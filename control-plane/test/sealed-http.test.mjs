import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/security.mjs';
import { loadConfig } from '../src/config.mjs';
import { createControlPlane } from '../src/app.mjs';

async function startApp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocwd-http-sealed-'));
  const password = 'a-very-long-test-password';
  const token = 's'.repeat(48);
  const config = loadConfig({
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '8787', DATA_DIR: dir, COOKIE_SECURE: 'false',
    CONTROL_PASSWORD_HASH: await hashPassword(password), AGENT_INGEST_TOKEN: token,
    DEFAULT_MODE: 'worker', MAIN_AGENT_IDS: 'main', WORKER_AGENT_IDS: 'body-worker', VERIFIER_AGENT_IDS: 'verifier',
  });
  const app = await createControlPlane(config);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  return { app, base: `http://127.0.0.1:${address.port}`, password, token };
}

const agentHeaders = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

async function login(base, password) {
  const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(response.status, 200);
  const data = await response.json();
  return { csrf: data.csrfToken, cookie: response.headers.get('set-cookie').split(';')[0] };
}

const browserHeaders = (auth) => ({ 'content-type': 'application/json', cookie: auth.cookie, 'x-csrf-token': auth.csrf });

async function post(base, pathname, token, body) {
  const response = await fetch(`${base}${pathname}`, { method: 'POST', headers: agentHeaders(token), body: JSON.stringify(body) });
  return { response, body: await response.json() };
}

test('durable Worker lifecycle is authoritative from Main route through tool gate', async (t) => {
  const { app, base, token } = await startApp();
  t.after(() => app.close());

  await post(base, '/api/runtime-status', token, {
    instanceId: 'gateway-1', pluginLoaded: true, main: { agentId: 'main', model: 'strong', provider: 'p', sessionId: 'main-session' },
    enforcement: { routeWired: true, toolCheckWired: true },
  });
  const registry = await post(base, '/api/registry-sync', token, {
    revision: 'registry-1', providers: [{ id: 'p', name: 'Provider' }],
    models: [
      { ref: 'p/strong', provider: 'p', model: 'strong', thinkingLevels: [{ id: 'high', label: 'High' }] },
      { ref: 'p/worker', provider: 'p', model: 'worker', thinkingLevels: [] },
    ],
    agents: [
      { agentId: 'main', role: 'main', configuredModel: 'p/strong' },
      { agentId: 'body-worker', role: 'worker', configuredModel: 'p/worker' },
      { agentId: 'verifier', role: 'verifier', configuredModel: 'p/worker' },
    ],
  });
  assert.equal(registry.response.status, 200);

  const parent = await post(base, '/api/route', token, {
    hook: 'before_prompt_build', instanceId: 'gateway-1', agentId: 'main', runId: 'main-run', sessionId: 'main-session', task: 'fix code and run tests',
  });
  assert.equal(parent.response.status, 200);
  assert.equal(parent.body.route.actor, 'worker');

  const prepared = await post(base, '/api/tasks/prepare', token, {
    parentAgentId: 'main', parentRunId: 'main-run', parentSessionId: 'main-session', parentSessionKey: 'main-session',
    targetAgentId: 'body-worker', task: 'fix code and run tests', toolCallId: 'spawn-1', openclawVersion: 'test',
  });
  assert.equal(prepared.response.status, 201);
  assert.match(prepared.body.task.id, /^wrk_/);
  assert.equal(prepared.body.spawn.agentId, 'body-worker');
  assert.ok(prepared.body.spawn.runTimeoutSeconds <= 3600);

  const task = prepared.body.task;
  const child = await post(base, '/api/route', token, {
    hook: 'before_prompt_build', instanceId: 'gateway-1', agentId: 'body-worker', runId: 'child-run', sessionId: 'child-session',
    taskId: task.id, ownerEpoch: task.ownerEpoch, task: `[[OCWD_TASK:${task.id}:${task.ownerEpoch}]]\nwork`,
  });
  assert.equal(child.response.status, 200);
  assert.equal(child.body.route.decision, 'durable-worker-task');

  const gate = await post(base, '/api/tool-check', token, {
    hook: 'before_tool_call', instanceId: 'gateway-1', agentId: 'body-worker', runId: 'child-run', sessionId: 'child-session',
    taskId: task.id, ownerEpoch: task.ownerEpoch, tool: 'exec',
  });
  assert.equal(gate.response.status, 200);
  assert.equal(gate.body.allowed, true);

  const terminal = await post(base, '/api/tasks/terminal', token, { taskId: task.id, ownerEpoch: task.ownerEpoch, outcome: 'succeeded' });
  assert.equal(terminal.response.status, 200);
  const blocked = await post(base, '/api/tool-check', token, {
    hook: 'before_tool_call', instanceId: 'gateway-1', agentId: 'body-worker', runId: 'child-run', sessionId: 'child-session',
    taskId: task.id, ownerEpoch: task.ownerEpoch, tool: 'exec',
  });
  assert.equal(blocked.body.allowed, false);
  assert.match(blocked.body.reason, /worker_task_succeeded|owner_epoch/);
});

test('browser routing control follows registry thinking declaration and root task action requires reauth', async (t) => {
  const { app, base, token, password } = await startApp();
  t.after(() => app.close());
  const auth = await login(base, password);

  await post(base, '/api/registry-sync', token, {
    revision: 'r2', providers: [{ id: 'p' }],
    models: [{ ref: 'p/no-levels', provider: 'p', model: 'no-levels', thinkingLevels: [] }],
    agents: [{ agentId: 'main', role: 'main', configuredModel: 'p/no-levels' }],
  });

  const unsupported = await fetch(`${base}/api/routing`, {
    method: 'PUT', headers: browserHeaders(auth),
    body: JSON.stringify({ mode: 'auto', role: 'main', modelRef: 'p/no-levels', thinking: 'high' }),
  });
  assert.equal(unsupported.status, 409);

  const auto = await fetch(`${base}/api/routing`, {
    method: 'PUT', headers: browserHeaders(auth),
    body: JSON.stringify({ mode: 'auto', role: 'main', modelRef: 'p/no-levels', thinking: 'auto' }),
  });
  assert.equal(auto.status, 200);

  const parent = await post(base, '/api/route', token, { agentId: 'main', runId: 'r-main', sessionId: 's-main', task: 'fix files' });
  assert.equal(parent.body.route.actor, 'worker');
  const prepared = await post(base, '/api/tasks/prepare', token, {
    parentAgentId: 'main', parentRunId: 'r-main', parentSessionId: 's-main', targetAgentId: 'body-worker', task: 'fix files',
  });
  const taskId = prepared.body.task.id;

  const noReauth = await fetch(`${base}/api/worker-tasks/${encodeURIComponent(taskId)}/action`, {
    method: 'POST', headers: browserHeaders(auth), body: JSON.stringify({ action: 'cancel', confirmation: 'CANCEL_TASK' }),
  });
  assert.equal(noReauth.status, 403);

  const cancelled = await fetch(`${base}/api/worker-tasks/${encodeURIComponent(taskId)}/action`, {
    method: 'POST', headers: browserHeaders(auth), body: JSON.stringify({ action: 'cancel', confirmation: 'CANCEL_TASK', reauthPassword: password }),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).task.state, 'cancelled');
});
