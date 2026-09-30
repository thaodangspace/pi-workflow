/**
 * Trusted Workflow Dispatcher and Ephemeral Iteration Manager.
 * Handles iteration lifecycle bindings, token/generation ownership safety,
 * delay resolution, and deterministic prompt construction.
 */

import { randomUUID } from "node:crypto";
import { formatDuration, parseDuration } from "./duration.ts";
import { buildIterationPrompt } from "./prompt.ts";
import type { WorkflowRunRegistry } from "./registry.ts";
import { checkRunBudgetExhaustion, getAmbiguousEffects, hasAmbiguousEffects } from "./run.ts";
import {
  type DispatchIterationOptions,
  type IterationBinding,
  type ResolveWakeupDelayOptions,
  type ResolvedWakeupDelay,
  WorkflowBudgetExhaustedError,
  WorkflowInvalidTransitionError,
  WorkflowIterationError,
  type WorkflowIterationContext,
  WorkflowOwnershipError,
  WorkflowRunError,
  type WorkflowRunLifecycle,
  WorkflowStaleIterationError,
} from "./types.ts";

/**
 * Resolves a wakeup delay according to definition policy, named wakeups, or explicit inputs.
 * Bounded by min/max limits if defined.
 */
export function resolveWakeupDelay(options: ResolveWakeupDelayOptions): ResolvedWakeupDelay {
  const { delay, delayMs, wakeupName, policy } = options;
  let rawDelayMs: number;
  let source: "named" | "explicit" | "default";

  if (wakeupName !== undefined) {
    let namedMs: number | undefined;
    if (policy?.namedMs && typeof policy.namedMs[wakeupName] === "number") {
      namedMs = policy.namedMs[wakeupName];
    } else if (policy?.named && typeof policy.named[wakeupName] === "string") {
      namedMs = parseDuration(policy.named[wakeupName], `wakeups.named.${wakeupName}`);
    } else if (policy && typeof (policy as any)[wakeupName] === "string") {
      namedMs = parseDuration((policy as any)[wakeupName], `wakeups.${wakeupName}`);
    } else if (policy && typeof (policy as any)[wakeupName] === "number") {
      namedMs = (policy as any)[wakeupName];
    }

    if (namedMs === undefined) {
      const knownNamed = [
        ...Object.keys(policy?.named ?? {}),
        ...Object.keys(policy?.namedMs ?? {}),
        ...Object.keys(policy ?? {}).filter(
          (k) => !["default", "defaultMs", "min", "minMs", "max", "maxMs", "named", "namedMs"].includes(k)
        ),
      ];
      throw new WorkflowRunError(
        `Unknown named wakeup "${wakeupName}". Available named wakeups: [${[...new Set(knownNamed)].join(", ")}]`
      );
    }

    rawDelayMs = namedMs;
    source = "named";
  } else if (delayMs !== undefined) {
    if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs <= 0) {
      throw new WorkflowRunError(`Explicit delayMs must be a positive finite number, got ${delayMs}`);
    }
    rawDelayMs = Math.round(delayMs);
    source = "explicit";
  } else if (delay !== undefined) {
    rawDelayMs = parseDuration(delay, "delay");
    if (rawDelayMs <= 0) {
      throw new WorkflowRunError(`Explicit delay must be positive, got "${delay}"`);
    }
    source = "explicit";
  } else {
    if (policy?.defaultMs !== undefined && policy.defaultMs > 0) {
      rawDelayMs = policy.defaultMs;
    } else if (policy?.default) {
      rawDelayMs = parseDuration(policy.default, "wakeups.default");
    } else {
      rawDelayMs = 60_000; // 1 minute default fallback
    }
    source = "default";
  }

  const originalDelayMs = rawDelayMs;
  let finalDelayMs = rawDelayMs;
  let isClamped = false;

  const minMs = policy?.minMs ?? (policy?.min ? parseDuration(policy.min, "wakeups.min") : undefined);
  const maxMs = policy?.maxMs ?? (policy?.max ? parseDuration(policy.max, "wakeups.max") : undefined);

  if (minMs !== undefined && minMs > 0 && finalDelayMs < minMs) {
    finalDelayMs = minMs;
    isClamped = true;
  }
  if (maxMs !== undefined && maxMs > 0 && finalDelayMs > maxMs) {
    finalDelayMs = maxMs;
    isClamped = true;
  }

  // Ensure positive delay (at least 1ms)
  if (finalDelayMs < 1) {
    finalDelayMs = 1;
    isClamped = true;
  }

  return {
    delayMs: finalDelayMs,
    delayString: formatDuration(finalDelayMs),
    source,
    isClamped,
    originalDelayMs,
  };
}

export class WorkflowDispatcher {
  private registry: WorkflowRunRegistry;
  private activeBinding?: IterationBinding;
  private generation: number = 0;

  constructor(registry: WorkflowRunRegistry) {
    this.registry = registry;
  }

  /**
   * Returns current generation number.
   */
  getGeneration(): number {
    return this.generation;
  }

  /**
   * Returns the currently active iteration binding if one exists.
   */
  getActiveIteration(): IterationBinding | undefined {
    return this.activeBinding;
  }

  /**
   * Bind an ephemeral execution context for a specific workflow run iteration turn.
   * Enforces exclusive single-iteration binding and increments turn counters.
   */
  beginIteration(runId: string, options: DispatchIterationOptions = {}): IterationBinding {
    const run = this.registry.requireRun(runId);
    if (run.lifecycle !== "active" && run.lifecycle !== "verifying") {
      throw new WorkflowInvalidTransitionError(
        runId,
        `Cannot dispatch iteration for run "${runId}" in lifecycle "${run.lifecycle}". Run must be "active" or "verifying".`,
        { fromLifecycle: run.lifecycle, action: "dispatch" }
      );
    }

    // Check hard budget limits before dispatching
    const exhaustion = checkRunBudgetExhaustion(run);
    if (exhaustion.exhausted) {
      const budgetPolicy = run.budget ?? run.snapshot.budget;
      if (budgetPolicy?.onExhaustion === "cancel") {
        this.registry.cancelRun(runId, { reason: exhaustion.reason });
      } else {
        this.registry.blockRun(runId, {
          reason: exhaustion.reason!,
          category: "human-required",
          requiresHuman: true,
        });
      }
      if (options.schedulerPort?.cancelWakeup) {
        try {
          options.schedulerPort.cancelWakeup(runId);
        } catch {
          // ignore
        }
      }
      throw new WorkflowBudgetExhaustedError(
        `Cannot dispatch iteration for run "${runId}": ${exhaustion.reason}`,
        { runId, dimension: exhaustion.dimension, limit: exhaustion.limit, actual: exhaustion.actual }
      );
    }

    // Ownership lease enforcement (fail closed):
    // A run with a LIVE ownership lease may only be dispatched by the owning instance.
    // A missing or expired lease permits takeover, which the scheduler adapter records
    // durably before dispatching. Omitting ownerId while a live lease exists is denied.
    if (run.lease) {
      const leaseLive = run.lease.expiresAt === undefined || run.lease.expiresAt > Date.now();
      if (leaseLive && run.lease.ownerId !== options.ownerId) {
        throw new WorkflowOwnershipError(
          `Cannot dispatch iteration for run "${runId}": run is leased to owner "${run.lease.ownerId}".`,
          { runId, currentOwnerId: run.lease.ownerId, requestedOwnerId: options.ownerId }
        );
      }
    }

    // Safely invalidate any existing active iteration
    if (this.activeBinding) {
      this.clearActiveIteration("replaced");
    }

    this.generation++;
    const token = randomUUID();

    if (options.incrementTurns !== false) {
      this.registry.updateRun(runId, { incrementTurns: 1 });
    }

    let capsSet: ReadonlySet<string> | undefined;
    if (options.capabilities) {
      if (options.capabilities instanceof Set) {
        capsSet = options.capabilities;
      } else if (Array.isArray(options.capabilities)) {
        capsSet = new Set(options.capabilities);
      } else if (typeof (options.capabilities as any)[Symbol.iterator] === "function") {
        capsSet = new Set(options.capabilities as Iterable<string>);
      } else {
        const obj = options.capabilities as Record<string, boolean>;
        capsSet = new Set(Object.keys(obj).filter((k) => obj[k]));
      }
    }

    const binding: IterationBinding = {
      token,
      generation: this.generation,
      runId,
      workflowName: run.workflow,
      createdAt: Date.now(),
      schedulerPort: options.schedulerPort,
      capabilities: capsSet,
      signal: options.signal,
      ownerId: options.ownerId,
    };

    this.activeBinding = binding;
    return binding;
  }

  /**
   * End an active iteration turn.
   * If a token is provided and does not match the active binding, does nothing (already ended or superseded).
   */
  endIteration(token?: string): void {
    if (token && this.activeBinding?.token !== token) {
      return;
    }
    this.generation++;
    this.activeBinding = undefined;
  }

  /**
   * Safely clears the active iteration on settle, abort, session reload, or tree navigation.
   * Monotonically increments generation to invalidate any in-flight asynchronous tool calls.
   */
  clearActiveIteration(reason?: string): void {
    this.generation++;
    this.activeBinding = undefined;
  }

  /**
   * Asserts that an iteration is currently active and matches the given token and generation.
   * Used by trusted internal or programmatic callers.
   */
  assertActiveBinding(token?: string, generation?: number): IterationBinding {
    if (!this.activeBinding) {
      throw new WorkflowIterationError("Cannot execute workflow operation: no workflow iteration is currently active.");
    }

    if (token !== undefined && this.activeBinding.token !== token) {
      throw new WorkflowStaleIterationError(
        `Stale workflow iteration call: iteration token "${token}" is no longer active (current token: "${this.activeBinding.token}").`,
        { runId: this.activeBinding.runId, token, currentGeneration: this.activeBinding.generation }
      );
    }

    if (generation !== undefined && this.activeBinding.generation !== generation) {
      throw new WorkflowStaleIterationError(
        `Stale workflow iteration call: iteration generation ${generation} is no longer active (current generation: ${this.activeBinding.generation}).`,
        { runId: this.activeBinding.runId, generation, currentGeneration: this.activeBinding.generation }
      );
    }

    if (this.activeBinding.signal?.aborted) {
      throw new WorkflowIterationError("Workflow iteration was aborted.", this.activeBinding.runId);
    }

    return this.activeBinding;
  }

  /**
   * Asserts that an iteration is currently active and strictly validates turn-scoped AbortSignal
   * identity for model-facing tool calls.
   *
   * To prevent stale or late asynchronous tool invocations from mutating a different run,
   * model-facing tools FAIL CLOSED unless BOTH:
   * 1. A turn-bound AbortSignal was provided when the iteration was dispatched (binding.signal);
   * 2. The tool invocation was passed an AbortSignal by the host environment (signal);
   * 3. The invocation signal is strictly identical (===) to the turn-bound signal.
   *
   * If either signal is absent, or if they differ, the tool call fails closed immediately.
   */
  assertToolBinding(signal: AbortSignal | undefined, token?: string, generation?: number): IterationBinding {
    if (!this.activeBinding) {
      throw new WorkflowIterationError("Cannot execute workflow tool: no workflow iteration is currently active.");
    }

    if (!this.activeBinding.signal) {
      throw new WorkflowIterationError(
        `Cannot execute workflow tool: active iteration for run "${this.activeBinding.runId}" was not bound with an AbortSignal. A turn-bound AbortSignal is required to enforce turn exclusivity.`,
        this.activeBinding.runId
      );
    }

    if (!signal) {
      throw new WorkflowIterationError(
        `Cannot execute workflow tool: tool invocation did not receive an AbortSignal. An AbortSignal is required to verify turn identity.`,
        this.activeBinding.runId
      );
    }

    if (this.activeBinding.signal !== signal) {
      throw new WorkflowStaleIterationError(
        `Stale workflow iteration call: tool call signal does not match the active iteration signal for run "${this.activeBinding.runId}". The invocation originated from a different turn.`,
        { runId: this.activeBinding.runId, currentGeneration: this.activeBinding.generation }
      );
    }

    if (this.activeBinding.signal.aborted || signal.aborted) {
      throw new WorkflowIterationError("Workflow iteration was aborted.", this.activeBinding.runId);
    }

    if (token !== undefined && this.activeBinding.token !== token) {
      throw new WorkflowStaleIterationError(
        `Stale workflow iteration call: iteration token "${token}" is no longer active (current token: "${this.activeBinding.token}").`,
        { runId: this.activeBinding.runId, token, currentGeneration: this.activeBinding.generation }
      );
    }

    if (generation !== undefined && this.activeBinding.generation !== generation) {
      throw new WorkflowStaleIterationError(
        `Stale workflow iteration call: iteration generation ${generation} is no longer active (current generation: ${this.activeBinding.generation}).`,
        { runId: this.activeBinding.runId, generation, currentGeneration: this.activeBinding.generation }
      );
    }

    // Secondary ownership enforcement: even a live iteration binding may not mutate a run
    // whose durable lease was taken over by another instance mid-iteration (fail closed).
    const ownedRun = this.registry.getRun(this.activeBinding.runId);
    if (ownedRun?.lease) {
      const leaseLive = ownedRun.lease.expiresAt === undefined || ownedRun.lease.expiresAt > Date.now();
      if (leaseLive && ownedRun.lease.ownerId !== this.activeBinding.ownerId) {
        throw new WorkflowOwnershipError(
          `Cannot execute workflow tool: run "${ownedRun.id}" is leased to owner "${ownedRun.lease.ownerId}", but iteration is bound to "${this.activeBinding.ownerId ?? "no owner"}".`,
          { runId: ownedRun.id, currentOwnerId: ownedRun.lease.ownerId, requestedOwnerId: this.activeBinding.ownerId }
        );
      }
    }

    return this.activeBinding;
  }

  /**
   * Executes a callback within a managed iteration scope, guaranteeing cleanup upon completion or error.
   */
  async withIteration<T>(
    runId: string,
    options: DispatchIterationOptions,
    fn: (binding: IterationBinding) => Promise<T>
  ): Promise<T> {
    const binding = this.beginIteration(runId, options);
    try {
      return await fn(binding);
    } finally {
      this.endIteration(binding.token);
    }
  }

  /**
   * Assembles the model-facing iteration context for the given binding.
   * Raw scheduler identifiers (loopTaskId) and session entries are excluded.
   */
  getIterationContext(binding?: IterationBinding, now = Date.now()): WorkflowIterationContext {
    const active = binding ?? this.assertActiveBinding();
    const run = this.registry.requireRun(active.runId);
    const snapshot = run.snapshot;

    const budget = run.budget ?? snapshot.budget;
    const maxTurns = budget?.maxTurns;
    const maxAttempts = budget?.maxAttempts;
    const maxDuration = budget?.maxDuration;
    const maxDurationMs = budget?.maxDurationMs;
    const maxCost = budget?.maxCost;
    const maxTokens = budget?.maxTokens;

    const turnsRemaining = maxTurns !== undefined ? Math.max(0, maxTurns - run.turns) : undefined;
    const attemptsRemaining = maxAttempts !== undefined ? Math.max(0, maxAttempts - run.attempts) : undefined;

    let durationRemainingMs: number | undefined;
    if (maxDurationMs !== undefined) {
      const elapsed = Math.max(0, now - (run.startedAt ?? run.createdAt));
      durationRemainingMs = Math.max(0, maxDurationMs - elapsed);
    }

    const exhaustion = checkRunBudgetExhaustion(run, now);

    const capabilitiesRecord: Record<string, boolean> = {};
    for (const req of snapshot.requires) {
      capabilitiesRecord[req] = active.capabilities ? active.capabilities.has(req) : true;
    }

    return {
      runId: run.id,
      workflow: run.workflow,
      lifecycle: run.lifecycle,
      step: run.step,
      turns: run.turns,
      attempts: run.attempts,
      data: run.data,
      budget: {
        maxTurns,
        turnsRemaining,
        maxDuration,
        maxDurationMs,
        durationRemainingMs,
        maxAttempts,
        attemptsRemaining,
        maxCost,
        ...(maxCost !== undefined ? { costStatus: "unavailable" as const } : {}),
        maxTokens,
        ...(maxTokens !== undefined ? { tokensStatus: "unavailable" as const } : {}),
        isExhausted: exhaustion.exhausted,
        exhaustedDimension: exhaustion.dimension,
        exhaustionReason: exhaustion.reason,
      },
      definition: {
        name: snapshot.name,
        description: snapshot.description,
        mode: snapshot.mode,
        version: run.definitionVersion,
        source: run.definitionSource,
      },
      requires: snapshot.requires,
      capabilities: capabilitiesRecord,
      wakeups: {
        default: snapshot.wakeups.default,
        defaultMs: snapshot.wakeups.defaultMs,
        min: snapshot.wakeups.min,
        minMs: snapshot.wakeups.minMs,
        max: snapshot.wakeups.max,
        maxMs: snapshot.wakeups.maxMs,
        named: snapshot.wakeups.named,
      },
      completion: snapshot.completion
        ? {
            requireSummary: snapshot.completion.requireSummary,
            requireEvidence: snapshot.completion.requireEvidence,
            verify: snapshot.completion.verify,
          }
        : undefined,
      effects: run.effects,
      ambiguousEffects: getAmbiguousEffects(run),
      inReconciliation: hasAmbiguousEffects(run),
    };
  }

  /**
   * Deterministically constructs the iteration prompt for the specified run.
   */
  buildPrompt(runId: string, options?: { availableCapabilities?: Iterable<string>; now?: number }): string {
    const run = this.registry.requireRun(runId);
    return buildIterationPrompt({
      run,
      availableCapabilities: options?.availableCapabilities ?? this.activeBinding?.capabilities,
      now: options?.now,
    });
  }
}
