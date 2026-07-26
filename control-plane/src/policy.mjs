const TOOL_ALIASES = new Map([
  ['bash', 'exec'],
  ['shell', 'exec'],
  ['shell.run', 'exec'],
  ['code-execution', 'code_execution'],
]);

export const MAIN_OBSERVE_TOOLS = [
  'read', 'web_search', 'web_fetch', 'agents_list', 'sessions_list',
  'sessions_history', 'session_status',
];
export const MAIN_DELEGATION_TOOLS = [
  'agents_list', 'sessions_list', 'sessions_spawn', 'sessions_yield',
  'sessions_history', 'session_status', 'subagents',
];
export const MUTATION_TOOLS = ['write', 'edit', 'apply_patch'];
export const RUNTIME_TOOLS = ['exec', 'process', 'code_execution'];
export const WORKER_DEFAULT_TOOLS = ['read', ...MUTATION_TOOLS, ...RUNTIME_TOOLS, 'web_search', 'web_fetch'];
export const VERIFIER_DEFAULT_TOOLS = ['read', 'web_search', 'web_fetch', 'session_status'];

export function normalizeToolName(tool) {
  const name = String(tool || '').trim().toLowerCase();
  return TOOL_ALIASES.get(name) || name;
}

export function resolveAgentRole(agentId, config) {
  const id = String(agentId || '').trim();
  if (!id) return 'unknown';
  if (config.mainAgentIds.includes(id)) return 'main';
  if (config.workerAgentIds.includes(id)) return 'worker';
  if (config.verifierAgentIds.includes(id)) return 'verifier';
  return 'unknown';
}

function allowList(role, tools, reason = null) {
  return {
    role,
    enforcement: 'allow-list',
    allow: [...new Set(tools.map(normalizeToolName))],
    deny: [],
    ...(reason ? { reason } : {}),
  };
}

export function buildPolicy({ mode = 'auto', role = 'unknown', routeActor = 'worker', workerExtraTools = [], verifierExtraTools = [] } = {}) {
  if (role === 'unknown') return allowList('unknown', [], 'unknown agent id');

  // MAIN means only the main agent is allowed to execute. Any already-running
  // worker/verifier is frozen immediately when the operator switches modes.
  if (mode === 'main' && role !== 'main') return allowList(role, [], 'main-only mode freezes non-main agents');

  if (role === 'worker') return allowList('worker', [...WORKER_DEFAULT_TOOLS, ...workerExtraTools]);
  if (role === 'verifier') return allowList('verifier', [...VERIFIER_DEFAULT_TOOLS, ...verifierExtraTools]);

  if (mode === 'main') {
    return { role: 'main', enforcement: 'deny-list', allow: ['*'], deny: ['sessions_spawn'], reason: 'main-only mode' };
  }

  if (mode === 'worker' || routeActor === 'worker') {
    return allowList('main', MAIN_DELEGATION_TOOLS, 'main is coordinator-only for delegated work');
  }

  // AUTO chose main: allow lightweight read/web work, but do not let main
  // second-guess the router by spawning a worker or mutating/executing.
  return allowList('main', MAIN_OBSERVE_TOOLS, 'auto mode selected main for a lightweight task');
}

export function toolDecision(policy, tool) {
  const normalizedTool = normalizeToolName(tool);
  if (!normalizedTool) return { allowed: false, reason: 'tool name is required', normalizedTool };
  if (policy.deny.map(normalizeToolName).includes(normalizedTool)) return { allowed: false, reason: 'explicitly denied', normalizedTool };
  if (policy.enforcement === 'allow-list' && !policy.allow.includes(normalizedTool) && !policy.allow.includes('*')) {
    return { allowed: false, reason: policy.reason || 'not present in allow list', normalizedTool };
  }
  return { allowed: true, reason: 'allowed by policy', normalizedTool };
}
