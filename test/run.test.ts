import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowContent } from "../src/parser.ts";
import { createWorkflowSnapshot } from "../src/snapshot.ts";
import {
  applyBlockRun,
  applyCancelRun,
  applyCompleteRun,
  applyPauseRun,
  applyResumeRun,
  applyRunUpdate,
  applyStepTransition,
  createWorkflowRun,
  isTerminalLifecycle,
} from "../src/run.ts";
import { WorkflowInvalidTransitionError, WorkflowRunError } from "../src/types.ts";

describe("WorkflowRun & Lifecycle Transitions", () => {
  const sampleDoc = `---
name: lifecycle-test
description: Lifecycle and step transition tests.
mode: self-paced
---
# Policy Body
Execute steps sequentially.
`;

  function createTestSnapshot() {
    const def = parseWorkflowContent(sampleDoc, {
      path: "/test/workflow.md",
      scope: "project",
    });
    return createWorkflowSnapshot(def);
  }

  it("creates a run with active lifecycle, initial step, and default counters", () => {
    const snapshot = createTestSnapshot();
    const run = createWorkflowRun({
      snapshot,
      initialStep: "STEP_1",
      initialData: { foo: "bar" },
      loopTaskId: "task-123",
    });

    assert(run.id.startsWith("wfrun-lifecycle-test-"));
    assert.equal(run.workflow, "lifecycle-test");
    assert.equal(run.lifecycle, "active");
    assert.equal(run.step, "STEP_1");
    assert.deepEqual(run.data, { foo: "bar" });
    assert.equal(run.loopTaskId, "task-123");
    assert.equal(run.attempts, 0);
    assert.equal(run.turns, 0);
    assert.equal(run.startedAt, run.createdAt);
    assert.equal(run.completedAt, undefined);
    assert.equal(run.blocker, undefined);
    assert.equal(run.completion, undefined);
    assert.equal(isTerminalLifecycle(run.lifecycle), false);
  });

  it("updates data, step, counters, and loopTaskId on active run", () => {
    const snapshot = createTestSnapshot();
    const run1 = createWorkflowRun({ snapshot, initialStep: "STEP_1" });

    const run2 = applyRunUpdate(run1, {
      data: { count: 1 },
      incrementAttempts: 1,
      incrementTurns: 2,
      step: "STEP_2",
      loopTaskId: "task-456",
    });

    assert.equal(run2.step, "STEP_2");
    assert.deepEqual(run2.data, { count: 1 });
    assert.equal(run2.attempts, 1);
    assert.equal(run2.turns, 2);
    assert.equal(run2.loopTaskId, "task-456");

    // Merging additional data
    const run3 = applyRunUpdate(run2, {
      data: { extra: true },
      incrementTurns: 1,
    });
    assert.deepEqual(run3.data, { count: 1, extra: true });
    assert.equal(run3.turns, 3);
  });

  it("advances step via applyStepTransition on active run", () => {
    const snapshot = createTestSnapshot();
    const run1 = createWorkflowRun({ snapshot, initialStep: "INITIAL" });

    const run2 = applyStepTransition(run1, {
      toStep: "IMPLEMENTING",
      data: { status: "in_progress" },
      reason: "Claimed task",
    });

    assert.equal(run2.step, "IMPLEMENTING");
    assert.equal(run2.lifecycle, "active");
    assert.deepEqual(run2.data, { status: "in_progress" });
  });

  it("supports active -> paused -> active cycle", () => {
    const snapshot = createTestSnapshot();
    const run1 = createWorkflowRun({ snapshot });

    const paused = applyPauseRun(run1, { reason: "User requested pause" });
    assert.equal(paused.lifecycle, "paused");

    const resumed = applyResumeRun(paused, { reason: "User resumed" });
    assert.equal(resumed.lifecycle, "active");
  });

  it("supports active -> blocked -> active cycle and clears blocker info upon resume", () => {
    const snapshot = createTestSnapshot();
    const run1 = createWorkflowRun({ snapshot });

    const blocked = applyBlockRun(run1, {
      reason: "Waiting for PR review",
      requiresHuman: true,
      data: { pr: 42 },
    });
    assert.equal(blocked.lifecycle, "blocked");
    assert.equal(blocked.blocker?.reason, "Waiting for PR review");
    assert.equal(blocked.blocker?.requiresHuman, true);
    assert(blocked.blocker?.blockedAt! > 0);

    const resumed = applyResumeRun(blocked, { step: "REVIEWED" });
    assert.equal(resumed.lifecycle, "active");
    assert.equal(resumed.step, "REVIEWED");
    assert.equal(resumed.blocker, undefined);
    assert.deepEqual(resumed.data, { pr: 42 });
  });

  it("supports active -> completed (terminal state) with evidence and summary", () => {
    const snapshot = createTestSnapshot();
    const run1 = createWorkflowRun({ snapshot });

    const completed = applyCompleteRun(run1, {
      summary: "Implemented issue and verified passing tests",
      evidence: [
        { type: "pr", description: "Pull request opened", url: "https://github.com/org/repo/pull/1" },
        { type: "test", description: "Unit tests passed: 42/42" },
      ],
      data: { outcome: "success" },
    });

    assert.equal(completed.lifecycle, "completed");
    assert.equal(isTerminalLifecycle(completed.lifecycle), true);
    assert.equal(completed.completion?.summary, "Implemented issue and verified passing tests");
    assert.equal(completed.completion?.evidence.length, 2);
    assert(completed.completedAt! > 0);
  });

  it("supports active -> cancelled and paused -> cancelled", () => {
    const snapshot = createTestSnapshot();
    const run1 = createWorkflowRun({ snapshot });

    const cancelled1 = applyCancelRun(run1, { reason: "Aborted by user" });
    assert.equal(cancelled1.lifecycle, "cancelled");
    assert.equal(isTerminalLifecycle(cancelled1.lifecycle), true);

    const run2 = createWorkflowRun({ snapshot });
    const paused = applyPauseRun(run2);
    const cancelled2 = applyCancelRun(paused, { reason: "Cancelled while paused" });
    assert.equal(cancelled2.lifecycle, "cancelled");
  });

  it("rejects invalid lifecycle transitions with WorkflowInvalidTransitionError", () => {
    const snapshot = createTestSnapshot();
    const run = createWorkflowRun({ snapshot });

    // Cannot resume an active run
    assert.throws(
      () => applyResumeRun(run),
      (err) => err instanceof WorkflowInvalidTransitionError && err.toLifecycle === "active"
    );

    // Cannot pause an already paused run
    const paused = applyPauseRun(run);
    assert.throws(
      () => applyPauseRun(paused),
      (err) => err instanceof WorkflowInvalidTransitionError && err.fromLifecycle === "paused"
    );

    // Cannot step transition on a paused run
    assert.throws(
      () => applyStepTransition(paused, { toStep: "NEXT" }),
      (err) => err instanceof WorkflowInvalidTransitionError && err.fromLifecycle === "paused"
    );

    // Cannot complete a paused run without resuming first
    assert.throws(
      () => applyCompleteRun(paused, { summary: "Done" }),
      (err) => err instanceof WorkflowInvalidTransitionError
    );

    // Complete run
    const activeAgain = applyResumeRun(paused);
    const completed = applyCompleteRun(activeAgain, { summary: "Finished" });

    // Terminal run cannot be modified or transitioned
    assert.throws(
      () => applyRunUpdate(completed, { step: "TRY_AGAIN" }),
      (err) => err instanceof WorkflowInvalidTransitionError && err.fromLifecycle === "completed"
    );
    assert.throws(
      () => applyPauseRun(completed),
      (err) => err instanceof WorkflowInvalidTransitionError
    );
    assert.throws(
      () => applyBlockRun(completed, { reason: "Blocked" }),
      (err) => err instanceof WorkflowInvalidTransitionError
    );
    assert.throws(
      () => applyResumeRun(completed),
      (err) => err instanceof WorkflowInvalidTransitionError
    );
    assert.throws(
      () => applyCompleteRun(completed, { summary: "Already done" }),
      (err) => err instanceof WorkflowInvalidTransitionError
    );
    assert.throws(
      () => applyCancelRun(completed),
      (err) => err instanceof WorkflowInvalidTransitionError
    );
  });
});
