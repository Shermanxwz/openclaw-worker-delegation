import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateTotp, hashPassword } from '../src/security.mjs';
import { loadConfig } from '../src/config.mjs';
import { createControlPlane } from '../src/app.mjs';

async function startApp({ totpSecret = '', mainAllowPersistent = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocwd-app-'));
  const password = 'a-very-long-test-password';
  const token = 't'.repeat(48);
  const config = loadConfig({
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '8787', DATA_DIR: dir, COOKIE_SECURE: 'false',
    CONTROL_PASSWORD_HASH: await hashPassword(password), CONTROL_TOTP_SECRET: totpSecret,
    AGENT_INGEST_TOKEN: token, MAIN_AGENT_IDS: 'main', WORKER_AGENT_IDS: 'body-worker', VERIFIER_AGENT_IDS: 'verifier',
    ...(mainAllowPersistent ? { MAIN_ALLOW_PERSISTENT: 'true' } : {}),
  });
  const app = await createControlPlane(config);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  return { app, base: `http://127.0.0.1:${address.port}`, password, token, totpSecret };
}

async function login(base, password, totp = '') {
  const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, totp }) });
  assert.equal(response.status, 200);
  const data = await response.json();
  return { csrf: data.csrfToken, cookie: response.headers.get('set-cookie').split(';')[0] };
}

const browserHeaders = (auth) => ({ 'content-type': 'application/json', cookie: auth.cookie, 'x-csrf-token': auth.csrf });
const agentHeaders = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

test('browser preview is separate and missing runtime binding fails closed for every role', async (t) => {
  const { app, base, password, token } = await startApp();
  t.after(() => app.close());
  const auth = await login(base, password);
  const preview = await fetch(`${base}/api/route-preview`, { method: 'POST', headers: browserHeaders(auth), body: JSON.stringify({ task: '修改代码并运行测试' }) });
  assert.equal(preview.status, 200);

  const statusAfterPreview = await (await fetch(`${base}/api/status`, { headers: { cookie: auth.cookie } })).json();
  assert.equal(statusAfterPreview.metrics.routeToWorker, 0, 'route preview must not pollute real metrics');

  const missingMain = await fetch(`${base}/api/tool-check`, { method: 'POST', headers: agentHeaders(token), body: JSON.stringify({ agentId: 'main', tool: 'exec' }) });
  const missingMainBody = await missingMain.json();
  assert.equal(missingMainBody.allowed, false);
  assert.equal(missingMainBody.reason, 'route_run_missing');

  const missingWorker = await fetch(`${base}/api/tool-check`, { method: 'POST', headers: agentHeaders(token), body: JSON.stringify({ agentId: 'body-worker', tool: 'exec' }) });
  const missingWorkerBody = await missingWorker.json();
  assert.equal(missingWorkerBody.allowed, false);
  assert.equal(missingWorkerBody.reason, 'route_run_missing');

  const route = await fetch(`${base}/api/route`, {
    method: 'POST', headers: agentHeaders(token),
    body: JSON.stringify({ hook: 'before_prompt_build', instanceId: 'i-preview', agentId: 'main', runId: 'r-preview', sessionId: 's-preview', task: '修改代码并运行测试' }),
  });
  assert.equal(route.status, 200);
  const mainBound = await fetch(`${base}/api/tool-check`, {
    method: 'POST', headers: agentHeaders(token),
    body: JSON.stringify({ hook: 'before_tool_call', instanceId: 'i-preview', agentId: 'main', runId: 'r-preview', sessionId: 's-preview', tool: 'exec' }),
  });
  assert.equal((await mainBound.json()).allowed, false, 'delegated Main remains coordinator-only');

  const spoof = await fetch(`${base}/api/tool-check`, {
    method: 'POST', headers: agentHeaders(token),
    body: JSON.stringify({ agentId: 'main', role: 'worker', runId: 'r-preview', sessionId: 's-preview', tool: 'exec' }),
  });
  assert.equal((await spoof.json()).allowed, false);
});

test('route decision is bound to agent and session', async (t) => {
  const { app, base, token } = await startApp();
  t.after(() => app.close());
  const headers = agentHeaders(token);
  const route = await fetch(`${base}/api/route`, { method: 'POST', headers, body: JSON.stringify({ hook: 'before_prompt_build', instanceId: 'i1', agentId: 'main', runId: 'r1', sessionId: 's1', task: '修改配置' }) });
  assert.equal(route.status, 200);
  const mismatch = await fetch(`${base}/api/tool-check`, { method: 'POST', headers, body: JSON.stringify({ hook: 'before_tool_call', instanceId: 'i1', agentId: 'body-worker', runId: 'r1', sessionId: 's1', tool: 'exec' }) });
  const body = await mismatch.json();
  assert.equal(body.allowed, false);
  assert.equal(body.reason, 'route_agent_mismatch');
});

test('main elevation requires explicit confirmation, password and optional TOTP', async (t) => {
  const totpSecret = 'JBSWY3DPEHPK3PXP';
  const { app, base, password } = await startApp({ totpSecret });
  t.after(() => app.close());
  const code = generateTotp(totpSecret);
  const auth = await login(base, password, code);
  const headers = browserHeaders(auth);
  const missing = await fetch(`${base}/api/mode`, { method: 'PUT', headers, body: JSON.stringify({ scope: 'global', mode: 'main', reauthPassword: password, reauthTotp: code }) });
  assert.equal(missing.status, 400);
  const noTotp = await fetch(`${base}/api/mode`, { method: 'PUT', headers, body: JSON.stringify({ scope: 'global', mode: 'main', confirmation: 'ENABLE_MAIN', reauthPassword: password, ttlMinutes: 15 }) });
  assert.equal(noTotp.status, 403);
  const ok = await fetch(`${base}/api/mode`, { method: 'PUT', headers, body: JSON.stringify({ scope: 'global', mode: 'main', confirmation: 'ENABLE_MAIN', reauthPassword: password, reauthTotp: code, ttlMinutes: 15 }) });
  assert.equal(ok.status, 200);
});

test('worker and auto switches are persistent while main is time-bounded', async (t) => {
  const { app, base, password } = await startApp();
  t.after(() => app.close());
  const auth = await login(base, password);
  const headers = browserHeaders(auth);
  const worker = await (await fetch(`${base}/api/mode`, { method: 'PUT', headers, body: JSON.stringify({ scope: 'global', mode: 'worker', ttlMinutes: 30 }) })).json();
  assert.equal(worker.entry.expiresAt, undefined);
  const main = await (await fetch(`${base}/api/mode`, { method: 'PUT', headers, body: JSON.stringify({ scope: 'global', mode: 'main', confirmation: 'ENABLE_MAIN', reauthPassword: password, ttlMinutes: 15 }) })).json();
  assert.ok(main.entry.expiresAt);
});

test('main-only mode immediately freezes worker tool calls', async (t) => {
  const { app, base, password, token } = await startApp();
  t.after(() => app.close());
  const auth = await login(base, password);
  await fetch(`${base}/api/mode`, { method: 'PUT', headers: browserHeaders(auth), body: JSON.stringify({ scope: 'global', mode: 'main', confirmation: 'ENABLE_MAIN', reauthPassword: password, ttlMinutes: 15 }) });
  const check = await fetch(`${base}/api/tool-check`, { method: 'POST', headers: agentHeaders(token), body: JSON.stringify({ agentId: 'body-worker', tool: 'exec' }) });
  assert.equal((await check.json()).allowed, false);
});

test('Web next-task override is consumed by one real main route only', async (t) => {
  const { app, base, password, token } = await startApp();
  t.after(() => app.close());
  const auth = await login(base, password);
  const browser = browserHeaders(auth);
  const set = await fetch(`${base}/api/mode`, {
    method: 'PUT',
    headers: browser,
    body: JSON.stringify({ scope: 'task', id: 's-next', mode: 'worker', ttlMinutes: 30 }),
  });
  assert.equal(set.status, 200);

  const headers = agentHeaders(token);
  const first = await (await fetch(`${base}/api/route`, {
    method: 'POST', headers,
    body: JSON.stringify({ hook: 'before_prompt_build', instanceId: 'i-next', agentId: 'main', runId: 'run-next-1', sessionId: 's-next', task: '解释架构' }),
  })).json();
  assert.equal(first.route.mode, 'worker');
  assert.equal(first.modeSource, 'task');

  const repeated = await (await fetch(`${base}/api/route`, {
    method: 'POST', headers,
    body: JSON.stringify({ hook: 'before_prompt_build', instanceId: 'i-next', agentId: 'main', runId: 'run-next-1', sessionId: 's-next', task: 'same run' }),
  })).json();
  assert.equal(repeated.route.mode, 'worker');
  assert.equal(repeated.modeSource, 'task');

  const second = await (await fetch(`${base}/api/route`, {
    method: 'POST', headers,
    body: JSON.stringify({ hook: 'before_prompt_build', instanceId: 'i-next', agentId: 'main', runId: 'run-next-2', sessionId: 's-next', task: '为什么使用 worker？' }),
  })).json();
  assert.equal(second.route.mode, 'auto');
});

test('persistent main is rejected when MAIN_ALLOW_PERSISTENT is disabled', async (t) => {
  const { app, base, password } = await startApp();
  t.after(() => app.close());
  const auth = await login(base, password);
  const headers = browserHeaders(auth);
  const rejected = await fetch(`${base}/api/mode`, {
    method: 'PUT', headers,
    body: JSON.stringify({ scope: 'global', mode: 'main', confirmation: 'ENABLE_MAIN_PERSISTENT', reauthPassword: password, ttlMinutes: 0 }),
  });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error, 'persistent_main_disabled');
});

test('persistent main requires explicit ENABLE_MAIN_PERSISTENT confirmation when enabled', async (t) => {
  const totpSecret = 'JBSWY3DPEHPK3PXP';
  const { app, base, password } = await startApp({ totpSecret, mainAllowPersistent: true });
  t.after(() => app.close());
  const code = generateTotp(totpSecret);
  const auth = await login(base, password, code);
  const headers = browserHeaders(auth);

  const wrongConfirmation = await fetch(`${base}/api/mode`, {
    method: 'PUT', headers,
    body: JSON.stringify({ scope: 'global', mode: 'main', confirmation: 'ENABLE_MAIN', reauthPassword: password, reauthTotp: code, ttlMinutes: 0 }),
  });
  assert.equal(wrongConfirmation.status, 200);
  const wcBody = await wrongConfirmation.json();
  assert.ok(wcBody.entry.expiresAt, 'time-bounded MAIN must keep expiresAt');
  assert.equal(wcBody.entry.persistent, undefined, 'ENABLE_MAIN must never yield persistent');

  const noReauth = await fetch(`${base}/api/mode`, {
    method: 'PUT', headers,
    body: JSON.stringify({ scope: 'global', mode: 'main', confirmation: 'ENABLE_MAIN_PERSISTENT', ttlMinutes: 0 }),
  });
  assert.equal(noReauth.status, 403);
  assert.equal((await noReauth.json()).error, 'reauthentication_required');

  const ok = await fetch(`${base}/api/mode`, {
    method: 'PUT', headers,
    body: JSON.stringify({ scope: 'global', mode: 'main', confirmation: 'ENABLE_MAIN_PERSISTENT', reauthPassword: password, reauthTotp: code, ttlMinutes: 0 }),
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.entry.mode, 'main');
  assert.equal(body.entry.expiresAt, undefined);
  assert.equal(body.entry.persistent, true);

  const status = await (await fetch(`${base}/api/status`, { headers: { cookie: auth.cookie } })).json();
  assert.equal(status.resolvedMode.mode, 'main');
  assert.equal(status.resolvedMode.entry.persistent, true);
  assert.equal(status.resolvedMode.entry.expiresAt, undefined);

  const switchBack = await fetch(`${base}/api/mode`, {
    method: 'PUT', headers,
    body: JSON.stringify({ scope: 'global', mode: 'auto', ttlMinutes: 0 }),
  });
  assert.equal(switchBack.status, 200);
  assert.equal((await switchBack.json()).entry.persistent, undefined);

  await fetch(`${base}/api/mode`, {
    method: 'PUT', headers,
    body: JSON.stringify({ scope: 'global', mode: 'main', confirmation: 'ENABLE_MAIN_PERSISTENT', reauthPassword: password, reauthTotp: code, ttlMinutes: 0 }),
  });
  const timeBounded = await fetch(`${base}/api/mode`, {
    method: 'PUT', headers,
    body: JSON.stringify({ scope: 'global', mode: 'main', confirmation: 'ENABLE_MAIN', reauthPassword: password, reauthTotp: code, ttlMinutes: 0 }),
  });
  assert.equal(timeBounded.status, 200);
  const tb = await timeBounded.json();
  assert.ok(tb.entry.expiresAt);
  assert.equal(tb.entry.persistent, undefined);
});

test('static serving hides backup and dotfile requests with 404', async (t) => {
  const { app, base } = await startApp();
  t.after(() => app.close());
  const forbidden = [
    '/app.js.bak.9999',
    '/app.js.bak-9999',
    '/app.js.old',
    '/app.js.swp',
    '/app.js.tmp',
    '/app.js.orig',
    '/app.js~',
    '/.bak-test-9999/app.js',
    '/.git/config',
    '/.env',
    '/app.js%2ebak.9999',
    '/.public-backups/anything/app.js',
  ];
  for (const url of forbidden) {
    const response = await fetch(`${base}${url}`);
    assert.equal(response.status, 404, `expected 404 for ${url}, got ${response.status}`);
    const body = await response.json().catch(() => ({}));
    assert.equal(body.error, 'not_found');
  }
  const allowed = ['/', '/app.js', '/styles.css', '/icon.svg', '/favicon-32.png'];
  for (const url of allowed) {
    const response = await fetch(`${base}${url}`);
    assert.equal(response.status, 200, `expected 200 for ${url}, got ${response.status}`);
  }
});
