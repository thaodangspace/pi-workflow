/**
 * Safe YAML Frontmatter and Schema Parser for Workflow Spec v1
 */

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  ALLOWED_FRONTMATTER_FIELDS,
  ALLOWED_WORKFLOW_MODES,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_WORKFLOW_FILE_SIZE_BYTES,
  WORKFLOW_SCHEMA_VERSION,
} from "./constants.ts";
import { parseDuration } from "./duration.ts";
import type { WorkflowCapabilityRequirement } from "./capabilities.ts";
import {
  type WorkflowBudgetPolicy,
  type WorkflowCompletionPolicy,
  type WorkflowConcurrencyPolicy,
  type WorkflowDefinitionV1,
  type WorkflowDiagnostic,
  type WorkflowMode,
  type WorkflowScheduleConfig,
  type WorkflowSourceIdentity,
  WorkflowValidationError,
  type WorkflowWakeupPolicy,
} from "./types.ts";

export interface ParseWorkflowOptions {
  /** Maximum allowed file size in bytes (defaults to 512 KiB) */
  maxFileSize?: number;
}

export interface ExtractedFrontmatter {
  yamlString: string;
  body: string;
}

const NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Extracts YAML frontmatter and preserves the Markdown body byte-for-byte.
 *
 * Rules:
 * - File must start with "---" followed by newline (or \r\n).
 * - Closing delimiter must be "---" or "..." on its own line.
 * - Body starts immediately after the newline of the closing delimiter.
 * - Preserves all characters, indentation, spaces, and newlines in the body exactly.
 */
export function extractFrontmatterAndBody(
  content: string,
  filePath = "inline"
): ExtractedFrontmatter {
  // Strip optional UTF-8 BOM
  let workingContent = content;
  if (workingContent.charCodeAt(0) === 0xfeff) {
    workingContent = workingContent.slice(1);
  }

  if (!workingContent.startsWith("---\n") && !workingContent.startsWith("---\r\n")) {
    throw new WorkflowValidationError(
      `Workflow definition must start with YAML frontmatter delimiter "---"`,
      filePath,
      "frontmatter"
    );
  }

  // Regex matching from opening delimiter to closing delimiter line
  const delimiterMatch = workingContent.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\\.{3})[ \t]*(?:\r?\n|$)/);

  if (!delimiterMatch) {
    throw new WorkflowValidationError(
      `Workflow definition has unclosed YAML frontmatter: missing closing "---" delimiter`,
      filePath,
      "frontmatter"
    );
  }

  const yamlString = delimiterMatch[1];
  // Body begins immediately after the entire delimiter match
  const body = workingContent.slice(delimiterMatch[0].length);

  return { yamlString, body };
}

/**
 * Parse and strictly validate workflow definition content.
 *
 * @param content Raw markdown string
 * @param source Source identity metadata
 * @param options Optional parser settings
 */
export function parseWorkflowContent(
  content: string,
  source: Omit<WorkflowSourceIdentity, "sha256" | "loadedAt"> & {
    sha256?: string;
    loadedAt?: string;
  },
  options: ParseWorkflowOptions = {}
): WorkflowDefinitionV1 {
  const filePath = source.path;
  const maxFileSize = options.maxFileSize ?? MAX_WORKFLOW_FILE_SIZE_BYTES;

  const contentByteLength = Buffer.byteLength(content, "utf-8");
  if (contentByteLength > maxFileSize) {
    throw new WorkflowValidationError(
      `Workflow file size (${contentByteLength} bytes) exceeds maximum limit of ${maxFileSize} bytes (${Math.round(
        maxFileSize / 1024
      )} KiB)`,
      filePath,
      undefined
    );
  }

  const sha256 = source.sha256 ?? createHash("sha256").update(content, "utf-8").digest("hex");
  const loadedAt = source.loadedAt ?? new Date().toISOString();

  // Extract frontmatter and byte-for-byte body
  const { yamlString, body } = extractFrontmatterAndBody(content, filePath);

  // Parse YAML safely (Core schema, no code evaluation)
  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = parseYaml(yamlString, {
      schema: "core",
      prettyErrors: true,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new WorkflowValidationError(
      `Malformed YAML frontmatter: ${errorMsg}`,
      filePath,
      "frontmatter"
    );
  }

  if (typeof rawFrontmatter !== "object" || rawFrontmatter === null || Array.isArray(rawFrontmatter)) {
    throw new WorkflowValidationError(
      `Frontmatter must be a YAML mapping (key-value object), received ${
        Array.isArray(rawFrontmatter) ? "array" : typeof rawFrontmatter
      }`,
      filePath,
      "frontmatter"
    );
  }

  const raw = rawFrontmatter as Record<string, unknown>;
  const diagnostics: WorkflowDiagnostic[] = [];

  function addError(field: string, message: string): void {
    diagnostics.push({ type: "error", path: filePath, field, message });
  }

  // 1. Check for unexpected top-level fields
  const allowedFields = new Set<string>(ALLOWED_FRONTMATTER_FIELDS);
  for (const key of Object.keys(raw)) {
    if (!allowedFields.has(key)) {
      addError(
        key,
        `Unexpected field "${key}" in workflow frontmatter. Allowed fields: ${ALLOWED_FRONTMATTER_FIELDS.join(
          ", "
        )}`
      );
    }
  }

  // 2. Validate 'name'
  let name = "";
  if (raw.name === undefined || raw.name === null) {
    addError("name", 'Field "name" is required');
  } else if (typeof raw.name !== "string") {
    addError("name", `Field "name" must be a string (got ${typeof raw.name})`);
  } else {
    name = raw.name.trim();
    if (!NAME_REGEX.test(name)) {
      addError(
        "name",
        `Field "name" must consist of 1-${MAX_NAME_LENGTH} lowercase alphanumeric characters, hyphens, or underscores, starting with an alphanumeric character (got "${raw.name}")`
      );
    }
  }

  // 3. Validate 'description'
  let description = "";
  if (raw.description === undefined || raw.description === null) {
    addError("description", 'Field "description" is required');
  } else if (typeof raw.description !== "string") {
    addError("description", `Field "description" must be a string (got ${typeof raw.description})`);
  } else {
    description = raw.description.trim();
    if (description.length === 0) {
      addError("description", 'Field "description" cannot be empty');
    } else if (description.length > MAX_DESCRIPTION_LENGTH) {
      addError(
        "description",
        `Field "description" exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`
      );
    }
  }

  // 4. Validate 'mode'
  let mode: WorkflowMode = "self-paced";
  if (raw.mode === undefined || raw.mode === null) {
    addError("mode", 'Field "mode" is required');
  } else if (typeof raw.mode !== "string") {
    addError("mode", `Field "mode" must be a string (got ${typeof raw.mode})`);
  } else if (!(ALLOWED_WORKFLOW_MODES as readonly string[]).includes(raw.mode)) {
    addError(
      "mode",
      `Field "mode" must be one of: ${ALLOWED_WORKFLOW_MODES.map((m) => `"${m}"`).join(
        ", "
      )} (got "${raw.mode}")`
    );
  } else {
    mode = raw.mode as WorkflowMode;
  }

  // 5. Validate 'schedule'
  let schedule: WorkflowScheduleConfig | undefined;
  if (raw.schedule !== undefined && raw.schedule !== null) {
    if (typeof raw.schedule !== "object" || Array.isArray(raw.schedule)) {
      addError("schedule", `Field "schedule" must be an object (got ${typeof raw.schedule})`);
    } else {
      const rawSchedule = raw.schedule as Record<string, unknown>;
      schedule = {};

      if (rawSchedule.interval !== undefined) {
        if (typeof rawSchedule.interval !== "string" && typeof rawSchedule.interval !== "number") {
          addError("schedule.interval", `Field "schedule.interval" must be a duration string or number`);
        } else {
          try {
            schedule.interval = String(rawSchedule.interval);
            schedule.intervalMs = parseDuration(rawSchedule.interval, "schedule.interval");
          } catch (e) {
            addError("schedule.interval", e instanceof Error ? e.message : String(e));
          }
        }
      }

      if (rawSchedule.cron !== undefined) {
        if (typeof rawSchedule.cron !== "string" || rawSchedule.cron.trim() === "") {
          addError("schedule.cron", `Field "schedule.cron" must be a non-empty string`);
        } else {
          schedule.cron = rawSchedule.cron.trim();
        }
      }

      if (rawSchedule.delay !== undefined) {
        if (typeof rawSchedule.delay !== "string" && typeof rawSchedule.delay !== "number") {
          addError("schedule.delay", `Field "schedule.delay" must be a duration string or number`);
        } else {
          try {
            schedule.delay = String(rawSchedule.delay);
            schedule.delayMs = parseDuration(rawSchedule.delay, "schedule.delay");
          } catch (e) {
            addError("schedule.delay", e instanceof Error ? e.message : String(e));
          }
        }
      }

      if (rawSchedule.at !== undefined) {
        if (typeof rawSchedule.at !== "string" || Number.isNaN(Date.parse(rawSchedule.at))) {
          addError("schedule.at", `Field "schedule.at" must be a valid ISO-8601 date string`);
        } else {
          schedule.at = rawSchedule.at;
        }
      }

      if (rawSchedule.timeZone !== undefined) {
        if (typeof rawSchedule.timeZone !== "string" || rawSchedule.timeZone.trim() === "") {
          addError("schedule.timeZone", `Field "schedule.timeZone" must be a non-empty string`);
        } else {
          schedule.timeZone = rawSchedule.timeZone.trim();
        }
      }
    }
  }

  // 6. Validate 'concurrency'
  const concurrency: WorkflowConcurrencyPolicy = { maxRuns: 1 };
  if (raw.concurrency !== undefined && raw.concurrency !== null) {
    if (typeof raw.concurrency !== "object" || Array.isArray(raw.concurrency)) {
      addError("concurrency", `Field "concurrency" must be an object (got ${typeof raw.concurrency})`);
    } else {
      const rawConcurrency = raw.concurrency as Record<string, unknown>;
      if (rawConcurrency.maxRuns !== undefined) {
        if (
          typeof rawConcurrency.maxRuns !== "number" ||
          !Number.isInteger(rawConcurrency.maxRuns) ||
          rawConcurrency.maxRuns < 1
        ) {
          addError(
            "concurrency.maxRuns",
            `Field "concurrency.maxRuns" must be an integer >= 1 (got ${rawConcurrency.maxRuns})`
          );
        } else {
          concurrency.maxRuns = rawConcurrency.maxRuns;
        }
      }
    }
  }

  // 7. Validate 'budget'
  const budget: WorkflowBudgetPolicy = {};
  if (raw.budget !== undefined && raw.budget !== null) {
    if (typeof raw.budget !== "object" || Array.isArray(raw.budget)) {
      addError("budget", `Field "budget" must be an object (got ${typeof raw.budget})`);
    } else {
      const rawBudget = raw.budget as Record<string, unknown>;

      if (rawBudget.maxTurns !== undefined) {
        if (
          typeof rawBudget.maxTurns !== "number" ||
          !Number.isInteger(rawBudget.maxTurns) ||
          rawBudget.maxTurns < 1
        ) {
          addError(
            "budget.maxTurns",
            `Field "budget.maxTurns" must be an integer >= 1 (got ${rawBudget.maxTurns})`
          );
        } else {
          budget.maxTurns = rawBudget.maxTurns;
        }
      }

      if (rawBudget.maxDuration !== undefined) {
        if (typeof rawBudget.maxDuration !== "string" && typeof rawBudget.maxDuration !== "number") {
          addError("budget.maxDuration", `Field "budget.maxDuration" must be a duration string or number`);
        } else {
          try {
            budget.maxDuration = String(rawBudget.maxDuration);
            budget.maxDurationMs = parseDuration(rawBudget.maxDuration, "budget.maxDuration");
          } catch (e) {
            addError("budget.maxDuration", e instanceof Error ? e.message : String(e));
          }
        }
      }

      if (rawBudget.maxAttempts !== undefined) {
        if (
          typeof rawBudget.maxAttempts !== "number" ||
          !Number.isInteger(rawBudget.maxAttempts) ||
          rawBudget.maxAttempts < 1
        ) {
          addError(
            "budget.maxAttempts",
            `Field "budget.maxAttempts" must be an integer >= 1 (got ${rawBudget.maxAttempts})`
          );
        } else {
          budget.maxAttempts = rawBudget.maxAttempts;
        }
      }

      if (rawBudget.maxCost !== undefined) {
        if (typeof rawBudget.maxCost !== "number" || !Number.isFinite(rawBudget.maxCost) || rawBudget.maxCost < 0) {
          addError(
            "budget.maxCost",
            `Field "budget.maxCost" must be a non-negative number (got ${rawBudget.maxCost})`
          );
        } else {
          budget.maxCost = rawBudget.maxCost;
        }
      }

      if (rawBudget.maxTokens !== undefined || rawBudget.tokenBudget !== undefined) {
        addError(
          "budget.maxTokens",
          `Field "budget.maxTokens" is not supported because Pi runtime does not expose authoritative token accounting data`
        );
      }

      if (rawBudget.onExhaustion !== undefined) {
        if (rawBudget.onExhaustion !== "block" && rawBudget.onExhaustion !== "cancel") {
          addError(
            "budget.onExhaustion",
            `Field "budget.onExhaustion" must be "block" or "cancel" (got "${String(rawBudget.onExhaustion)}")`
          );
        } else {
          budget.onExhaustion = rawBudget.onExhaustion;
        }
      }
    }
  }

  // 8. Validate 'wakeups'
  const wakeups: WorkflowWakeupPolicy = {};
  if (raw.wakeups !== undefined && raw.wakeups !== null) {
    if (typeof raw.wakeups !== "object" || Array.isArray(raw.wakeups)) {
      addError("wakeups", `Field "wakeups" must be an object (got ${typeof raw.wakeups})`);
    } else {
      const rawWakeups = raw.wakeups as Record<string, unknown>;
      const named: Record<string, string> = {};
      const namedMs: Record<string, number> = {};

      for (const [key, value] of Object.entries(rawWakeups)) {
        if (key === "named" && typeof value === "object" && value !== null && !Array.isArray(value)) {
          for (const [namedKey, namedVal] of Object.entries(value as Record<string, unknown>)) {
            if (typeof namedVal !== "string" && typeof namedVal !== "number") {
              addError(`wakeups.named.${namedKey}`, `Wakeup delay must be a duration string or number`);
            } else {
              try {
                const ms = parseDuration(namedVal, `wakeups.named.${namedKey}`);
                named[namedKey] = String(namedVal);
                namedMs[namedKey] = ms;
              } catch (e) {
                addError(`wakeups.named.${namedKey}`, e instanceof Error ? e.message : String(e));
              }
            }
          }
          continue;
        }

        if (typeof value !== "string" && typeof value !== "number") {
          addError(`wakeups.${key}`, `Wakeup delay for "${key}" must be a duration string or number`);
          continue;
        }

        try {
          const ms = parseDuration(value, `wakeups.${key}`);
          if (key === "default") {
            wakeups.default = String(value);
            wakeups.defaultMs = ms;
          } else if (key === "min") {
            wakeups.min = String(value);
            wakeups.minMs = ms;
          } else if (key === "max") {
            wakeups.max = String(value);
            wakeups.maxMs = ms;
          } else {
            named[key] = String(value);
            namedMs[key] = ms;
            wakeups[key] = value;
          }
        } catch (e) {
          addError(`wakeups.${key}`, e instanceof Error ? e.message : String(e));
        }
      }

      if (Object.keys(named).length > 0) {
        wakeups.named = named;
        wakeups.namedMs = namedMs;
      }
    }
  }

  // 9. Validate 'requires' (bare names and/or structured constraints)
  const requires: string[] = [];
  const capabilityRequirements: WorkflowCapabilityRequirement[] = [];
  if (raw.requires !== undefined && raw.requires !== null) {
    if (!Array.isArray(raw.requires)) {
      addError("requires", `Field "requires" must be an array of capability strings (got ${typeof raw.requires})`);
    } else {
      const seenCapabilities = new Set<string>();
      for (let i = 0; i < raw.requires.length; i++) {
        const item = raw.requires[i];
        let capName: string | undefined;
        let requirement: WorkflowCapabilityRequirement | undefined;

        if (typeof item === "string") {
          const cap = item.trim();
          if (cap === "") {
            addError(`requires[${i}]`, `Capability item at index ${i} must be a non-empty string`);
          } else {
            capName = cap;
            requirement = { name: cap };
          }
        } else if (isPlainObject(item)) {
          const rawReq = item as Record<string, unknown>;
          const rawName = rawReq.name;
          if (typeof rawName !== "string" || rawName.trim() === "") {
            addError(`requires[${i}].name`, `Capability requirement at index ${i} requires a non-empty string "name"`);
          } else {
            const name = rawName.trim();
            const req: WorkflowCapabilityRequirement = { name };

            if (rawReq.version !== undefined) {
              if (
                typeof rawReq.version !== "number" ||
                !Number.isInteger(rawReq.version) ||
                rawReq.version < 1
              ) {
                addError(
                  `requires[${i}].version`,
                  `Capability "${name}" version must be an integer >= 1 (got ${String(rawReq.version)})`
                );
              } else {
                req.version = rawReq.version;
              }
            }

            if (rawReq.features !== undefined) {
              if (!Array.isArray(rawReq.features)) {
                addError(`requires[${i}].features`, `Capability "${name}" features must be an array of strings`);
              } else {
                const features: string[] = [];
                const seenFeatures = new Set<string>();
                for (let f = 0; f < rawReq.features.length; f++) {
                  const feature = rawReq.features[f];
                  if (typeof feature !== "string" || feature.trim() === "") {
                    addError(
                      `requires[${i}].features[${f}]`,
                      `Capability "${name}" feature at index ${f} must be a non-empty string`
                    );
                  } else {
                    const trimmedFeature = feature.trim();
                    if (seenFeatures.has(trimmedFeature)) {
                      addError(
                        `requires[${i}].features`,
                        `Duplicate feature "${trimmedFeature}" for capability "${name}"`
                      );
                    } else {
                      seenFeatures.add(trimmedFeature);
                      features.push(trimmedFeature);
                    }
                  }
                }
                if (features.length > 0) {
                  req.features = features;
                }
              }
            }

            if (rawReq.optional !== undefined) {
              if (typeof rawReq.optional !== "boolean") {
                addError(`requires[${i}].optional`, `Capability "${name}" optional must be a boolean`);
              } else if (rawReq.optional) {
                req.optional = true;
              }
            }

            capName = name;
            requirement = req;
          }
        } else {
          addError(
            `requires[${i}]`,
            `Capability item at index ${i} must be a non-empty string or a structured capability object`
          );
        }

        if (capName !== undefined && requirement !== undefined) {
          if (seenCapabilities.has(capName)) {
            addError(`requires`, `Duplicate capability "${capName}" in field "requires"`);
          } else {
            seenCapabilities.add(capName);
            requires.push(capName);
            capabilityRequirements.push(requirement);
          }
        }
      }
    }
  }

  // 10. Validate 'completion'
  let completion: WorkflowCompletionPolicy | undefined;
  if (raw.completion !== undefined && raw.completion !== null) {
    if (typeof raw.completion !== "object" || Array.isArray(raw.completion)) {
      addError("completion", `Field "completion" must be an object (got ${typeof raw.completion})`);
    } else {
      const rawCompletion = raw.completion as Record<string, unknown>;
      completion = {};

      if (rawCompletion.requireSummary !== undefined) {
        if (typeof rawCompletion.requireSummary !== "boolean") {
          addError("completion.requireSummary", `Field "completion.requireSummary" must be a boolean`);
        } else {
          completion.requireSummary = rawCompletion.requireSummary;
        }
      }

      if (rawCompletion.requireEvidence !== undefined) {
        if (typeof rawCompletion.requireEvidence !== "boolean") {
          addError("completion.requireEvidence", `Field "completion.requireEvidence" must be a boolean`);
        } else {
          completion.requireEvidence = rawCompletion.requireEvidence;
        }
      }

      if (rawCompletion.verify !== undefined) {
        if (typeof rawCompletion.verify !== "boolean") {
          addError("completion.verify", `Field "completion.verify" must be a boolean`);
        } else {
          completion.verify = rawCompletion.verify;
        }
      }

      if (rawCompletion.verifierPrompt !== undefined) {
        if (typeof rawCompletion.verifierPrompt !== "string" || rawCompletion.verifierPrompt.trim() === "") {
          addError("completion.verifierPrompt", `Field "completion.verifierPrompt" must be a non-empty string`);
        } else {
          completion.verifierPrompt = rawCompletion.verifierPrompt;
        }
      }

      if (rawCompletion.maxVerificationAttempts !== undefined) {
        if (
          typeof rawCompletion.maxVerificationAttempts !== "number" ||
          !Number.isInteger(rawCompletion.maxVerificationAttempts) ||
          rawCompletion.maxVerificationAttempts < 1
        ) {
          addError(
            "completion.maxVerificationAttempts",
            `Field "completion.maxVerificationAttempts" must be an integer >= 1`
          );
        } else {
          completion.maxVerificationAttempts = rawCompletion.maxVerificationAttempts;
        }
      }

      if (rawCompletion.returnStep !== undefined) {
        if (typeof rawCompletion.returnStep !== "string" || rawCompletion.returnStep.trim() === "") {
          addError("completion.returnStep", `Field "completion.returnStep" must be a non-empty string`);
        } else {
          completion.returnStep = rawCompletion.returnStep.trim();
        }
      }

      if (rawCompletion.onRejectionExhausted !== undefined) {
        if (rawCompletion.onRejectionExhausted !== "block" && rawCompletion.onRejectionExhausted !== "fail") {
          addError(
            "completion.onRejectionExhausted",
            `Field "completion.onRejectionExhausted" must be "block" or "fail" (got "${String(rawCompletion.onRejectionExhausted)}")`
          );
        } else {
          completion.onRejectionExhausted = rawCompletion.onRejectionExhausted;
        }
      }
    }
  }

  // 11. Validate 'metadata'
  let metadata: Record<string, unknown> | undefined;
  if (raw.metadata !== undefined && raw.metadata !== null) {
    if (typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) {
      addError("metadata", `Field "metadata" must be an object (got ${typeof raw.metadata})`);
    } else {
      metadata = raw.metadata as Record<string, unknown>;
    }
  }

  if (diagnostics.length > 0) {
    const primaryError = diagnostics[0];
    throw new WorkflowValidationError(
      `Validation error in "${filePath}" for field "${primaryError.field ?? 'unknown'}": ${primaryError.message}`,
      filePath,
      primaryError.field,
      diagnostics
    );
  }

  const fullSource: WorkflowSourceIdentity = {
    path: source.path,
    scope: source.scope,
    relativePath: source.relativePath,
    sha256,
    loadedAt,
  };

  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name,
    description,
    mode,
    ...(schedule ? { schedule } : {}),
    concurrency,
    budget,
    wakeups,
    requires,
    ...(capabilityRequirements.length > 0 ? { capabilityRequirements } : {}),
    ...(completion ? { completion } : {}),
    ...(metadata ? { metadata } : {}),
    body,
    source: fullSource,
  };
}

/** Narrows a value to a non-array object (used for structured requirements). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
