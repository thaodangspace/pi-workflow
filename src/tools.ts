/**
 * Model-callable workflow tools:
 * - workflow_get_context
 * - workflow_transition
 * - workflow_continue
 * - workflow_block
 * - workflow_complete
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_RETRYABLE_BLOCKER_DELAY_MS,
  MAX_VERIFICATION_ATTEMPTS_DEFAULT,
} from "./constants.ts";
import {
  validateBlockerInfo,
  validateCompletionClaim,
  validateCompletionInfo,
  validateRunData,
  validateStepName,
  validateVerificationFindings,
} from "./data-bounds.ts";
import type { WorkflowDispatcher } from "./dispatcher.ts";
import { resolveWakeupDelay } from "./dispatcher.ts";
import { formatDuration, parseDuration } from "./duration.ts";
import type { WorkflowRunRegistry } from "./registry.ts";
import { checkRunBudgetExhaustion, getAmbiguousEffects, hasAmbiguousEffects } from "./run.ts";
import {
  type BlockerCategory,
  type JsonValue,
  type WorkflowBlockerInfo,
  type WorkflowCompletionClaim,
  type WorkflowCompletionInfo,
  type WorkflowEffect,
  type WorkflowVerificationFindings,
  WorkflowAmbiguousEffectError,
  WorkflowBudgetExhaustedError,
  WorkflowEffectAlreadyCommittedError,
  WorkflowEffectError,
  WorkflowInvalidTransitionError,
  WorkflowIterationError,
  type WorkflowRunLifecycle,
  WorkflowRunError,
} from "./types.ts";

export interface WorkflowEffectBeginDetails {
  status: "started" | "already_committed";
  key: string;
  kind?: string;
  effect?: Readonly<WorkflowEffect>;
}

export interface WorkflowEffectCommitDetails {
  status: "committed";
  key: string;
  effect?: Readonly<WorkflowEffect>;
}

export interface WorkflowEffectReconcileDetails {
  status: "committed" | "aborted" | "retryable";
  key: string;
  reason: string;
  effect?: Readonly<WorkflowEffect>;
}

export interface WorkflowCompleteDetails {
  runId: string;
  lifecycle: WorkflowRunLifecycle;
  step: string;
  status: "completed" | "verifying" | "blocked" | "rejected";
  pendingSummary?: string;
  completion?: Readonly<WorkflowCompletionInfo>;
  blocker?: Readonly<WorkflowBlockerInfo>;
  verificationFindings?: Readonly<WorkflowVerificationFindings>;
  data?: Readonly<Record<string, JsonValue>>;
}

export interface WorkflowVerifyDetails {
  runId: string;
  status: "completed" | "blocked" | "rejected";
  lifecycle: WorkflowRunLifecycle;
  step: string;
  completion?: Readonly<WorkflowCompletionInfo>;
  blocker?: Readonly<WorkflowBlockerInfo>;
  verificationFindings?: Readonly<WorkflowVerificationFindings>;
  data?: Readonly<Record<string, JsonValue>>;
}

/**
 * Creates the workflow_get_context tool.
 */
export function createWorkflowGetContextTool(
  dispatcher: WorkflowDispatcher,
  _registry: WorkflowRunRegistry
): ToolDefinition {
  return defineTool({
    name: "workflow_get_context",
    label: "Workflow Get Context",
    description:
      "Inspect the current workflow execution context, including lifecycle state, active step, durable run data, remaining budget limits, definition metadata, and capability availability.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const binding = dispatcher.assertToolBinding(signal);
      const token = binding.token;
      const generation = binding.generation;

      const context = dispatcher.getIterationContext(binding);

      dispatcher.assertToolBinding(signal, token, generation);

      const summaryText = [
        `Workflow: ${context.workflow} (Run ID: ${context.runId})`,
        `Lifecycle: ${context.lifecycle} | Step: ${context.step}`,
        `Turns: ${context.turns}${context.budget.maxTurns ? ` / ${context.budget.maxTurns}` : ""}${
          context.budget.turnsRemaining !== undefined ? ` (${context.budget.turnsRemaining} remaining)` : ""
        }`,
        `Attempts: ${context.attempts}${context.budget.maxAttempts ? ` / ${context.budget.maxAttempts}` : ""}`,
        `Data: ${JSON.stringify(context.data)}`,
      ].join("\n");

      return {
        content: [{ type: "text", text: summaryText }],
        details: context,
      };
    },
  });
}

/**
 * Creates the workflow_transition tool.
 */
export function createWorkflowTransitionTool(
  dispatcher: WorkflowDispatcher,
  registry: WorkflowRunRegistry
): ToolDefinition {
  return defineTool({
    name: "workflow_transition",
    label: "Workflow Transition",
    description:
      "Atomically advance the workflow to a new step, optionally updating durable run data and recording an audit note.",
    parameters: Type.Object({
      toStep: Type.String({ description: "Target workflow step name (e.g. IMPLEMENTING, REVIEWING, DEPLOYED)" }),
      data: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Optional key-value state updates to merge into durable run data",
        })
      ),
      reason: Type.Optional(Type.String({ description: "Optional explanation or audit note for this transition" })),
    }),
    async execute(_toolCallId, params, signal) {
      const binding = dispatcher.assertToolBinding(signal);
      const token = binding.token;
      const generation = binding.generation;

      // Validate inputs
      const validatedStep = validateStepName(params.toStep, { runId: binding.runId });
      const validatedData =
        params.data !== undefined
          ? validateRunData(params.data as Record<string, JsonValue>, { runId: binding.runId })
          : undefined;

      // Verify binding is still current before mutating
      dispatcher.assertToolBinding(signal, token, generation);

      const run = registry.requireRun(binding.runId);
      if (run.lifecycle !== "active") {
        throw new WorkflowInvalidTransitionError(
          run.id,
          `Cannot transition step from lifecycle "${run.lifecycle}". Run must be "active" to advance steps.`,
          { fromLifecycle: run.lifecycle, action: "transition" }
        );
      }

      if (hasAmbiguousEffects(run)) {
        const ambiguous = getAmbiguousEffects(run);
        throw new WorkflowAmbiguousEffectError(
          `Cannot transition step while run "${run.id}" has ambiguous external effect "${ambiguous[0].key}" (${ambiguous[0].kind}). Reconcile pending effects first with workflow_effect_commit or workflow_effect_reconcile.`,
          { runId: run.id, ambiguousKey: ambiguous[0].key }
        );
      }

      const updated = registry.transitionStep(binding.runId, {
        toStep: validatedStep,
        data: validatedData,
        reason: params.reason,
      });

      // Verify binding is still current after mutating
      dispatcher.assertToolBinding(signal, token, generation);

      return {
        content: [
          {
            type: "text",
            text: `Transitioned workflow "${run.workflow}" step from "${run.step}" to "${updated.step}".`,
          },
        ],
        details: {
          runId: updated.id,
          fromStep: run.step,
          toStep: updated.step,
          reason: params.reason,
          data: updated.data,
        },
      };
    },
  });
}

/**
 * Creates the workflow_continue tool.
 */
export function createWorkflowContinueTool(
  dispatcher: WorkflowDispatcher,
  registry: WorkflowRunRegistry
): ToolDefinition {
  return defineTool({
    name: "workflow_continue",
    label: "Workflow Continue",
    description:
      "Request the next scheduled wakeup iteration for the current workflow run using a named wakeup policy, explicit bounded delay, or default delay.",
    parameters: Type.Object({
      delay: Type.Optional(Type.String({ description: "Optional explicit delay duration (e.g. '30s', '5m', '1h')" })),
      delayMs: Type.Optional(Type.Number({ description: "Optional explicit delay duration in milliseconds" })),
      wakeupName: Type.Optional(
        Type.String({ description: "Optional named wakeup policy from definition (e.g. 'idle', 'retry')" })
      ),
      reason: Type.Optional(Type.String({ description: "Optional reason for scheduling next wakeup" })),
    }),
    async execute(_toolCallId, params, signal) {
      const binding = dispatcher.assertToolBinding(signal);
      const token = binding.token;
      const generation = binding.generation;

      const run = registry.requireRun(binding.runId);
      if (run.lifecycle !== "active") {
        throw new WorkflowInvalidTransitionError(
          run.id,
          `Cannot continue scheduling a workflow run in lifecycle "${run.lifecycle}". Run must be "active".`,
          { fromLifecycle: run.lifecycle, action: "continue" }
        );
      }

      // Check hard budget limits before scheduling follow-up
      const exhaustion = checkRunBudgetExhaustion(run);
      if (exhaustion.exhausted) {
        if (binding.schedulerPort?.cancelWakeup) {
          await binding.schedulerPort.cancelWakeup(run.id);
        }
        const budgetPolicy = run.budget ?? run.snapshot.budget;
        if (budgetPolicy?.onExhaustion === "cancel") {
          registry.cancelRun(run.id, { reason: exhaustion.reason });
        } else {
          registry.blockRun(run.id, {
            reason: exhaustion.reason!,
            category: "human-required",
            requiresHuman: true,
          });
        }
        dispatcher.assertToolBinding(signal, token, generation);
        throw new WorkflowBudgetExhaustedError(
          exhaustion.reason!,
          { runId: run.id, dimension: exhaustion.dimension, limit: exhaustion.limit, actual: exhaustion.actual }
        );
      }

      if (!binding.schedulerPort) {
        throw new WorkflowRunError(
          `No scheduler port is configured for workflow iteration continue on run "${run.id}".`,
          run.id
        );
      }

      const resolved = resolveWakeupDelay({
        delay: params.delay,
        delayMs: params.delayMs,
        wakeupName: params.wakeupName,
        policy: run.snapshot.wakeups,
      });

      dispatcher.assertToolBinding(signal, token, generation);

      await binding.schedulerPort.scheduleWakeup({
        runId: run.id,
        delayMs: resolved.delayMs,
        reason: params.reason,
      });

      dispatcher.assertToolBinding(signal, token, generation);

      const note = resolved.isClamped
        ? ` (clamped from ${formatDuration(resolved.originalDelayMs)} by policy bounds)`
        : "";

      return {
        content: [
          {
            type: "text",
            text: `Scheduled next iteration for workflow "${run.workflow}" in ${resolved.delayString}${note} (source: ${resolved.source}).`,
          },
        ],
        details: {
          runId: run.id,
          delayMs: resolved.delayMs,
          delay: resolved.delayString,
          source: resolved.source,
          isClamped: resolved.isClamped,
          reason: params.reason,
        },
      };
    },
  });
}

/**
 * Creates the workflow_block tool.
 */
export function createWorkflowBlockTool(
  dispatcher: WorkflowDispatcher,
  registry: WorkflowRunRegistry
): ToolDefinition {
  return defineTool({
    name: "workflow_block",
    label: "Workflow Block",
    description:
      "Move the workflow run into a blocked state due to external prerequisites, missing resources, or conditions requiring human intervention.",
    parameters: Type.Object({
      reason: Type.String({ description: "Concrete explanation of why the workflow run is blocked" }),
      requiresHuman: Type.Optional(
        Type.Boolean({ description: "Whether human intervention is required to unblock the run (default: false)" })
      ),
      category: Type.Optional(
        Type.Union([
          Type.Literal("external-retryable"),
          Type.Literal("human-required"),
          Type.Literal("terminal"),
        ], {
          description:
            "Blocker category: 'external-retryable' (may wake conservatively to recheck), 'human-required' (stops automatic wakeups), or 'terminal' (no further autonomous progress)",
        })
      ),
      retryDelay: Type.Optional(
        Type.String({ description: "Optional conservative retry delay duration for external-retryable blocker (e.g. '15m')" })
      ),
      data: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Optional state updates to merge into durable run data",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const binding = dispatcher.assertToolBinding(signal);
      const token = binding.token;
      const generation = binding.generation;

      const validatedBlocker = validateBlockerInfo(
        {
          reason: params.reason,
          category: params.category,
          requiresHuman: params.requiresHuman,
        },
        { runId: binding.runId }
      );

      const validatedData =
        params.data !== undefined
          ? validateRunData(params.data as Record<string, JsonValue>, { runId: binding.runId })
          : undefined;

      dispatcher.assertToolBinding(signal, token, generation);

      const run = registry.requireRun(binding.runId);
      if (run.lifecycle === "completed" || run.lifecycle === "cancelled") {
        throw new WorkflowInvalidTransitionError(
          run.id,
          `Cannot block a terminal run (lifecycle: "${run.lifecycle}").`,
          { fromLifecycle: run.lifecycle, toLifecycle: "blocked", action: "block" }
        );
      }

      let retryDelayMs: number | undefined;
      if (validatedBlocker.category === "external-retryable") {
        if (params.retryDelay) {
          retryDelayMs = parseDuration(params.retryDelay, "retryDelay");
        } else if (run.snapshot.wakeups?.named?.retry) {
          retryDelayMs = parseDuration(run.snapshot.wakeups.named.retry, "wakeups.named.retry");
        } else if (run.snapshot.wakeups?.namedMs?.retry) {
          retryDelayMs = run.snapshot.wakeups.namedMs.retry;
        } else {
          retryDelayMs = DEFAULT_RETRYABLE_BLOCKER_DELAY_MS;
        }
      } else {
        // human-required or terminal: cancel any pending wakeup before blocking
        if (binding.schedulerPort?.cancelWakeup) {
          await binding.schedulerPort.cancelWakeup(binding.runId);
        }
      }

      const updated = registry.blockRun(binding.runId, {
        reason: validatedBlocker.reason,
        category: validatedBlocker.category,
        requiresHuman: validatedBlocker.requiresHuman,
        retryDelayMs,
        data: validatedData,
      });

      // Handle scheduler wakeup for external-retryable category
      if (validatedBlocker.category === "external-retryable" && retryDelayMs !== undefined && binding.schedulerPort) {
        try {
          await binding.schedulerPort.scheduleWakeup({
            runId: binding.runId,
            delayMs: retryDelayMs,
            reason: `Conservative retry for blocked run: ${updated.blocker?.reason}`,
          });
        } catch (scheduleErr: unknown) {
          // If scheduling retry wakeup fails, fail closed to human-required blocker
          const reason = `Failed to schedule conservative retry wakeup: ${scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr)}`;
          registry.blockRun(binding.runId, {
            reason,
            category: "human-required",
            requiresHuman: true,
          });
          dispatcher.assertToolBinding(signal, token, generation);
          throw new WorkflowRunError(reason, binding.runId);
        }
      }

      dispatcher.assertToolBinding(signal, token, generation);

      return {
        content: [
          {
            type: "text",
            text: `Workflow "${run.workflow}" is now blocked (${updated.blocker?.category}): ${updated.blocker?.reason}${
              updated.blocker?.requiresHuman ? " (requires human action)" : ""
            }.`,
          },
        ],
        details: {
          runId: updated.id,
          lifecycle: updated.lifecycle,
          step: updated.step,
          blocker: updated.blocker,
          data: updated.data,
        },
      };
    },
  });
}

/**
 * Creates the workflow_complete tool.
 */
export function createWorkflowCompleteTool(
  dispatcher: WorkflowDispatcher,
  registry: WorkflowRunRegistry
): ToolDefinition {
  return defineTool({
    name: "workflow_complete",
    label: "Workflow Complete",
    description:
      "Submit completion summary and structured evidence to complete the workflow run, or trigger the verification gate if required by definition policy.",
    parameters: Type.Object({
      summary: Type.String({ description: "Executive summary of completed work, outcomes, and deliverables" }),
      evidence: Type.Optional(
        Type.Array(
          Type.Object({
            type: Type.String({ description: "Evidence category (e.g. pr, commit, test, url, file)" }),
            description: Type.String({ description: "Human-readable description of evidence" }),
            url: Type.Optional(Type.String({ description: "URL if applicable" })),
            path: Type.Optional(Type.String({ description: "File path if applicable" })),
            data: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Structured metadata" })),
          }),
          { description: "Structured verification or outcome evidence items" }
        )
      ),
      data: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Optional final state updates to merge into durable run data",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const binding = dispatcher.assertToolBinding(signal);
      const token = binding.token;
      const generation = binding.generation;

      const run = registry.requireRun(binding.runId);
      if (run.lifecycle === "completed" || run.lifecycle === "cancelled") {
        throw new WorkflowInvalidTransitionError(
          run.id,
          `Cannot complete a run that is already in terminal lifecycle "${run.lifecycle}".`,
          { fromLifecycle: run.lifecycle, toLifecycle: "completed", action: "complete" }
        );
      }

      if (hasAmbiguousEffects(run)) {
        const ambiguous = getAmbiguousEffects(run);
        throw new WorkflowAmbiguousEffectError(
          `Cannot complete workflow while run "${run.id}" has ambiguous external effect "${ambiguous[0].key}". Reconcile pending effects first.`,
          { runId: run.id, ambiguousKey: ambiguous[0].key }
        );
      }

      // If the run is already in the verification phase, completeTool cannot bypass the gate!
      if (run.lifecycle === "verifying" || run.step === "VERIFYING" || run.data?._verificationRequested === true) {
        throw new WorkflowRunError(
          `Cannot submit completion claim: workflow "${run.workflow}" is currently in the verification phase (lifecycle: ${run.lifecycle}, step: ${run.step}). Authoritative verification decisions must be submitted via workflow_verify({ decision: "accept" | "reject" }).`,
          run.id
        );
      }

      if (run.lifecycle !== "active") {
        throw new WorkflowInvalidTransitionError(
          run.id,
          `Cannot submit completion claim on run in lifecycle "${run.lifecycle}". Run must be "active".`,
          { fromLifecycle: run.lifecycle, toLifecycle: "verifying", action: "claim" }
        );
      }

      if (!params.summary || params.summary.trim() === "") {
        throw new WorkflowRunError("Completion requires a non-empty summary.", run.id);
      }

      const validatedCompletion = validateCompletionInfo(
        {
          summary: params.summary,
          evidence: params.evidence,
        },
        { runId: binding.runId }
      );

      const validatedData =
        params.data !== undefined
          ? validateRunData(params.data as Record<string, JsonValue>, { runId: binding.runId })
          : undefined;

      const completionPolicy = run.snapshot.completion;
      if (
        completionPolicy?.requireEvidence &&
        (!validatedCompletion.evidence || validatedCompletion.evidence.length === 0)
      ) {
        throw new WorkflowRunError("Completion policy requires at least one evidence item.", run.id);
      }

      dispatcher.assertToolBinding(signal, token, generation);

      // Check if verification gate applies
      if (completionPolicy?.verify) {
        // Submit completion claim and transition to verification phase
        const verificationData: Record<string, JsonValue> = {
          ...(validatedData ?? {}),
          _verificationRequested: true,
          _pendingCompletionSummary: validatedCompletion.summary,
        };
        const updated = registry.claimCompletion(binding.runId, {
          summary: validatedCompletion.summary,
          evidence: validatedCompletion.evidence,
          data: verificationData,
        });

        if (binding.schedulerPort) {
          try {
            await binding.schedulerPort.scheduleWakeup({
              runId: binding.runId,
              delayMs: 1_000,
              reason: "Scheduled verification iteration for completion claim",
            });
          } catch (scheduleErr: unknown) {
            // Fail closed with actionable blocked state rather than leaving verifying run unscheduled
            const reason = `Failed to schedule verification iteration: ${scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr)}`;
            registry.blockRun(binding.runId, {
              reason,
              category: "human-required",
              requiresHuman: true,
            });
            dispatcher.assertToolBinding(signal, token, generation);
            throw new WorkflowRunError(reason, binding.runId);
          }
        }

        dispatcher.assertToolBinding(signal, token, generation);

        const details: WorkflowCompleteDetails = {
          runId: updated.id,
          lifecycle: updated.lifecycle,
          step: updated.step,
          status: "verifying",
          pendingSummary: validatedCompletion.summary,
          data: updated.data,
        };
        return {
          content: [
            {
              type: "text",
              text: `Workflow "${run.workflow}" entered verification phase (step: VERIFYING). Final completion requires verification confirmation.`,
            },
          ],
          details,
        };
      }

      // Direct completion without verification gate:
      // Safe ordering: cancel pending scheduler wakeups BEFORE committing terminal completed state
      if (binding.schedulerPort?.cancelWakeup) {
        await binding.schedulerPort.cancelWakeup(binding.runId);
      }

      const updated = registry.completeRun(binding.runId, {
        summary: validatedCompletion.summary,
        evidence: validatedCompletion.evidence,
        data: validatedData,
      });

      dispatcher.assertToolBinding(signal, token, generation);

      const details: WorkflowCompleteDetails = {
        runId: updated.id,
        lifecycle: updated.lifecycle,
        step: updated.step,
        status: "completed",
        completion: updated.completion,
        data: updated.data,
      };

      return {
        content: [
          {
            type: "text",
            text: `Workflow "${run.workflow}" completed successfully: ${updated.completion?.summary}`,
          },
        ],
        details,
      };
    },
  });
}

/**
 * Creates the workflow_verify tool.
 */
export function createWorkflowVerifyTool(
  dispatcher: WorkflowDispatcher,
  registry: WorkflowRunRegistry
): ToolDefinition {
  return defineTool({
    name: "workflow_verify",
    label: "Workflow Verify",
    description:
      "Authoritatively evaluate a submitted completion claim, accepting to complete the workflow or rejecting with findings to return for rework or block.",
    parameters: Type.Object({
      decision: Type.Union([Type.Literal("accept"), Type.Literal("reject")], {
        description: "Verification decision: 'accept' marks run completed, 'reject' returns run for rework or blocks",
      }),
      findings: Type.Optional(
        Type.String({ description: "Authoritative findings, evidence evaluation, or rejection feedback" })
      ),
      checks: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: "Verification check name" }),
            passed: Type.Boolean({ description: "Whether check passed" }),
            message: Type.Optional(Type.String({ description: "Optional check diagnostic message" })),
          }),
          { description: "Optional structured evaluation checks" }
        )
      ),
      returnStep: Type.Optional(
        Type.String({ description: "Target step to return to if rejected (defaults to definition policy or pre-verification step)" })
      ),
      data: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Optional state updates to merge into durable run data",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const binding = dispatcher.assertToolBinding(signal);
      const token = binding.token;
      const generation = binding.generation;

      const run = registry.requireRun(binding.runId);
      if (run.lifecycle === "completed" || run.lifecycle === "cancelled") {
        throw new WorkflowInvalidTransitionError(
          run.id,
          `Cannot verify a run in terminal lifecycle "${run.lifecycle}".`,
          { fromLifecycle: run.lifecycle, action: "verify" }
        );
      }

      // Verify that the run is in the verification phase
      if (run.lifecycle !== "verifying") {
        throw new WorkflowRunError(
          `Cannot verify completion: workflow "${run.workflow}" is not currently in the verification phase (lifecycle: "${run.lifecycle}", step: "${run.step}"). Submit a completion claim with workflow_complete first.`,
          run.id
        );
      }

      const validatedFindings = validateVerificationFindings(
        {
          decision: params.decision,
          findings: params.findings,
          checks: params.checks,
          returnStep: params.returnStep,
        },
        { runId: binding.runId }
      );

      const validatedData =
        params.data !== undefined
          ? validateRunData(params.data as Record<string, JsonValue>, { runId: binding.runId })
          : undefined;

      dispatcher.assertToolBinding(signal, token, generation);

      if (validatedFindings.decision === "accepted") {
        // Safe ordering: cancel pending scheduler wakeups BEFORE committing terminal completed state
        if (binding.schedulerPort?.cancelWakeup) {
          await binding.schedulerPort.cancelWakeup(binding.runId);
        }

        const updated = registry.verifyRun(binding.runId, {
          decision: "accepted",
          findings: validatedFindings.feedback,
          checks: validatedFindings.checks,
          data: validatedData,
        });

        dispatcher.assertToolBinding(signal, token, generation);

        const details: WorkflowVerifyDetails = {
          runId: updated.id,
          status: "completed",
          lifecycle: updated.lifecycle,
          step: updated.step,
          completion: updated.completion,
          verificationFindings: updated.verificationFindings,
          data: updated.data,
        };

        return {
          content: [
            {
              type: "text",
              text: `Verification accepted for workflow "${run.workflow}": run marked completed. ${updated.completion?.summary}`,
            },
          ],
          details,
        };
      }

      // Decision is "rejected"
      const maxAttempts = run.snapshot.completion?.maxVerificationAttempts ?? MAX_VERIFICATION_ATTEMPTS_DEFAULT;
      const willBlock = ((run.verificationAttempts ?? 0) + 1) >= maxAttempts;

      if (willBlock) {
        // Safe ordering: cancel pending scheduler wakeups BEFORE committing blocked state
        if (binding.schedulerPort?.cancelWakeup) {
          await binding.schedulerPort.cancelWakeup(binding.runId);
        }

        const updated = registry.verifyRun(binding.runId, {
          decision: "rejected",
          findings: validatedFindings.feedback,
          checks: validatedFindings.checks,
          returnStep: validatedFindings.returnStep,
          data: validatedData,
        });

        dispatcher.assertToolBinding(signal, token, generation);

        const details: WorkflowVerifyDetails = {
          runId: updated.id,
          status: "blocked",
          lifecycle: updated.lifecycle,
          step: updated.step,
          blocker: updated.blocker,
          verificationFindings: updated.verificationFindings,
          data: updated.data,
        };

        return {
          content: [
            {
              type: "text",
              text: `Verification rejected for workflow "${run.workflow}" and max verification attempts reached: run blocked. ${updated.blocker?.reason}`,
            },
          ],
          details,
        };
      }

      // Rejection with retries remaining: return to active rework step
      const updated = registry.verifyRun(binding.runId, {
        decision: "rejected",
        findings: validatedFindings.feedback,
        checks: validatedFindings.checks,
        returnStep: validatedFindings.returnStep,
        data: validatedData,
      });

      // Schedule next iteration for rework
      if (binding.schedulerPort) {
        try {
          await binding.schedulerPort.scheduleWakeup({
            runId: binding.runId,
            delayMs: 1_000,
            reason: "Resumed active iteration following verification rejection",
          });
        } catch (scheduleErr: unknown) {
          // Fail closed with actionable blocked state rather than swallowing schedule failure
          const reason = `Failed to schedule rework iteration following verification rejection: ${scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr)}`;
          registry.blockRun(binding.runId, {
            reason,
            category: "human-required",
            requiresHuman: true,
          });
          dispatcher.assertToolBinding(signal, token, generation);
          throw new WorkflowRunError(reason, binding.runId);
        }
      }

      dispatcher.assertToolBinding(signal, token, generation);

      const details: WorkflowVerifyDetails = {
        runId: updated.id,
        status: "rejected",
        lifecycle: updated.lifecycle,
        step: updated.step,
        verificationFindings: updated.verificationFindings,
        data: updated.data,
      };

      return {
        content: [
          {
            type: "text",
            text: `Verification rejected for workflow "${run.workflow}": returned to step "${updated.step}" for rework. Findings: ${updated.verificationFindings?.feedback ?? "None"}`,
          },
        ],
        details,
      };
    },
  });
}

/**
 * Creates the workflow_effect_begin tool.
 */
export function createWorkflowEffectBeginTool(
  dispatcher: WorkflowDispatcher,
  registry: WorkflowRunRegistry
): ToolDefinition {
  return defineTool({
    name: "workflow_effect_begin",
    label: "Workflow Effect Begin",
    description:
      "Record intent before performing an external side effect (e.g. creating a PR, issue, or deployment), establishing an idempotent checkpoint.",
    parameters: Type.Object({
      key: Type.String({ description: "Unique effect identifier within this workflow run (e.g. 'create-pr', 'post-slack-notice')" }),
      kind: Type.String({ description: "Category or kind of external effect (e.g. 'github.pull_request.create')" }),
      inputSummary: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Bounded JSON-safe summary of effect inputs or intent",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const binding = dispatcher.assertToolBinding(signal);
      const token = binding.token;
      const generation = binding.generation;

      const run = registry.requireRun(binding.runId);

      // Check if key was already committed
      const existing = run.effects?.[params.key];
      if (existing && existing.status === "committed") {
        const details: WorkflowEffectBeginDetails = {
          status: "already_committed",
          key: params.key,
          kind: existing.kind,
          effect: existing,
        };
        return {
          content: [
            {
              type: "text",
              text: `Effect "${params.key}" was already committed at ${new Date(existing.committedAt!).toISOString()}. Do NOT repeat the external side effect.`,
            },
          ],
          details,
        };
      }

      const updated = registry.beginEffect(binding.runId, {
        key: params.key,
        kind: params.kind,
        inputSummary: params.inputSummary as any,
        allowCommitted: true,
      });

      dispatcher.assertToolBinding(signal, token, generation);

      const details: WorkflowEffectBeginDetails = {
        status: "started",
        key: params.key,
        kind: params.kind,
        effect: updated.effects?.[params.key],
      };

      return {
        content: [
          {
            type: "text",
            text: `Effect checkpoint started: "${params.key}" (${params.kind}). You may now perform the external side effect. Call workflow_effect_commit after observing success.`,
          },
        ],
        details,
      };
    },
  });
}

/**
 * Creates the workflow_effect_commit tool.
 */
export function createWorkflowEffectCommitTool(
  dispatcher: WorkflowDispatcher,
  registry: WorkflowRunRegistry
): ToolDefinition {
  return defineTool({
    name: "workflow_effect_commit",
    label: "Workflow Effect Commit",
    description:
      "Confirm and commit an external side effect after observing its success, preventing accidental duplication.",
    parameters: Type.Object({
      key: Type.String({ description: "Unique effect identifier to commit" }),
      resultSummary: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Bounded JSON-safe summary of observed outcome or result (e.g. { prNumber: 123, url: '...' })",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const binding = dispatcher.assertToolBinding(signal);
      const token = binding.token;
      const generation = binding.generation;

      const updated = registry.commitEffect(binding.runId, {
        key: params.key,
        resultSummary: params.resultSummary as any,
      });

      dispatcher.assertToolBinding(signal, token, generation);

      const details: WorkflowEffectCommitDetails = {
        status: "committed",
        key: params.key,
        effect: updated.effects?.[params.key],
      };

      return {
        content: [
          {
            type: "text",
            text: `Effect "${params.key}" committed successfully. External result confirmed.`,
          },
        ],
        details,
      };
    },
  });
}

/**
 * Creates the workflow_effect_reconcile tool.
 */
export function createWorkflowEffectReconcileTool(
  dispatcher: WorkflowDispatcher,
  registry: WorkflowRunRegistry
): ToolDefinition {
  return defineTool({
    name: "workflow_effect_reconcile",
    label: "Workflow Effect Reconcile",
    description:
      "Reconcile an interrupted or ambiguous effect checkpoint after inspecting external reality.",
    parameters: Type.Object({
      key: Type.String({ description: "Unique effect identifier to reconcile" }),
      resolution: Type.Union([Type.Literal("committed"), Type.Literal("aborted"), Type.Literal("retryable")], {
        description: "Reconciliation outcome: 'committed' if external action was confirmed done, 'aborted' if abandoned, 'retryable' if cleared for retry",
      }),
      reason: Type.String({ description: "Explanation of external observation and resolution findings" }),
      resultSummary: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Optional observed result summary",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const binding = dispatcher.assertToolBinding(signal);
      const token = binding.token;
      const generation = binding.generation;

      const updated = registry.reconcileEffect(binding.runId, {
        key: params.key,
        resolution: params.resolution,
        reason: params.reason,
        resultSummary: params.resultSummary as any,
      });

      dispatcher.assertToolBinding(signal, token, generation);

      const details: WorkflowEffectReconcileDetails = {
        status: params.resolution,
        key: params.key,
        reason: params.reason,
        effect: updated.effects?.[params.key],
      };

      return {
        content: [
          {
            type: "text",
            text: `Effect "${params.key}" reconciled as "${params.resolution}": ${params.reason}`,
          },
        ],
        details,
      };
    },
  });
}

/**
 * Creates all model-callable workflow tools registered with the agent runtime.
 */
export function createWorkflowTools(options: {
  dispatcher: WorkflowDispatcher;
  registry: WorkflowRunRegistry;
}): ToolDefinition[] {
  return [
    createWorkflowGetContextTool(options.dispatcher, options.registry),
    createWorkflowTransitionTool(options.dispatcher, options.registry),
    createWorkflowContinueTool(options.dispatcher, options.registry),
    createWorkflowBlockTool(options.dispatcher, options.registry),
    createWorkflowCompleteTool(options.dispatcher, options.registry),
    createWorkflowVerifyTool(options.dispatcher, options.registry),
    createWorkflowEffectBeginTool(options.dispatcher, options.registry),
    createWorkflowEffectCommitTool(options.dispatcher, options.registry),
    createWorkflowEffectReconcileTool(options.dispatcher, options.registry),
  ];
}
