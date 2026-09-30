/**
 * Constants for Workflow Spec v1
 */

/** Schema version string */
export const WORKFLOW_SCHEMA_VERSION = "v1" as const;

/**
 * Maximum workflow file size in bytes (512 KiB).
 * Capped to prevent accidental loading of huge files or DoS.
 */
export const MAX_WORKFLOW_FILE_SIZE_BYTES = 512 * 1024; // 524,288 bytes

/** Maximum workflow name length */
export const MAX_NAME_LENGTH = 64;

/** Maximum workflow description length */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Default relative directory for project-level workflows */
export const DEFAULT_PROJECT_WORKFLOWS_DIR = ".pi/workflows";

/** Default directory name under ~/.pi/agent/ for user-level workflows */
export const DEFAULT_USER_WORKFLOWS_SUBDIR = "workflows";

/** Allowed workflow modes */
export const ALLOWED_WORKFLOW_MODES = [
  "self-paced",
  "fixed",
  "interval",
  "cron",
  "once",
  "manual",
] as const;

/** Allowed top-level frontmatter fields for Workflow Spec v1 */
export const ALLOWED_FRONTMATTER_FIELDS = [
  "name",
  "description",
  "mode",
  "schedule",
  "concurrency",
  "budget",
  "wakeups",
  "requires",
  "completion",
  "metadata",
] as const;
