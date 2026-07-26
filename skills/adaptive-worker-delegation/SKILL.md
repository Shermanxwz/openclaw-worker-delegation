---
name: adaptive-worker-delegation
description: Apply externally selected worker, automatic, or main-only execution modes. Consult the delegation controller before tool use and obey its returned policy instead of inferring permissions from the active model.
license: MIT
compatibility: openclaw, generic-agent-loop
metadata:
  version: "0.2.0"
  category: routing
  audience: agent-runtime
  workflow: adaptive-delegation
  tags: delegation,control-plane,permissions,workers,routing
---

# Adaptive worker delegation

The current mode is external runtime state. Do not guess or reconstruct it from chat history.

## Before task execution

1. Ask the controller for the effective mode and route.
2. Apply the returned tool policy before exposing tools to main.
3. For every proposed tool invocation, enforce the controller tool check.
4. Publish routing, tool, worker and verification events.

## Modes

### Worker

Main may understand, plan, create a brief, spawn a worker, inspect results and report. Main must not write, edit, patch, execute commands, run tests or duplicate worker body-work. Pure text Q&A may remain in main unless strict worker-all is active.

### Auto

Use the controller result. Mutation, execution, repository scans and retry-heavy work default to workers. If routing is uncertain and the task requires tools, fail closed to a worker.

### Main

Main performs the task directly and does not automatically spawn workers. This mode is an explicit user-controlled privilege elevation and may expire automatically.

## Role invariants

- Model fallback never changes the role's permissions.
- Worker failure changes the brief, worker, model or strategy; it does not silently transfer authority to main in worker mode.
- A verifier may execute verification commands but must not edit source files.
- A blocked tool call is a reportable event, not a suggestion to find a bypass.

## Minimum worker brief

```text
Objective: <exact outcome>
Scope: <allowed files and systems>
Do not: <destructive or external actions>
Context: <minimal required facts>
Output: <summary, files, commands, evidence>
Verify: <specific verification>
Risk: <low | medium | high and reason>
```
