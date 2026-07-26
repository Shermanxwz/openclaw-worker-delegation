import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicy, resolveAgentRole, toolDecision } from '../src/policy.mjs';

const config = { mainAgentIds: ['main'], workerAgentIds: ['body-worker'], verifierAgentIds: ['verifier'] };

test('role is derived from configured agent id', () => {
  assert.equal(resolveAgentRole('main', config), 'main');
  assert.equal(resolveAgentRole('body-worker', config), 'worker');
  assert.equal(resolveAgentRole('unknown', config), 'unknown');
});

test('worker mode makes main coordinator-only', () => {
  const policy = buildPolicy({ mode: 'worker', role: 'main', routeActor: 'worker' });
  assert.equal(toolDecision(policy, 'exec').allowed, false);
  assert.equal(toolDecision(policy, 'read').allowed, false);
  assert.equal(toolDecision(policy, 'web_search').allowed, false);
  assert.equal(toolDecision(policy, 'sessions_spawn').allowed, true);
});

test('auto route is authoritative for main', () => {
  const lightweight = buildPolicy({ mode: 'auto', role: 'main', routeActor: 'main' });
  assert.equal(toolDecision(lightweight, 'read').allowed, true);
  assert.equal(toolDecision(lightweight, 'sessions_spawn').allowed, false);
  assert.equal(toolDecision(lightweight, 'edit').allowed, false);

  const delegated = buildPolicy({ mode: 'auto', role: 'main', routeActor: 'worker' });
  assert.equal(toolDecision(delegated, 'sessions_spawn').allowed, true);
  assert.equal(toolDecision(delegated, 'read').allowed, false);
});

test('main-only mode permits main and freezes non-main roles', () => {
  const main = buildPolicy({ mode: 'main', role: 'main', routeActor: 'main' });
  assert.equal(toolDecision(main, 'exec').allowed, true);
  assert.equal(toolDecision(main, 'sessions_spawn').allowed, false);
  const worker = buildPolicy({ mode: 'main', role: 'worker', routeActor: 'worker' });
  assert.equal(toolDecision(worker, 'exec').allowed, false);
  const verifier = buildPolicy({ mode: 'main', role: 'verifier', routeActor: 'verifier' });
  assert.equal(toolDecision(verifier, 'read').allowed, false);
});

test('verifier is actually read-only by default', () => {
  const policy = buildPolicy({ mode: 'auto', role: 'verifier' });
  assert.equal(toolDecision(policy, 'read').allowed, true);
  assert.equal(toolDecision(policy, 'exec').allowed, false);
  assert.equal(toolDecision(policy, 'edit').allowed, false);
});

test('unknown agent fails closed', () => {
  const policy = buildPolicy({ role: 'unknown' });
  assert.equal(toolDecision(policy, 'read').allowed, false);
});
