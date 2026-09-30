/**
 * Deterministic prompt construction for workflow iterations.
 */

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

export interface BuildIterationPromptOptions {
  /** Authoritative run record */
  run: WorkflowRun;
  /** Available capabilities (optional) */
  availableCapabilities?: Iterable<string> | Record<string, boolean>;
  /** Fixed timestamp for testing / reproducibility (optional) */
  now?: number;
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
  ];

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
