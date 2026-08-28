# Threat model — v0.3

## Security goal

The control plane prevents OpenClaw/model-originated execution from silently crossing the selected Main/Auto/Worker role boundary and prevents a Worker/Verifier from retaining tool authority after its durable task ownership, liveness or deadline is invalid.

The design is fail-closed: inability to prove current route/ownership authority blocks tools rather than inferring permission from model intent.

## Trusted components

- VPS operating system and root administrator.
- OpenClaw Gateway process and installed `delegation-guard` plugin code.
- Loopback connection between plugin and controller.
- Controller state/environment, TLS private key and agent token.
- Reverse-proxy/firewall configuration that keeps agent-only endpoints off the public Internet.

## Untrusted or partially trusted components

- Model output, prompts and tool selections.
- Worker-produced text, patches, commands, URLs and logs.
- Browser requests before authentication.
- Runtime-supplied event content and human-readable provider/model names.
- Public Internet clients.

## Enforced guarantees

1. `before_tool_call` can terminally block a tool before OpenClaw executes it.
2. Role is derived from configured OpenClaw agent identity; request bodies cannot self-promote with `role`/`actor` fields.
3. Authoritative Main routes are persistently bound to run/agent/session identity. Missing run/binding fails closed.
4. Worker/Verifier tool calls require a durable `wrk_...` task, matching owner epoch, matching execution identity, fresh heartbeat, live lease/grace, and an unexpired hard deadline.
5. Owner epoch revocation prevents an old Worker incarnation from regaining authority after root cancellation or mode fencing.
6. WORKER makes Main coordinator/reviewer only for substantive user work. Main cannot silently duplicate Worker body-work with file/web/runtime tools.
7. AUTO is conservative: tool/heavy/ambiguous work delegates rather than progressively widening Main authority.
8. MAIN denies Worker spawning and fences existing delegated authority only within the selected global/project/session scope. One-shot MAIN does not kill unrelated already-running work.
9. MAIN elevation requires explicit confirmation and browser credential re-authentication. Persistent MAIN is separately opt-in and uses a distinct confirmation token.
10. The OpenClaw Registry is authoritative for selectable model refs. Non-Auto reasoning levels are accepted only when upstream declares them.
11. Quick tasks are hard-clamped to 600 seconds total; standard tasks to 3600 seconds total. Configuration may lower but cannot raise these product ceilings.
12. Ordinary heartbeat proves liveness only. Meaningful progress renews normal lease authority, never beyond the immutable hard deadline.
13. `HARD` requires a fresh plugin heartbeat plus actual route and tool-hook observations from the same plugin instance. Controller restart clears old observations.
14. State writes are atomic/serialized and audit/state retention is bounded.
15. Public reverse-proxy examples expose browser endpoints only and hide agent/runtime control APIs.

## Important execution boundary: logical cancellation vs process destruction

Root-control cancel and MAIN fencing revoke the durable task owner epoch and therefore block all subsequent plugin-governed tools immediately. Native Worker spawn also receives a bounded OpenClaw `runTimeoutSeconds` matching the remaining hard deadline.

The controller does **not** claim to be an operating-system process supervisor. If a Worker model call or non-tool runtime operation is already executing inside OpenClaw, revoking task authority does not guarantee instant physical thread/process destruction. The security guarantee is immediate revocation of subsequent governed tool authority plus bounded native OpenClaw timeout. A deployment that requires hard process kill semantics must enforce that at the OpenClaw/runtime or OS supervisor layer.

## Explicit non-goals and residual risks

### Compromised host, Gateway or controller

Root, the OpenClaw service account, a compromised Gateway/controller process, or an attacker holding `AGENT_INGEST_TOKEN` can bypass/impersonate the control plane. This project is not host intrusion prevention.

### Allowed shell side effects

Tool policy filters authority to call a tool; it cannot introspect every side effect inside an allowed `exec`. A permitted Worker shell command can write files, access networks, invoke Git or launch programs. Use OpenClaw sandboxing, disabled elevation and suitable exec approvals/allowlists for high-consequence deployments.

### Credential exposure to Worker

Never put `OCWD_AGENT_TOKEN` in prompts, task briefs, workspaces or generic shell profiles. A Worker that can inspect Gateway process credentials can steal it. Strong deployments isolate Worker execution from Gateway/service credentials.

### Hook timeout behavior

A timed-out host hook can undermine fail-closed expectations if OpenClaw continues execution. Keep OpenClaw hook timeouts greater than the plugin HTTP request timeout. The example uses a 2.5-second controller request timeout and 5-second critical hook timeouts.

### Model correctness and verifier correctness

Delegation/verification does not make generated work correct. The verifier is an independent evidence/review role, not a proof system. Use sandboxing, tests, Git review and human approval for high-impact operations.

### Registry completeness

The plugin mirrors provider/model information visible through the installed OpenClaw configuration/runtime interfaces and runtime-observed models. It does not claim to discover a provider's entire remote catalog independently of OpenClaw. The control plane therefore never invents models or reasoning tiers outside what OpenClaw exposes.

### Availability

`failMode: "closed"` protects integrity at the cost of availability: controller loss blocks tools because current authority cannot be proven. `failMode: "open"` is intentionally available only as an operator-selected tradeoff and is not the recommended sealed-production posture.

## Recommended production posture

- Controller loopback-only.
- Trusted HTTPS at the reverse proxy.
- Unique 14+ character passphrase plus TOTP.
- 32+ character random agent token outside prompts/config-visible workspaces.
- Distinct Main, Worker and Verifier agent IDs.
- Worker sandbox with no elevated execution and appropriately scoped workspace access.
- Verifier read-only by default.
- `failMode: "closed"`.
- Hook timeouts larger than controller request timeout.
- Regular `openclaw plugins inspect delegation-guard --runtime --json` checks.
- Treat `HARD` as runtime evidence, not a static installation badge.
