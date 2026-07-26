# OpenClaw Delegation Control Plane

A three-mode delegation controller for OpenClaw: keep Main as coordinator, send body-work to Workers, or temporarily let Main take over — with a phone-friendly Web panel, current-model visibility, and a native pre-tool enforcement plugin.

> The repository's `main` branch remains the stable v0.1.1 documentation-only project. Development of the v0.2 runtime is isolated on `agent/control-plane-mvp` and proposed through PR #1.

## What v0.2 adds

- One-click `WORKER`, `AUTO`, and time-bounded `MAIN` modes.
- One-shot task, session, project, and global mode precedence.
- Mobile Web panel over normal public-IP HTTPS; no Cloudflare or Tailscale dependency.
- Current Main model, provider, session, Worker models, and heartbeat freshness.
- Deterministic bilingual routing with explanations.
- A native OpenClaw plugin that uses `before_prompt_build` and terminal `before_tool_call` blocking.
- Host-derived agent roles, run/session route binding, fail-closed behavior, and auditable allowed/blocked calls.
- Explicit `HARD` versus `ADVISORY` state based on real hook observations, not a checkbox or startup claim.
- Password re-authentication, optional TOTP, CSRF/Origin checks, rate limits, bounded sessions/SSE/logs, and hardened deployment examples.
- Zero third-party runtime dependencies for the controller; Node.js 20+.
- A pinned real-OpenClaw end-to-end test using OpenClaw `2026.7.1-2` and Node.js `24.15.0`.

## Modes

| Mode | Main | Worker / Verifier |
|---|---|---|
| `WORKER` | Pure text Q&A plus coordination tools only; no file reads, web body-work, mutation, or execution | Worker executes; Verifier is read-only by default |
| `AUTO` | Router decides. A Main-routed light task may read/search but cannot mutate, execute, or spawn; a delegated task makes Main coordination-only | Runs when selected by routing |
| `MAIN` | Full tool set except automatic Worker spawn; privilege expires | Existing Worker/Verifier tool calls are frozen immediately |

Model fallback never changes role permissions.

## Architecture

```text
Phone browser
    |
    | HTTPS :443
    v
Nginx / Caddy on the VPS
    |
    | browser API only
    v
Control Plane 127.0.0.1:8787
    |-- mode store and expiry
    |-- deterministic router
    |-- policy/tool gate
    |-- bounded audit stream
    `-- runtime/model status
             ^
             | loopback bearer API
             |
OpenClaw native delegation-guard plugin
    |-- before_prompt_build -> /api/route
    |-- before_tool_call   -> /api/tool-check
    |-- model/subagent hooks -> runtime status
    `-- block: true on denied tools
```

OpenClaw documents `before_tool_call` as an in-process pre-execution hook that can return terminal `block: true`. The included plugin is the enforcement point; the Web panel alone is not a sandbox.

## Quick start

```bash
cd control-plane

CONTROL_PASSWORD_INPUT='a unique passphrase of at least 14 characters' npm run hash-password
npm run generate-token
npm run generate-totp-secret   # recommended for public access

cp .env.example .env
# Fill CONTROL_PASSWORD_HASH, AGENT_INGEST_TOKEN, optional TOTP, PUBLIC_ORIGIN,
# and the real Main/Worker/Verifier agent IDs.

set -a; . ./.env; set +a
npm run check
npm test
npm run doctor
npm start
```

The controller intentionally rejects non-loopback `HOST` values. Publish it through `control-plane/deploy/nginx-public-ip.conf` or the optional Caddy example.

## Install the native OpenClaw plugin

```bash
cd /opt/openclaw-worker-delegation/control-plane/openclaw-plugin
openclaw plugins install --link .
openclaw plugins enable delegation-guard
openclaw gateway restart
openclaw plugins inspect delegation-guard --runtime --json
```

Merge `control-plane/deploy/openclaw.example.json5` into the real OpenClaw configuration and provide the same random token to the Gateway as `OCWD_AGENT_TOKEN`.

The panel remains `ADVISORY` until the controller observes a real `before_prompt_build` route and a real `before_tool_call` check from the same fresh plugin instance. This prevents a heartbeat or startup probe from falsely claiming hard enforcement.

## Real OpenClaw end-to-end validation

The repository does not rely only on a mocked plugin host. `.github/workflows/openclaw-e2e.yml` installs the pinned official npm package, starts a real Gateway, installs the actual linked plugin, and drives real agent/tool loops through a deterministic local OpenAI-compatible model endpoint.

The test proves:

- official plugin install, enable, config validation, and runtime inspection;
- runtime registration of `before_prompt_build` and `before_tool_call`;
- Auto mode blocks Main `exec`;
- Worker mode permits a real `sessions_spawn` and Worker `exec`;
- Main mode permits Main `exec`;
- switching to Main freezes a Worker that was already generating its tool call;
- a next-task Main override is consumed exactly once;
- Main and Worker models/providers are reported from real model/subagent hooks;
- the panel reaches `HARD` only after observed runtime hooks;
- stopping the Controller blocks every subsequent tool in fail-closed mode.

The deterministic model server removes external provider keys and nondeterminism; the Gateway, plugin loader, agent loop, subagent loop, and tool execution path are the official OpenClaw runtime.

## Repository map

```text
control-plane/
├── src/                         # controller, auth, store, router and policy
├── public/                      # responsive phone Web UI
├── openclaw-plugin/             # native OpenClaw enforcement plugin
├── integration/                 # runtime-neutral client for other loops
├── deploy/                      # public-IP Nginx, Caddy, systemd, config example
├── docs/                        # API, audit and threat model
├── scripts/validate-deployment.sh
└── test/
    ├── *.test.mjs               # unit and HTTP integration tests
    └── openclaw/                # pinned real-Gateway E2E harness

skills/
└── adaptive-worker-delegation/  # v0.2 behavior guidance (replaces retired model-aware-worker-delegation)
```

## Security boundary

This project blocks model-originated tool calls. It does not protect against root, a compromised Gateway/controller process, a stolen agent token, or the side effects of an allowed Worker shell command. An allowed `exec` can mutate files even if file-edit tools are denied, so Workers should run in an OpenClaw sandbox with elevated execution disabled and appropriate exec approval/allowlist policy.

Read before deployment:

- `control-plane/docs/THREAT_MODEL.md`
- `control-plane/docs/AUDIT.md`
- `control-plane/deploy/PUBLIC_IP_DEPLOY.md`
- `control-plane/docs/API.md`

## Validation

```bash
cd control-plane
npm run check
npm test
./scripts/validate-deployment.sh   # on the target VPS after installation
```

CI runs the complete Node test suite on Node 20 and 22, plugin package checks, official OpenClaw plugin smoke tests, the pinned real-Gateway E2E, skill validation, and secret scanning.

## License

MIT — see `LICENSE`.
