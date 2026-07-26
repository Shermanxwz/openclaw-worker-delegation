# Pre-flight checklist (expanded, v0.2 control-plane)

A printable, expanded version of the pre-flight checklist in the README and `skills/adaptive-worker-delegation/SKILL.md`. Walk through this before every spawn decision. If a box cannot be checked, fix it before spawning — the rest of the workflow assumes each box is true.

The checklist has three sections: **before the run**, **during the run**, and **after the run**. Most failure modes are caused by skipping the *before* section.

## 1. Before the run

### 1.1 Control-plane state

- [ ] `/api/state` is reachable. The controller is up.
- [ ] `enforcement: HARD` is reported. The native plugin has registered fresh `before_prompt_build` and `before_tool_call` hooks for the current instance.
- [ ] I know the current `mode` (`WORKER`, `AUTO`, or `MAIN`) and any active task/session/project/global override.

If `enforcement` is `ADVISORY`, the controller is *not* in charge of tool gating yet. Pause body-work, or restrict to pure-text Q&A until the plugin reports in.

### 1.2 Identity of the active session

- [ ] I know which **model** the main session is currently on (from `/api/state.runtime.mainModel` or the runtime header).
- [ ] I know whether the runtime has signalled a **fallback** is in effect (the active model is not the default).
- [ ] I know the **budget** for the run — max steps, max wall time, max tokens — and have set it on the worker.

If any of these is unknown, the routing decision is a guess. Get the data first; do not guess.

### 1.3 Controller route for the task

- [ ] I called `POST /api/route` for the heavy task and recorded the returned route (`main`, `worker`, `verifier`).
- [ ] I know the controller's `reason` for that route and would defend it in a code review.

If the route is `main` but the task looks heavy, rephrase and re-call — the router is deterministic on the task description.

### 1.4 Identity of the task

- [ ] I can write the task's **Objective** in one line. If I cannot, the brief is not ready.
- [ ] I have classified the task: **light**, **heavy body-work**, or **heavy planning-dense**.
- [ ] I have a **Scope** in concrete paths or globs. Phrases like "wherever it's needed" do not count.
- [ ] I have a **Do not** list, even if it is short. Destructive verbs (`rm`, force-push, public posting, network egress) belong here unless explicitly authorised.
- [ ] I have a **Verify** command. The smallest meaningful check. No Verify, no spawn.
- [ ] I have a **Model** field in the brief naming the worker model explicitly. Implicit models default to whatever the runtime picks, which is rarely what you wanted.

### 1.5 Justification for the spawn (if any)

- [ ] The decision is **not** "I felt like it" or "the strong model is busy".
- [ ] The controller route is `worker` (in `AUTO`) or the active mode is `WORKER` and I have a real reason (parallelism, isolation, long background, or cleanly separable subproblem).
- [ ] If main is on the strong model, the task is genuinely heavy (body- or scan-dense). Light work does not need a worker.

If the justification is missing, default to **do in main**.

### 1.6 Failure plan

- [ ] I have a **failure rule** ready: two consecutive failures on the same problem triggers a strategy change, not a third retry.
- [ ] I have a **smaller reproduction** in mind for if the worker reports a parse error or test failure — the worst place to be is "the worker is stuck and I have no idea what the smallest failing input is".
- [ ] I know how to read `/api/audit` to confirm the failure was real and not a controller miss.

## 2. During the run

### 2.1 Main session discipline

- [ ] Main is **not** re-scanning the files the worker is scanning.
- [ ] Main is **not** re-running the commands the worker is running.
- [ ] Main is **not** guess-and-checking the same patch the worker is trying.
- [ ] Main **is** doing one of: planning the next step, running a non-overlapping risk check, or preparing the final-review summary.

If main duplicates the worker's work, both context budgets are now polluted.

### 2.2 Worker discipline

- [ ] The worker is using the **context** I sent, not the main session's history.
- [ ] The worker's actions are **inside Scope**. `/api/audit` should show every tool call hitting the controller's scope check.
- [ ] The worker has not crossed any line in **Do not** without explicit approval. Any `block: true` decision from `/api/tool-check` was respected, not retried under a different identity.
- [ ] The worker's `Output` field is being read as it grows — not all at once at the end (which is when surprises are most expensive to fix).

### 2.3 Cost & routing signals

- [ ] The worker's active model is the one the brief asked for. If not, decide whether to retry with a tighter pin or accept the drift.
- [ ] The main session has not fallen back to the worker model mid-run. If it has, stop spawning same-model workers for serial work. The controller will keep the route the same; the worker should change, not the policy.
- [ ] `/api/state` still reports `enforcement: HARD`. If it drops to `ADVISORY`, pause and re-arm the plugin.

A short mental note ("worker is on <expected-model>", "main is on <expected-model>", "controller is HARD") at the start of each turn keeps this honest.

## 3. After the run

### 3.1 Verification

- [ ] I read the worker's `Output` section, all of it.
- [ ] I ran the worker's `Verify` command myself, or a smaller equivalent I trust.
- [ ] Verify passed. If it did not, I sent a **focused** retry brief, not the original brief with "try again" appended.

### 3.2 Integration

- [ ] The changes are inside `Scope`. Out-of-scope changes are reverted before integrating.
- [ ] The changes do not introduce secrets, private hosts, or credential shapes (the secret-scan workflow and pre-commit gitleaks hook will catch most of these, but verify the obvious ones in the diff).
- [ ] The main session reports the work as **done** with evidence (a one-line summary plus the verify output).

### 3.3 Lessons

- [ ] If the run was smooth, no lesson to record — but I will still re-read this checklist on the next spawn, since smooth runs are how bad habits hide.
- [ ] If the run failed, the failure mode is one of the patterns in `docs/failure-modes.md`. I added it to my mental trigger table.

## 4. What this checklist is *not*

- It is **not** a workflow that runs once. It runs before every spawn.
- It is **not** a substitute for the brief. The brief is the *what*; the checklist is the *am I actually doing this right*.
- It is **not** exhaustive. There will be runs where an extra check matters (e.g. "have I informed the user this will take 10 minutes?"). Add your own boxes when they are real.

The full decision flow is in [`examples/decision-flow.md`](decision-flow.md), the brief template is in [`examples/worker-brief-template.md`](worker-brief-template.md), and the cost & routing verification is in [`docs/cost-routing.md`](../docs/cost-routing.md). This checklist is the *compressed* version of all three.
