/**
 * Bounded, best-effort sanitization for user/model-controlled diagnostic text
 * (issue #10).
 *
 * This module is intentionally low-level (it imports only constants and types)
 * so it can be applied at two boundaries without creating an import cycle:
 *
 *  1. the **history projection boundary** (`src/run.ts` /
 *     `src/registry.ts`): summaries and detail values are sanitized before they
 *     are retained, so the in-memory projection and every replay of it are
 *     deterministic and never store raw credential-shaped prose; and
 *  2. the **display boundary** (`src/observability.ts`): any free text that
 *     reaches a command output or the TUI status line.
 *
 * The policy is explicitly **best-effort, not a guarantee**: arbitrary prose
 * cannot be proven secret-free. Every value is normalized, bounded with a
 * visible omission marker, and credential-shaped substrings are redacted. The
 * durable Pi session JSONL log remains the append-only source of truth.
 */

import { MAX_DIAGNOSTIC_KEY_LENGTH, MAX_DIAGNOSTIC_TEXT_LENGTH } from "./constants.ts";
import type { JsonValue } from "./types.ts";

/** Result of sanitizing a user/model-controlled diagnostic string. */
export interface SanitizedText {
  /** Bounded, inline-safe, redacted text (empty when omitted). */
  readonly text: string;
  /** True when the source was truncated to the bounded length. */
  readonly truncated: boolean;
  /** True when at least one credential-shaped substring was redacted. */
  readonly redacted: boolean;
  /** True when the source was absent/empty and nothing is shown. */
  readonly omitted: boolean;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const WHITESPACE_RUN = /[ \t\r\n]+/g;

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * Credential-shaped substrings redacted from diagnostic text.
 *
 * The key/value rule accepts both punctuation separators (`token:`, `token=`)
 * and natural-language copulas (`password is …`, `token was …`) so a value
 * following the keyword is redacted rather than just the copula.
 */
const REDACTION_RULES: readonly RedactionRule[] = [
  {
    pattern: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/gi,
    replacement: "[redacted private key]",
  },
  { pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, replacement: "[redacted key]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "[redacted token]" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[redacted token]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[redacted aws key]" },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[redacted jwt]",
  },
  {
    // HTTP authorization header with an optional scheme (`Bearer`, `Basic`,
    // `Token`). MUST run before the generic keyword rule, which would otherwise
    // redact the scheme word as the "value" and leave the actual token behind.
    // Example: `Authorization: Bearer actualsecret` -> `Authorization: [redacted]`.
    pattern:
      /\b(authorization)\b\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?([^\s,;]+)/gi,
    replacement: "$1: [redacted]",
  },
  {
    // `password is hunter2`, `token = abc`, `secret: xyz`, `api key was …`
    pattern:
      /\b(authorization|bearer|password|passwd|secret|token|api[\s_-]?key)\b((?:\s*(?::=|[:=]|=>|is|are|was|were)\s*)|(?:\s+))(?!\[redacted)([^\s,;]+)/gi,
    replacement: "$1$2[redacted]",
  },
  { pattern: /\/\/[^/\s:@]+:[^/\s@]+@/g, replacement: "//[redacted]@" },
];

/**
 * Sanitize a user/model-controlled diagnostic string for inline display.
 *
 * (1) strips control characters and collapses line breaks, (2) redacts
 * credential-shaped substrings, (3) truncates to `maxLength` with a visible
 * `…[+N chars]` marker. Never claims the result is secret-free.
 */
export function sanitizeDiagnosticText(
  value: unknown,
  maxLength: number = MAX_DIAGNOSTIC_TEXT_LENGTH
): SanitizedText {
  if (typeof value !== "string") {
    return Object.freeze({ text: "", truncated: false, redacted: false, omitted: true });
  }
  const normalized = value.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");
  const inline = normalized.replace(WHITESPACE_RUN, " ").trim();
  if (inline.length === 0) {
    return Object.freeze({ text: "", truncated: false, redacted: false, omitted: true });
  }

  let redactedFlag = false;
  let safe = inline;
  for (const rule of REDACTION_RULES) {
    safe = safe.replace(rule.pattern, (match, ...groups) => {
      redactedFlag = true;
      // Re-expand `$1`/`$2` capture references in the replacement.
      return rule.replacement.replace(/\$(\d)/g, (_, n: string) => String(groups[Number(n) - 1] ?? ""));
    });
  }

  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : MAX_DIAGNOSTIC_TEXT_LENGTH;
  let truncated = false;
  if (safe.length > limit) {
    truncated = true;
    safe = `${safe.slice(0, limit)}…[+${safe.length - limit} chars]`;
  }

  return Object.freeze({ text: safe, truncated, redacted: redactedFlag, omitted: false });
}

export interface SanitizeDetailsOptions {
  readonly maxStringLength?: number;
  readonly maxKeyLength?: number;
  readonly maxDepth?: number;
  readonly maxArrayLength?: number;
  readonly maxKeys?: number;
}

/**
 * Sanitize/bound a list of object keys, deterministically resolving collisions
 * (two distinct raw keys can sanitize to the same safe key). Keys are sorted
 * first, and each subsequent duplicate gets a stable `#N` suffix.
 */
export function sanitizeDiagnosticKeys(
  keys: readonly string[],
  options: { maxKeyLength?: number; maxItems?: number } = {}
): string[] {
  const maxKeyLength = options.maxKeyLength ?? MAX_DIAGNOSTIC_KEY_LENGTH;
  const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
  const used = new Set<string>();
  const out: string[] = [];
  for (const raw of keys) {
    if (out.length >= maxItems) {
      break;
    }
    const base = sanitizeDiagnosticText(raw, maxKeyLength).text || "[key]";
    let candidate = base;
    let suffix = 1;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${base}#${suffix}`;
    }
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}

/**
 * Recursively sanitize/bound a JSON-safe details record at the projection
 * boundary. **Object keys are sanitized as well as values**, string values are
 * bounded, arrays/objects are bounded in breadth and depth, and non-finite
 * numbers/non-JSON values are dropped. Key collisions are resolved
 * deterministically.
 *
 * Deterministic: the same input always yields the same output, so live and
 * replayed projections remain byte-for-byte identical.
 */
export function sanitizeHistoryDetails<T extends JsonValue = JsonValue>(
  details: Record<string, T> | undefined,
  options: SanitizeDetailsOptions = {}
): Record<string, T> | undefined {
  if (details === undefined) {
    return undefined;
  }
  const maxStringLength = options.maxStringLength ?? MAX_DIAGNOSTIC_TEXT_LENGTH;
  const maxKeyLength = options.maxKeyLength ?? MAX_DIAGNOSTIC_KEY_LENGTH;
  const maxDepth = options.maxDepth ?? 6;
  const maxArrayLength = options.maxArrayLength ?? 50;
  const maxKeys = options.maxKeys ?? 64;

  const walk = (value: unknown, depth: number): JsonValue => {
    if (typeof value === "string") {
      return sanitizeDiagnosticText(value, maxStringLength).text;
    }
    if (value === null || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (Array.isArray(value)) {
      if (depth >= maxDepth) {
        return "[truncated]";
      }
      return value.slice(0, maxArrayLength).map((item) => walk(item, depth + 1));
    }
    if (typeof value === "object") {
      if (depth >= maxDepth) {
        return "[truncated]";
      }
      const source = value as Record<string, unknown>;
      const rawKeys = Object.keys(source).sort();
      const safeKeys = sanitizeDiagnosticKeys(rawKeys, { maxKeyLength, maxItems: maxKeys });
      const out: Record<string, JsonValue> = {};
      for (let i = 0; i < safeKeys.length; i++) {
        out[safeKeys[i]] = walk(source[rawKeys[i]], depth + 1);
      }
      if (rawKeys.length > maxKeys) {
        let marker = "[truncated]";
        let suffix = 1;
        while (marker in out) {
          suffix += 1;
          marker = `[truncated]#${suffix}`;
        }
        out[marker] = true;
      }
      return out;
    }
    // functions/symbols/undefined are not JSON-safe.
    return null;
  };

  return walk(details, 0) as Record<string, T>;
}
