import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';

async function tempStore(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocwd-store-'));
  const store = new StateStore({ dataDir: dir, defaultMode: 'auto', ...options });
  await store.init();
  return { dir, store };
}

test('mode precedence is task > session > project > global', async () => {
  const { store } = await tempStore();
  await store.setMode({ scope: 'project', id: 'p1', mode: 'worker' });
  await store.setMode({ scope: 'session', id: 's1', mode: 'main' });
  assert.equal(store.resolveMode({ projectId: 'p1' }).mode, 'worker');
  assert.equal(store.resolveMode({ projectId: 'p1', sessionId: 's1' }).mode, 'main');
  assert.equal(store.resolveMode({ projectId: 'p1', sessionId: 's1', taskMode: 'auto' }).mode, 'auto');
});

test('global main elevation really expires back to default', async () => {
  let now = 1_700_000_000_000;
  const { store } = await tempStore({ now: () => now });
  await store.setMode({ scope: 'global', mode: 'main', ttlMinutes: 5 });
  assert.equal(store.resolveMode().mode, 'main');
  now += 6 * 60_000;
  assert.equal(store.resolveMode().mode, 'auto');
  await store.purgeExpired();
  assert.equal(store.state.global.mode, 'auto');
});

test('hard enforcement requires fresh heartbeat and actual hooks for same instance', async () => {
  let now = 1_700_000_000_000;
  const { store } = await tempStore({ now: () => now });
  await store.updateRuntimeStatus({ instanceId: 'instance-1', pluginLoaded: true, main: { model: 'provider/model' }, enforcement: { routeWired: true, toolCheckWired: true } });
  assert.equal(store.enforcementSnapshot().hard, false);
  await store.markRouteObserved({ instanceId: 'instance-1', runId: 'r1', agentId: 'main', route: { actor: 'worker' } });
  await store.markToolCheckObserved({ instanceId: 'instance-1' });
  assert.equal(store.enforcementSnapshot().hard, true);
  now += 120_000;
  assert.equal(store.enforcementSnapshot().hard, false);
});

test('controller restart clears old hook observations', async () => {
  const { dir, store } = await tempStore();
  await store.updateRuntimeStatus({ instanceId: 'instance-1', pluginLoaded: true, enforcement: { routeWired: true, toolCheckWired: true } });
  await store.markRouteObserved({ instanceId: 'instance-1', runId: 'r1', agentId: 'main', route: { actor: 'main' } });
  await store.markToolCheckObserved({ instanceId: 'instance-1' });
  assert.equal(store.enforcementSnapshot().hard, true);
  const restarted = new StateStore({ dataDir: dir, defaultMode: 'auto' });
  await restarted.init();
  assert.equal(restarted.enforcementSnapshot().hard, false);
});

test('low-signal runtime heartbeat does not overwrite fresh real runtime identity', async () => {
  let now = 1_700_000_000_000;
  const { store } = await tempStore({ now: () => now });
  await store.updateRuntimeStatus({
    instanceId: 'gateway-instance',
    pluginLoaded: true,
    main: { model: 'gpt-5.5', provider: 'new-api', sessionId: 's1', agentId: 'main' },
    sessionId: 's1',
    enforcement: { routeWired: true, toolCheckWired: true },
  });
  await store.markRouteObserved({ instanceId: 'gateway-instance', runId: 'r1', agentId: 'main', route: { actor: 'main' } });
  await store.markToolCheckObserved({ instanceId: 'gateway-instance' });
  assert.equal(store.enforcementSnapshot().hard, true);

  const ignored = await store.updateRuntimeStatus({
    instanceId: 'inspect-instance',
    pluginLoaded: true,
    main: { configuredModel: 'new-api/gpt-5.5', agentId: 'main' },
    enforcement: { routeWired: true, toolCheckWired: true },
  });
  assert.equal(ignored.instanceId, 'gateway-instance');
  assert.equal(store.state.runtime.main.model, 'gpt-5.5');
  assert.equal(store.enforcementSnapshot().hard, true);

  await store.updateRuntimeStatus({
    instanceId: 'new-gateway-instance',
    pluginLoaded: true,
    main: { model: 'gpt-5.5', sessionId: 's2', agentId: 'main' },
    sessionId: 's2',
    enforcement: { routeWired: true, toolCheckWired: true },
  });
  assert.equal(store.state.runtime.instanceId, 'new-gateway-instance');
  assert.equal(store.enforcementSnapshot().hard, false);
});

test('route binding rejects agent or session substitution', async () => {
  const { store } = await tempStore();
  await store.markRouteObserved({ runId: 'r1', agentId: 'main', sessionId: 's1', route: { actor: 'worker' } });
  assert.equal(store.validateRouteBinding('r1', 'main', 's1').valid, true);
  assert.equal(store.validateRouteBinding('r1', 'body-worker', 's1').reason, 'route_agent_mismatch');
  assert.equal(store.validateRouteBinding('r1', 'main', 's2').reason, 'route_session_mismatch');
});

test('concurrent state writes remain valid JSON', async () => {
  const { dir, store } = await tempStore();
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.setMode({ scope: 'session', id: `s${index}`, mode: index % 2 ? 'worker' : 'auto' })));
  const parsed = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(Object.keys(parsed.sessions).length, 20);
});

test('malformed trailing audit event does not prevent restart', async () => {
  const { dir, store } = await tempStore();
  await store.appendEvent({ type: 'ok' });
  await fs.appendFile(path.join(dir, 'events.ndjson'), '{broken\n');
  const restarted = new StateStore({ dataDir: dir, defaultMode: 'auto' });
  await restarted.init();
  assert.equal(restarted.listEvents()[0].type, 'ok');
});

test('next-task override is highest priority and consumed exactly once', async () => {
  const { store } = await tempStore();
  await store.setMode({ scope: 'global', mode: 'auto' });
  await store.setMode({ scope: 'session', id: 's1', mode: 'worker' });
  await store.setMode({ scope: 'task', id: 's1', mode: 'main', ttlMinutes: 30 });
  assert.equal(store.resolveMode({ sessionId: 's1' }).source, 'task');
  const first = await store.consumeMode({ sessionId: 's1' });
  assert.equal(first.mode, 'main');
  assert.equal(first.source, 'task');
  const second = await store.consumeMode({ sessionId: 's1' });
  assert.equal(second.mode, 'worker');
  assert.equal(second.source, 'session');
});

test('expired next-task override is never consumed', async () => {
  let now = 1_700_000_000_000;
  const { store } = await tempStore({ now: () => now });
  await store.setMode({ scope: 'task', id: 's1', mode: 'main', ttlMinutes: 5 });
  now += 6 * 60_000;
  const resolved = await store.consumeMode({ sessionId: 's1' });
  assert.equal(resolved.mode, 'auto');
  assert.notEqual(resolved.source, 'task');
});

test('persistent main entry is recorded without expiresAt and visible in snapshot', async () => {
  const { store } = await tempStore();
  const entry = await store.setMode({ scope: 'global', mode: 'main', ttlMinutes: 0, persistent: true });
  assert.equal(entry.expiresAt, undefined);
  assert.equal(entry.persistent, true);
  const snapshot = store.snapshot();
  assert.equal(snapshot.resolvedMode.mode, 'main');
  assert.equal(snapshot.resolvedMode.entry.persistent, true);
  assert.equal(snapshot.resolvedMode.entry.expiresAt, undefined);

  const nonPersistent = await store.setMode({ scope: 'global', mode: 'worker', ttlMinutes: 0 });
  assert.equal(nonPersistent.persistent, undefined);
});
