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
  validateBlockerInfo,
  validateCompletionInfo,
  validateRunData,
  validateStepName,
} from "./data-bounds.ts";
import type { WorkflowDispatcher } from "./dispatcher.ts";
import { resolveWakeupDelay } from "./dispatcher.ts";
import { formatDuration } from "./duration.ts";
import type { WorkflowRunRegistry } from "./registry.ts";
import {
  type JsonValue,
  type WorkflowCompletionInfo,
  WorkflowInvalidTransitionError,
  WorkflowIterationError,
  type WorkflowRunLifecycle,
  WorkflowRunError,
} from "./types.ts";

export interface WorkflowCompleteDetails {
  runId: string;
  lifecycle: WorkflowRunLifecycle;
  step: string;
  status: "completed" | "verifying";
  pendingSummary?: string;
  completion?: Readonly<WorkflowCompletionInfo>;
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

      const updated = registry.blockRun(binding.runId, {
        reason: validatedBlocker.reason,
        requiresHuman: validatedBlocker.requiresHuman,
        data: validatedData,
      });

      // Cancel any pending wakeup on the scheduler port
      if (binding.schedulerPort?.cancelWakeup) {
        await binding.schedulerPort.cancelWakeup(binding.runId);
      }

      dispatcher.assertToolBinding(signal, token, generation);

      return {
        content: [
          {
            type: "text",
            text: `Workflow "${run.workflow}" is now blocked: ${updated.blocker?.reason}${
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
      "Submit completion summary and evidence to complete the workflow run, or trigger verification gate if required by definition policy.",
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

      dispatcher.assertToolBinding(signal, token, generation);

      const run = registry.requireRun(binding.runId);
      if (run.lifecycle === "completed" || run.lifecycle === "cancelled") {
        throw new WorkflowInvalidTransitionError(
          run.id,
          `Cannot complete a run that is already in terminal lifecycle "${run.lifecycle}".`,
          { fromLifecycle: run.lifecycle, toLifecycle: "completed", action: "complete" }
        );
      }

      const completionPolicy = run.snapshot.completion;
      if (
        completionPolicy?.requireEvidence &&
        (!validatedCompletion.evidence || validatedCompletion.evidence.length === 0)
      ) {
        throw new WorkflowRunError("Completion policy requires at least one evidence item.", run.id);
      }

      // Check if verification gate applies
      if (completionPolicy?.verify) {
        const isVerifying = run.step === "VERIFYING" || run.data?._verificationRequested === true;
        if (!isVerifying) {
          // Transition to verification phase
          const verificationData: Record<string, JsonValue> = {
            ...(validatedData ?? {}),
            _verificationRequested: true,
            _pendingCompletionSummary: validatedCompletion.summary,
          };
          const updated = registry.transitionStep(binding.runId, {
            toStep: "VERIFYING",
            data: verificationData,
            reason: "Entering verification phase before final completion",
          });

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
      }

      // Complete run
      const updated = registry.completeRun(binding.runId, {
        summary: validatedCompletion.summary,
        evidence: validatedCompletion.evidence,
        data: validatedData,
      });

      // Cancel any pending wakeup on scheduler port
      if (binding.schedulerPort?.cancelWakeup) {
        await binding.schedulerPort.cancelWakeup(binding.runId);
      }

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
 * Creates all 5 model-callable workflow tools.
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
  ];
}
