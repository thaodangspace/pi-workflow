/**
 * pi-workflow: Workflow engine for Pi coding agent
 *
 * Workflow Spec v1 definition parser, loader, and immutable snapshot facilities.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorkflowRunRegistry } from "./registry.ts";
import type { WorkflowSessionTarget } from "./types.ts";

// Re-export constants
export * from "./constants.ts";

// Re-export types
export * from "./types.ts";

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

// Re-export session entry encoding and parsing
export * from "./session-entries.ts";

// Re-export registry
export * from "./registry.ts";

/**
 * Factory to create a WorkflowRunRegistry.
 */
export function createWorkflowRunRegistry(
  sessionTarget?: WorkflowSessionTarget
): WorkflowRunRegistry {
  return new WorkflowRunRegistry(sessionTarget);
}

/**
 * Pi extension entrypoint.
 * Automatically synchronizes workflow runs with the active session branch across reloads and tree navigation.
 */
export default function workflowExtension(pi: ExtensionAPI): void {
  const registry = new WorkflowRunRegistry();

  pi.on("session_start", async (_event, ctx) => {
    registry.bindSession({
      appendEntry: (customType: string, data?: unknown) => pi.appendEntry(customType, data),
      getBranch: (fromId?: string) => ctx.sessionManager.getBranch(fromId),
    });
    registry.refresh();
  });

  pi.on("session_tree", async (_event, _ctx) => {
    registry.refresh();
  });
}
