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
 * Check if an unknown value is a valid WorkflowSnapshotV1
 */
export function isWorkflowSnapshot(value: unknown): value is WorkflowSnapshotV1 {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<WorkflowSnapshotV1>;
  return (
    s.schemaVersion === WORKFLOW_SCHEMA_VERSION &&
    typeof s.snapshotId === "string" &&
    typeof s.name === "string" &&
    typeof s.body === "string" &&
    typeof s.source === "object"
  );
}
