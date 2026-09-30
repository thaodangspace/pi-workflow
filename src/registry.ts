/**
 * Authoritative runtime registry for workflow executions.
 * Manages run lifecycles, concurrency policies, JSON bounds, and append-only session persistence.
 */

import { randomUUID } from "node:crypto";
import {
  MAX_RUN_HISTORY_QUERY_LIMIT,
  MAX_RUN_RECOVERY_EVENTS,
  WORKFLOW_RUN_ENTRY_TYPE,
} from "./constants.ts";
import { appendBounded } from "./bounded-history.ts";
import { validateRunId } from "./data-bounds.ts";
import {
  appendHistoryProjection,
  applyAcquireLease,
  applyBlockRun,
  applyCancelRun,
  applyClaimCompletion,
  applyCompleteRun,
  applyEffectBegin,
  applyEffectCommit,
  applyEffectReconcile,
  applyMarkEffectAmbiguous,
  applyPauseRun,
  applyRecoveryEvent,
  applyReleaseLease,
  applyResumeRun,
  applyRunUpdate,
  applyStepTransition,
  applyVerifyRun,
  applyWakeupScheduled,
  createWorkflowRun,
  getHistoryProjection,
  getRecoveryProjection,
  isTerminalLifecycle,
} from "./run.ts";
import {
  buildMutationEntryData,
  parseSessionMutationEntry,
} from "./session-entries.ts";
import { createWorkflowSnapshot, isWorkflowSnapshot } from "./snapshot.ts";
import {
  type AcquireLeaseOptions,
  type BlockRunOptions,
  type CancelRunOptions,
  type ClaimCompletionOptions,
  type CompleteRunOptions,
  type CreateRunOptions,
  type EffectBeginOptions,
  type EffectCommitOptions,
  type EffectReconcileOptions,
  type MarkEffectAmbiguousOptions,
  type PauseRunOptions,
  type ReconstructOptions,
  type ResumeRunOptions,
  type TransitionStepOptions,
  type UpdateRunOptions,
  type VerifyCompletionOptions,
  type WakeupScheduledOptions,
  WorkflowConcurrencyError,
  type WorkflowDefinitionV1,
  WorkflowInvalidTransitionError,
  WorkflowPersistenceError,
  type WorkflowRecoveryEvent,
  type WorkflowRecoveryEventOptions,
  type WorkflowRun,
  WorkflowRunError,
  type WorkflowRunDiagnostic,
  type WorkflowRunHistoryOptions,
  type WorkflowRunHistoryView,
  type WorkflowRunLifecycle,
  WorkflowRunNotFoundError,
  type WorkflowSessionTarget,
  type WorkflowSnapshotV1,
} from "./types.ts";

export interface ListRunsFilter {
  workflow?: string;
  lifecycle?: WorkflowRunLifecycle | WorkflowRunLifecycle[];
  nonterminalOnly?: boolean;
}

export class WorkflowRunRegistry {
  private runs = new Map<string, WorkflowRun>();
  private diagnostics: WorkflowRunDiagnostic[] = [];
  private sessionTarget?: WorkflowSessionTarget;
  /**
   * Post-commit mutation observers (issue #10). Listeners are notified only
   * AFTER a run mutation has been persisted and committed to the in-memory map,
   * so an observer can never observe a torn state. Observer errors are swallowed
   * so a passive UI refresh can never break a durable mutation.
   */
  private mutationListeners = new Set<() => void>();

  constructor(sessionTarget?: WorkflowSessionTarget) {
    this.sessionTarget = sessionTarget;
  }

  /**
   * Subscribe to post-commit registry mutations. Returns an idempotent
   * unsubscribe function. No mutation replay/scan is performed for observers.
   */
  subscribeMutations(listener: () => void): () => void {
    this.mutationListeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.mutationListeners.delete(listener);
    };
  }

  private notifyMutations(): void {
    for (const listener of Array.from(this.mutationListeners)) {
      try {
        listener();
      } catch {
        // Passive observers must never break a durable mutation.
      }
    }
  }

  /**
   * Commit a run into the authoritative map (post-persist) and notify observers.
   */
  private commitRun(runId: string, run: WorkflowRun): void {
    this.runs.set(runId, run);
    this.notifyMutations();
  }

  /**
   * Bind or unbind a session target for persisting mutations and replaying active branch entries.
   */
  bindSession(sessionTarget: WorkflowSessionTarget | undefined): void {
    this.sessionTarget = sessionTarget;
  }

  /**
   * Get the currently bound session target.
   */
  getSessionTarget(): WorkflowSessionTarget | undefined {
    return this.sessionTarget;
  }

  /**
   * Returns accumulated diagnostics from replay or validation.
   */
  getDiagnostics(): WorkflowRunDiagnostic[] {
    return [...this.diagnostics];
  }

  /**
   * Clears accumulated diagnostics.
   */
  clearDiagnostics(): void {
    this.diagnostics = [];
  }

  /**
   * Create and register a new workflow run.
   *
   * Enforces concurrency.maxRuns against all nonterminal runs of the same workflow.
   * Both "blocked" and "paused" runs remain nonterminal and occupy concurrency slots
   * because their state and execution context remain live and awaiting resumption.
   */
  createRun(
    definitionOrSnapshot: WorkflowDefinitionV1 | WorkflowSnapshotV1,
    options: CreateRunOptions = {}
  ): WorkflowRun {
    const snapshot: WorkflowSnapshotV1 = isWorkflowSnapshot(definitionOrSnapshot)
      ? definitionOrSnapshot
      : createWorkflowSnapshot(definitionOrSnapshot);

    const workflowName = snapshot.name;
    const maxRuns = snapshot.concurrency?.maxRuns ?? 1;

    // Check custom runId collision BEFORE concurrency checks
    if (options.runId) {
      const validRunId = validateRunId(options.runId);
      if (this.runs.has(validRunId)) {
        const existing = this.runs.get(validRunId)!;
        if (existing.workflow !== workflowName) {
          throw new WorkflowRunError(
            `Run ID "${validRunId}" already exists for workflow "${existing.workflow}" (cannot be reused for workflow "${workflowName}")`,
            validRunId
          );
        }

        if (!isTerminalLifecycle(existing.lifecycle)) {
          if (options.existingPolicy === "returnExisting") {
            return existing;
          }
          throw new WorkflowConcurrencyError(
            workflowName,
            [existing.id],
            maxRuns,
            `Run with ID "${validRunId}" is already active in workflow "${workflowName}"`
          );
        }

        throw new WorkflowRunError(
          `Run ID "${validRunId}" already exists as a terminal run in workflow "${workflowName}".`,
          validRunId
        );
      }
    }

    // Find nonterminal runs of this workflow
    const nonterminalRuns = this.getNonterminalRuns(workflowName);

    if (nonterminalRuns.length >= maxRuns) {
      if (options.existingPolicy === "returnExisting") {
        return nonterminalRuns[0];
      }
      throw new WorkflowConcurrencyError(
        workflowName,
        nonterminalRuns.map((r) => r.id),
        maxRuns
      );
    }

    const run = createWorkflowRun({
      id: options.runId,
      snapshot,
      initialStep: options.initialStep,
      initialData: options.initialData,
      budget: options.budget,
      loopTaskId: options.loopTaskId,
      createdAt: options.createdAt,
    });

    // Build mutation entry
    const entryData = buildMutationEntryData("create", run.id, run.workflow, {
      snapshot: run.snapshot,
      initialStep: run.step,
      initialData: run.data,
      budget: run.budget,
      loopTaskId: run.loopTaskId,
    }, { timestamp: run.createdAt });

    this.persistEntry(entryData);
    this.commitRun(run.id, run);

    return run;
  }

  /**
   * Update an active or nonterminal run's step, counters, or data.
   */
  updateRun(runId: string, options: UpdateRunOptions): WorkflowRun {
    const current = this.requireRun(runId);
    const updated = applyRunUpdate(current, options);

    const entryData = buildMutationEntryData("update", runId, updated.workflow, {
      step: options.step,
      data: options.data,
      attempts: options.attempts,
      incrementAttempts: options.incrementAttempts,
      turns: options.turns,
      incrementTurns: options.incrementTurns,
      loopTaskId: options.loopTaskId,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Advance the workflow run's execution step.
   */
  transitionStep(runId: string, options: TransitionStepOptions): WorkflowRun {
    const current = this.requireRun(runId);
    const updated = applyStepTransition(current, options);

    const entryData = buildMutationEntryData("transition", runId, updated.workflow, {
      toStep: options.toStep,
      data: options.data,
      reason: options.reason,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Transition an active run into "blocked" lifecycle state.
   */
  blockRun(runId: string, options: BlockRunOptions): WorkflowRun {
    const current = this.requireRun(runId);
    const updated = applyBlockRun(current, options);

    const entryData = buildMutationEntryData("block", runId, updated.workflow, {
      reason: options.reason,
      category: updated.blocker?.category,
      requiresHuman: updated.blocker?.requiresHuman,
      retryDelayMs: updated.blocker?.retryDelayMs,
      data: options.data,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Transition an active run into "paused" lifecycle state.
   */
  pauseRun(runId: string, options: PauseRunOptions = {}): WorkflowRun {
    const current = this.requireRun(runId);
    const updated = applyPauseRun(current, options);

    const entryData = buildMutationEntryData("pause", runId, updated.workflow, {
      reason: options.reason,
      data: options.data,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Resume a "paused" or "blocked" run back to "active" lifecycle state.
   */
  resumeRun(runId: string, options: ResumeRunOptions = {}): WorkflowRun {
    const current = this.requireRun(runId);
    const updated = applyResumeRun(current, options);

    const entryData = buildMutationEntryData("resume", runId, updated.workflow, {
      step: options.step,
      data: options.data,
      reason: options.reason,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Submit an explicit completion claim for verification.
   */
  claimCompletion(runId: string, options: ClaimCompletionOptions): WorkflowRun {
    const current = this.requireRun(runId);
    const updated = applyClaimCompletion(current, options);

    const entryData = buildMutationEntryData("claim", runId, updated.workflow, {
      summary: options.summary,
      evidence: options.evidence,
      data: options.data,
      claimId: options.claimId,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Authoritatively evaluate and record verification findings for a completion claim.
   */
  verifyRun(runId: string, options: VerifyCompletionOptions): WorkflowRun {
    const current = this.requireRun(runId);
    const updated = applyVerifyRun(current, options);

    const entryData = buildMutationEntryData("verify", runId, updated.workflow, {
      decision: options.decision,
      feedback: options.feedback ?? options.findings,
      checks: options.checks,
      returnStep: options.returnStep,
      data: options.data,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Mark a run as successfully "completed" (terminal).
   */
  completeRun(runId: string, options: CompleteRunOptions): WorkflowRun {
    const current = this.requireRun(runId);
    const updated = applyCompleteRun(current, options);

    const entryData = buildMutationEntryData("complete", runId, updated.workflow, {
      summary: options.summary,
      evidence: options.evidence,
      data: options.data,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Terminate a run as "cancelled" (terminal).
   */
  cancelRun(runId: string, options: CancelRunOptions = {}): WorkflowRun {
    const current = this.requireRun(runId);
    const updated = applyCancelRun(current, options);

    const entryData = buildMutationEntryData("cancel", runId, updated.workflow, {
      reason: options.reason,
      data: options.data,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Begin an external effect checkpoint on an active run.
   */
  beginEffect(runId: string, options: EffectBeginOptions): WorkflowRun {
    const current = this.requireRun(runId);
    const updated = applyEffectBegin(current, options);

    if (updated === current) {
      return updated;
    }

    const entryData = buildMutationEntryData("effect_begin", runId, updated.workflow, {
      key: options.key,
      kind: options.kind,
      inputSummary: options.inputSummary,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Commit an external effect checkpoint after observed execution.
   */
  commitEffect(runId: string, options: EffectCommitOptions): WorkflowRun {
    const current = this.requireRun(runId);
    const wasAmbiguous = current.effects?.[options.key]?.ambiguous === true;
    const eventId = wasAmbiguous
      ? options.eventId ?? `recov-${randomUUID().slice(0, 8)}`
      : undefined;
    const updated = applyEffectCommit(current, {
      ...options,
      recovered: wasAmbiguous,
      eventId,
    });

    if (updated === current) {
      return updated;
    }

    const entryData = buildMutationEntryData("effect_commit", runId, updated.workflow, {
      key: options.key,
      resultSummary: options.resultSummary,
      ...(wasAmbiguous ? { recovered: true, eventId } : {}),
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Reconcile an interrupted or ambiguous effect checkpoint.
   */
  reconcileEffect(runId: string, options: EffectReconcileOptions): WorkflowRun {
    const current = this.requireRun(runId);
    const eventId = options.eventId ?? `recov-${randomUUID().slice(0, 8)}`;
    const updated = applyEffectReconcile(current, { ...options, eventId });

    const entryData = buildMutationEntryData("effect_reconcile", runId, updated.workflow, {
      key: options.key,
      resolution: options.resolution,
      reason: options.reason,
      resultSummary: options.resultSummary,
      eventId,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Conservatively mark a started mutating effect ambiguous after a dispatch
   * whose remote outcome is uncertain. Persisted and replay-faithful so a
   * same-session retry (as well as a reload) fails closed until reconciled.
   */
  markEffectAmbiguous(runId: string, options: MarkEffectAmbiguousOptions): WorkflowRun {
    const current = this.requireRun(runId);
    const eventId = options.eventId ?? `recov-${runId}-${options.key}`;
    const updated = applyMarkEffectAmbiguous(current, { ...options, eventId });

    if (updated === current) {
      return updated;
    }

    const entryData = buildMutationEntryData("effect_ambiguous", runId, updated.workflow, {
      key: options.key,
      reason: options.reason,
      eventId,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Record an authoritative recovery event on a run.
   */
  recordRecoveryEvent(runId: string, options: WorkflowRecoveryEventOptions): WorkflowRun {
    const current = this.requireRun(runId);
    const eventId = options.eventId ?? `recov-${randomUUID().slice(0, 8)}`;
    const updated = applyRecoveryEvent(current, { ...options, eventId });

    const entryData = buildMutationEntryData("recovery", runId, updated.workflow, {
      type: options.type,
      message: options.message,
      details: options.details,
      eventId,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Record a durable, replay-equivalent `wakeup_scheduled` history fact.
   *
   * Audit-only: no run lifecycle transition. Terminal runs are not persisted so
   * replay matches the live path. Only safe scalar metadata (the clamped delay)
   * is stored; never the wakeup reason, task prompt or task ID.
   */
  recordWakeupScheduled(runId: string, options: WakeupScheduledOptions): WorkflowRun {
    const current = this.requireRun(runId);
    if (isTerminalLifecycle(current.lifecycle)) {
      return current;
    }
    const updated = applyWakeupScheduled(current, options);
    const entryData = buildMutationEntryData(
      "wakeup_scheduled",
      runId,
      updated.workflow,
      { delayMs: options.delayMs },
      { timestamp: updated.updatedAt }
    );
    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Acquire or renew an ownership lease on a run.
   */
  acquireLease(runId: string, options: AcquireLeaseOptions): WorkflowRun {
    const current = this.requireRun(runId);
    const updated = applyAcquireLease(current, options);

    const entryData = buildMutationEntryData("lease", runId, updated.workflow, {
      ownerId: options.ownerId,
      expiresAt: options.expiresAt,
      leaseToken: options.leaseToken,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Release an ownership lease on a run.
   */
  releaseLease(runId: string, ownerId: string): WorkflowRun {
    const current = this.requireRun(runId);
    const updated = applyReleaseLease(current, ownerId);

    if (updated === current) {
      return updated;
    }

    const entryData = buildMutationEntryData("update", runId, updated.workflow, {
      lease: null,
      leaseOwnerId: ownerId,
    }, { timestamp: updated.updatedAt });

    this.persistEntry(entryData);
    this.commitRun(runId, updated);
    return updated;
  }

  /**
   * Get a bounded, deterministic view of a run's recent history projection.
   *
   * The accessor never scans or materializes the lifetime session log: it reads
   * only the in-memory projection (`O(MAX_RUN_HISTORY_ENTRIES)`).
   *
   * - `order` is `"oldest"` (default, chronological) or `"newest"` (most recent
   *   first). Both orderings are deterministic.
   * - `limit` is clamped to `[0, MAX_RUN_HISTORY_QUERY_LIMIT]`. The `limit` picks
   *   the most recent `limit` retained entries (returned in the requested order).
   * - Truncation metadata (`total`, `retained`, `dropped`, `truncated`) lets
   *   callers distinguish a short-lived run from a long-lived one whose history
   *   has been truncated.
   */
  getRunHistory(runId: string, options: WorkflowRunHistoryOptions = {}): WorkflowRunHistoryView {
    const run = this.requireRun(runId);
    const retainedEntries = run.history ?? [];
    const retained = retainedEntries.length;
    const total = run.historyTotal ?? retained;
    const dropped = run.historyDropped ?? Math.max(0, total - retained);

    const order = options.order === "newest" ? "newest" : "oldest";
    const requested = options.limit;
    const limit =
      requested === undefined || !Number.isFinite(requested)
        ? MAX_RUN_HISTORY_QUERY_LIMIT
        : Math.min(MAX_RUN_HISTORY_QUERY_LIMIT, Math.max(0, Math.floor(requested)));

    const limited = retained > limit;
    // `retainedEntries` is oldest-first; the most recent window is the tail.
    const window = limited ? retainedEntries.slice(retained - limit) : retainedEntries;
    const entries = order === "newest" ? Object.freeze([...window].reverse()) : window;

    return Object.freeze({
      runId,
      entries,
      order,
      limit,
      retained,
      total,
      dropped,
      truncated: dropped > 0,
      limited,
    });
  }

  /**
   * Get the bounded recent recovery-event projection for a run (oldest first).
   */
  getRunRecoveryEvents(runId: string): ReadonlyArray<WorkflowRecoveryEvent> {
    return this.requireRun(runId).recoveryEvents ?? [];
  }


  /**
   * Lookup a run by ID.
   */
  getRun(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * Assert a run exists and return it, or throw WorkflowRunNotFoundError.
   */
  requireRun(runId: string): WorkflowRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new WorkflowRunNotFoundError(runId);
    }
    return run;
  }

  /**
   * Check whether a run ID is present.
   */
  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * List runs matching optional filters.
   */
  listRuns(filter: ListRunsFilter = {}): WorkflowRun[] {
    const results: WorkflowRun[] = [];

    const lifecycles = filter.lifecycle
      ? Array.isArray(filter.lifecycle)
        ? filter.lifecycle
        : [filter.lifecycle]
      : null;

    for (const run of this.runs.values()) {
      if (filter.workflow && run.workflow !== filter.workflow) {
        continue;
      }
      if (lifecycles && !lifecycles.includes(run.lifecycle)) {
        continue;
      }
      if (filter.nonterminalOnly && isTerminalLifecycle(run.lifecycle)) {
        continue;
      }
      results.push(run);
    }

    return results;
  }

  /**
   * Get active runs for all workflows or a specific workflow.
   */
  getActiveRuns(workflow?: string): WorkflowRun[] {
    return this.listRuns({ workflow, lifecycle: "active" });
  }

  /**
   * Get nonterminal runs (active, paused, blocked) for all workflows or a specific workflow.
   */
  getNonterminalRuns(workflow?: string): WorkflowRun[] {
    return this.listRuns({ workflow, nonterminalOnly: true });
  }

  /**
   * Reconstruct all run state deterministically from the active session branch only.
   *
   * Replays mutation entries in topological branch order from root to current leaf.
   * Abandoned branches are automatically excluded by Pi's getBranch() contract.
   * Replay is idempotent and avoids duplicate run creations.
   */
  reconstructFromSession(
    target?: WorkflowSessionTarget,
    options: ReconstructOptions = {}
  ): { runs: WorkflowRun[]; diagnostics: WorkflowRunDiagnostic[] } {
    if (target) {
      this.sessionTarget = target;
    }

    if (!this.sessionTarget) {
      return { runs: Array.from(this.runs.values()), diagnostics: this.getDiagnostics() };
    }

    const branchEntries = this.sessionTarget.getBranch();
    const newRuns = new Map<string, WorkflowRun>();
    const localDiagnostics: WorkflowRunDiagnostic[] = [];

    for (const entry of branchEntries) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        entry.type !== "custom" ||
        entry.customType !== WORKFLOW_RUN_ENTRY_TYPE
      ) {
        continue;
      }

      const { entryData, diagnostic } = parseSessionMutationEntry(entry.data, entry.id);

      if (diagnostic) {
        localDiagnostics.push(diagnostic);
        if (options.strict) {
          throw new WorkflowPersistenceError(
            `Malformed session entry encountered in strict replay: ${diagnostic.message}`,
            { entryId: entry.id }
          );
        }
        continue;
      }

      if (!entryData) continue;

      const { action, runId, payload, timestamp } = entryData;
      const p = (payload ?? {}) as Record<string, any>;

      try {
        if (action === "create") {
          if (newRuns.has(runId)) {
            // Idempotent duplicate create entry ignored during replay
            localDiagnostics.push({
              type: "warning",
              code: "DUPLICATE_CREATE_IGNORED",
              message: `Duplicate create entry for run "${runId}" ignored during replay`,
              runId,
              entryId: entry.id,
              timestamp,
            });
            continue;
          }

          const run = createWorkflowRun({
            id: runId,
            snapshot: p.snapshot,
            initialStep: p.initialStep,
            initialData: p.initialData,
            budget: p.budget,
            loopTaskId: p.loopTaskId,
            createdAt: timestamp,
          });
          newRuns.set(runId, run);
        } else {
          const current = newRuns.get(runId);
          if (!current) {
            localDiagnostics.push({
              type: "error",
              code: "ORPHANED_MUTATION",
              message: `Cannot apply mutation "${action}" to non-existent run "${runId}"`,
              runId,
              entryId: entry.id,
              timestamp,
            });
            if (options.strict) {
              throw new WorkflowPersistenceError(
                `Orphaned mutation "${action}" for run "${runId}"`,
                { runId, entryId: entry.id }
              );
            }
            continue;
          }

          let updated: WorkflowRun;
          switch (action) {
            case "update":
              if (p.lease === null) {
                // Backward/supported encoding for ownership lease release: clear
                // the lease and append the same audit history entry as the live
                // applyReleaseLease path, using the persisted owner and timestamp
                // so replay is byte-for-byte faithful.
                const releaseOwner =
                  typeof p.leaseOwnerId === "string" && p.leaseOwnerId.length > 0
                    ? p.leaseOwnerId
                    : current.lease?.ownerId ?? "";
                updated = applyReleaseLease(current, releaseOwner, timestamp);
                break;
              }
              updated = applyRunUpdate(current, {
                step: p.step,
                data: p.data,
                attempts: p.attempts,
                incrementAttempts: p.incrementAttempts,
                turns: p.turns,
                incrementTurns: p.incrementTurns,
                loopTaskId: p.loopTaskId,
                updatedAt: timestamp,
              });
              break;
            case "transition":
              updated = applyStepTransition(current, {
                toStep: p.toStep,
                data: p.data,
                reason: p.reason,
                updatedAt: timestamp,
              });
              break;
            case "block":
              updated = applyBlockRun(current, {
                reason: p.reason,
                category: p.category,
                requiresHuman: p.requiresHuman,
                retryDelayMs: p.retryDelayMs,
                data: p.data,
                blockedAt: timestamp,
              });
              break;
            case "claim":
              updated = applyClaimCompletion(current, {
                summary: p.summary,
                evidence: p.evidence,
                data: p.data,
                claimId: p.claimId,
                submittedAt: timestamp,
              });
              break;
            case "verify":
              updated = applyVerifyRun(current, {
                decision: p.decision,
                feedback: p.feedback ?? p.findings,
                checks: p.checks,
                returnStep: p.returnStep,
                data: p.data,
                verifiedAt: timestamp,
              });
              break;
            case "pause":
              updated = applyPauseRun(current, {
                reason: p.reason,
                data: p.data,
                pausedAt: timestamp,
              });
              break;
            case "resume":
              updated = applyResumeRun(current, {
                step: p.step,
                data: p.data,
                reason: p.reason,
                resumedAt: timestamp,
              });
              break;
            case "complete":
              updated = applyCompleteRun(current, {
                summary: p.summary,
                evidence: p.evidence,
                data: p.data,
                completedAt: timestamp,
              });
              break;
            case "cancel":
              updated = applyCancelRun(current, {
                reason: p.reason,
                data: p.data,
                cancelledAt: timestamp,
              });
              break;
            case "effect_begin":
              updated = applyEffectBegin(current, {
                key: p.key,
                kind: p.kind,
                inputSummary: p.inputSummary,
                startedAt: timestamp,
                allowCommitted: true,
              });
              break;
            case "effect_commit":
              updated = applyEffectCommit(current, {
                key: p.key,
                resultSummary: p.resultSummary,
                committedAt: timestamp,
                recovered: p.recovered === true,
                eventId: typeof p.eventId === "string" ? p.eventId : undefined,
              });
              break;
            case "effect_reconcile":
              updated = applyEffectReconcile(current, {
                key: p.key,
                resolution: p.resolution,
                reason: p.reason,
                resultSummary: p.resultSummary,
                reconciledAt: timestamp,
                eventId: typeof p.eventId === "string" ? p.eventId : undefined,
              });
              break;
            case "effect_ambiguous":
              updated = applyMarkEffectAmbiguous(current, {
                key: p.key,
                reason: p.reason,
                markedAt: timestamp,
                eventId:
                  typeof p.eventId === "string" ? p.eventId : `recov-${runId}-${p.key}`,
              });
              break;
            case "wakeup_scheduled":
              updated = applyWakeupScheduled(current, {
                delayMs: typeof p.delayMs === "number" ? p.delayMs : 0,
                timestamp,
              });
              break;
            case "recovery":
              updated = applyRecoveryEvent(current, {
                type: p.type,
                message: p.message,
                details: p.details,
                timestamp,
                eventId: typeof p.eventId === "string" ? p.eventId : undefined,
              });
              break;
            case "lease":
              updated = applyAcquireLease(current, {
                ownerId: p.ownerId,
                expiresAt: p.expiresAt,
                leaseToken: p.leaseToken,
                now: timestamp,
              });
              break;
            default:
              continue;
          }

          newRuns.set(runId, updated);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        localDiagnostics.push({
          type: "error",
          code: "REPLAY_ERROR",
          message: `Failed to replay mutation "${action}" on run "${runId}": ${message}`,
          runId,
          entryId: entry.id,
          timestamp,
        });
        if (options.strict) {
          throw err;
        }
      }
    }

    // Post-replay reconciliation pass:
    // Identify any uncommitted effects that were in "started" state when session reloaded.
    // In accordance with recovery model: started effects after interruption are ambiguous, never auto-retried.
    //
    // These "effect_ambiguous" recovery events are SYNTHESIZED in memory (not persisted as
    // session entries) because ambiguity is a derived property of durable replay, not a new
    // user action. They are marked with `synthesized: true` to distinguish them from
    // PERSISTED recovery events (e.g. `effect_reconciled` written via applyEffectReconcile).
    // Event/ history IDs and timestamps are deterministic so repeated reconstruction is
    // idempotent and never duplicates entries.
    for (const [runId, run] of newRuns.entries()) {
      if (isTerminalLifecycle(run.lifecycle)) continue;
      if (!run.effects) continue;

      let hasAmbiguous = false;
      const updatedEffects = { ...run.effects };
      let recoveryProjection = getRecoveryProjection(run);
      let historyProjection = getHistoryProjection(run);

      for (const [key, effect] of Object.entries(run.effects)) {
        if (effect.status !== "started" || effect.ambiguous) continue;

        hasAmbiguous = true;
        updatedEffects[key] = Object.freeze({
          ...effect,
          ambiguous: true,
        });
        const eventId = `recov-${runId}-${key}`;
        const alreadyRecorded =
          recoveryProjection.entries.some((e) => e.eventId === eventId) ||
          historyProjection.entries.some((h) => h.eventId === eventId);
        if (alreadyRecorded) continue;

        const recEvent: WorkflowRecoveryEvent = Object.freeze({
          eventId,
          type: "effect_ambiguous",
          timestamp: effect.startedAt,
          message: `Effect "${effect.key}" (${effect.kind}) was in started state when session reloaded. State is ambiguous; reconciliation required before new side effects.`,
          details: Object.freeze({ key: effect.key, kind: effect.kind, synthesized: true }),
        });
        recoveryProjection = appendBounded(recoveryProjection, recEvent, MAX_RUN_RECOVERY_EVENTS);
        historyProjection = appendHistoryProjection(
          historyProjection,
          "recovery",
          `Recovery event [effect_ambiguous]: ${recEvent.message}`,
          { key: effect.key, kind: effect.kind, synthesized: true },
          effect.startedAt,
          eventId
        );
      }

      if (hasAmbiguous) {
        const updatedRun: WorkflowRun = Object.freeze({
          ...run,
          effects: Object.freeze(updatedEffects),
          recoveryEvents: recoveryProjection.entries,
          recoveryEventsTotal: recoveryProjection.total,
          recoveryEventsDropped: recoveryProjection.dropped,
          history: historyProjection.entries,
          historyTotal: historyProjection.total,
          historyDropped: historyProjection.dropped,
        });
        newRuns.set(runId, updatedRun);
      }
    }

    this.runs = newRuns;
    this.diagnostics = localDiagnostics;
    // Post-commit notification: reconstruction replaced active-branch state.
    // Observers repaint from the new authoritative map (idempotent).
    this.notifyMutations();

    return {
      runs: Array.from(this.runs.values()),
      diagnostics: this.getDiagnostics(),
    };
  }

  /**
   * Refreshes run state from the currently bound session.
   */
  refresh(options: ReconstructOptions = {}): { runs: WorkflowRun[]; diagnostics: WorkflowRunDiagnostic[] } {
    return this.reconstructFromSession(undefined, options);
  }

  private persistEntry(data: ReturnType<typeof buildMutationEntryData>): void {
    if (!this.sessionTarget) return;

    if (typeof this.sessionTarget.appendCustomEntry === "function") {
      try {
        this.sessionTarget.appendCustomEntry(WORKFLOW_RUN_ENTRY_TYPE, data);
      } catch (err: unknown) {
        if (err instanceof WorkflowPersistenceError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new WorkflowPersistenceError(`Failed to persist session entry: ${msg}`, { runId: data.runId });
      }
    } else if (typeof this.sessionTarget.appendEntry === "function") {
      try {
        this.sessionTarget.appendEntry(WORKFLOW_RUN_ENTRY_TYPE, data);
      } catch (err: unknown) {
        if (err instanceof WorkflowPersistenceError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new WorkflowPersistenceError(`Failed to persist session entry: ${msg}`, { runId: data.runId });
      }
    } else {
      throw new WorkflowPersistenceError(
        `Bound sessionTarget does not implement appendCustomEntry or appendEntry`,
        { runId: data.runId }
      );
    }
  }
}
