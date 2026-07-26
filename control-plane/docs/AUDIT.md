# Production hardening audit

This document records the review performed for the v0.2 control-plane branch. “Perfect” is not a defensible software claim; the target is a small, auditable system with explicit boundaries, regression tests, fail-closed defaults, and evidence from the real OpenClaw runtime.

## Critical findings fixed

- Caller-controlled `role`/`actor` could select a wider policy. Role is now derived from configured host agent IDs.
- A shared run ID could be reused with another agent/session. Route decisions are now bound and mismatches deny.
- A startup self-probe could make the panel claim `HARD` without a real hook invocation. Startup probes were removed; real hook traffic is required.
- Main-only mode stopped future spawns but did not freeze existing Workers. Non-main roles now receive an empty policy immediately in Main mode.
- Worker mode still let Main read files and browse, enabling duplicate body-work. Main is now coordination-only when delegated.
- Auto-routed lightweight Main tasks could still spawn Workers. The route is now authoritative.
- Worker/Auto persistent switches accidentally inherited the Main TTL. Persistent Worker/Auto no longer expire; the explicit next-task scope is one-shot and separately time-bounded.
- Expiring global Main state did not return to the default. Global expiry is now handled and periodically purged.
- Real `model_call_started`/`model_call_ended` hooks do not guarantee `ctx.agentId`; the host identity can be carried by `event.sessionKey`. Runtime model reporting now derives the Agent ID from the documented `agent:<id>:...` session identity when needed.

## Security and reliability findings fixed

- Added an actual native OpenClaw plugin using `before_prompt_build` and terminal `before_tool_call` blocking.
- Added fully fail-closed behavior and loopback controller validation in the plugin; controller loss blocks every tool rather than guessing which tools are safe.
- Added optional TOTP for login and Main elevation.
- Upgraded password hashing while retaining legacy hash verification.
- Bounded concurrent expensive password checks.
- Bounded sessions, login limiter state, SSE clients, event memory, and audit-log disk size.
- Serialized and atomically replaced state files.
- Tolerated and compacted a malformed trailing audit-log line after an unclean shutdown.
- Cleared hook observations after controller restart to prevent stale `HARD` status.
- Split browser route preview from real runtime routing metrics. Added a server-owned, expiring one-shot next-task override that is consumed once and bound to the resulting run.
- Removed anonymous mode leakage from health endpoints.
- Added strict request sizes, content types, identifiers, security headers, request IDs, graceful shutdown, and production config validation.
- Hardened systemd and reverse-proxy examples; agent-only APIs are excluded from the public proxy.
- Changed Verifier to genuinely read-only by default.

## Automated test coverage

The Node suite covers routing in Chinese and English, mode semantics, one-shot task consumption, role derivation, spoof attempts, route binding, Main elevation, optional TOTP, password hashing, global expiry, controller restart proof reset, concurrent state writes, audit recovery, native plugin package consistency, real Hook session identity normalization, and browser/agent API integration.

## Official OpenClaw runtime acceptance

GitHub Actions installs Node.js `24.15.0` and the pinned official npm package `openclaw@2026.7.1-2`, then starts a real Gateway and installs the linked `delegation-guard` plugin through the official CLI.

The real-runtime E2E has passed all of these assertions:

- plugin installation, enabling, configuration validation, and `plugins inspect --runtime --json`;
- nine registered plugin hooks, including `before_prompt_build`, `before_tool_call`, model, subagent, and Gateway lifecycle hooks;
- Auto mode blocking a real Main `exec` tool call;
- Worker mode allowing a real Main `sessions_spawn`, a real body-worker model turn, and a real Worker `exec`;
- Main mode allowing a real Main `exec`;
- a Worker that had already started model generation being blocked before its delayed `exec` after switching to Main;
- one-shot Main mode applying to exactly one real run and falling back on the next run;
- actual Main and Worker model/provider reporting;
- `HARD` proof from fresh heartbeat plus observed route and tool hooks;
- complete fail-closed behavior after the Controller process is stopped.

The E2E uses a deterministic local OpenAI-compatible endpoint so no third-party model key or probabilistic model behavior can hide a control-plane regression. The Gateway, plugin loader, agent and subagent loops, hook runner, and tools are the real OpenClaw implementation.

## Remaining target-VPS acceptance work

Repository and real-Gateway runtime behavior are validated. The remaining checks are specific to the operator's actual VPS and cannot be proven by a hosted CI runner:

- trusted public HTTPS certificate and phone login through the selected VPS address;
- the production model/provider credentials and fallback chain;
- systemd, Nginx/Caddy, firewall, state-directory permissions, and restart behavior on that host;
- real Worker sandbox isolation from Gateway credentials and host-sensitive paths;
- operator-selected exec approvals/allowlists and filesystem/network boundaries;
- load, disk retention, and recovery behavior under the VPS's actual resource limits.

See `THREAT_MODEL.md` and `deploy/PUBLIC_IP_DEPLOY.md`.
