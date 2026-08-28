# OpenClaw Delegation Control Plane v0.3

The control plane is a loopback Node.js controller plus a native OpenClaw plugin. Together they provide authoritative mode/model routing, durable Worker/Verifier ownership, fail-closed tool enforcement, runtime proof and a minimal Web control surface.

## Runtime authority

The Web UI is not the enforcement boundary. The native plugin participates directly in OpenClaw lifecycle hooks:

- `before_model_resolve` — applies the controller-selected provider/model route;
- `before_prompt_build` — injects the authoritative Main/Worker/Verifier role contract;
- `before_agent_run` — stops a run fail-closed when no authoritative route exists;
- `before_tool_call` — terminal policy/ownership/lease gate and native `sessions_spawn` rewrite;
- model/subagent hooks — report runtime identity, progress and terminal outcomes.

The controller exposes `HARD` only after a fresh plugin instance has produced real route and tool-gate observations. Controller or Gateway restart returns proof to `ADVISORY` until those boundaries are observed again.

## Mode behavior

### WORKER

Main is an autonomous coordinator/reviewer. Substantive user work is delegated to Worker without asking the user whether delegation should occur. Main keeps only coordination/status authority. Worker performs body-work; Verifier is independently read-only by default.

### AUTO

The deterministic router keeps only unambiguous lightweight questions on Main. Tool use, mutation, execution, repository scans, retries/debugging, substantial planning and ambiguous work delegate to Worker. This avoids progressively broadening Main authority when classification is uncertain.

### MAIN

Main executes directly and `sessions_spawn` is denied. Existing delegated authority is fenced only in the selected scope: global, project or session. A one-shot MAIN override applies to the next authoritative Main route and does not tear down unrelated running tasks. MAIN elevation requires explicit confirmation and credential re-authentication; persistent MAIN is opt-in.

## OpenClaw Registry and model routing

The plugin publishes configured/runtime provider-model information from OpenClaw and the controller stores only routing overrides. Route changes made in the Web UI are consumed by the plugin on subsequent OpenClaw model/spawn resolution.

Reasoning/thinking levels follow upstream capability declarations. If OpenClaw does not declare levels for a model, the control plane exposes only `Auto`; it never synthesizes provider-specific tiers.

## Durable `wrk_...` tasks

Every Worker/Verifier execution has persistent control-plane ownership with:

- role, target agent and provider/model/thinking route;
- Main parent run/session/project provenance;
- child run/session/session-key/thread/turn identity when available;
- heartbeat, meaningful progress, bounded event timeline and review point;
- owner epoch, lease, grace, immutable hard deadline and terminal state;
- structured bounded error information.

Product ceilings are hard-clamped even when the store is constructed directly:

- quick task: 10 minutes total;
- standard task: 60 minutes total.

A heartbeat proves liveness but does not renew the normal lease. Meaningful progress renews the lease only up to the hard deadline. Tool authority requires a durable route binding, correct owner epoch, fresh heartbeat, a live lease/grace window and matching Worker identity. Any mismatch fails closed.

Root-control cancel/extend is an authenticated fallback. Cancel increments the owner epoch immediately; extend cannot move the hard deadline.

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

The default URL is `http://127.0.0.1:8787`. Production requires loopback binding, trusted HTTPS `PUBLIC_ORIGIN`, secure cookies, a password hash, and a 32+ character agent token.

## Native plugin

```bash
openclaw plugins install --link ./openclaw-plugin
openclaw plugins enable delegation-guard
openclaw gateway restart
openclaw plugins inspect delegation-guard --runtime --json
```

Use `deploy/openclaw.example.json5` as the configuration guide. Set `OCWD_AGENT_TOKEN` in the Gateway environment to the same secret used as controller `AGENT_INGEST_TOKEN`. Never place the token in prompts, skills, workspaces or browser JavaScript.

## Web information architecture

The root page contains only the active mode/scope and relevant model routing cards. Detailed surfaces are separate:

- `/tasks.html` — Worker/Verifier lifecycle and authenticated root-control fallback;
- `/runtime.html` — OpenClaw runtime/model state and enforcement proof;
- `/audit.html` — audit events;
- `/settings.html` — advanced control-plane information.

## Public deployment

Use `deploy/PUBLIC_IP_DEPLOY.md`. The reverse-proxy examples keep the controller on loopback, expose only browser endpoints over HTTPS, hide agent ingestion/routing/tool endpoints, rate-limit login/API traffic and preserve SSE behavior.

## Acceptance

```bash
npm run check
npm test
npm run doctor
```

Repository CI additionally validates Node 20/22, the plugin package, deployment examples, secret scanning, official plugin install/inspect and a pinned real OpenClaw `2026.7.1-2` Gateway E2E on Node 24.

## Documentation

- `docs/API.md` — HTTP contract.
- `docs/THREAT_MODEL.md` — guarantees and non-goals.
- `docs/AUDIT.md` — engineering/security acceptance record.
- `deploy/openclaw.example.json5` — OpenClaw multi-agent/plugin configuration guide.
