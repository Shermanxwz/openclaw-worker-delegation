import test from 'node:test';
import assert from 'node:assert/strict';
import { agentIdFromSessionKey, resolveHookAgentId, resolveHookModel, resolveHookSessionId } from '../openclaw-plugin/runtime-identity.mjs';

test('extracts agent id from real OpenClaw session keys', () => {
  assert.equal(agentIdFromSessionKey('agent:main:cli:session'), 'main');
  assert.equal(agentIdFromSessionKey('agent:body-worker:subagent:uuid'), 'body-worker');
  assert.equal(agentIdFromSessionKey('not-an-agent-key'), '');
});

test('host-provided agent id wins over session-derived identity', () => {
  assert.equal(resolveHookAgentId({ sessionKey: 'agent:body-worker:x' }, { agentId: 'main' }), 'main');
  assert.equal(resolveHookAgentId({ sessionKey: 'agent:main:x' }, {}), 'main');
});

test('model hooks use the documented event fields and context fallback', () => {
  assert.deepEqual(resolveHookModel({ provider: 'mock', model: 'mock-model' }, {}), { provider: 'mock', model: 'mock-model' });
  assert.deepEqual(resolveHookModel({}, { modelProviderId: 'fallback', modelId: 'fallback-model' }), { provider: 'fallback', model: 'fallback-model' });
});

test('session identity accepts model-event session fields', () => {
  assert.equal(resolveHookSessionId({ sessionId: 'session-id', sessionKey: 'agent:main:key' }, {}, 'main'), 'session-id');
  assert.equal(resolveHookSessionId({ sessionKey: 'agent:main:key' }, {}, 'main'), 'agent:main:key');
});
