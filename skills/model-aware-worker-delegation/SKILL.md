---
name: model-aware-worker-delegation
description: Route work between the main session and a cheap worker based on the current model and task type. Keeps the strong model's context clean for planning and avoids spawning same-model shadow workers when the main session has already fallen back to the worker model.
license: MIT
compatibility: openclaw, opencode, generic-agent-loop
metadata:
  version: "0.1.1"
  category: routing
  audience: agent-runtime
  strong-model: configurable
  worker-model: configurable
  workflow: model-aware-delegation
  tags: delegation,cost-control,routing,worker-pattern,failure-recovery
---

# Model-aware worker delegation

Use this skill when deciding whether to do work in the current session or spawn a worker. Particularly relevant for coding, scripts, config parsing, batch file reads, repository scans, long logs, audits, and retry-heavy loops.

The exact models are configurable. By default we assume:

- **Strong (planner/reviewer)**: GPT/Codex-class.
- **Weak (body-work worker)**: MiniMax-M3-class or similar cheap model.

Substitute your own strong/weak pair; the rules transfer.

## Pre-flight checklist

Run through this before every spawn decision. The full decision flow is below; this is the compressed version.

- [ ] **I know which model the main session is on** (check `session_status` or the runtime header). If unknown, get this first; do not guess.
- [ ] **I can write the task's Objective in one line.** If I cannot, the brief is not ready — split the task or sharpen it.
- [ ] **The task is genuinely heavy** (code edits, scans, long logs, retry loops, multi-step research). If it is light, do it in main.
- [ ] **If delegating, the brief includes every field** (Objective / Scope / Do not / Context / Output / Verify / Model / Risk). No Verify, no spawn.
- [ ] **The worker model is *not* the same as the main session's active model** — unless the brief explicitly justifies the exception (parallelism, isolation, long background, cleanly separable subproblem).
- [ ] **Main will not duplicate the worker's work** while the worker runs. Main may plan, risk-check, or prep the review only.
- [ ] **I have a budget in mind** (max steps / wall time / tokens) so a failing worker cannot loop forever.
- [ ] **I have a failure rule ready**: two consecutive failures on the same problem triggers a strategy change, not a third retry.

If any box is unchecked, fix it before spawning. The rest of this skill is the long-form version of the same rules.

## Core rule

Before doing heavy work, check the current runtime model.

- If the main session is on the **strong model**, delegate body-work to a **cheap worker**.
- If the main session has already fallen back to the **cheap model**, do the work directly — do not spawn another same-model shadow worker for the same serial work.
- Spawn a worker while already on the cheap model **only** for parallelism, risk isolation, long background runs, or clearly separable subproblems.

## When to delegate

Delegate while on the strong model for:

- Writing or modifying scripts, code, or configs.
- Fixing config parsing, shell/Python quoting, or fragile command syntax.
- Batch reading files, scanning repositories, grepping large trees.
- Analyzing or compressing long logs.
- Audits, multi-step research, issue triage, scouting.
- Build/test loops where retries are likely.

Do not delegate for:

- Simple Q&A.
- A single small file read.
- A single low-risk command or direct verification.
- Tiny deterministic edits that are easy to verify in place.

## Runtime decision flow

1. Determine the current model from runtime metadata (or `session_status`).
2. Classify the task:
   - **light** — answer directly;
   - **heavy body-work** — delegate if on the strong model;
   - **heavy, but already on the cheap model** — do directly unless an exception applies.
3. If delegating, spawn with:
   - the configured cheap-worker model;
   - isolated context by default;
   - a precise objective, write scope, safety boundaries, and verification criteria (use the brief template).
4. While the worker runs, the main session may only do **non-overlapping** work — planning, risk checks, or final-review prep. Do not duplicate the worker's scans or commands.
5. After the worker completes, the main session reviews the output, runs the smallest meaningful verification, then reports.

## Failure rule

If the main session has **two consecutive** patch/command failures on the same problem:

- Stop direct trial-and-error.
- If currently on the **strong model** → delegate to a cheap worker.
- If already on the **cheap model** → change strategy: isolate a smaller subproblem, use a scratch reproduction, or spawn only for isolation/parallelism.

## Worker brief template

```text
Objective: <exact outcome in one line>
Scope:     <files / dirs / systems allowed>
Do not:    <destructive or external actions without approval>
Context:   <minimal facts needed>
Output:    <summary + changed files / commands / tests>
Verify:    <specific test / lint / build / inspection to run>
Model:     <strong-model> for planning; <worker-model> as the worker
Risk:      <low | medium | high — with a one-line reason>
```

Full template and rationale: see `examples/worker-brief-template.md`.

## Cost & routing verification

A few quick signals to watch for during a run, before the bill arrives:

- The main session's active model equals the worker model across many turns → main has fallen back; do not spawn same-model workers for serial work.
- The worker's `Model:` field differs from the brief's expected model → the worker used a fallback. Re-brief with a tighter pin or budget for the drift.
- The brief is longer than the worker's output → the task was light; you over-delegated.
- Two consecutive failures on the same problem → apply the failure rule, do not retry the same way.

For the full version — why model name may not equal billing source, which signals are observable from inside the session, and the verification checklist — see `docs/cost-routing.md`.

## Default posture

The strong model is the planner and reviewer. The cheap worker is the body-work horse. When the main session is already on the cheap model, avoid creating a same-model shadow worker unless it buys parallelism, isolation, or durability.
