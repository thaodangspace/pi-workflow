# Issue #6 Implementation Plan: Budgets, Completion Gates, and Blocked/Paused Semantics

Source: https://github.com/thaodangspace/pi-workflow/issues/6
Spec: `/Users/dt/code/brain/spec/2026/Sep/30/03_task_pi-workflow_issue-6_budgets_completion.md`
Builds on merged issues #1, #2, #3, #4, and #5.

## Goals

1. Make long-running workflows bounded with durable, enforceable execution budgets (turns/iterations, wall-clock duration, implementation attempts).
2. Fail closed on unsupported budget dimensions (cost/token budgets) without guessing or approximating.
3. Make completion an explicit engine concept via structured completion claims and evidence storage.
4. Provide a generic verifier mechanism driven by the Pi agent runtime with explicit accept/reject decisions and retry/rework policies.
5. Define distinct semantics for `paused` (human-controlled suspension, zero automatic polling) versus `blocked` (`external-retryable`, `human-required`, `terminal`).

## Key Changes

1. **Budget Policy & Enforcement (`src/types.ts`, `src/run.ts`, `src/dispatcher.ts`, `src/scheduler-adapter.ts`, `src/tools.ts`)**:
   - `checkRunBudgetExhaustion`: checks `maxTurns`, `maxDurationMs`, `maxAttempts`.
   - Checks hard budgets before every dispatch (`beginIteration`, `handleBeforeAgentStart`, `handleTurnStart`) and before follow-up scheduling (`workflow_continue`, `scheduleWakeup`).
   - On exhaustion: transitions run to `blocked` (`category: "human-required"`, `requiresHuman: true`) or `cancelled` according to `budget.onExhaustion`, cancels scheduler wakeup, and preserves last known run state.
   - Rejects unsupported token budgets (`maxTokens`) in definition parser and unsupported cost budgets (`maxCost`) in `startRun` and `/workflow start` with `WorkflowUnsupportedBudgetError`. Reports `costStatus: "unavailable"` in iteration context.
   - Persists turn counts, attempt counts, creation timestamps, and run-level budget limits across session reconstruction.
   - `reconcile` identifies exhausted reconstructed runs, stops any live scheduler tasks, and blocks them.

2. **Completion Gate & Generic Verification (`src/tools.ts`, `src/registry.ts`, `src/prompt.ts`, `src/session-entries.ts`)**:
   - `workflow_complete` submits an explicit completion claim with required summary and structured evidence references.
   - The engine stores evidence in run history without assuming claims are true.
   - If `completion.verify` is true, transitions step to `VERIFYING` and persists claim in session log (`action: "claim"`).
   - Constrained verifier prompt (`buildVerifierPrompt`) presents claim summary, evidence items, and verifier instructions.
   - Authoritative verification decision via `workflow_verify` tool (or `workflow_complete` with decision):
     - `accept`: marks run `completed`, records verification findings, and stops scheduler wakeups.
     - `reject`: rejects claim with findings. If attempts < `maxVerificationAttempts`, transitions back to `returnStep` for rework; if attempts exhausted, transitions to `blocked` (`human-required`).
     - A rejected claim never leaves a run marked complete.

3. **Distinct Blocked vs. Paused Semantics (`src/run.ts`, `src/data-bounds.ts`, `src/scheduler-adapter.ts`, `src/commands.ts`)**:
   - `paused`: human-controlled suspension (`/workflow pause <run-id>`). Nonterminal, no blocker reason. Stopped scheduler task; `reconcile` ensures zero live tasks in pi-loop. Resumed only via human `/workflow resume <run-id>`.
   - `blocked`: system/condition-controlled. Records `reason` and `category`:
     - `external-retryable`: external prerequisite (e.g. CI, webhook). May wake conservatively and re-check (`retryDelayMs`). `reconcile` permits matching conservative retry task.
     - `human-required`: human action/decision required. Stops automatic wakeups; `reconcile` deletes live tasks.
     - `terminal`: fatal condition. No autonomous polling.

4. **Production-Faithful Extension Composition (`src/index.ts`, `test/budgets-and-completion.test.ts`)**:
   - `workflowExtension(pi)` registers all 6 tools including `workflow_verify`.
   - Verified through full extension composition tests coordinating events, session entries, scheduler adapter, and tools.
