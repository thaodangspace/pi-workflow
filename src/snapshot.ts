/**
 * Immutable Workflow Definition Snapshot for durable runs
 */

import { WORKFLOW_SCHEMA_VERSION } from "./constants.ts";
import type { DeepReadonly, WorkflowDefinitionV1, WorkflowSnapshotV1 } from "./types.ts";

/**
 * Deep freezes an object recursively to guarantee immutability.
 */
export function deepFreeze<T>(obj: T): DeepReadonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj as DeepReadonly<T>;
  }

  // Freeze properties first
  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }

  return Object.freeze(obj) as DeepReadonly<T>;
}

export interface CreateSnapshotOptions {
  /** Optional custom snapshot identifier */
  snapshotId?: string;
  /** Optional creation timestamp (ISO 8601) */
  createdAt?: string;
}

/**
 * Create an immutable snapshot of a workflow definition.
 * Suitable for durable runs to ensure that modifications to files on disk
 * do not alter active runs in progress.
 */
export function createWorkflowSnapshot(
  definition: WorkflowDefinitionV1,
  options: CreateSnapshotOptions = {}
): WorkflowSnapshotV1 {
  const snapshotId =
    options.snapshotId ??
    `wf-snap-${definition.name}-${definition.source.sha256.slice(0, 12)}`;
  const createdAt = options.createdAt ?? new Date().toISOString();

  // Create deep clone before freezing
  const clonedDef: WorkflowDefinitionV1 = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: definition.name,
    description: definition.description,
    ...(definition.type ? { type: definition.type } : {}),
    ...(definition.objective !== undefined ? { objective: definition.objective } : {}),
    mode: definition.mode,
    ...(definition.schedule ? { schedule: JSON.parse(JSON.stringify(definition.schedule)) } : {}),
    concurrency: { ...definition.concurrency },
    budget: { ...definition.budget },
    wakeups: {
      ...definition.wakeups,
      ...(definition.wakeups.named ? { named: { ...definition.wakeups.named } } : {}),
      ...(definition.wakeups.namedMs ? { namedMs: { ...definition.wakeups.namedMs } } : {}),
    },
    requires: [...definition.requires],
    ...(definition.capabilityRequirements
      ? {
          capabilityRequirements: definition.capabilityRequirements.map((r) => ({
            ...r,
            ...(r.features ? { features: [...r.features] } : {}),
          })),
        }
      : {}),
    ...(definition.completion ? { completion: { ...definition.completion } } : {}),
    ...(definition.metadata ? { metadata: JSON.parse(JSON.stringify(definition.metadata)) } : {}),
    body: definition.body,
    source: { ...definition.source },
  };

  const snapshot: WorkflowSnapshotV1 = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    snapshotId,
    createdAt,
    definition: clonedDef,
    source: clonedDef.source,
    name: clonedDef.name,
    description: clonedDef.description,
    ...(clonedDef.type ? { type: clonedDef.type } : {}),
    ...(clonedDef.objective !== undefined ? { objective: clonedDef.objective } : {}),
    mode: clonedDef.mode,
    schedule: clonedDef.schedule,
    concurrency: clonedDef.concurrency,
    budget: clonedDef.budget,
    wakeups: clonedDef.wakeups,
    requires: clonedDef.requires,
    capabilityRequirements: clonedDef.capabilityRequirements,
    completion: clonedDef.completion,
    metadata: clonedDef.metadata,
    body: clonedDef.body,
  };

  return deepFreeze(snapshot);
}

/**
 * Validates the durable kind/objective invariant shared by a snapshot's
 * top-level fields and its nested immutable `definition`.
 *
 * Invariants:
 * - `type`, when present, must be a member of the closed union
 *   (`"workflow" | "goal"`); an absent type defaults to an ordinary workflow.
 * - The top-level and nested `definition` kinds must agree.
 * - A `goal` must carry a non-empty objective in BOTH places and the two must
 *   be identical; the objective is durable goal identity, so a mismatch is
 *   corruption rather than a recoverable inconsistency.
 * - An ordinary/legacy workflow must carry NO objective in either place.
 * - Pre-feature ordinary snapshots (both fields absent) remain valid.
 */
function isValidSnapshotKindInvariant(
  topType: unknown,
  topObjective: unknown,
  nestedType: unknown,
  nestedObjective: unknown
): boolean {
  const validKind = (v: unknown): v is "workflow" | "goal" | undefined =>
    v === undefined || v === "workflow" || v === "goal";
  if (!validKind(topType) || !validKind(nestedType)) {
    return false;
  }

  const topKind = topType === "goal" ? "goal" : "workflow";
  const nestedKind = nestedType === "goal" ? "goal" : "workflow";
  if (topKind !== nestedKind) {
    return false;
  }

  const topObjIsString = topObjective === undefined || typeof topObjective === "string";
  const nestedObjIsString = nestedObjective === undefined || typeof nestedObjective === "string";
  if (!topObjIsString || !nestedObjIsString) {
    return false;
  }

  if (topKind === "goal") {
    if (typeof topObjective !== "string" || topObjective.trim().length === 0) return false;
    if (typeof nestedObjective !== "string" || nestedObjective.trim().length === 0) return false;
    return topObjective === nestedObjective;
  }

  // Ordinary/legacy: objective is meaningless and must be absent everywhere.
  return topObjective === undefined && nestedObjective === undefined;
}

/**
 * Check if an unknown value is a valid WorkflowSnapshotV1.
 *
 * Beyond the presence of required envelope fields, this enforces the durable
 * kind/objective invariant across both the top-level snapshot fields and the
 * nested immutable `definition` (see {@link isValidSnapshotKindInvariant}), so a
 * replayed create payload can never silently lose or corrupt goal identity.
 */
export function isWorkflowSnapshot(value: unknown): value is WorkflowSnapshotV1 {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<WorkflowSnapshotV1>;
  if (
    s.schemaVersion !== WORKFLOW_SCHEMA_VERSION ||
    typeof s.snapshotId !== "string" ||
    typeof s.name !== "string" ||
    typeof s.body !== "string" ||
    typeof s.source !== "object"
  ) {
    return false;
  }

  const rawDefinition = (s as { definition?: unknown }).definition;
  const nestedDefinition =
    rawDefinition !== null && typeof rawDefinition === "object" && !Array.isArray(rawDefinition)
      ? (rawDefinition as Record<string, unknown>)
      : undefined;

  return isValidSnapshotKindInvariant(
    s.type,
    s.objective,
    nestedDefinition?.type,
    nestedDefinition?.objective
  );
}
