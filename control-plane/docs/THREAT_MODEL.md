# Threat model

## Security goal

The control plane prevents an OpenClaw model from silently crossing the selected Main/Auto/Worker role boundary. It is designed to stop accidental or model-originated tool use before execution and to make the effective mode, model, routing, and blocked calls observable from a phone.

## Trusted components

- The VPS operating system and root administrator.
- The OpenClaw Gateway process and installed `delegation-guard` plugin code.
- The loopback connection between the plugin and controller.
- The controller environment file, state directory, TLS private key, and agent token.
- Nginx/Caddy configuration that keeps agent-only endpoints off the public Internet.

## Untrusted or partially trusted components

- Model output and tool selections.
- Worker-produced text, patches, commands, URLs, and logs.
- Browser requests before authentication.
- Event payloads and model/provider names sent by the runtime.
- Network clients on the public Internet.

## Enforced guarantees

1. `before_tool_call` can terminally block a tool before OpenClaw executes it.
2. The controller derives role from configured `agentId`; request bodies cannot elevate `main` by claiming `role=worker`.
3. Real route decisions are bound to run, agent, and session where those identifiers are available.
4. Worker mode gives main coordination tools only. Main cannot read files, browse, mutate, or execute body-work tools.
5. Auto mode makes the router authoritative: a main-routed light task cannot spawn a worker; a worker-routed task cannot be duplicated by main.
6. Main mode freezes already-running worker and verifier tool calls, not just future spawns.
7. Main elevation requires explicit confirmation, password re-authentication, optional TOTP, and a bounded expiry.
8. `HARD` requires a fresh heartbeat plus actual route and tool-hook observations from the same plugin instance. A controller restart clears old observations.
9. State writes are atomic and serialized; the audit file is bounded and compacted.
10. Public reverse-proxy examples hide agent-only endpoints and expose only the authenticated browser surface.

## Explicit non-goals and residual risks

### Compromised host or Gateway

Root, the `openclaw` Unix account, a compromised Gateway process, or an attacker who obtains `AGENT_INGEST_TOKEN` can bypass or impersonate the plugin. This project is not a host intrusion-prevention system.

### Shell side effects

Tool policy filters tool names, not the behavior inside an allowed command. A Worker with `exec` can write files, access the network, run Git, or invoke another program even when `write`/`edit` are denied. Put Workers in an OpenClaw sandbox, disable elevated execution, and use exec approvals/allowlists when consequences matter.

### Token exposure to workers

Do not place `OCWD_AGENT_TOKEN` in prompts, task briefs, workspace files, or generic shell profiles. A Worker that can read the Gateway process environment or its service credentials can steal it. Strong deployments isolate Worker execution from the Gateway host and credential paths.

### Hook timeout behavior

OpenClaw stops awaiting a timed-out hook and continues the hook pipeline. Keep `before_tool_call` timeout larger than the plugin's HTTP request timeout. The example uses 5 seconds for the hook and 2.5 seconds for the controller request. Do not override the hook timeout below the request timeout.

### Worker correctness

Delegation does not make Worker output correct. Verification, sandboxing, scoped workspaces, Git review, and human approval for high-impact operations remain necessary.

### Availability

The plugin defaults to fail-closed for mutation/runtime tools when the controller is unreachable. This protects integrity at the cost of availability. `failMode: "open"` is supported only for operators who deliberately accept that tradeoff.

## Recommended production posture

- Controller bound to loopback only.
- Trusted HTTPS certificate at the public reverse proxy.
- Unique 14+ character passphrase and TOTP.
- 32+ random-byte agent token, kept outside OpenClaw config and workspaces.
- Main, Worker, and Verifier as distinct configured agent IDs.
- Worker sandbox `mode: "all"`, session scope, no elevated execution.
- Verifier read-only by default. Add `exec` only inside an isolated disposable sandbox.
- `failMode: "closed"`.
- Regular `openclaw plugins inspect delegation-guard --runtime --json` checks.
