/**
 * Deterministic prompt construction for workflow iterations.
 */

import { getAmbiguousEffects, hasAmbiguousEffects } from "./run.ts";
import type { WorkflowRun } from "./types.ts";

/**
 * Deterministically sorts object keys deeply to ensure stable JSON output.
 */
function sortJson(value: any): any {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  const sortedKeys = Object.keys(value).sort();
  const result: Record<string, any> = {};
  for (const key of sortedKeys) {
    result[key] = sortJson(value[key]);
  }
  return result;
}

/**
 * Produces deterministic JSON string with sorted keys.
 */
export function deterministicJsonStringify(value: any, space = 2): string {
  return JSON.stringify(sortJson(value), null, space);
}

/**
 * Extracts a workflow run ID from an iteration prompt text.
 * Matches standard prompt header "- Run ID: <id>" or explicit marker "[pi-workflow:run:<id>]".
 * Returns undefined if no run ID is present.
 */
export function extractWorkflowRunId(prompt: string): string | undefined {
  if (typeof prompt !== "string" || !prompt) {
    return undefined;
  }
  const match = prompt.match(/(?:^|\n)-\s*Run ID:\s*([^\s\r\n]+)/m);
  if (match) {
    return match[1].trim();
  }
  const markerMatch =
    prompt.match(/\[pi-workflow:run:([^\s\]]+)\]/) ||
    prompt.match(/<!--\s*pi-workflow:run:([^\s>]+)\s*-->/);
  if (markerMatch) {
    return markerMatch[1].trim();
  }
  return undefined;
}

/**
 * Extracts a workflow owner / runner instance identifier from an iteration prompt text.
 * Matches standard prompt header "- Owner: <ownerId>" or explicit marker "[pi-workflow:owner:<ownerId>]".
 * Returns undefined if no owner ID is present.
 */
export function extractWorkflowOwnerId(prompt: string): string | undefined {
  if (typeof prompt !== "string" || !prompt) {
    return undefined;
  }
  const match = prompt.match(/(?:^|\n)-\s*Owner:\s*([^\s\r\n]+)/m);
  if (match) {
    return match[1].trim();
  }
  const markerMatch =
    prompt.match(/\[pi-workflow:owner:([^\s\]]+)\]/) ||
    prompt.match(/<!--\s*pi-workflow:owner:([^\s>]+)\s*-->/);
  if (markerMatch) {
    return markerMatch[1].trim();
  }
  return undefined;
}

export interface BuildIterationPromptOptions {
  /** Authoritative run record */
  run: WorkflowRun;
  /** Available capabilities (optional) */
  availableCapabilities?: Iterable<string> | Record<string, boolean>;
  /** Fixed timestamp for testing / reproducibility (optional) */
  now?: number;
}

/**
 * Builds a constrained verification iteration prompt combining:
 * 1. Engine preamble describing verification role and Run ID
 * 2. Submitted completion claim summary and evidence items
 * 3. Specific workflow verifierPrompt policy instructions (if defined)
 * 4. Current durable run data
 * 5. Constrained verifier actions (workflow_verify accept/reject, or workflow_block)
 */
export function buildVerifierPrompt(options: BuildIterationPromptOptions): string {
  const { run } = options;
  const snapshot = run.snapshot;
  const claim = run.completionClaim;
  const verifierPrompt = snapshot.completion?.verifierPrompt;

  const claimSummary = claim?.summary ?? (run.data?._pendingCompletionSummary as string) ?? "No summary provided";
  const claimEvidence = claim?.evidence ?? [];

  const lines: (string | null)[] = [
    `# Workflow Completion Verification: ${run.workflow}`,
    `- Run ID: ${run.id}`,
    `- Definition: ${snapshot.name}`,
    `- Source: ${run.definitionSource}`,
    `- Step: VERIFYING`,
    `- Verification Attempt: ${(run.verificationAttempts ?? 0) + 1}`,
    ``,
    `You are executing an authoritative verification turn for workflow "${run.workflow}".`,
    `A completion claim has been submitted and must be verified before the workflow can be marked complete.`,
    ``,
    `## Submitted Completion Claim`,
    `- Summary: ${claimSummary}`,
  ];

  if (run.lease?.ownerId) {
    lines.splice(4, 0, `- Owner: ${run.lease.ownerId}`);
  }

  if (claimEvidence.length > 0) {
    lines.push(`- Evidence Items (${claimEvidence.length}):`);
    for (const ev of claimEvidence) {
      lines.push(`  * [${ev.type}] ${ev.description}${ev.url ? ` (${ev.url})` : ""}${ev.path ? ` (${ev.path})` : ""}`);
    }
  } else {
    lines.push(`- Evidence Items: None provided`);
  }

  lines.push(``);
  lines.push(`## Verification Instructions`);
  if (verifierPrompt) {
    lines.push(verifierPrompt.trim());
  } else {
    lines.push(
      `Inspect the claimed deliverables, outputs, and evidence above. Verify that all requirements and acceptance criteria have been satisfied.`
    );
  }

  lines.push(``);
  lines.push(`## Current Run State & Data`);
  lines.push(`- Lifecycle: ${run.lifecycle}`);
  lines.push(`- Data:`);
  lines.push("```json");
  lines.push(deterministicJsonStringify(run.data, 2));
  lines.push("```");

  lines.push(``);
  lines.push(`## Required Verification Action`);
  lines.push(`You must execute one of the following model tools to record your authoritative verification finding:`);
  lines.push(
    `1. \`workflow_verify({ decision: "accept", findings: "..." })\` to accept the claim and mark the workflow completed.`
  );
  lines.push(
    `2. \`workflow_verify({ decision: "reject", findings: "...", returnStep?: "..." })\` to reject the claim and return for rework.`
  );
  lines.push(
    `3. \`workflow_block({ reason: "...", requiresHuman?: boolean })\` if verification is blocked by external conditions.`
  );

  return lines.filter((line) => line !== null).join("\n");
}

/**
 * Builds a constrained recovery reconciliation iteration prompt combining:
 * 1. Engine preamble describing recovery context, run ID, and ambiguous effects
 * 2. Strict directive NOT to repeat unconfirmed external effects
 * 3. Step-by-step instructions to observe external reality and reconcile
 * 4. Current durable run state and data
 * 5. Constrained recovery actions (workflow_effect_commit, workflow_effect_reconcile, or workflow_block)
 */
export function buildRecoveryPrompt(options: BuildIterationPromptOptions): string {
  const { run } = options;
  const snapshot = run.snapshot;
  const ambiguousEffects = getAmbiguousEffects(run);

  const lines: (string | null)[] = [
    `# Workflow Recovery & Reconciliation: ${run.workflow}`,
    `- Run ID: ${run.id}`,
    `- Definition: ${snapshot.name}`,
    `- Source: ${run.definitionSource}`,
    `- Current Step: ${run.step}`,
    `- Lifecycle: ${run.lifecycle}`,
  ];

  if (run.lease?.ownerId) {
    lines.splice(4, 0, `- Owner: ${run.lease.ownerId}`);
  }

  lines.push(
    ``,
    `## RECOVERY REQUIRED: Ambiguous External Effects Detected`,
    `This workflow was interrupted while one or more external side effects were in progress.`,
    `Durable state records the following effect(s) that were started before interruption but never committed:`,
    ``,
  );

  for (const effect of ambiguousEffects) {
    lines.push(`### Effect: "${effect.key}"`);
    lines.push(`- Kind: ${effect.kind}`);
    lines.push(`- Started At: ${new Date(effect.startedAt).toISOString()}`);
    if (effect.inputSummary !== undefined) {
      lines.push(`- Input Summary:`);
      lines.push("```json");
      lines.push(deterministicJsonStringify(effect.inputSummary, 2));
      lines.push("```");
    }
  }

  lines.push(``);
  lines.push(`## Critical Reconciliation Directive`);
  lines.push(`DO NOT blindly re-execute the external action(s) above!`);
  lines.push(`You must observe external reality first:`);
  lines.push(`1. Inspect the external system (e.g. check if the PR, commit, issue, or resource already exists).`);
  lines.push(`2. If the external action ALREADY SUCCEEDED in the real world:`);
  lines.push(`   Confirm and commit it using \`workflow_effect_commit({ key: "<key>", resultSummary: { ... } })\`.`);
  lines.push(`3. If the external action did NOT occur or failed:`);
  lines.push(`   Reconcile it using \`workflow_effect_reconcile({ key: "<key>", resolution: "aborted" | "retryable", reason: "..." })\`.`);
  lines.push(`4. If external state is ambiguous or requires human decision:`);
  lines.push(`   Halt execution using \`workflow_block({ reason: "...", category: "human-required", requiresHuman: true })\`.`);
  lines.push(``);
  lines.push(`## Current Run State & Data`);
  lines.push(`- Data:`);
  lines.push("```json");
  lines.push(deterministicJsonStringify(run.data, 2));
  lines.push("```");
  lines.push(``);
  lines.push(`## Required Reconciliation Action`);
  lines.push(`Choose one of the following tools to resolve the ambiguous effect:`);
  lines.push(`1. \`workflow_effect_commit({ key: "...", resultSummary?: { ... } })\` if external action was confirmed.`);
  lines.push(`2. \`workflow_effect_reconcile({ key: "...", resolution: "committed" | "aborted" | "retryable", reason: "..." })\` to resolve or abort.`);
  lines.push(`3. \`workflow_block({ reason: "...", category: "human-required", requiresHuman: true })\` if uncertain.`);

  return lines.filter((line) => line !== null).join("\n");
}

/**
 * Builds a deterministic iteration prompt combining:
 * 1. Engine preamble describing run context and tool contracts
 * 2. Workflow definition Markdown policy body
 * 3. Current durable run state and data
 * 4. Concise instructions requiring the iteration to choose an action
 */
export function buildIterationPrompt(options: BuildIterationPromptOptions): string {
  const { run } = options;
  if (hasAmbiguousEffects(run)) {
    return buildRecoveryPrompt(options);
  }
  if (run.step === "VERIFYING" || run.data?._verificationRequested === true) {
    return buildVerifierPrompt(options);
  }

  const snapshot = run.snapshot;
  const maxTurns = snapshot.budget?.maxTurns;
  const maxAttempts = snapshot.budget?.maxAttempts;
  const maxDuration = snapshot.budget?.maxDuration;

  let turnsStr = `${run.turns}`;
  if (maxTurns !== undefined) {
    turnsStr += ` / ${maxTurns}`;
  }

  let attemptsStr = `${run.attempts}`;
  if (maxAttempts !== undefined) {
    attemptsStr += ` / ${maxAttempts}`;
  }

  const versionStr = String(snapshot.schemaVersion).startsWith("v")
    ? String(snapshot.schemaVersion)
    : `v${snapshot.schemaVersion}`;

  const lines: (string | null)[] = [
    `# Workflow Execution: ${run.workflow}`,
    `- Run ID: ${run.id}`,
    `- Definition: ${snapshot.name} (schema ${versionStr})`,
    `- Source: ${run.definitionSource}`,
  ];

  if (run.lease?.ownerId) {
    lines.push(`- Owner: ${run.lease.ownerId}`);
  }

  lines.push(
    ``,
    `You are executing an iteration turn of the workflow "${run.workflow}".`,
    `Interact with the workflow engine using the following model tools:`,
    `- \`workflow_get_context\`: Inspect current iteration state, counters, limits, and capabilities.`,
    `- \`workflow_transition\`: Atomically advance to another step and optionally update run data.`,
    `- \`workflow_continue\`: Request the next wakeup for this run via named policy or bounded delay.`,
    `- \`workflow_block\`: Halt execution if blocked by external conditions or requiring human action.`,
    `- \`workflow_complete\`: Submit completion summary and evidence to complete or verify the run.`,
    ``,
    `## Workflow Policy`,
    snapshot.body.trim(),
    ``,
    `## Current Run State`,
    `- Lifecycle: ${run.lifecycle}`,
    `- Current Step: ${run.step}`,
    `- Turn: ${turnsStr}`,
    `- Attempts: ${attemptsStr}`,
  );

  if (maxDuration) {
    lines.push(`- Max Duration: ${maxDuration}`);
  }

  lines.push(
    `- Data:`,
    "```json",
    deterministicJsonStringify(run.data, 2),
    "```",
    ``,
    `## Required Action`,
    `You must choose and execute one of the following workflow actions during this turn:`,
    `1. \`workflow_transition({ toStep: "...", data?: { ... }, reason?: "..." })\` to advance step.`,
    `2. \`workflow_continue({ delay?: "...", wakeupName?: "...", reason?: "..." })\` to schedule the next iteration.`,
    `3. \`workflow_block({ reason: "...", requiresHuman?: boolean, data?: { ... } })\` if blocked.`,
    `4. \`workflow_complete({ summary: "...", evidence?: [...], data?: { ... } })\` when finished.`
  );

  return lines.filter((line) => line !== null).join("\n");
}
