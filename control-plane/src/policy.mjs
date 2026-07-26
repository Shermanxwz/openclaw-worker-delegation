export const MAIN_SAFE_TOOLS = [
  'read',
  'sessions_spawn',
  'sessions_yield',
  'sessions_history',
  'session_status',
  'subagents',
];

export const MAIN_EXECUTION_TOOLS = [
  'write',
  'edit',
  'apply_patch',
  'exec',
  'process',
];

export function buildPolicy({ mode = 'auto', actor = 'main', role = 'main' } = {}) {
  if (role === 'worker') {
    return {
      role,
      enforcement: 'allow-list',
      allow: ['read', 'write', 'edit', 'apply_patch', 'exec', 'process'],
      deny: ['git.push', 'secrets.read'],
    };
  }

  if (role === 'verifier') {
    return {
      role,
      enforcement: 'allow-list',
      allow: ['read', 'exec', 'process'],
      deny: ['write', 'edit', 'apply_patch', 'git.push', 'secrets.read'],
    };
  }

  if (mode === 'main') {
    return {
      role: 'main',
      enforcement: 'deny-list',
      allow: ['*'],
      deny: ['sessions_spawn'],
    };
  }

  if (mode === 'worker' || actor === 'worker') {
    return {
      role: 'main',
      enforcement: 'allow-list',
      allow: [...MAIN_SAFE_TOOLS],
      deny: [...MAIN_EXECUTION_TOOLS],
    };
  }

  return {
    role: 'main',
    enforcement: 'deny-list',
    allow: ['*'],
    deny: [],
  };
}

export function toolDecision(policy, tool) {
  if (policy.deny.includes(tool)) return { allowed: false, reason: 'explicitly denied' };
  if (policy.enforcement === 'allow-list' && !policy.allow.includes(tool) && !policy.allow.includes('*')) {
    return { allowed: false, reason: 'not present in allow list' };
  }
  return { allowed: true, reason: 'allowed by policy' };
}
