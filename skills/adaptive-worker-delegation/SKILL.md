---
name: adaptive-worker-delegation
description: Obey externally selected Worker, Auto, or Main execution modes. Use the native delegation controller and pre-tool gate instead of inferring authority from the active model or chat history.
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

Mode and permissions are external runtime state. Never reconstruct them from conversation text, model identity, fallback behavior, or prior turns.

## Runtime contract

1. Obtain the authoritative route before execution.
2. Treat the controller/native plugin tool decision as mandatory.
3. Never change `agentId`, `runId`, or session identity to seek a wider policy.
4. A blocked call is final. Report it; do not search for an equivalent bypass.
5. Publish Worker, model, tool, and verification lifecycle events.

## Worker mode

Main may understand the request, answer pure text questions, prepare a precise brief, spawn/observe Workers, review their reported output, and summarize. Main must not read project files, browse for body-work, mutate state, execute commands, run tests, or duplicate a Worker scan. Worker failure changes the brief, Worker, model, isolation, or strategy; it never silently transfers execution to Main.

## Auto mode

Follow the route exactly. A Main-routed light task may use only the returned lightweight observation tools. A Worker-routed task makes Main coordination-only. Mutation, runtime execution, repository scans, and retry-heavy work should route to Workers; tool-requiring uncertainty fails closed to Worker.

## Main mode

Main performs work directly and does not spawn Workers. Existing Worker and Verifier tool calls are frozen. Main mode is explicit temporary privilege elevation and may expire at any time; check the policy before every call.

## Role invariants

- Model fallback never changes role or permission.
- Main cannot self-promote because a task seems easy or urgent.
- Worker cannot impersonate Main or Verifier.
- Verifier is read-only by default. Execution is allowed only when the deployment explicitly adds it and provides a disposable sandbox; `exec` is not inherently read-only.
- The Worker brief must scope files, systems, destructive actions, expected output, verification, and risk.

## Minimum Worker brief

```text
Objective: <exact outcome>
Scope:     <allowed files, directories, systems>
Do not:    <destructive, external, credential or publishing actions>
Context:   <minimal required facts>
Output:    <summary, changed files, commands and evidence>
Verify:    <specific verification or verifier handoff>
Risk:      <low | medium | high, with reason>
```
