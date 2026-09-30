/**
 * JSON validation and bounding enforcement for workflow runs and session entries.
 */

import {
  MAX_BLOCKER_REASON_LENGTH,
  MAX_COMPLETION_SUMMARY_LENGTH,
  MAX_DATA_DEPTH,
  MAX_DATA_KEY_LENGTH,
  MAX_DATA_STRING_LENGTH,
  MAX_EFFECT_KEY_LENGTH,
  MAX_EFFECT_KIND_LENGTH,
  MAX_EFFECT_NOTE_LENGTH,
  MAX_EFFECTS_PER_RUN,
  MAX_EVIDENCE_ITEMS,
  MAX_RUN_DATA_BYTES,
  MAX_RUN_ID_LENGTH,
  MAX_STEP_NAME_LENGTH,
  MAX_VERIFICATION_FINDINGS_LENGTH,
} from "./constants.ts";
import {
  type BlockerCategory,
  type JsonValue,
  type WorkflowBlockerInfo,
  type WorkflowCompletionClaim,
  type WorkflowCompletionInfo,
  WorkflowDataBoundsError,
  type WorkflowEvidence,
  type WorkflowVerificationFindings,
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

  const b = blocker as Record<string, unknown>;

  if (typeof b.reason !== "string" || b.reason.trim() === "") {
    throw new WorkflowDataBoundsError(
      `Blocker info requires non-empty string "reason"`,
      { runId, field: "blocker.reason" }
    );
  }

  if (b.reason.length > MAX_BLOCKER_REASON_LENGTH) {
    throw new WorkflowDataBoundsError(
      `Blocker reason length (${b.reason.length}) exceeds maximum allowed of ${MAX_BLOCKER_REASON_LENGTH}`,
      { runId, field: "blocker.reason", limit: MAX_BLOCKER_REASON_LENGTH, actual: b.reason.length }
    );
  }

  let category: BlockerCategory;
  if (b.category !== undefined) {
    if (
      b.category !== "external-retryable" &&
      b.category !== "human-required" &&
      b.category !== "terminal"
    ) {
      throw new WorkflowDataBoundsError(
        `Blocker category must be "external-retryable", "human-required", or "terminal" (got "${String(b.category)}")`,
        { runId, field: "blocker.category" }
      );
    }
    category = b.category as BlockerCategory;
  } else {
    category = b.requiresHuman ? "human-required" : "external-retryable";
  }

  const requiresHuman = category === "human-required" || category === "terminal" || Boolean(b.requiresHuman);

  let retryDelayMs: number | undefined;
  if (b.retryDelayMs !== undefined) {
    if (typeof b.retryDelayMs !== "number" || !Number.isFinite(b.retryDelayMs) || b.retryDelayMs <= 0) {
      throw new WorkflowDataBoundsError(
        `Blocker retryDelayMs must be a positive finite number, got ${b.retryDelayMs}`,
        { runId, field: "blocker.retryDelayMs" }
      );
    }
    retryDelayMs = Math.round(b.retryDelayMs);
  }

  const blockedAt = typeof b.blockedAt === "number" && Number.isFinite(b.blockedAt) && b.blockedAt > 0
    ? b.blockedAt
    : Date.now();

  return {
    reason: b.reason.trim(),
    category,
    requiresHuman,
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
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
 * Validates completion claim information.
 */
export function validateCompletionClaim(
  claim: unknown,
  options: { runId?: string } = {}
): WorkflowCompletionClaim {
  const runId = options.runId;

  if (!isPlainObject(claim)) {
    throw new WorkflowDataBoundsError(`Completion claim must be an object`, { runId, field: "claim" });
  }

  const c = claim as Record<string, unknown>;

  if (typeof c.summary !== "string" || c.summary.trim() === "") {
    throw new WorkflowDataBoundsError(
      `Completion claim requires non-empty string "summary"`,
      { runId, field: "claim.summary" }
    );
  }

  if (c.summary.length > MAX_COMPLETION_SUMMARY_LENGTH) {
    throw new WorkflowDataBoundsError(
      `Completion claim summary length (${c.summary.length}) exceeds maximum allowed of ${MAX_COMPLETION_SUMMARY_LENGTH}`,
      { runId, field: "claim.summary", limit: MAX_COMPLETION_SUMMARY_LENGTH, actual: c.summary.length }
    );
  }

  const evidence = validateEvidence(c.evidence, { runId });
  const submittedAt =
    typeof c.submittedAt === "number" && Number.isFinite(c.submittedAt) && c.submittedAt > 0
      ? c.submittedAt
      : Date.now();

  const claimId = typeof c.claimId === "string" && c.claimId.trim() !== "" ? c.claimId.trim() : undefined;

  return {
    summary: c.summary.trim(),
    evidence,
    submittedAt,
    ...(claimId ? { claimId } : {}),
  };
}

/**
 * Validates verification findings and decision.
 */
export function validateVerificationFindings(
  findings: unknown,
  options: { runId?: string } = {}
): WorkflowVerificationFindings {
  const runId = options.runId;

  if (!isPlainObject(findings)) {
    throw new WorkflowDataBoundsError(`Verification findings must be an object`, { runId, field: "findings" });
  }

  const f = findings as Record<string, unknown>;

  if (f.decision !== "accept" && f.decision !== "accepted" && f.decision !== "reject" && f.decision !== "rejected") {
    throw new WorkflowDataBoundsError(
      `Verification decision must be "accept" or "reject" (got "${String(f.decision)}")`,
      { runId, field: "findings.decision" }
    );
  }

  const decision: "accepted" | "rejected" =
    f.decision === "accept" || f.decision === "accepted" ? "accepted" : "rejected";

  let feedback: string | undefined;
  if (typeof f.feedback === "string" && f.feedback.trim() !== "") {
    feedback = f.feedback.trim();
  } else if (typeof f.findings === "string" && f.findings.trim() !== "") {
    feedback = f.findings.trim();
  }

  if (feedback && feedback.length > MAX_VERIFICATION_FINDINGS_LENGTH) {
    throw new WorkflowDataBoundsError(
      `Verification feedback length (${feedback.length}) exceeds maximum allowed of ${MAX_VERIFICATION_FINDINGS_LENGTH}`,
      { runId, field: "findings.feedback", limit: MAX_VERIFICATION_FINDINGS_LENGTH, actual: feedback.length }
    );
  }

  const verifiedAt =
    typeof f.verifiedAt === "number" && Number.isFinite(f.verifiedAt) && f.verifiedAt > 0
      ? f.verifiedAt
      : Date.now();

  const attempt =
    typeof f.attempt === "number" && Number.isInteger(f.attempt) && f.attempt >= 1
      ? f.attempt
      : 1;

  let returnStep: string | undefined;
  if (typeof f.returnStep === "string" && f.returnStep.trim() !== "") {
    returnStep = validateStepName(f.returnStep, { runId });
  }

  let checks: Array<{ name: string; passed: boolean; message?: string }> | undefined;
  if (f.checks !== undefined) {
    if (!Array.isArray(f.checks)) {
      throw new WorkflowDataBoundsError(`Verification checks must be an array`, { runId, field: "findings.checks" });
    }
    checks = f.checks.map((chk, i) => {
      if (!isPlainObject(chk) || typeof chk.name !== "string" || typeof chk.passed !== "boolean") {
        throw new WorkflowDataBoundsError(
          `Verification check item at index ${i} must have string "name" and boolean "passed"`,
          { runId, field: `findings.checks[${i}]` }
        );
      }
      return {
        name: chk.name.trim(),
        passed: chk.passed,
        ...(typeof chk.message === "string" ? { message: chk.message.trim() } : {}),
      };
    });
  }

  return {
    decision,
    ...(feedback ? { feedback } : {}),
    verifiedAt,
    attempt,
    ...(returnStep ? { returnStep } : {}),
    ...(checks ? { checks } : {}),
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

/**
 * Validates an effect key.
 */
export function validateEffectKey(key: string, options: { runId?: string } = {}): string {
  const runId = options.runId;

  if (typeof key !== "string" || key.trim() === "") {
    throw new WorkflowDataBoundsError(
      `Effect key must be a non-empty string`,
      { runId, field: "effect.key" }
    );
  }

  const trimmed = key.trim();
  if (trimmed.length > MAX_EFFECT_KEY_LENGTH) {
    throw new WorkflowDataBoundsError(
      `Effect key length (${trimmed.length}) exceeds maximum allowed of ${MAX_EFFECT_KEY_LENGTH}`,
      { runId, field: "effect.key", limit: MAX_EFFECT_KEY_LENGTH, actual: trimmed.length }
    );
  }

  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new WorkflowDataBoundsError(
      `Effect key contains invalid control characters`,
      { runId, field: "effect.key" }
    );
  }

  return trimmed;
}

/**
 * Validates an effect kind.
 */
export function validateEffectKind(kind: string, options: { runId?: string } = {}): string {
  const runId = options.runId;

  if (typeof kind !== "string" || kind.trim() === "") {
    throw new WorkflowDataBoundsError(
      `Effect kind must be a non-empty string`,
      { runId, field: "effect.kind" }
    );
  }

  const trimmed = kind.trim();
  if (trimmed.length > MAX_EFFECT_KIND_LENGTH) {
    throw new WorkflowDataBoundsError(
      `Effect kind length (${trimmed.length}) exceeds maximum allowed of ${MAX_EFFECT_KIND_LENGTH}`,
      { runId, field: "effect.kind", limit: MAX_EFFECT_KIND_LENGTH, actual: trimmed.length }
    );
  }

  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new WorkflowDataBoundsError(
      `Effect kind contains invalid control characters`,
      { runId, field: "effect.kind" }
    );
  }

  return trimmed;
}

/**
 * Validates an effect input or result summary JSON payload.
 */
export function validateEffectSummary(
  summary: unknown,
  options: { runId?: string; field?: string } = {}
): JsonValue {
  const runId = options.runId;
  const field = options.field ?? "effect.summary";

  if (summary === undefined || summary === null) {
    return null;
  }

  return validateJsonValue(summary, {
    maxDepth: MAX_DATA_DEPTH,
    maxStringLength: MAX_DATA_STRING_LENGTH,
    maxKeyLength: MAX_DATA_KEY_LENGTH,
    runId,
    fieldPath: field,
  });
}

/**
 * Validates an effect reconciliation resolution decision.
 */
export function validateEffectResolution(
  resolution: string,
  options: { runId?: string } = {}
): "committed" | "aborted" | "retryable" {
  const runId = options.runId;

  if (resolution !== "committed" && resolution !== "aborted" && resolution !== "retryable") {
    throw new WorkflowDataBoundsError(
      `Effect resolution must be "committed", "aborted", or "retryable" (got "${String(resolution)}")`,
      { runId, field: "effect.resolution" }
    );
  }

  return resolution;
}

/**
 * Validates an effect recovery note or reason string.
 */
export function validateEffectNote(note: string, options: { runId?: string } = {}): string {
  const runId = options.runId;

  if (typeof note !== "string") {
    throw new WorkflowDataBoundsError(`Effect note must be a string`, { runId, field: "effect.note" });
  }

  const trimmed = note.trim();
  if (trimmed.length > MAX_EFFECT_NOTE_LENGTH) {
    throw new WorkflowDataBoundsError(
      `Effect note length (${trimmed.length}) exceeds maximum allowed of ${MAX_EFFECT_NOTE_LENGTH}`,
      { runId, field: "effect.note", limit: MAX_EFFECT_NOTE_LENGTH, actual: trimmed.length }
    );
  }

  return trimmed;
}
