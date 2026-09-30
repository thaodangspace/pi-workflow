import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowContent } from "../src/parser.ts";
import { WorkflowRunRegistry } from "../src/registry.ts";
import { createWorkflowSnapshot } from "../src/snapshot.ts";
import { WorkflowConcurrencyError } from "../src/types.ts";

describe("Workflow Concurrency & Nonterminal Occupancy", () => {
  const singleRunDoc = `---
name: single-worker
description: Workflow with maxRuns 1.
mode: self-paced
concurrency:
  maxRuns: 1
---
# Single worker policy
`;

  const multiRunDoc = `---
name: multi-worker
description: Workflow with maxRuns 3.
mode: self-paced
concurrency:
  maxRuns: 3
---
# Multi worker policy
`;

  const anotherDoc = `---
name: other-workflow
description: Another workflow definition.
mode: self-paced
concurrency:
  maxRuns: 1
---
# Other workflow policy
`;

  it("enforces maxRuns: 1 for concurrent active runs of the same workflow", () => {
    const registry = new WorkflowRunRegistry();
    const def = parseWorkflowContent(singleRunDoc, { path: "/test/single.md", scope: "project" });

    const run1 = registry.createRun(def);
    assert.equal(run1.lifecycle, "active");

    assert.throws(
      () => registry.createRun(def),
      (err) => {
        assert(err instanceof WorkflowConcurrencyError);
        assert.equal(err.workflow, "single-worker");
        assert.equal(err.maxRuns, 1);
        assert.deepEqual(err.activeRunIds, [run1.id]);
        return true;
      }
    );
  });

  it("treats blocked runs as nonterminal and counting toward concurrency occupancy", () => {
    const registry = new WorkflowRunRegistry();
    const def = parseWorkflowContent(singleRunDoc, { path: "/test/single.md", scope: "project" });

    const run1 = registry.createRun(def);
    registry.blockRun(run1.id, { reason: "Waiting on external webhook" });

    assert.equal(registry.getRun(run1.id)?.lifecycle, "blocked");

    // Blocked run occupies concurrency slot to prevent duplicate parallel runs
    assert.throws(
      () => registry.createRun(def),
      (err) => err instanceof WorkflowConcurrencyError && err.activeRunIds.includes(run1.id)
    );
  });

  it("treats paused runs as nonterminal and counting toward concurrency occupancy", () => {
    const registry = new WorkflowRunRegistry();
    const def = parseWorkflowContent(singleRunDoc, { path: "/test/single.md", scope: "project" });

    const run1 = registry.createRun(def);
    registry.pauseRun(run1.id, { reason: "User paused" });

    assert.equal(registry.getRun(run1.id)?.lifecycle, "paused");

    // Paused run occupies concurrency slot
    assert.throws(
      () => registry.createRun(def),
      (err) => err instanceof WorkflowConcurrencyError && err.activeRunIds.includes(run1.id)
    );
  });

  it("frees concurrency slot when a run transitions to terminal completed or cancelled", () => {
    const registry = new WorkflowRunRegistry();
    const def = parseWorkflowContent(singleRunDoc, { path: "/test/single.md", scope: "project" });

    const run1 = registry.createRun(def);
    registry.completeRun(run1.id, { summary: "Work complete" });

    // Completed run frees slot
    const run2 = registry.createRun(def);
    assert.equal(run2.lifecycle, "active");
    assert.notEqual(run2.id, run1.id);

    // Cancel run2
    registry.cancelRun(run2.id, { reason: "Work cancelled" });

    // Cancelled run frees slot
    const run3 = registry.createRun(def);
    assert.equal(run3.lifecycle, "active");
    assert.notEqual(run3.id, run2.id);
  });

  it("enforces multi-run concurrency limit (maxRuns: 3)", () => {
    const registry = new WorkflowRunRegistry();
    const def = parseWorkflowContent(multiRunDoc, { path: "/test/multi.md", scope: "project" });

    const run1 = registry.createRun(def);
    const run2 = registry.createRun(def);
    const run3 = registry.createRun(def);

    assert.equal(registry.getActiveRuns("multi-worker").length, 3);

    // 4th run rejected
    assert.throws(
      () => registry.createRun(def),
      (err) => err instanceof WorkflowConcurrencyError && err.maxRuns === 3 && err.activeRunIds.length === 3
    );

    // Cancel one run, now 4th run succeeds
    registry.cancelRun(run2.id);
    const run4 = registry.createRun(def);
    assert.equal(run4.lifecycle, "active");
  });

  it("allows multiple runs of different workflows to coexist", () => {
    const registry = new WorkflowRunRegistry();
    const defA = parseWorkflowContent(singleRunDoc, { path: "/test/single.md", scope: "project" });
    const defB = parseWorkflowContent(anotherDoc, { path: "/test/other.md", scope: "project" });

    const runA = registry.createRun(defA);
    const runB = registry.createRun(defB);

    assert.equal(runA.workflow, "single-worker");
    assert.equal(runB.workflow, "other-workflow");
    assert.equal(registry.getActiveRuns().length, 2);

    // Second run of A fails
    assert.throws(() => registry.createRun(defA), WorkflowConcurrencyError);
    // Second run of B fails
    assert.throws(() => registry.createRun(defB), WorkflowConcurrencyError);
  });

  it("supports existingPolicy: 'returnExisting' to resolve to active run without throwing", () => {
    const registry = new WorkflowRunRegistry();
    const def = parseWorkflowContent(singleRunDoc, { path: "/test/single.md", scope: "project" });

    const run1 = registry.createRun(def);

    const runResolved = registry.createRun(def, { existingPolicy: "returnExisting" });
    assert.equal(runResolved.id, run1.id);
  });
});
