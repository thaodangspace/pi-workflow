/**
 * Fixed-capacity bounded projection primitives (issue #24).
 *
 * `WorkflowRun.history` and `WorkflowRun.recoveryEvents` are in-memory
 * projections over the durable append-only Pi session log. They retain only a
 * small, fixed number of the most recent entries so that:
 *
 *   memory   = O(capacity)
 *   append   = O(capacity)   (never O(total lifetime entries))
 *
 * A projection also tracks the total lifetime number of entries ever appended
 * and how many were dropped, so truncation is observable and a run that has
 * only a few lifetime events is distinguishable from a run that has many
 * lifetime events but the same retained window.
 *
 * All projections are immutable: `entries` arrays and the projection wrapper
 * are frozen on every append.
 */

/** Immutable fixed-capacity projection of the most recent entries. */
export interface BoundedProjection<T> {
  /** Retained entries, oldest first. */
  readonly entries: ReadonlyArray<T>;
  /** Total lifetime entries appended (retained + dropped). */
  readonly total: number;
  /** Number of lifetime entries dropped from the retained window. */
  readonly dropped: number;
}

/**
 * Create an empty projection. The returned object (and its entries array) is
 * frozen.
 */
export function emptyBoundedProjection<T>(): BoundedProjection<T> {
  return Object.freeze({ entries: Object.freeze([]) as ReadonlyArray<T>, total: 0, dropped: 0 });
}

/**
 * Append a single entry to a bounded projection.
 *
 * The retained window is capped at `capacity` entries (oldest dropped first).
 * Work performed is always O(capacity) — copying at most `capacity` entries —
 * and never proportional to `total` lifetime entries.
 */
export function appendBounded<T>(
  projection: BoundedProjection<T> | undefined,
  entry: T,
  capacity: number
): BoundedProjection<T> {
  const base = projection ?? emptyBoundedProjection<T>();
  const cap = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0;
  const total = base.total + 1;
  const prev = base.entries;

  let entries: ReadonlyArray<T>;
  if (cap === 0) {
    entries = Object.freeze([]) as ReadonlyArray<T>;
  } else if (prev.length < cap) {
    entries = Object.freeze([...prev, entry]);
  } else {
    // Sliding window: keep the newest `cap - 1` and append the new newest.
    entries = Object.freeze([...prev.slice(prev.length - cap + 1), entry]);
  }

  return Object.freeze({ entries, total, dropped: total - entries.length });
}
