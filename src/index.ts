/**
 * pi-workflow: Workflow engine for Pi coding agent
 *
 * Workflow Spec v1 definition parser, loader, and immutable snapshot facilities.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

/**
 * Pi extension entrypoint stub.
 * Pure core logic remains cleanly testable independently of live Pi process.
 */
export default function workflowExtension(pi: ExtensionAPI): void {
  // Extension entrypoint stub - runtime engine and commands are registered in subsequent issues.
}
