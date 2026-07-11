# Worker brief template

A short, complete brief is the difference between a worker that finishes in one shot and a worker that comes back asking "what do you actually want?".

Copy this block and fill every field. Missing fields default to ambiguity.

```text
Objective: <one-line outcome you want when this brief is done>
Scope:     <allowed files / dirs / systems, in concrete paths or globs>
Do not:    <destructive or external actions that need explicit approval>
Context:   <minimal facts the worker needs; link instead of dumping>
Output:    <summary + list of changed files / commands / tests run>
Verify:    <exact test / lint / build / inspection command(s) to run>
Model:     <strong-model> for planning; <worker-model> as the worker
Risk:      <low | medium | high — with a one-line reason>
Deadline:  <soft or hard time budget, optional>
```

## Why each field exists

- **Objective** — kills "what is this?" round-trips. If you can't write it in one line, the task isn't ready.
- **Scope** — the worker's hard fence. Out-of-scope changes should be rejected, not silently absorbed.
- **Do not** — explicit guardrails for destructive actions (`rm -rf`, force-push, public posting, network egress). Always present, even if empty.
- **Context** — paste only what's needed. Don't forward the whole session transcript; the worker's context is precious too.
- **Output** — commits the worker to producing evidence, not a vibe.
- **Verify** — the smallest meaningful check. If a worker can't tell you how to verify, the brief is incomplete.
- **Model** — make the delegation explicit so the worker doesn't re-delegate.
- **Risk** — calibrates how aggressive the worker can be. High risk should mean narrower Scope, not skipped checks.
- **Deadline** — optional. Useful for "I'd rather have a partial right answer in 60s than a perfect one in 10 minutes".

## Filled example

```text
Objective: Refactor scripts/apply_patch.py to handle CRLF inputs without crashing.
Scope:     scripts/apply_patch.py, tests/test_apply_patch.py
Do not:    No changes outside scripts/ and tests/. Don't touch packaging.
Context:   Currently fails on Windows-style line endings in fixtures/win/*.
Output:    Patched script + updated tests passing locally; one-line summary.
Verify:    `pytest tests/test_apply_patch.py -q` → all green.
Model:     <strong-model> plans; <worker-model> executes.
Risk:      low — single-file refactor with test coverage.
```

## Anti-patterns

- "Fix the bug." (no Scope, no Verify)
- "Make it production-ready." (objective unbounded)
- "Just do whatever you think." (delegation without accountability)
- Pasting the entire main-session transcript into Context.
