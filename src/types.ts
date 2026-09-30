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
