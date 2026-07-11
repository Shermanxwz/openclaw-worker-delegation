# How this differs from omo

A short, generic comparison for people coming from an omo-style setup.

> *omo-style* setups usually define a team of named agents with per-agent models: planners/reviewers use stronger models, while explorers, researchers, and executors often use cheaper models. This repository is a lighter rule set for teams that want the same cost-control idea without adopting a full multi-agent framework.

## Default posture

| | omo-style | this rule set |
| --- | --- | --- |
| Shape | Multi-agent team | One main session + optional worker |
| Planning | Dedicated planner/orchestrator agents | Strong model stays in main |
| Exploration/body-work | Specialized low-cost agents | Cheap worker handles body-work |
| Review | Dedicated reviewer/debug agents | Main reviews worker output |
| Overhead | Higher, more structured | Lower, simpler |

The cost goal is similar. The operating model is intentionally smaller.

## Spawning rules

This skill set adds three rules that vanilla omo doesn't enforce:

1. **No same-model shadow workers for serial work.** If main has already fallen back to the worker model, don't spawn another of the same model for the same task. A second identical worker adds cost without helping unless the work is truly parallel or isolated.
2. **Explicit exceptions for spawning while already on the cheap model.** The only allowed reasons are parallelism, isolation, long background runs, or clearly separable subproblems. "I felt like it" is not on the list.
3. **Main stays clean during worker runs.** Main may plan, risk-check, or prep the final review; it must not duplicate scans, reads, or commands. This keeps the strong model's context for what it's actually good at.

## Failure handling

omo's default retry is "ask again, possibly with a stronger model". This skill set instead:

- After **two consecutive** failures on the same problem, forces a strategy change — not a third attempt of the same approach.
- If already on the cheap model, isolates a smaller subproblem or builds a scratch reproduction before trying again.
- Escalates to the strong model only when the failure has a clear planning or reasoning gap, not because retries "felt unlucky".

## Brief format

omo commonly passes the entire session transcript to the worker. This skill set uses a tight brief (Objective / Scope / Do not / Context / Output / Verify / Model / Risk). The reasoning: the worker's context is also a budget, and a tight brief is verifiable — the worker either produced the Output or it didn't.

## When omo is still the right choice

- The task stream is mostly small and uniform (lots of similar Q&A, formatting, lookups).
- Context isolation isn't a concern and the cheap model handles most queries well.
- You genuinely want "default to cheap" as a posture because traffic is dominated by narrow calls.

In those cases, omo is fine. This skill set is for workflows where planning, code edits, and audits dominate, and where doubling up on the cheap model is a real cost.
