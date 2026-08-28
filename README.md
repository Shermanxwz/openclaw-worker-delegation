# OpenClaw Delegation Control Plane

OpenClaw-native delegation control for autonomous `MAIN`, `WORKER`, and `AUTO` execution. The controller, native plugin, model registry bridge, durable Worker task store, and Web control surface are designed as one runtime control plane rather than a display-only sidecar.

> **v0.3.0 is the sealed mainline contract.** `main` is the product line. The runtime is fail-closed, Worker/Verifier execution is durably owned by `wrk_...` tasks, model routing is sourced from OpenClaw, and the Web UI is a control/observation surface rather than an execution authority.

## Product contract

- **WORKER** — Main is an autonomous planner/coordinator/reviewer. User body-work is delegated to Worker; Main does not ask the user whether delegation should happen. Only control-plane/status work stays on Main.
- **AUTO** — deterministic conservative routing keeps only unambiguous lightweight questions on Main; tool work, mutation, execution, repository scans, retry loops, substantial planning, and ambiguous work go to Worker.
- **MAIN** — Main executes directly and Worker/Verifier authority is fenced for the selected scope. Session/project/global fencing is scoped; a one-shot MAIN override does not cancel unrelated work.
- **Verifier** — independent read-only review role by default.
- **Fail closed** — a missing/invalid route binding, stale/expired Worker lease, owner-epoch mismatch, controller outage, or denied policy blocks tool execution.

## OpenClaw-native model routing

The plugin publishes the active OpenClaw model/provider registry to the controller and applies the selected route at `before_model_resolve` and native `sessions_spawn` boundaries.

- Provider/model choices come from OpenClaw configuration/runtime discovery, not a separate hard-coded catalog.
- Main/Worker/Verifier routes are mode-specific.
- Thinking/reasoning levels are exposed only when upstream OpenClaw policy declares them.
- **If upstream declares no levels, the only selectable value is `Auto`.** The controller never invents `low/medium/high/max` tiers.
- Worker spawn receives the selected agent/model/thinking and the remaining hard timeout.

## Durable delegated execution

Every provider-isolated Worker/Verifier execution receives a persistent `wrk_...` task record containing:

- role, target agent, provider/model/thinking route and execution provenance;
- parent Main run/session/project identity;
- Worker run/session/session-key/thread/turn identity when OpenClaw reports it;
- progress sequence, meaningful-progress sequence, heartbeat and event timeline;
- lease, grace window, owner epoch, review point and terminal state;
- structured bounded error information.

Hard product ceilings are immutable:

- `quick`: **10 minutes maximum total runtime**;
- `standard`: **60 minutes maximum total runtime**.

Heartbeat proves liveness; it does not renew the lease. Only meaningful progress renews normal lease authority, always clamped to the immutable hard deadline. A limited grace window exists for transient scheduling gaps. Stale heartbeat, exhausted grace, hard deadline, cancellation, or ownership mismatch fails closed.

Root-control cancel/extend remains an authenticated fallback. Cancellation revokes the current owner epoch immediately. Extension cannot move the hard deadline.

## Web control surface

The root dashboard is intentionally small: active mode, scope, and the model routing cards relevant to that mode. Operational detail is separated into dedicated pages:

- `/tasks.html` — durable `wrk_...` task lifecycle and root-control fallback;
- `/runtime.html` — OpenClaw runtime/model state and HARD enforcement proof;
- `/audit.html` — audit stream;
- `/settings.html` — advanced/control-plane information.

Changing a model route in the panel changes the authoritative routing profile consumed by the OpenClaw plugin; it is not a cosmetic preference.

## Architecture

```text
Browser / operator
       |
       | HTTPS (browser endpoints only)
       v
Control Plane 127.0.0.1:8787
  |-- mode/scope authority
  |-- OpenClaw Registry mirror + routing profiles
  |-- durable wrk_ task ownership / lease / provenance
  |-- route + tool policy gate
  |-- bounded audit/SSE observation
  `-- authenticated root-control fallback
       ^
       | loopback bearer API
       |
OpenClaw native delegation-guard plugin
  |-- before_model_resolve -> authoritative model route
  |-- before_prompt_build  -> autonomous role context
  |-- before_agent_run     -> fail-closed run boundary
  |-- before_tool_call     -> terminal tool gate + native spawn rewrite
  |-- model/subagent hooks -> provenance/progress/runtime
  `-- heartbeat/registry sync -> controller
       |
       +--> Main
       +--> body-worker
       `--> verifier
```

`HARD` is earned only from fresh plugin runtime identity plus real route/tool hook observations from the same plugin instance. A startup heartbeat alone never claims hard enforcement.

## Quick start

```bash
cd control-plane

CONTROL_PASSWORD_INPUT='a unique passphrase of at least 14 characters' npm run hash-password
npm run generate-token
npm run generate-totp-secret

cp .env.example .env
# Configure CONTROL_PASSWORD_HASH, AGENT_INGEST_TOKEN, PUBLIC_ORIGIN,
# optional TOTP and the real Main/Worker/Verifier agent IDs.

set -a; . ./.env; set +a
npm run check
npm test
npm run doctor
npm start
```

Install the native plugin:

```bash
cd control-plane/openclaw-plugin
openclaw plugins install --link .
openclaw plugins enable delegation-guard
openclaw gateway restart
openclaw plugins inspect delegation-guard --runtime --json
```

Use `control-plane/deploy/openclaw.example.json5` as the merge guide. The Gateway must receive the same random secret as `OCWD_AGENT_TOKEN` that the controller uses as `AGENT_INGEST_TOKEN`.

## Acceptance gates

A release is not considered sealed unless all repository gates pass:

- Node 20 and Node 22 controller syntax + unit + HTTP integration tests;
- plugin package validation;
- deployment/config validation;
- secret scanning;
- official OpenClaw plugin install/inspect smoke test;
- pinned real OpenClaw `2026.7.1-2` / Node 24 Gateway E2E.

The real-Gateway harness exercises actual OpenClaw plugin loading, routing/tool hooks, Main blocking, native Worker spawn and execution, MAIN takeover/fencing, one-shot override, model reporting, HARD proof, and controller-outage fail-closed behavior.

## Repository map

```text
control-plane/
├── src/                 # controller, security, router, policy, durable store
├── public/              # minimal dashboard + tasks/runtime/audit/settings pages
├── openclaw-plugin/     # native OpenClaw routing/enforcement bridge
├── integration/         # runtime-neutral sidecar integration helpers
├── deploy/              # Nginx/Caddy/systemd/OpenClaw examples
├── docs/                # API, threat model and audit material
└── test/                # unit, HTTP and real OpenClaw acceptance tests

skills/
└── adaptive-worker-delegation/
```

## Security boundary

The project governs OpenClaw/model-originated tool authority; it is not an OS/root security boundary. A compromised Gateway/controller, stolen agent token, root process, or side effects of an explicitly allowed shell command remain outside that boundary. Keep the controller loopback-only, publish only browser endpoints through trusted HTTPS, disable elevated Worker execution, and use OpenClaw sandbox/exec policy appropriate to the deployment.

Read before production deployment:

- `control-plane/docs/THREAT_MODEL.md`
- `control-plane/docs/AUDIT.md`
- `control-plane/docs/API.md`
- `control-plane/deploy/PUBLIC_IP_DEPLOY.md`

## License

MIT — see `LICENSE`.
