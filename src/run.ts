/**
 * WorkflowRun runtime model, lifecycle state machine, and transitions.
 */

import { randomUUID } from "node:crypto";
import {
  validateBlockerInfo,
  validateCompletionClaim,
  validateCompletionInfo,
  validateRunData,
  validateRunId,
  validateStepName,
  validateVerificationFindings,
} from "./data-bounds.ts";
import { MAX_VERIFICATION_ATTEMPTS_DEFAULT } from "./constants.ts";
import { isWorkflowSnapshot, deepFreeze } from "./snapshot.ts";
import {
  type BlockRunOptions,
  type CancelRunOptions,
  type ClaimCompletionOptions,
  type CompleteRunOptions,
  type JsonValue,
  type PauseRunOptions,
  type ResumeRunOptions,
  type TransitionStepOptions,
  type UpdateRunOptions,
  type VerifyCompletionOptions,
  type WorkflowBlockerInfo,
  type WorkflowBudgetPolicy,
  type WorkflowCompletionInfo,
  WorkflowInvalidTransitionError,
  type WorkflowRun,
  WorkflowRunError,
  type WorkflowRunLifecycle,
  type WorkflowSnapshotV1,
} from "./types.ts";

/**
 * Checks whether a run lifecycle state is terminal (no further transitions permitted).
 */
export function isTerminalLifecycle(lifecycle: WorkflowRunLifecycle): boolean {
  return lifecycle === "completed" || lifecycle === "cancelled";
}

/**
 * Generate a cryptographically unique stable run ID.
 */
export function generateRunId(workflowName: string): string {
  const safeName = workflowName.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
  const time = Date.now().toString(36);
  const rand = randomUUID().replace(/-/g, "").slice(0, 8);
  return `wfrun-${safeName}-${time}-${rand}`;
}

export interface CreateRunParams {
  id?: string;
  snapshot: WorkflowSnapshotV1;
  initialStep?: string;
  initialData?: Record<string, JsonValue>;
  budget?: WorkflowBudgetPolicy;
  loopTaskId?: string;
  createdAt?: number;
}

export interface BudgetExhaustionCheck {
  exhausted: boolean;
  dimension?: "turns" | "duration" | "attempts";
  limit?: number;
  actual?: number;
  reason?: string;
}

/**
 * Checks whether any enforceable hard budget (turns, duration, attempts) is exhausted.
 */
export function checkRunBudgetExhaustion(run: WorkflowRun, now: number = Date.now()): BudgetExhaustionCheck {
  const budget = run.budget ?? run.snapshot.budget;
  if (!budget) {
    return { exhausted: false };
  }

  // 1. Turns budget
  if (budget.maxTurns !== undefined && budget.maxTurns > 0) {
    if (run.turns >= budget.maxTurns) {
      return {
        exhausted: true,
        dimension: "turns",
        limit: budget.maxTurns,
        actual: run.turns,
        reason: `Budget exhausted: maximum turns limit of ${budget.maxTurns} reached (turns: ${run.turns}).`,
      };
    }
  }

  // 2. Wall-clock duration budget
  const maxDurationMs = budget.maxDurationMs;
  if (maxDurationMs !== undefined && maxDurationMs > 0) {
    const elapsed = Math.max(0, now - (run.startedAt ?? run.createdAt));
    if (elapsed >= maxDurationMs) {
      return {
        exhausted: true,
        dimension: "duration",
        limit: maxDurationMs,
        actual: elapsed,
        reason: `Budget exhausted: maximum duration of ${budget.maxDuration ?? `${maxDurationMs}ms`} reached (elapsed: ${elapsed}ms >= ${maxDurationMs}ms).`,
      };
    }
  }

  // 3. Attempts budget
  if (budget.maxAttempts !== undefined && budget.maxAttempts > 0) {
    if (run.attempts >= budget.maxAttempts) {
      return {
        exhausted: true,
        dimension: "attempts",
        limit: budget.maxAttempts,
        actual: run.attempts,
        reason: `Budget exhausted: maximum attempts limit of ${budget.maxAttempts} reached (attempts: ${run.attempts}).`,
      };
    }
  }

  return { exhausted: false };
}

/**
 * Creates an immutable, valid WorkflowRun instance initialized to "active" state.
 */
export function createWorkflowRun(params: CreateRunParams): WorkflowRun {
  if (!isWorkflowSnapshot(params.snapshot)) {
    throw new WorkflowRunError("Cannot create workflow run without a valid WorkflowSnapshotV1");
  }

  const id = params.id ? validateRunId(params.id) : generateRunId(params.snapshot.name);
  const now = params.createdAt ?? Date.now();
  const step = params.initialStep ? validateStepName(params.initialStep, { runId: id }) : "INITIAL";
  const data = validateRunData(params.initialData, { runId: id });

  const frozenSnapshot = Object.isFrozen(params.snapshot)
    ? params.snapshot
    : deepFreeze(params.snapshot);

  const run: WorkflowRun = {
    id,
    workflow: params.snapshot.name,
    definitionVersion: params.snapshot.schemaVersion,
    definitionSource: params.snapshot.source.path,
    snapshot: frozenSnapshot,
    ...(params.budget ? { budget: Object.freeze({ ...params.budget }) } : {}),
    lifecycle: "active",
    step,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    loopTaskId: params.loopTaskId,
    attempts: 0,
    turns: 0,
    verificationAttempts: 0,
    data: Object.freeze({ ...data }),
  };

  return Object.freeze(run);
}

/**
 * Apply an update mutation to an existing run.
 */
export function applyRunUpdate(current: WorkflowRun, options: UpdateRunOptions): WorkflowRun {
  if (isTerminalLifecycle(current.lifecycle)) {
    throw new WorkflowInvalidTransitionError(
      current.id,
      `Cannot update run "${current.id}" because it is in terminal state "${current.lifecycle}"`,
      { fromLifecycle: current.lifecycle, action: "update" }
    );
  }

  const now = options.updatedAt ?? Date.now();
  const step = options.step !== undefined ? validateStepName(options.step, { runId: current.id }) : current.step;

  let mergedData = current.data;
  if (options.data !== undefined) {
    const updateData = validateRunData(options.data, { runId: current.id });
    mergedData = Object.freeze({
      ...current.data,
      ...updateData,
    });
    // Ensure merged data stays within byte bounds
    validateRunData(mergedData, { runId: current.id });
  }

  let attempts = current.attempts;
  if (options.attempts !== undefined) {
    if (!Number.isInteger(options.attempts) || options.attempts < 0) {
      throw new WorkflowRunError(`Attempts must be a non-negative integer, got ${options.attempts}`, current.id);
    }
    attempts = options.attempts;
  } else if (options.incrementAttempts !== undefined) {
    if (!Number.isInteger(options.incrementAttempts) || options.incrementAttempts < 0) {
      throw new WorkflowRunError(
        `Increment attempts must be a non-negative integer, got ${options.incrementAttempts}`,
        current.id
      );
    }
    attempts += options.incrementAttempts;
  }

  let turns = current.turns;
  if (options.turns !== undefined) {
    if (!Number.isInteger(options.turns) || options.turns < 0) {
      throw new WorkflowRunError(`Turns must be a non-negative integer, got ${options.turns}`, current.id);
    }
    turns = options.turns;
  } else if (options.incrementTurns !== undefined) {
    if (!Number.isInteger(options.incrementTurns) || options.incrementTurns < 0) {
      throw new WorkflowRunError(
        `Increment turns must be a non-negative integer, got ${options.incrementTurns}`,
        current.id
      );
    }
    turns += options.incrementTurns;
  }

  const loopTaskId =
    options.loopTaskId === null || options.loopTaskId === ""
      ? undefined
      : options.loopTaskId !== undefined
      ? options.loopTaskId
      : current.loopTaskId;

  return Object.freeze({
    ...current,
    step,
    data: mergedData,
    attempts,
    turns,
    loopTaskId,
    updatedAt: Math.max(now, current.updatedAt),
  });
}

/**
 * Apply a step transition mutation.
 */
export function applyStepTransition(current: WorkflowRun, options: TransitionStepOptions): WorkflowRun {
  if (current.lifecycle !== "active") {
    throw new WorkflowInvalidTransitionError(
      current.id,
      `Cannot transition step from lifecycle "${current.lifecycle}". Run must be "active" to advance steps.`,
      { fromLifecycle: current.lifecycle, action: "transition" }
    );
  }

  const toStep = validateStepName(options.toStep, { runId: current.id });
  const now = options.updatedAt ?? Date.now();

  let mergedData = current.data;
  if (options.data !== undefined) {
    const patch = validateRunData(options.data, { runId: current.id });
    mergedData = Object.freeze({
      ...current.data,
      ...patch,
    });
    validateRunData(mergedData, { runId: current.id });
  }

  return Object.freeze({
    ...current,
    step: toStep,
    data: mergedData,
    updatedAt: Math.max(now, current.updatedAt),
  });
}

/**
 * Transition run to "blocked" lifecycle.
 */
export function applyBlockRun(current: WorkflowRun, options: BlockRunOptions): WorkflowRun {
  if (current.lifecycle !== "active" && current.lifecycle !== "verifying") {
    throw new WorkflowInvalidTransitionError(
      current.id,
      `Cannot block run in lifecycle "${current.lifecycle}". Only active/verifying runs can be blocked.`,
      { fromLifecycle: current.lifecycle, toLifecycle: "blocked", action: "block" }
    );
  }

  const now = options.blockedAt ?? Date.now();
  const blocker = validateBlockerInfo(
    {
      reason: options.reason,
      category: options.category,
      requiresHuman: options.requiresHuman,
      retryDelayMs: options.retryDelayMs,
      blockedAt: now,
    },
    { runId: current.id }
  );

  let mergedData = current.data;
  if (options.data !== undefined) {
    const patch = validateRunData(options.data, { runId: current.id });
    mergedData = Object.freeze({
      ...current.data,
      ...patch,
    });
    validateRunData(mergedData, { runId: current.id });
  }

  return Object.freeze({
    ...current,
    lifecycle: "blocked",
    blocker: Object.freeze(blocker),
    data: mergedData,
    updatedAt: Math.max(now, current.updatedAt),
  });
}

/**
 * Transition run to "paused" lifecycle.
 */
export function applyPauseRun(current: WorkflowRun, options: PauseRunOptions = {}): WorkflowRun {
  if (current.lifecycle !== "active" && current.lifecycle !== "verifying") {
    throw new WorkflowInvalidTransitionError(
      current.id,
      `Cannot pause run in lifecycle "${current.lifecycle}". Only "active" or "verifying" runs can be paused.`,
      { fromLifecycle: current.lifecycle, toLifecycle: "paused", action: "pause" }
    );
  }

  const now = options.pausedAt ?? Date.now();

  let mergedData = current.data;
  if (options.data !== undefined) {
    const patch = validateRunData(options.data, { runId: current.id });
    mergedData = Object.freeze({
      ...current.data,
      ...patch,
    });
    validateRunData(mergedData, { runId: current.id });
  }

  return Object.freeze({
    ...current,
    lifecycle: "paused",
    data: mergedData,
    updatedAt: Math.max(now, current.updatedAt),
  });
}

/**
 * Record a completion claim and transition to verifying lifecycle and VERIFYING step.
 */
export function applyClaimCompletion(current: WorkflowRun, options: ClaimCompletionOptions): WorkflowRun {
  if (current.lifecycle !== "active") {
    throw new WorkflowInvalidTransitionError(
      current.id,
      `Cannot claim completion on run in lifecycle "${current.lifecycle}". Run must be "active" to submit a completion claim.`,
      { fromLifecycle: current.lifecycle, toLifecycle: "verifying", action: "claim" }
    );
  }

  const now = options.submittedAt ?? Date.now();
  const claim = validateCompletionClaim(
    {
      summary: options.summary,
      evidence: options.evidence ?? [],
      submittedAt: now,
      claimId: options.claimId,
    },
    { runId: current.id }
  );

  let mergedData = current.data;
  if (options.data !== undefined) {
    const patch = validateRunData(options.data, { runId: current.id });
    mergedData = Object.freeze({
      ...current.data,
      ...patch,
    });
    validateRunData(mergedData, { runId: current.id });
  }

  return Object.freeze({
    ...current,
    lifecycle: "verifying",
    step: "VERIFYING",
    completionClaim: Object.freeze(claim),
    data: Object.freeze({
      ...mergedData,
      _verificationRequested: true,
      _pendingCompletionSummary: claim.summary,
      _preVerificationStep: current.step,
    }),
    updatedAt: Math.max(now, current.updatedAt),
  });
}

/**
 * Record a verification decision and findings on a completion claim.
 */
export function applyVerifyRun(current: WorkflowRun, options: VerifyCompletionOptions): WorkflowRun {
  if (current.lifecycle !== "verifying") {
    throw new WorkflowInvalidTransitionError(
      current.id,
      `Cannot verify run in lifecycle "${current.lifecycle}". Run must be in "verifying" lifecycle to evaluate a completion claim.`,
      { fromLifecycle: current.lifecycle, action: "verify" }
    );
  }

  const now = options.verifiedAt ?? Date.now();
  const attempt = (current.verificationAttempts ?? 0) + 1;
  const findings = validateVerificationFindings(
    {
      decision: options.decision,
      feedback: options.feedback ?? options.findings,
      checks: options.checks,
      returnStep: options.returnStep,
      verifiedAt: now,
      attempt,
    },
    { runId: current.id }
  );

  let mergedData = current.data;
  if (options.data !== undefined) {
    const patch = validateRunData(options.data, { runId: current.id });
    mergedData = Object.freeze({
      ...current.data,
      ...patch,
    });
    validateRunData(mergedData, { runId: current.id });
  }

  if (findings.decision === "accepted") {
    const completionSummary = current.completionClaim?.summary ?? findings.feedback ?? "Completed and verified";
    const completionEvidence = current.completionClaim?.evidence ?? [];
    const completion: WorkflowCompletionInfo = validateCompletionInfo(
      {
        summary: completionSummary,
        evidence: completionEvidence,
        completedAt: now,
      },
      { runId: current.id }
    );

    return Object.freeze({
      ...current,
      lifecycle: "completed",
      step: "COMPLETED",
      completion: Object.freeze(completion),
      verificationFindings: Object.freeze(findings),
      verificationAttempts: attempt,
      data: mergedData,
      updatedAt: Math.max(now, current.updatedAt),
      completedAt: now,
    });
  }

  // decision === "rejected"
  const maxAttempts = current.snapshot.completion?.maxVerificationAttempts ?? MAX_VERIFICATION_ATTEMPTS_DEFAULT;
  if (attempt >= maxAttempts) {
    // Exceeded allowed verification attempts
    const reason = `Verification rejected (attempt ${attempt}/${maxAttempts}): ${findings.feedback ?? "Verification criteria not met."}`;
    if (current.snapshot.completion?.onRejectionExhausted === "fail") {
      return Object.freeze({
        ...current,
        lifecycle: "cancelled",
        verificationFindings: Object.freeze(findings),
        verificationAttempts: attempt,
        data: mergedData,
        updatedAt: Math.max(now, current.updatedAt),
        completedAt: now,
      });
    }

    const blocker = validateBlockerInfo(
      {
        reason,
        category: "human-required",
        requiresHuman: true,
        blockedAt: now,
      },
      { runId: current.id }
    );

    return Object.freeze({
      ...current,
      lifecycle: "blocked",
      blocker: Object.freeze(blocker),
      verificationFindings: Object.freeze(findings),
      verificationAttempts: attempt,
      data: mergedData,
      updatedAt: Math.max(now, current.updatedAt),
    });
  }

  // Rejection with retries remaining: return run to configured step in active lifecycle
  const returnStep =
    findings.returnStep ??
    options.returnStep ??
    current.snapshot.completion?.returnStep ??
    (typeof current.data._preVerificationStep === "string" ? current.data._preVerificationStep : "INITIAL");

  const cleanedData: Record<string, JsonValue> = {
    ...mergedData,
    _lastVerificationFindings: {
      decision: findings.decision,
      feedback: findings.feedback ?? "",
      attempt: findings.attempt,
      verifiedAt: findings.verifiedAt,
    },
  };
  delete cleanedData._verificationRequested;

  return Object.freeze({
    ...current,
    lifecycle: "active",
    step: returnStep,
    verificationFindings: Object.freeze(findings),
    verificationAttempts: attempt,
    data: Object.freeze(cleanedData),
    updatedAt: Math.max(now, current.updatedAt),
  });
}

/**
 * Transition run from "paused" or "blocked" back to "active".
 */
export function applyResumeRun(current: WorkflowRun, options: ResumeRunOptions = {}): WorkflowRun {
  if (current.lifecycle !== "paused" && current.lifecycle !== "blocked") {
    throw new WorkflowInvalidTransitionError(
      current.id,
      `Cannot resume run in lifecycle "${current.lifecycle}". Run must be "paused" or "blocked" to resume.`,
      { fromLifecycle: current.lifecycle, toLifecycle: "active", action: "resume" }
    );
  }

  const now = options.resumedAt ?? Date.now();
  const step = options.step !== undefined ? validateStepName(options.step, { runId: current.id }) : current.step;

  let mergedData = current.data;
  if (options.data !== undefined) {
    const patch = validateRunData(options.data, { runId: current.id });
    mergedData = Object.freeze({
      ...current.data,
      ...patch,
    });
    validateRunData(mergedData, { runId: current.id });
  }

  return Object.freeze({
    ...current,
    lifecycle: "active",
    step,
    blocker: undefined, // Clear blocker upon resume
    data: mergedData,
    updatedAt: Math.max(now, current.updatedAt),
  });
}

/**
 * Transition run to "completed" (terminal).
 */
export function applyCompleteRun(current: WorkflowRun, options: CompleteRunOptions): WorkflowRun {
  if (isTerminalLifecycle(current.lifecycle)) {
    throw new WorkflowInvalidTransitionError(
      current.id,
      `Cannot complete run "${current.id}" because it is already in terminal state "${current.lifecycle}"`,
      { fromLifecycle: current.lifecycle, toLifecycle: "completed", action: "complete" }
    );
  }

  if (current.lifecycle === "paused") {
    throw new WorkflowInvalidTransitionError(
      current.id,
      `Cannot complete paused run "${current.id}". Resume the run before completing it.`,
      { fromLifecycle: current.lifecycle, toLifecycle: "completed", action: "complete" }
    );
  }

  const now = options.completedAt ?? Date.now();
  const completion = validateCompletionInfo(
    {
      summary: options.summary,
      evidence: options.evidence ?? [],
      completedAt: now,
    },
    { runId: current.id }
  );

  let mergedData = current.data;
  if (options.data !== undefined) {
    const patch = validateRunData(options.data, { runId: current.id });
    mergedData = Object.freeze({
      ...current.data,
      ...patch,
    });
    validateRunData(mergedData, { runId: current.id });
  }

  return Object.freeze({
    ...current,
    lifecycle: "completed",
    completion: Object.freeze(completion),
    blocker: undefined,
    data: mergedData,
    updatedAt: Math.max(now, current.updatedAt),
    completedAt: now,
  });
}

/**
 * Transition run to "cancelled" (terminal).
 */
export function applyCancelRun(current: WorkflowRun, options: CancelRunOptions = {}): WorkflowRun {
  if (isTerminalLifecycle(current.lifecycle)) {
    throw new WorkflowInvalidTransitionError(
      current.id,
      `Cannot cancel run "${current.id}" because it is already in terminal state "${current.lifecycle}"`,
      { fromLifecycle: current.lifecycle, toLifecycle: "cancelled", action: "cancel" }
    );
  }

  const now = options.cancelledAt ?? Date.now();

  let mergedData = current.data;
  if (options.data !== undefined) {
    const patch = validateRunData(options.data, { runId: current.id });
    mergedData = Object.freeze({
      ...current.data,
      ...patch,
    });
    validateRunData(mergedData, { runId: current.id });
  }

  return Object.freeze({
    ...current,
    lifecycle: "cancelled",
    blocker: undefined,
    data: mergedData,
    updatedAt: Math.max(now, current.updatedAt),
    completedAt: now,
  });
}
