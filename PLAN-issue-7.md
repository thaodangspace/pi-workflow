# PLAN: GitHub Issue #7 — Crash-Safe Recovery, Reconciliation, and Idempotent Effect Checkpoints

## Goal

Make workflow runs safe to resume after Pi reloads, process interruption, or crashes that occur between durable state transitions and external side effects.

Long-running automation must assume it can stop after any individual action.

## Recovery Model & Architecture

On session start or session tree reconstruction (`session_start`, `session_tree`), each nonterminal workflow run enters an authoritative reconciliation pass before new side effects are attempted.

The engine strictly distinguishes:
1. **Durable Workflow State**: Reconstructed deterministically from append-only custom entries along the active session branch (`WorkflowRunRegistry.reconstructFromSession`).
2. **Authoritative Scheduler State**: Tasks queried from the versioned `pi-loop` service boundary (`LoopSchedulerAdapter.reconcile`).
3. **Declared External-Effect Intent**: Checkpoints established before attempting external actions (`workflow_effect_begin`).
4. **Observed/Confirmed External Reality**: Confirmed external results observed and committed (`workflow_effect_commit` or `workflow_effect_reconcile`).

Recovery always prefers **observed external reality** over stale assumptions and **fails closed** when ownership or state is ambiguous.

---

## Key Components Implemented

### 1. Durable Effect Checkpoints API
- `workflow_effect_begin`: Records intent to perform an external side effect, establishing an idempotent checkpoint before executing the action.
  - Generates per-run unique keys.
  - Persists `effect_begin` mutation to session storage.
  - Replaying `begin` for a committed key returns the committed record with `{ status: "already_committed" }` and blocks duplicate execution.
  - An effect left in `started` state after restart/interruption is marked **ambiguous**, never automatically retried.
- `workflow_effect_commit`: Confirms and commits an external side effect after observing its success.
  - Persists `effect_commit` mutation to session storage.
  - Clears ambiguity and records reconciliation recovery events in durable history.
- `workflow_effect_reconcile`: Explicit tool for reconciling ambiguous effects after observing external reality.
  - Outcomes: `"committed"` (observed to have succeeded), `"aborted"` (abandoned/failed), `"retryable"` (cleared for safe re-attempt).
  - Records reason and findings.

### 2. Recovery & Reconciliation Phase
- Runs with ambiguous uncommitted effects enter **Reconciliation Mode**:
  - `hasAmbiguousEffects(run)` is true.
  - `buildRecoveryPrompt`: Dispatches a specialized recovery prompt instructing the agent to observe external reality before taking any action.
  - Step transitions (`workflow_transition`) and completion (`workflow_complete`) fail closed with `WorkflowAmbiguousEffectError` while ambiguous effects exist.
  - If external reality cannot be confirmed, `workflow_block` halts execution with a `human-required` blocker.

### 3. Deterministic Scheduler Reconciliation
- `LoopSchedulerAdapter.reconcile`:
  - **Terminal Runs**: Live scheduler tasks linked to completed or cancelled runs are stopped and pruned (`deleteTask`).
  - **Orphan Pruning**: Tasks in `pi-loop` pointing to missing workflow runs are pruned safely without touching non-workflow tasks (e.g. user `/loop`).
  - **Missing Task Recreation**: Active runs missing their scheduler task are safely recreated according to documented policy (`recreateMissing: true`). If disabled, runs are blocked with a `human-required` blocker.
  - **Ambiguous Linkage Protection**: If multiple tasks claim the same run ID or a task points to a mismatched run ID, the engine fails closed: duplicate tasks are stopped, and the run is moved to `blocked` (`human-required`).

### 4. Work Ownership & Lease Metadata
- `WorkflowRunLease`: Records `ownerId`, `acquiredAt`, `expiresAt`, and `leaseToken`.
- `acquireLease`: Exclusive lease acquisition. Attempting to acquire a run with an active, unexpired lease by a different owner fails closed with `WorkflowOwnershipError`.
- Every `LoopSchedulerAdapter` mints a stable per-instance `ownerId` (`<sessionId>:inst-<random>`), stamped into leases and iteration prompts (`- Owner: <ownerId>`).
- Production paths (`handleBeforeAgentStart`, `handleTurnStart`, `dispatchIteration`, model tools) pass the real per-instance owner into the dispatcher; a live lease held by another owner cannot be intercepted, dispatched, reconnected, or mutated (fail closed).
- On reconstruction, runs leased by another **live** instance are skipped with a `run-leased-by-other` diagnostic; after lease **expiry** the reconciling instance takes over deterministically (durable lease renewal + `scheduler_reconnected`). Leases are heartbeated on turn start so a crashed instance's lease lapses within `leaseDurationMs` (default 15m).
- Generic claim tokens via `getEffectClaimToken(runId, effectKey)` enable domain-specific external resource tagging, branching, and PR labeling.

### 6. Stale Linkage & Cross-Link Safety
- **Stale run↔task link**: reconnects the single live task that declares the run in place (never a duplicate) when ownership is proven, records `scheduler_reconnected`, and updates durable linkage.
- **Unprovable ownership**: fails closed (block `human-required`, stop the unverified task, record `scheduler_ambiguous`).
- **Terminal cross-links**: never stops a user `/loop` task or another run's task; clears the bogus linkage and emits `cross-point-*` diagnostics plus `scheduler_cleaned`.
- **Active run → user task**: blocks `human-required`, clears bogus durable linkage, preserves the user task.
- **Direct-control validation**: `cancelWakeup` (used by `/workflow pause`/`stop`) refuses to stop a task whose prompt belongs to another run or is a non-workflow task, preserving it; stale links to absent tasks are cleared.
- **Ownership precedes budget mutation**: `scheduleRun` asserts ownership before the budget check, so a non-owner cannot cancel/block another live owner's run.

### 5. Audit History & Visibility
- `WorkflowRun.history`: Chronological audit trail of all lifecycle mutations and actions.
- `WorkflowRun.recoveryEvents`: Chronological record of recovery and reconciliation events (`effect_ambiguous`, `effect_reconciled`, `effect_aborted`, `scheduler_reconnected`, `scheduler_recreated`, `scheduler_cleaned`, `scheduler_ambiguous`).
- Post-replay ambiguity marking appends to BOTH `recoveryEvents` and `history`. These entries are **synthesized** (`details.synthesized === true`, deterministic id `recov-<runId>-<effectKey>`, timestamp `effect.startedAt`), not persisted, so repeated reconstruction/`refresh()` is deterministic and duplicate-free.
- `/workflow status <run-id>`: Displays active effects, ambiguous warnings, lease details, and recent recovery events.

---

## Acceptance Criteria Verification

- [x] A run interrupted after effect-begin but before effect-commit resumes in reconciliation, not by blindly repeating the effect.
- [x] A committed effect cannot be accidentally repeated under the same key.
- [x] Scheduler/run mismatches are reconciled deterministically.
- [x] Terminal runs cannot retain live scheduler tasks after reconciliation.
- [x] Active runs with missing scheduler tasks can recover according to documented policy.
- [x] Ambiguous external effects lead to reconciliation/blocking, not automatic duplication.
- [x] Recovery events are visible in run history.
- [x] Tests simulate crashes at every checkpoint boundary around a representative external side effect.
- [x] Tests cover orphan scheduler tasks and stale run-to-task mappings.
- [x] Preserves Issue #5 (commands) and Issue #6 (budgets/completion gate) semantics.
