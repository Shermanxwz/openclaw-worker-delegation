# openclaw-worker-delegation

A lightweight, model-aware rule set for deciding whether an [OpenClaw](https://openclaw.dev)-style agent should do work in the main session or delegate it to a cheaper worker.

The goal is simple: **let the strong model plan and review, let the cheap model do the body-work.**

[![skill-validate](https://github.com/Shermanxwz/openclaw-worker-delegation/actions/workflows/skill-validate.yml/badge.svg)](https://github.com/Shermanxwz/openclaw-worker-delegation/actions/workflows/skill-validate.yml)
[![secret-scan](https://github.com/Shermanxwz/openclaw-worker-delegation/actions/workflows/secret-scan.yml/badge.svg)](https://github.com/Shermanxwz/openclaw-worker-delegation/actions/workflows/secret-scan.yml)


## Pre-flight checklist

Run through this before every spawn decision. The full decision flow is below; this is the compressed version.

- [ ] **I know which model the main session is on** (check `session_status` or the runtime header). If unknown, get this first; do not guess.
- [ ] **I can write the task's Objective in one line.** If I cannot, the brief is not ready.
- [ ] **The task is genuinely heavy** (code edits, scans, long logs, retry loops, multi-step research). If it is light, do it in main.
- [ ] **If delegating, the brief includes every field** (Objective / Scope / Do not / Context / Output / Verify / Model / Risk). No Verify, no spawn.
- [ ] **The worker model is *not* the same as the main session's active model** — unless the brief explicitly justifies the exception (parallelism, isolation, long background, cleanly separable subproblem).
- [ ] **Main will not duplicate the worker's work** while the worker runs.
- [ ] **I have a budget in mind** (max steps / wall time / tokens) so a failing worker cannot loop forever.
- [ ] **I have a failure rule ready**: two consecutive failures on the same problem triggers a strategy change, not a third retry.

If any box is unchecked, fix it before spawning. A printable, expanded version is in [`examples/pre-flight-checklist.md`](examples/pre-flight-checklist.md).

## Why this exists

When one agent session juggles planning, coding, scanning, log crunching, and verification, the expensive model ends up doing jobs a cheap model can finish faster and cheaper. Spawning a worker for every task is wasteful too — spawning a same-model shadow when the main has already fallen back to that model is just paying twice.

This repo packages the minimum rule set that has, in practice, cut both cost and round-trips:

- Strong model (e.g. GPT/Codex) is the **planner and reviewer**.
- Cheap worker (e.g. MiniMax-M3) is the **body-work horse**.
- If the main session has already fallen back to the worker model, do the work directly — don't spawn a same-model shadow unless you genuinely need **parallelism, isolation, or a long background run**.

Models are configurable. Substitute your own strong/weak pair and the rules still apply.

## What's in the box (v0.1.1)

```
openclaw-worker-delegation/
├── README.md                                 # this file
├── LICENSE                                   # MIT
├── .gitignore
├── .pre-commit-config.yaml                   # gitleaks + markdown sanity hooks
├── .github/
│   └── workflows/
│       ├── skill-validate.yml                # structural validation of skills/
│       └── secret-scan.yml                   # gitleaks full-history secret scan
├── skills/
│   └── model-aware-worker-delegation/
│       └── SKILL.md                          # drop-in OpenClaw skill (v0.1.1 frontmatter)
├── snippets/
│   └── AGENTS.md.snippet                     # paste-into / AGENTS.md section
├── examples/
│   ├── worker-brief-template.md              # what to put in a worker brief
│   ├── decision-flow.md                      # the trigger table, expanded
│   ├── pre-flight-checklist.md               # expanded pre-flight checklist
│   └── opencode-config.md                    # generic OpenCode/OpenClaw-style config
└── docs/
    ├── omo-comparison.md                     # how this differs from omo
    ├── failure-modes.md                      # what to do when delegation breaks
    └── cost-routing.md                       # verifying worker model routing & cost
```

## The rule, in one sentence

> If main is on the strong model → delegate body-work to the cheap worker.
> If main is already on the cheap worker → do it directly unless you need parallelism, isolation, or background.

## Quick start

1. **As an OpenClaw skill**: copy `skills/model-aware-worker-delegation/` into your agent's `skills/` directory. The agent will pick it up and apply the rule automatically.
2. **As project guidance**: paste `snippets/AGENTS.md.snippet` into your `AGENTS.md` (or equivalent rules file).
3. **Tweak the model pair**: edit `SKILL.md` to swap `GPT/Codex` ↔ `MiniMax-M3` for whatever strong/weak pair you run.
4. **Brief workers consistently**: copy `examples/worker-brief-template.md` whenever you spawn a session.
5. **Wire the runtime config**: see [`examples/opencode-config.md`](examples/opencode-config.md) for a generic OpenCode / OpenClaw-style sketch covering strong model, cheap worker, small classifier, and a permission-scoped scout.
6. **Verify cost & routing**: see [`docs/cost-routing.md`](docs/cost-routing.md) for how to confirm the worker is actually on the model you think it is, and why model name may not equal billing source.

See [`examples/decision-flow.md`](examples/decision-flow.md) for the full trigger table, [`docs/omo-comparison.md`](docs/omo-comparison.md) for how this differs from omo, [`docs/failure-modes.md`](docs/failure-modes.md) for recovery rules, and [`docs/cost-routing.md`](docs/cost-routing.md) for cost verification.

## When to delegate

**Delegate to the worker** when on the strong model and the task is:

- Writing or modifying scripts, configs, or code.
- Fixing shell/Python quoting, fragile command syntax, parse errors.
- Batch reading files, scanning a repository, grepping large trees.
- Analyzing long logs or compressing noisy output.
- Bounty scouting, issue triage, audits, multi-step research.
- Build/test loops where retries are likely.

**Do it in main** when:

- It's a simple Q&A or one short read.
- A single low-risk command or a one-line verification.
- A tiny deterministic edit that's easy to confirm.
- Main is already on the worker model and there's no parallelism/isolation win.

## Worker brief, minimum viable

```
Objective: <exact outcome in one line>
Scope:     <files / dirs / systems allowed>
Do not:    <destructive or external actions without approval>
Context:   <minimal facts needed>
Output:    <summary + changed files / commands / tests>
Verify:    <specific test / lint / build / inspection>
```

See [`examples/worker-brief-template.md`](examples/worker-brief-template.md) for the full template and rationale, and [`examples/pre-flight-checklist.md`](examples/pre-flight-checklist.md) for the expanded pre-flight checklist.

## Cost & routing at a glance

A run-time signal worth watching: if the main session's active model is the *same* as the worker model across many turns, the main has fallen back. From that point, **do not spawn a same-model worker for serial work** — it is paying twice. The full verification checklist and a discussion of why model name may not equal billing source is in [`docs/cost-routing.md`](docs/cost-routing.md).

## Failure rule

If main has **two consecutive** patch/command failures on the same problem:

1. Stop direct trial-and-error.
2. If currently on the strong model → delegate to the worker.
3. If already on the worker model → change strategy: isolate a smaller subproblem, build a scratch reproduction, or spawn only when you need isolation/parallelism.

Full recovery playbook in [`docs/failure-modes.md`](docs/failure-modes.md).

## CI / local checks

- **GitHub Actions** — `.github/workflows/skill-validate.yml` validates skill structure (frontmatter, layout, name, description, no obvious private hosts or credential shapes) and `.github/workflows/secret-scan.yml` runs gitleaks against the full history on push and weekly. Both use stock `ubuntu-latest` runners and have no required secrets.
- **Pre-commit** — `.pre-commit-config.yaml` provides a local mirror: gitleaks for staged changes, plus trailing-whitespace, EOF-newline, merge-conflict, YAML parse, and markdown sanity hooks. Install with `pip install pre-commit && pre-commit install`.

## Philosophy

- **Cheap work should not consume expensive context.** The planner's context should stay clean for planning.
- **A worker that does the same job as main is a liability, not a helper.** Don't double-pay for serial work.
- **A worker that runs in parallel, isolates a risky change, or survives a context trim is worth its cost.** Spend the budget when the isolation is real.
- **Models are configurable.** The rule is what matters; plug in your own pair.

## Contributing

Issues and PRs welcome. Keep examples generic — no personal names, credentials, private hosts, domains, IPs, or internal paths. Use placeholders like `<your-strong-model>` and `<your-worker-model>`. See the pre-flight checklist before submitting.

## License

MIT — see [LICENSE](LICENSE).
