# OpenCode / OpenClaw-style config examples

Generic configuration sketches for [OpenCode](https://opencode.ai)-style and OpenClaw-style agent runtimes. These examples show how to wire a strong/weak model pair, a small classification model, and a permission-scoped subagent into a runtime that exposes similar concepts.

> **Privacy note.** Replace every `<placeholder>` below with your own identifiers. Do **not** copy any private model-provider IDs, hostnames, or credentials into this repo. The goal is to illustrate shape, not to commit a working config.

The examples below assume a runtime with these primitives:

- A **default model** for the main session.
- A **named worker** model for delegated body-work.
- A **classifier / routing** model used to decide *whether* to delegate at all.
- A **subagent** profile that runs with a reduced permission set.

Real runtimes differ; treat the field names as illustrative. Adapt the schema to whatever your runtime actually accepts (`config.yaml`, `opencode.json`, agent profile files, etc.).

## 1. Strong (planner / reviewer) model in the main session

The default model for the main session should be the strongest model you have permission to use for planning, reviewing, and short reasoning chains. The main session's job is to stay clean for planning.

```yaml
# config.yaml (illustrative schema)
session:
  default_model: <your-strong-model>      # e.g. a GPT/Codex-class planner
  fallback_model: <your-worker-model>     # used only when the default is unavailable
  system_prompt_path: prompts/main.md
permissions:
  allow:
    - file.read
    - file.edit
    - shell.run
  deny:
    - network.egress
    - git.push
    - secrets.read
```

Notes:

- `default_model` is what the main session uses for planning and reviewing. The `adaptive-worker-delegation` skill assumes the main session starts on this model and falls back only when the runtime forces it.
- `permissions.allow` should be **narrow** in the main session. If a worker is doing scans, main should not need network egress.

## 2. Cheap worker (body-work) model for delegated tasks

The worker profile is the cheap model. The main session spawns a worker with this profile when delegating body-work, with a tight brief.

```yaml
# workers/body-worker.yaml (illustrative)
name: body-worker
model: <your-worker-model>                # cheap, fast, body-work oriented
isolation: context                         # fresh context, no shared history
context_policy:
  inherit: []                              # do not forward the main transcript
  brief_only: true                         # only the structured brief enters
permissions:
  allow:
    - file.read
    - file.edit
    - shell.run
    - search.grep
  deny:
    - network.egress
    - git.push
    - secrets.read
    - system.install
budget:
  max_steps: 40
  max_wall_seconds: 600
  max_tokens: 200000
```

Notes:

- `isolation: context` means each spawn starts with no shared history. The brief is the only context.
- `inherit: []` is the point. Do **not** forward the main session transcript. The worker's context is a budget.
- `budget` caps retries. The skill's failure rule is enforced partly by this cap: after two failed attempts the main session should change strategy, not let the worker loop forever.

## 3. Small classification model (routing decisions)

A tiny, fast model can be used as a *router* — its only job is to answer "is this light or heavy? should we delegate?" before the main session decides what to do. The router is cheaper than the worker, and dramatically cheaper than the strong model.

```yaml
# routers/classifier.yaml (illustrative)
name: classifier
model: <your-small-model>                 # cheapest available
output_format: json
schema:
  task_class: [light, heavy_body, heavy_planning]
  recommendation: [do_in_main, delegate, change_strategy]
  confidence: number
permissions:
  allow:
    - file.read                            # the brief only, no scan rights
  deny:
    - file.edit
    - shell.run
    - network.egress
budget:
  max_tokens: 4000
  max_wall_seconds: 15
```

Notes:

- The router does **not** do the work. It classifies. Treating it as a cheap pre-filter is what keeps the strong model from spending context on "is this a real worker job or can I just answer it?".
- `permissions.allow` is intentionally tiny: read the brief, return a class. No scans, no edits, no shell.

## 4. Permission-scoped subagent (the "scout" or "scanner" pattern)

For risky or blast-radius-sensitive body-work, run the worker with a *narrower* permission set than the body-worker default. This is the "scout" / "scanner" pattern: the worker can read and search, but cannot edit, push, or touch secrets.

```yaml
# workers/scout.yaml (illustrative)
name: scout
model: <your-worker-model>
isolation: context
context_policy:
  inherit: []
  brief_only: true
permissions:
  allow:
    - file.read
    - search.grep
    - search.glob
  deny:
    - file.edit
    - file.write
    - shell.run
    - network.egress
    - git.push
    - secrets.read
budget:
  max_steps: 20
  max_wall_seconds: 300
  max_tokens: 100000
```

Notes:

- The scout cannot modify the repo. If it needs an edit, the brief is escalated to a body-worker or back to main. This is the cheap way to keep blast radius small.
- Combine this with the failure rule: if the scout comes back without enough signal, escalate to a body-worker; do not let main duplicate the scout's scans.

## 5. Putting it together (illustrative `opencode.json`)

```jsonc
{
  "$schema": "https://example.com/opencode.schema.json",
  "session": {
    "default_model": "<your-strong-model>",
    "fallback_model": "<your-worker-model>"
  },
  "models": {
    "strong":  { "id": "<your-strong-model>" },
    "worker":  { "id": "<your-worker-model>" },
    "small":   { "id": "<your-small-model>" }
  },
  "routers": {
    "classifier": "routers/classifier.yaml"
  },
  "workers": {
    "body-worker": "workers/body-worker.yaml",
    "scout":       "workers/scout.yaml"
  },
  "skills": {
    "include": [
      "skills/adaptive-worker-delegation/"
    ]
  },
  "delegation": {
    "rule": "skills/adaptive-worker-delegation/SKILL.md",
    "default_decision": "route_via_classifier",
    "fallback_decision": "do_in_main"
  }
}
```

Notes:

- `delegation.rule` points the runtime at the skill in this repo. The runtime is expected to read it as guidance, not as executable code.
- `default_decision: route_via_classifier` means: ask the small model first, then act. `fallback_decision: do_in_main` is the conservative answer when classification is uncertain or the router is unavailable.
- All `<placeholder>` fields must be filled with your own identifiers before the file is usable. Do not commit a populated copy of this file with real IDs unless the repo is private; the placeholder form is what should be checked in here.

## 6. What to commit vs. what to keep local

| File or value | Commit? | Why |
| --- | --- | --- |
| The placeholder shape of `opencode.json` | yes | Other users can adapt it. |
| The placeholder workers / routers | yes | Same reason. |
| Your real model IDs | no | Model provider IDs can be account-specific. Keep them in a private override file. |
| API keys, tokens, hostnames | no | Never commit. Use the runtime's secrets store. |
| The skill files in `skills/` | yes | They are the rule, not the config. |

A common pattern is to commit a `config.example.yaml` and add `config.yaml` and `*.local.yaml` to `.gitignore`. The skill itself never needs secrets to function.
