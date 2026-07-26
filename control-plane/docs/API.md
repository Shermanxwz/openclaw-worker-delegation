# API contract

All responses are JSON. Browser mutation endpoints require a server-side session cookie, `X-CSRF-Token`, and the configured `Origin`. Agent endpoints require `Authorization: Bearer <AGENT_INGEST_TOKEN>` and should be reachable only over loopback.

## Public and browser endpoints

### `GET /health/live`

Liveness only. It intentionally does not reveal mode or model.

### `GET /health/ready`

Controller/store readiness.

### `GET /api/login-config`

Returns whether a TOTP code is required. No secrets are returned.

### `POST /api/login`

```json
{ "password": "...", "totp": "123456" }
```

Returns a CSRF token and sets an HttpOnly, SameSite=Strict session cookie.

### `GET /api/status?sessionId=...&projectId=...`

Returns the resolved mode, scope entries, current runtime/model heartbeat, enforcement proof, metrics, and latest real main-agent route.

### `PUT /api/mode`

```json
{
  "scope": "session",
  "id": "session-id",
  "mode": "worker",
  "ttlMinutes": 0
}
```

For `mode: "main"`, also send:

```json
{
  "confirmation": "ENABLE_MAIN",
  "reauthPassword": "...",
  "reauthTotp": "123456",
  "ttlMinutes": 15
}
```

Persistent Main mode is time-bounded by the UI/API. Worker and Auto persist until changed. With `scope: "task"`, `id` is a session ID and the override is consumed by exactly one real Main route; every task override expires if unused.

### `DELETE /api/mode`

Clears a task, session, or project override.

### `POST /api/route-preview`

Browser-only, non-authoritative preview. It does not create a runtime route binding or affect real routing metrics.

### `GET /api/events`

Returns bounded, newest-first audit events.

### `GET /api/stream`

Authenticated SSE stream. The number of concurrent clients is capped.

## Agent endpoints

### `POST /api/route`

Called by the native `before_prompt_build` hook.

```json
{
  "hook": "before_prompt_build",
  "instanceId": "plugin-instance-uuid",
  "agentId": "main",
  "runId": "run-id",
  "sessionId": "session-id",
  "projectId": "project-id",
  "task": "user request"
}
```

The controller derives the role from `agentId`, atomically consumes any pending one-shot override for that session, resolves the current mode, returns the authoritative route/policy, and binds the decision to the run/agent/session where identifiers are present. Agent callers cannot elevate to Main with `taskMode`.

### `POST /api/tool-check`

Called by the native `before_tool_call` hook before every tool invocation.

```json
{
  "hook": "before_tool_call",
  "instanceId": "plugin-instance-uuid",
  "agentId": "main",
  "runId": "run-id",
  "sessionId": "session-id",
  "tool": "exec",
  "toolKind": null,
  "toolInputKind": null,
  "toolCallId": "call-id"
}
```

Returns:

```json
{
  "allowed": false,
  "reason": "main is coordinator-only for delegated work",
  "normalizedTool": "exec",
  "mode": "worker",
  "role": "main"
}
```

A route binding mismatch is denied. Caller-supplied `role` or `actor` fields are ignored.

### `POST /api/runtime-status`

Heartbeat containing actual model/provider/session data and plugin instance ID. `HARD` is not granted from this self-report alone; the controller must also observe real route and tool-hook calls for the same instance.

### `POST /api/events`

Runtime lifecycle/audit ingestion. Common secret-shaped fields are redacted and large payloads are truncated.

### `POST /api/policy`

Diagnostic policy lookup for the native plugin or operator tooling. It follows the same server-side agent-role and route-binding rules as tool checks.
