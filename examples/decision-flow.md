# Decision flow (v0.2 control-plane)

The full version of the rule, with the trigger table the README and `skills/adaptive-worker-delegation/SKILL.md` point to. Mode and routing decisions are made by the **OpenClaw control plane**, not by the model. The flow below shows when to ask the controller, when to act on the answer, and what to do in main while the controller is busy.

## 1. Detect the current mode and route

The authoritative state is `/api/state` (browser-authenticated for the panel, bearer-authenticated for agents). Look for:

- `mode`: `WORKER`, `AUTO`, or `MAIN`.
- `enforcement`: `HARD` (plugin reported fresh hooks) or `ADVISORY` (still waiting).
- `runtime.mainModel`, `runtime.workers[].model`.
- `route` for the current task, if you called `/api/route`.

If `/api/state` is unreachable or `enforcement` is `ADVISORY`, do not trust any tool result yet — the controller is not in charge. Pause or fall back to pure-text Q&A.

## 2. Ask the controller before heavy work

Before any heavy operation (file edit, exec, scan, long-running worker), call `POST /api/route` with the task description. The controller returns:

- `route`: `main` or `worker` (or `verifier` for read-only reviews).
- `reason`: a short explanation.
- `mode`: the effective mode (`WORKER`, `AUTO`, `MAIN`).

Treat the answer as mandatory. The default pair is GPT/Codex ↔ MiniMax-M3 for the runtime models; the controller does not pick the model, only the agent route and the tool gate.

## 3. Classify the task

| Class | Examples | Default action |
| --- | --- | --- |
| **Light** | Simple Q&A, single small file read, one short command, deterministic one-line edit | Do in main (controller will return `route: main` for these in `AUTO`) |
| **Heavy body-work** | Code edits, scripts, config parsing, repo scans, long logs, build/test loops, audits, multi-step research | Controller routes to a Worker; Main spawns with a tight brief |
| **Heavy + exception** | Long background runs, clearly parallel subproblems, risky/blast-radius-isolated changes | Worker even if mode is `WORKER`, justified explicitly in the brief |

## 4. Decision tree

```
             ┌─ controller /api/route → worker ────► delegate to cheap worker (or chosen model)
             │
task = heavy ┤
             │
             └─ controller /api/route → main  ──── exception (parallel / isolated / long-bg)?
                                             │                  │
                                             no                yes
                                             │                  │
                                             ▼                  ▼
                                          do directly      spawn worker (justify)
```

```
             ┌─ always do in main
task = light ┤
             └─ controller route will agree; no worker needed
```

## 5. While the worker runs

The main session may only do **non-overlapping** work:

- Plan the next step.
- Run a quick safety / blast-radius check (read-only — `before_tool_call` will block mutations while a Worker is the route).
- Prepare the final-review summary template.
- Verify a piece of work the worker is **not** doing (or hand it to the verifier).

The main session must **not**:

- Re-scan the files the worker is scanning.
- Re-run the commands the worker is running.
- Guess-and-check the same patch the worker is trying.
- Open a second worker for the same serial problem.
- Bypass a `block: true` decision from `/api/tool-check` by retrying under a different `agentId`/`runId`.

## 6. After the worker returns

1. Read the worker's Output and Verify sections.
2. Run the worker's stated Verify command yourself, or run a smaller equivalent you trust.
3. If verify passes, integrate; if not, send a focused retry brief — not the original brief with "try again" appended.
4. Report the result and what was verified.

## 7. Failure recovery

When two consecutive attempts on the same problem fail:

| Current mode / route | Action |
| --- | --- |
| Route returned Worker | Re-brief a fresh worker with a tighter scope and a smaller reproduction |
| Route returned Main, model is strong | Re-brief a worker with a focused brief and a minimal reproduction |
| Route returned Main, model is cheap | Change strategy: isolate a tighter subproblem, build a scratch reproduction outside the failing path, or spawn only when isolation/parallelism is real |
| `MAIN` mode active | Re-brief with a different scope/profile; do not silently retry the same patch in main |

See [`docs/failure-modes.md`](../docs/failure-modes.md) for the long-form recovery playbook.

## 8. One-page checklist

- [ ] Is `/api/state` reachable and `enforcement: HARD`?
- [ ] Do I know which model I'm on, from the runtime hooks?
- [ ] Did I call `/api/route` for this heavy task?
- [ ] If route = worker → brief → spawn → wait → verify.
- [ ] If route = main + heavy → re-check; maybe rephrase so the router picks worker.
- [ ] If route = main + light → do it directly.
- [ ] Never spawn two same-model workers for serial work.
- [ ] Never retry a `block: true` from `/api/tool-check`.
