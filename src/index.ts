/**
 * pi-workflow: Workflow engine for Pi coding agent
 *
 * Workflow Spec v1 definition parser, loader, immutable snapshot facilities,
 * durable run registry, and iteration execution context with model-callable tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowCapabilityRegistry, type WorkflowCapabilityRegistry } from "./capabilities.ts";
import { WorkflowDispatcher } from "./dispatcher.ts";
import { WorkflowRunRegistry } from "./registry.ts";
import {
  LoopSchedulerAdapter,
  type LoopSchedulerAdapterOptions,
} from "./scheduler-adapter.ts";
import {
  WorkflowCommandController,
  type WorkflowCommandControllerOptions,
  registerWorkflowCommand,
} from "./commands.ts";
import { GoalCommandController, registerGoalCommand } from "./goal-commands.ts";
import { createWorkflowTools } from "./tools.ts";
import type { WorkflowSessionTarget } from "./types.ts";

// Re-export constants
export * from "./constants.ts";

// Re-export types
export * from "./types.ts";

// Re-export capability/provider registry
export * from "./capabilities.ts";

// Re-export duration utilities
export * from "./duration.ts";

// Re-export parser
export * from "./parser.ts";

// Re-export loader
export * from "./loader.ts";

// Re-export snapshot
export * from "./snapshot.ts";

// Re-export data bounds & JSON validation
export * from "./data-bounds.ts";

// Re-export run model and transitions
export * from "./run.ts";

// Re-export bounded history projection primitives
export * from "./bounded-history.ts";

// Re-export session entry encoding and parsing
export * from "./session-entries.ts";

// Re-export registry
export * from "./registry.ts";

// Re-export prompt construction
export * from "./prompt.ts";

// Re-export dispatcher
export * from "./dispatcher.ts";

// Re-export tools
export * from "./tools.ts";

// Re-export scheduler adapter
export * from "./scheduler-adapter.ts";

// Re-export the authoritative pi-loop service contract consumed for scheduling.
// pi-loop/service is the single source of truth; pi-workflow does not redefine it.
export * from "pi-loop/service";

// Re-export commands & lifecycle controller
export * from "./commands.ts";

// Re-export built-in goal definition factory and /goal facade
export * from "./goal.ts";
export * from "./goal-commands.ts";

/**
 * Factory to create a WorkflowRunRegistry.
 */
export function createWorkflowRunRegistry(
  sessionTarget?: WorkflowSessionTarget
): WorkflowRunRegistry {
  return new WorkflowRunRegistry(sessionTarget);
}

/**
 * Factory to create a WorkflowDispatcher.
 */
export function createWorkflowDispatcher(
  registry: WorkflowRunRegistry
): WorkflowDispatcher {
  return new WorkflowDispatcher(registry);
}

/**
 * Factory to create a LoopSchedulerAdapter.
 */
export function createLoopSchedulerAdapter(
  options: LoopSchedulerAdapterOptions
): LoopSchedulerAdapter {
  return new LoopSchedulerAdapter(options);
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
 * Factory to create a GoalCommandController.
 */
export function createGoalCommandController(
  options: ConstructorParameters<typeof GoalCommandController>[0]
): GoalCommandController {
  return new GoalCommandController(options);
}

export interface WorkflowExtensionOptions {
  /**
   * Optional pre-built, session-scoped capability registry. When provided,
   * third-party provider extensions can register capabilities before the
   * workflow engine starts.
   */
  capabilityRegistry?: WorkflowCapabilityRegistry;
}

/**
 * Internals returned by the extension entrypoint for programmatic use and
 * testing. Pi ignores the return value.
 */
export interface WorkflowExtensionHandle {
  registry: WorkflowRunRegistry;
  capabilityRegistry: WorkflowCapabilityRegistry;
  dispatcher: WorkflowDispatcher;
  adapter: LoopSchedulerAdapter;
  controller: WorkflowCommandController;
  goalController: GoalCommandController;
}

/**
 * Pi extension entrypoint.
 * Automatically synchronizes workflow runs with the active session branch across reloads and tree navigation,
 * discovers and bridges to pi-loop for workflow scheduling, registers model-facing workflow tools,
 * and enforces safe iteration clearing across lifecycle events.
 */
export default function workflowExtension(
  pi: ExtensionAPI,
  options: WorkflowExtensionOptions = {}
): WorkflowExtensionHandle {
  const registry = new WorkflowRunRegistry();
  const capabilityRegistry =
    options.capabilityRegistry ?? createWorkflowCapabilityRegistry();
  const dispatcher = new WorkflowDispatcher(registry);
  const adapter = new LoopSchedulerAdapter({
    registry,
    dispatcher,
    events: (pi as any).events,
    capabilityRegistry,
  });
  const tools = createWorkflowTools({ dispatcher, registry });

  if (typeof pi.registerTool === "function") {
    for (const tool of tools) {
      pi.registerTool(tool);
    }
  }

  const controller = new WorkflowCommandController({
    registry,
    adapter,
    dispatcher,
    pi,
    capabilityRegistry,
  });

  registerWorkflowCommand(pi, controller);

  const goalController = new GoalCommandController({
    workflowController: controller,
    pi,
  });

  registerGoalCommand(pi, goalController);

  const events = (pi as any).events;
  if (events && typeof capabilityRegistry.bindEventBus === "function") {
    capabilityRegistry.bindEventBus(events);
  }

  const resolveActiveSessionId = (ctx: any): string | undefined => {
    const value =
      typeof ctx?.sessionManager?.getSessionId === "function"
        ? ctx.sessionManager.getSessionId()
        : undefined;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    dispatcher.clearActiveIteration("session_start");
    // Bind the capability registry to the concrete active session before any
    // provider advertisement is honored. Bus ads from other sessions are
    // ignored, and providers attributed to a previous session are reset.
    const sessionId = resolveActiveSessionId(ctx);
    if (sessionId) {
      try {
        capabilityRegistry.beginSession(sessionId);
      } catch {
        // Registry disposal or invalid id must not crash session startup.
      }
    }
    registry.bindSession({
      appendEntry: (customType: string, data?: unknown) => pi.appendEntry(customType, data),
      getBranch: (fromId?: string) => ctx.sessionManager.getBranch(fromId),
    });
    registry.refresh();

    // Fail closed when the concrete session identity is missing or invalid:
    // end any session-scoped scheduler state and skip discovery/reconciliation
    // entirely, so a previous session's service handle can never be retained
    // or used for an unidentified session.
    if (!sessionId) {
      adapter.endSession();
      return;
    }

    // Bind the scheduler adapter to the concrete workflow session generation
    // BEFORE discovery/reconciliation so ownership identity and ephemeral
    // correlation state are scoped to this session (and never leak from the
    // previous one). A different session id is a hard boundary.
    try {
      adapter.beginSession(sessionId);
    } catch {
      // Invalid id must not crash session startup; fail closed instead.
      adapter.endSession();
      return;
    }

    // Capture the session generation this handler bound. A later/overlapping
    // session_start (or shutdown) supersedes it; if that happens while
    // discovery is awaiting, this suspended handler must NOT reconcile the new
    // session against its own (now stale) assumptions.
    const boundGeneration = adapter.getSessionGeneration();

    if ((pi as any).events) {
      adapter.bindEvents((pi as any).events);
      await adapter.discover((pi as any).events, { timeoutMs: 500 }).catch(() => {});
      if (adapter.getSessionGeneration() !== boundGeneration) {
        return;
      }
      if (adapter.isAvailable()) {
        await adapter.reconcile().catch(() => {});
      }
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    dispatcher.clearActiveIteration("session_tree");
    registry.refresh();
    // Identity unknown: fail closed. Never reconcile against a service handle
    // that cannot be attributed to the concrete active session.
    const sessionId = resolveActiveSessionId(ctx);
    if (!sessionId) {
      return;
    }
    // A tree refresh within the same session preserves ownership identity while
    // rebuilding branch-derived run state. A different id is a session switch.
    try {
      adapter.beginSession(sessionId);
    } catch {
      // Invalid id must not crash session navigation.
      return;
    }
    if (adapter.isSessionActive() && adapter.isAvailable()) {
      await adapter.reconcile().catch(() => {});
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    return adapter.handleBeforeAgentStart(event, ctx) as any;
  });

  pi.on("turn_start", async (_event, ctx) => {
    adapter.handleTurnStart(ctx);
  });

  pi.on("agent_settled", async () => {
    adapter.handleAgentSettled();
  });

  pi.on("session_shutdown", async () => {
    dispatcher.clearActiveIteration("session_shutdown");
    // End the adapter session generation: detaches/invalidates the service
    // handle, clears ephemeral mappings and pending turn correlation, and
    // rotates ownership so stale handles cannot mutate a later session.
    adapter.endSession();
    capabilityRegistry.dispose();
  });

  return { registry, capabilityRegistry, dispatcher, adapter, controller, goalController };
}
