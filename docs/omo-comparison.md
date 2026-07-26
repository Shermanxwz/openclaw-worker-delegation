# How this differs from omo (v0.2 control-plane)

A short, generic comparison for people coming from an omo-style setup or from a pure-skill delegation rule set.

> *omo-style* setups usually define a team of named agents with per-agent models: planners/reviewers use stronger models, while explorers, researchers, and executors often use cheaper models. This repository is a **control plane** — a controller + native OpenClaw plugin — that decides routing and tool gating externally, instead of a rule set that each agent is expected to follow.

## Default posture

| | omo-style | v0.1 skill-only delegation | this control plane (v0.2) |
| --- | --- | --- | --- |
| Shape | Multi-agent team | One main session + optional worker | Controller + native plugin + main/worker/verifier agents |
| Planning | Dedicated planner/orchestrator agents | Strong model stays in main | Controller decides per task via deterministic router |
| Exploration/body-work | Specialized low-cost agents | Cheap worker handles body-work | Workers spawned per task; verifier read-only |
| Review | Dedicated reviewer/debug agents | Main reviews worker output | Verifier role + bounded audit stream |
| Tool gating | Per-agent config | Skill text (best-effort) | Native `before_tool_call` returns terminal `block: true` |
| Overhead | Higher, more structured | Lowest | Lower than omo, structured like a real sidecar |

The cost goal is similar across all three. The control-plane approach is the only one where tool gating is enforced by the runtime instead of by the model being well-behaved.

## Routing rules

The control plane adds three rules that vanilla omo and the v0.1 skill-only rule set don't enforce:

1. **Controller route is authoritative.** A worker's intent to mutate does not matter if the controller's `/api/route` returned Main. The plugin then calls `/api/tool-check` and blocks the mutation. This is enforced by the runtime, not by the worker's prompt.
2. **Explicit modes from the panel.** The user (or an outer operator) selects `WORKER`, `AUTO`, or time-bounded `MAIN` from the Web panel. The session inherits that mode unless a one-shot task, session, project, or global override wins. Mode changes do not require restarting the agent.
3. **Model fallback never changes permissions.** If main falls back to the worker model, the route and tool decisions do not change. This used to be a hand-waved rule; in v0.2 it is enforced by the controller's policy, not by the model noticing.

## Failure handling

omo's default retry is "ask again, possibly with a stronger model". The v0.1 skill set instead:

- After **two consecutive** failures on the same problem, forces a strategy change — not a third attempt of the same approach.

The v0.2 control plane adds:

- A `before_tool_call` decision that is **terminal** — the worker cannot retry the same call under a different `agentId`/`runId`, and the controller rejects agent/session substitution attempts at the route layer.
- A bounded `/api/audit` stream so failures are observable after the fact, not just guessed at.
- A fail-closed default: if the controller is unreachable, no tool call is allowed. The plugin defaults to this; deployments can opt into a `controllerDown: allow|deny` policy.

## Brief format

omo commonly passes the entire session transcript to the worker. The v0.1 skill set introduced a tight brief (Objective / Scope / Do not / Context / Output / Verify / Model / Risk). The v0.2 control plane keeps the tight brief format and additionally requires Scope, Do not, and Risk to be **machine-checkable**, because the controller checks them on every call, not just reads them in prose.

## When omo is still the right choice

- The task stream is mostly small and uniform (lots of similar Q&A, formatting, lookups).
- Context isolation isn't a concern and the cheap model handles most queries well.
- You genuinely want "default to cheap" as a posture because traffic is dominated by narrow calls.
- You cannot install a native OpenClaw plugin (e.g. you are not on OpenClaw).

In those cases, omo is fine. This control plane is for workflows where planning, code edits, and audits dominate, where doubling up on the cheap model is a real cost, and where untrusted tool calls must be blocked at the runtime boundary rather than at the prompt.
