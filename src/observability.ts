/**
 * Issue #10 — shared read-only observability projections and formatters.
 *
 * This module is deliberately pure with respect to workflow state: it reads the
 * authoritative run registry and the read-only scheduler projection and derives
 * safe, bounded, deterministic views. It never mutates a run, never holds a
 * mutable scheduler/service handle, and never parses the chat transcript.
 *
 * Both the human `/workflow status` surface and the interactive TUI status line
 * are built from the same projections so the two can never disagree.
 *
 * ## Free-text safety policy
 *
 * Blocker reasons, completion summaries, verifier feedback, recovery notes and
 * goal objectives are user- or model-controlled prose. Truncation alone does not
 * make arbitrary prose secret-free, so every such value crosses
 * {@link sanitizeDiagnosticText} before it is displayed or embedded in a
 * command's structured `data`:
 *
 *  1. control characters are stripped and line breaks collapsed to a single
 *     space (the value is rendered inline);
 *  2. obvious credential shapes (private keys, `sk-…`/`ghp_…`/`xox…`/AWS keys,
 *     JWTs, `password=`/`token:`/`bearer …` pairs, `user:pass@` URL userinfo)
 *     are replaced with a `[redacted …]` marker;
 *  3. the value is truncated to an explicit bounded length with a visible
 *     `…[+N chars]` omission marker.
 *
 * The durable Pi session JSONL log remains the append-only source of truth. The
 * bounded in-memory history projection is for recent operational visibility, not
 * a second lifetime store, and it is never rendered wholesale.
 */

import { type CapabilityResolution, type WorkflowCapabilityRegistry } from "./capabilities.ts";
import {
  MAX_DIAGNOSTIC_TEXT_LENGTH,
  MAX_RECOVERY_EVENTS_DISPLAYED,
  MAX_STATUS_BLOCKER_LENGTH,
  MAX_STATUS_LINE_LENGTH,
} from "./constants.ts";
import { isTerminalLifecycle } from "./run.ts";
import type { LoopSchedulerAdapter } from "./scheduler-adapter.ts";
import {
  type BlockerCategory,
  type JsonValue,
  type WorkflowEvidence,
  type WorkflowRun,
  type WorkflowRunHistoryView,
  type WorkflowRunLifecycle,
  type WorkflowRecoveryEvent,
  type WorkflowKind,
  workflowKindOf,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Free-text sanitization
// ---------------------------------------------------------------------------

/** Result of sanitizing a user/model-controlled diagnostic string. */
export interface SanitizedText {
  /** Bounded, inline-safe, redacted text (empty when omitted). */
  readonly text: string;
  /** True when the source was truncated to the bounded length. */
  readonly truncated: boolean;
  /** True when at least one credential-shaped substring was redacted. */
  readonly redacted: boolean;
  /** True when the source was absent/empty and nothing is shown. */
  readonly omitted: boolean;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const WHITESPACE_RUN = /[ \t\r\n]+/g;

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * Credential-shaped substrings redacted from diagnostic text. Best-effort only:
 * the policy is explicitly that arbitrary prose cannot be proven secret-free,
 * so values are also bounded and omission-marked.
 */
const REDACTION_RULES: readonly RedactionRule[] = [
  {
    pattern: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/gi,
    replacement: "[redacted private key]",
  },
  { pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, replacement: "[redacted key]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "[redacted token]" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[redacted token]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[redacted aws key]" },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[redacted jwt]",
  },
  {
    pattern: /\b(authorization|bearer|password|passwd|secret|token|api[_-]?key)\b(\s*[:=]\s*|\s+)(?!\[redacted)([^\s,;]+)/gi,
    replacement: "$1$2[redacted]",
  },
  { pattern: /\/\/[^/\s:@]+:[^/\s@]+@/g, replacement: "//[redacted]@" },
];

/**
 * Sanitize a user/model-controlled diagnostic string for inline display.
 *
 * See the module-level "Free-text safety policy". Never claims the result is
 * secret-free; it bounds, normalizes, and redacts obvious credential shapes.
 */
export function sanitizeDiagnosticText(
  value: unknown,
  maxLength: number = MAX_DIAGNOSTIC_TEXT_LENGTH
): SanitizedText {
  if (typeof value !== "string") {
    return Object.freeze({ text: "", truncated: false, redacted: false, omitted: true });
  }
  const normalized = value.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");
  const inline = normalized.replace(WHITESPACE_RUN, " ").trim();
  if (inline.length === 0) {
    return Object.freeze({ text: "", truncated: false, redacted: false, omitted: true });
  }

  let redactedFlag = false;
  let safe = inline;
  for (const rule of REDACTION_RULES) {
    safe = safe.replace(rule.pattern, (match, ...groups) => {
      redactedFlag = true;
      // Re-expand `$1`/`$2` capture references in the replacement.
      return rule.replacement.replace(/\$(\d)/g, (_, n: string) => String(groups[Number(n) - 1] ?? ""));
    });
  }

  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : MAX_DIAGNOSTIC_TEXT_LENGTH;
  let truncated = false;
  if (safe.length > limit) {
    truncated = true;
    safe = `${safe.slice(0, limit)}…[+${safe.length - limit} chars]`;
  }

  return Object.freeze({ text: safe, truncated, redacted: redactedFlag, omitted: false });
}

// ---------------------------------------------------------------------------
// Time helpers (shared by status output and the TUI line)
// ---------------------------------------------------------------------------

/** Format an age in milliseconds relative to `now` into a compact duration. */
export function formatAge(epochMs: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - epochMs);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) {
    return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

/** Format an absolute epoch timestamp as a deterministic 24h local clock time. */
export function formatClockTime(epochMs: number): string {
  const date = new Date(epochMs);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

// ---------------------------------------------------------------------------
// Scheduler linkage projection (read-only)
// ---------------------------------------------------------------------------

/**
 * Safe linkage classification between a workflow run and the authoritative
 * scheduler. Never exposes a service handle, task prompt, or raw task object.
 */
export type SchedulerLinkageState =
  | "linked"
  | "absent"
  | "stale"
  | "ambiguous"
  | "unavailable"
  | "not-applicable";

export interface SchedulerLinkage {
  readonly state: SchedulerLinkageState;
  /** True when a durable scheduler task link exists for this run. */
  readonly taskLinked: boolean;
  /** Absolute next fire time when the linked live task exposes one. */
  readonly nextFireAt?: number;
  readonly pending?: boolean;
  /** True when the run lease is held by this adapter instance. */
  readonly ownedByCurrent?: boolean;
  /** Safe human-readable explanation. Never contains raw task IDs. */
  readonly detail: string;
}

/**
 * Project the authoritative, read-only scheduler linkage for a run.
 *
 * Distinguishes:
 *  - `linked`        durable link resolves to a live task for this run;
 *  - `absent`        no durable scheduler link (not scheduled / link cleared);
 *  - `stale`         durable link present but the task is gone from the scheduler;
 *  - `ambiguous`     the live task maps to a different run (cross-link);
 *  - `unavailable`   scheduler session/service cannot be consulted;
 *  - `not-applicable` terminal, paused or blocked runs have no active wakeup.
 */
export function projectSchedulerLinkage(
  run: WorkflowRun,
  adapter: LoopSchedulerAdapter
): SchedulerLinkage {
  if (isTerminalLifecycle(run.lifecycle)) {
    return Object.freeze({ state: "not-applicable", taskLinked: false, detail: `run is ${run.lifecycle}` });
  }
  if (run.lifecycle === "paused" || run.lifecycle === "blocked") {
    return Object.freeze({
      state: "not-applicable",
      taskLinked: false,
      detail: `${run.lifecycle}; wakeups suspended`,
    });
  }

  const taskId = adapter.getLinkedTaskId(run.id);
  if (!taskId) {
    return Object.freeze({ state: "absent", taskLinked: false, detail: "no scheduler task is linked" });
  }

  const ownedByCurrent = Boolean(run.lease && run.lease.ownerId === adapter.ownerId);
  if (!adapter.isAvailable()) {
    return Object.freeze({
      state: "unavailable",
      taskLinked: true,
      ownedByCurrent,
      detail: "pi-loop scheduler service is unavailable; linkage cannot be verified",
    });
  }

  const service = adapter.getService();
  if (!service) {
    return Object.freeze({
      state: "unavailable",
      taskLinked: true,
      ownedByCurrent,
      detail: "pi-loop scheduler service is not attached; linkage cannot be verified",
    });
  }

  let tasks;
  try {
    tasks = service.listTasks();
  } catch {
    return Object.freeze({
      state: "unavailable",
      taskLinked: true,
      ownedByCurrent,
      detail: "pi-loop scheduler query failed; linkage cannot be verified",
    });
  }

  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    return Object.freeze({
      state: "stale",
      taskLinked: true,
      ownedByCurrent,
      detail: "linked scheduler task no longer exists",
    });
  }

  const mappedRunId = adapter.getLinkedRunId(taskId);
  if (mappedRunId !== undefined && mappedRunId !== run.id) {
    return Object.freeze({
      state: "ambiguous",
      taskLinked: true,
      ownedByCurrent,
      detail: "linked scheduler task belongs to a different run",
    });
  }

  return Object.freeze({
    state: "linked",
    taskLinked: true,
    ...(task.nextFireAt !== undefined && task.nextFireAt !== null ? { nextFireAt: task.nextFireAt } : {}),
    pending: task.pending === true,
    ownedByCurrent,
    detail: task.pending === true ? "linked; a missed run is queued" : "linked",
  });
}

// ---------------------------------------------------------------------------
// Aggregate status projection (command list + TUI line)
// ---------------------------------------------------------------------------

export interface WorkflowStatusBlockerView {
  readonly reason: string;
  readonly reasonOmitted: boolean;
  readonly category?: BlockerCategory;
  readonly requiresHuman: boolean;
  readonly blockedAt: number;
}

export interface WorkflowStatusRunView {
  readonly id: string;
  readonly workflow: string;
  readonly type: WorkflowKind;
  readonly lifecycle: WorkflowRunLifecycle;
  readonly step: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly ageMs: number;
  readonly age: string;
  readonly nextWakeup: string;
  readonly nextWakeupAt?: number;
  readonly schedulerState: SchedulerLinkageState;
  readonly blocker?: WorkflowStatusBlockerView;
  readonly completionSummary?: string;
  readonly objective?: string;
}

/** Aggregate, deterministic view of all nonterminal workflow runs. */
export interface WorkflowStatusProjection {
  readonly now: number;
  readonly total: number;
  readonly active: number;
  readonly blocked: number;
  readonly paused: number;
  readonly verifying: number;
  /** Earliest valid future wakeup across linked runs, deterministic tie-break by id. */
  readonly earliestNextWakeupAt?: number;
  readonly runs: readonly WorkflowStatusRunView[];
}

function mostRecentWakeup(
  runs: readonly { id: string; nextWakeupAt?: number }[],
  now: number
): number | undefined {
  let best: number | undefined;
  for (const run of [...runs].sort((a, b) => a.id.localeCompare(b.id))) {
    const at = run.nextWakeupAt;
    if (at === undefined || !Number.isFinite(at) || at < now) continue;
    if (best === undefined || at < best) best = at;
  }
  return best;
}

/**
 * Build the aggregate status projection from the authoritative registry plus the
 * read-only scheduler projection. Run order is deterministic (createdAt, then
 * id); counts and earliest wakeup are deterministic. Unrelated user `/loop`
 * tasks are never counted because only workflow runs enter this projection.
 */
export function buildStatusProjection(
  registry: { getNonterminalRuns(): WorkflowRun[] },
  adapter: LoopSchedulerAdapter,
  options: { now?: number } = {}
): WorkflowStatusProjection {
  const now = options.now ?? Date.now();
  const runs = [...registry.getNonterminalRuns()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  );

  const runViews: WorkflowStatusRunView[] = [];
  let active = 0;
  let blocked = 0;
  let paused = 0;
  let verifying = 0;

  for (const run of runs) {
    if (run.lifecycle === "active") active += 1;
    else if (run.lifecycle === "blocked") blocked += 1;
    else if (run.lifecycle === "paused") paused += 1;
    else if (run.lifecycle === "verifying") verifying += 1;

    const linkage = projectSchedulerLinkage(run, adapter);
    const blockerReason = run.blocker ? sanitizeDiagnosticText(run.blocker.reason, MAX_STATUS_BLOCKER_LENGTH) : undefined;
    const objective = run.objective !== undefined ? sanitizeDiagnosticText(run.objective, MAX_STATUS_BLOCKER_LENGTH) : undefined;

    runViews.push(
      Object.freeze({
        id: run.id,
        workflow: run.workflow,
        type: workflowKindOf(run),
        lifecycle: run.lifecycle,
        step: run.step,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        ageMs: Math.max(0, now - run.createdAt),
        age: formatAge(run.createdAt, now),
        nextWakeup: formatNextWakeup(run, adapter, now),
        ...(linkage.nextFireAt !== undefined ? { nextWakeupAt: linkage.nextFireAt } : {}),
        schedulerState: linkage.state,
        ...(run.blocker
          ? {
              blocker: Object.freeze({
                reason: blockerReason!.text,
                reasonOmitted: blockerReason!.omitted,
                ...(run.blocker.category ? { category: run.blocker.category } : {}),
                requiresHuman: run.blocker.requiresHuman === true,
                blockedAt: run.blocker.blockedAt,
              }),
            }
          : {}),
        ...(run.completion
          ? { completionSummary: sanitizeDiagnosticText(run.completion.summary, MAX_STATUS_BLOCKER_LENGTH).text }
          : {}),
        ...(objective && !objective.omitted ? { objective: objective.text } : {}),
      })
    );
  }

  const earliestNextWakeupAt = mostRecentWakeup(runViews, now);

  return Object.freeze({
    now,
    total: runViews.length,
    active,
    blocked,
    paused,
    verifying,
    ...(earliestNextWakeupAt !== undefined ? { earliestNextWakeupAt } : {}),
    runs: Object.freeze(runViews),
  });
}

/**
 * Render the single aggregate TUI status line, or `undefined` when there are no
 * nonterminal workflows (the caller clears the dedicated status key).
 *
 * Example: `◇ 2 workflows · 1 active · 1 blocked · next 10:42`.
 * The line is bounded to {@link MAX_STATUS_LINE_LENGTH} characters.
 */
export function formatStatusLine(projection: WorkflowStatusProjection): string | undefined {
  if (projection.total === 0) {
    return undefined;
  }
  const parts: string[] = [
    `${projection.total} workflow${projection.total === 1 ? "" : "s"}`,
    `${projection.active} active`,
  ];
  if (projection.blocked > 0) parts.push(`${projection.blocked} blocked`);
  if (projection.paused > 0) parts.push(`${projection.paused} paused`);
  if (projection.verifying > 0) parts.push(`${projection.verifying} verifying`);
  if (projection.earliestNextWakeupAt !== undefined) {
    parts.push(`next ${formatClockTime(projection.earliestNextWakeupAt)}`);
  }

  let line = `◇ ${parts.join(" · ")}`;
  if (line.length > MAX_STATUS_LINE_LENGTH) {
    line = `${line.slice(0, MAX_STATUS_LINE_LENGTH - 1)}…`;
  }
  return line;
}

/** Render the `/workflow status` list output (deterministic, unchanged labels). */
export function formatStatusList(projection: WorkflowStatusProjection): string {
  if (projection.total === 0) {
    return "No active workflow runs found. Run '/workflow list' to see available workflows, or '/workflow start <name>' to start one.";
  }
  const lines: string[] = [`Active Workflow Runs (${projection.total}):`];
  for (const run of projection.runs) {
    lines.push(`  • ${run.id}`);
    lines.push(`    Workflow:    ${run.workflow}`);
    lines.push(`    Type:        ${run.type}`);
    lines.push(`    Lifecycle:   ${run.lifecycle}`);
    lines.push(`    Step:        ${run.step}`);
    lines.push(`    Age:         ${run.age}`);
    lines.push(`    Next Wakeup: ${run.nextWakeup}`);
    if (run.blocker) {
      const humanReq = run.blocker.requiresHuman ? " (human action required)" : "";
      const reason = run.blocker.reasonOmitted ? "(reason omitted)" : run.blocker.reason;
      lines.push(`    Blocker:     ${reason}${humanReq}`);
    }
    if (run.completionSummary !== undefined) {
      lines.push(`    Completion:  ${run.completionSummary}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Detailed safe run diagnostics (command `status <run-id>`)
// ---------------------------------------------------------------------------

export interface WorkflowCapabilitySummary {
  readonly required: readonly string[];
  readonly satisfied: readonly string[];
  readonly missing: readonly string[];
  readonly incompatible: readonly string[];
  readonly degraded: readonly string[];
  readonly optionalMissing: readonly string[];
}

export interface WorkflowBudgetView {
  readonly maxTurns?: number;
  readonly maxAttempts?: number;
  readonly maxDurationMs?: number;
  readonly onExhaustion?: "block" | "cancel";
  readonly turnsUsed: number;
  readonly attemptsUsed: number;
  readonly elapsedMs: number;
  readonly durationRemainingMs?: number;
}

export interface WorkflowEvidenceView {
  readonly type: string;
  readonly description: string;
  readonly descriptionOmitted: boolean;
}

export interface WorkflowEffectView {
  readonly key: string;
  readonly kind: string;
  readonly status: string;
  readonly ambiguous: boolean;
  readonly recoveryNote?: string;
}

export interface WorkflowRecoveryView {
  readonly type: string;
  readonly timestamp: number;
  readonly message: string;
}

/** Safe, bounded, deterministic diagnostics for a single run. */
export interface WorkflowRunDiagnosticView {
  readonly id: string;
  readonly workflow: string;
  readonly type: WorkflowKind;
  readonly objective?: string;
  readonly lifecycle: WorkflowRunLifecycle;
  readonly step: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly age: string;
  readonly turns: number;
  readonly attempts: number;
  readonly definition: {
    readonly source: string;
    readonly sha256: string;
    readonly schemaVersion: string;
    readonly definitionVersion: number | string;
    readonly mode: string;
    readonly requires: readonly string[];
  };
  readonly budget: WorkflowBudgetView;
  readonly scheduler: SchedulerLinkage;
  readonly capabilities?: WorkflowCapabilitySummary;
  readonly verification: string;
  readonly blocker?: WorkflowStatusBlockerView;
  readonly completionClaim?: { readonly summary: string; readonly summaryOmitted: boolean; readonly evidenceCount: number };
  readonly verificationFindings?: {
    readonly decision: "accepted" | "rejected";
    readonly attempt: number;
    readonly feedback?: string;
  };
  readonly completion?: {
    readonly summary: string;
    readonly summaryOmitted: boolean;
    readonly evidence: readonly WorkflowEvidenceView[];
  };
  readonly effects: readonly WorkflowEffectView[];
  readonly recoveryEvents: readonly WorkflowRecoveryView[];
  readonly latestReconciliation?: WorkflowRecoveryView;
  readonly dataKeys: readonly string[];
  readonly leased: boolean;
  readonly leaseExpiresAt?: number;
}

function capabilitySummary(resolution: CapabilityResolution | undefined): WorkflowCapabilitySummary | undefined {
  if (!resolution) return undefined;
  return Object.freeze({
    required: Object.freeze(resolution.items.filter((i) => !i.optional).map((i) => i.name)),
    satisfied: Object.freeze([...resolution.satisfied]),
    missing: Object.freeze([...resolution.missing]),
    incompatible: Object.freeze([...resolution.incompatible]),
    degraded: Object.freeze([...resolution.degraded]),
    optionalMissing: Object.freeze([...resolution.optionalMissing]),
  });
}

const RECONCILIATION_TYPES = new Set([
  "effect_reconciled",
  "effect_aborted",
  "effect_ambiguous",
  "scheduler_reconnected",
  "scheduler_recreated",
  "scheduler_cleaned",
  "scheduler_ambiguous",
  "run_reconciled",
]);

function recoveryView(event: WorkflowRecoveryEvent): WorkflowRecoveryView {
  return Object.freeze({
    type: event.type,
    timestamp: event.timestamp,
    message: sanitizeDiagnosticText(event.message, MAX_DIAGNOSTIC_TEXT_LENGTH).text,
  });
}

/**
 * Build a bounded, sanitized diagnostic view for a run. The raw `WorkflowRun`
 * (which carries arbitrary data values, evidence locations, provider-shaped
 * payloads and mutable-ish fields) is never returned to a command's `data`.
 */
export function buildRunDiagnostic(
  run: WorkflowRun,
  adapter: LoopSchedulerAdapter,
  options: { capabilityRegistry?: WorkflowCapabilityRegistry; now?: number } = {}
): WorkflowRunDiagnosticView {
  const now = options.now ?? Date.now();
  const effectiveBudget = run.budget ?? run.snapshot.budget;
  const requirements =
    run.snapshot.capabilityRequirements && run.snapshot.capabilityRequirements.length > 0
      ? run.snapshot.capabilityRequirements
      : run.snapshot.requires;
  let capabilities: WorkflowCapabilitySummary | undefined;
  if (options.capabilityRegistry) {
    try {
      capabilities = capabilitySummary(options.capabilityRegistry.resolveRequirements(requirements));
    } catch {
      capabilities = undefined;
    }
  }

  const elapsedMs = Math.max(0, now - (run.startedAt ?? run.createdAt));
  const maxDurationMs = effectiveBudget?.maxDurationMs;
  const budget: WorkflowBudgetView = Object.freeze({
    ...(effectiveBudget?.maxTurns !== undefined ? { maxTurns: effectiveBudget.maxTurns } : {}),
    ...(effectiveBudget?.maxAttempts !== undefined ? { maxAttempts: effectiveBudget.maxAttempts } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    ...(effectiveBudget?.onExhaustion !== undefined ? { onExhaustion: effectiveBudget.onExhaustion } : {}),
    turnsUsed: run.turns,
    attemptsUsed: run.attempts,
    elapsedMs,
    ...(maxDurationMs !== undefined ? { durationRemainingMs: Math.max(0, maxDurationMs - elapsedMs) } : {}),
  });

  const blocker = run.blocker
    ? Object.freeze({
        reason: sanitizeDiagnosticText(run.blocker.reason, MAX_DIAGNOSTIC_TEXT_LENGTH).text,
        reasonOmitted: false,
        ...(run.blocker.category ? { category: run.blocker.category } : {}),
        requiresHuman: run.blocker.requiresHuman === true,
        blockedAt: run.blocker.blockedAt,
      })
    : undefined;

  const completionClaim = run.completionClaim
    ? (() => {
        const summary = sanitizeDiagnosticText(run.completionClaim!.summary, MAX_DIAGNOSTIC_TEXT_LENGTH);
        return Object.freeze({
          summary: summary.text,
          summaryOmitted: summary.omitted,
          evidenceCount: run.completionClaim!.evidence.length,
        });
      })()
    : undefined;

  const verificationFindings = run.verificationFindings
    ? Object.freeze({
        decision: run.verificationFindings.decision,
        attempt: run.verificationFindings.attempt,
        ...(run.verificationFindings.feedback
          ? { feedback: sanitizeDiagnosticText(run.verificationFindings.feedback, MAX_DIAGNOSTIC_TEXT_LENGTH).text }
          : {}),
      })
    : undefined;

  const completion = run.completion
    ? (() => {
        const summary = sanitizeDiagnosticText(run.completion!.summary, MAX_DIAGNOSTIC_TEXT_LENGTH);
        const evidence: WorkflowEvidenceView[] = run.completion!.evidence
          .slice(0, MAX_EVIDENCE_DISPLAY)
          .map((item: WorkflowEvidence) => {
            const description = sanitizeDiagnosticText(item.description, MAX_DIAGNOSTIC_TEXT_LENGTH);
            return Object.freeze({
              type: sanitizeDiagnosticText(item.type, 64).text,
              description: description.text,
              descriptionOmitted: description.omitted,
            });
          });
        return Object.freeze({ summary: summary.text, summaryOmitted: summary.omitted, evidence: Object.freeze(evidence) });
      })()
    : undefined;

  const effects: readonly WorkflowEffectView[] = Object.freeze(
    Object.keys(run.effects ?? {})
      .sort()
      .map((key) => {
        const effect = run.effects![key];
        return Object.freeze({
          key: sanitizeDiagnosticText(effect.key, 128).text,
          kind: sanitizeDiagnosticText(effect.kind, 128).text,
          status: effect.status,
          ambiguous: effect.ambiguous === true,
          ...(effect.recoveryNote
            ? { recoveryNote: sanitizeDiagnosticText(effect.recoveryNote, MAX_DIAGNOSTIC_TEXT_LENGTH).text }
            : {}),
        });
      })
  );

  const recoveryEvents: readonly WorkflowRecoveryView[] = Object.freeze(
    (run.recoveryEvents ?? []).map(recoveryView)
  );

  let latestReconciliation: WorkflowRecoveryView | undefined;
  for (let i = recoveryEvents.length - 1; i >= 0; i--) {
    if (RECONCILIATION_TYPES.has(recoveryEvents[i].type)) {
      latestReconciliation = recoveryEvents[i];
      break;
    }
  }

  const definition = Object.freeze({
    source: run.definitionSource,
    sha256: typeof run.snapshot.source?.sha256 === "string" ? run.snapshot.source.sha256.slice(0, 12) : "",
    schemaVersion: run.snapshot.schemaVersion,
    definitionVersion: run.definitionVersion,
    mode: run.snapshot.mode,
    requires: Object.freeze([...run.snapshot.requires]),
  });

  const objectiveSanitized = run.objective !== undefined ? sanitizeDiagnosticText(run.objective, MAX_DIAGNOSTIC_TEXT_LENGTH) : undefined;

  return Object.freeze({
    id: run.id,
    workflow: run.workflow,
    type: workflowKindOf(run),
    ...(objectiveSanitized && !objectiveSanitized.omitted ? { objective: objectiveSanitized.text } : {}),
    lifecycle: run.lifecycle,
    step: run.step,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
    age: formatAge(run.createdAt, now),
    turns: run.turns,
    attempts: run.attempts,
    definition,
    budget,
    scheduler: projectSchedulerLinkage(run, adapter),
    ...(capabilities ? { capabilities } : {}),
    verification: describeVerification(run),
    ...(blocker ? { blocker } : {}),
    ...(completionClaim ? { completionClaim } : {}),
    ...(verificationFindings ? { verificationFindings } : {}),
    ...(completion ? { completion } : {}),
    effects,
    recoveryEvents,
    ...(latestReconciliation ? { latestReconciliation } : {}),
    dataKeys: Object.freeze(Object.keys(run.data).sort()),
    leased: run.lease !== undefined,
    ...(run.lease?.expiresAt !== undefined ? { leaseExpiresAt: run.lease.expiresAt } : {}),
  });
}

/**
 * Describes the verification state of a run without ever implying that an
 * unconfigured (or not-yet-performed) verification happened.
 */
export function describeVerification(run: WorkflowRun): string {
  const findings = run.verificationFindings;
  if (findings) {
    return findings.decision === "accepted"
      ? `accepted by verifier (attempt ${findings.attempt})`
      : `rejected by verifier (attempt ${findings.attempt})`;
  }
  const verifyConfigured = run.snapshot.completion?.verify === true;
  if (!verifyConfigured) {
    return run.lifecycle === "completed" ? "not configured (unverified completion)" : "not configured";
  }
  if (run.lifecycle === "verifying") {
    return "pending (awaiting verifier decision)";
  }
  return "configured (awaiting completion claim)";
}

/**
 * Resolve the human-facing next wakeup string without exposing scheduler task
 * IDs. Reports `unknown` rather than inventing a time when the scheduler cannot
 * supply one.
 */
export function formatNextWakeup(
  run: WorkflowRun,
  adapter: LoopSchedulerAdapter,
  now: number = Date.now()
): string {
  if (run.lifecycle === "paused") {
    return "none (paused)";
  }
  if (run.lifecycle === "blocked") {
    return "none (blocked)";
  }
  if (isTerminalLifecycle(run.lifecycle)) {
    return `none (${run.lifecycle})`;
  }

  const taskId = adapter.getLinkedTaskId(run.id);
  if (!taskId || !adapter.isAvailable()) {
    return "unknown";
  }

  const service = adapter.getService();
  if (!service) {
    return "unknown";
  }

  try {
    const tasks = service.listTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.nextFireAt === undefined || task.nextFireAt === null) {
      return "unknown";
    }

    if (task.nextFireAt <= now) {
      return "due now";
    }

    const deltaMs = task.nextFireAt - now;
    return `in ${formatAge(now - deltaMs, now)}`;
  } catch {
    return "unknown";
  }
}

/** Render the sanitized detailed diagnostics for `/workflow status <run-id>`. */
export function formatRunDiagnostic(view: WorkflowRunDiagnosticView): string {
  const lines: string[] = [
    `Workflow Run: ${view.id}`,
    `  Workflow:    ${view.workflow}`,
    `  Type:        ${view.type}`,
    `  Lifecycle:   ${view.lifecycle}`,
    `  Step:        ${view.step}`,
    `  Age:         ${view.age}`,
    `  Turns:       ${view.turns}`,
    `  Attempts:    ${view.attempts}`,
    `  Next Wakeup: ${formatDiagnosticWakeup(view)}`,
    `  Scheduler:   ${view.scheduler.state} (${view.scheduler.detail})`,
    `  Created:     ${new Date(view.createdAt).toISOString()}`,
    `  Updated:     ${new Date(view.updatedAt).toISOString()}`,
  ];

  if (view.objective !== undefined) {
    lines.push(`  Objective:   ${view.objective}`);
  }
  if (view.startedAt !== undefined) {
    lines.push(`  Started:     ${new Date(view.startedAt).toISOString()}`);
  }
  if (view.completedAt !== undefined) {
    lines.push(`  Completed:   ${new Date(view.completedAt).toISOString()}`);
  }

  lines.push(`  Definition:`);
  lines.push(`    Source:    ${view.definition.source}`);
  lines.push(`    Mode:      ${view.definition.mode}`);
  lines.push(`    Version:   ${view.definition.definitionVersion} (schema ${view.definition.schemaVersion})`);
  if (view.definition.sha256) {
    lines.push(`    Hash:      ${view.definition.sha256}`);
  }
  lines.push(`    Requires:  ${view.definition.requires.length > 0 ? view.definition.requires.join(", ") : "none"}`);

  const budget = view.budget;
  if (
    budget.maxTurns !== undefined ||
    budget.maxAttempts !== undefined ||
    budget.maxDurationMs !== undefined ||
    budget.onExhaustion !== undefined
  ) {
    lines.push(`  Budget:`);
    if (budget.maxTurns !== undefined) lines.push(`    Max Turns:     ${budget.maxTurns} (used ${budget.turnsUsed})`);
    if (budget.maxAttempts !== undefined) lines.push(`    Max Attempts:  ${budget.maxAttempts} (used ${budget.attemptsUsed})`);
    if (budget.maxDurationMs !== undefined) lines.push(`    Max Duration:  ${budget.maxDurationMs}ms (remaining ${budget.durationRemainingMs}ms)`);
    if (budget.onExhaustion !== undefined) lines.push(`    On Exhaustion: ${budget.onExhaustion}`);
  }

  if (view.capabilities) {
    const cap = view.capabilities;
    lines.push(`  Capabilities:`);
    lines.push(`    Required:   ${cap.required.length > 0 ? cap.required.join(", ") : "none"}`);
    lines.push(`    Satisfied:  ${cap.satisfied.length > 0 ? cap.satisfied.join(", ") : "none"}`);
    if (cap.missing.length > 0) lines.push(`    Missing:    ${cap.missing.join(", ")}`);
    if (cap.incompatible.length > 0) lines.push(`    Incompat.:  ${cap.incompatible.join(", ")}`);
    if (cap.degraded.length > 0) lines.push(`    Degraded:   ${cap.degraded.join(", ")}`);
    if (cap.optionalMissing.length > 0) lines.push(`    Opt. missing: ${cap.optionalMissing.join(", ")}`);
  }

  lines.push(`  Verification: ${view.verification}`);

  if (view.blocker) {
    const reason = view.blocker.reasonOmitted ? "(reason omitted)" : view.blocker.reason;
    lines.push(`  Blocker:`);
    lines.push(`    Reason:        ${reason}`);
    if (view.blocker.category) lines.push(`    Category:      ${view.blocker.category}`);
    lines.push(`    RequiresHuman: ${view.blocker.requiresHuman}`);
    lines.push(`    BlockedAt:     ${new Date(view.blocker.blockedAt).toISOString()}`);
  }

  if (view.completionClaim) {
    lines.push(`  Completion Claim:`);
    lines.push(`    Summary:       ${view.completionClaim.summaryOmitted ? "(omitted)" : view.completionClaim.summary}`);
    lines.push(`    Evidence:      ${view.completionClaim.evidenceCount} item(s)`);
  }

  if (view.verificationFindings) {
    lines.push(`  Verification Findings:`);
    lines.push(`    Decision:      ${view.verificationFindings.decision}`);
    if (view.verificationFindings.feedback !== undefined) {
      lines.push(`    Feedback:      ${view.verificationFindings.feedback}`);
    }
    lines.push(`    Attempt:       ${view.verificationFindings.attempt}`);
  }

  if (view.completion) {
    lines.push(`  Completion:`);
    lines.push(`    Summary:       ${view.completion.summaryOmitted ? "(omitted)" : view.completion.summary}`);
    lines.push(`    Evidence:      ${view.completion.evidence.length} item(s)`);
    for (const ev of view.completion.evidence) {
      const desc = ev.descriptionOmitted ? "(description omitted)" : ev.description;
      lines.push(`      • [${ev.type}] ${desc}`);
    }
  }

  if (view.dataKeys.length === 0) {
    lines.push(`  Data:        (empty)`);
  } else {
    lines.push(`  Data Keys:   [${view.dataKeys.join(", ")}] (values omitted to prevent secret exposure)`);
  }

  if (view.effects.length > 0) {
    lines.push(`  Effects (${view.effects.length}):`);
    for (const eff of view.effects) {
      const ambigStr = eff.ambiguous ? " [AMBIGUOUS - RECONCILIATION REQUIRED]" : "";
      lines.push(`    • [${eff.status.toUpperCase()}] ${eff.key} (${eff.kind})${ambigStr}`);
      if (eff.recoveryNote) {
        lines.push(`      Note: ${eff.recoveryNote}`);
      }
    }
  }

  if (view.recoveryEvents.length > 0) {
    const recent = view.recoveryEvents.slice(-MAX_RECOVERY_EVENTS_DISPLAYED);
    lines.push(`  Recovery Events (${view.recoveryEvents.length}):`);
    for (const ev of recent) {
      lines.push(`    • [${new Date(ev.timestamp).toISOString()}] ${ev.type}: ${ev.message}`);
    }
  }

  if (view.latestReconciliation) {
    lines.push(`  Latest Reconciliation: ${view.latestReconciliation.type} at ${new Date(view.latestReconciliation.timestamp).toISOString()}`);
    lines.push(`    ${view.latestReconciliation.message}`);
  }

  if (view.leased) {
    lines.push(`  Lease:       active${view.leaseExpiresAt !== undefined ? ` (expires ${new Date(view.leaseExpiresAt).toISOString()})` : ""}`);
  }

  return lines.join("\n");
}

function formatDiagnosticWakeup(view: WorkflowRunDiagnosticView): string {
  const link = view.scheduler;
  if (link.state === "not-applicable") {
    return view.lifecycle === "paused" ? "none (paused)" : view.lifecycle === "blocked" ? "none (blocked)" : `none (${view.lifecycle})`;
  }
  if (link.nextFireAt === undefined) {
    return "unknown";
  }
  return formatClockTime(link.nextFireAt);
}

// ---------------------------------------------------------------------------
// History view formatting
// ---------------------------------------------------------------------------

/** Render a bounded, sanitized, deterministic view of a run's recent history. */
export function formatRunHistory(view: WorkflowRunHistoryView): string {
  const header =
    view.entries.length === 0
      ? `Run History: ${view.runId} (no retained events; ${view.total} lifetime)`
      : `Run History: ${view.runId} (${view.entries.length} shown, ${view.retained} retained, ${view.total} lifetime, ${view.dropped} dropped)`;
  const lines: string[] = [header];

  for (const entry of view.entries) {
    const summary = sanitizeDiagnosticText(entry.summary, MAX_DIAGNOSTIC_TEXT_LENGTH).text;
    lines.push(`  • [${new Date(entry.timestamp).toISOString()}] ${entry.action} — ${summary}`);
  }

  if (view.truncated) {
    lines.push(
      `  ⚠ Older events are not shown: ${view.dropped} lifetime event(s) dropped from the bounded ${view.retained}-entry projection. The append-only session log remains the durable source of truth.`
    );
  }
  if (view.limited) {
    lines.push(`  ⚠ Showing the most recent ${view.entries.length} of ${view.retained} retained events (requested limit ${view.limit}).`);
  }
  return lines.join("\n");
}

/** Safe structured history payload for a command's `data` (no raw run/values). */
export interface WorkflowHistoryData {
  readonly runId: string;
  readonly entries: readonly {
    readonly eventId: string;
    readonly action: string;
    readonly timestamp: number;
    readonly summary: string;
  }[];
  readonly retained: number;
  readonly total: number;
  readonly dropped: number;
  readonly truncated: boolean;
  readonly limited: boolean;
  readonly limit: number;
  readonly order: "oldest" | "newest";
}

export function buildHistoryData(view: WorkflowRunHistoryView): WorkflowHistoryData {
  return Object.freeze({
    runId: view.runId,
    entries: Object.freeze(
      view.entries.map((entry) =>
        Object.freeze({
          eventId: entry.eventId,
          action: entry.action,
          timestamp: entry.timestamp,
          summary: sanitizeDiagnosticText(entry.summary, MAX_DIAGNOSTIC_TEXT_LENGTH).text,
        })
      )
    ),
    retained: view.retained,
    total: view.total,
    dropped: view.dropped,
    truncated: view.truncated,
    limited: view.limited,
    limit: view.limit,
    order: view.order,
  });
}

/** JSON-safe helper retained for callers that need an object's bounded keys. */
export function safeDataKeys(data: Readonly<Record<string, JsonValue>>): readonly string[] {
  return Object.freeze(Object.keys(data).sort());
}

/** Maximum completion-evidence rows rendered by the detailed diagnostics. */
const MAX_EVIDENCE_DISPLAY = 10;
