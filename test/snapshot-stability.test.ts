import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowContent } from "../src/parser.ts";
import { WorkflowRunRegistry } from "../src/registry.ts";
import { createWorkflowSnapshot } from "../src/snapshot.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

describe("WorkflowRun Snapshot Stability & Immutability", () => {
  const sampleDoc = `---
name: stability-workflow
description: Tests snapshot stability for workflow runs.
mode: self-paced
budget:
  maxTurns: 30
---
# Policy Body
Original markdown prompt body.
`;

  it("freezes snapshot on run creation and protects against mutations to definition", () => {
    const def = parseWorkflowContent(sampleDoc, {
      path: "/test/stability.md",
      scope: "project",
    });

    const registry = new WorkflowRunRegistry();
    const run = registry.createRun(def);

    // Mutate source definition
    def.budget.maxTurns = 9999;
    def.body = "Completely altered body";

    // Run snapshot remains pristine
    assert.equal(run.snapshot.budget.maxTurns, 30);
    assert.equal(run.snapshot.body, "# Policy Body\nOriginal markdown prompt body.\n");

    // Attempting to mutate run snapshot throws in strict mode
    assert.throws(() => {
      // @ts-expect-error mutating readonly property
      run.snapshot.name = "altered";
    }, TypeError);
  });

  it("preserves snapshot across session persistence and replay without re-reading disk", () => {
    const def = parseWorkflowContent(sampleDoc, {
      path: "/test/stability.md",
      scope: "project",
    });

    const session = new FakeSessionManager();
    const registry1 = new WorkflowRunRegistry(session);
    const run1 = registry1.createRun(def);

    // Simulate session reload: export JSONL and reconstitute fresh registry
    const jsonl = session.exportJsonl();
    const reloadedSession = FakeSessionManager.fromJsonl(jsonl);
    const registry2 = new WorkflowRunRegistry();
    const { runs } = registry2.reconstructFromSession(reloadedSession);

    assert.equal(runs.length, 1);
    const reloadedRun = runs[0];

    assert.equal(reloadedRun.id, run1.id);
    assert.equal(reloadedRun.snapshot.name, "stability-workflow");
    assert.equal(reloadedRun.snapshot.body, "# Policy Body\nOriginal markdown prompt body.\n");
    assert.equal(reloadedRun.snapshot.budget.maxTurns, 30);

    // Reconstructed snapshot is also frozen
    assert.throws(() => {
      // @ts-expect-error mutating readonly property
      reloadedRun.snapshot.name = "altered";
    }, TypeError);
  });
});
