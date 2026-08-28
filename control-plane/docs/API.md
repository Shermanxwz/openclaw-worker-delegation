# API contract — v0.3

All responses are JSON. Browser mutations require an authenticated server-side session, `X-CSRF-Token`, and the configured Origin policy. Agent/runtime endpoints require `Authorization: Bearer <AGENT_INGEST_TOKEN>` and should be reachable only over loopback.

Identifiers are bounded. Runtime callers never choose their own role: the controller derives Main/Worker/Verifier from configured agent IDs.

## Public health

### `GET /health/live`

Process liveness only.

### `GET /health/ready`

Controller/store readiness.

## Browser/session endpoints

### `GET /api/login-config`

Returns whether TOTP is required.

### `POST /api/login`

```json
{ "password": "...", "totp": "123456" }
```

Sets an HttpOnly, SameSite=Strict session cookie and returns a CSRF token.

### `POST /api/logout`

Authenticated + CSRF. Invalidates the current browser session.

### `GET /api/session`

Returns authenticated session metadata and CSRF state.

### `GET /api/status?sessionId=...&projectId=...`

Returns resolved mode/scope, routing profiles, Registry snapshot, runtime model/enforcement state, Worker summary, metrics and latest real Main route.

## Mode control

### `PUT /api/mode`

Worker/Auto example:

```json
{
  "scope": "session",
  "id": "session-id",
  "mode": "worker",
  "ttlMinutes": 0
}
```

MAIN requires re-authentication:

```json
{
  "scope": "session",
  "id": "session-id",
  "mode": "main",
  "confirmation": "ENABLE_MAIN",
  "reauthPassword": "...",
  "reauthTotp": "123456",
  "ttlMinutes": 15
}
```

Persistent MAIN is available only when `MAIN_ALLOW_PERSISTENT=true` and uses `ENABLE_MAIN_PERSISTENT` with `ttlMinutes: 0`.

Scope semantics:

- `global`: all subsequent matching Main routes; MAIN fences all active delegated tasks.
- `project`: project-specific; MAIN fences only that project's active delegated tasks.
- `session`: session-specific; MAIN fences only that session's active delegated tasks.
- `task`: one-shot override consumed by exactly one authoritative Main route; a one-shot MAIN override does **not** cancel already-running delegated work.

Worker and Auto are persistent outside task scope. Bounded MAIN expires automatically unless persistent MAIN was explicitly enabled.

### `DELETE /api/mode`

Clears task/session/project overrides.

## Model Registry and routing

### `GET /api/registry`

Returns the latest OpenClaw-sourced Registry snapshot and routing profiles.

The Registry includes discovered providers/models, configured Main/Worker/Verifier model identities, OpenClaw version/revision information, and upstream-declared thinking levels when available.

### `PUT /api/routing`

Authenticated + CSRF.

```json
{
  "mode": "auto",
  "role": "worker",
  "modelRef": "provider/model",
  "thinking": "auto"
}
```

Rules:

- `modelRef` must exist in the current OpenClaw Registry.
- `role` must be valid for the selected mode; MAIN exposes only Main routing.
- non-`auto` thinking must be explicitly declared by the selected model's upstream thinking policy.
- when upstream declares no levels, only `auto` is accepted.

The saved routing profile is consumed by the native OpenClaw plugin; this endpoint is not display-only configuration.

## Browser observation

### `POST /api/route-preview`

Non-authoritative browser preview. It never creates a runtime route binding or changes route metrics.

### `GET /api/worker-tasks?limit=100&active=1`

Returns bounded durable `wrk_...` Worker/Verifier records.

### `GET /api/worker-tasks/:taskId`

Returns one durable task record.

### `POST /api/worker-tasks/:taskId/action`

Authenticated + CSRF + credential re-authentication. Root-control fallback only.

Cancel:

```json
{
  "action": "cancel",
  "confirmation": "CANCEL_TASK",
  "reauthPassword": "...",
  "reauthTotp": "123456"
}
```

Extend:

```json
{
  "action": "extend",
  "minutes": 5,
  "confirmation": "EXTEND_TASK",
  "reauthPassword": "...",
  "reauthTotp": "123456"
}
```

Cancel revokes the current owner epoch immediately. Extend is bounded and cannot move the immutable task hard deadline.

### `GET /api/events?limit=100`

Returns bounded newest-first audit events.

### `GET /api/stream`

Authenticated SSE stream with capped concurrent clients.

## Native OpenClaw/runtime endpoints

### `POST /api/registry-sync`

Plugin-only Registry publication. The controller normalizes and bounds provider/model/agent metadata and thinking declarations.

### `POST /api/runtime-status`

Plugin heartbeat with actual provider/model/session/runtime identity. Self-report alone never earns `HARD`; real route and tool observations from the same fresh plugin instance are also required.

### `POST /api/route`

Authoritative route binding for Main or a durable Worker/Verifier task.

Main example:

```json
{
  "hook": "before_model_resolve",
  "instanceId": "plugin-instance",
  "agentId": "main",
  "runId": "main-run",
  "sessionId": "main-session",
  "projectId": "project-id",
  "task": "fix the repository and run tests"
}
```

Worker example:

```json
{
  "hook": "before_model_resolve",
  "instanceId": "plugin-instance",
  "agentId": "body-worker",
  "runId": "child-run",
  "sessionId": "child-session",
  "taskId": "wrk_...",
  "ownerEpoch": 1,
  "task": "[[OCWD_TASK:wrk_...:1]]\n..."
}
```

Main routes consume scope/one-shot authority and persist the run binding. Worker/Verifier routes require a live durable task lease, matching agent ownership and owner epoch, then bind child execution identity to the task. Missing route/run identity fails closed.

The response contains route, policy, role, mode source, effective model route and task metadata when applicable.

### `POST /api/tasks/prepare`

Called by the plugin before native Main `sessions_spawn`. Only a Main run whose authoritative route selected Worker can prepare a task.

The controller creates a persistent `wrk_...` record and returns the spawn contract:

```json
{
  "task": { "id": "wrk_...", "ownerEpoch": 1, "kind": "standard" },
  "spawn": {
    "agentId": "body-worker",
    "model": "provider/model",
    "thinking": "high",
    "runTimeoutSeconds": 3599
  }
}
```

`thinking` is omitted when effective value is Auto. `runTimeoutSeconds` is always clamped to the remaining immutable task hard deadline.

### `POST /api/tasks/bind`

Binds child run/session/session-key/thread/turn identity to a prepared task. Requires matching `taskId`, `ownerEpoch` and target agent.

### `POST /api/tasks/heartbeat`

Updates task liveness/progress.

```json
{
  "taskId": "wrk_...",
  "ownerEpoch": 1,
  "agentId": "body-worker",
  "runId": "child-run",
  "sessionId": "child-session",
  "meaningful": true,
  "phase": "tool-complete",
  "summary": "..."
}
```

Ordinary heartbeat refreshes liveness only. `meaningful: true` advances meaningful progress and renews the normal lease, always clamped to the hard deadline.

### `POST /api/tasks/terminal`

Records `succeeded`, `failed`, `cancelled`, or `expired` terminal state with bounded structured error/review information.

### `POST /api/tool-check`

Terminal pre-tool authority gate. Required fields include authoritative run identity; Worker/Verifier calls additionally require durable task ownership.

```json
{
  "hook": "before_tool_call",
  "instanceId": "plugin-instance",
  "agentId": "body-worker",
  "runId": "child-run",
  "sessionId": "child-session",
  "taskId": "wrk_...",
  "ownerEpoch": 1,
  "tool": "exec"
}
```

A Worker/Verifier tool is allowed only when all of the following hold:

- durable run binding exists and matches role/session;
- task exists and is non-terminal;
- owner epoch matches;
- agent/run/session ownership matches;
- hard deadline is not exceeded;
- heartbeat is fresh;
- lease/grace authority is live;
- role/mode tool policy allows the tool.

Any failure returns `allowed: false`; caller-supplied `role`/`actor` cannot elevate authority.

### `POST /api/policy`

Diagnostic policy resolution using the same durable route binding and server-derived role semantics.

### `POST /api/events`

Runtime audit/lifecycle ingestion. Secret-shaped content is redacted and payload sizes are bounded.

## Hard runtime limits

The controller hard-clamps total task runtime even when configured directly:

- `quick`: 600 seconds;
- `standard`: 3600 seconds.

Environment variables may lower these ceilings but cannot raise them above the product contract.
