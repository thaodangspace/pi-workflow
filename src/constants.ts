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

/** CustomEntry customType identifier for workflow run mutations */
export const WORKFLOW_RUN_ENTRY_TYPE = "workflow-run";

/** Version of the persisted workflow run mutation log schema */
export const WORKFLOW_RUN_PERSISTENCE_VERSION = 1;

/** Maximum byte size per individual run data payload (64 KiB) */
export const MAX_RUN_DATA_BYTES = 64 * 1024;

/** Maximum cumulative byte size of data stored on a single run (256 KiB) */
export const MAX_RUN_TOTAL_DATA_BYTES = 256 * 1024;

/** Maximum object nesting depth for workflow data */
export const MAX_DATA_DEPTH = 10;

/** Maximum allowed key length in workflow data objects */
export const MAX_DATA_KEY_LENGTH = 128;

/** Maximum string length for scalar values in workflow data (16 KiB) */
export const MAX_DATA_STRING_LENGTH = 16 * 1024;

/** Maximum number of evidence items in a completion record */
export const MAX_EVIDENCE_ITEMS = 50;

/** Maximum character length for blocker reason */
export const MAX_BLOCKER_REASON_LENGTH = 2048;

/** Maximum character length for completion summary */
export const MAX_COMPLETION_SUMMARY_LENGTH = 4096;

/** Maximum length for workflow step names */
export const MAX_STEP_NAME_LENGTH = 64;

/** Maximum length for workflow run IDs */
export const MAX_RUN_ID_LENGTH = 128;

/** Maximum character length for verification findings */
export const MAX_VERIFICATION_FINDINGS_LENGTH = 4096;

/** Default maximum verification attempts before blocking */
export const MAX_VERIFICATION_ATTEMPTS_DEFAULT = 3;

/** Default conservative retry delay for external-retryable blockers (15 minutes) */
export const DEFAULT_RETRYABLE_BLOCKER_DELAY_MS = 15 * 60 * 1000;

/** Maximum character length for an effect key */
export const MAX_EFFECT_KEY_LENGTH = 128;

/** Maximum character length for an effect kind */
export const MAX_EFFECT_KIND_LENGTH = 128;

/** Maximum character length for an effect recovery note or reason */
export const MAX_EFFECT_NOTE_LENGTH = 4096;

/** Maximum number of effects stored on a single run */
export const MAX_EFFECTS_PER_RUN = 1000;
