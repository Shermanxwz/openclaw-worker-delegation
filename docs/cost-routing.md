# Cost & routing verification (v0.2 control-plane)

A practical guide to confirming, at runtime, that the main session is actually using the model you think it is, that the **controller** is the authority for routing and tool decisions, and that the resulting cost profile matches what you planned.

> **Audience.** This doc assumes you are operating a session in front of the OpenClaw control plane (controller + native `delegation-guard` plugin), not a billing admin. It is intentionally generic — no provider SDK calls, no private dashboards. Everything here is something you can do from inside the session.

## 1. What "verify routing" actually means

There are four distinct things to verify, and they are not the same:

1. **Identity of the active model.** Which model is the main session *actually* running on right now? Not which one you asked for. The control plane reports this from real `model`/`subagent` hooks, not from headers.
2. **Identity of the worker model.** Which model did the worker run on? Not which one you put in the brief.
3. **Identity of the routing decision.** Which agent (`main`, `body-worker`, `verifier`) and mode (`WORKER`/`AUTO`/`MAIN`) was actually selected by the controller? The panel snapshot (`/api/state`) is the source of truth; chat text is not.
4. **Identity of the billing source.** Which model is your account actually being charged for, given the fallback chain the runtime is allowed to use?

These four are usually equal. When they are not, that's the source of almost every cost surprise in this category of workflow. Treat them as four separate things to verify.

## 2. Verifying the active model in the main session

The control plane exposes runtime/model state on `GET /api/state` (bearer-authenticated for agents, browser-authenticated for the panel). Look for one of:

- `runtime.mainModel`
- `runtime.mainProvider`
- `runtime.workers[].model`
- `runtime.heartbeatAt`

If none of these are present, or the heartbeat is stale, the runtime is being secretive about which model is running. Treat that as a sign that cost is also being managed opaquely — escalate to a stronger guardrail before the run.

### What to do with the result

- The model name returned by the runtime is the **identity of the active model**, not necessarily the **identity of the billing source**. The runtime may have fallen back without telling the model, and the active model can be a different family from the one you will be billed for. See §5.
- If the active model is your *worker* model and not your *strong* model, the main session has fallen back. From this point the rule is: **do not spawn another same-model worker for serial work.** A short status note ("main fell back to <worker-model>") in your context is enough; the rule then applies automatically. The controller's `before_tool_call` gate will still enforce scope and policy regardless of which model is active.

## 3. Verifying the worker model

When a worker comes back with output, the brief should already name the model it was *supposed* to run on. Verify that what the worker actually ran matches:

- The worker's `Output` section should include a `Model:` line (see `examples/worker-brief-template.md`).
- The runtime's worker report (from `/api/state`) should list the active model ID for the worker session.
- If the brief did not pin a model, the worker may have used whatever the runtime defaulted to. That is *not* a worker; that is the runtime's fallback. Treat it as such when reading the cost.

### Common drift

- **Runtime fell back to a stronger (more expensive) model than you expected.** This is rare but happens when a small-model provider is unavailable and the runtime silently promotes to a more expensive tier. Cost goes *up*, not down.
- **Runtime fell back to a weaker (less capable) model than you expected.** More common. Cost goes *down*, quality goes *down*. The brief will often surface this in the Output section ("I couldn't parse X with the available model").
- **A "worker" turned out to be the main session's own model under a different label.** This is the worst case: you are paying twice for the same model. The fix is to make the brief's `Model:` field mandatory and check it on return.
- **The controller route disagrees with the model's intent.** The controller wins. A worker that tries to mutate while the route returned `main` is blocked by `before_tool_call`; that is a successful enforcement, not a failure.

## 4. Why model name may not equal billing source

This is the single most important point in this doc. It is also the one most often missed.

The model *name* you see in the runtime, in headers, in `session_status`, in the worker's `Model:` field, or in the control-plane's `/api/state` identifies **which model produced the output**. It does **not** always identify **which model you are billed for**.

A few reasons:

- **Tier aliases.** Providers sometimes expose the same model under multiple SKU names. Two sessions can show the same model name in their status and yet be billed against different SKUs. The status report does not always know the SKU.
- **Routing tier.** A "small" model label may be a routing tier that the provider fills from a pool of actual models. The model name is stable; the actual model identity can vary per request.
- **Fallback chains.** A runtime configured with a strong default and a cheap fallback can run on the cheap fallback for an entire session while still showing the strong name in headers. This is by design (it is the fallback doing its job), but it means the *header* is not the *bill*.
- **Batch vs. interactive pricing.** The same model name can have different prices for batched and interactive use. The runtime may or may not tell you which you got.
- **Provider credits / trial tiers.** A model name on a free tier is not the same model name on a paid tier, even if the responses are nominally similar.

The rule of thumb: **trust the model's identity for capability questions, but trust the billing report for cost questions.** They are independent signals.

## 5. Cost signals you can observe from inside the session

You almost never need to call a billing API to know whether cost is going wrong. Watch for these signals during the run:

| Signal | What it usually means |
| --- | --- |
| Main session reports the worker model as its active model for many turns in a row | Main has fallen back. Stop spawning same-model workers for serial work. |
| A worker comes back with a `Model:` field different from the brief's expected model | The worker used a fallback. Re-brief with a tighter model pin, or accept the drift and budget accordingly. |
| Worker output includes many `retry` / `attempt 2 of N` lines | The worker is in a loop. The failure rule applies: after two consecutive failures, change strategy. |
| Brief is longer than the worker's actual output | You delegated a light task. Stop. |
| Main session's context is filling up with output from a worker that's still running | Main is duplicating the worker's work. Stop reading the worker's intermediate output. |
| A "long background run" is taking 10× longer than the same task in main | The worker model is wrong for that task. Either escalate to the strong model or stop. |
| `/api/state` shows `enforcement: ADVISORY` for a long stretch | The native plugin hasn't reported fresh `before_prompt_build`/`before_tool_call` observations. Tool calls may not be gated — pause body-work until `HARD` returns. |
| `/api/audit` shows repeated `block: true` decisions for the same tool | A worker is repeatedly crossing scope. Tighten the brief or freeze the worker. |

None of these are billing-API calls. All of them are observable from the session.

## 6. The verification checklist

Before declaring a delegation run a success, walk this list:

- [ ] I know which model the main session is currently on (from `/api/state` or `session_status`).
- [ ] I know which model the worker actually ran on (from the worker's `Model:` field, not from the brief).
- [ ] I know the controller route for each delegation (from `/api/state` mode + route binding, not from chat text).
- [ ] I know the worker is not the same model as the main session, **unless** the brief justified the exception (parallelism / isolation / long background / cleanly separable subproblem).
- [ ] The panel reached `HARD` enforcement before I trusted any tool result.
- [ ] The worker's `Output` matches the brief's `Objective`.
- [ ] I ran the worker's `Verify` step, or a smaller equivalent I trust.
- [ ] I did not duplicate the worker's scans or commands in main while the worker was running.
- [ ] I have not re-spawned a worker for the same task in a loop.
- [ ] If two consecutive attempts failed, I changed strategy (re-briefed, switched profile, or escalated route), instead of trying a third time the same way.

If any of these is "I don't know", that's the one to fix before the next run.

## 7. What to do when verification fails

- **Main fell back to the worker model** and you spawned a same-model worker for serial work: cancel the worker, finish in main, and record the pattern in your personal trigger table.
- **Worker ran on a different model than the brief said**: re-brief with an explicit model pin, or accept the fallback and budget for it. Do not pretend the cost is what you expected.
- **Main and worker are the same model and the work was serial**: that was a cost-doubling event. The controller's router did not catch it because the brief justified the spawn. Decide whether the workflow warrants a second look.
- **Two consecutive failures on the same problem**: apply the failure rule. Do not retry the same patch a third time.
- **The controller route disagrees with the worker's intent**: the worker is wrong, not the controller. Re-brief with a tighter scope, or freeze the worker via `MAIN` mode for a moment.
- **Cost is observably wrong** (the run is taking far longer or producing far more output than expected): pause the run. Inspect. Re-classify. Do not "let it finish and then check the bill".

## 8. What this doc deliberately does not cover

- Provider-specific billing dashboards or APIs. The point of this doc is to verify routing from inside the session, not to replace billing reports.
- Specific model IDs, SKUs, or price points. Those vary by provider and change frequently. Use this doc as the *shape* of the verification; the *values* come from your provider.
- Auth, secrets, and account administration. Cost verification from inside the session is not a substitute for proper account hygiene.

The goal is simple: by the time the run finishes, you should already know whether the cost was reasonable. If you have to wait for a bill to find out, the verification was incomplete.
