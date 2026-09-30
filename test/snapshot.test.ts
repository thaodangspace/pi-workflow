import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowContent } from "../src/parser.ts";
import { createWorkflowSnapshot, isWorkflowSnapshot } from "../src/snapshot.ts";

describe("Workflow Snapshots & Immutability", () => {
  const sampleDoc = `---
name: snapshot-test
description: Snapshot immutability verification.
mode: self-paced

concurrency:
  maxRuns: 2

budget:
  maxTurns: 50
  maxDuration: 4h

wakeups:
  default: 2m
  retry: 30s

requires:
  - loop
  - tmux

completion:
  requireSummary: true
  verify: true
---
# Stable Policy Body
Line 1
Line 2
`;

  it("creates a stable, versioned snapshot carrying schema version and source identity", () => {
    const definition = parseWorkflowContent(sampleDoc, {
      path: "/workspace/.pi/workflows/snapshot-test.md",
      scope: "project",
      relativePath: ".pi/workflows/snapshot-test.md",
    });

    const snapshot = createWorkflowSnapshot(definition);

    assert.equal(snapshot.schemaVersion, "v1");
    assert(snapshot.snapshotId.startsWith("wf-snap-snapshot-test-"));
    assert(snapshot.createdAt.length > 0);
    assert.equal(snapshot.name, "snapshot-test");
    assert.equal(snapshot.description, "Snapshot immutability verification.");
    assert.equal(snapshot.mode, "self-paced");
    assert.equal(snapshot.concurrency.maxRuns, 2);
    assert.equal(snapshot.budget.maxTurns, 50);
    assert.equal(snapshot.budget.maxDuration, "4h");
    assert.equal(snapshot.wakeups.default, "2m");
    assert.deepEqual(snapshot.requires, ["loop", "tmux"]);
    assert.equal(snapshot.completion?.verify, true);
    assert.equal(snapshot.body, "# Stable Policy Body\nLine 1\nLine 2\n");
    assert.equal(snapshot.source.path, "/workspace/.pi/workflows/snapshot-test.md");
    assert.equal(snapshot.source.scope, "project");

    assert(isWorkflowSnapshot(snapshot));
    assert(!isWorkflowSnapshot({}));
    assert(!isWorkflowSnapshot(null));
  });

  it("enforces deep immutability against modifications to top-level and nested properties", () => {
    const definition = parseWorkflowContent(sampleDoc, {
      path: "/workspace/.pi/workflows/snapshot-test.md",
      scope: "project",
    });

    const snapshot = createWorkflowSnapshot(definition);

    // Attempting to mutate top-level property throws
    assert.throws(() => {
      // @ts-expect-error mutating readonly property
      snapshot.name = "mutated-name";
    }, TypeError);

    // Attempting to mutate nested budget throws
    assert.throws(() => {
      // @ts-expect-error mutating readonly property
      snapshot.budget.maxTurns = 999;
    }, TypeError);

    // Attempting to mutate nested array throws
    assert.throws(() => {
      // @ts-expect-error mutating readonly array
      snapshot.requires.push("unauthorized");
    }, TypeError);

    // Attempting to mutate nested wakeups throws
    assert.throws(() => {
      // @ts-expect-error mutating readonly property
      snapshot.wakeups.default = "10s";
    }, TypeError);
  });

  it("isolates snapshot from later mutations of the source definition", () => {
    const definition = parseWorkflowContent(sampleDoc, {
      path: "/workspace/.pi/workflows/snapshot-test.md",
      scope: "project",
    });

    const snapshot = createWorkflowSnapshot(definition);

    // Mutate the original definition object
    definition.budget.maxTurns = 12345;
    definition.requires.push("another-cap");

    // Snapshot remains untouched
    assert.equal(snapshot.budget.maxTurns, 50);
    assert.deepEqual(snapshot.requires, ["loop", "tmux"]);
  });

  it("supports explicit custom snapshotId and createdAt timestamp", () => {
    const definition = parseWorkflowContent(sampleDoc, {
      path: "/workspace/.pi/workflows/snapshot-test.md",
      scope: "project",
    });

    const customId = "run-snap-9988";
    const customTime = "2026-09-30T12:00:00.000Z";
    const snapshot = createWorkflowSnapshot(definition, {
      snapshotId: customId,
      createdAt: customTime,
    });

    assert.equal(snapshot.snapshotId, customId);
    assert.equal(snapshot.createdAt, customTime);
  });
});
