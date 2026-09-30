/**
 * LoopSchedulerAdapter: pi-loop scheduler integration for pi-workflow.
 *
 * Implements trusted sibling extension integration against the versioned pi-loop service (v1).
 * pi-workflow owns workflow orchestration state, lifecycle, and model tools;
 * pi-loop owns timers, due queues, wakeups, coalescing, and scheduler persistence.
 *
 * This module conforms to the public versioned pi-loop/service boundary and discovery protocol
 * over pi.events without importing private pi-loop modules or duplicating timer/due-queue logic.
 */

import { randomUUID } from "node:crypto";
import type { WorkflowDispatcher } from "./dispatcher.ts";
import { parseDuration } from "./duration.ts";
import { extractWorkflowRunId } from "./prompt.ts";
import type { WorkflowRunRegistry } from "./registry.ts";
import { isTerminalLifecycle, checkRunBudgetExhaustion } from "./run.ts";
import {
  type DispatchIterationOptions,
  type IterationBinding,
  type JsonValue,
  type WorkflowBudgetPolicy,
  type WorkflowDefinitionV1,
  WorkflowBudgetExhaustedError,
  WorkflowInvalidTransitionError,
  type WorkflowRun,
  WorkflowRunError,
  type WorkflowScheduleWakeupParams,
  type WorkflowSchedulerPort,
  type WorkflowSnapshotV1,
  WorkflowUnsupportedBudgetError,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Public Versioned Service Protocol (pi-loop/service V1 Contract)
// ---------------------------------------------------------------------------

export const LOOP_SERVICE_VERSION = 1 as const;
export type LoopServiceVersion = typeof LOOP_SERVICE_VERSION;

/** Event-bus channel a consumer emits a discovery request on. */
export const LOOP_SERVICE_DISCOVER_CHANNEL = "pi-loop:service:discover:v1";

/** Prefix of the per-request reply channel. */
export const LOOP_SERVICE_REPLY_CHANNEL_PREFIX = "pi-loop:service:reply:v1:";

/** Event-bus channel a provider emits availability changes on. */
export const LOOP_SERVICE_CHANGED_CHANNEL = "pi-loop:service:changed:v1";

/** Default timeout for discovery requests in milliseconds. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_000;

/** Minimal subset of pi.events required for the discovery protocol. */
export interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): (() => void) | void;
}

export type LoopTaskMode = "fixed" | "self-paced" | "one-shot";

/** Frozen summary snapshot of a scheduled task in pi-loop. */
export interface LoopTaskSummary {
  readonly id: string;
  readonly mode: LoopTaskMode;
  readonly prompt: string;
  readonly maintenance: boolean;
  readonly intervalMs?: number;
  readonly cron?: string;
  readonly timeZone?: string;
  readonly nextFireAt?: number;
  readonly expiresAt?: number;
  readonly pending: boolean;
  readonly reason?: string;
}

export interface LoopScheduleOptions {
  readonly expiresAt?: number;
}

export interface LoopCronOptions extends LoopScheduleOptions {
  readonly timeZone?: string;
}

export interface LoopSelfPacedOptions extends LoopScheduleOptions {
  readonly fallbackDelayMs?: number;
}

export interface LoopServiceWakeupDecision {
  readonly requestedMs: number;
  readonly delayMs: number;
  readonly clamped: boolean;
  readonly nextFireAt: number;
  readonly reason?: string;
}

/**
 * Public versioned LoopServiceV1 contract provided by pi-loop.
 */
export interface LoopServiceV1 {
  readonly version: LoopServiceVersion;
  readonly sessionId: string;
  isAvailable(): boolean;
  scheduleFixed(intervalMs: number, prompt: string, options?: LoopScheduleOptions): LoopTaskSummary;
  scheduleCron(expression: string, prompt: string, options?: LoopCronOptions): LoopTaskSummary;
  scheduleOnce(at: number, prompt: string, options?: LoopScheduleOptions): LoopTaskSummary;
  scheduleSelfPaced(prompt: string, options?: LoopSelfPacedOptions): LoopTaskSummary;
  listTasks(): LoopTaskSummary[];
  deleteTask(id: string): boolean;
  scheduleTaskWakeup(id: string, delayMs: number, reason?: string): LoopServiceWakeupDecision;
  stopTask(id: string): boolean;
}

export class LoopServiceUnavailableError extends Error {
  readonly code = "loop-service-unavailable";
  constructor(message = "the pi-loop service for this session is no longer available") {
    super(message);
    this.name = "LoopServiceUnavailableError";
  }
}

export class LoopServiceInputError extends Error {
  readonly code = "loop-service-input";
  constructor(message: string) {
    super(message);
    this.name = "LoopServiceInputError";
  }
}

export type LoopServiceStatus =
  | { readonly version: LoopServiceVersion; readonly available: true; readonly sessionId: string }
  | { readonly version: LoopServiceVersion; readonly available: false; readonly reason: string };

export type LoopServiceDiscoveryResponse =
  | {
      readonly version: LoopServiceVersion;
      readonly available: true;
      readonly sessionId: string;
      readonly service: LoopServiceV1;
    }
  | { readonly version: LoopServiceVersion; readonly available: false; readonly reason: string };

export type LoopServiceDiscoveryFailure = "unavailable" | "timeout" | "invalid-response";

export type LoopServiceDiscovery =
  | { readonly ok: true; readonly service: LoopServiceV1 }
  | {
      readonly ok: false;
      readonly reason: LoopServiceDiscoveryFailure;
      readonly message: string;
    };

export interface DiscoverLoopServiceOptions {
  timeoutMs?: number;
  requestId?: () => string;
}

// ---------------------------------------------------------------------------
// Scheduler Error Classes
// ---------------------------------------------------------------------------

export class WorkflowSchedulerError extends WorkflowRunError {
  constructor(message: string, runId?: string) {
    super(message, runId);
    this.name = "WorkflowSchedulerError";
  }
}

export class WorkflowSchedulerUnavailableError extends WorkflowSchedulerError {
  constructor(message = "pi-loop scheduler service is not available in the current session.", runId?: string) {
    super(message, runId);
    this.name = "WorkflowSchedulerUnavailableError";
  }
}

export class WorkflowSchedulerTaskNotFoundError extends WorkflowSchedulerError {
  readonly taskId?: string;
  constructor(message: string, options?: { runId?: string; taskId?: string }) {
    super(message, options?.runId);
    this.name = "WorkflowSchedulerTaskNotFoundError";
    this.taskId = options?.taskId;
  }
}

// ---------------------------------------------------------------------------
// Protocol Validation Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isLoopServiceV1(value: unknown): value is LoopServiceV1 {
  if (!isRecord(value) || value.version !== LOOP_SERVICE_VERSION || typeof value.sessionId !== "string") {
    return false;
  }
  return (
    typeof value.isAvailable === "function" &&
    typeof value.scheduleFixed === "function" &&
    typeof value.scheduleCron === "function" &&
    typeof value.scheduleOnce === "function" &&
    typeof value.scheduleSelfPaced === "function" &&
    typeof value.listTasks === "function" &&
    typeof value.deleteTask === "function" &&
    typeof value.scheduleTaskWakeup === "function" &&
    typeof value.stopTask === "function"
  );
}

function parseStatus(data: unknown): LoopServiceStatus | undefined {
  if (!isRecord(data) || data.version !== LOOP_SERVICE_VERSION || typeof data.available !== "boolean") {
    return undefined;
  }
  if (data.available === false) {
    return typeof data.reason === "string"
      ? { version: LOOP_SERVICE_VERSION, available: false, reason: data.reason }
      : undefined;
  }
  return typeof data.sessionId === "string"
    ? { version: LOOP_SERVICE_VERSION, available: true, sessionId: data.sessionId }
    : undefined;
}

function parseDiscoveryResponse(data: unknown): LoopServiceDiscoveryResponse | undefined {
  const status = parseStatus(data);
  if (status === undefined) {
    return undefined;
  }
  if (!status.available) {
    return { version: LOOP_SERVICE_VERSION, available: false, reason: status.reason };
  }
  const service = isRecord(data) ? data.service : undefined;
  if (!isLoopServiceV1(service)) {
    return undefined;
  }
  return { version: LOOP_SERVICE_VERSION, available: true, sessionId: status.sessionId, service };
}

/**
 * Discover the active pi-loop service for the current session over pi.events.
 */
export function discoverLoopService(
  events: EventBusLike,
  options: DiscoverLoopServiceOptions = {}
): Promise<LoopServiceDiscovery> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const requestId = (options.requestId ?? (() => randomUUID()))();
  const replyChannel = `${LOOP_SERVICE_REPLY_CHANNEL_PREFIX}${requestId}`;

  return new Promise<LoopServiceDiscovery>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    const finish = (result: LoopServiceDiscovery): void => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const subscription = events.on(replyChannel, (data) => {
      const response = parseDiscoveryResponse(data);
      if (response === undefined) {
        finish({
          ok: false,
          reason: "invalid-response",
          message: "pi-loop replied with an unrecognized discovery response",
        });
        return;
      }
      if (!response.available) {
        finish({ ok: false, reason: "unavailable", message: response.reason });
        return;
      }
      finish({ ok: true, service: response.service });
    });

    if (typeof subscription === "function") {
      unsubscribe = subscription;
    }

    events.emit(LOOP_SERVICE_DISCOVER_CHANNEL, {
      version: LOOP_SERVICE_VERSION,
      requestId,
      replyChannel,
    });

    if (!settled) {
      timer = setTimeout(() => {
        finish({
          ok: false,
          reason: "timeout",
          message: `no pi-loop service replied within ${timeoutMs}ms`,
        });
      }, timeoutMs);
    }
  });
}

/**
 * Watch for pi-loop service availability broadcasts.
 */
export function onLoopServiceChange(
  events: EventBusLike,
  handler: (status: LoopServiceStatus) => void
): () => void {
  const subscription = events.on(LOOP_SERVICE_CHANGED_CHANNEL, (data) => {
    const status = parseStatus(data);
    if (status !== undefined) {
      handler(status);
    }
  });
  return typeof subscription === "function" ? subscription : () => {};
}

// ---------------------------------------------------------------------------
// Scheduler Adapter Options & Result Types
// ---------------------------------------------------------------------------

export interface ScheduleRunOptions {
  /** Optional custom initial prompt override (defaults to dispatcher.buildPrompt(run.id)) */
  prompt?: string;
  /** Explicit absolute expiry epoch ms */
  expiresAt?: number;
  /** Explicit absolute execution time for one-shot runs (epoch ms) */
  at?: number;
}

export interface StartRunOptions extends ScheduleRunOptions {
  /** Optional initial step */
  initialStep?: string;
  /** Initial workflow state */
  initialData?: Record<string, JsonValue>;
  /** Optional run-level budget override */
  budget?: WorkflowBudgetPolicy;
  /** Custom run ID */
  runId?: string;
  /** Concurrency resolution policy */
  existingPolicy?: "fail" | "returnExisting";
}

export interface ReconcileOptions {
  /** Whether to recreate missing scheduler tasks for active runs (default: true) */
  recreateMissing?: boolean;
  /** Whether to delete/stop orphan scheduler tasks with no live run (default: true) */
  reconcileOrphans?: boolean;
}

export interface WorkflowSchedulerDiagnostic {
  type: "error" | "warning";
  code: string;
  message: string;
  runId?: string;
  taskId?: string;
}

export interface WorkflowBeforeAgentStartResult {
  message?: {
    customType: string;
    content: Array<{ type: "text"; text: string }>;
    display: boolean;
    details?: unknown;
  };
  systemPrompt?: string;
}

export interface ReconcileResult {
  matched: Array<{ runId: string; taskId: string }>;
  recreated: Array<{ runId: string; oldTaskId?: string; newTaskId: string }>;
  blocked: Array<{ runId: string; reason: string }>;
  orphans: Array<{ taskId: string; runId?: string; stopped: boolean }>;
  diagnostics: WorkflowSchedulerDiagnostic[];
}

export interface LoopSchedulerAdapterOptions {
  registry: WorkflowRunRegistry;
  dispatcher: WorkflowDispatcher;
  service?: LoopServiceV1;
  events?: EventBusLike;
  discoveryTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// LoopSchedulerAdapter Implementation
// ---------------------------------------------------------------------------

/**
 * LoopSchedulerAdapter bridges pi-workflow to the versioned pi-loop scheduling service.
 * Handles task scheduling across self-paced, fixed, cron, and one-shot modes,
 * runId ↔ loopTaskId linkage, prompt dispatch correlation, and authoritative reconciliation.
 */
export class LoopSchedulerAdapter {
  private registry: WorkflowRunRegistry;
  private dispatcher: WorkflowDispatcher;
  private service?: LoopServiceV1;
  private events?: EventBusLike;
  private unsubscribeChange?: () => void;
  private discoveryTimeoutMs: number;

  private runToTaskMap = new Map<string, string>();
  private taskToRunMap = new Map<string, string>();
  private pendingTurnRunId?: string;

  constructor(options: LoopSchedulerAdapterOptions) {
    this.registry = options.registry;
    this.dispatcher = options.dispatcher;
    this.service = options.service;
    this.events = options.events;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;

    if (this.events) {
      this.bindEvents(this.events);
    }
  }

  /**
   * Returns true if attached to an active, valid session service generation.
   */
  isAvailable(): boolean {
    return this.service !== undefined && this.service.isAvailable();
  }

  /**
   * Returns the attached service handle if one is present.
   */
  getService(): LoopServiceV1 | undefined {
    return this.service;
  }

  /**
   * Directly attaches an authoritative LoopServiceV1 instance (e.g. from discovery or testing).
   */
  attachService(service: LoopServiceV1): void {
    this.service = service;
  }

  /**
   * Detaches the current service instance, invalidating scheduler operations.
   */
  detachService(): void {
    this.service = undefined;
    if (this.unsubscribeChange) {
      this.unsubscribeChange();
      this.unsubscribeChange = undefined;
    }
  }

  /**
   * Binds to an event bus to observe service availability broadcasts.
   */
  bindEvents(events: EventBusLike): void {
    if (this.unsubscribeChange) {
      this.unsubscribeChange();
    }
    this.events = events;
    this.unsubscribeChange = onLoopServiceChange(events, (status) => {
      if (!status.available) {
        if (this.service) {
          this.service = undefined;
        }
      }
    });
  }

  /**
   * Performs dynamic service discovery over the configured or provided event bus.
   */
  async discover(events?: EventBusLike, options?: DiscoverLoopServiceOptions): Promise<LoopServiceDiscovery> {
    const bus = events ?? this.events;
    if (!bus) {
      return {
        ok: false,
        reason: "unavailable",
        message: "No event bus available for pi-loop discovery",
      };
    }

    const discovery = await discoverLoopService(bus, {
      timeoutMs: options?.timeoutMs ?? this.discoveryTimeoutMs,
      requestId: options?.requestId,
    });

    if (discovery.ok) {
      this.attachService(discovery.service);
    }
    return discovery;
  }

  private assertServiceAvailable(runId?: string): LoopServiceV1 {
    if (!this.service || !this.service.isAvailable()) {
      throw new WorkflowSchedulerUnavailableError(
        "pi-loop scheduler service is unavailable for this session. Cannot perform scheduling operations.",
        runId
      );
    }
    return this.service;
  }

  /**
   * Returns linked scheduler taskId for a workflow runId.
   */
  getLinkedTaskId(runId: string): string | undefined {
    return this.runToTaskMap.get(runId) ?? this.registry.getRun(runId)?.loopTaskId;
  }

  /**
   * Returns linked workflow runId for a scheduler taskId.
   */
  getLinkedRunId(taskId: string): string | undefined {
    return this.taskToRunMap.get(taskId);
  }

  /**
   * Schedules a task in pi-loop for an existing workflow run based on its definition mode and schedule.
   * Updates the run record and internal maps with the newly allocated loopTaskId.
   */
  async scheduleRun(
    runOrId: string | WorkflowRun,
    options: ScheduleRunOptions = {}
  ): Promise<LoopTaskSummary> {
    const run = typeof runOrId === "string" ? this.registry.requireRun(runOrId) : runOrId;
    const service = this.assertServiceAvailable(run.id);

    if (run.lifecycle !== "active" && run.lifecycle !== "verifying") {
      throw new WorkflowInvalidTransitionError(
        run.id,
        `Cannot schedule scheduler task for run "${run.id}" in lifecycle "${run.lifecycle}". Run must be active.`,
        { fromLifecycle: run.lifecycle, action: "schedule" }
      );
    }

    // Check hard budget limits before scheduling
    const exhaustion = checkRunBudgetExhaustion(run);
    if (exhaustion.exhausted) {
      const budgetPolicy = run.budget ?? run.snapshot.budget;
      if (budgetPolicy?.onExhaustion === "cancel") {
        this.registry.cancelRun(run.id, { reason: exhaustion.reason });
      } else {
        this.registry.blockRun(run.id, {
          reason: exhaustion.reason!,
          category: "human-required",
          requiresHuman: true,
        });
      }
      throw new WorkflowBudgetExhaustedError(
        `Cannot schedule task for run "${run.id}": ${exhaustion.reason}`,
        { runId: run.id, dimension: exhaustion.dimension, limit: exhaustion.limit, actual: exhaustion.actual }
      );
    }

    // Idempotency: check if run already has a live scheduled task in pi-loop
    const existingTaskId = this.runToTaskMap.get(run.id) ?? run.loopTaskId;
    if (existingTaskId) {
      const liveTasks = service.listTasks();
      const existing = liveTasks.find((t) => t.id === existingTaskId);
      if (existing) {
        return existing;
      }
    }

    const snapshot = run.snapshot;
    const prompt = options.prompt ?? this.dispatcher.buildPrompt(run.id);

    // Calculate absolute expiry if specified in budget
    let expiresAt = options.expiresAt;
    if (expiresAt === undefined && snapshot.budget?.maxDurationMs !== undefined) {
      expiresAt = (run.startedAt ?? run.createdAt) + snapshot.budget.maxDurationMs;
    }

    let task: LoopTaskSummary;
    try {
      if (snapshot.mode === "self-paced") {
        let fallbackDelayMs: number | undefined;
        if (snapshot.wakeups?.defaultMs !== undefined) {
          fallbackDelayMs = snapshot.wakeups.defaultMs;
        } else if (snapshot.wakeups?.default) {
          fallbackDelayMs = parseDuration(snapshot.wakeups.default, "wakeups.default");
        }
        task = service.scheduleSelfPaced(prompt, { fallbackDelayMs, expiresAt });
      } else if (snapshot.mode === "fixed") {
        let intervalMs: number | undefined;
        if (snapshot.schedule?.intervalMs !== undefined) {
          intervalMs = snapshot.schedule.intervalMs;
        } else if (snapshot.schedule?.interval) {
          intervalMs = parseDuration(snapshot.schedule.interval, "schedule.interval");
        } else {
          intervalMs = 60_000;
        }
        task = service.scheduleFixed(intervalMs, prompt, { expiresAt });
      } else if (snapshot.mode === "cron") {
        const cron = snapshot.schedule?.cron;
        if (!cron) {
          throw new WorkflowSchedulerError(
            `Workflow "${snapshot.name}" specifies cron mode but lacks schedule.cron expression.`,
            run.id
          );
        }
        task = service.scheduleCron(cron, prompt, {
          timeZone: snapshot.schedule?.timeZone,
          expiresAt,
        });
      } else if (snapshot.mode === "once") {
        let at = options.at;
        if (at === undefined) {
          if (snapshot.schedule?.at) {
            at = new Date(snapshot.schedule.at).getTime();
          } else if (snapshot.schedule?.delayMs !== undefined) {
            at = Date.now() + snapshot.schedule.delayMs;
          } else if (snapshot.schedule?.delay) {
            at = Date.now() + parseDuration(snapshot.schedule.delay, "schedule.delay");
          } else {
            at = Date.now() + 60_000;
          }
        }
        task = service.scheduleOnce(at, prompt, { expiresAt });
      } else {
        throw new WorkflowSchedulerError(
          `Unsupported workflow scheduling mode "${snapshot.mode}" for run "${run.id}".`,
          run.id
        );
      }
    } catch (error) {
      if (error instanceof LoopServiceUnavailableError) {
        throw new WorkflowSchedulerUnavailableError(error.message, run.id);
      }
      throw error;
    }

    // Persist linkage
    this.runToTaskMap.set(run.id, task.id);
    this.taskToRunMap.set(task.id, run.id);
    this.registry.updateRun(run.id, { loopTaskId: task.id });

    return task;
  }

  /**
   * Atomically creates a workflow run from definition/snapshot and schedules its task in pi-loop.
   * If scheduling fails, safely rolls back the run.
   */
  async startRun(
    definitionOrSnapshot: WorkflowDefinitionV1 | WorkflowSnapshotV1,
    options: StartRunOptions = {}
  ): Promise<{ run: WorkflowRun; task: LoopTaskSummary }> {
    // Assert scheduler service is available before creating any run record
    this.assertServiceAvailable();

    const snapshot =
      "snapshot" in definitionOrSnapshot
        ? ((definitionOrSnapshot as any).snapshot as WorkflowSnapshotV1)
        : (definitionOrSnapshot as WorkflowSnapshotV1);

    const budget = options.budget ?? snapshot.budget;
    if (budget?.maxCost !== undefined) {
      throw new WorkflowUnsupportedBudgetError(
        snapshot.name,
        "maxCost",
        `Workflow "${snapshot.name}" specifies budget dimension "maxCost", which is unsupported because Pi runtime does not expose authoritative cost accounting data.`
      );
    }
    if ((budget as any)?.maxTokens !== undefined) {
      throw new WorkflowUnsupportedBudgetError(
        snapshot.name,
        "maxTokens",
        `Workflow "${snapshot.name}" specifies budget dimension "maxTokens", which is unsupported because Pi runtime does not expose authoritative token accounting data.`
      );
    }

    const run = this.registry.createRun(definitionOrSnapshot, options);
    try {
      const task = await this.scheduleRun(run, options);
      return { run: this.registry.requireRun(run.id), task };
    } catch (error) {
      // Rollback newly created un-scheduled run
      try {
        this.registry.cancelRun(run.id, {
          reason: `Failed to schedule task in pi-loop: ${error instanceof Error ? error.message : String(error)}`,
        });
      } catch {
        // Ignore rollback errors
      }
      throw error;
    }
  }

  /**
   * Reschedules the next wakeup for a self-paced workflow run.
   * Implements WorkflowSchedulerPort.scheduleWakeup.
   */
  async scheduleWakeup(params: WorkflowScheduleWakeupParams): Promise<LoopServiceWakeupDecision> {
    const { runId, delayMs, reason } = params;
    const service = this.assertServiceAvailable(runId);
    const taskId = this.getLinkedTaskId(runId);

    if (!taskId) {
      throw new WorkflowSchedulerTaskNotFoundError(
        `Cannot schedule wakeup: workflow run "${runId}" has no linked scheduler task ID.`,
        { runId }
      );
    }

    const run = this.registry.getRun(runId);
    if (run) {
      const exhaustion = checkRunBudgetExhaustion(run);
      if (exhaustion.exhausted) {
        const budgetPolicy = run.budget ?? run.snapshot.budget;
        if (budgetPolicy?.onExhaustion === "cancel") {
          this.registry.cancelRun(run.id, { reason: exhaustion.reason });
        } else {
          this.registry.blockRun(run.id, {
            reason: exhaustion.reason!,
            category: "human-required",
            requiresHuman: true,
          });
        }
        await this.cancelWakeup(runId);
        throw new WorkflowBudgetExhaustedError(
          `Cannot schedule wakeup for run "${runId}": ${exhaustion.reason}`,
          { runId, dimension: exhaustion.dimension, limit: exhaustion.limit, actual: exhaustion.actual }
        );
      }
    }

    try {
      return service.scheduleTaskWakeup(taskId, delayMs, reason);
    } catch (error) {
      if (error instanceof LoopServiceUnavailableError) {
        throw new WorkflowSchedulerUnavailableError(error.message, runId);
      }
      throw error;
    }
  }

  /**
   * Cancels the scheduled task for a workflow run.
   * Implements WorkflowSchedulerPort.cancelWakeup.
   * Fails closed if the scheduler is unavailable or if stopping a live task fails.
   * If the task is already confirmed absent from authoritative scheduler state (listTasks),
   * clears stale linkage so pause/stop are not blocked forever.
   * Maintains internal mappings on failure, and clears internal maps and durable linkage on success.
   */
  async cancelWakeup(runId: string): Promise<boolean> {
    const service = this.assertServiceAvailable(runId);
    const taskId = this.getLinkedTaskId(runId);
    if (!taskId) {
      return true;
    }

    let stopped: boolean;
    try {
      stopped = service.stopTask(taskId);
    } catch (error) {
      if (error instanceof LoopServiceUnavailableError) {
        throw new WorkflowSchedulerUnavailableError(error.message, runId);
      }
      throw new WorkflowSchedulerError(
        `Failed to stop scheduler task "${taskId}" for run "${runId}": ${error instanceof Error ? error.message : String(error)}`,
        runId
      );
    }

    if (!stopped) {
      // Check authoritative scheduler tasks to verify whether task is already absent
      let liveTasks: LoopTaskSummary[] = [];
      try {
        liveTasks = service.listTasks();
      } catch (listErr) {
        if (listErr instanceof LoopServiceUnavailableError) {
          throw new WorkflowSchedulerUnavailableError(listErr.message, runId);
        }
        throw new WorkflowSchedulerError(
          `Failed to verify scheduler task "${taskId}" status for run "${runId}": ${listErr instanceof Error ? listErr.message : String(listErr)}`,
          runId
        );
      }

      const taskStillPresent = liveTasks.some((t) => t.id === taskId);
      if (taskStillPresent) {
        // Task is still live in scheduler service, but stopTask failed to stop it. Fail closed!
        throw new WorkflowSchedulerError(
          `Failed to stop scheduler task "${taskId}" for run "${runId}": task is still active in scheduler service but could not be stopped.`,
          runId
        );
      }
      // If task is confirmed absent from scheduler, the linkage was stale.
      // Clear the stale linkage below so pause and stop are not blocked forever.
    }

    // Success or stale linkage confirmed absent: delete in-memory maps and clear durable linkage in registry
    this.runToTaskMap.delete(runId);
    this.taskToRunMap.delete(taskId);

    if (this.registry.hasRun(runId)) {
      const current = this.registry.getRun(runId);
      if (current && !isTerminalLifecycle(current.lifecycle)) {
        this.registry.updateRun(runId, { loopTaskId: null });
      }
    }

    return true;
  }

  /**
   * Returns a WorkflowSchedulerPort instance bound to the specified run ID.
   */
  getSchedulerPort(runId: string): WorkflowSchedulerPort {
    return {
      scheduleWakeup: async (params) => {
        await this.scheduleWakeup(params);
      },
      cancelWakeup: async (targetRunId) => {
        await this.cancelWakeup(targetRunId);
      },
    };
  }

  /**
   * Reconciles authoritative tasks from pi-loop with workflow runs in WorkflowRunRegistry.
   * Handles re-linking, recreating missing active self-paced tasks, and clearing orphan workflow tasks.
   * Ordinary user `/loop` tasks and unrelated tasks are strictly preserved without interference.
   */
  async reconcile(options: ReconcileOptions = {}): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      matched: [],
      recreated: [],
      blocked: [],
      orphans: [],
      diagnostics: [],
    };

    if (!this.service || !this.service.isAvailable()) {
      result.diagnostics.push({
        type: "warning",
        code: "scheduler-unavailable",
        message: "Cannot reconcile workflow scheduler tasks: pi-loop service is unavailable.",
      });
      return result;
    }

    let tasks: LoopTaskSummary[];
    try {
      tasks = this.service.listTasks();
    } catch (error) {
      result.diagnostics.push({
        type: "error",
        code: "list-tasks-failed",
        message: `Failed to list tasks from pi-loop service: ${error instanceof Error ? error.message : String(error)}`,
      });
      return result;
    }

    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const claimedTaskIds = new Set<string>();

    // Index tasks by prompt runId to detect ambiguous / duplicate mappings
    const tasksByRunId = new Map<string, LoopTaskSummary[]>();
    for (const task of tasks) {
      const promptRunId = extractWorkflowRunId(task.prompt);
      if (promptRunId) {
        const list = tasksByRunId.get(promptRunId) ?? [];
        list.push(task);
        tasksByRunId.set(promptRunId, list);
      }
    }

    // 1. Reconcile terminal runs: terminal runs must NOT retain live scheduler tasks
    const allRuns = this.registry.listRuns();
    for (const run of allRuns) {
      if (isTerminalLifecycle(run.lifecycle)) {
        const taskList = tasksByRunId.get(run.id) ?? [];
        const existingTaskId = run.loopTaskId;
        if (existingTaskId && taskMap.has(existingTaskId) && !taskList.some((t) => t.id === existingTaskId)) {
          taskList.push(taskMap.get(existingTaskId)!);
        }

        for (const t of taskList) {
          let stopped = false;
          try {
            stopped = this.service.deleteTask(t.id);
          } catch (err) {
            result.diagnostics.push({
              type: "warning",
              code: "terminal-task-stop-failed",
              message: `Failed to stop task "${t.id}" for terminal run "${run.id}": ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          this.runToTaskMap.delete(run.id);
          this.taskToRunMap.delete(t.id);
          claimedTaskIds.add(t.id);
          result.orphans.push({ taskId: t.id, runId: run.id, stopped });
        }
      }
    }

    // 2. Reconcile nonterminal runs from registry
    const nonterminalRuns = this.registry.getNonterminalRuns();
    for (const run of nonterminalRuns) {
      const existingTaskId = run.loopTaskId;
      const matchingTasks = tasksByRunId.get(run.id) ?? [];

      // Check for ambiguous mapping: multiple tasks claiming the same run ID
      if (matchingTasks.length > 1) {
        const reason = `Ambiguous scheduler task mapping: multiple live tasks [${matchingTasks.map((t) => t.id).join(", ")}] found for run "${run.id}". Blocked to prevent duplicate execution.`;
        if (run.lifecycle === "active" || run.lifecycle === "verifying") {
          this.registry.blockRun(run.id, {
            reason,
            category: "human-required",
            requiresHuman: true,
          });
          result.blocked.push({ runId: run.id, reason });
        }
        for (const t of matchingTasks) {
          try {
            this.service.deleteTask(t.id);
          } catch {
            // ignore
          }
          claimedTaskIds.add(t.id);
        }
        this.runToTaskMap.delete(run.id);
        if (existingTaskId) this.taskToRunMap.delete(existingTaskId);
        try {
          this.registry.recordRecoveryEvent(run.id, {
            type: "scheduler_ambiguous",
            message: reason,
            details: { taskIds: matchingTasks.map((t) => t.id) as any },
          });
        } catch {
          // ignore
        }
        continue;
      }

      // Check for mismatched linkage: run.loopTaskId points to a task belonging to a different run
      if (existingTaskId && taskMap.has(existingTaskId)) {
        const declaredRunId = extractWorkflowRunId(taskMap.get(existingTaskId)!.prompt);
        if (declaredRunId && declaredRunId !== run.id) {
          const reason = `Ambiguous scheduler task mapping: task "${existingTaskId}" belongs to run "${declaredRunId}", but run "${run.id}" links to it.`;
          if (run.lifecycle === "active" || run.lifecycle === "verifying") {
            this.registry.blockRun(run.id, { reason, category: "human-required", requiresHuman: true });
            result.blocked.push({ runId: run.id, reason });
          }
          this.runToTaskMap.delete(run.id);
          this.taskToRunMap.delete(existingTaskId);
          try {
            this.registry.recordRecoveryEvent(run.id, {
              type: "scheduler_ambiguous",
              message: reason,
            });
          } catch {
            // ignore
          }
          continue;
        }
      }

      // Check hard budget exhaustion
      const exhaustion = checkRunBudgetExhaustion(run);
      if (exhaustion.exhausted) {
        if (existingTaskId && taskMap.has(existingTaskId)) {
          try {
            this.service.deleteTask(existingTaskId);
          } catch {
            // ignore
          }
          this.runToTaskMap.delete(run.id);
          this.taskToRunMap.delete(existingTaskId);
        }
        if (run.lifecycle === "active" || run.lifecycle === "verifying") {
          const reason = exhaustion.reason!;
          const budgetPolicy = run.budget ?? run.snapshot.budget;
          if (budgetPolicy?.onExhaustion === "cancel") {
            this.registry.cancelRun(run.id, { reason });
          } else {
            this.registry.blockRun(run.id, {
              reason,
              category: "human-required",
              requiresHuman: true,
            });
            result.blocked.push({ runId: run.id, reason });
          }
        }
        continue;
      }

      // Paused runs: must NOT have active scheduler task
      if (run.lifecycle === "paused") {
        if (existingTaskId && taskMap.has(existingTaskId)) {
          try {
            this.service.deleteTask(existingTaskId);
          } catch {
            // ignore
          }
          this.runToTaskMap.delete(run.id);
          this.taskToRunMap.delete(existingTaskId);
        }
        continue;
      }

      // Blocked runs: human-required or terminal must NOT have active scheduler task
      if (run.lifecycle === "blocked") {
        const isRetryable = run.blocker?.category === "external-retryable";
        if (!isRetryable) {
          if (existingTaskId && taskMap.has(existingTaskId)) {
            try {
              this.service.deleteTask(existingTaskId);
            } catch {
              // ignore
            }
            this.runToTaskMap.delete(run.id);
            this.taskToRunMap.delete(existingTaskId);
          }
          continue;
        } else {
          // external-retryable may keep its live task if matched
          if (existingTaskId && taskMap.has(existingTaskId)) {
            this.runToTaskMap.set(run.id, existingTaskId);
            this.taskToRunMap.set(existingTaskId, run.id);
            claimedTaskIds.add(existingTaskId);
            result.matched.push({ runId: run.id, taskId: existingTaskId });
          }
          continue;
        }
      }

      if (existingTaskId && taskMap.has(existingTaskId)) {
        // Live matching task
        this.runToTaskMap.set(run.id, existingTaskId);
        this.taskToRunMap.set(existingTaskId, run.id);
        claimedTaskIds.add(existingTaskId);
        result.matched.push({ runId: run.id, taskId: existingTaskId });
      } else if (run.lifecycle === "active" || run.lifecycle === "verifying") {
        // Active run missing its scheduler task (e.g. after reload where ephemeral self-paced task was dropped)
        if (options.recreateMissing !== false) {
          try {
            const newTask = await this.scheduleRun(run);
            claimedTaskIds.add(newTask.id);
            result.recreated.push({
              runId: run.id,
              oldTaskId: existingTaskId,
              newTaskId: newTask.id,
            });
            try {
              this.registry.recordRecoveryEvent(run.id, {
                type: "scheduler_recreated",
                message: `Recreated missing scheduler task for active run "${run.id}".`,
                details: { oldTaskId: (existingTaskId ?? null) as any, newTaskId: newTask.id as any },
              });
            } catch {
              // ignore
            }
          } catch (err) {
            const reason = `Failed to recreate missing scheduler task: ${err instanceof Error ? err.message : String(err)}`;
            this.registry.blockRun(run.id, { reason, category: "human-required", requiresHuman: true });
            result.blocked.push({ runId: run.id, reason });
            result.diagnostics.push({
              type: "error",
              code: "recreation-failed",
              message: reason,
              runId: run.id,
            });
          }
        } else {
          const reason = "Linked scheduler task lost during recovery and recreation is disabled.";
          this.registry.blockRun(run.id, { reason, category: "human-required", requiresHuman: true });
          result.blocked.push({ runId: run.id, reason });
        }
      } else {
        // Blocked or paused run missing task is normal
        if (existingTaskId) {
          this.runToTaskMap.delete(run.id);
          this.taskToRunMap.delete(existingTaskId);
        }
      }
    }


    // 2. Identify orphan workflow tasks in pi-loop
    for (const task of tasks) {
      if (claimedTaskIds.has(task.id)) {
        continue;
      }

      // Check if prompt belongs to a workflow execution
      const runId = extractWorkflowRunId(task.prompt);
      if (!runId) {
        // User /loop task or ordinary non-workflow task: NEVER touch
        continue;
      }

      const run = this.registry.getRun(runId);
      const isOrphan = !run || run.lifecycle === "completed" || run.lifecycle === "cancelled";

      if (isOrphan) {
        let stopped = false;
        if (options.reconcileOrphans !== false) {
          try {
            stopped = this.service.deleteTask(task.id);
          } catch (err) {
            result.diagnostics.push({
              type: "warning",
              code: "orphan-stop-failed",
              message: `Failed to delete orphan task "${task.id}": ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
        result.orphans.push({ taskId: task.id, runId, stopped });
      }
    }

    return result;
  }

  /**
   * Lifecycle hook: inspects outgoing prompt before agent start.
   * If prompt belongs to an active workflow run, records run ID for turn binding
   * and returns a fresh, deterministic iteration prompt containing current step,
   * counters, and run data to append to the turn context.
   */
  handleBeforeAgentStart(
    event: { prompt: string; systemPromptOptions?: unknown },
    _ctx?: unknown
  ): WorkflowBeforeAgentStartResult | undefined {
    const runId = extractWorkflowRunId(event.prompt);
    if (!runId) {
      return undefined;
    }
    const run = this.registry.getRun(runId);
    if (!run || (run.lifecycle !== "active" && run.lifecycle !== "verifying")) {
      return undefined;
    }

    const exhaustion = checkRunBudgetExhaustion(run);
    if (exhaustion.exhausted) {
      const reason = exhaustion.reason!;
      const budgetPolicy = run.budget ?? run.snapshot.budget;
      if (budgetPolicy?.onExhaustion === "cancel") {
        this.registry.cancelRun(run.id, { reason });
      } else {
        this.registry.blockRun(run.id, { reason, category: "human-required", requiresHuman: true });
      }
      this.cancelWakeup(run.id).catch(() => {});
      return undefined;
    }

    this.pendingTurnRunId = runId;

    // Generate fresh, deterministic prompt reflecting current run state, step, turn counters, and data
    const freshPrompt = this.dispatcher.buildPrompt(run.id);

    return {
      message: {
        customType: "workflow_iteration_prompt",
        content: [{ type: "text", text: freshPrompt }],
        display: false,
        details: {
          runId: run.id,
          workflow: run.workflow,
          step: run.step,
          turns: run.turns,
          attempts: run.attempts,
          lifecycle: run.lifecycle,
          data: run.data,
        },
      },
    };
  }

  /**
   * Lifecycle hook: binds ephemeral iteration turn with authoritative per-turn AbortSignal.
   */
  handleTurnStart(ctx: { signal?: AbortSignal }, prompt?: string): IterationBinding | undefined {
    let runId = this.pendingTurnRunId;
    if (!runId && prompt) {
      runId = extractWorkflowRunId(prompt);
    }
    this.pendingTurnRunId = undefined;

    if (!runId) {
      return undefined;
    }

    const run = this.registry.getRun(runId);
    if (!run || (run.lifecycle !== "active" && run.lifecycle !== "verifying")) {
      return undefined;
    }

    const exhaustion = checkRunBudgetExhaustion(run);
    if (exhaustion.exhausted) {
      return undefined;
    }

    return this.dispatcher.beginIteration(run.id, {
      signal: ctx.signal,
      schedulerPort: this.getSchedulerPort(run.id),
    });
  }

  /**
   * Lifecycle hook: cleans up iteration binding and pending turns on settle.
   */
  handleAgentSettled(): void {
    this.pendingTurnRunId = undefined;
    this.dispatcher.clearActiveIteration("agent_settled");
  }

  /**
   * Programmatic dispatch helper: dispatches an iteration turn with an AbortSignal.
   */
  dispatchIteration(runId: string, options: DispatchIterationOptions = {}): IterationBinding {
    return this.dispatcher.beginIteration(runId, {
      schedulerPort: this.getSchedulerPort(runId),
      ...options,
    });
  }
}
