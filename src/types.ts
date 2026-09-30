/**
 * Workflow Spec v1 Type Definitions
 */

import type { ALLOWED_WORKFLOW_MODES, WORKFLOW_SCHEMA_VERSION } from "./constants.ts";
import type {
  CapabilityResolution,
  CapabilityStatus,
  WorkflowCapabilityRequirement,
} from "./capabilities.ts";

export type WorkflowMode = (typeof ALLOWED_WORKFLOW_MODES)[number];

/**
 * Closed durable workflow-kind discriminator.
 *
 * - `"workflow"` default for ordinary named/discovered workflows.
 * - `"goal"` for the command-owned ad-hoc goal facade (see `src/goal.ts`).
 */
export type WorkflowKind = "workflow" | "goal";

/** Allowed values for the durable workflow-kind discriminator. */
export const WORKFLOW_KINDS: readonly WorkflowKind[] = ["workflow", "goal"] as const;

/**
 * Resolves the durable kind of a definition/snapshot/run-like object.
 * Absent discriminator means an ordinary workflow (backward compatible).
 */
export function workflowKindOf(value: { type?: WorkflowKind } | null | undefined): WorkflowKind {
  return value?.type === "goal" ? "goal" : "workflow";
}

/** True when the value is a goal-kind definition/snapshot/run. */
export function isGoalKind(value: { type?: WorkflowKind } | null | undefined): boolean {
  return value?.type === "goal";
}

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
  /** Optional monetary or cost limit (unsupported in runtime) */
  maxCost?: number;
  /** Optional token limit (unsupported in runtime) */
  maxTokens?: number;
  /** Action when hard budget is exhausted: "block" (default) or "cancel" */
  onExhaustion?: "block" | "cancel";
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
  /** Target step to return to when verification is rejected */
  returnStep?: string;
  /** Policy when verification retries are exhausted: "block" (default) or "fail" */
  onRejectionExhausted?: "block" | "fail";
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
  /**
   * Durable workflow-kind discriminator.
   *
   * Absent (or `"workflow"`) for ordinary named workflows discovered from disk.
   * `"goal"` marks a command-owned ad-hoc goal facade definition built in
   * memory by `src/goal.ts`. This is a closed union validated on replay; goals
   * must never be identified by a name prefix alone.
   */
  type?: WorkflowKind;
  /**
   * User-supplied goal objective. Only present for `type: "goal"` definitions
   * built by the built-in goal factory. It is not an allowed frontmatter field,
   * so an on-disk named workflow can never claim to be a goal.
   */
  objective?: string;
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
  /** Required capability names (legacy, string form; preserved for compatibility) */
  requires: string[];
  /**
   * Normalized capability requirements with optional version/feature/optional
   * constraints. Always present after parsing; entries mirror `requires` when
   * only bare names were declared.
   */
  capabilityRequirements?: WorkflowCapabilityRequirement[];
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
  /** Durable workflow-kind discriminator preserved from the definition. */
  readonly type?: WorkflowKind;
  /** Goal objective preserved immutably for goal-kind snapshots. */
  readonly objective?: string;
  readonly mode: WorkflowMode;
  readonly schedule?: DeepReadonly<WorkflowScheduleConfig>;
  readonly concurrency: DeepReadonly<WorkflowConcurrencyPolicy>;
  readonly budget: DeepReadonly<WorkflowBudgetPolicy>;
  readonly wakeups: DeepReadonly<WorkflowWakeupPolicy>;
  readonly requires: ReadonlyArray<string>;
  readonly capabilityRequirements?: DeepReadonly<WorkflowCapabilityRequirement[]>;
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
  | "verifying"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled";

/** Blocker category determining autonomous polling behavior */
export type BlockerCategory = "external-retryable" | "human-required" | "terminal";

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
  /** Blocker category / type */
  category?: BlockerCategory;
  /** Whether human intervention/decision is required to unblock */
  requiresHuman?: boolean;
  /** Optional conservative retry delay in ms for external-retryable blockers */
  retryDelayMs?: number;
  /** Timestamp when blocked (Unix epoch ms) */
  blockedAt: number;
}

/** Explicit completion claim submitted by workflow */
export interface WorkflowCompletionClaim {
  /** Summary of completed work and deliverables */
  summary: string;
  /** Concrete verification or outcome evidence */
  evidence: WorkflowEvidence[];
  /** Timestamp when claim was submitted (Unix epoch ms) */
  submittedAt: number;
  /** Optional identifier for the completion claim */
  claimId?: string;
}

/** Findings and decision from an authoritative verification iteration */
export interface WorkflowVerificationFindings {
  /** Verification decision */
  decision: "accepted" | "rejected";
  /** Evaluator feedback or explanation */
  feedback?: string;
  /** Timestamp when verified (Unix epoch ms) */
  verifiedAt: number;
  /** Verification attempt number (1-based) */
  attempt: number;
  /** Optional step to return to upon rejection */
  returnStep?: string;
  /** Optional structured checks evaluation */
  checks?: Array<{ name: string; passed: boolean; message?: string }>;
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

/** Status of an external effect checkpoint */
export type WorkflowEffectStatus = "started" | "committed" | "reconciled";

/**
 * Durable record of an external side effect checkpoint.
 */
export interface WorkflowEffect {
  /** Unique effect key within the workflow run */
  readonly key: string;
  /** Category or kind of side effect (e.g. github.pull_request.create) */
  readonly kind: string;
  /** Status of effect checkpoint */
  readonly status: WorkflowEffectStatus;
  /** Bounded JSON-safe summary of effect inputs/intent */
  readonly inputSummary?: Readonly<Record<string, JsonValue>> | JsonValue;
  /** Bounded JSON-safe summary of observed outcome/result */
  readonly resultSummary?: Readonly<Record<string, JsonValue>> | JsonValue;
  /** Timestamp when effect was begun (epoch ms) */
  readonly startedAt: number;
  /** Timestamp when effect was committed (epoch ms) */
  readonly committedAt?: number;
  /** Timestamp when effect was reconciled (epoch ms) */
  readonly reconciledAt?: number;
  /** Explanation of reconciliation observation or decision */
  readonly recoveryNote?: string;
  /** Whether the effect is ambiguous (started before interruption, uncommitted upon recovery) */
  readonly ambiguous?: boolean;
}

/** Types of recovery events recorded in durable run history */
export type WorkflowRecoveryEventType =
  | "effect_ambiguous"
  | "effect_reconciled"
  | "effect_aborted"
  | "scheduler_reconnected"
  | "scheduler_recreated"
  | "scheduler_cleaned"
  | "scheduler_ambiguous"
  | "run_reconciled";

/**
 * Durable record of a recovery or reconciliation event in run history.
 */
export interface WorkflowRecoveryEvent {
  readonly eventId: string;
  readonly type: WorkflowRecoveryEventType;
  readonly timestamp: number;
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

/**
 * Chronological history entry for auditability of run mutations and events.
 */
export interface WorkflowRunHistoryEntry {
  readonly eventId: string;
  readonly action: string;
  readonly timestamp: number;
  readonly summary: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

/**
 * Ownership lease metadata preventing duplicate workflow runners on the same run.
 */
export interface WorkflowRunLease {
  /** Unique owner / runner instance identifier */
  readonly ownerId: string;
  /** Timestamp when lease was acquired (epoch ms) */
  readonly acquiredAt: number;
  /** Optional expiry timestamp (epoch ms) */
  readonly expiresAt?: number;
  /** Optional lease token / nonce */
  readonly leaseToken?: string;
}

/**
 * Concrete, durable workflow execution record.
 */
export interface WorkflowRun {
  /** Stable unique run identifier */
  readonly id: string;
  /** Workflow definition name */
  readonly workflow: string;
  /** Durable workflow-kind discriminator derived from the snapshot. */
  readonly type?: WorkflowKind;
  /** Goal objective derived from a goal-kind snapshot (undefined otherwise). */
  readonly objective?: string;
  /** Version number or string of the workflow definition */
  readonly definitionVersion: number | string;
  /** Source identity or path of the definition */
  readonly definitionSource: string;
  /** Immutable definition snapshot */
  readonly snapshot: WorkflowSnapshotV1;
  /** Optional run-level budget limits overriding snapshot budget */
  readonly budget?: Readonly<WorkflowBudgetPolicy>;

  /** Generic lifecycle status (active, verifying, paused, blocked, completed, cancelled) */
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
  /** Explicit completion claim if submitted */
  readonly completionClaim?: Readonly<WorkflowCompletionClaim>;
  /** Authoritative verification findings if verification was performed */
  readonly verificationFindings?: Readonly<WorkflowVerificationFindings>;
  /** Number of verification attempts performed */
  readonly verificationAttempts?: number;
  /** Details if the run has transitioned to "completed" state */
  readonly completion?: Readonly<WorkflowCompletionInfo>;

  /** Recorded external effect checkpoints keyed by effect key */
  readonly effects?: Readonly<Record<string, WorkflowEffect>>;
  /**
   * Bounded recent recovery-event projection (oldest retained event first).
   *
   * At most `MAX_RUN_RECOVERY_EVENTS` events are retained; older events remain
   * durable in the Pi session log but are dropped from the projection.
   */
  readonly recoveryEvents?: ReadonlyArray<WorkflowRecoveryEvent>;
  /** Total lifetime recovery events appended (retained + dropped) */
  readonly recoveryEventsTotal?: number;
  /** Number of lifetime recovery events dropped from the projection */
  readonly recoveryEventsDropped?: number;
  /** Bounded recent-history projection of lifecycle mutations and actions */
  readonly history?: ReadonlyArray<WorkflowRunHistoryEntry>;
  /** Total lifetime history entries appended (retained + dropped) */
  readonly historyTotal?: number;
  /** Number of lifetime history entries dropped from the retained projection */
  readonly historyDropped?: number;
  /** Active ownership lease if claimed */
  readonly lease?: Readonly<WorkflowRunLease>;
}

/** Deterministic ordering for `registry.getRunHistory` results. */
export type WorkflowRunHistoryOrder = "oldest" | "newest";

/** Options for the bounded recent-history accessor. */
export interface WorkflowRunHistoryOptions {
  /**
   * Maximum number of entries to return. Clamped to
   * `[0, MAX_RUN_HISTORY_QUERY_LIMIT]`; defaults to the full retained window.
   * Values that are `NaN`/non-finite fall back to the full retained window.
   */
  limit?: number;
  /**
   * Order of returned entries. Defaults to `"oldest"` (chronological, matching
   * the retained projection). `"newest"` returns most-recent-first.
   */
  order?: WorkflowRunHistoryOrder;
}

/**
 * Observability view over a run's bounded recent-history projection.
 * Exposes truncation metadata without scanning the lifetime session log.
 */
export interface WorkflowRunHistoryView {
  readonly runId: string;
  /** Retained entries in the requested deterministic order. */
  readonly entries: ReadonlyArray<WorkflowRunHistoryEntry>;
  /** Deterministic order of `entries`. */
  readonly order: WorkflowRunHistoryOrder;
  /** Effective (clamped) limit applied to `entries`. */
  readonly limit: number;
  /** Number of entries retained in the run projection. */
  readonly retained: number;
  /** Total lifetime history entries appended (retained + dropped). */
  readonly total: number;
  /** Number of lifetime entries dropped from the retained projection. */
  readonly dropped: number;
  /** True when lifetime history exceeded the retention capacity. */
  readonly truncated: boolean;
  /** True when `entries` excludes retained entries because of `limit`. */
  readonly limited: boolean;
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
  | "cancel"
  | "claim"
  | "verify"
  | "effect_begin"
  | "effect_commit"
  | "effect_reconcile"
  | "wakeup_scheduled"
  | "recovery"
  | "lease";

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
  /** Optional run-level budget override */
  budget?: WorkflowBudgetPolicy;
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
  /** Update scheduler task linkage (pass null or empty string to clear) */
  loopTaskId?: string | null;
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
  /** Blocker category / type */
  category?: BlockerCategory;
  /** Whether human action/judgment is required to unblock */
  requiresHuman?: boolean;
  /** Optional conservative retry delay in ms for external-retryable blocker */
  retryDelayMs?: number;
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

export interface ClaimCompletionOptions {
  /** Summary of completion outcomes */
  summary: string;
  /** Concrete verification evidence */
  evidence?: WorkflowEvidence[];
  /** Optional final data updates */
  data?: Record<string, JsonValue>;
  /** Optional claim ID */
  claimId?: string;
  /** Timestamp when claim was submitted (Unix epoch ms) */
  submittedAt?: number;
}

export interface VerifyCompletionOptions {
  /** Verification decision */
  decision: "accept" | "reject" | "accepted" | "rejected";
  /** Evaluator feedback or explanation */
  feedback?: string;
  /** Optional synonym for feedback */
  findings?: string;
  /** Optional structured checks evaluation */
  checks?: Array<{ name: string; passed: boolean; message?: string }>;
  /** Optional step to return to upon rejection */
  returnStep?: string;
  /** Optional data updates */
  data?: Record<string, JsonValue>;
  /** Timestamp when verified (Unix epoch ms) */
  verifiedAt?: number;
}

export interface CompleteRunOptions {
  /** Summary of completion outcomes */
  summary: string;
  /** Concrete verification evidence */
  evidence?: WorkflowEvidence[];
  /** Optional final data updates */
  data?: Record<string, JsonValue>;
  /** Optional claim ID */
  claimId?: string;
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

export interface EffectBeginOptions {
  /** Unique key identifying the effect within the run */
  key: string;
  /** Category or kind of side effect (e.g. github.pull_request.create) */
  kind: string;
  /** Bounded JSON-safe summary of effect inputs/intent */
  inputSummary?: Record<string, JsonValue> | JsonValue;
  /** Optional start timestamp */
  startedAt?: number;
  /** Whether to return the existing record if already committed instead of throwing */
  allowCommitted?: boolean;
}

export interface EffectCommitOptions {
  /** Unique key identifying the effect within the run */
  key: string;
  /** Bounded JSON-safe summary of observed outcome/result */
  resultSummary?: Record<string, JsonValue> | JsonValue;
  /** Optional commit timestamp */
  committedAt?: number;
  /**
   * Whether this commit reconciles a previously ambiguous started effect.
   * Persisted so replay reproduces the `effect_reconciled` audit event.
   */
  recovered?: boolean;
  /**
   * Optional deterministic id for the generated `effect_reconciled` recovery
   * event. Persisted so replay reproduces the same event id.
   */
  eventId?: string;
}

/**
 * Options for recording a durable `wakeup_scheduled` history fact.
 *
 * Only safe scalar scheduler metadata is recorded (the clamped delay actually
 * scheduled). The arbitrary wakeup `reason`, task prompt and task ID are never
 * persisted into the run history projection.
 */
export interface WakeupScheduledOptions {
  /** Clamped delay in milliseconds that was actually scheduled. */
  delayMs: number;
  /** Optional deterministic timestamp (Unix epoch ms). */
  timestamp?: number;
}

export interface EffectReconcileOptions {
  /** Unique key identifying the effect within the run */
  key: string;
  /** Reconciliation outcome */
  resolution: "committed" | "aborted" | "retryable";
  /** Bounded JSON-safe summary of observed outcome/result */
  resultSummary?: Record<string, JsonValue> | JsonValue;
  /** Explanation of external observation and resolution */
  reason?: string;
  /** Optional reconciliation timestamp */
  reconciledAt?: number;
  /**
   * Optional deterministic id for the generated recovery event. Persisted so
   * replay reproduces the same event id.
   */
  eventId?: string;
}

export interface WorkflowRecoveryEventOptions {
  /** Type of recovery event */
  type: WorkflowRecoveryEventType;
  /** Human-readable description of the recovery event */
  message: string;
  /** Optional JSON-safe structured metadata */
  details?: Record<string, JsonValue>;
  /** Optional timestamp */
  timestamp?: number;
  /** Optional event identifier */
  eventId?: string;
}

export interface AcquireLeaseOptions {
  /** Owner / runner instance identifier */
  ownerId: string;
  /** Optional expiration timestamp (epoch ms) */
  expiresAt?: number;
  /** Optional lease token / nonce */
  leaseToken?: string;
  /** Optional current timestamp */
  now?: number;
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

export class WorkflowCapabilityError extends WorkflowRunError {
  readonly workflow: string;
  readonly missingCapabilities: readonly string[];
  /** Capabilities present but at an incompatible version/features. */
  readonly incompatibleCapabilities: readonly string[];
  /** Per-requirement resolution detail when available. */
  readonly resolution?: CapabilityResolution;

  constructor(
    workflow: string,
    missingCapabilities: string[],
    message?: string,
    runId?: string,
    options?: { incompatible?: string[]; resolution?: CapabilityResolution }
  ) {
    super(
      message ??
        `Workflow "${workflow}" requires capabilities: [${missingCapabilities.join(
          ", "
        )}] which are not currently available.`,
      runId
    );
    this.name = "WorkflowCapabilityError";
    this.workflow = workflow;
    this.missingCapabilities = Object.freeze([...missingCapabilities]);
    this.incompatibleCapabilities = Object.freeze([...(options?.incompatible ?? [])]);
    this.resolution = options?.resolution;
  }
}

export class WorkflowBudgetError extends WorkflowRunError {
  readonly dimension?: string;
  constructor(message: string, runId?: string, dimension?: string) {
    super(message, runId);
    this.name = "WorkflowBudgetError";
    this.dimension = dimension;
  }
}

export class WorkflowUnsupportedBudgetError extends WorkflowBudgetError {
  constructor(workflow: string, dimension: string, message?: string, runId?: string) {
    super(
      message ??
        `Workflow "${workflow}" specifies budget dimension "${dimension}", which is unsupported because Pi runtime does not expose authoritative accounting data.`,
      runId,
      dimension
    );
    this.name = "WorkflowUnsupportedBudgetError";
  }
}

export class WorkflowBudgetExhaustedError extends WorkflowBudgetError {
  readonly limit?: number;
  readonly actual?: number;
  constructor(
    message: string,
    options?: { runId?: string; dimension?: string; limit?: number; actual?: number }
  ) {
    super(message, options?.runId, options?.dimension);
    this.name = "WorkflowBudgetExhaustedError";
    this.limit = options?.limit;
    this.actual = options?.actual;
  }
}

export class WorkflowVerificationError extends WorkflowRunError {
  constructor(message: string, runId?: string) {
    super(message, runId);
    this.name = "WorkflowVerificationError";
  }
}

export class WorkflowEffectError extends WorkflowRunError {
  readonly key?: string;
  readonly effectKind?: string;

  constructor(message: string, options?: { runId?: string; key?: string; effectKind?: string }) {
    super(message, options?.runId);
    this.name = "WorkflowEffectError";
    this.key = options?.key;
    this.effectKind = options?.effectKind;
  }
}

export class WorkflowEffectAlreadyCommittedError extends WorkflowEffectError {
  readonly effect?: WorkflowEffect;

  constructor(key: string, runId?: string, effect?: WorkflowEffect) {
    super(
      `Effect "${key}" on run "${runId ?? "unknown"}" was already committed and cannot be executed again under the same key.`,
      { runId, key, effectKind: effect?.kind }
    );
    this.name = "WorkflowEffectAlreadyCommittedError";
    this.effect = effect;
  }
}

export class WorkflowAmbiguousEffectError extends WorkflowEffectError {
  readonly ambiguousKey?: string;

  constructor(message: string, options?: { runId?: string; ambiguousKey?: string; key?: string }) {
    super(message, { runId: options?.runId, key: options?.key });
    this.name = "WorkflowAmbiguousEffectError";
    this.ambiguousKey = options?.ambiguousKey;
  }
}

/** Machine-readable reason a model-callable provider action was refused/failed. */
export type WorkflowProviderCallCode =
  | "no_registry"
  | "capability_invalid"
  | "capability_not_declared"
  | "capability_missing"
  | "capability_unavailable"
  | "capability_incompatible"
  | "operations_unavailable"
  | "operation_not_allowlisted"
  | "input_invalid"
  | "effect_required"
  | "effect_unexpected"
  | "effect_not_started"
  | "effect_already_committed"
  | "effect_kind_mismatch"
  | "effect_ambiguous"
  | "provider_degraded"
  | "execution_failed";

/**
 * Raised when a model-callable provider action cannot be dispatched safely:
 * absent/unhealthy/incompatible provider, operation not on the allowlist, or a
 * mutating operation without a valid durable effect checkpoint.
 */
export class WorkflowProviderCallError extends WorkflowRunError {
  readonly code: WorkflowProviderCallCode;
  readonly capability?: string;
  readonly operation?: string;

  constructor(
    message: string,
    options: {
      runId?: string;
      code: WorkflowProviderCallCode;
      capability?: string;
      operation?: string;
    }
  ) {
    super(message, options.runId);
    this.name = "WorkflowProviderCallError";
    this.code = options.code;
    this.capability = options.capability;
    this.operation = options.operation;
  }
}

export class WorkflowOwnershipError extends WorkflowRunError {
  readonly currentOwnerId?: string;
  readonly requestedOwnerId?: string;

  constructor(
    message: string,
    options?: { runId?: string; currentOwnerId?: string; requestedOwnerId?: string }
  ) {
    super(message, options?.runId);
    this.name = "WorkflowOwnershipError";
    this.currentOwnerId = options?.currentOwnerId;
    this.requestedOwnerId = options?.requestedOwnerId;
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
  /** Structured capability resolution captured at dispatch time (if any). */
  readonly capabilityReport?: CapabilityResolution;
  readonly signal?: AbortSignal;
  readonly ownerId?: string;
}

/** Options for dispatching an iteration turn */
export interface DispatchIterationOptions {
  schedulerPort?: WorkflowSchedulerPort;
  capabilities?: Iterable<string> | Record<string, boolean>;
  /** Structured resolution of the run's required capabilities. */
  capabilityReport?: CapabilityResolution;
  signal?: AbortSignal;
  incrementTurns?: boolean;
  ownerId?: string;
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
  costStatus?: "unavailable";
  maxTokens?: number;
  tokensStatus?: "unavailable";
  isExhausted?: boolean;
  exhaustedDimension?: "turns" | "duration" | "attempts";
  exhaustionReason?: string;
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
  /** Provider status per required capability (available/degraded/missing/incompatible). */
  capabilityStatus?: Record<string, CapabilityStatus | "missing" | "incompatible">;
  /** Actionable issues per required capability (version/feature/availability). */
  capabilityIssues?: Record<string, string>;
  /** Required capabilities that are missing or unavailable at dispatch. */
  missingCapabilities?: readonly string[];
  /** Required capabilities present at an incompatible version/features. */
  incompatibleCapabilities?: readonly string[];
  /** Required capabilities currently degraded. */
  degradedCapabilities?: readonly string[];
  /** Optional capabilities that are missing or unavailable. */
  optionalCapabilitiesMissing?: readonly string[];
  /** Optional capabilities present at an incompatible version/features. */
  optionalCapabilitiesIncompatible?: readonly string[];
  /** Whether all required capabilities were satisfied at dispatch. */
  capabilitiesSatisfied?: boolean;
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
  /** Recorded external effect checkpoints */
  effects?: Readonly<Record<string, WorkflowEffect>>;
  /** Interrupted uncommitted effects requiring recovery reconciliation */
  ambiguousEffects?: ReadonlyArray<WorkflowEffect>;
  /** Whether the run is currently in recovery reconciliation mode */
  inReconciliation?: boolean;
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
