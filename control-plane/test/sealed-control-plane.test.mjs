import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.mjs';

async function tempStore(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocwd-sealed-'));
  const store = new StateStore({ dataDir: dir, defaultMode: 'auto', ...options });
  await store.init();
  return { dir, store };
}

async function prepare(store, { kind = 'standard', sessionId = 's1', projectId = 'p1', role = 'worker', agentId = 'body-worker' } = {}) {
  return store.prepareWorkerTask({
    kind,
    role,
    mode: 'worker',
    targetAgentId: agentId,
    task: 'execute delegated work',
    parent: { agentId: 'main', runId: `parent-${sessionId}`, sessionId, sessionKey: sessionId, projectId },
    provenance: { pluginInstanceId: 'i1', createdBy: 'main' },
  });
}

test('hard task ceilings cannot be raised by direct construction', async () => {
  let now = 1_700_000_000_000;
  const { store } = await tempStore({ now: () => now, workerTaskStandardMaxSeconds: 99_999, workerTaskQuickMaxSeconds: 99_999 });
  const standard = await prepare(store, { kind: 'standard', sessionId: 'std' });
  const quick = await prepare(store, { kind: 'quick', sessionId: 'quick' });
  assert.equal(Date.parse(standard.lease.hardDeadline) - now, 60 * 60_000);
  assert.equal(Date.parse(quick.lease.hardDeadline) - now, 10 * 60_000);
});

test('ordinary heartbeat keeps liveness but only meaningful progress renews lease', async () => {
  let now = 1_700_000_000_000;
  const { store } = await tempStore({ now: () => now, workerTaskLeaseSeconds: 60, workerTaskGraceSeconds: 20, workerHeartbeatStaleSeconds: 45 });
  const task = await prepare(store);
  const firstExpiry = task.lease.expiresAt;
  now += 30_000;
  const heartbeat = await store.heartbeatWorkerTask({ id: task.id, ownerEpoch: task.ownerEpoch, agentId: 'body-worker', meaningful: false });
  assert.equal(heartbeat.lease.expiresAt, firstExpiry);
  now += 10_000;
  const progress = await store.heartbeatWorkerTask({ id: task.id, ownerEpoch: task.ownerEpoch, agentId: 'body-worker', meaningful: true, phase: 'editing', summary: 'changed config' });
  assert.ok(Date.parse(progress.lease.expiresAt) > Date.parse(firstExpiry));
  assert.equal(progress.progress.meaningfulSeq, 1);
});

test('tool authority fails closed on stale worker heartbeat even before hard deadline', async () => {
  let now = 1_700_000_000_000;
  const { store } = await tempStore({ now: () => now, workerTaskLeaseSeconds: 300, workerTaskGraceSeconds: 60, workerHeartbeatStaleSeconds: 45 });
  const task = await prepare(store);
  await store.bindWorkerTask({ id: task.id, ownerEpoch: task.ownerEpoch, agentId: 'body-worker', runId: 'child-run', sessionId: 'child-session' });
  assert.equal(store.validateWorkerLease({ id: task.id, ownerEpoch: task.ownerEpoch, agentId: 'body-worker', runId: 'child-run', sessionId: 'child-session' }).valid, true);
  now += 46_000;
  const stale = store.validateWorkerLease({ id: task.id, ownerEpoch: task.ownerEpoch, agentId: 'body-worker', runId: 'child-run', sessionId: 'child-session' });
  assert.equal(stale.valid, false);
  assert.equal(stale.reason, 'worker_heartbeat_stale');
});

test('session MAIN fences only matching delegated tasks', async () => {
  const { store } = await tempStore();
  const target = await prepare(store, { sessionId: 's-target', projectId: 'p1' });
  const other = await prepare(store, { sessionId: 's-other', projectId: 'p1' });
  await store.setMode({ scope: 'session', id: 's-target', mode: 'main', ttlMinutes: 15 });
  const fenced = store.getWorkerTask(target.id);
  const untouched = store.getWorkerTask(other.id);
  assert.equal(fenced.state, 'cancelled');
  assert.equal(fenced.ownerEpoch, target.ownerEpoch + 1);
  assert.equal(untouched.state, 'queued');
});

test('project MAIN fences only the selected project and one-shot MAIN fences nothing already running', async () => {
  const { store } = await tempStore();
  const p1 = await prepare(store, { sessionId: 's1', projectId: 'p1' });
  const p2 = await prepare(store, { sessionId: 's2', projectId: 'p2' });
  await store.setMode({ scope: 'task', id: 's1', mode: 'main', ttlMinutes: 15 });
  assert.equal(store.getWorkerTask(p1.id).state, 'queued');
  await store.setMode({ scope: 'project', id: 'p1', mode: 'main', ttlMinutes: 15 });
  assert.equal(store.getWorkerTask(p1.id).state, 'cancelled');
  assert.equal(store.getWorkerTask(p2.id).state, 'queued');
});

test('root cancellation revokes the old owner epoch immediately', async () => {
  const { store } = await tempStore();
  const task = await prepare(store);
  const cancelled = await store.rootTaskAction({ id: task.id, action: 'cancel' });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.ownerEpoch, task.ownerEpoch + 1);
  assert.equal(store.validateWorkerLease({ id: task.id, ownerEpoch: task.ownerEpoch, agentId: 'body-worker' }).reason, 'worker_owner_epoch_mismatch');
});

test('registry exposes only Auto when upstream declares no thinking levels', async () => {
  const { store } = await tempStore();
  await store.updateRegistry({
    revision: 'r1',
    providers: [{ id: 'p', name: 'Provider' }],
    models: [{ ref: 'p/m', provider: 'p', model: 'm', name: 'Model', thinkingLevels: [] }],
    agents: [{ agentId: 'main', role: 'main', configuredModel: 'p/m' }],
  });
  const route = store.resolveRouteConfig('auto', 'main');
  assert.deepEqual(route.thinkingLevels, [{ id: 'auto', label: 'Auto' }]);
  await assert.rejects(() => store.setRoutingProfile({ mode: 'auto', role: 'main', modelRef: 'p/m', thinking: 'high' }), /thinking_level_not_supported/);
});

test('durable route binding survives controller restart and missing binding is fail-closed', async () => {
  const { dir, store } = await tempStore();
  assert.equal(store.validateRouteBinding('missing', 'main', 's1').reason, 'route_binding_missing');
  await store.markRouteObserved({ runId: 'run-1', agentId: 'main', sessionId: 's1', route: { mode: 'auto', actor: 'worker' }, modeSource: 'global' });
  const restarted = new StateStore({ dataDir: dir, defaultMode: 'auto' });
  await restarted.init();
  const binding = restarted.validateRouteBinding('run-1', 'main', 's1');
  assert.equal(binding.valid, true);
  assert.equal(binding.decision.route.actor, 'worker');
});
