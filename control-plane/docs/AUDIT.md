# Production hardening audit — v0.3

This document records the engineering/security closure criteria for the sealed v0.3 mainline. “Perfect” is not a defensible software property; the release criterion is explicit authority boundaries, fail-closed defaults, durable ownership, regression tests and acceptance against a real OpenClaw Gateway.

## P0/P1 findings closed

- **Role spoofing** — role/actor claims from request bodies no longer select policy; roles derive from configured OpenClaw agent IDs.
- **Missing route fail-open** — tool authority now requires an authoritative persistent run binding. Missing run/binding fails closed.
- **Run/session substitution** — route bindings reject agent/session mismatches.
- **Ephemeral route ownership** — real route decisions persist in controller state and survive controller restart within bounded TTL; runtime hook proof itself intentionally does not survive restart.
- **Worker as a black box** — Worker/Verifier execution now receives persistent `wrk_...` task identity with parent/execution provenance, model route, owner epoch, heartbeat, progress, lease, review and terminal event timeline.
- **Stale Worker authority** — Worker/Verifier tools require fresh heartbeat plus live lease/grace, matching owner epoch and execution identity, and an unexpired hard deadline.
- **Heartbeat extending forever** — ordinary heartbeat does not renew normal lease duration. Only meaningful progress renews, clamped to hard deadline.
- **Unlimited task duration** — quick tasks are hard-clamped to 600 seconds; standard tasks to 3600 seconds even when StateStore is constructed directly.
- **Cancellation/fencing race** — cancellation and MAIN fencing increment owner epoch, invalidating stale Worker ownership immediately.
- **Over-broad MAIN fence** — project/session MAIN fences only matching delegated work; one-shot MAIN does not tear down unrelated running tasks.
- **WORKER still doing work on Main** — substantive WORKER tasks always delegate; Main remains autonomous coordinator/reviewer, with only control/status exceptions.
- **AUTO ambiguity granting Main authority** — ambiguous/tool/heavy work delegates conservatively.
- **Display-only model routing** — routing profiles are consumed by the native plugin at model resolution and native `sessions_spawn` rewriting.
- **Synthetic reasoning tiers** — model thinking levels come only from OpenClaw upstream policy; models with no declared levels expose only `Auto`.
- **Spawn provenance loss** — durable task marker + child run/session binding connects native OpenClaw subagent execution back to the controller task.
- **Long child run heartbeat gaps** — periodic plugin heartbeat covers both run-bound and session-only child task identities.
- **Inconsistent hook run IDs** — host run ID is pinned to session identity so later hooks that omit run ID reuse the authoritative binding.
- **Pending spawn correlation** — spawn prepare/completion uses a consistent toolCallId-or-parent-run fallback key.
- **False HARD badge** — startup self-report is insufficient; HARD requires fresh same-instance runtime plus actual route and tool observations.
- **Controller outage ambiguity** — recommended plugin posture is fully fail-closed; controller loss blocks subsequent tools.

## Web/product closure

The root dashboard is intentionally reduced to the operator's primary decisions: mode/scope and model routing for the active mode. Operational detail is separated into Tasks, Runtime, Audit and Settings pages. Root-control task cancel/extend is explicitly secondary and requires confirmation plus credential re-authentication.

The Web panel writes authoritative controller routing profiles; it does not maintain an independent provider/model catalog.

## Durable task invariants

A non-terminal Worker/Verifier tool call is authorized only if all of the following are true:

1. authoritative run binding exists;
2. configured role matches the runtime agent;
3. durable `wrk_...` task exists;
4. owner epoch matches;
5. agent/run/session ownership matches when known;
6. hard deadline is in the future;
7. heartbeat is fresh;
8. lease/grace authority is live;
9. mode/role tool policy permits the requested tool.

Failure of any invariant is a denial.

## Cancellation boundary

Controller cancellation/fencing guarantees immediate revocation of future plugin-governed tool authority and native spawn is bounded by OpenClaw `runTimeoutSeconds`. It does not claim OS-level instant destruction of an already-executing model/thread. That residual boundary is documented in `THREAT_MODEL.md` rather than hidden behind an inaccurate “kill” claim.

## Automated coverage

The controller suite covers:

- bilingual routing and literal WORKER semantics;
- conservative AUTO behavior and risk-signal monotonicity;
- mode precedence/expiry/persistent MAIN/one-shot consumption;
- role spoofing and route binding substitution;
- durable route restart recovery and missing-binding fail-closed behavior;
- hard 10/60 minute task ceilings;
- heartbeat freshness versus meaningful-progress lease renewal;
- scoped MAIN fencing and one-shot no-fence semantics;
- owner-epoch cancellation revocation;
- Registry routing and upstream thinking declaration behavior;
- complete HTTP Main-route → prepare → Worker-route → tool-gate → terminal lifecycle;
- root-control credential re-authentication;
- password/TOTP/session/CSRF/static-file hardening;
- atomic state writes, malformed audit recovery and runtime proof reset;
- plugin package/identity normalization.

## Official OpenClaw acceptance gate

The release workflow pins official OpenClaw `2026.7.1-2` with Node 24 and runs the checked-in real-Gateway harness. The merge gate requires:

- official plugin install/enable/config validation/runtime inspect;
- critical route/tool hooks registered in the real Gateway;
- AUTO blocking real Main execution;
- WORKER allowing a real native `sessions_spawn`, body-worker model turn and Worker tool execution;
- MAIN allowing Main execution while fencing delegated Worker authority;
- one-shot MAIN consumed exactly once;
- actual Main/Worker provider-model reporting;
- same-instance HARD proof only after real runtime hooks;
- controller-loss fail-closed behavior.

Controller CI also requires Node 20 and Node 22 syntax/unit/HTTP tests, plugin package validation, deploy/config validation and secret scanning. Plugin smoke uses the pinned official OpenClaw package.

## Deployment-specific acceptance

Hosted CI cannot prove the operator's production host. Before exposing a deployment, validate:

- trusted public HTTPS and browser login on the real address;
- production provider credentials and desired models as visible to OpenClaw Registry;
- systemd/reverse-proxy/firewall/state-directory permissions and restart behavior;
- Worker sandbox isolation from Gateway credentials and host-sensitive paths;
- operator-selected exec approvals/allowlists/filesystem/network boundaries;
- load, disk retention and recovery under actual host resources.

See `THREAT_MODEL.md`, `API.md`, and `deploy/PUBLIC_IP_DEPLOY.md`.
