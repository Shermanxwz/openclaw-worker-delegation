---
name: model-aware-worker-delegation
description: Route work between the main session and a cheap worker based on the current model and task type. Keeps the strong model's context clean for planning and avoids spawning same-model shadow workers when the main session has already fallen back to the worker model.
---

# Model-aware worker delegation

Use this skill when deciding whether to do work in the current session or spawn a worker. Particularly relevant for coding, scripts, config parsing, batch file reads, repository scans, long logs, audits, and retry-heavy loops.

The exact models are configurable. By default we assume:

- **Strong (planner/reviewer)**: GPT/Codex-class.
- **Weak (body-work worker)**: MiniMax-M3-class or similar cheap model.

Substitute your own strong/weak pair; the rules transfer.

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
```

Full template and rationale: see `examples/worker-brief-template.md`.

## Default posture

The strong model is the planner and reviewer. The cheap worker is the body-work horse. When the main session is already on the cheap model, avoid creating a same-model shadow worker unless it buys parallelism, isolation, or durability.
