/**
 * `/goal` command facade.
 *
 * `/goal` is a thin, user-facing facade over the existing workflow engine. It
 * parses a free-form objective (or an exact control subcommand) and delegates
 * run creation and lifecycle control to the shared `WorkflowCommandController`
 * and the single pi-loop scheduler adapter. It introduces no second scheduler,
 * continuation engine, timer, or `agent_settled` loop.
 *
 * Exactly one command-owned *nonterminal* goal exists at a time (enforced by the
 * built-in definition's `concurrency.maxRuns: 1`). Terminal goal history
 * remains visible by run ID through `/workflow status <id>`, and `/goal status`
 * reports it explicitly rather than pretending no goal ever existed.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  CommandAutocompleteItem,
  WorkflowCommandController,
  WorkflowCommandResult,
} from "./commands.ts";
import { createGoalDefinition, GoalDefinitionError, type GoalDefinitionOptions } from "./goal.ts";
import type { WorkflowRun } from "./types.ts";

/** Exact control subcommands reserved by `/goal`. */
export const GOAL_RESERVED_SUBCOMMANDS = ["status", "pause", "resume", "stop", "help"] as const;

export type GoalSubcommand = "objective" | "status" | "pause" | "resume" | "stop" | "help" | "ambiguous";

export interface ParsedGoalCommand {
  subcommand: GoalSubcommand;
  /** Objective text for `subcommand: "objective"`. */
  objective?: string;
  /** Reserved word that made the input ambiguous. */
  ambiguousReserved?: string;
  raw: string;
}

/**
 * Parses raw `/goal` arguments.
 *
 * - Empty input means `help`.
 * - An exact reserved word (`status|pause|resume|stop|help`) is a control command.
 * - A reserved word with trailing text is ambiguous and fails closed.
 * - `--` forces the remainder to be treated literally as an objective, which is
 *   the documented escape hatch for objectives starting with a reserved word.
 */
export function parseGoalArgs(rawArgs: string): ParsedGoalCommand {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0) {
    return { subcommand: "help", raw: trimmed };
  }

  if (trimmed === "--") {
    return { subcommand: "objective", objective: "", raw: trimmed };
  }
  if (trimmed.startsWith("-- ")) {
    return { subcommand: "objective", objective: trimmed.slice(3).trim(), raw: trimmed };
  }

  const parts = trimmed.split(/\s+/);
  const first = parts[0].toLowerCase();
  if ((GOAL_RESERVED_SUBCOMMANDS as readonly string[]).includes(first)) {
    if (parts.length === 1) {
      return { subcommand: first as GoalSubcommand, raw: trimmed };
    }
    return { subcommand: "ambiguous", ambiguousReserved: first, raw: trimmed };
  }

  return { subcommand: "objective", objective: trimmed, raw: trimmed };
}

export interface GoalCommandControllerOptions {
  /**
   * Shared workflow command controller. Goal start reuses its common start
   * validation; pause/resume/stop delegate to its generic lifecycle controls.
   */
  workflowController: WorkflowCommandController;
  /** Optional overrides for the built-in goal definition factory. */
  goalOptions?: GoalDefinitionOptions;
  outputStream?: (text: string) => void;
  pi?: ExtensionAPI;
}

/** True when a run was created from a goal-kind snapshot. */
export function isGoalRun(run: WorkflowRun): boolean {
  return run.type === "goal" || run.snapshot.type === "goal";
}

function getHelpSummary(): string {
  return [
    "Goal Commands (/goal):",
    "  /goal <objective>      - Start an ad-hoc goal workflow run",
    "  /goal -- <objective>   - Start when the objective starts with a reserved word",
    "  /goal status           - Show the active goal (or the most recent terminal goal)",
    "  /goal pause            - Pause the active goal and suspend wakeups",
    "  /goal resume           - Resume the paused/blocked active goal",
    "  /goal stop             - Stop (cancel) the active goal and cancel its scheduler task",
    "  /goal help             - Show this help summary",
  ].join("\n");
}

/**
 * Facade controller for `/goal <objective>` and `status|pause|resume|stop`.
 */
export class GoalCommandController {
  readonly workflowController: WorkflowCommandController;
  private readonly options: GoalCommandControllerOptions;

  constructor(options: GoalCommandControllerOptions) {
    this.options = options;
    this.workflowController = options.workflowController;
  }

  private get registry() {
    return this.workflowController.registry;
  }

  /** All goal-kind runs, oldest first (registry insertion order is stable). */
  private listGoalRuns(): WorkflowRun[] {
    return this.registry.listRuns().filter(isGoalRun);
  }

  /** Nonterminal goal runs (active, verifying, paused, blocked). */
  private listNonterminalGoalRuns(): WorkflowRun[] {
    return this.registry.getNonterminalRuns().filter(isGoalRun);
  }

  private selectSoleNonterminalGoal(verb: string): WorkflowCommandResult | { run: WorkflowRun } {
    const active = this.listNonterminalGoalRuns();
    if (active.length > 1) {
      const ids = active.map((r) => `${r.id} (${r.lifecycle})`).join(", ");
      const errorMsg = `Ambiguous goal state: multiple nonterminal goals exist [${ids}]. Refusing to ${verb} an arbitrary goal; resolve by run ID with '/workflow status <run-id>'.`;
      return { ok: false, action: verb, output: errorMsg, error: errorMsg };
    }
    if (active.length === 1) {
      return { run: active[0] };
    }
    const history = this.listGoalRuns();
    const latest = history.length > 0 ? history[history.length - 1] : undefined;
    const detail = latest
      ? ` Most recent goal is terminal (run ID: ${latest.id}, lifecycle: ${latest.lifecycle}). Use '/workflow status ${latest.id}' for details.`
      : "";
    const errorMsg = `No active goal to ${verb}.${detail}`;
    return { ok: false, action: verb, output: errorMsg, error: errorMsg };
  }

  /**
   * Start a goal. Fails closed, creating no run, when the objective is invalid,
   * the `loop` capability is unavailable, the scheduler service is absent, or a
   * command-owned goal is already nonterminal.
   */
  private async startGoal(
    objective: string,
    options: { pi?: ExtensionAPI } = {}
  ): Promise<WorkflowCommandResult> {
    const active = this.listNonterminalGoalRuns();
    if (active.length > 0) {
      const ids = active.map((r) => `${r.id} (${r.lifecycle})`).join(", ");
      const errorMsg = `A goal is already active [${ids}]. Use '/goal status', '/goal pause', '/goal resume', or '/goal stop' before starting another goal. Only one command-owned goal may be nonterminal at a time.`;
      return { ok: false, action: "goal", output: errorMsg, error: errorMsg };
    }

    let definition;
    try {
      definition = createGoalDefinition(objective, this.options.goalOptions);
    } catch (err: unknown) {
      const msg =
        err instanceof GoalDefinitionError
          ? err.message
          : `Invalid goal objective: ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, action: "goal", output: msg, error: msg };
    }

    const started = await this.workflowController.startDefinition(definition, {
      pi: options.pi,
    });
    if (!started.ok) {
      return { ...started, action: "goal" };
    }

    const runId = (started.data as { runId?: string } | undefined)?.runId;
    const output = `Started goal (run ID: ${runId}). Objective: ${definition.objective}`;
    return { ...started, action: "goal", output };
  }

  private async showStatus(): Promise<WorkflowCommandResult> {
    const active = this.listNonterminalGoalRuns();
    if (active.length > 1) {
      const ids = active.map((r) => `${r.id} (${r.lifecycle})`).join(", ");
      const errorMsg = `Ambiguous goal state: multiple nonterminal goals exist [${ids}]. Refusing to pick one; inspect by run ID with '/workflow status <run-id>'.`;
      return { ok: false, action: "status", output: errorMsg, error: errorMsg };
    }

    if (active.length === 1) {
      const detail = await this.workflowController.executeStatusRun(active[0].id);
      return { ...detail, action: "status", output: `Goal status\n${detail.output}` };
    }

    const history = this.listGoalRuns();
    if (history.length > 0) {
      const latest = history[history.length - 1];
      const output =
        `No active goal. Most recent goal is terminal (run ID: ${latest.id}, workflow: ${latest.workflow}, ` +
        `lifecycle: ${latest.lifecycle}). Use '/workflow status ${latest.id}' for details or '/goal <objective>' to start a new goal.`;
      return { ok: true, action: "status", output, data: latest };
    }

    return {
      ok: true,
      action: "status",
      output: "No goals found. Start one with '/goal <objective>'.",
    };
  }

  /**
   * Dispatch parsed `/goal` arguments to the corresponding operation.
   */
  async execute(
    rawArgs: string,
    options: { pi?: ExtensionAPI; ctx?: ExtensionCommandContext } = {}
  ): Promise<WorkflowCommandResult> {
    const parsed = parseGoalArgs(rawArgs);

    switch (parsed.subcommand) {
      case "help":
        return { ok: true, action: "help", output: getHelpSummary() };

      case "ambiguous": {
        const errorMsg =
          `Ambiguous goal command: "${parsed.raw}" starts with the reserved subcommand ` +
          `"${parsed.ambiguousReserved}". To start a goal whose objective begins with that word, ` +
          `use '/goal -- ${parsed.raw}'. Run '/goal help' for usage.`;
        return { ok: false, action: "ambiguous", output: errorMsg, error: errorMsg };
      }

      case "objective":
        return this.startGoal(parsed.objective ?? "", { pi: options.pi });

      case "status":
        return this.showStatus();

      case "pause": {
        const sel = this.selectSoleNonterminalGoal("pause");
        if ("ok" in sel) return sel;
        return this.workflowController.executePause(sel.run.id);
      }

      case "resume": {
        const sel = this.selectSoleNonterminalGoal("resume");
        if ("ok" in sel) return sel;
        return this.workflowController.executeResume(sel.run.id, { pi: options.pi });
      }

      case "stop": {
        const sel = this.selectSoleNonterminalGoal("stop");
        if ("ok" in sel) return sel;
        return this.workflowController.executeStop(sel.run.id);
      }

      default: {
        const errorMsg = `Unknown goal subcommand. Run '/goal help' for usage.`;
        return { ok: false, action: "unknown", output: errorMsg, error: errorMsg };
      }
    }
  }

  /**
   * Handle slash command execution from Pi ExtensionCommandContext, mirroring
   * `/workflow`'s UI notify and non-TUI plain-text fallback behavior.
   */
  async handleCommand(args: string, ctx: ExtensionCommandContext): Promise<WorkflowCommandResult> {
    const result = await this.execute(args, { ctx, pi: this.options.pi });

    if (ctx.ui?.notify) {
      ctx.ui.notify(result.output, result.ok ? "info" : "error");
    }

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
      { name: "status", description: "Show the active goal or most recent terminal goal" },
      { name: "pause", description: "Pause the active goal and suspend wakeups" },
      { name: "resume", description: "Resume the paused or blocked active goal" },
      { name: "stop", description: "Stop the active goal and cancel its scheduler task" },
      { name: "help", description: "Show help and command usage" },
    ];

    if (parts.length <= 1 && !trimmed.endsWith(" ")) {
      const match = parts[0] || "";
      const matched = subcommands.filter((s) => s.name.startsWith(match.toLowerCase()));
      if (matched.length === 0) return null;
      return matched.map((s) => ({ value: `${s.name} `, label: s.name, description: s.description }));
    }

    // Control subcommands take no arguments: `/goal pause <id>` is deliberately
    // rejected as ambiguous by `parseGoalArgs`. Do not advertise completions that
    // the parser would refuse. Objectives are free text, so there is nothing
    // useful (and nothing valid) to complete after a subcommand.
    return null;
  }
}

/**
 * Register the `/goal` command on Pi's ExtensionAPI.
 */
export function registerGoalCommand(pi: ExtensionAPI, controller: GoalCommandController): void {
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("goal", {
      description: "Create and control an ad-hoc goal workflow (status, pause, resume, stop)",
      getArgumentCompletions: (prefix) => controller.getArgumentCompletions(prefix),
      handler: async (args, ctx) => {
        await controller.handleCommand(args, ctx);
      },
    });
  }
}
