import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowContent } from "../src/parser.ts";
import { WorkflowRunRegistry } from "../src/registry.ts";
import { WorkflowDispatcher } from "../src/dispatcher.ts";
import { createWorkflowGetContextTool } from "../src/tools.ts";
import { WorkflowIterationError } from "../src/types.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

const WORKFLOW_DEF = `---
name: context-test-wf
description: Test workflow for iteration context inspection.
mode: self-paced

budget:
  maxTurns: 20
  maxAttempts: 5
  maxDuration: 2h
  maxCost: 10.5

wakeups:
  default: 5m
  min: 1m
  max: 30m
  named:
    idle: 15m
    retry: 2m

requires:
  - git
  - tmux
  - docker

completion:
  requireSummary: true
  requireEvidence: true
  verify: true
---

# Policy Body
Ensure context fields are surfaced accurately.
`;

describe("Workflow Iteration Context Inspection", () => {
  function setup() {
    const session = new FakeSessionManager();
    const registry = new WorkflowRunRegistry(session);
    const dispatcher = new WorkflowDispatcher(registry);
    const getContextTool = createWorkflowGetContextTool(dispatcher, registry);

    const def = parseWorkflowContent(WORKFLOW_DEF, {
      path: "/workflows/context-test.md",
      scope: "project",
    });

    const run = registry.createRun(def, {
      initialStep: "STEP_A",
      initialData: { foo: "bar", count: 42 },
      loopTaskId: "internal-scheduler-task-999",
    });

    return { session, registry, dispatcher, getContextTool, run };
  }

  it("returns complete model context for the active run and hides internal loopTaskId", async () => {
    const { registry, dispatcher, getContextTool, run } = setup();

    const ac = new AbortController();
    // Begin iteration with git and tmux available, docker missing, and turn signal bound
    const binding = dispatcher.beginIteration(run.id, {
      capabilities: ["git", "tmux"],
      signal: ac.signal,
      incrementTurns: false,
    });

    const result = await getContextTool.execute("call-1", {}, ac.signal, undefined, {} as any);

    assert(result.content && result.content[0]);
    assert.equal(result.content[0].type, "text");

    const details: any = result.details;
    assert.equal(details.runId, run.id);
    assert.equal(details.workflow, "context-test-wf");
    assert.equal(details.lifecycle, "active");
    assert.equal(details.step, "STEP_A");
    assert.deepEqual(details.data, { foo: "bar", count: 42 });

    // Counters and budget
    assert.equal(details.turns, 0);
    assert.equal(details.attempts, 0);
    assert.equal(details.budget.maxTurns, 20);
    assert.equal(details.budget.turnsRemaining, 20);
    assert.equal(details.budget.maxAttempts, 5);
    assert.equal(details.budget.attemptsRemaining, 5);
    assert.equal(details.budget.maxDuration, "2h");
    assert(details.budget.durationRemainingMs !== undefined && details.budget.durationRemainingMs > 0);
    assert.equal(details.budget.maxCost, 10.5);

    // Definition metadata
    assert.equal(details.definition.name, "context-test-wf");
    assert.equal(details.definition.mode, "self-paced");
    assert.equal(details.definition.source, "/workflows/context-test.md");

    // Capabilities availability
    assert.deepEqual(details.requires, ["git", "tmux", "docker"]);
    assert.equal(details.capabilities.git, true);
    assert.equal(details.capabilities.tmux, true);
    assert.equal(details.capabilities.docker, false);

    // Wakeup policy
    assert.equal(details.wakeups.default, "5m");
    assert.equal(details.wakeups.min, "1m");
    assert.equal(details.wakeups.max, "30m");
    assert.deepEqual(details.wakeups.named, { idle: "15m", retry: "2m" });

    // Completion policy
    assert.equal(details.completion.requireSummary, true);
    assert.equal(details.completion.requireEvidence, true);
    assert.equal(details.completion.verify, true);

    // Boundary: internal loopTaskId must NEVER be exposed in model context
    assert.equal((details as any).loopTaskId, undefined);
    assert(!JSON.stringify(details).includes("internal-scheduler-task-999"));
  });

  it("calculates budget remaining accurately as turns and duration advance", async () => {
    const { registry, dispatcher, run } = setup();

    // Advance turns and attempts
    registry.updateRun(run.id, { turns: 12, attempts: 2 });

    const binding = dispatcher.beginIteration(run.id, { incrementTurns: false });
    const now = run.createdAt + 30 * 60 * 1000; // 30 minutes later

    const ctx = dispatcher.getIterationContext(binding, now);

    assert.equal(ctx.turns, 12);
    assert.equal(ctx.budget.turnsRemaining, 8); // 20 - 12
    assert.equal(ctx.attempts, 2);
    assert.equal(ctx.budget.attemptsRemaining, 3); // 5 - 2
    assert.equal(ctx.budget.durationRemainingMs, 90 * 60 * 1000); // 2h - 30m = 90m
  });

  it("fails closed when called outside an active iteration", async () => {
    const { getContextTool } = setup();

    const ac = new AbortController();
    await assert.rejects(
      async () => {
        await getContextTool.execute("call-outside", {}, ac.signal, undefined, {} as any);
      },
      (err: any) => {
        assert(err instanceof WorkflowIterationError);
        assert.match(err.message, /no workflow iteration is currently active/i);
        return true;
      }
    );
  });

  it("regression: fails closed when active iteration has no turn-bound signal", async () => {
    const { dispatcher, getContextTool, run } = setup();

    // Dispatched without signal
    dispatcher.beginIteration(run.id, { incrementTurns: false });

    const ac = new AbortController();
    await assert.rejects(
      async () => {
        await getContextTool.execute("call-no-bound-sig", {}, ac.signal, undefined, {} as any);
      },
      (err: any) => {
        assert(err instanceof WorkflowIterationError);
        assert.match(err.message, /turn-bound AbortSignal is required/i);
        return true;
      }
    );
  });

  it("regression: fails closed when tool invocation does not supply a signal", async () => {
    const { dispatcher, getContextTool, run } = setup();

    const ac = new AbortController();
    dispatcher.beginIteration(run.id, { signal: ac.signal, incrementTurns: false });

    // Invocation without signal
    await assert.rejects(
      async () => {
        await getContextTool.execute("call-no-sig", {}, undefined, undefined, {} as any);
      },
      (err: any) => {
        assert(err instanceof WorkflowIterationError);
        assert.match(err.message, /tool invocation did not receive an AbortSignal/i);
        return true;
      }
    );
  });

  it("regression: fails closed when invocation signal does not match turn-bound signal", async () => {
    const { dispatcher, getContextTool, run } = setup();

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    dispatcher.beginIteration(run.id, { signal: ac1.signal, incrementTurns: false });

    await assert.rejects(
      async () => {
        await getContextTool.execute("call-mismatched-sig", {}, ac2.signal, undefined, {} as any);
      },
      (err: any) => {
        assert(err instanceof WorkflowIterationError);
        assert.match(err.message, /tool call signal does not match the active iteration signal/i);
        return true;
      }
    );
  });

  it("fails closed when iteration has been aborted", async () => {
    const { dispatcher, getContextTool, run } = setup();

    const ac = new AbortController();
    dispatcher.beginIteration(run.id, { signal: ac.signal, incrementTurns: false });

    // Abort turn
    ac.abort();

    await assert.rejects(
      async () => {
        await getContextTool.execute("call-aborted", {}, ac.signal, undefined, {} as any);
      },
      (err: any) => {
        assert(err instanceof WorkflowIterationError);
        assert.match(err.message, /aborted/i);
        return true;
      }
    );
  });
});
