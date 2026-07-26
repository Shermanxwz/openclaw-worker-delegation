# OpenCode / OpenClaw-style config examples (v0.2 control-plane)

Generic configuration sketches for [OpenCode](https://opencode.ai)-style and OpenClaw-style agent runtimes. These examples show how to wire a strong/weak model pair, the control plane, the native `delegation-guard` plugin, and a permission-scoped subagent into a runtime that exposes similar concepts.

> **Privacy note.** Replace every `<placeholder>` below with your own identifiers. Do **not** copy any private model-provider IDs, hostnames, or credentials into this repo. The goal is to illustrate shape, not to commit a working config.

The examples below assume a runtime with these primitives:

- A **default model** for the main session.
- A **named worker** model for delegated body-work.
- A **control plane** sidecar that owns mode/route/policy/tool decisions and is reachable on loopback.
- A **native plugin** that calls the control plane from `before_prompt_build` and `before_tool_call`.
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
control_plane:
  url: http://127.0.0.1:8787               # loopback only; reverse proxy for HTTPS
  token_env: OCWD_AGENT_TOKEN              # bearer token shared with the native plugin
  mode: AUTO                               # WORKER | AUTO | MAIN — overridable per task
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

- `default_model` is what the main session uses for planning and reviewing. The control plane never picks a model — it only picks a route and applies a tool gate.
- `control_plane.token_env` is read by the native plugin at startup. Never put the token in a prompt, skill, workspace file, or browser JavaScript.
- `permissions.allow` should be **narrow** in the main session. If a worker is doing scans, main should not need network egress. The control plane's `before_tool_call` will re-check on every call regardless of what is declared here.

## 2. Cheap worker (body-work) model for delegated tasks

The worker profile is the cheap model. The main session spawns a worker with this profile when the controller's `/api/route` returns `worker`, with a tight brief.

```yaml
# workers/body-worker.yaml (illustrative)
name: body-worker
model: <your-worker-model>                # cheap, fast, body-work oriented
isolation: context                         # fresh context, no shared history
context_policy:
  inherit: []                              # do not forward the main transcript
  brief_only: true                         # only the structured brief enters
control_plane:
  obey: true                               # every tool call goes through /api/tool-check
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
- `control_plane.obey: true` means the native plugin must consult the controller on every tool call. This is the default and should not be disabled.
- `budget` caps retries. The skill's failure rule is enforced partly by this cap: after two failed attempts the main session should change strategy, not let the worker loop forever.

## 3. Small classification model (routing decisions)

The control plane does the routing internally with a deterministic rule; a tiny, fast model can still be useful as a *pre-filter* — its only job is to answer "is this light or heavy? should we delegate at all?" before the main session decides whether to even call `/api/route`.

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
- The control plane's router does not call this model — it uses deterministic rules. This file is only for agents that want a learned pre-filter in front of `/api/route`.

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
control_plane:
  obey: true
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

## 5. Verifier (read-only reviewer)

The verifier is a third profile that the controller routes to when the task is "review what the worker produced". It is read-only by default and can be promoted to allow execution only when the deployment explicitly adds it and provides a disposable sandbox; `exec` is not inherently read-only.

```yaml
# workers/verifier.yaml (illustrative)
name: verifier
model: <your-strong-model>                # reviewers benefit from the stronger model
isolation: context
context_policy:
  inherit: []
  brief_only: true                         # brief + the worker's reported output
control_plane:
  obey: true
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
  max_steps: 30
  max_wall_seconds: 300
```

Notes:

- The verifier is the cheapest way to confirm a worker's `Verify` claim without re-running the work.
- The control plane will route to the verifier when the brief mentions "review" or "verify" and the mode is `AUTO`.

## 6. Putting it together (illustrative `opencode.json`)

```jsonc
{
  "$schema": "https://example.com/opencode.schema.json",
  "session": {
    "default_model": "<your-strong-model>",
    "fallback_model": "<your-worker-model>"
  },
  "control_plane": {
    "url": "http://127.0.0.1:8787",
    "token_env": "OCWD_AGENT_TOKEN",
    "mode": "AUTO"
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
    "scout":       "workers/scout.yaml",
    "verifier":    "workers/verifier.yaml"
  },
  "plugins": {
    "delegation-guard": {
      "controller_url": "http://127.0.0.1:8787",
      "token_env": "OCWD_AGENT_TOKEN",
      "fail_closed": true
    }
  },
  "skills": {
    "include": [
      "skills/adaptive-worker-delegation/"
    ]
  },
  "delegation": {
    "rule": "skills/adaptive-worker-delegation/SKILL.md",
    "default_decision": "route_via_control_plane",
    "fallback_decision": "do_in_main"
  }
}
```

Notes:

- `delegation.rule` points the runtime at the skill in this repo. The runtime is expected to read it as guidance for *when* to consult the control plane, not as a substitute for it.
- `default_decision: route_via_control_plane` means: ask `/api/route` first, then act. `fallback_decision: do_in_main` is the conservative answer when the controller is unreachable or `enforcement` is `ADVISORY`.
- `plugins.delegation-guard` is the native enforcement plugin. It must be installed, enabled, and reporting fresh hooks before the panel reaches `HARD`.
- All `<placeholder>` fields must be filled with your own identifiers before the file is usable. Do not commit a populated copy of this file with real IDs unless the repo is private; the placeholder form is what should be checked in here.

## 7. What to commit vs. what to keep local

| File or value | Commit? | Why |
| --- | --- | --- |
| The placeholder shape of `opencode.json` | yes | Other users can adapt it. |
| The placeholder workers / routers | yes | Same reason. |
| Your real model IDs | no | Model provider IDs can be account-specific. Keep them in a private override file. |
| API keys, tokens, hostnames | no | Never commit. Use the runtime's secrets store. The control-plane bearer token is in `OCWD_AGENT_TOKEN`, not in config. |
| The skill files in `skills/` | yes | They are the rule, not the config. |

A common pattern is to commit a `config.example.yaml` and add `config.yaml` and `*.local.yaml` to `.gitignore`. The skill itself never needs secrets to function.
