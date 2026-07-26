# Production hardening audit

This document records the review performed for the v0.2 control-plane branch. “Perfect” is not a defensible software claim; the target is a small, auditable system with explicit boundaries, regression tests, and fail-closed defaults.

## Critical findings fixed

- Caller-controlled `role`/`actor` could select a wider policy. Role is now derived from configured host agent IDs.
- A shared run ID could be reused with another agent/session. Route decisions are now bound and mismatches deny.
- A startup self-probe could make the panel claim `HARD` without a real hook invocation. Startup probes were removed; real hook traffic is required.
- Main-only mode stopped future spawns but did not freeze existing Workers. Non-main roles now receive an empty policy immediately in Main mode.
- Worker mode still let Main read files and browse, enabling duplicate body-work. Main is now coordination-only when delegated.
- Auto-routed lightweight Main tasks could still spawn Workers. The route is now authoritative.
- Worker/Auto Web switches accidentally inherited the Main TTL. Only Main is time-bounded.
- Expiring global Main state did not return to the default. Global expiry is now handled and periodically purged.

## Security and reliability findings fixed

- Added an actual native OpenClaw plugin using `before_prompt_build` and terminal `before_tool_call` blocking.
- Added fail-closed behavior and loopback controller validation in the plugin.
- Added optional TOTP for login and Main elevation.
- Upgraded password hashing while retaining legacy hash verification.
- Bounded concurrent expensive password checks.
- Bounded sessions, login limiter state, SSE clients, event memory, and audit-log disk size.
- Serialized and atomically replaced state files.
- Tolerated and compacted a malformed trailing audit-log line after an unclean shutdown.
- Cleared hook observations after controller restart to prevent stale `HARD` status.
- Split browser route preview from real runtime routing metrics.
- Removed anonymous mode leakage from health endpoints.
- Added strict request sizes, content types, identifiers, security headers, request IDs, graceful shutdown, and production config validation.
- Hardened systemd and reverse-proxy examples; agent-only APIs are excluded from the public proxy.
- Changed Verifier to genuinely read-only by default.

## Test coverage

The suite covers routing in Chinese and English, mode semantics, role derivation, spoof attempts, route binding, Main elevation, optional TOTP, password hashing, global expiry, controller restart proof reset, concurrent state writes, audit recovery, native plugin package consistency, and browser/agent API integration.

## Remaining deployment acceptance work

No repository can prove the behavior of a VPS it has not been installed on. Before calling a deployment complete:

- Install and enable the native plugin in the target OpenClaw Gateway.
- Confirm runtime inspection lists both hooks.
- Confirm the Web panel reaches `HARD` only after a real route and real tool call.
- Test blocked Main file/read/web/runtime tools in Worker mode.
- Test Worker freeze in Main mode.
- Test mode expiry and controller/Gateway restart behavior.
- Confirm the Worker sandbox cannot read Gateway credentials or host-sensitive paths.

See `THREAT_MODEL.md` and `deploy/PUBLIC_IP_DEPLOY.md`.
