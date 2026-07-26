import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicy, toolDecision } from '../src/policy.mjs';

test('worker mode blocks main execution tools', () => {
  const policy = buildPolicy({ mode: 'worker', actor: 'worker', role: 'main' });
  assert.equal(toolDecision(policy, 'exec').allowed, false);
  assert.equal(toolDecision(policy, 'sessions_spawn').allowed, true);
});

test('main mode disables automatic spawn', () => {
  const policy = buildPolicy({ mode: 'main', actor: 'main', role: 'main' });
  assert.equal(toolDecision(policy, 'exec').allowed, true);
  assert.equal(toolDecision(policy, 'sessions_spawn').allowed, false);
});

test('verifier can execute but cannot edit', () => {
  const policy = buildPolicy({ role: 'verifier' });
  assert.equal(toolDecision(policy, 'exec').allowed, true);
  assert.equal(toolDecision(policy, 'edit').allowed, false);
});
