# Decision flow

The full version of the rule, with the trigger table the README and SKILL.md point to.

## 1. Detect current model

Check runtime metadata for the active session. If uncertain, call `session_status` (or whatever your runtime exposes) before deciding.

You need to know whether main is on the **strong model** (planner/reviewer) or the **cheap model** (body-worker). The default pair is GPT/Codex ↔ MiniMax-M3; swap in your own.

## 2. Classify the task

| Class | Examples | Default action |
| --- | --- | --- |
| **Light** | Simple Q&A, single small file read, one short command, deterministic one-line edit | Do in main |
| **Heavy body-work** | Code edits, scripts, config parsing, repo scans, long logs, build/test loops, audits, multi-step research | If on strong model → delegate to worker. If on cheap model → do directly, **unless** an exception applies |
| **Heavy + exception** | Long background runs, clearly parallel subproblems, risky/blast-radius-isolated changes | Spawn a worker even on the cheap model |

## 3. Decision tree

```
             ┌─ current model = strong? ──── yes ──► delegate to cheap worker
             │
task = heavy ┤
             │
             └─ current model = cheap?  ──── exception (parallel / isolated / long-bg)?
                                             │                  │
                                             no                yes
                                             │                  │
                                             ▼                  ▼
                                          do directly      spawn worker
```

```
             ┌─ always do in main
task = light ┤
             └─ no worker needed
```

## 4. While the worker runs

The main session may only do **non-overlapping** work:

- Plan the next step.
- Run a quick safety / blast-radius check.
- Prepare the final-review summary template.
- Verify a piece of work the worker is **not** doing.

The main session must **not**:

- Re-scan the files the worker is scanning.
- Re-run the commands the worker is running.
- Guess-and-check the same patch the worker is trying.
- Open a second worker for the same serial problem.

## 5. After the worker returns

1. Read the worker's Output and Verify sections.
2. Run the worker's stated Verify command yourself, or run a smaller equivalent you trust.
3. If verify passes, integrate; if not, send a focused retry brief — not the original brief with "try again" appended.
4. Report the result and what was verified.

## 6. Failure recovery

When two consecutive attempts on the same problem fail:

| Current model | Action |
| --- | --- |
| Strong model | Delegate to cheap worker with a focused brief, using the smallest reproduction |
| Cheap model | Change strategy: isolate a tighter subproblem, build a scratch reproduction outside the failing path, or spawn only when isolation/parallelism is real |

See [`docs/failure-modes.md`](../docs/failure-modes.md) for the long-form recovery playbook.

## 7. One-page checklist

- [ ] Do I know which model I'm on?
- [ ] Is the task genuinely heavy, or could I answer it in a few lines?
- [ ] If heavy + strong model → brief → spawn → wait → verify.
- [ ] If heavy + cheap model + no exception → do it directly.
- [ ] If heavy + cheap model + real exception → spawn anyway, briefly justify.
- [ ] Never spawn two same-model workers for serial work.
