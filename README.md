# openclaw-worker-delegation

A model-aware delegation rule set plus an experimental control plane for deciding whether an OpenClaw-style main session should answer directly or delegate execution to workers.

> `main` remains the stable v0.1.1 documentation-only release. The `agent/control-plane-mvp` branch adds the v0.2 control-plane MVP without changing the existing main branch.

## v0.2 control-plane MVP

The new `control-plane/` application turns delegation from prompt advice into externally controlled runtime state.

### What is included

- Three one-click modes: `worker`, `auto`, and `main`.
- Mode precedence: task override, session, project, then global default.
- Expiring privilege elevation for main-only mode.
- Deterministic routing scores and readable decision reasons.
- A policy endpoint for main, worker, and verifier tool sets.
- A mandatory pre-tool-check endpoint for hard runtime enforcement.
- Runtime heartbeat reporting for the active main model, configured model, provider, workers and enforcement wiring.
- Event ingestion for route, worker, verification, attempted and blocked tool calls.
- A mobile-friendly web panel with live SSE updates.
- Visible `HARD` versus `ADVISORY` enforcement state in the Web panel.
- Password login, server-side sessions, CSRF protection, Origin checks, login throttling, redaction and security headers.
- Loopback-only controller binding with Caddy and direct-public-IP Nginx deployment examples.
- Zero third-party runtime dependencies; Node.js 20+ is sufficient.

### Architecture

```text
Phone browser
    |
    | HTTPS :443
    v
Caddy / Nginx on the VPS
    |
    | loopback
    v
Delegation Control Plane :8787
    |-- mode store
    |-- router
    |-- permission policy
    |-- tool gate
    |-- runtime/model status
    |-- event stream
    `-- mobile web panel
          |
          v
OpenClaw runtime adapter
    |-- main
    |-- body worker
    `-- verifier
```

The runtime adapter is the enforcement point. It must call `/api/tool-check` before every tool invocation and refuse blocked actions. A runtime that only reads the policy but ignores the result remains advisory.

### Important: what is still runtime integration work

The repository contains the controller, API, Web panel and a runtime-neutral adapter, but it cannot patch an arbitrary OpenClaw installation automatically. For actual hard enforcement, the deployed OpenClaw agent loop still must:

1. call `/api/route` before choosing main versus worker;
2. call `/api/tool-check` before every tool execution;
3. refuse execution whenever `allowed` is `false`;
4. report the active main/worker models through `/api/runtime-status`;
5. publish worker and tool lifecycle events.

The Web panel shows `HARD` only when the runtime reports that both route and tool-check integration are wired. Otherwise it shows `ADVISORY`. It also shows `未上报` instead of guessing the current model.

Implementation checklist:

- [x] Control plane, router, policies and tool-check API.
- [x] Mobile Web panel and model/enforcement display.
- [x] Runtime-neutral client at `control-plane/integration/openclaw-sidecar-hook.mjs`.
- [ ] Connect that client to the actual OpenClaw agent loop used on the target VPS.
- [ ] Verify that no tool can execute after `allowed: false`.
- [ ] Send model heartbeats on startup, fallback, switch and worker lifecycle changes.

## Quick start

```bash
cd control-plane

CONTROL_PASSWORD_INPUT='choose-a-long-password' npm run hash-password
cp .env.example .env
# Add the generated hash and a long random AGENT_INGEST_TOKEN.

set -a
. ./.env
set +a

npm test
npm start
```

Open the controller locally at `http://127.0.0.1:8787`. For a VPS, expose it through the supplied reverse-proxy configs rather than changing `HOST` to `0.0.0.0`.

Deployment examples:

- `control-plane/deploy/Caddyfile` for a normal HTTPS hostname.
- `control-plane/deploy/nginx-public-ip.conf` for direct public-IP access with a trusted IP certificate.
- `control-plane/deploy/openclaw-delegation.service` for systemd.

## Modes

### Worker

Main plans, prepares briefs, spawns workers, reviews output and reports. Tool work is routed to workers. Main receives an allow-list containing read and session-management capabilities, while write/edit/patch/exec/process are denied.

Pure text questions stay in main by default. Runtimes may request `workerAll` to delegate those too.

### Auto

Tasks receive an explainable score. Mutation, command execution, repository scans and retry-heavy work route to workers. Tool-requiring uncertainty fails closed to a worker.

### Main

Main receives execution tools and automatic worker spawning is denied. Switching to this mode through the web panel requires password re-authentication and gets a bounded expiry time.

## Runtime API

Browser-authenticated endpoints:

```text
POST /api/login
GET  /api/session
GET  /api/status
PUT  /api/mode
DELETE /api/mode
POST /api/route
GET  /api/events
GET  /api/stream
```

Agent bearer-token endpoints:

```text
POST /api/route
POST /api/policy
POST /api/tool-check
POST /api/runtime-status
POST /api/events
```

A runtime-neutral client is included at `control-plane/integration/openclaw-sidecar-hook.mjs`.

## Existing v0.1 rules remain available

The original skill is still present at:

```text
skills/model-aware-worker-delegation/SKILL.md
```

The new externally controlled skill is additive:

```text
skills/adaptive-worker-delegation/SKILL.md
```

The original documentation remains useful for worker briefs, cost routing and failure recovery:

- `examples/worker-brief-template.md`
- `examples/decision-flow.md`
- `examples/pre-flight-checklist.md`
- `docs/failure-modes.md`
- `docs/cost-routing.md`

## Validation

```bash
cd control-plane
npm test
npm run doctor
```

GitHub Actions runs the Node tests for control-plane changes, alongside the existing skill validation and secret scan workflows.

## Security posture

- The controller rejects `HOST=0.0.0.0`.
- Only the reverse proxy should be internet-facing.
- Main-mode elevation requires re-authentication and expires.
- Browser writes require a valid session, CSRF token and configured Origin.
- Agent endpoints require a separate bearer token.
- Event payloads redact common secret fields and truncate oversized content.
- There is intentionally no arbitrary shell endpoint in the web panel.

## License

MIT — see `LICENSE`.
