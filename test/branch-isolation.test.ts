import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowDispatcher } from "../src/dispatcher.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { WorkflowRunRegistry } from "../src/registry.ts";
import { LoopSchedulerAdapter } from "../src/scheduler-adapter.ts";
import { WorkflowStatusController } from "../src/status-line.ts";
import { WorkflowConcurrencyError } from "../src/types.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

class BranchStatusUI {
  calls: Array<{ key: string; text: string | undefined }> = [];
  setStatus(key: string, text: string | undefined): void {
    this.calls.push({ key, text });
  }
  lastText(): string | undefined {
    const calls = this.calls.filter((c) => c.key === "workflow");
    return calls.length > 0 ? calls[calls.length - 1].text : undefined;
  }
}

describe("Session Tree Branch Isolation & Reconstruction", () => {
  const sampleDoc = `---
name: branch-workflow
description: Branch isolation verification workflow.
mode: self-paced
concurrency:
  maxRuns: 1
---
# Branch Policy Body
`;

  it("reconstructs only active branch state and isolates abandoned branches completely", () => {
    const session = new FakeSessionManager();
    const registry = new WorkflowRunRegistry(session);
    const def = parseWorkflowContent(sampleDoc, { path: "/test/branch.md", scope: "project" });

    // 1. Initial run created on main branch
    const run1 = registry.createRun(def, {
      runId: "run-root",
      initialStep: "ROOT_STEP",
      initialData: { root: true },
    });
    assert.equal(run1.lifecycle, "active");
    const forkPointLeafId = session.getLeafId();
    assert(forkPointLeafId !== null);

    // 2. Advance Branch A
    registry.transitionStep(run1.id, {
      toStep: "STEP_BRANCH_A",
      data: { branch: "A" },
    });
    registry.completeRun(run1.id, {
      summary: "Completed on Branch A",
      data: { branchACompleted: true },
    });

    // Run 1 is completed on Branch A, freeing maxRuns slot
    const run2 = registry.createRun(def, {
      runId: "run-branch-a-2",
      initialStep: "NEW_RUN_A",
    });
    assert.equal(run2.lifecycle, "active");
    const leafBranchA = session.getLeafId();

    // 3. Fork Branch B from forkPointLeafId (before Branch A's step transitions & completion)
    session.setLeafId(forkPointLeafId);

    // Switch registry to Branch B
    registry.refresh();

    // Verify run state on Branch B right after forking
    const runOnB = registry.requireRun("run-root");
    assert.equal(runOnB.lifecycle, "active");
    assert.equal(runOnB.step, "ROOT_STEP");
    assert.equal(registry.hasRun("run-branch-a-2"), false); // run2 does not exist on branch B!

    // On Branch B, pause run-root
    registry.pauseRun(runOnB.id, {
      reason: "Paused on Branch B",
      data: { branch: "B" },
    });

    // Since run-root is paused (nonterminal) on Branch B and maxRuns: 1, creating a new run fails
    assert.throws(
      () => registry.createRun(def, { runId: "run-branch-b-attempt" }),
      (err) => err instanceof WorkflowConcurrencyError && err.activeRunIds.includes("run-root")
    );
    const leafBranchB = session.getLeafId();

    // 4. Verify Branch A again
    session.setLeafId(leafBranchA);
    registry.refresh();

    const run1OnA = registry.requireRun("run-root");
    assert.equal(run1OnA.lifecycle, "completed");
    assert.equal(run1OnA.step, "STEP_BRANCH_A");
    assert.equal(run1OnA.data.branch, "A");
    assert.equal(run1OnA.data.branchACompleted, true);
    assert.equal(run1OnA.completion?.summary, "Completed on Branch A");

    const run2OnA = registry.requireRun("run-branch-a-2");
    assert.equal(run2OnA.lifecycle, "active");

    // 5. Verify Branch B again
    session.setLeafId(leafBranchB);
    registry.refresh();

    const run1OnB = registry.requireRun("run-root");
    assert.equal(run1OnB.lifecycle, "paused");
    assert.equal(run1OnB.step, "ROOT_STEP");
    assert.equal(run1OnB.data.branch, "B");
    assert.equal(run1OnB.data.branchACompleted, undefined);
    assert.equal(run1OnB.completion, undefined); // Branch A completion did NOT leak into Branch B!
    assert.equal(registry.hasRun("run-branch-a-2"), false);

    // 6. Abandoned branch C test
    session.setLeafId(forkPointLeafId);
    registry.refresh();
    registry.cancelRun("run-root", { reason: "Abandoned test in branch C" });
    const leafBranchC = session.getLeafId();

    // Navigate to Branch A: completely unaffected by Branch C
    session.setLeafId(leafBranchA);
    registry.refresh();
    assert.equal(registry.requireRun("run-root").lifecycle, "completed");

    // Navigate to Branch B: completely unaffected by Branch C
    session.setLeafId(leafBranchB);
    registry.refresh();
    assert.equal(registry.requireRun("run-root").lifecycle, "paused");
  });

  it("repaints the aggregate status line per branch and clears on a branch with zero nonterminal runs (issue #10)", () => {
    const session = new FakeSessionManager();
    const registry = new WorkflowRunRegistry(session);
    const adapter = new LoopSchedulerAdapter({
      registry,
      dispatcher: new WorkflowDispatcher(registry),
    });
    const ui = new BranchStatusUI();
    const controller = new WorkflowStatusController({ registry, adapter });
    controller.attach(ui);

    const emptyLeaf = session.getLeafId(); // branch point with zero workflow runs
    const def = parseWorkflowContent(sampleDoc, { path: "/test/branch.md", scope: "project" });
    const run = registry.createRun(def, { runId: "run-status" });
    const runLeaf = session.getLeafId();
    controller.paintNow();
    assert.match(ui.lastText() ?? "", /◇ 1 workflow · 1 active/);

    // Switch to the empty branch: the dedicated key is cleared.
    session.setLeafId(emptyLeaf);
    registry.refresh();
    controller.paintNow();
    assert.equal(ui.lastText(), undefined);

    // Back to the run branch: the line is restored.
    session.setLeafId(runLeaf);
    registry.refresh();
    controller.paintNow();
    assert.match(ui.lastText() ?? "", /◇ 1 workflow · 1 active/);

    // Cancelling on this branch clears again.
    registry.cancelRun(run.id, { reason: "done" });
    controller.paintNow();
    assert.equal(ui.lastText(), undefined);
  });
});
