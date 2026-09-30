/**
 * Workflow Spec v1 Type Definitions
 */

import type { ALLOWED_WORKFLOW_MODES, WORKFLOW_SCHEMA_VERSION } from "./constants.ts";

export type WorkflowMode = (typeof ALLOWED_WORKFLOW_MODES)[number];

export interface WorkflowScheduleConfig {
  /** Cadence interval as a duration string (e.g., "30m", "2h") */
  interval?: string;
  /** Cadence interval in milliseconds */
  intervalMs?: number;
  /** Standard 5-field cron expression */
  cron?: string;
  /** One-time execution delay as duration string */
  delay?: string;
  /** One-time execution delay in milliseconds */
  delayMs?: number;
  /** One-time absolute ISO timestamp */
  at?: string;
  /** IANA timezone for cron */
  timeZone?: string;
}

export interface WorkflowConcurrencyPolicy {
  /** Maximum concurrent runs of this workflow (must be >= 1) */
  maxRuns: number;
}

export interface WorkflowBudgetPolicy {
  /** Maximum workflow turns/iterations */
  maxTurns?: number;
  /** Maximum wall-clock duration as string (e.g. "8h", "30m") */
  maxDuration?: string;
  /** Maximum wall-clock duration in milliseconds */
  maxDurationMs?: number;
  /** Maximum implementation/retry attempts */
  maxAttempts?: number;
  /** Optional monetary or cost limit */
  maxCost?: number;
}

export interface WorkflowWakeupPolicy {
  /** Default wakeup delay as duration string (e.g. "5m") */
  default?: string;
  /** Default wakeup delay in milliseconds */
  defaultMs?: number;
  /** Minimum wakeup delay as duration string */
  min?: string;
  /** Minimum wakeup delay in milliseconds */
  minMs?: number;
  /** Maximum wakeup delay as duration string */
  max?: string;
  /** Maximum wakeup delay in milliseconds */
  maxMs?: number;
  /** Named wakeup delays (e.g. { idle: "15m", retry: "1m" }) */
  named?: Record<string, string>;
  /** Named wakeup delays in milliseconds */
  namedMs?: Record<string, number>;
  /** Additional named wakeups directly on the wakeups object */
  [key: string]: unknown;
}

export interface WorkflowCompletionPolicy {
  /** Whether a completion summary is required */
  requireSummary?: boolean;
  /** Whether evidence items are required */
  requireEvidence?: boolean;
  /** Whether an independent verification iteration must be performed before marking complete */
  verify?: boolean;
  /** Prompt template or instructions for verification */
  verifierPrompt?: string;
  /** Maximum allowed verification attempts */
  maxVerificationAttempts?: number;
}

export type WorkflowScope = "project" | "user" | "explicit";

export interface WorkflowSourceIdentity {
  /** Absolute filesystem path to the workflow definition file */
  path: string;
  /** Scope of definition (project-local, user-global, or explicit path) */
  scope: WorkflowScope;
  /** Path relative to root or scope directory */
  relativePath?: string;
  /** SHA-256 hex digest of the raw file content */
  sha256: string;
  /** ISO-8601 timestamp when loaded */
  loadedAt: string;
}

export interface WorkflowDefinitionV1 {
  /** Schema version */
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  /** Unique workflow name identifier */
  name: string;
  /** Human-readable workflow description */
  description: string;
  /** Workflow scheduling mode */
  mode: WorkflowMode;
  /** Scheduling configuration when applicable */
  schedule?: WorkflowScheduleConfig;
  /** Concurrency control policy */
  concurrency: WorkflowConcurrencyPolicy;
  /** Run budget policy */
  budget: WorkflowBudgetPolicy;
  /** Timing/wakeup delay policy */
  wakeups: WorkflowWakeupPolicy;
  /** Required capability dependencies */
  requires: string[];
  /** Optional completion and verification gate policy */
  completion?: WorkflowCompletionPolicy;
  /** Optional arbitrary metadata */
  metadata?: Record<string, unknown>;
  /** Byte-for-byte preserved Markdown prompt and policy body */
  body: string;
  /** Source identity and provenance */
  source: WorkflowSourceIdentity;
}

export type DeepReadonly<T> = T extends (infer R)[]
  ? ReadonlyArray<DeepReadonly<R>>
  : T extends Function
  ? T
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export interface WorkflowSnapshotV1 {
  readonly schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly definition: DeepReadonly<WorkflowDefinitionV1>;
  readonly source: DeepReadonly<WorkflowSourceIdentity>;
  readonly name: string;
  readonly description: string;
  readonly mode: WorkflowMode;
  readonly schedule?: DeepReadonly<WorkflowScheduleConfig>;
  readonly concurrency: DeepReadonly<WorkflowConcurrencyPolicy>;
  readonly budget: DeepReadonly<WorkflowBudgetPolicy>;
  readonly wakeups: DeepReadonly<WorkflowWakeupPolicy>;
  readonly requires: ReadonlyArray<string>;
  readonly completion?: DeepReadonly<WorkflowCompletionPolicy>;
  readonly metadata?: DeepReadonly<Record<string, unknown>>;
  readonly body: string;
}

export interface WorkflowDiagnostic {
  type: "error" | "warning";
  path: string;
  field?: string;
  message: string;
}

export class WorkflowValidationError extends Error {
  readonly path: string;
  readonly field?: string;
  readonly diagnostics: WorkflowDiagnostic[];

  constructor(message: string, path: string, field?: string, diagnostics: WorkflowDiagnostic[] = []) {
    super(message);
    this.name = "WorkflowValidationError";
    this.path = path;
    this.field = field;
    this.diagnostics = diagnostics.length > 0 ? diagnostics : [{ type: "error", path, field, message }];
  }
}

// ---------------------------------------------------------------------------
// Workflow Run & Persistence Types (Issue #2)
// ---------------------------------------------------------------------------

/** JSON-safe primitive types */
export type JsonPrimitive = string | number | boolean | null;

/** Bounded JSON-safe value type */
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Generic workflow run execution lifecycle */
export type WorkflowRunLifecycle =
  | "active"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled";

/** Structured evidence reference for workflow completion */
export interface WorkflowEvidence {
  /** Evidence category e.g. "pr", "commit", "url", "test", "file" */
  type: string;
  /** Human-readable explanation of this evidence */
  description: string;
  /** Web or PR URL if applicable */
  url?: string;
  /** Local filesystem path if applicable */
  path?: string;
  /** Optional JSON-safe structured metadata */
  data?: Record<string, JsonValue>;
}

/** Information attached to a blocked workflow run */
export interface WorkflowBlockerInfo {
  /** Concrete reason why the run is blocked */
  reason: string;
  /** Whether human intervention/decision is required to unblock */
  requiresHuman?: boolean;
  /** Timestamp when blocked (Unix epoch ms) */
  blockedAt: number;
}

/** Completion record for a successful workflow run */
export interface WorkflowCompletionInfo {
  /** Executive summary of work performed and outcomes */
  summary: string;
  /** Structured verification or outcome evidence */
  evidence: WorkflowEvidence[];
  /** Timestamp when completed (Unix epoch ms) */
  completedAt: number;
}

/**
 * Concrete, durable workflow execution record.
 */
export interface WorkflowRun {
  /** Stable unique run identifier */
  readonly id: string;
  /** Workflow definition name */
  readonly workflow: string;
  /** Version number or string of the workflow definition */
  readonly definitionVersion: number | string;
  /** Source identity or path of the definition */
  readonly definitionSource: string;
  /** Immutable definition snapshot */
  readonly snapshot: WorkflowSnapshotV1;

  /** Generic lifecycle status (active, paused, blocked, completed, cancelled) */
  readonly lifecycle: WorkflowRunLifecycle;
  /** Current workflow-specific execution step (e.g., WAITING_CI, IMPLEMENTING) */
  readonly step: string;

  /** Timestamp created (Unix epoch ms) */
  readonly createdAt: number;
  /** Timestamp last updated (Unix epoch ms) */
  readonly updatedAt: number;
  /** Timestamp when execution started (Unix epoch ms) */
  readonly startedAt?: number;
  /** Timestamp when execution ended (completed or cancelled) */
  readonly completedAt?: number;

  /** Linkage to scheduled task or loop task ID if managed by scheduler */
  readonly loopTaskId?: string;

  /** Number of retry or execution attempts */
  readonly attempts: number;
  /** Number of agent turns or iterations completed */
  readonly turns: number;

  /** Bounded JSON-safe workflow-specific key/value state */
  readonly data: Readonly<Record<string, JsonValue>>;

  /** Details if the run is currently in "blocked" state */
  readonly blocker?: Readonly<WorkflowBlockerInfo>;
  /** Details if the run has transitioned to "completed" state */
  readonly completion?: Readonly<WorkflowCompletionInfo>;
}

/** Mutation actions for append-only session entries */
export type WorkflowRunMutationAction =
  | "create"
  | "update"
  | "transition"
  | "block"
  | "pause"
  | "resume"
  | "complete"
  | "cancel";

/** Persisted CustomEntry data payload in Pi session */
export interface WorkflowRunMutationEntryData {
  readonly version: number;
  readonly eventId: string;
  readonly runId: string;
  readonly workflow: string;
  readonly action: WorkflowRunMutationAction;
  readonly timestamp: number;
  readonly payload: unknown;
}

/** Diagnostic emitted during session reconstruction or entry validation */
export interface WorkflowRunDiagnostic {
  type: "error" | "warning";
  code: string;
  message: string;
  runId?: string;
  entryId?: string;
  timestamp?: number;
  details?: unknown;
}

/** Session provider that returns entries along the active session branch */
export interface SessionBranchProvider {
  getBranch(fromId?: string): readonly any[] | any[];
}

/** Session appender interface matching Pi's SessionManager and ExtensionAPI */
export interface SessionEntryAppender {
  appendCustomEntry?(customType: string, data?: unknown): string;
  appendEntry?(customType: string, data?: unknown): void | string;
}

/** Combined session target for reading active branch and appending mutations */
export type WorkflowSessionTarget = SessionBranchProvider & SessionEntryAppender;

// ---------------------------------------------------------------------------
// Registry Options
// ---------------------------------------------------------------------------

export interface CreateRunOptions {
  /** Optional custom run ID (auto-generated if omitted) */
  runId?: string;
  /** Initial workflow step (defaults to "INITIAL") */
  initialStep?: string;
  /** Initial workflow data */
  initialData?: Record<string, JsonValue>;
  /** Linkage to scheduler task */
  loopTaskId?: string;
  /** Optional creation timestamp (Unix epoch ms) */
  createdAt?: number;
  /**
   * Concurrency resolution policy if maxRuns is exceeded:
   * - "fail" (default): throw WorkflowConcurrencyError
   * - "returnExisting": return the currently active/nonterminal run
   */
  existingPolicy?: "fail" | "returnExisting";
}

export interface UpdateRunOptions {
  /** Update workflow step without full transition */
  step?: string;
  /** Shallow-merged key/value updates to data */
  data?: Record<string, JsonValue>;
  /** Explicit absolute attempts count */
  attempts?: number;
  /** Relative attempts increment */
  incrementAttempts?: number;
  /** Explicit absolute turns count */
  turns?: number;
  /** Relative turns increment */
  incrementTurns?: number;
  /** Update scheduler task linkage */
  loopTaskId?: string;
  /** Update timestamp (Unix epoch ms) */
  updatedAt?: number;
}

export interface TransitionStepOptions {
  /** Target workflow step name */
  toStep: string;
  /** Optional data updates during step transition */
  data?: Record<string, JsonValue>;
  /** Reason for transition */
  reason?: string;
  /** Update timestamp (Unix epoch ms) */
  updatedAt?: number;
}

export interface BlockRunOptions {
  /** Required explanation of the blocking condition */
  reason: string;
  /** Whether human action/judgment is required to unblock */
  requiresHuman?: boolean;
  /** Optional data updates during blocking */
  data?: Record<string, JsonValue>;
  /** Timestamp when blocked (Unix epoch ms) */
  blockedAt?: number;
}

export interface PauseRunOptions {
  /** Reason for pausing */
  reason?: string;
  /** Optional data updates during pause */
  data?: Record<string, JsonValue>;
  /** Timestamp when paused (Unix epoch ms) */
  pausedAt?: number;
}

export interface ResumeRunOptions {
  /** Optional step to resume into */
  step?: string;
  /** Optional data updates upon resume */
  data?: Record<string, JsonValue>;
  /** Reason for resume */
  reason?: string;
  /** Timestamp when resumed (Unix epoch ms) */
  resumedAt?: number;
}

export interface CompleteRunOptions {
  /** Summary of completion outcomes */
  summary: string;
  /** Concrete verification evidence */
  evidence?: WorkflowEvidence[];
  /** Optional final data updates */
  data?: Record<string, JsonValue>;
  /** Timestamp when completed (Unix epoch ms) */
  completedAt?: number;
}

export interface CancelRunOptions {
  /** Reason for cancellation */
  reason?: string;
  /** Optional data updates upon cancellation */
  data?: Record<string, JsonValue>;
  /** Timestamp when cancelled (Unix epoch ms) */
  cancelledAt?: number;
}

export interface ReconstructOptions {
  /** If true, throws on first malformed entry rather than collecting diagnostics */
  strict?: boolean;
}

// ---------------------------------------------------------------------------
// Error Hierarchy
// ---------------------------------------------------------------------------

export class WorkflowRunError extends Error {
  readonly runId?: string;
  constructor(message: string, runId?: string) {
    super(message);
    this.name = "WorkflowRunError";
    this.runId = runId;
  }
}

export class WorkflowConcurrencyError extends WorkflowRunError {
  readonly workflow: string;
  readonly activeRunIds: readonly string[];
  readonly maxRuns: number;

  constructor(workflow: string, activeRunIds: string[], maxRuns: number, message?: string) {
    super(
      message ??
        `Workflow "${workflow}" concurrency limit reached (${activeRunIds.length}/${maxRuns} nonterminal runs active). Active runs: [${activeRunIds.join(", ")}].`,
      activeRunIds[0]
    );
    this.name = "WorkflowConcurrencyError";
    this.workflow = workflow;
    this.activeRunIds = Object.freeze([...activeRunIds]);
    this.maxRuns = maxRuns;
  }
}

export class WorkflowInvalidTransitionError extends WorkflowRunError {
  readonly fromLifecycle?: WorkflowRunLifecycle;
  readonly toLifecycle?: WorkflowRunLifecycle;
  readonly action?: string;

  constructor(
    runId: string,
    message: string,
    options?: {
      fromLifecycle?: WorkflowRunLifecycle;
      toLifecycle?: WorkflowRunLifecycle;
      action?: string;
    }
  ) {
    super(message, runId);
    this.name = "WorkflowInvalidTransitionError";
    this.fromLifecycle = options?.fromLifecycle;
    this.toLifecycle = options?.toLifecycle;
    this.action = options?.action;
  }
}

export class WorkflowRunNotFoundError extends WorkflowRunError {
  constructor(runId: string, message?: string) {
    super(message ?? `Workflow run not found: "${runId}"`, runId);
    this.name = "WorkflowRunNotFoundError";
  }
}

export class WorkflowDataBoundsError extends WorkflowRunError {
  readonly field?: string;
  readonly limit?: number;
  readonly actual?: number;

  constructor(
    message: string,
    options?: { runId?: string; field?: string; limit?: number; actual?: number }
  ) {
    super(message, options?.runId);
    this.name = "WorkflowDataBoundsError";
    this.field = options?.field;
    this.limit = options?.limit;
    this.actual = options?.actual;
  }
}

export class WorkflowPersistenceError extends WorkflowRunError {
  readonly entryId?: string;

  constructor(message: string, options?: { runId?: string; entryId?: string }) {
    super(message, options?.runId);
    this.name = "WorkflowPersistenceError";
    this.entryId = options?.entryId;
  }
}

// ---------------------------------------------------------------------------
// Workflow Iteration Context & Dispatcher Types (Issue #3)
// ---------------------------------------------------------------------------

export class WorkflowIterationError extends WorkflowRunError {
  constructor(message: string, runId?: string) {
    super(message, runId);
    this.name = "WorkflowIterationError";
  }
}

export class WorkflowStaleIterationError extends WorkflowIterationError {
  readonly token?: string;
  readonly generation?: number;
  readonly currentGeneration?: number;

  constructor(
    message: string,
    options?: { runId?: string; token?: string; generation?: number; currentGeneration?: number }
  ) {
    super(message, options?.runId);
    this.name = "WorkflowStaleIterationError";
    this.token = options?.token;
    this.generation = options?.generation;
    this.currentGeneration = options?.currentGeneration;
  }
}

/** Parameters passed to the scheduler port when scheduling a wakeup */
export interface WorkflowScheduleWakeupParams {
  runId: string;
  delayMs: number;
  reason?: string;
}

/** Port interface for interacting with an external task scheduler (e.g. pi-loop) */
export interface WorkflowSchedulerPort {
  scheduleWakeup(params: WorkflowScheduleWakeupParams): Promise<void> | void;
  cancelWakeup?(runId: string): Promise<void> | void;
}

/** Ephemeral binding representing an active iteration turn */
export interface IterationBinding {
  readonly token: string;
  readonly generation: number;
  readonly runId: string;
  readonly workflowName: string;
  readonly createdAt: number;
  readonly schedulerPort?: WorkflowSchedulerPort;
  readonly capabilities?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

/** Options for dispatching an iteration turn */
export interface DispatchIterationOptions {
  schedulerPort?: WorkflowSchedulerPort;
  capabilities?: Iterable<string> | Record<string, boolean>;
  signal?: AbortSignal;
  incrementTurns?: boolean;
}

/** Budget status and remaining limits exposed in iteration context */
export interface WorkflowIterationBudgetStatus {
  maxTurns?: number;
  turnsRemaining?: number;
  maxDuration?: string;
  maxDurationMs?: number;
  durationRemainingMs?: number;
  maxAttempts?: number;
  attemptsRemaining?: number;
  maxCost?: number;
}

/** Model-facing execution context snapshot */
export interface WorkflowIterationContext {
  runId: string;
  workflow: string;
  lifecycle: WorkflowRunLifecycle;
  step: string;
  turns: number;
  attempts: number;
  data: Readonly<Record<string, JsonValue>>;
  budget: WorkflowIterationBudgetStatus;
  definition: {
    name: string;
    description: string;
    mode: WorkflowMode;
    version: number | string;
    source: string;
  };
  requires: readonly string[];
  capabilities: Record<string, boolean>;
  wakeups: {
    default?: string;
    defaultMs?: number;
    min?: string;
    minMs?: number;
    max?: string;
    maxMs?: number;
    named?: Record<string, string>;
  };
  completion?: {
    requireSummary?: boolean;
    requireEvidence?: boolean;
    verify?: boolean;
  };
}

/** Options for resolving a wakeup delay */
export interface ResolveWakeupDelayOptions {
  delay?: string;
  delayMs?: number;
  wakeupName?: string;
  policy?: WorkflowWakeupPolicy;
}

/** Resolved delay result with metadata */
export interface ResolvedWakeupDelay {
  delayMs: number;
  delayString: string;
  source: "named" | "explicit" | "default";
  isClamped: boolean;
  originalDelayMs: number;
}
