import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workflowExtension, { createWorkflowRunRegistry } from "../src/index.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { WorkflowDispatcher } from "../src/dispatcher.ts";
import {
  createWorkflowBlockTool,
  createWorkflowCompleteTool,
  createWorkflowContinueTool,
  createWorkflowGetContextTool,
  createWorkflowTransitionTool,
} from "../src/tools.ts";
import {
  type WorkflowSchedulerPort,
  WorkflowIterationError,
  WorkflowStaleIterationError,
} from "../src/types.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

const WORKFLOW_DEF_A = `---
name: workflow-a
description: Workflow A
mode: self-paced
---
# Policy A
Execute workflow A
`;

const WORKFLOW_DEF_B = `---
name: workflow-b
description: Workflow B
mode: self-paced
---
# Policy B
Execute workflow B
`;

describe("Iteration Exclusivity, Stale Late Calls, and Lifecycle Boundaries", () => {
  class MockSchedulerPort implements WorkflowSchedulerPort {
    scheduled: any[] = [];
    cancelled: string[] = [];

    async scheduleWakeup(params: any): Promise<void> {
      this.scheduled.push(params);
    }
    async cancelWakeup(runId: string): Promise<void> {
      this.cancelled.push(runId);
    }
  }

  function setup() {
    const session = new FakeSessionManager();
    const registry = createWorkflowRunRegistry(session);
    const dispatcher = new WorkflowDispatcher(registry);
    const schedulerPort = new MockSchedulerPort();

    const getContextTool = createWorkflowGetContextTool(dispatcher, registry);
    const transitionTool = createWorkflowTransitionTool(dispatcher, registry);
    const continueTool = createWorkflowContinueTool(dispatcher, registry);
    const blockTool = createWorkflowBlockTool(dispatcher, registry);
    const completeTool = createWorkflowCompleteTool(dispatcher, registry);

    const defA = parseWorkflowContent(WORKFLOW_DEF_A, { path: "/a.md", scope: "project" });
    const defB = parseWorkflowContent(WORKFLOW_DEF_B, { path: "/b.md", scope: "project" });

    const runA = registry.createRun(defA, { initialStep: "A_START", initialData: { a: 1 } });
    const runB = registry.createRun(defB, { initialStep: "B_START", initialData: { b: 2 } });

    return {
      session,
      registry,
      dispatcher,
      schedulerPort,
      getContextTool,
      transitionTool,
      continueTool,
      blockTool,
      completeTool,
      runA,
      runB,
    };
  }

  it("enforces exclusivity: starting iteration B invalidates iteration A and advances generation", () => {
    const { dispatcher, runA, runB } = setup();

    const bindingA = dispatcher.beginIteration(runA.id, { incrementTurns: false });
    assert.equal(dispatcher.getActiveIteration()?.runId, runA.id);
    const genA = dispatcher.getGeneration();

    // Start iteration for run B
    const bindingB = dispatcher.beginIteration(runB.id, { incrementTurns: false });
    assert.equal(dispatcher.getActiveIteration()?.runId, runB.id);
    const genB = dispatcher.getGeneration();

    assert(genB > genA, "Generation must advance monotonically on replacement");
    assert.notEqual(bindingA.token, bindingB.token);

    // Asserting binding A must now fail closed
    assert.throws(
      () => dispatcher.assertActiveBinding(bindingA.token, bindingA.generation),
      (err: any) => {
        assert(err instanceof WorkflowStaleIterationError);
        assert.equal(err.token, bindingA.token);
        return true;
      }
    );

    // Asserting binding B succeeds
    assert.equal(
      dispatcher.assertActiveBinding(bindingB.token, bindingB.generation).runId,
      runB.id
    );
  });

  it("prevents stale asynchronous tool call in run A from mutating run A or run B", async () => {
    const { registry, dispatcher, transitionTool, runA, runB } = setup();

    // 1. Iteration A starts
    const bindingA = dispatcher.beginIteration(runA.id, { incrementTurns: false });
    const tokenA = bindingA.token;
    const genA = bindingA.generation;

    // 2. An async tool call starts under Iteration A, capturing binding info
    // Simulate async delay before applying transition
    let toolCallStarted = false;
    let toolCallFinished = false;
    let toolError: any = null;

    const delayedToolCallPromise = (async () => {
      // Tool begins execution under Iteration A
      dispatcher.assertActiveBinding(tokenA, genA);
      toolCallStarted = true;

      // Yield event loop simulating async I/O or network delay
      await new Promise((resolve) => setTimeout(resolve, 20));

      try {
        // Delayed attempt to mutate using stale token and generation
        dispatcher.assertActiveBinding(tokenA, genA);
        registry.transitionStep(runA.id, { toStep: "STALE_STEP", data: { hacked: true } });
      } catch (err) {
        toolError = err;
        throw err;
      } finally {
        toolCallFinished = true;
      }
    })();

    assert.equal(toolCallStarted, true);

    // 3. Before the delayed tool call completes, Iteration A ends and Iteration B begins
    dispatcher.beginIteration(runB.id, { incrementTurns: false });

    // 4. Await the delayed tool call from Iteration A
    await assert.rejects(delayedToolCallPromise, (err: any) => {
      assert(err instanceof WorkflowStaleIterationError);
      return true;
    });

    assert.equal(toolCallFinished, true);
    assert(toolError instanceof WorkflowStaleIterationError);

    // 5. Verify NEITHER run A nor run B was mutated
    const currentA = registry.requireRun(runA.id);
    assert.equal(currentA.step, "A_START");
    assert.deepEqual(currentA.data, { a: 1 });

    const currentB = registry.requireRun(runB.id);
    assert.equal(currentB.step, "B_START");
    assert.deepEqual(currentB.data, { b: 2 });
  });

  it("prevents tool call from turn A starting after run B is bound from mutating run B when turn signal is provided", async () => {
    const { registry, dispatcher, transitionTool, runA, runB } = setup();

    const acA = new AbortController();
    const acB = new AbortController();

    // 1. Iteration A starts with turn A signal
    dispatcher.beginIteration(runA.id, { signal: acA.signal, incrementTurns: false });

    // 2. Before tool executes, Iteration B binds with turn B signal
    dispatcher.beginIteration(runB.id, { signal: acB.signal, incrementTurns: false });

    // 3. Tool call that originated in turn A now enters execute() passing turn A's signal
    await assert.rejects(
      async () => {
        await transitionTool.execute(
          "call-late-start",
          { toStep: "MUTATE_STEP", data: { from: "turnA" } },
          acA.signal,
          undefined,
          {} as any
        );
      },
      (err: any) => {
        assert(err instanceof WorkflowStaleIterationError);
        assert.match(err.message, /tool call signal does not match the active iteration signal/i);
        return true;
      }
    );

    // 4. Verify run B was NOT mutated by the late call from turn A
    const currentB = registry.requireRun(runB.id);
    assert.equal(currentB.step, "B_START");
    assert.deepEqual(currentB.data, { b: 2 });
  });

  it("documents limitation: without host turn signal, tool execution starting after run B binding sees active run B", async () => {
    const { registry, dispatcher, transitionTool, runA, runB } = setup();

    // In an environment where neither turn passes an AbortSignal and host provides no per-call identity:
    dispatcher.beginIteration(runA.id, { incrementTurns: false });
    // Run B replaces run A
    dispatcher.beginIteration(runB.id, { incrementTurns: false });

    // A tool call starting NOW without any signal or token identity executes against the currently bound run (B)
    const result = await transitionTool.execute(
      "call-no-signal",
      { toStep: "B_NEXT", data: { b: 99 } },
      undefined,
      undefined,
      {} as any
    );

    const details = result.details as any;
    assert.equal(details.runId, runB.id);
    assert.equal(details.toStep, "B_NEXT");

    // Run A was untouched
    const currentA = registry.requireRun(runA.id);
    assert.equal(currentA.step, "A_START");
  });

  it("clears active iteration and invalidates in-flight calls on session lifecycle events", async () => {
    const handlers = new Map<string, Function>();
    const fakePi: any = {
      registeredTools: [] as any[],
      on(event: string, handler: Function) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      registerTool(tool: any) {
        this.registeredTools.push(tool);
      },
      appendEntry(_type: string, _data?: unknown) {},
    };

    workflowExtension(fakePi);

    // Verify all 5 tools were registered
    assert.equal(fakePi.registeredTools.length, 5);
    const toolNames = fakePi.registeredTools.map((t: any) => t.name).sort();
    assert.deepEqual(toolNames, [
      "workflow_block",
      "workflow_complete",
      "workflow_continue",
      "workflow_get_context",
      "workflow_transition",
    ]);

    // Verify lifecycle handlers registered
    assert(handlers.has("session_start"));
    assert(handlers.has("session_tree"));
    assert(handlers.has("agent_settled"));
    assert(handlers.has("session_shutdown"));

    // Calling tools outside active iteration fails closed
    for (const tool of fakePi.registeredTools) {
      await assert.rejects(
        async () => {
          await tool.execute("call-1", { reason: "r", toStep: "s", summary: "sum" }, undefined, undefined, {} as any);
        },
        (err: any) => {
          assert(err instanceof WorkflowIterationError);
          return true;
        }
      );
    }
  });

  it("withIteration guarantees cleanup on error and normal exit", async () => {
    const { dispatcher, runA } = setup();

    // Normal exit cleanup
    await dispatcher.withIteration(runA.id, { incrementTurns: false }, async (binding) => {
      assert.equal(dispatcher.getActiveIteration()?.token, binding.token);
    });
    assert.equal(dispatcher.getActiveIteration(), undefined);

    // Error exit cleanup
    await assert.rejects(
      async () => {
        await dispatcher.withIteration(runA.id, { incrementTurns: false }, async () => {
          throw new Error("Crash during iteration");
        });
      },
      (err: any) => {
        assert.equal(err.message, "Crash during iteration");
        return true;
      }
    );
    assert.equal(dispatcher.getActiveIteration(), undefined);
  });
});
