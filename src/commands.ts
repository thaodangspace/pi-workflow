/**
 * Human-facing command surface and lifecycle controller for pi-workflow.
 *
 * Implements `/workflow list|start <name>|status [run-id]|pause <run-id>|resume <run-id>|stop <run-id>|reload|help`.
 * Exposes workflow-level concepts, stable run IDs, actionable errors,
 * strict disambiguation between workflow names and run IDs, deterministic ordering,
 * capability validation, and sensible text fallbacks for non-TUI modes.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createLoopCapabilityRegistration,
  createWorkflowCapabilityRegistry,
  normalizeCapabilityRequirements,
  type CapabilityResolution,
  type WorkflowCapabilityRegistry,
  type WorkflowCapabilityRequirement,
} from "./capabilities.ts";
import type { WorkflowDispatcher } from "./dispatcher.ts";
import { loadWorkflows, type LoadWorkflowsOptions } from "./loader.ts";
import type { WorkflowRunRegistry } from "./registry.ts";
import { isTerminalLifecycle } from "./run.ts";
import { LOOP_SERVICE_VERSION } from "pi-loop/service";
import type { LoopSchedulerAdapter } from "./scheduler-adapter.ts";
import {
  type JsonValue,
  type WorkflowDefinitionV1,
  WorkflowCapabilityError,
  WorkflowConcurrencyError,
  WorkflowInvalidTransitionError,
  type WorkflowRun,
  WorkflowRunError,
  WorkflowRunNotFoundError,
  WorkflowUnsupportedBudgetError,
  WorkflowValidationError,
  isGoalKind,
  workflowKindOf,
} from "./types.ts";

/**
 * Autocomplete item format compatible with Pi's getArgumentCompletions.
 */
export interface CommandAutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

/**
 * Outcome of executing a workflow command.
 */
export interface WorkflowCommandResult {
  ok: boolean;
  action: string;
  output: string;
  error?: string;
  data?: unknown;
}

/**
 * Configuration options for WorkflowCommandController.
 */
export interface WorkflowCommandControllerOptions {
  registry: WorkflowRunRegistry;
  adapter: LoopSchedulerAdapter;
  dispatcher?: WorkflowDispatcher;
  cwd?: string;
  loadOptions?: LoadWorkflowsOptions;
  /** Trusted, explicitly declared capability names (authoritative; not a tool-name heuristic). */
  capabilities?: Iterable<string> | (() => Iterable<string> | Promise<Iterable<string>>);
  /**
   * Optional shared session-scoped capability registry. When omitted, the
   * controller creates its own, seeded with the public pi-loop service and any
   * explicit `capabilities`.
   */
  capabilityRegistry?: WorkflowCapabilityRegistry;
  outputStream?: (text: string) => void;
  pi?: ExtensionAPI;
}

/**
 * Returns the structured requirement list for a workflow definition/snapshot,
 * falling back to legacy bare capability names.
 */
export function declaredRequirements(def: {
  requires: readonly string[];
  capabilityRequirements?: readonly WorkflowCapabilityRequirement[];
}): readonly (string | WorkflowCapabilityRequirement)[] {
  return def.capabilityRequirements && def.capabilityRequirements.length > 0
    ? def.capabilityRequirements
    : def.requires;
}

/**
 * Builds an actionable capability error message. For the legacy case of only
 * missing names, returns undefined so the error keeps its canonical wording.
 */
export function buildCapabilityErrorMessage(
  workflowName: string,
  resolution: CapabilityResolution
): string | undefined {
  if (resolution.incompatible.length === 0) {
    return undefined;
  }
  const reasons = resolution.items
    .filter((item) => !item.optional && !item.satisfied && item.reason)
    .map((item) => item.reason)
    .join("; ");
  const missingPart = resolution.missing.length > 0 ? `missing: [${resolution.missing.join(", ")}]` : "";
  const incompatiblePart =
    resolution.incompatible.length > 0 ? `incompatible: [${resolution.incompatible.join(", ")}]` : "";
  const summary = [missingPart, incompatiblePart].filter(Boolean).join(", ");
  return `Workflow "${workflowName}" requires capabilities that are not satisfied (${summary}). ${reasons}`;
}

/**
 * Format age from epoch milliseconds into human-readable duration string.
 */
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

/**
 * Resolve next wakeup display string for a workflow run without exposing raw task IDs.
 * If the scheduler cannot supply next wakeup, reports "unknown" rather than inventing it.
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
 * Parsed representation of a CLI invocation.
 */
export interface ParsedWorkflowCommand {
  subcommand: string;
  target?: string;
  extra: string[];
}

/**
 * Parse raw arguments string into subcommand and targets.
 */
export function parseWorkflowCommandArgs(rawArgs: string): ParsedWorkflowCommand {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { subcommand: "help", extra: [] };
  }

  const subcommand = parts[0].toLowerCase();
  const target = parts[1];
  const extra = parts.slice(2);

  return { subcommand, target, extra };
}

/**
 * Result of resolving an argument as a run ID versus workflow definition name.
 */
export interface ResolvedRunTarget {
  kind: "run" | "definition" | "ambiguous" | "unknown";
  run?: WorkflowRun;
  definitionName?: string;
  ambiguousMatches?: string[];
  raw: string;
}

/**
 * Workflow lifecycle controller managing definition discovery, run controls,
 * status inspection, and human command interactions.
 */
export class WorkflowCommandController {
  readonly registry: WorkflowRunRegistry;
  readonly adapter: LoopSchedulerAdapter;
  readonly dispatcher?: WorkflowDispatcher;
  readonly capabilityRegistry: WorkflowCapabilityRegistry;
  private options: WorkflowCommandControllerOptions;
  private discoveredDefinitions = new Map<string, WorkflowDefinitionV1>();
  private definitionsLoaded = false;
  private explicitCapabilitiesSeeded = false;

  constructor(options: WorkflowCommandControllerOptions) {
    this.options = options;
    this.registry = options.registry;
    this.adapter = options.adapter;
    this.dispatcher = options.dispatcher;
    this.capabilityRegistry =
      options.capabilityRegistry ??
      createWorkflowCapabilityRegistry({ sessionId: options.adapter?.sessionId });

    // Advertise the public pi-loop service as the `loop` capability. Status is
    // resolved dynamically from the versioned service contract, so a degraded
    // or missing scheduler is never silently treated as healthy.
    if (!this.capabilityRegistry.isDisposed() && !this.capabilityRegistry.has("loop")) {
      try {
        this.capabilityRegistry.register(
          createLoopCapabilityRegistration({
            version: LOOP_SERVICE_VERSION,
            isAvailable: () => this.adapter.isAvailable(),
            reason: () => "the pi-loop scheduler service for this session is unavailable",
          })
        );
      } catch {
        // Conflicting registration must not break command setup.
      }
    }
  }

  /**
   * Registers explicit, trusted capability declarations supplied by the host.
   * These are authoritative assertions (not a tool-name heuristic) and are
   * registered lazily because a provider function may be asynchronous.
   */
  private async seedExplicitCapabilities(): Promise<void> {
    if (this.explicitCapabilitiesSeeded) {
      return;
    }
    this.explicitCapabilitiesSeeded = true;
    const source = this.options.capabilities;
    if (!source || this.capabilityRegistry.isDisposed()) {
      return;
    }
    let values: Iterable<string>;
    try {
      values = typeof source === "function" ? await source() : source;
    } catch {
      return;
    }
    for (const raw of values) {
      const name = typeof raw === "string" ? raw.trim() : "";
      if (!name) {
        continue;
      }
      try {
        // Explicit declarations override dynamic discovery for the same name.
        this.capabilityRegistry.register({ name, version: 1, features: [] }, { replace: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Returns the names of capabilities currently satisfied by registered
   * providers (available or degraded), plus explicit trusted declarations.
   *
   * This deliberately does NOT inspect `pi.getAllTools()`: a registered tool or
   * namespace is a discovery hint at best and cannot prove that a compatible,
   * healthy provider exists (binary installed, credentials valid, version
   * matched). Only explicit provider registrations count.
   */
  async getAvailableCapabilities(_pi?: ExtensionAPI): Promise<Set<string>> {
    await this.seedExplicitCapabilities();
    const caps = new Set<string>();
    for (const capability of this.capabilityRegistry.listCapabilities()) {
      if (capability.status !== "unavailable") {
        caps.add(capability.name);
      }
    }
    return caps;
  }

  /**
   * Validates definition compatibility between an existing run snapshot and on-disk definition.
   *
   * Explicit compatibility policy:
   * 1. Missing on-disk definition:
   *    Allowed and safe. The run executes against its deeply frozen, content-addressed snapshot,
   *    preserving its original prompt, policies, and configuration even if the definition file
   *    was deleted or moved.
   * 2. On-disk definition present:
   *    - The definition mode must match (e.g. self-paced run cannot be resumed if disk def changed to cron/fixed).
   *    - The schema version must match.
   *    - Any newly added required capabilities on disk must also be checked against available capabilities.
   */
  async validateDefinitionCompatibility(
    run: WorkflowRun,
    pi?: ExtensionAPI
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Synthetic, snapshot-only goal definitions have no on-disk file by design.
    // Their immutable snapshot is authoritative; there is nothing on disk to
    // compare against, and the reserved goal name cannot be produced by the
    // loader, so this bypass is safe and cannot skip a real compatibility check.
    if (isGoalKind(run) || isGoalKind(run.snapshot)) {
      return { ok: true };
    }

    await this.ensureDefinitionsLoaded();
    const onDiskDef = this.discoveredDefinitions.get(run.workflow);

    if (!onDiskDef) {
      // Missing definition on disk: safe to resume from frozen snapshot
      return { ok: true };
    }

    // 1. Mode mismatch check
    if (onDiskDef.mode !== run.snapshot.mode) {
      return {
        ok: false,
        reason: `On-disk workflow definition mode "${onDiskDef.mode}" conflicts with run snapshot mode "${run.snapshot.mode}". Execution mode cannot change across iterations.`,
      };
    }

    // 2. Schema version check
    if (onDiskDef.schemaVersion !== run.snapshot.schemaVersion) {
      return {
        ok: false,
        reason: `On-disk workflow definition schema version "${onDiskDef.schemaVersion}" is incompatible with run snapshot version "${run.snapshot.schemaVersion}".`,
      };
    }

    // 3. Check if on-disk definition added new required capabilities
    const diskCapCheck = await this.validateCapabilities(
      run.workflow,
      declaredRequirements(onDiskDef),
      pi,
      run.id
    );
    if (!diskCapCheck.ok) {
      const incompatible =
        "incompatible" in diskCapCheck && diskCapCheck.incompatible.length > 0
          ? ` Incompatible: [${diskCapCheck.incompatible.join(", ")}].`
          : "";
      return {
        ok: false,
        reason: `On-disk workflow definition requires additional capabilities: [${diskCapCheck.missing.join(
          ", "
        )}] which are not currently available.${incompatible}`,
      };
    }

    return { ok: true };
  }

  /**
   * Validate that all required capabilities are satisfied by the currently
   * registered providers. Accepts bare names and structured requirements.
   *
   * Distinguished outcomes:
   * - `missing`: no provider (or an unavailable one) for a required name;
   * - `incompatible`: provider present but below the required version or
   *   lacking a required feature.
   */
  async validateCapabilities(
    workflowName: string,
    requirements: readonly (string | WorkflowCapabilityRequirement)[],
    _pi?: ExtensionAPI,
    runId?: string
  ): Promise<
    | { ok: true }
    | { ok: false; missing: string[]; incompatible: string[]; error: WorkflowCapabilityError }
  > {
    await this.seedExplicitCapabilities();
    const normalized = normalizeCapabilityRequirements(requirements);
    if (normalized.length === 0) {
      return { ok: true };
    }

    const resolution = this.capabilityRegistry.resolveRequirements(normalized);
    if (resolution.ok) {
      return { ok: true };
    }

    const missing = [...resolution.missing];
    const incompatible = [...resolution.incompatible];
    const error = new WorkflowCapabilityError(
      workflowName,
      missing,
      buildCapabilityErrorMessage(workflowName, resolution),
      runId,
      { incompatible, resolution }
    );
    return { ok: false, missing, incompatible, error };
  }

  /**
   * Ensure workflow definitions are loaded from disk into the cache.
   */
  async ensureDefinitionsLoaded(): Promise<Map<string, WorkflowDefinitionV1>> {
    if (!this.definitionsLoaded) {
      await this.reloadDefinitions();
    }
    return this.discoveredDefinitions;
  }

  /**
   * Refresh workflow definitions freshly from disk.
   */
  async reloadDefinitions(): Promise<{
    definitions: WorkflowDefinitionV1[];
    diagnostics: unknown[];
  }> {
    const loadResult = await loadWorkflows({
      cwd: this.options.cwd,
      ...this.options.loadOptions,
      strict: false,
    });

    this.discoveredDefinitions = loadResult.workflows;
    this.definitionsLoaded = true;

    return {
      definitions: loadResult.definitions,
      diagnostics: loadResult.diagnostics,
    };
  }

  /**
   * Resolve an argument into a run ID or identify it as a definition name or ambiguous prefix.
   */
  resolveRunTarget(arg: string): ResolvedRunTarget {
    const trimmed = arg.trim();

    // 1. Exact run ID match
    const exactRun = this.registry.getRun(trimmed);
    if (exactRun) {
      return { kind: "run", run: exactRun, raw: trimmed };
    }

    // 2. Prefix match (minimum 4 chars)
    if (trimmed.length >= 4) {
      const allRuns = this.registry.listRuns();
      const prefixMatches = allRuns.filter((r) => r.id.startsWith(trimmed));
      if (prefixMatches.length === 1) {
        return { kind: "run", run: prefixMatches[0], raw: trimmed };
      }
      if (prefixMatches.length > 1) {
        return {
          kind: "ambiguous",
          ambiguousMatches: prefixMatches.map((r) => r.id),
          raw: trimmed,
        };
      }
    }

    // 3. Definition name check
    if (this.discoveredDefinitions.has(trimmed)) {
      return { kind: "definition", definitionName: trimmed, raw: trimmed };
    }

    return { kind: "unknown", raw: trimmed };
  }

  /**
   * Execute `/workflow list`: discover and show definitions with:
   * name, short description, scheduling mode, required capabilities, active run count.
   */
  async executeList(): Promise<WorkflowCommandResult> {
    await this.ensureDefinitionsLoaded();
    const defs = Array.from(this.discoveredDefinitions.values());

    // Sort deterministically by name alphabetically
    defs.sort((a, b) => a.name.localeCompare(b.name));

    if (defs.length === 0) {
      const output =
        "No workflow definitions found. Place workflow definition files (.md) in .pi/workflows/ or ~/.pi/agent/workflows/.";
      return { ok: true, action: "list", output, data: { count: 0, workflows: [] } };
    }

    const lines: string[] = [`Discovered Workflows (${defs.length}):`];
    const dataList: unknown[] = [];

    for (const def of defs) {
      const activeCount = this.registry.getActiveRuns(def.name).length;
      const requiresStr = def.requires.length > 0 ? def.requires.join(", ") : "none";

      lines.push(`  • ${def.name} [${def.mode}]`);
      lines.push(`    Description: ${def.description || "(no description)"}`);
      lines.push(`    Requires:    ${requiresStr}`);
      lines.push(`    Active runs: ${activeCount}`);

      dataList.push({
        name: def.name,
        description: def.description,
        mode: def.mode,
        requires: def.requires,
        activeRuns: activeCount,
        source: def.source.path,
      });
    }

    return {
      ok: true,
      action: "list",
      output: lines.join("\n"),
      data: { count: defs.length, workflows: dataList },
    };
  }

  /**
   * Execute `/workflow start <name>`: validate definition & capabilities,
   * enforce concurrency, create durable run, attach scheduler state,
   * trigger the first iteration according to schedule mode.
   */
  async executeStart(
    name: string,
    options: { pi?: ExtensionAPI; initialData?: Record<string, JsonValue> } = {}
  ): Promise<WorkflowCommandResult> {
    const trimmed = name.trim();

    // Check if input looks like a run ID instead of a definition name
    if (trimmed.startsWith("wfrun-") || this.registry.hasRun(trimmed)) {
      const errorMsg =
        `"${trimmed}" appears to be a run ID, not a workflow definition name. ` +
        `To inspect or control this run, use '/workflow status ${trimmed}', '/workflow pause ${trimmed}', ` +
        `or '/workflow stop ${trimmed}'. To start a workflow, provide its definition name (run '/workflow list' to see available workflows).`;
      return { ok: false, action: "start", output: errorMsg, error: errorMsg };
    }

    await this.ensureDefinitionsLoaded();
    const def = this.discoveredDefinitions.get(trimmed);

    if (!def) {
      const errorMsg = `Workflow definition "${trimmed}" not found. Run '/workflow list' to see available workflows.`;
      return { ok: false, action: "start", output: errorMsg, error: errorMsg };
    }

    return this.startDefinition(def, {
      pi: options.pi,
      initialData: options.initialData,
    });
  }

  /**
   * Shared durable-run start path used by both `/workflow start <name>` and the
   * `/goal` facade. Performs the common validation (required capabilities,
   * enforceable budget dimensions, scheduler availability) and then creates the
   * durable run and schedules it through the single pi-loop adapter. It never
   * defines a second scheduler or run-creation path.
   */
  async startDefinition(
    def: WorkflowDefinitionV1,
    options: {
      pi?: ExtensionAPI;
      initialData?: Record<string, JsonValue>;
      initialStep?: string;
      existingPolicy?: "fail" | "returnExisting";
    } = {}
  ): Promise<WorkflowCommandResult> {
    // 1. Validate required capabilities
    const capCheck = await this.validateCapabilities(def.name, declaredRequirements(def), options.pi);
    if (!capCheck.ok) {
      const msg = capCheck.error.message;
      return { ok: false, action: "start", output: msg, error: msg };
    }

    // 2. Validate enforceable budget dimensions
    if (def.budget?.maxCost !== undefined) {
      const errorMsg = `Failed to start workflow "${def.name}": Workflow "${def.name}" specifies budget dimension "maxCost", which is unsupported because Pi runtime does not expose authoritative cost accounting data.`;
      return { ok: false, action: "start", output: errorMsg, error: errorMsg };
    }
    if ((def.budget as any)?.maxTokens !== undefined) {
      const errorMsg = `Failed to start workflow "${def.name}": Workflow "${def.name}" specifies budget dimension "maxTokens", which is unsupported because Pi runtime does not expose authoritative token accounting data.`;
      return { ok: false, action: "start", output: errorMsg, error: errorMsg };
    }

    // 3. Validate scheduler service availability
    if (!this.adapter.isAvailable()) {
      const errorMsg = "Cannot start workflow: pi-loop scheduler service is not available in the current session.";
      return { ok: false, action: "start", output: errorMsg, error: errorMsg };
    }

    // 4. Create durable run & attach scheduler state
    try {
      const { run, task } = await this.adapter.startRun(def, {
        initialData: options.initialData,
        initialStep: options.initialStep,
        existingPolicy: options.existingPolicy,
      });

      const output =
        `Started workflow "${def.name}" (run ID: ${run.id}, mode: ${def.mode}, initial step: ${run.step}).`;

      return {
        ok: true,
        action: "start",
        output,
        data: { runId: run.id, workflow: run.workflow, step: run.step, taskId: task.id },
      };
    } catch (err: unknown) {
      if (err instanceof WorkflowConcurrencyError) {
        const errorMsg = err.message;
        return { ok: false, action: "start", output: errorMsg, error: errorMsg };
      }
      const msg = `Failed to start workflow "${def.name}": ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, action: "start", output: msg, error: msg };
    }
  }

  /**
   * Execute `/workflow status`: show active/nonterminal runs in deterministic order.
   * Concise fields: run ID, workflow, lifecycle, current step, age, next wakeup when known,
   * blocker/completion summary when relevant.
   */
  async executeStatusList(): Promise<WorkflowCommandResult> {
    const runs = this.registry.getNonterminalRuns();

    // Sort deterministically: createdAt ascending, then ID ascending
    runs.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    if (runs.length === 0) {
      const output =
        "No active workflow runs found. Run '/workflow list' to see available workflows, or '/workflow start <name>' to start one.";
      return { ok: true, action: "status", output, data: { count: 0, runs: [] } };
    }

    const lines: string[] = [`Active Workflow Runs (${runs.length}):`];
    const dataRuns: unknown[] = [];
    const now = Date.now();

    for (const run of runs) {
      const ageStr = formatAge(run.createdAt, now);
      const wakeupStr = formatNextWakeup(run, this.adapter, now);

      lines.push(`  • ${run.id}`);
      lines.push(`    Workflow:    ${run.workflow}`);
      lines.push(`    Type:        ${workflowKindOf(run)}`);
      lines.push(`    Lifecycle:   ${run.lifecycle}`);
      lines.push(`    Step:        ${run.step}`);
      lines.push(`    Age:         ${ageStr}`);
      lines.push(`    Next Wakeup: ${wakeupStr}`);

      if (run.blocker) {
        const humanReq = run.blocker.requiresHuman ? " (human action required)" : "";
        lines.push(`    Blocker:     ${run.blocker.reason}${humanReq}`);
      }

      if (run.completion) {
        lines.push(`    Completion:  ${run.completion.summary}`);
      }

      dataRuns.push({
        id: run.id,
        workflow: run.workflow,
        type: workflowKindOf(run),
        lifecycle: run.lifecycle,
        step: run.step,
        createdAt: run.createdAt,
        age: ageStr,
        nextWakeup: wakeupStr,
        blocker: run.blocker,
        completion: run.completion,
      });
    }

    return {
      ok: true,
      action: "status",
      output: lines.join("\n"),
      data: { count: runs.length, runs: dataRuns },
    };
  }

  /**
   * Execute `/workflow status <run-id>`: show detailed status of a specific run.
   */
  async executeStatusRun(runTarget: string): Promise<WorkflowCommandResult> {
    await this.ensureDefinitionsLoaded();
    const target = this.resolveRunTarget(runTarget);

    if (target.kind === "ambiguous") {
      const errorMsg = `Ambiguous run ID prefix "${runTarget}". Matches: [${target.ambiguousMatches!.join(", ")}].`;
      return { ok: false, action: "status", output: errorMsg, error: errorMsg };
    }

    if (target.kind === "definition") {
      const errorMsg =
        `"${runTarget}" is a workflow definition name, not a run ID. ` +
        `To start this workflow, use '/workflow start ${runTarget}'. To view active runs, use '/workflow status'.`;
      return { ok: false, action: "status", output: errorMsg, error: errorMsg };
    }

    if (target.kind === "unknown" || !target.run) {
      const errorMsg = `Workflow run "${runTarget}" not found. Run '/workflow status' to see active runs.`;
      return { ok: false, action: "status", output: errorMsg, error: errorMsg };
    }

    const run = target.run;
    const now = Date.now();
    const ageStr = formatAge(run.createdAt, now);
    const wakeupStr = formatNextWakeup(run, this.adapter, now);
    const requiresStr = run.snapshot.requires.length > 0 ? run.snapshot.requires.join(", ") : "none";

    const lines: string[] = [
      `Workflow Run: ${run.id}`,
      `  Workflow:    ${run.workflow}`,
      `  Type:        ${workflowKindOf(run)}`,
      `  Lifecycle:   ${run.lifecycle}`,
      `  Step:        ${run.step}`,
      `  Age:         ${ageStr}`,
      `  Turns:       ${run.turns}`,
      `  Attempts:    ${run.attempts}`,
      `  Next Wakeup: ${wakeupStr}`,
      `  Created:     ${new Date(run.createdAt).toISOString()}`,
      `  Updated:     ${new Date(run.updatedAt).toISOString()}`,
    ];

    if (run.objective !== undefined) {
      lines.push(`  Objective:   ${run.objective}`);
    }

    if (run.startedAt) {
      lines.push(`  Started:     ${new Date(run.startedAt).toISOString()}`);
    }
    if (run.completedAt) {
      lines.push(`  Completed:   ${new Date(run.completedAt).toISOString()}`);
    }

    lines.push(`  Definition:`);
    lines.push(`    Source:    ${run.definitionSource}`);
    lines.push(`    Mode:      ${run.snapshot.mode}`);
    lines.push(`    Requires:  ${requiresStr}`);

    const effectiveBudget = run.budget ?? run.snapshot.budget;
    if (effectiveBudget && Object.keys(effectiveBudget).length > 0) {
      lines.push(`  Budget:`);
      if (effectiveBudget.maxTurns !== undefined) {
        lines.push(`    Max Turns:     ${effectiveBudget.maxTurns}`);
      }
      if (effectiveBudget.maxDuration !== undefined) {
        lines.push(`    Max Duration:  ${effectiveBudget.maxDuration}`);
      }
      if (effectiveBudget.maxAttempts !== undefined) {
        lines.push(`    Max Attempts:  ${effectiveBudget.maxAttempts}`);
      }
      if (effectiveBudget.onExhaustion !== undefined) {
        lines.push(`    On Exhaustion: ${effectiveBudget.onExhaustion}`);
      }
    }

    lines.push(`  Verification: ${describeVerification(run)}`);

    const dataKeys = Object.keys(run.data);
    if (dataKeys.length === 0) {
      lines.push(`  Data:        (empty)`);
    } else {
      lines.push(`  Data Keys:   [${dataKeys.sort().join(", ")}] (values omitted to prevent secret exposure)`);
    }

    if (run.blocker) {
      lines.push(`  Blocker:`);
      lines.push(`    Reason:        ${run.blocker.reason}`);
      if (run.blocker.category) {
        lines.push(`    Category:      ${run.blocker.category}`);
      }
      lines.push(`    RequiresHuman: ${run.blocker.requiresHuman ?? false}`);
      lines.push(`    BlockedAt:     ${new Date(run.blocker.blockedAt).toISOString()}`);
    }

    if (run.completionClaim) {
      lines.push(`  Completion Claim:`);
      lines.push(`    Summary:       ${run.completionClaim.summary}`);
      lines.push(`    Evidence:      ${run.completionClaim.evidence.length} item(s)`);
    }

    if (run.verificationFindings) {
      lines.push(`  Verification Findings:`);
      lines.push(`    Decision:      ${run.verificationFindings.decision}`);
      if (run.verificationFindings.feedback) {
        lines.push(`    Feedback:      ${run.verificationFindings.feedback}`);
      }
      lines.push(`    Attempt:       ${run.verificationFindings.attempt}`);
    }

    if (run.completion) {
      lines.push(`  Completion:`);
      lines.push(`    Summary:       ${run.completion.summary}`);
      if (run.completion.evidence && run.completion.evidence.length > 0) {
        lines.push(`    Evidence (${run.completion.evidence.length}):`);
        for (const ev of run.completion.evidence) {
          const loc = ev.url || ev.path || "";
          lines.push(`      • [${ev.type}] ${ev.description}${loc ? ` (${loc})` : ""}`);
        }
      }
    }

    if (run.effects && Object.keys(run.effects).length > 0) {
      const effectKeys = Object.keys(run.effects).sort();
      lines.push(`  Effects (${effectKeys.length}):`);
      for (const key of effectKeys) {
        const eff = run.effects[key];
        const ambigStr = eff.ambiguous ? " [AMBIGUOUS - RECONCILIATION REQUIRED]" : "";
        lines.push(`    • [${eff.status.toUpperCase()}] ${eff.key} (${eff.kind})${ambigStr}`);
        if (eff.recoveryNote) {
          lines.push(`      Note: ${eff.recoveryNote}`);
        }
      }
    }

    if (run.recoveryEvents && run.recoveryEvents.length > 0) {
      lines.push(`  Recovery Events (${run.recoveryEvents.length}):`);
      const recentEvents = run.recoveryEvents.slice(-5);
      for (const rev of recentEvents) {
        lines.push(`    • [${new Date(rev.timestamp).toISOString()}] ${rev.type}: ${rev.message}`);
      }
    }

    if (run.lease) {
      lines.push(`  Lease:`);
      lines.push(`    Owner:     ${run.lease.ownerId}`);
      lines.push(`    Acquired:  ${new Date(run.lease.acquiredAt).toISOString()}`);
      if (run.lease.expiresAt) {
        lines.push(`    Expires:   ${new Date(run.lease.expiresAt).toISOString()}`);
      }
    }

    return {
      ok: true,
      action: "status",
      output: lines.join("\n"),
      data: run,
    };
  }

  /**
   * Execute `/workflow pause <run-id>`: persist paused state and cancel/suspend
   * future wakeups without deleting run history.
   */
  async executePause(runTarget: string): Promise<WorkflowCommandResult> {
    await this.ensureDefinitionsLoaded();
    const target = this.resolveRunTarget(runTarget);

    if (target.kind === "ambiguous") {
      const errorMsg = `Ambiguous run ID prefix "${runTarget}". Matches: [${target.ambiguousMatches!.join(", ")}].`;
      return { ok: false, action: "pause", output: errorMsg, error: errorMsg };
    }

    if (target.kind === "definition") {
      const errorMsg =
        `"${runTarget}" is a workflow definition name, not a run ID. ` +
        `To inspect runs, use '/workflow status'.`;
      return { ok: false, action: "pause", output: errorMsg, error: errorMsg };
    }

    if (target.kind === "unknown" || !target.run) {
      const errorMsg = `Workflow run "${runTarget}" not found. Run '/workflow status' to see active runs.`;
      return { ok: false, action: "pause", output: errorMsg, error: errorMsg };
    }

    const run = target.run;

    if (run.lifecycle === "paused") {
      const msg = `Workflow run "${run.id}" is already paused.`;
      return { ok: true, action: "pause", output: msg, data: run };
    }

    if (isTerminalLifecycle(run.lifecycle)) {
      const errorMsg = `Cannot pause run "${run.id}": run is in terminal state "${run.lifecycle}".`;
      return { ok: false, action: "pause", output: errorMsg, error: errorMsg };
    }

    if (run.lifecycle === "blocked") {
      const errorMsg = `Cannot pause run "${run.id}": run is currently blocked.`;
      return { ok: false, action: "pause", output: errorMsg, error: errorMsg };
    }

    try {
      // 1. Cancel linked scheduler task so no automatic wakeups occur
      await this.adapter.cancelWakeup(run.id);

      // 2. Persist paused lifecycle
      const updated = this.registry.pauseRun(run.id, {
        reason: "Paused via /workflow pause",
      });

      const output = `Paused workflow run "${run.id}" (workflow: "${run.workflow}", step: "${run.step}"). Wakeups suspended.`;
      return { ok: true, action: "pause", output, data: updated };
    } catch (err: unknown) {
      const msg = `Failed to pause run "${run.id}": ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, action: "pause", output: msg, error: msg };
    }
  }

  /**
   * Execute `/workflow resume <run-id>`: revalidate capabilities/definition compatibility
   * and safely schedule the next iteration. Creates/restores exactly one scheduler linkage.
   */
  async executeResume(
    runTarget: string,
    options: { pi?: ExtensionAPI } = {}
  ): Promise<WorkflowCommandResult> {
    await this.ensureDefinitionsLoaded();
    const target = this.resolveRunTarget(runTarget);

    if (target.kind === "ambiguous") {
      const errorMsg = `Ambiguous run ID prefix "${runTarget}". Matches: [${target.ambiguousMatches!.join(", ")}].`;
      return { ok: false, action: "resume", output: errorMsg, error: errorMsg };
    }

    if (target.kind === "definition") {
      const errorMsg =
        `"${runTarget}" is a workflow definition name, not a run ID. ` +
        `To inspect runs, use '/workflow status'.`;
      return { ok: false, action: "resume", output: errorMsg, error: errorMsg };
    }

    if (target.kind === "unknown" || !target.run) {
      const errorMsg = `Workflow run "${runTarget}" not found. Run '/workflow status' to see active runs.`;
      return { ok: false, action: "resume", output: errorMsg, error: errorMsg };
    }

    const run = target.run;

    if (run.lifecycle === "active") {
      const msg = `Workflow run "${run.id}" is already active.`;
      return { ok: true, action: "resume", output: msg, data: run };
    }

    if (isTerminalLifecycle(run.lifecycle)) {
      const errorMsg = `Cannot resume run "${run.id}": run is in terminal state "${run.lifecycle}".`;
      return { ok: false, action: "resume", output: errorMsg, error: errorMsg };
    }

    // 1. Revalidate required capabilities against run snapshot
    const capCheck = await this.validateCapabilities(
      run.workflow,
      declaredRequirements(run.snapshot),
      options.pi,
      run.id
    );
    if (!capCheck.ok) {
      const msg = `Cannot resume run "${run.id}": ${capCheck.error.message}`;
      return { ok: false, action: "resume", output: msg, error: msg };
    }

    // 2. Check definition compatibility with on-disk definition
    const compatCheck = await this.validateDefinitionCompatibility(run, options.pi);
    if (!compatCheck.ok) {
      const msg = `Cannot resume run "${run.id}": ${compatCheck.reason}`;
      return { ok: false, action: "resume", output: msg, error: msg };
    }

    // 3. Validate scheduler service availability
    if (!this.adapter.isAvailable()) {
      const errorMsg = `Cannot resume run "${run.id}": pi-loop scheduler service is not available in the current session.`;
      return { ok: false, action: "resume", output: errorMsg, error: errorMsg };
    }

    const previousLifecycle = run.lifecycle;
    let resumed: WorkflowRun;
    try {
      // 4. Persist resumed lifecycle
      resumed = this.registry.resumeRun(run.id, {
        reason: "Resumed via /workflow resume",
      });
    } catch (err: unknown) {
      const msg = `Failed to resume run "${run.id}": ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, action: "resume", output: msg, error: msg };
    }

    try {
      // 5. Safely schedule the next iteration (restores exactly one linkage)
      const task = await this.adapter.scheduleRun(resumed);

      const output =
        `Resumed workflow run "${run.id}" (workflow: "${run.workflow}", step: "${resumed.step}"). Next iteration scheduled.`;

      return { ok: true, action: "resume", output, data: { run: resumed, taskId: task.id } };
    } catch (scheduleErr: unknown) {
      // Rollback to previous lifecycle on scheduling failure
      try {
        if (previousLifecycle === "paused") {
          this.registry.pauseRun(run.id, {
            reason: `Rollback: failed to schedule next iteration on resume (${scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr)})`,
          });
        } else if (previousLifecycle === "blocked") {
          this.registry.blockRun(run.id, {
            reason: `Rollback: failed to schedule next iteration on resume (${scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr)})`,
            requiresHuman: run.blocker?.requiresHuman ?? false,
          });
        }
      } catch {
        // Ignore secondary rollback error
      }

      const msg = `Failed to resume run "${run.id}": ${scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr)}`;
      return { ok: false, action: "resume", output: msg, error: msg };
    }
  }

  /**
   * Execute `/workflow stop <run-id>`: cancel the run, stop its scheduler task,
   * retain durable history, and do not treat cancellation as successful completion.
   * Isolated: stops only the target run's task and never touches user /loop.
   */
  async executeStop(runTarget: string): Promise<WorkflowCommandResult> {
    await this.ensureDefinitionsLoaded();
    const target = this.resolveRunTarget(runTarget);

    if (target.kind === "ambiguous") {
      const errorMsg = `Ambiguous run ID prefix "${runTarget}". Matches: [${target.ambiguousMatches!.join(", ")}].`;
      return { ok: false, action: "stop", output: errorMsg, error: errorMsg };
    }

    if (target.kind === "definition") {
      const errorMsg =
        `"${runTarget}" is a workflow definition name, not a run ID. ` +
        `To inspect runs, use '/workflow status'.`;
      return { ok: false, action: "stop", output: errorMsg, error: errorMsg };
    }

    if (target.kind === "unknown" || !target.run) {
      const errorMsg = `Workflow run "${runTarget}" not found. Run '/workflow status' to see active runs.`;
      return { ok: false, action: "stop", output: errorMsg, error: errorMsg };
    }

    const run = target.run;

    if (isTerminalLifecycle(run.lifecycle)) {
      const msg = `Workflow run "${run.id}" is already in terminal state "${run.lifecycle}".`;
      return { ok: true, action: "stop", output: msg, data: run };
    }

    try {
      // 1. Cancel only this run's scheduler task
      await this.adapter.cancelWakeup(run.id);

      // 2. Persist cancellation in durable registry
      const updated = this.registry.cancelRun(run.id, {
        reason: "Cancelled via /workflow stop",
      });

      const output =
        `Stopped workflow run "${run.id}" (workflow: "${run.workflow}", status: cancelled). Durable history retained.`;

      return { ok: true, action: "stop", output, data: updated };
    } catch (err: unknown) {
      const msg = `Failed to stop run "${run.id}": ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, action: "stop", output: msg, error: msg };
    }
  }

  /**
   * Execute `/workflow reload`: refresh discovered definitions for future runs.
   * Must not silently mutate the definition snapshot of an already-running run.
   */
  async executeReload(): Promise<WorkflowCommandResult> {
    const { definitions, diagnostics } = await this.reloadDefinitions();

    const lines: string[] = [
      `Reloaded workflow definitions (${definitions.length} discovered). ` +
        `Future runs will use updated definitions; existing runs remain unaffected.`,
    ];

    if (diagnostics.length > 0) {
      lines.push(`Diagnostics (${diagnostics.length}):`);
      for (const d of diagnostics as any[]) {
        lines.push(`  • [${d.type ?? "warning"}] ${d.path}: ${d.message}`);
      }
    }

    return {
      ok: true,
      action: "reload",
      output: lines.join("\n"),
      data: { count: definitions.length, diagnostics },
    };
  }

  /**
   * Show usage help summary.
   */
  getHelpSummary(): string {
    return [
      "Workflow Commands (/workflow):",
      "  /workflow list               - List discovered workflow definitions",
      "  /workflow start <name>       - Start a new workflow run",
      "  /workflow status             - Show active workflow runs",
      "  /workflow status <run-id>    - Show detailed status of a specific run",
      "  /workflow pause <run-id>     - Pause an active run and suspend wakeups",
      "  /workflow resume <run-id>    - Resume a paused or blocked run",
      "  /workflow stop <run-id>      - Stop a run and cancel its scheduler task",
      "  /workflow reload             - Refresh workflow definitions from disk",
      "  /workflow help               - Show this help summary",
    ].join("\n");
  }

  /**
   * Dispatch parsed subcommand to the corresponding execution handler.
   */
  async execute(
    rawArgs: string,
    options: { pi?: ExtensionAPI; ctx?: ExtensionCommandContext } = {}
  ): Promise<WorkflowCommandResult> {
    const parsed = parseWorkflowCommandArgs(rawArgs);

    switch (parsed.subcommand) {
      case "list": {
        if (parsed.target || parsed.extra.length > 0) {
          const unexpected = [parsed.target, ...parsed.extra].filter(Boolean).join(" ");
          const errorMsg = `Unexpected argument(s) for '/workflow list': "${unexpected}". Usage: /workflow list`;
          return { ok: false, action: "list", output: errorMsg, error: errorMsg };
        }
        return this.executeList();
      }

      case "start": {
        if (!parsed.target) {
          const errorMsg = "Missing required argument <name> for '/workflow start'. Usage: /workflow start <name>";
          return { ok: false, action: "start", output: errorMsg, error: errorMsg };
        }
        if (parsed.extra.length > 0) {
          const errorMsg = `Unexpected argument(s) for '/workflow start': "${parsed.extra.join(" ")}". Usage: /workflow start <name>`;
          return { ok: false, action: "start", output: errorMsg, error: errorMsg };
        }
        return this.executeStart(parsed.target, { pi: options.pi });
      }

      case "status": {
        if (parsed.extra.length > 0) {
          const errorMsg = `Unexpected argument(s) for '/workflow status': "${parsed.extra.join(" ")}". Usage: /workflow status [run-id]`;
          return { ok: false, action: "status", output: errorMsg, error: errorMsg };
        }
        if (!parsed.target) {
          return this.executeStatusList();
        }
        return this.executeStatusRun(parsed.target);
      }

      case "pause": {
        if (!parsed.target) {
          const errorMsg = "Missing required argument <run-id> for '/workflow pause'. Usage: /workflow pause <run-id>";
          return { ok: false, action: "pause", output: errorMsg, error: errorMsg };
        }
        if (parsed.extra.length > 0) {
          const errorMsg = `Unexpected argument(s) for '/workflow pause': "${parsed.extra.join(" ")}". Usage: /workflow pause <run-id>`;
          return { ok: false, action: "pause", output: errorMsg, error: errorMsg };
        }
        return this.executePause(parsed.target);
      }

      case "resume": {
        if (!parsed.target) {
          const errorMsg = "Missing required argument <run-id> for '/workflow resume'. Usage: /workflow resume <run-id>";
          return { ok: false, action: "resume", output: errorMsg, error: errorMsg };
        }
        if (parsed.extra.length > 0) {
          const errorMsg = `Unexpected argument(s) for '/workflow resume': "${parsed.extra.join(" ")}". Usage: /workflow resume <run-id>`;
          return { ok: false, action: "resume", output: errorMsg, error: errorMsg };
        }
        return this.executeResume(parsed.target, { pi: options.pi });
      }

      case "stop": {
        if (!parsed.target) {
          const errorMsg = "Missing required argument <run-id> for '/workflow stop'. Usage: /workflow stop <run-id>";
          return { ok: false, action: "stop", output: errorMsg, error: errorMsg };
        }
        if (parsed.extra.length > 0) {
          const errorMsg = `Unexpected argument(s) for '/workflow stop': "${parsed.extra.join(" ")}". Usage: /workflow stop <run-id>`;
          return { ok: false, action: "stop", output: errorMsg, error: errorMsg };
        }
        return this.executeStop(parsed.target);
      }

      case "reload": {
        if (parsed.target || parsed.extra.length > 0) {
          const unexpected = [parsed.target, ...parsed.extra].filter(Boolean).join(" ");
          const errorMsg = `Unexpected argument(s) for '/workflow reload': "${unexpected}". Usage: /workflow reload`;
          return { ok: false, action: "reload", output: errorMsg, error: errorMsg };
        }
        return this.executeReload();
      }

      case "help": {
        if (parsed.target || parsed.extra.length > 0) {
          const unexpected = [parsed.target, ...parsed.extra].filter(Boolean).join(" ");
          const errorMsg = `Unexpected argument(s) for '/workflow help': "${unexpected}". Usage: /workflow help`;
          return { ok: false, action: "help", output: errorMsg, error: errorMsg };
        }
        return { ok: true, action: "help", output: this.getHelpSummary() };
      }

      default: {
        const errorMsg =
          `Unknown workflow subcommand "${parsed.subcommand}". ` +
          `Available subcommands: list, start, status, pause, resume, stop, reload. Run '/workflow help' for usage.`;
        return { ok: false, action: "unknown", output: errorMsg, error: errorMsg };
      }
    }
  }

  /**
   * Handle slash command execution from Pi ExtensionCommandContext.
   * Dispatches command, emits UI notify, and provides non-TUI text fallback.
   */
  async handleCommand(args: string, ctx: ExtensionCommandContext): Promise<WorkflowCommandResult> {
    const result = await this.execute(args, { ctx, pi: this.options.pi });

    // 1. UI Notification when UI is present
    if (ctx.ui?.notify) {
      ctx.ui.notify(result.output, result.ok ? "info" : "error");
    }

    // 2. Sensible text fallback in non-TUI / non-dialog modes
    if (!ctx.hasUI || ctx.mode !== "tui") {
      if (this.options.outputStream) {
        this.options.outputStream(result.output);
      } else if (typeof process !== "undefined") {
        if (result.ok) {
          if (process.stdout?.write) {
            process.stdout.write(result.output + "\n");
          } else {
            console.log(result.output);
          }
        } else {
          if (process.stderr?.write) {
            process.stderr.write(result.output + "\n");
          } else {
            console.error(result.output);
          }
        }
      }
    }

    return result;
  }

  /**
   * Autocomplete provider for Pi's getArgumentCompletions.
   */
  async getArgumentCompletions(prefix: string): Promise<CommandAutocompleteItem[] | null> {
    const trimmed = prefix.trimStart();
    const parts = trimmed.split(/\s+/);

    const subcommands: Array<{ name: string; description: string }> = [
      { name: "list", description: "List discovered workflow definitions" },
      { name: "start", description: "Start a new workflow run" },
      { name: "status", description: "Show active workflow runs or run details" },
      { name: "pause", description: "Pause an active run and suspend wakeups" },
      { name: "resume", description: "Resume a paused or blocked run" },
      { name: "stop", description: "Stop a run and cancel its scheduler task" },
      { name: "reload", description: "Refresh workflow definitions from disk" },
      { name: "help", description: "Show help and command usage" },
    ];

    // Case 1: Completing the subcommand itself
    if (parts.length <= 1 && !trimmed.endsWith(" ")) {
      const match = parts[0] || "";
      const matched = subcommands.filter((s) => s.name.startsWith(match.toLowerCase()));
      if (matched.length === 0) return null;
      return matched.map((s) => ({
        value: `${s.name} `,
        label: s.name,
        description: s.description,
      }));
    }

    const subcommand = parts[0].toLowerCase();
    const argPrefix = parts[1] || "";

    // Case 2: Completing workflow name for "start"
    if (subcommand === "start") {
      await this.ensureDefinitionsLoaded();
      const names = Array.from(this.discoveredDefinitions.keys());
      const filtered = names.filter((n) => n.startsWith(argPrefix));
      if (filtered.length === 0) return null;
      return filtered.map((name) => {
        const def = this.discoveredDefinitions.get(name);
        return {
          value: `start ${name}`,
          label: name,
          description: def?.description || `${def?.mode} workflow`,
        };
      });
    }

    // Case 3: Completing run IDs for status, pause, resume, stop
    if (["status", "pause", "resume", "stop"].includes(subcommand)) {
      let candidateRuns: WorkflowRun[];
      if (subcommand === "pause") {
        candidateRuns = this.registry.getActiveRuns();
      } else if (subcommand === "resume") {
        candidateRuns = this.registry.listRuns({ lifecycle: ["paused", "blocked"] });
      } else if (subcommand === "stop") {
        candidateRuns = this.registry.getNonterminalRuns();
      } else {
        // status completes nonterminal first, then all runs
        candidateRuns = this.registry.listRuns();
      }

      const filtered = candidateRuns.filter((r) => r.id.startsWith(argPrefix));
      if (filtered.length === 0) return null;
      return filtered.map((run) => ({
        value: `${subcommand} ${run.id}`,
        label: run.id,
        description: `${run.workflow} (${run.lifecycle}, step: ${run.step})`,
      }));
    }

    return null;
  }
}

/**
 * Factory to create a WorkflowCommandController.
 */
export function createWorkflowCommandController(
  options: WorkflowCommandControllerOptions
): WorkflowCommandController {
  return new WorkflowCommandController(options);
}

/**
 * Register the /workflow command on Pi's ExtensionAPI.
 */
export function registerWorkflowCommand(
  pi: ExtensionAPI,
  controller: WorkflowCommandController
): void {
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("workflow", {
      description: "Manage workflow definitions and runs (list, start, status, pause, resume, stop, reload)",
      getArgumentCompletions: (prefix) => controller.getArgumentCompletions(prefix),
      handler: async (args, ctx) => {
        await controller.handleCommand(args, ctx);
      },
    });
  }
}
