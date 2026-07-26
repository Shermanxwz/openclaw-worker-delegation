# OpenClaw Delegation Control Plane

The control plane is a small Node.js sidecar plus a native OpenClaw plugin. It provides externally controlled delegation modes, a public-IP-ready phone UI, actual model reporting, and pre-tool enforcement.

## Required components

1. **Controller** — stores modes, routes tasks, evaluates tools, serves the Web UI, and records bounded audit events.
2. **Native plugin** — runs inside OpenClaw and calls the controller from `before_prompt_build` and `before_tool_call`.
3. **Reverse proxy** — terminates trusted HTTPS for the public phone UI while hiding agent-only endpoints.
4. **Distinct agent IDs** — Main, body Worker, and Verifier must match controller and plugin configuration.

Starting only the controller produces `ADVISORY`, not `HARD`.

## Local setup

```bash
CONTROL_PASSWORD_INPUT='a unique passphrase of at least 14 characters' npm run hash-password
npm run generate-token
npm run generate-totp-secret
cp .env.example .env
set -a; . ./.env; set +a
npm run check
npm test
npm run doctor
npm start
```

The default URL is `http://127.0.0.1:8787`. Production configuration requires loopback binding, HTTPS `PUBLIC_ORIGIN`, secure cookies, a password hash, and a 32+ character agent token.

## Native plugin setup

```bash
openclaw plugins install --link ./openclaw-plugin
openclaw plugins enable delegation-guard
openclaw gateway restart
openclaw plugins inspect delegation-guard --runtime --json
```

Use `deploy/openclaw.example.json5` as a merge guide. The plugin defaults to:

- loopback controller URL;
- fully fail-closed behavior: no tool is allowed while the controller is unreachable;
- 2.5-second controller request timeout;
- 30-second runtime/model heartbeat;
- explicit Main/Worker/Verifier agent-ID maps.

Set `OCWD_AGENT_TOKEN` in the OpenClaw Gateway environment to the same value used as controller `AGENT_INGEST_TOKEN`. Never put it in a prompt, skill, workspace file, or browser JavaScript.

## Enforcement proof

The Web UI shows `HARD` only when all conditions are true:

- plugin heartbeat is fresh;
- plugin reports route and tool hooks enabled;
- the controller observed a real `/api/route` call marked `before_prompt_build`;
- the controller observed a real `/api/tool-check` call marked `before_tool_call`;
- both observations belong to the current plugin instance.

A Gateway or controller restart returns the state to `ADVISORY` until real traffic proves the hooks again.

## Mode behavior

### Worker

Main may answer without tools and coordinate workers. It receives session/agent coordination tools but not `read`, web tools, file mutation, or runtime execution. This prevents Main from “helpfully” duplicating Worker body-work.

### Auto

The deterministic router scores task properties. If it chooses Main, Main may perform lightweight read/web work but cannot mutate, execute, or spawn. If it chooses Worker, Main becomes coordination-only.

### Main

Main may use its statically available tools except `sessions_spawn`. Existing Workers and Verifiers are immediately frozen by an empty dynamic policy. Web elevation requires explicit confirmation, password, optional TOTP, and expiry.

Persistent Main mode is intentionally time-bounded by default (see `MAIN_MODE_MAX_TTL_MINUTES`). Operators may opt into persistent Main by setting `MAIN_ALLOW_PERSISTENT=true` in the controller environment. When enabled, the Web panel exposes a “until I manually switch back to Auto” option that requires the explicit `ENABLE_MAIN_PERSISTENT` confirmation token in addition to the normal password and TOTP re-auth. Persistent Main stays in effect until the operator switches back to Auto or Worker in the Web panel. Worker and Auto persist until changed by default. A “next task” override is always one-shot and expires if it is not consumed.

## One-shot next-task override

Choose “下一次任务” in the Web panel and enter the actual runtime session ID. The controller stores the mode with a short expiry, consumes it on the next authoritative Main route for that session, binds it to that run, and then falls back to the session/project/global mode. Agent request bodies cannot invent or elevate a one-shot override.

## Model reporting

The plugin reports resolved provider/model information from model-call hooks and subagent lifecycle hooks. The UI distinguishes actual model from configured model where both are available. Missing data displays `未上报`; the controller never guesses.

## Public VPS deployment

Use `deploy/PUBLIC_IP_DEPLOY.md`. The provided Nginx profile:

- exposes only HTTPS browser endpoints;
- returns 404 for route/policy/tool/runtime agent endpoints;
- prevents public POSTs to event ingestion;
- rate-limits login and API requests;
- disables buffering for SSE;
- leaves the controller on loopback.

## Operational commands

```bash
npm run doctor
curl --fail http://127.0.0.1:8787/health/ready
openclaw plugins inspect delegation-guard --runtime --json
./scripts/validate-deployment.sh
```

## Documentation

- `docs/API.md` — endpoint contract.
- `docs/THREAT_MODEL.md` — guarantees and non-goals.
- `docs/AUDIT.md` — findings fixed and deployment acceptance work.
- `deploy/openclaw.example.json5` — multi-agent/plugin configuration example.
