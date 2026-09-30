/**
 * Duration parsing and formatting utilities for Workflow Spec v1
 */

const DURATION_PART_REGEX = /^(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?|ms|milliseconds?)$/i;

const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  mins: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hrs: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

/**
 * Parse a duration string or number into milliseconds.
 *
 * Supported formats:
 * - "30s", "5m", "8h", "1d", "500ms"
 * - "1h 30m", "2 days 4 hours"
 * - Numeric milliseconds (non-negative finite number)
 *
 * @param value Duration string or numeric milliseconds
 * @param fieldName Optional field name for error reporting
 * @returns Duration in milliseconds
 * @throws Error if duration format is invalid
 */
export function parseDuration(value: string | number, fieldName = "duration"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid duration for "${fieldName}": must be a non-negative finite number (got ${value})`);
    }
    return Math.round(value);
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid duration for "${fieldName}": must be a non-empty string or positive number`);
  }

  const trimmed = value.trim();

  // Split multiple parts e.g. "1h 30m"
  const tokens = trimmed.split(/\s+/);
  let totalMs = 0;
  let parsedAny = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // Check if token alone matches: e.g. "5m"
    let match = token.match(DURATION_PART_REGEX);

    // If not, check if current token is number and next is unit: e.g. "5" "minutes"
    if (!match && i + 1 < tokens.length) {
      const combined = `${token} ${tokens[i + 1]}`;
      match = combined.match(DURATION_PART_REGEX);
      if (match) {
        i++; // skip next token
      }
    }

    if (!match) {
      throw new Error(
        `Invalid duration format "${value}" for "${fieldName}": expected formats like "5m", "8h", "30s", "1d"`
      );
    }

    const num = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = UNIT_TO_MS[unit];

    if (multiplier === undefined) {
      throw new Error(`Unknown duration unit "${unit}" in "${value}" for "${fieldName}"`);
    }

    totalMs += Math.round(num * multiplier);
    parsedAny = true;
  }

  if (!parsedAny || totalMs < 0) {
    throw new Error(`Invalid duration value "${value}" for "${fieldName}"`);
  }

  return totalMs;
}

/**
 * Format a duration in milliseconds into a concise readable string (e.g. "8h", "5m", "30s").
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";

  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  const seconds = Math.floor((ms % (60 * 1000)) / 1000);
  const milliseconds = ms % 1000;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  if (parts.length === 0 && milliseconds > 0) parts.push(`${milliseconds}ms`);

  return parts.join(" ") || "0s";
}
