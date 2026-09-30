/**
 * WorkflowRun runtime model, lifecycle state machine, and transitions.
 */

import { randomUUID } from "node:crypto";
import {
  validateBlockerInfo,
  validateCompletionInfo,
  validateRunData,
  validateRunId,
  validateStepName,
} from "./data-bounds.ts";
import { isWorkflowSnapshot, deepFreeze } from "./snapshot.ts";
import {
  type BlockRunOptions,
  type CancelRunOptions,
  type CompleteRunOptions,
  type JsonValue,
  type PauseRunOptions,
  type ResumeRunOptions,
  type TransitionStepOptions,
  type UpdateRunOptions,
  type WorkflowBlockerInfo,
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
  loopTaskId?: string;
  createdAt?: number;
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
    lifecycle: "active",
    step,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    loopTaskId: params.loopTaskId,
    attempts: 0,
    turns: 0,
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

  const loopTaskId = options.loopTaskId !== undefined ? options.loopTaskId : current.loopTaskId;

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
  if (current.lifecycle !== "active") {
    throw new WorkflowInvalidTransitionError(
      current.id,
      `Cannot block run in lifecycle "${current.lifecycle}". Only "active" runs can be blocked.`,
      { fromLifecycle: current.lifecycle, toLifecycle: "blocked", action: "block" }
    );
  }

  const now = options.blockedAt ?? Date.now();
  const blocker = validateBlockerInfo(
    {
      reason: options.reason,
      requiresHuman: options.requiresHuman,
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
  if (current.lifecycle !== "active") {
    throw new WorkflowInvalidTransitionError(
      current.id,
      `Cannot pause run in lifecycle "${current.lifecycle}". Only "active" runs can be paused.`,
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
