/**
 * Runtime-neutral adapter for an OpenClaw-style agent loop.
 *
 * The runtime MUST call toolCheck() before executing a tool. Merely fetching
 * policy without enforcing the returned decision is not a security boundary.
 *
 * The runtime SHOULD also call publishRuntimeStatus() on session start, model
 * fallback/switch, worker lifecycle changes, and periodically while active.
 * The web panel deliberately displays "not reported" instead of guessing.
 */
export function createDelegationClient({ baseUrl = 'http://127.0.0.1:8787', token, fetchImpl = fetch }) {
  if (!token) throw new Error('agent ingest token is required');

  async function request(path, body) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
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
