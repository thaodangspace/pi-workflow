/**
 * JSON validation and bounding enforcement for workflow runs and session entries.
 */

import {
  MAX_BLOCKER_REASON_LENGTH,
  MAX_COMPLETION_SUMMARY_LENGTH,
  MAX_DATA_DEPTH,
  MAX_DATA_KEY_LENGTH,
  MAX_DATA_STRING_LENGTH,
  MAX_EVIDENCE_ITEMS,
  MAX_RUN_DATA_BYTES,
  MAX_RUN_ID_LENGTH,
  MAX_STEP_NAME_LENGTH,
} from "./constants.ts";
import {
  type JsonValue,
  type WorkflowBlockerInfo,
  type WorkflowCompletionInfo,
  WorkflowDataBoundsError,
  type WorkflowEvidence,
} from "./types.ts";

export interface JsonValidationOptions {
  maxDepth?: number;
  maxStringLength?: number;
  maxKeyLength?: number;
  runId?: string;
  fieldPath?: string;
}

/**
 * Checks if a value is a plain JavaScript object (not an instance of a class, Date, RegExp, etc.)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively validates and deep clones a JSON-safe value while enforcing depth, string length,
 * and rejecting non-finite numbers, functions, symbols, BigInts, and circular references.
 */
export function validateJsonValue(
  value: unknown,
  options: JsonValidationOptions = {}
): JsonValue {
  const maxDepth = options.maxDepth ?? MAX_DATA_DEPTH;
  const maxStringLength = options.maxStringLength ?? MAX_DATA_STRING_LENGTH;
  const maxKeyLength = options.maxKeyLength ?? MAX_DATA_KEY_LENGTH;
  const runId = options.runId;
  const seen = new Set<unknown>();

  function validateInternal(val: unknown, currentDepth: number, currentPath: string): JsonValue {
    if (currentDepth > maxDepth) {
      throw new WorkflowDataBoundsError(
        `Nesting depth exceeded maximum allowed depth of ${maxDepth} at "${currentPath}"`,
        { runId, field: currentPath, limit: maxDepth, actual: currentDepth }
      );
    }

    if (val === null) return null;

    const t = typeof val;
    if (t === "boolean") return val as boolean;

    if (t === "number") {
      if (!Number.isFinite(val)) {
        throw new WorkflowDataBoundsError(
          `Non-finite number (${val}) is not valid JSON at "${currentPath}"`,
          { runId, field: currentPath }
        );
      }
      return val as number;
    }

    if (t === "string") {
      const s = val as string;
      if (s.length > maxStringLength) {
        throw new WorkflowDataBoundsError(
          `String length ${s.length} exceeds maximum allowed of ${maxStringLength} at "${currentPath}"`,
          { runId, field: currentPath, limit: maxStringLength, actual: s.length }
        );
      }
      return s;
    }

    if (t === "bigint" || t === "symbol" || t === "function" || t === "undefined") {
      throw new WorkflowDataBoundsError(
        `Type "${t}" is not allowed in workflow JSON data at "${currentPath}"`,
        { runId, field: currentPath }
      );
    }

    if (Array.isArray(val)) {
      if (seen.has(val)) {
        throw new WorkflowDataBoundsError(
          `Circular reference detected in array at "${currentPath}"`,
          { runId, field: currentPath }
        );
      }
      seen.add(val);
      try {
        const outArray: JsonValue[] = [];
        for (let i = 0; i < val.length; i++) {
          outArray.push(validateInternal(val[i], currentDepth + 1, `${currentPath}[${i}]`));
        }
        return outArray;
      } finally {
        seen.delete(val);
      }
    }

    if (isPlainObject(val)) {
      if (seen.has(val)) {
        throw new WorkflowDataBoundsError(
          `Circular reference detected in object at "${currentPath}"`,
          { runId, field: currentPath }
        );
      }
      seen.add(val);
      try {
        const outObj: Record<string, JsonValue> = {};
        for (const [k, v] of Object.entries(val)) {
          if (k.length > maxKeyLength) {
            throw new WorkflowDataBoundsError(
              `Object key "${k.slice(0, 32)}..." length ${k.length} exceeds maximum allowed of ${maxKeyLength}`,
              { runId, field: `${currentPath}.${k}`, limit: maxKeyLength, actual: k.length }
            );
          }
          outObj[k] = validateInternal(v, currentDepth + 1, `${currentPath}.${k}`);
        }
        return outObj;
      } finally {
        seen.delete(val);
      }
    }

    throw new WorkflowDataBoundsError(
      `Unsupported object type (${Object.prototype.toString.call(val)}) at "${currentPath}"`,
      { runId, field: currentPath }
    );
  }

  return validateInternal(value, 0, options.fieldPath ?? "root");
}

/**
 * Validates a workflow run data mapping and ensures total serialized UTF-8 bytes
 * remain within MAX_RUN_DATA_BYTES.
 */
export function validateRunData(
  data: unknown,
  options: { runId?: string; maxBytes?: number; fieldPath?: string } = {}
): Record<string, JsonValue> {
  const runId = options.runId;
  const maxBytes = options.maxBytes ?? MAX_RUN_DATA_BYTES;
  const fieldPath = options.fieldPath ?? "data";

  if (data === null || data === undefined) {
    return {};
  }

  if (!isPlainObject(data)) {
    throw new WorkflowDataBoundsError(
      `Workflow data must be a plain object mapping, received ${typeof data}`,
      { runId, field: fieldPath }
    );
  }

  const validated = validateJsonValue(data, {
    runId,
    fieldPath,
  }) as Record<string, JsonValue>;

  // Check UTF-8 byte size
  const serialized = JSON.stringify(validated);
  const byteLength = Buffer.byteLength(serialized, "utf8");

  if (byteLength > maxBytes) {
    throw new WorkflowDataBoundsError(
      `Workflow data serialized size (${byteLength} bytes) exceeds maximum of ${maxBytes} bytes`,
      { runId, field: fieldPath, limit: maxBytes, actual: byteLength }
    );
  }

  return validated;
}

/**
 * Validates an array of structured workflow completion evidence items.
 */
export function validateEvidence(
  evidence: unknown,
  options: { runId?: string } = {}
): WorkflowEvidence[] {
  const runId = options.runId;

  if (evidence === null || evidence === undefined) {
    return [];
  }

  if (!Array.isArray(evidence)) {
    throw new WorkflowDataBoundsError(
      `Workflow completion evidence must be an array, received ${typeof evidence}`,
      { runId, field: "completion.evidence" }
    );
  }

  if (evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new WorkflowDataBoundsError(
      `Evidence item count (${evidence.length}) exceeds maximum allowed of ${MAX_EVIDENCE_ITEMS}`,
      { runId, field: "completion.evidence", limit: MAX_EVIDENCE_ITEMS, actual: evidence.length }
    );
  }

  const out: WorkflowEvidence[] = [];
  for (let i = 0; i < evidence.length; i++) {
    const item = evidence[i];
    const prefix = `completion.evidence[${i}]`;

    if (!isPlainObject(item)) {
      throw new WorkflowDataBoundsError(
        `Evidence item at index ${i} must be an object`,
        { runId, field: prefix }
      );
    }

    if (typeof item.type !== "string" || item.type.trim() === "" || item.type.length > 64) {
      throw new WorkflowDataBoundsError(
        `Evidence item at index ${i} requires non-empty string "type" (<= 64 chars)`,
        { runId, field: `${prefix}.type` }
      );
    }

    if (typeof item.description !== "string" || item.description.trim() === "" || item.description.length > 2048) {
      throw new WorkflowDataBoundsError(
        `Evidence item at index ${i} requires non-empty string "description" (<= 2048 chars)`,
        { runId, field: `${prefix}.description` }
      );
    }

    const validatedItem: WorkflowEvidence = {
      type: item.type.trim(),
      description: item.description.trim(),
    };

    if (item.url !== undefined) {
      if (typeof item.url !== "string" || item.url.length > 2048) {
        throw new WorkflowDataBoundsError(
          `Evidence URL at index ${i} must be string <= 2048 chars`,
          { runId, field: `${prefix}.url` }
        );
      }
      validatedItem.url = item.url.trim();
    }

    if (item.path !== undefined) {
      if (typeof item.path !== "string" || item.path.length > 1024) {
        throw new WorkflowDataBoundsError(
          `Evidence path at index ${i} must be string <= 1024 chars`,
          { runId, field: `${prefix}.path` }
        );
      }
      validatedItem.path = item.path.trim();
    }

    if (item.data !== undefined) {
      validatedItem.data = validateRunData(item.data, {
        runId,
        maxBytes: 16 * 1024,
        fieldPath: `${prefix}.data`,
      });
    }

    out.push(validatedItem);
  }

  return out;
}

/**
 * Validates blocker information.
 */
export function validateBlockerInfo(
  blocker: unknown,
  options: { runId?: string } = {}
): WorkflowBlockerInfo {
  const runId = options.runId;

  if (!isPlainObject(blocker)) {
    throw new WorkflowDataBoundsError(
      `Blocker info must be an object`,
      { runId, field: "blocker" }
    );
  }

  if (typeof blocker.reason !== "string" || blocker.reason.trim() === "") {
    throw new WorkflowDataBoundsError(
      `Blocker info requires non-empty string "reason"`,
      { runId, field: "blocker.reason" }
    );
  }

  if (blocker.reason.length > MAX_BLOCKER_REASON_LENGTH) {
    throw new WorkflowDataBoundsError(
      `Blocker reason length (${blocker.reason.length}) exceeds maximum allowed of ${MAX_BLOCKER_REASON_LENGTH}`,
      { runId, field: "blocker.reason", limit: MAX_BLOCKER_REASON_LENGTH, actual: blocker.reason.length }
    );
  }

  const blockedAt = typeof blocker.blockedAt === "number" && Number.isFinite(blocker.blockedAt) && blocker.blockedAt > 0
    ? blocker.blockedAt
    : Date.now();

  return {
    reason: blocker.reason.trim(),
    requiresHuman: Boolean(blocker.requiresHuman),
    blockedAt,
  };
}

/**
 * Validates completion information.
 */
export function validateCompletionInfo(
  completion: unknown,
  options: { runId?: string } = {}
): WorkflowCompletionInfo {
  const runId = options.runId;

  if (!isPlainObject(completion)) {
    throw new WorkflowDataBoundsError(
      `Completion info must be an object`,
      { runId, field: "completion" }
    );
  }

  if (typeof completion.summary !== "string" || completion.summary.trim() === "") {
    throw new WorkflowDataBoundsError(
      `Completion info requires non-empty string "summary"`,
      { runId, field: "completion.summary" }
    );
  }

  if (completion.summary.length > MAX_COMPLETION_SUMMARY_LENGTH) {
    throw new WorkflowDataBoundsError(
      `Completion summary length (${completion.summary.length}) exceeds maximum allowed of ${MAX_COMPLETION_SUMMARY_LENGTH}`,
      { runId, field: "completion.summary", limit: MAX_COMPLETION_SUMMARY_LENGTH, actual: completion.summary.length }
    );
  }

  const evidence = validateEvidence(completion.evidence, { runId });
  const completedAt = typeof completion.completedAt === "number" && Number.isFinite(completion.completedAt) && completion.completedAt > 0
    ? completion.completedAt
    : Date.now();

  return {
    summary: completion.summary.trim(),
    evidence,
    completedAt,
  };
}

/**
 * Validates workflow step name.
 */
export function validateStepName(step: string, options: { runId?: string } = {}): string {
  const runId = options.runId;

  if (typeof step !== "string" || step.trim() === "") {
    throw new WorkflowDataBoundsError(
      `Step name must be a non-empty string`,
      { runId, field: "step" }
    );
  }

  const trimmed = step.trim();
  if (trimmed.length > MAX_STEP_NAME_LENGTH) {
    throw new WorkflowDataBoundsError(
      `Step name length (${trimmed.length}) exceeds maximum allowed of ${MAX_STEP_NAME_LENGTH}`,
      { runId, field: "step", limit: MAX_STEP_NAME_LENGTH, actual: trimmed.length }
    );
  }

  // Reject control characters
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new WorkflowDataBoundsError(
      `Step name contains invalid control characters`,
      { runId, field: "step" }
    );
  }

  return trimmed;
}

/**
 * Validates run identifier.
 */
export function validateRunId(id: string): string {
  if (typeof id !== "string" || id.trim() === "") {
    throw new WorkflowDataBoundsError("Run ID must be a non-empty string", { field: "id" });
  }

  const trimmed = id.trim();
  if (trimmed.length > MAX_RUN_ID_LENGTH) {
    throw new WorkflowDataBoundsError(
      `Run ID length (${trimmed.length}) exceeds maximum of ${MAX_RUN_ID_LENGTH}`,
      { field: "id", limit: MAX_RUN_ID_LENGTH, actual: trimmed.length }
    );
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed)) {
    throw new WorkflowDataBoundsError(
      `Run ID "${trimmed}" contains invalid characters. Must start with alphanumeric and only contain [a-zA-Z0-9._-]`,
      { field: "id" }
    );
  }

  return trimmed;
}
