import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowContent } from "../src/parser.ts";
import { WorkflowRunRegistry } from "../src/registry.ts";
import { WorkflowDispatcher } from "../src/dispatcher.ts";
import {
  createWorkflowBlockTool,
  createWorkflowCompleteTool,
  createWorkflowContinueTool,
  createWorkflowTransitionTool,
  createWorkflowVerifyTool,
} from "../src/tools.ts";
import {
  type WorkflowScheduleWakeupParams,
  type WorkflowSchedulerPort,
  WorkflowDataBoundsError,
  WorkflowInvalidTransitionError,
  WorkflowRunError,
} from "../src/types.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

const WORKFLOW_WITH_POLICIES = `---
name: lifecycle-test-wf
description: Test workflow for lifecycle operations and transitions.
mode: self-paced

concurrency:
  maxRuns: 2

budget:
  maxTurns: 10
  maxAttempts: 3

wakeups:
  default: 5m
  min: 30s
  max: 1h
  named:
    idle: 15m
    retry: 1m
    fast: 10s

requires:
  - loop

completion:
  requireSummary: true
  requireEvidence: true
  verify: true
---

# Policy Body
Test transitions, continuations, blocking, and completion.
`;

describe("Workflow Model-Callable Lifecycle Tools", () => {
  class MockSchedulerPort implements WorkflowSchedulerPort {
    scheduled: WorkflowScheduleWakeupParams[] = [];
    cancelled: string[] = [];

    async scheduleWakeup(params: WorkflowScheduleWakeupParams): Promise<void> {
      this.scheduled.push(params);
    }

    async cancelWakeup(runId: string): Promise<void> {
      this.cancelled.push(runId);
    }
  }

  function setup() {
    const session = new FakeSessionManager();
    const registry = new WorkflowRunRegistry(session);
    const dispatcher = new WorkflowDispatcher(registry);
    const schedulerPort = new MockSchedulerPort();
    const ac = new AbortController();

    const transitionTool = createWorkflowTransitionTool(dispatcher, registry);
    const continueTool = createWorkflowContinueTool(dispatcher, registry);
    const blockTool = createWorkflowBlockTool(dispatcher, registry);
    const completeTool = createWorkflowCompleteTool(dispatcher, registry);
    const verifyTool = createWorkflowVerifyTool(dispatcher, registry);

    const def = parseWorkflowContent(WORKFLOW_WITH_POLICIES, {
      path: "/workflows/lifecycle-test.md",
      scope: "project",
    });

    const run = registry.createRun(def, {
      initialStep: "START",
      initialData: { counter: 0 },
    });

    return {
      session,
      registry,
      dispatcher,
      schedulerPort,
      transitionTool,
      continueTool,
      blockTool,
      completeTool,
      verifyTool,
      run,
      ac,
    };
  }

  describe("workflow_transition", () => {
    it("atomically advances step, merges data, and persists to sessionTarget", async () => {
      const { session, registry, dispatcher, transitionTool, run, ac } = setup();

      dispatcher.beginIteration(run.id, { signal: ac.signal, incrementTurns: false });

      const result = await transitionTool.execute(
        "call-t1",
        {
          toStep: "IMPLEMENTING",
          data: { counter: 1, file: "src/index.ts" },
          reason: "Beginning implementation phase",
        },
        ac.signal,
        undefined,
        {} as any
      );

      const details = result.details as any;
      assert.equal(details.toStep, "IMPLEMENTING");
      assert.equal(details.fromStep, "START");

      // Verify in-memory state updated
      const updated = registry.requireRun(run.id);
      assert.equal(updated.step, "IMPLEMENTING");
      assert.deepEqual(updated.data, { counter: 1, file: "src/index.ts" });

      // Verify persisted to session entries immediately
      const entries = session.getBranch();
      const transitionEntry = entries.find(
        (e: any) => e.data?.action === "transition" && e.data?.runId === run.id
      );
      assert(transitionEntry);
      const payload = (transitionEntry.data as any).payload;
      assert.equal(payload.toStep, "IMPLEMENTING");
      assert.equal(payload.reason, "Beginning implementation phase");
    });

    it("rejects invalid step names with WorkflowDataBoundsError", async () => {
      const { dispatcher, transitionTool, run, ac } = setup();

      dispatcher.beginIteration(run.id, { signal: ac.signal, incrementTurns: false });

      await assert.rejects(
        async () => {
          await transitionTool.execute(
            "call-t2",
            { toStep: "INVALID\nSTEP" },
            ac.signal,
            undefined,
            {} as any
          );
        },
        (err: any) => {
          assert(err instanceof WorkflowDataBoundsError);
          return true;
        }
      );
    });

    it("rejects invalid JSON run data bounds", async () => {
      const { dispatcher, transitionTool, run, ac } = setup();

      dispatcher.beginIteration(run.id, { signal: ac.signal, incrementTurns: false });

      await assert.rejects(
        async () => {
          await transitionTool.execute(
            "call-t3",
            {
              toStep: "VALID_STEP",
              data: { invalidValue: NaN as any },
            },
            ac.signal,
            undefined,
            {} as any
          );
        },
        (err: any) => {
          assert(err instanceof WorkflowDataBoundsError);
          return true;
        }
      );
    });

    it("rejects step transition when run is not in active lifecycle", async () => {
      const { registry, dispatcher, transitionTool, run } = setup();

      // Pause run first
      registry.pauseRun(run.id, { reason: "Waiting on external input" });

      // Begin iteration should fail on non-active run
      assert.throws(
        () => dispatcher.beginIteration(run.id),
        (err: any) => {
          assert(err instanceof WorkflowInvalidTransitionError);
          return true;
        }
      );
    });
  });

  describe("workflow_continue", () => {
    it("resolves named wakeup delay and calls schedulerPort with current run ID", async () => {
      const { dispatcher, schedulerPort, continueTool, run, ac } = setup();

      dispatcher.beginIteration(run.id, { schedulerPort, signal: ac.signal, incrementTurns: false });

      const result = await continueTool.execute(
        "call-c1",
        {
          wakeupName: "idle",
          reason: "Waiting for next polling period",
        },
        ac.signal,
        undefined,
        {} as any
      );

      const details = result.details as any;
      assert.equal(details.delayMs, 15 * 60 * 1000);
      assert.equal(details.source, "named");
      assert.equal(details.runId, run.id);

      assert.equal(schedulerPort.scheduled.length, 1);
      assert.equal(schedulerPort.scheduled[0].runId, run.id);
      assert.equal(schedulerPort.scheduled[0].delayMs, 15 * 60 * 1000);
      assert.equal(schedulerPort.scheduled[0].reason, "Waiting for next polling period");
    });

    it("resolves explicit delay duration string", async () => {
      const { dispatcher, schedulerPort, continueTool, run, ac } = setup();

      dispatcher.beginIteration(run.id, { schedulerPort, signal: ac.signal, incrementTurns: false });

      const result = await continueTool.execute(
        "call-c2",
        { delay: "10m", reason: "Quick retry" },
        ac.signal,
        undefined,
        {} as any
      );

      const details = result.details as any;
      assert.equal(details.delayMs, 10 * 60 * 1000);
      assert.equal(details.source, "explicit");
      assert.equal(schedulerPort.scheduled.length, 1);
      assert.equal(schedulerPort.scheduled[0].delayMs, 10 * 60 * 1000);
    });

    it("resolves default delay when neither delay nor wakeupName is provided", async () => {
      const { dispatcher, schedulerPort, continueTool, run, ac } = setup();

      dispatcher.beginIteration(run.id, { schedulerPort, signal: ac.signal, incrementTurns: false });

      const result = await continueTool.execute("call-c3", {}, ac.signal, undefined, {} as any);

      const details = result.details as any;
      assert.equal(details.delayMs, 5 * 60 * 1000); // 5m default from definition
      assert.equal(details.source, "default");
      assert.equal(schedulerPort.scheduled.length, 1);
      assert.equal(schedulerPort.scheduled[0].delayMs, 5 * 60 * 1000);
    });

    it("clamps delay against min and max policy bounds", async () => {
      const { dispatcher, schedulerPort, continueTool, run, ac } = setup();

      dispatcher.beginIteration(run.id, { schedulerPort, signal: ac.signal, incrementTurns: false });

      // 'fast' is 10s, min bound in wakeups policy is 30s
      const resultMin = await continueTool.execute(
        "call-c4",
        { wakeupName: "fast" },
        ac.signal,
        undefined,
        {} as any
      );

      const detailsMin = resultMin.details as any;
      assert.equal(detailsMin.isClamped, true);
      assert.equal(detailsMin.delayMs, 30 * 1000); // Clamped to min 30s

      // Delay 2h, max bound in wakeups policy is 1h
      const resultMax = await continueTool.execute(
        "call-c5",
        { delay: "2h" },
        ac.signal,
        undefined,
        {} as any
      );

      const detailsMax = resultMax.details as any;
      assert.equal(detailsMax.isClamped, true);
      assert.equal(detailsMax.delayMs, 60 * 60 * 1000); // Clamped to max 1h
    });

    it("throws on unknown named wakeup", async () => {
      const { dispatcher, schedulerPort, continueTool, run, ac } = setup();

      dispatcher.beginIteration(run.id, { schedulerPort, signal: ac.signal, incrementTurns: false });

      await assert.rejects(
        async () => {
          await continueTool.execute(
            "call-c6",
            { wakeupName: "nonexistent" },
            ac.signal,
            undefined,
            {} as any
          );
        },
        (err: any) => {
          assert(err instanceof WorkflowRunError);
          assert.match(err.message, /unknown named wakeup/i);
          return true;
        }
      );
    });

    it("throws when scheduler port is not configured", async () => {
      const { dispatcher, continueTool, run, ac } = setup();

      // Begin iteration without schedulerPort
      dispatcher.beginIteration(run.id, { signal: ac.signal, incrementTurns: false });

      await assert.rejects(
        async () => {
          await continueTool.execute("call-c7", {}, ac.signal, undefined, {} as any);
        },
        (err: any) => {
          assert(err instanceof WorkflowRunError);
          assert.match(err.message, /no scheduler port is configured/i);
          return true;
        }
      );
    });

    it("rejects continue if run is blocked or terminal", async () => {
      const { registry, dispatcher, schedulerPort, continueTool, run } = setup();

      registry.blockRun(run.id, { reason: "Dependency failure" });

      // Run is now blocked
      // beginIteration fails on non-active run
      assert.throws(
        () => dispatcher.beginIteration(run.id, { schedulerPort }),
        (err: any) => {
          assert(err instanceof WorkflowInvalidTransitionError);
          return true;
        }
      );
    });
  });

  describe("workflow_block", () => {
    it("moves run to blocked, records reason, cancels scheduled wakeup, and persists", async () => {
      const { session, registry, dispatcher, schedulerPort, blockTool, continueTool, run, ac } = setup();

      dispatcher.beginIteration(run.id, { schedulerPort, signal: ac.signal, incrementTurns: false });

      const result = await blockTool.execute(
        "call-b1",
        {
          reason: "Waiting for human approval on deployment",
          requiresHuman: true,
          data: { blockedStep: "DEPLOY" },
        },
        ac.signal,
        undefined,
        {} as any
      );

      const details = result.details as any;
      assert.equal(details.lifecycle, "blocked");
      assert.equal(details.blocker.reason, "Waiting for human approval on deployment");
      assert.equal(details.blocker.requiresHuman, true);

      // Verify in registry
      const blocked = registry.requireRun(run.id);
      assert.equal(blocked.lifecycle, "blocked");
      assert.equal(blocked.blocker?.reason, "Waiting for human approval on deployment");
      assert.equal(blocked.blocker?.requiresHuman, true);

      // Verify schedulerPort.cancelWakeup was invoked
      assert(schedulerPort.cancelled.includes(run.id));

      // Verify persisted to session entries
      const entries = session.getBranch();
      const blockEntry = entries.find(
        (e: any) => e.data?.action === "block" && e.data?.runId === run.id
      );
      assert(blockEntry);
      const payload = (blockEntry.data as any).payload;
      assert.equal(payload.reason, "Waiting for human approval on deployment");

      // A blocked run cannot continue scheduling
      await assert.rejects(
        async () => {
          await continueTool.execute("call-c-blocked", {}, ac.signal, undefined, {} as any);
        },
        (err: any) => {
          assert(err instanceof WorkflowInvalidTransitionError);
          return true;
        }
      );
    });

    it("rejects blocking an already completed run", async () => {
      const { registry, dispatcher, schedulerPort, blockTool, run } = setup();

      // Complete run directly in registry
      registry.completeRun(run.id, {
        summary: "Done",
        evidence: [{ type: "test", description: "all passed" }],
      });

      // Assert beginIteration fails on terminal run
      assert.throws(
        () => dispatcher.beginIteration(run.id, { schedulerPort }),
        (err: any) => {
          assert(err instanceof WorkflowInvalidTransitionError);
          return true;
        }
      );
    });
  });

  describe("workflow_complete", () => {
    it("enters verification phase when definition specifies completion.verify: true", async () => {
      const { registry, dispatcher, schedulerPort, completeTool, verifyTool, run, ac } = setup();

      dispatcher.beginIteration(run.id, { schedulerPort, signal: ac.signal, incrementTurns: false });

      // First call to complete when verify is true
      const result = await completeTool.execute(
        "call-comp1",
        {
          summary: "Implementation finished, ready for verification",
          evidence: [{ type: "commit", description: "git commit abc1234" }],
        },
        ac.signal,
        undefined,
        {} as any
      );

      const details1 = result.details as any;
      assert.equal(details1.status, "verifying");
      assert.equal(details1.step, "VERIFYING");

      const inVerify = registry.requireRun(run.id);
      assert.equal(inVerify.step, "VERIFYING");
      assert.equal(inVerify.lifecycle, "verifying");
      assert.equal(inVerify.data._verificationRequested, true);

      // Calling completeTool again while in VERIFYING step must fail closed to prevent gate bypass
      await assert.rejects(
        async () => {
          await completeTool.execute(
            "call-comp2",
            { summary: "Trying to complete while verifying" },
            ac.signal,
            undefined,
            {} as any
          );
        },
        (err: any) => {
          assert(err instanceof WorkflowRunError);
          assert.match(err.message, /currently in the verification phase/);
          return true;
        }
      );

      // Explicit verifier decision via workflow_verify completes the run
      const finalResult = await verifyTool.execute(
        "call-comp-verify",
        {
          decision: "accept",
          findings: "Verification passed with all checks green",
        },
        ac.signal,
        undefined,
        {} as any
      );

      const finalDetails = finalResult.details as any;
      assert.equal(finalDetails.status, "completed");
      assert.equal(finalDetails.lifecycle, "completed");

      const completed = registry.requireRun(run.id);
      assert.equal(completed.lifecycle, "completed");
      assert.equal(completed.completion?.summary, "Implementation finished, ready for verification");

      // Verify schedulerPort.cancelWakeup was invoked
      assert(schedulerPort.cancelled.includes(run.id));
    });

    it("enforces requireEvidence: true from completion policy", async () => {
      const { dispatcher, schedulerPort, completeTool, run, ac } = setup();

      dispatcher.beginIteration(run.id, { schedulerPort, signal: ac.signal, incrementTurns: false });

      // Omit evidence when policy requires it
      await assert.rejects(
        async () => {
          await completeTool.execute(
            "call-comp3",
            { summary: "Finished without evidence" },
            ac.signal,
            undefined,
            {} as any
          );
        },
        (err: any) => {
          assert(err instanceof WorkflowRunError);
          assert.match(err.message, /requires at least one evidence item/i);
          return true;
        }
      );
    });

    it("rejects completion of an already completed run", async () => {
      const { registry, dispatcher, schedulerPort, completeTool, verifyTool, run, ac } = setup();

      dispatcher.beginIteration(run.id, { schedulerPort, signal: ac.signal, incrementTurns: false });

      // First submit claim for verification
      await completeTool.execute(
        "call-comp4",
        { summary: "Verify", evidence: [{ type: "t", description: "d" }] },
        ac.signal,
        undefined,
        {} as any
      );
      // Verify and accept claim to complete run
      await verifyTool.execute(
        "call-comp5",
        { decision: "accept", findings: "Done" },
        ac.signal,
        undefined,
        {} as any
      );

      // Third call when already completed
      await assert.rejects(
        async () => {
          await completeTool.execute(
            "call-comp6",
            { summary: "Again", evidence: [{ type: "t", description: "d" }] },
            ac.signal,
            undefined,
            {} as any
          );
        },
        (err: any) => {
          assert(err instanceof WorkflowInvalidTransitionError);
          return true;
        }
      );
    });
  });
});
