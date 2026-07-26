function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function agentIdFromSessionKey(sessionKey = '') {
  const match = /^agent:([^:]+):/.exec(String(sessionKey));
  return match?.[1] || '';
}

export function resolveHookAgentId(event = {}, ctx = {}) {
  return firstString(
    ctx.agentId,
    event.agentId,
    agentIdFromSessionKey(ctx.sessionKey),
    agentIdFromSessionKey(event.sessionKey),
  );
}

export function resolveHookSessionId(event = {}, ctx = {}, agentId = '') {
  return firstString(
    ctx.sessionId,
    event.sessionId,
    ctx.sessionKey,
    event.sessionKey,
    agentId ? `${agentId}:unknown` : '',
  );
}

export function resolveHookModel(event = {}, ctx = {}) {
  return {
    provider: firstString(event.provider, event.providerId, ctx.modelProviderId, ctx.provider),
    model: firstString(event.model, event.modelId, ctx.modelId, ctx.model),
  };
}
