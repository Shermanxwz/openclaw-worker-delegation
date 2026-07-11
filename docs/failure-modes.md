# Failure modes and recovery

The skill is small but the failure surface isn't. This doc catalogues what goes wrong, what it looks like, and what to do.

## 1. "I spawned a worker for a question I could've answered"

**Looks like**: a worker came back with a one-line answer and the brief was longer than the answer.

**Fix**: tighten the trigger table in your head. Anything that fits in the main session's context and isn't retry-prone is light. Light = do in main.

**Prevention**: re-read the *Do not delegate for* list in `SKILL.md` before spawning.

## 2. "I spawned a same-model worker for serial work"

**Looks like**: main is already on the cheap model; you spawned another cheap worker; the worker did the same scans main already did; cost doubled.

**Fix**: kill the worker, do the work in main, and add the failure to your mental trigger table.

**Prevention**: check the current model *before* every spawn. If `main == worker.model` and there's no real parallelism/isolation/long-bg/clean-subproblem reason, don't spawn.

## 3. "Worker came back without verifying"

**Looks like**: the worker reports "I changed X" but there's no test/lint/build output.

**Fix**: brief was missing the **Verify** field. Send a focused retry — paste the current brief back, mark Verify as the only thing the worker skipped, demand a specific command and its output.

**Prevention**: every brief includes Verify. No exceptions.

## 4. "Worker rewrote things outside Scope"

**Looks like**: scope was `scripts/foo.py`, the diff is four files and a config.

**Fix**: revert out-of-scope changes, keep what's inside Scope, send the worker a "scope discipline" note before any retry.

**Prevention**: write Scope as concrete paths or globs. Avoid phrases like "wherever it's needed".

## 5. "Two consecutive failures on the same problem"

**Looks like**: patch retry #1 didn't apply, patch retry #2 didn't apply, you're considering retry #3.

**Fix**: stop. Apply the failure rule.

| Current model | Action |
| --- | --- |
| Strong model | Delegate to cheap worker with a focused brief + minimal reproduction |
| Cheap model | Isolate a smaller subproblem or build a scratch reproduction. Spawn only for true isolation/parallelism |

**Prevention**: keep a counter. Two in a row = forced strategy change. Don't let retry mood decide.

## 6. "Main duplicated the worker's work"

**Looks like**: worker was grepping `src/`, main also grepped `src/` "to be safe". Context is now polluted with redundant output.

**Fix**: drop the duplicate work from main, save only what main needs for the next decision.

**Prevention**: while the worker runs, main is allowed to plan, risk-check, prep the final review, or verify a *separate* check. Anything else is duplication.

## 7. "I delegated a destructive action"

**Looks like**: brief said "clean up", worker ran something that touched things it shouldn't have.

**Fix**: revert the side effect, add an explicit **Do not** to the brief, retry with the same scope and a tightened Do-not list.

**Prevention**: every brief includes Do not. Destructive verbs (`rm`, `mkfs`, `git push --force`, `kubectl delete`, public posting) belong in Do not unless explicitly authorised in the same brief.

## 8. "Worker is too expensive — the strong model would have been cheaper"

**Looks like**: a long, twisty problem got handed to the cheap model, which went around in circles. The strong model would have just solved it in one shot.

**Fix**: not every "heavy" task belongs on the worker. Tasks that are **planning-dense** (single coherent reasoning chain, low scan volume) are often cheaper on the strong model. Save the worker for **scan / script / log / retry-loop** heavy work.

**Prevention**: classify heavy tasks as either *planning-dense* or *body-dense*. Body-dense → worker. Planning-dense → strong model, possibly without delegation.

## 9. "Same-model shadow worker for parallelism I didn't actually get"

**Looks like**: "I'll just spawn two cheap workers and let them race." They produced overlapping diffs and now you have to merge them.

**Fix**: cancel one. If the parallelism is real, define disjoint scope per worker **in the briefs**, and verify disjointness before spawn.

**Prevention**: parallel only when scope splits cleanly. Otherwise serial is cheaper.

## 10. "Loop where main keeps re-creating a worker that just finished"

**Looks like**: worker completed, main spawns another for the same task, the cycle repeats.

**Fix**: review the worker's Output and Verify sections first. If Verify passed, integrate. If it didn't, send a **focused** retry brief, not a fresh spawn of the whole task.

**Prevention**: never spawn a worker without first reading the previous worker's output, if one exists for the same task.

---

## Long-form recovery playbook

When something is clearly broken and the simple fixes above don't apply:

1. **Stop the loop.** Cancel pending work, kill spawned workers, snapshot the state.
2. **Inspect.** What was the brief, what did the worker actually do, what does main know?
3. **Re-classify.** Is the task still the same task, or did it drift? If drifted, redraft the brief.
4. **Re-tier.** Is the current model the right tier for this problem now that you know more? Switch if not.
5. **Re-spawn or finish.** Re-spawn with a smaller, focused brief — or finish in main if it's small enough now.
6. **Note the lesson.** Add the pattern to your personal trigger table so the next session avoids it.
