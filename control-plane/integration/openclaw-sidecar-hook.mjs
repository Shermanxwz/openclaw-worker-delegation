/**
 * Runtime-neutral client. Prefer the native plugin under ../openclaw-plugin for
 * actual OpenClaw deployments because it derives agent identity from host hook
 * context and blocks tools in before_tool_call.
 */
export function createDelegationClient({ baseUrl = 'http://127.0.0.1:8787', token, agentId, instanceId, fetchImpl = fetch }) {
  if (!token) throw new Error('agent token is required');
  if (!agentId) throw new Error('agentId is required');
  async function request(path, body) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, agentId, instanceId }),
    });
    if (!response.ok) throw new Error(`Delegation controller returned ${response.status}`);
    return response.json();
  }
  return {
    routeTask: (input) => request('/api/route', input),
    getPolicy: (input) => request('/api/policy', input),
    toolCheck: (input) => request('/api/tool-check', input),
    publishRuntimeStatus: (status) => request('/api/runtime-status', status),
    publishEvent: (event) => request('/api/events', event),
  };
}
