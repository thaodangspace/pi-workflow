/**
 * Authoritative runtime registry for workflow executions.
 * Manages run lifecycles, concurrency policies, JSON bounds, and append-only session persistence.
 */

import { WORKFLOW_RUN_ENTRY_TYPE } from "./constants.ts";
import { validateRunId } from "./data-bounds.ts";
import {
  applyBlockRun,
  applyCancelRun,
  applyClaimCompletion,
  applyCompleteRun,
  applyPauseRun,
  applyResumeRun,
  applyRunUpdate,
  applyStepTransition,
  applyVerifyRun,
  createWorkflowRun,
  isTerminalLifecycle,
} from "./run.ts";
import {
  buildMutationEntryData,
  parseSessionMutationEntry,
} from "./session-entries.ts";
import { createWorkflowSnapshot, isWorkflowSnapshot } from "./snapshot.ts";
import {
  type BlockRunOptions,
  type CancelRunOptions,
  type ClaimCompletionOptions,
  type CompleteRunOptions,
  type CreateRunOptions,
  type PauseRunOptions,
  type ReconstructOptions,
  type ResumeRunOptions,
  type TransitionStepOptions,
  type UpdateRunOptions,
  type VerifyCompletionOptions,
  WorkflowConcurrencyError,
  type WorkflowDefinitionV1,
  WorkflowInvalidTransitionError,
  WorkflowPersistenceError,
  type WorkflowRun,
  WorkflowRunError,
  type WorkflowRunDiagnostic,
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

  constructor(sessionTarget?: WorkflowSessionTarget) {
    this.sessionTarget = sessionTarget;
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
    this.runs.set(run.id, run);

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
    this.runs.set(runId, updated);
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
    this.runs.set(runId, updated);
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
    this.runs.set(runId, updated);
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
    this.runs.set(runId, updated);
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
    this.runs.set(runId, updated);
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
    this.runs.set(runId, updated);
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
    this.runs.set(runId, updated);
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
    this.runs.set(runId, updated);
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
    this.runs.set(runId, updated);
    return updated;
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

    this.runs = newRuns;
    this.diagnostics = localDiagnostics;

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
