/**
 * Generic, model-callable provider-action seam.
 *
 * Capability metadata alone is not callable: declaring a capability such as
 * `github` or `worker-runtime` exposes no executable action to the workflow
 * model. This module is the single, generic seam that lets a dispatched
 * iteration invoke a provider's explicitly allowlisted operation.
 *
 * Safety properties:
 * - No arbitrary method/path dispatch: the operation must be on the provider's
 *   registration-time allowlist.
 * - The bound run must declare the capability, and the provider must currently
 *   satisfy that requirement (version/features/health).
 * - Input and result are structurally bounded JSON; the trusted `api` handle
 *   and any credentials never cross this boundary.
 * - Mutating operations require a durable, started (non-ambiguous) effect
 *   checkpoint whose kind matches the operation's declared `effectKind`; a
 *   successful call commits that checkpoint so a replay cannot double-apply.
 *
 * This module intentionally contains no domain logic and imports no
 * GitHub/tmux code: domain methods live in provider adapters.
 */

import {
  MAX_DATA_DEPTH,
  MAX_DATA_KEY_LENGTH,
  MAX_DATA_STRING_LENGTH,
  MAX_DIAGNOSTIC_TEXT_LENGTH,
  MAX_PROVIDER_CALL_BYTES,
  MAX_PROVIDER_OPERATION_NAME_LENGTH,
} from "./constants.ts";
import { validateJsonValue, validateRunData } from "./data-bounds.ts";
import type {
  WorkflowCapabilityRegistry,
  WorkflowProviderCallContext,
  WorkflowProviderOperation,
} from "./capabilities.ts";
import type { WorkflowRunRegistry } from "./registry.ts";
import { getAmbiguousEffects, hasAmbiguousEffects } from "./run.ts";
import { sanitizeDiagnosticText, sanitizeHistoryDetails } from "./sanitize.ts";
import {
  type IterationBinding,
  type JsonValue,
  WorkflowDataBoundsError,
  WorkflowProviderCallError,
  type WorkflowProviderCallCode,
} from "./types.ts";

/** Model-supplied provider-call request (already typed by the tool schema). */
export interface ProviderCallRequest {
  capability: string;
  operation: string;
  input?: unknown;
  effectKey?: string;
}

/** Safe provider descriptor echoed back to the model with the result. */
export interface ProviderCallProviderDescriptor {
  name: string;
  version: number;
  features: readonly string[];
  status: string;
  reason?: string;
}

/** Bounded, model-safe outcome of a dispatched provider action. */
export interface ProviderCallOutcome {
  capability: string;
  operation: string;
  mutating: boolean;
  effectKey?: string;
  /** True when a mutating call committed its durable effect checkpoint. */
  effectCommitted: boolean;
  /**
   * Explicit, model-safe projection of the provider result (never the raw
   * provider output). Bounded and credential-redacted.
   */
  result: Record<string, JsonValue>;
  /** Bounded, provider-projected summary persisted as the effect result. */
  resultSummary?: Record<string, JsonValue>;
  provider: ProviderCallProviderDescriptor;
  correlationId: string;
  durationMs: number;
}

export interface DispatchProviderActionOptions {
  capabilityRegistry?: WorkflowCapabilityRegistry;
  runRegistry: WorkflowRunRegistry;
  binding: IterationBinding;
  request: ProviderCallRequest;
  /** Optional deterministic correlation id (defaults to a random one). */
  correlationId?: string;
  /** Optional dispatch timestamp (Unix epoch ms). */
  now?: number;
}

function refuse(
  message: string,
  options: {
    runId?: string;
    code: WorkflowProviderCallCode;
    capability?: string;
    operation?: string;
  }
): never {
  throw new WorkflowProviderCallError(message, options);
}

function requireName(value: unknown, field: string, runId: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    refuse(`${field} must be a non-empty string.`, { runId, code: "capability_invalid" });
  }
  return (value as string).trim();
}

/**
 * Bounds and redacts provider-controlled text (status reasons, validator
 * errors) before it can reach a model-visible error message.
 */
function safeText(value: unknown): string {
  return sanitizeDiagnosticText(value, MAX_DIAGNOSTIC_TEXT_LENGTH).text;
}

/** Structurally validates a JSON payload and enforces the provider-call byte cap. */
function boundCallPayload(value: unknown, runId: string, field: string): JsonValue {
  const validated = validateJsonValue(value, {
    maxDepth: MAX_DATA_DEPTH,
    maxStringLength: MAX_DATA_STRING_LENGTH,
    maxKeyLength: MAX_DATA_KEY_LENGTH,
    runId,
    fieldPath: field,
  });
  const bytes = Buffer.byteLength(JSON.stringify(validated), "utf8");
  if (bytes > MAX_PROVIDER_CALL_BYTES) {
    throw new WorkflowDataBoundsError(
      `Provider ${field} payload (${bytes} bytes) exceeds the maximum of ${MAX_PROVIDER_CALL_BYTES} bytes.`,
      { runId, field, limit: MAX_PROVIDER_CALL_BYTES, actual: bytes }
    );
  }
  return validated;
}

/**
 * Dispatches a single provider action for the currently bound iteration.
 *
 * Callers (the model-facing tool) are responsible for turn-binding assertions
 * before/after; this function performs all capability, allowlist, effect, and
 * bounds enforcement.
 */
export async function dispatchProviderAction(
  options: DispatchProviderActionOptions
): Promise<ProviderCallOutcome> {
  const { capabilityRegistry, runRegistry, binding, request } = options;
  const run = runRegistry.requireRun(binding.runId);
  const now = options.now ?? Date.now();
  const correlationId = options.correlationId ?? `pcall-${Math.random().toString(36).slice(2, 12)}`;

  const capability = requireName(request.capability, "capability", run.id);
  const operation = requireName(request.operation, "operation", run.id);
  if (operation.length > MAX_PROVIDER_OPERATION_NAME_LENGTH) {
    refuse(`operation name is too long.`, {
      runId: run.id,
      code: "capability_invalid",
      capability,
      operation,
    });
  }

  if (!capabilityRegistry || capabilityRegistry.isDisposed()) {
    refuse(
      `No capability registry is available to dispatch provider operation "${capability}.${operation}".`,
      { runId: run.id, code: "no_registry", capability, operation }
    );
  }

  // 1. The run must declare the capability; undeclared providers are never callable.
  const snapshot = run.snapshot;
  const requirements =
    snapshot.capabilityRequirements && snapshot.capabilityRequirements.length > 0
      ? snapshot.capabilityRequirements
      : snapshot.requires.map((name) => ({ name }));
  const declared = requirements.find((r) => r.name === capability);
  if (!declared) {
    refuse(
      `Workflow "${run.workflow}" does not declare capability "${capability}"; provider calls are restricted to declared capabilities.`,
      { runId: run.id, code: "capability_not_declared", capability, operation }
    );
  }

  // 2. Provider must be present and not unavailable.
  const provider = capabilityRegistry.getCapability(capability);
  if (!provider) {
    refuse(
      `Required capability "${capability}" has no registered provider; cannot dispatch operation "${operation}".`,
      { runId: run.id, code: "capability_missing", capability, operation }
    );
  }
  if (provider.status === "unavailable") {
    refuse(
      `Capability "${capability}" provider is unavailable${provider.reason ? `: ${safeText(provider.reason)}` : ""}.`,
      { runId: run.id, code: "capability_unavailable", capability, operation }
    );
  }

  // 3. The declared version/features must be satisfied right now.
  const resolution = capabilityRegistry.resolveRequirements([declared]);
  const item = resolution.items[0];
  if (!item || !item.satisfied) {
    refuse(
      `Capability "${capability}" no longer satisfies the run's declared requirement: ${safeText(item?.reason ?? "unsatisfied")}.`,
      { runId: run.id, code: "capability_incompatible", capability, operation }
    );
  }

  // 4. Operation must be on the explicit allowlist.
  const operations = capabilityRegistry.getProviderOperations(capability);
  if (!operations || Object.keys(operations).length === 0) {
    refuse(
      `Capability "${capability}" exposes no model-invokable operations.`,
      { runId: run.id, code: "operations_unavailable", capability, operation }
    );
  }
  if (!Object.prototype.hasOwnProperty.call(operations, operation)) {
    const allowed = Object.keys(operations).sort().join(", ");
    refuse(
      `Operation "${operation}" is not allowlisted for capability "${capability}". Allowed: [${allowed}].`,
      { runId: run.id, code: "operation_not_allowlisted", capability, operation }
    );
  }
  const op = operations[operation] as WorkflowProviderOperation;
  const mutating = op.mutating === true;

  // Degraded providers may serve reads, but a reduced-mode provider must never
  // perform a mutation.
  if (mutating && provider.status === "degraded") {
    refuse(
      `Refusing mutating operation "${operation}": capability "${capability}" is degraded${provider.reason ? ` (${safeText(provider.reason)})` : ""}.`,
      { runId: run.id, code: "provider_degraded", capability, operation }
    );
  }

  // 5. Mutations require a durable, started, non-ambiguous effect checkpoint.
  let effectKey: string | undefined;
  if (mutating) {
    if (typeof request.effectKey !== "string" || request.effectKey.trim() === "") {
      refuse(
        `Mutating operation "${capability}.${operation}" requires an effectKey referencing a started effect checkpoint (call workflow_effect_begin first).`,
        { runId: run.id, code: "effect_required", capability, operation }
      );
    }
    effectKey = request.effectKey.trim();
    if (hasAmbiguousEffects(run) && !getAmbiguousEffects(run).some((e) => e.key === effectKey)) {
      refuse(
        `Cannot dispatch mutating operation "${capability}.${operation}" while run "${run.id}" has an unrelated ambiguous effect. Reconcile it first.`,
        { runId: run.id, code: "effect_ambiguous", capability, operation }
      );
    }
    const effect = run.effects?.[effectKey];
    if (!effect) {
      refuse(
        `Effect "${effectKey}" is not registered on run "${run.id}"; call workflow_effect_begin before "${capability}.${operation}".`,
        { runId: run.id, code: "effect_not_started", capability, operation }
      );
    }
    if (effect.ambiguous === true) {
      refuse(
        `Effect "${effectKey}" is ambiguous after an interruption; reconcile it before retrying "${capability}.${operation}".`,
        { runId: run.id, code: "effect_ambiguous", capability, operation }
      );
    }
    if (effect.status === "committed") {
      refuse(
        `Effect "${effectKey}" is already committed; refusing to repeat mutating operation "${capability}.${operation}" under the same key.`,
        { runId: run.id, code: "effect_already_committed", capability, operation }
      );
    }
    if (effect.status !== "started") {
      refuse(
        `Effect "${effectKey}" is not in a started state (status: ${effect.status}); call workflow_effect_begin before "${capability}.${operation}".`,
        { runId: run.id, code: "effect_not_started", capability, operation }
      );
    }
    if (op.effectKind && effect.kind !== op.effectKind) {
      refuse(
        `Effect "${effectKey}" kind "${effect.kind}" does not match the required kind "${op.effectKind}" for mutating operation "${capability}.${operation}".`,
        { runId: run.id, code: "effect_kind_mismatch", capability, operation }
      );
    }
  } else if (request.effectKey !== undefined && request.effectKey !== null && request.effectKey !== "") {
    refuse(
      `Read-only operation "${capability}.${operation}" must not be given an effectKey.`,
      { runId: run.id, code: "effect_unexpected", capability, operation }
    );
  }

  // 6. Structurally bound the input, then apply the mandatory provider validator.
  // The validator is provider code and may throw credential-bearing prose, so
  // its error is bounded and redacted before it can reach the model.
  let input: JsonValue = boundCallPayload(request.input === undefined ? {} : request.input, run.id, "provider.input");
  if (op.validateInput) {
    let validated: unknown;
    try {
      validated = op.validateInput(input);
    } catch (err: unknown) {
      const message = safeText(err instanceof Error ? err.message : String(err));
      refuse(
        `Provider operation "${capability}.${operation}" rejected its input: ${message || "invalid input"}`,
        { runId: run.id, code: "input_invalid", capability, operation }
      );
    }
    input = boundCallPayload(validated, run.id, "provider.input");
  }

  const context: WorkflowProviderCallContext = {
    capability,
    operation,
    runId: run.id,
    workflow: run.workflow,
    step: run.step,
    iterationToken: binding.token,
    generation: binding.generation,
    ...(effectKey !== undefined ? { effectKey } : {}),
    ...(binding.signal ? { signal: binding.signal } : {}),
    now,
  };

  const startedAt = Date.now();

  // Any failure after execute begins may leave a remote mutation applied, so a
  // mutating effect is conservatively marked ambiguous before the error is
  // surfaced. Pre-dispatch validation failures never reach here.
  const markAmbiguousAfterDispatchFailure = (reason: string): void => {
    if (!mutating || !effectKey) return;
    try {
      runRegistry.markEffectAmbiguous(run.id, { key: effectKey, reason });
    } catch {
      // Best-effort: the original dispatch failure is still surfaced.
    }
  };

  let rawResult: unknown;
  try {
    rawResult = await op.execute(input, context);
  } catch (err: unknown) {
    markAmbiguousAfterDispatchFailure(
      "Provider operation threw after dispatch; the remote outcome is uncertain."
    );
    const rawMessage = err instanceof Error ? err.message : String(err);
    // Provider errors can carry credential-bearing internal prose; bound and
    // redact before it can reach the model.
    const safeMessage = safeText(rawMessage);
    refuse(
      `Provider operation "${capability}.${operation}" failed: ${safeMessage || "provider error"}`,
      { runId: run.id, code: "execution_failed", capability, operation }
    );
  }

  let boundedRawResult: JsonValue;
  try {
    boundedRawResult = boundCallPayload(
      rawResult === undefined ? null : rawResult,
      run.id,
      "provider.result"
    );
  } catch (err: unknown) {
    markAmbiguousAfterDispatchFailure(
      "Provider result could not be validated after dispatch; the remote outcome is uncertain."
    );
    throw err;
  }

  // The raw result never leaves the seam: apply the provider's explicit,
  // model-safe projection, bound it, then recursively redact/bound it.
  let projected: Record<string, JsonValue>;
  try {
    projected = validateRunData(op.projectResult(boundedRawResult), {
      runId: run.id,
      fieldPath: "provider.projection",
    });
  } catch (err: unknown) {
    markAmbiguousAfterDispatchFailure(
      "Provider result projection failed after dispatch; the remote outcome is uncertain."
    );
    if (err instanceof WorkflowDataBoundsError) throw err;
    const rawMessage = err instanceof Error ? err.message : String(err);
    const safeMessage = safeText(rawMessage);
    refuse(
      `Provider operation "${capability}.${operation}" produced an invalid result projection: ${safeMessage || "invalid projection"}`,
      { runId: run.id, code: "execution_failed", capability, operation }
    );
  }
  const result = sanitizeHistoryDetails(projected, {
    maxStringLength: MAX_DIAGNOSTIC_TEXT_LENGTH,
  }) ?? {};
  const resultSummary = result;

  // Commit the mutation checkpoint immediately after observed success so a
  // replay cannot double-apply. If the process dies before this line, the
  // effect stays started and becomes ambiguous on reconstruction.
  if (mutating && effectKey) {
    try {
      runRegistry.commitEffect(run.id, { key: effectKey, resultSummary });
    } catch (err: unknown) {
      markAmbiguousAfterDispatchFailure(
        "Effect commit failed after a successful mutation; the remote outcome is uncertain."
      );
      throw err;
    }
  }

  return {
    capability,
    operation,
    mutating,
    ...(effectKey !== undefined ? { effectKey } : {}),
    effectCommitted: mutating,
    result,
    resultSummary,
    provider: {
      name: provider.name,
      version: provider.version,
      features: provider.features,
      status: provider.status,
      ...(provider.reason ? { reason: safeText(provider.reason) } : {}),
    },
    correlationId,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}
