/**
 * Serialization, deserialization, and schema validation for workflow run session entries.
 */

import { randomUUID } from "node:crypto";
import { WORKFLOW_RUN_ENTRY_TYPE, WORKFLOW_RUN_PERSISTENCE_VERSION } from "./constants.ts";
import {
  validateBlockerInfo,
  validateCompletionInfo,
  validateRunData,
  validateRunId,
  validateStepName,
} from "./data-bounds.ts";
import { isWorkflowSnapshot } from "./snapshot.ts";
import {
  type BlockRunOptions,
  type CancelRunOptions,
  type CompleteRunOptions,
  type PauseRunOptions,
  type ResumeRunOptions,
  type TransitionStepOptions,
  type UpdateRunOptions,
  type WorkflowRunDiagnostic,
  type WorkflowRunMutationAction,
  type WorkflowRunMutationEntryData,
  type WorkflowSnapshotV1,
} from "./types.ts";

export const VALID_ACTIONS = new Set<WorkflowRunMutationAction>([
  "create",
  "update",
  "transition",
  "block",
  "pause",
  "resume",
  "complete",
  "cancel",
]);

export interface CreatePayload {
  snapshot: WorkflowSnapshotV1;
  initialStep?: string;
  initialData?: Record<string, unknown>;
  loopTaskId?: string;
}

/**
 * Builds a validated WorkflowRunMutationEntryData structure ready to be stored in a CustomEntry.
 */
export function buildMutationEntryData(
  action: WorkflowRunMutationAction,
  runId: string,
  workflow: string,
  payload: unknown,
  options: { timestamp?: number; eventId?: string } = {}
): WorkflowRunMutationEntryData {
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`Invalid workflow run mutation action: "${action}"`);
  }

  const validRunId = validateRunId(runId);
  const timestamp = options.timestamp ?? Date.now();
  const eventId = options.eventId ?? `wfevt-${randomUUID().slice(0, 8)}`;

  return {
    version: WORKFLOW_RUN_PERSISTENCE_VERSION,
    eventId,
    runId: validRunId,
    workflow: workflow.trim(),
    action,
    timestamp,
    payload,
  };
}

export interface ParseEntryResult {
  entryData?: WorkflowRunMutationEntryData;
  diagnostic?: WorkflowRunDiagnostic;
}

/**
 * Validates an entry found in a session branch. Returns either a typed entryData or a diagnostic.
 */
export function parseSessionMutationEntry(
  rawEntry: unknown,
  entryId?: string
): ParseEntryResult {
  if (typeof rawEntry !== "object" || rawEntry === null) {
    return {
      diagnostic: {
        type: "error",
        code: "MALFORMED_ENTRY",
        message: "Session custom entry data is null or not an object",
        entryId,
      },
    };
  }

  const obj = rawEntry as Record<string, unknown>;

  // Check version
  if (typeof obj.version !== "number") {
    return {
      diagnostic: {
        type: "error",
        code: "MISSING_VERSION",
        message: 'Workflow run entry missing numeric "version"',
        entryId,
      },
    };
  }

  if (obj.version > WORKFLOW_RUN_PERSISTENCE_VERSION) {
    return {
      diagnostic: {
        type: "error",
        code: "UNSUPPORTED_VERSION",
        message: `Workflow run entry has unsupported version ${obj.version} (maximum supported: ${WORKFLOW_RUN_PERSISTENCE_VERSION})`,
        entryId,
        details: { version: obj.version },
      },
    };
  }

  // Check runId
  if (typeof obj.runId !== "string" || obj.runId.trim() === "") {
    return {
      diagnostic: {
        type: "error",
        code: "MALFORMED_ENTRY",
        message: 'Workflow run entry missing non-empty "runId"',
        entryId,
      },
    };
  }

  // Check action
  if (typeof obj.action !== "string" || !VALID_ACTIONS.has(obj.action as WorkflowRunMutationAction)) {
    return {
      diagnostic: {
        type: "error",
        code: "MALFORMED_ACTION",
        message: `Workflow run entry has unknown action "${String(obj.action)}"`,
        runId: obj.runId,
        entryId,
      },
    };
  }

  const action = obj.action as WorkflowRunMutationAction;
  const runId = obj.runId.trim();
  const workflow = typeof obj.workflow === "string" ? obj.workflow.trim() : "";
  const timestamp = typeof obj.timestamp === "number" && Number.isFinite(obj.timestamp) ? obj.timestamp : Date.now();
  const eventId = typeof obj.eventId === "string" ? obj.eventId : `wfevt-${randomUUID().slice(0, 8)}`;

  // Validate action-specific payload
  const payloadDiagnostic = validatePayloadForAction(action, runId, obj.payload, entryId);
  if (payloadDiagnostic) {
    return { diagnostic: payloadDiagnostic };
  }

  return {
    entryData: {
      version: obj.version,
      eventId,
      runId,
      workflow,
      action,
      timestamp,
      payload: obj.payload,
    },
  };
}

function validatePayloadForAction(
  action: WorkflowRunMutationAction,
  runId: string,
  payload: unknown,
  entryId?: string
): WorkflowRunDiagnostic | null {
  if (payload !== undefined && (typeof payload !== "object" || payload === null)) {
    return {
      type: "error",
      code: "INVALID_PAYLOAD",
      message: `Action "${action}" payload must be an object or undefined`,
      runId,
      entryId,
    };
  }

  const p = (payload ?? {}) as Record<string, unknown>;

  try {
    switch (action) {
      case "create": {
        if (!isWorkflowSnapshot(p.snapshot)) {
          return {
            type: "error",
            code: "INVALID_SNAPSHOT",
            message: `Create mutation requires a valid WorkflowSnapshotV1 in payload`,
            runId,
            entryId,
          };
        }
        if (p.initialStep !== undefined) {
          validateStepName(String(p.initialStep), { runId });
        }
        if (p.initialData !== undefined) {
          validateRunData(p.initialData, { runId });
        }
        break;
      }
      case "update": {
        if (p.step !== undefined) {
          validateStepName(String(p.step), { runId });
        }
        if (p.data !== undefined) {
          validateRunData(p.data, { runId });
        }
        break;
      }
      case "transition": {
        if (typeof p.toStep !== "string" || p.toStep.trim() === "") {
          return {
            type: "error",
            code: "INVALID_PAYLOAD",
            message: `Transition mutation requires string "toStep"`,
            runId,
            entryId,
          };
        }
        validateStepName(p.toStep, { runId });
        if (p.data !== undefined) {
          validateRunData(p.data, { runId });
        }
        break;
      }
      case "block": {
        if (typeof p.reason !== "string" || p.reason.trim() === "") {
          return {
            type: "error",
            code: "INVALID_PAYLOAD",
            message: `Block mutation requires string "reason"`,
            runId,
            entryId,
          };
        }
        validateBlockerInfo({ reason: p.reason, requiresHuman: p.requiresHuman }, { runId });
        if (p.data !== undefined) {
          validateRunData(p.data, { runId });
        }
        break;
      }
      case "pause": {
        if (p.data !== undefined) {
          validateRunData(p.data, { runId });
        }
        break;
      }
      case "resume": {
        if (p.step !== undefined) {
          validateStepName(String(p.step), { runId });
        }
        if (p.data !== undefined) {
          validateRunData(p.data, { runId });
        }
        break;
      }
      case "complete": {
        if (typeof p.summary !== "string" || p.summary.trim() === "") {
          return {
            type: "error",
            code: "INVALID_PAYLOAD",
            message: `Complete mutation requires non-empty string "summary"`,
            runId,
            entryId,
          };
        }
        validateCompletionInfo({ summary: p.summary, evidence: p.evidence }, { runId });
        if (p.data !== undefined) {
          validateRunData(p.data, { runId });
        }
        break;
      }
      case "cancel": {
        if (p.data !== undefined) {
          validateRunData(p.data, { runId });
        }
        break;
      }
    }
  } catch (err: unknown) {
    return {
      type: "error",
      code: "INVALID_PAYLOAD",
      message: err instanceof Error ? err.message : String(err),
      runId,
      entryId,
    };
  }

  return null;
}
