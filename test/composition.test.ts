import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workflowExtension, {
  createGoalCommandController,
  createLoopSchedulerAdapter,
  createWorkflowCommandController,
  createWorkflowDispatcher,
  createWorkflowRunRegistry,
  createWorkflowTools,
  extractWorkflowRunId,
  GOAL_WORKFLOW_NAME,
  WorkflowDispatcher,
  WorkflowRunRegistry,
} from "../src/index.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { FakeLoopService, TestEventBus } from "./fake-loop-service.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

const WORKFLOW_DEV = `---
name: dev-workflow
description: End-to-end development cycle
mode: self-paced
budget:
  maxTurns: 10
wakeups:
  default: 5m
  named:
    ci: 15m
    retry: 2m
completion:
  requireEvidence: true
  requireSummary: true
---
# Dev Workflow
Follow the dev process.
`;

const WORKFLOW_DOCS = `---
name: docs-workflow
description: Documentation sync cycle
mode: self-paced
wakeups:
  default: 10m
---
# Docs Workflow
Sync documentation.
`;

describe("End-to-End Composition Test (pi-workflow & pi-loop)", () => {
  it("executes production-faithful multi-run lifecycle with /loop coexistence, signal safety, and recovery", async () => {
    const session = new FakeSessionManager();
    const eventBus = new TestEventBus();
    const loopService = new FakeLoopService({ sessionId: "test-session-gen-1" });
    eventBus.registerProvider(loopService);

    const handlers = new Map<string, Function>();
    const registeredTools = new Map<string, any>();
    const dispatchedMessages: string[] = [];

    // Construct ExtensionAPI fake matching Pi runtime contracts
    const pi: any = {
      events: eventBus,
      on(event: string, handler: Function) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      registerTool(tool: any) {
        registeredTools.set(tool.name, tool);
      },
      appendEntry(customType: string, data?: unknown) {
        return session.appendCustomEntry(customType, data);
      },
      sendUserMessage(text: string) {
        dispatchedMessages.push(text);
      },
    };

    // Load workflow extension
    workflowExtension(pi);

    // Verify tools registered
    assert(registeredTools.has("workflow_get_context"));
    assert(registeredTools.has("workflow_transition"));
    assert(registeredTools.has("workflow_continue"));
    assert(registeredTools.has("workflow_block"));
    assert(registeredTools.has("workflow_complete"));

    // 1. Simulate session_start
    const sessionCtx: any = {
      sessionManager: session,
    };
    await handlers.get("session_start")!({ type: "session_start" }, sessionCtx);

    // 2. Discover adapter and start two distinct workflow runs
    const registry = new WorkflowRunRegistry(session);
    registry.refresh();
    const dispatcher = new WorkflowDispatcher(registry);
    const adapter = createLoopSchedulerAdapter({
      registry,
      dispatcher,
      service: loopService,
      events: eventBus,
    });

    const defDev = parseWorkflowContent(WORKFLOW_DEV, { path: "/dev.md", scope: "project" });
    const defDocs = parseWorkflowContent(WORKFLOW_DOCS, { path: "/docs.md", scope: "project" });

    const devRunResult = await adapter.startRun(defDev, { runId: "run-dev-001" });
    const docsRunResult = await adapter.startRun(defDocs, { runId: "run-docs-002" });

    assert(devRunResult.task.id);
    assert(docsRunResult.task.id);
    assert.notEqual(devRunResult.task.id, docsRunResult.task.id);

    // 3. Simulate user starting an ordinary /loop command task
    const userLoopTask = loopService.scheduleFixed(5 * 60_000, "user /loop maintenance prompt");
    assert.equal(loopService.listTasks().length, 3);

    // 4. Simulate scheduler waking up workflow 1 iteration (Turn 1)
    const turn1Controller = new AbortController();
    const prompt1 = dispatcher.buildPrompt(devRunResult.run.id);

    // Pi fires before_agent_start and turn_start
    adapter.handleBeforeAgentStart({ prompt: prompt1 });
    handlers.get("before_agent_start")!({ prompt: prompt1 }, sessionCtx);
    const turn1Binding = adapter.handleTurnStart({ signal: turn1Controller.signal });

    assert(turn1Binding);
    assert.equal(turn1Binding.runId, "run-dev-001");
    assert.equal(turn1Binding.signal, turn1Controller.signal);

    // Model inspects context
    const getContextTool = registeredTools.get("workflow_get_context")!;
    // Note: create tools with this dispatcher and registry to verify tool integration
    const boundTools = createWorkflowTools({ dispatcher, registry });
    const boundGetContext = boundTools.find((t) => t.name === "workflow_get_context")!;
    const boundTransition = boundTools.find((t) => t.name === "workflow_transition")!;
    const boundContinue = boundTools.find((t) => t.name === "workflow_continue")!;
    const boundComplete = boundTools.find((t) => t.name === "workflow_complete")!;

    const ctxRes = await boundGetContext.execute("c1", {}, turn1Controller.signal, undefined, {} as any);
    assert.equal((ctxRes.details as any).runId, "run-dev-001");
    assert.equal((ctxRes.details as any).step, "INITIAL");

    // Model advances step to IMPLEMENTING
    await boundTransition.execute(
      "c2",
      { toStep: "IMPLEMENTING", data: { feature: "issue-4", progress: 50 }, reason: "started coding" },
      turn1Controller.signal,
      undefined,
      {} as any
    );

    // Model schedules variable wakeup: 15m (named wakeup "ci")
    await boundContinue.execute(
      "c3",
      { wakeupName: "ci", reason: "waiting for remote CI" },
      turn1Controller.signal,
      undefined,
      {} as any
    );

    // Verify pi-loop received the reschedule
    assert.equal(loopService.wakeups.length, 1);
    assert.equal(loopService.wakeups[0].taskId, devRunResult.task.id);
    assert.equal(loopService.wakeups[0].delayMs, 15 * 60_000);

    // Settle Turn 1
    adapter.handleAgentSettled();
    handlers.get("agent_settled")!({}, sessionCtx);
    assert.equal(dispatcher.getActiveIteration(), undefined);

    // 5. Simulate Turn 2 for Workflow 1 (CI completed, ready to finish)
    const turn2Controller = new AbortController();
    adapter.handleBeforeAgentStart({ prompt: prompt1 });
    handlers.get("before_agent_start")!({ prompt: prompt1 }, sessionCtx);
    const turn2Binding = adapter.handleTurnStart({ signal: turn2Controller.signal });

    assert(turn2Binding);
    assert.equal(turn2Binding.signal, turn2Controller.signal);

    // Complete workflow with evidence
    await boundComplete.execute(
      "c4",
      {
        summary: "Implemented scheduler integration successfully",
        evidence: [{ type: "test", description: "all unit and composition tests passed" }],
      },
      turn2Controller.signal,
      undefined,
      {} as any
    );

    adapter.handleAgentSettled();

    // Verify run 1 is completed
    const completedRun = registry.requireRun("run-dev-001");
    assert.equal(completedRun.lifecycle, "completed");

    // Verify Task 1 is stopped, but Docs Workflow task and user /loop are STILL LIVE
    assert.equal(loopService.stoppedTaskIds.includes(devRunResult.task.id), true);
    const activeTasksAfterComplete = loopService.listTasks();
    assert.equal(activeTasksAfterComplete.length, 2);
    assert(activeTasksAfterComplete.some((t) => t.id === docsRunResult.task.id));
    assert(activeTasksAfterComplete.some((t) => t.id === userLoopTask.id));

    // 6. Simulate cancelling Workflow 2
    await adapter.cancelWakeup("run-docs-002");
    registry.cancelRun("run-docs-002", { reason: "cancelled by user" });

    // Verify Docs workflow task is stopped, user /loop task remains untouched
    assert.equal(loopService.stoppedTaskIds.includes(docsRunResult.task.id), true);
    const activeTasksAfterCancel = loopService.listTasks();
    assert.equal(activeTasksAfterCancel.length, 1);
    assert.equal(activeTasksAfterCancel[0].id, userLoopTask.id);

    // 7. Session reload / reconstruction
    // Sibling extension reconnects to session branch and reconciles with pi-loop
    registry.refresh();
    const reconcileReport = await adapter.reconcile();

    // User /loop task is strictly preserved and not treated as orphan
    assert.equal(reconcileReport.orphans.length, 0);
    assert.equal(loopService.listTasks().length, 1);
    assert.equal(loopService.listTasks()[0].id, userLoopTask.id);
  });

  it("coexists a goal, a named workflow, and an ordinary /loop task without cross-cancellation", async () => {
    const session = new FakeSessionManager();
    const bus = new TestEventBus();
    const loopService = new FakeLoopService({ sessionId: "coexist-gen-1" });
    bus.registerProvider(loopService);

    const registry = new WorkflowRunRegistry(session);
    const dispatcher = new WorkflowDispatcher(registry);
    const adapter = createLoopSchedulerAdapter({ registry, dispatcher, events: bus });
    adapter.beginSession("coexist-session");
    await adapter.discover(bus, { timeoutMs: 200 });

    const workflowController = createWorkflowCommandController({ registry, adapter, dispatcher });
    const goalController = createGoalCommandController({ workflowController });

    // 1. Named workflow run
    const namedDef = parseWorkflowContent(WORKFLOW_DOCS, { path: "/docs.md", scope: "project" });
    const named = await adapter.startRun(namedDef, { runId: "run-named-coexist" });

    // 2. Goal run (same adapter, same service)
    const goalRes = await goalController.execute("achieve coexistence");
    assert.equal(goalRes.ok, true, goalRes.output);
    const goalRunId = (goalRes.data as any).runId as string;
    assert.equal(registry.requireRun(goalRunId).workflow, GOAL_WORKFLOW_NAME);

    // 3. Ordinary user /loop task
    const userLoopTask = loopService.scheduleFixed(5 * 60_000, "ordinary user /loop prompt");

    // Distinct task ownership for all three.
    const tasks = loopService.listTasks();
    assert.equal(tasks.length, 3);
    const taskIds = new Set(tasks.map((t) => t.id));
    assert.equal(taskIds.size, 3);
    assert.notEqual(named.task.id, userLoopTask.id);
    assert.notEqual(registry.requireRun(goalRunId).loopTaskId, named.task.id);

    // 4. Pausing the goal must not touch the named workflow or user /loop tasks.
    const paused = await goalController.execute("pause");
    assert.equal(paused.ok, true, paused.output);
    assert.equal(registry.requireRun(goalRunId).lifecycle, "paused");
    const afterPause = loopService.listTasks();
    assert.equal(afterPause.length, 2);
    assert.ok(afterPause.some((t) => t.id === named.task.id));
    assert.ok(afterPause.some((t) => t.id === userLoopTask.id));

    // 5. Resuming restores exactly one goal task, still leaving others alone.
    const resumed = await goalController.execute("resume");
    assert.equal(resumed.ok, true, resumed.output);
    assert.equal(loopService.listTasks().length, 3);

    // 6. Stopping the goal cancels only the goal's task.
    const stopped = await goalController.execute("stop");
    assert.equal(stopped.ok, true, stopped.output);
    assert.equal(registry.requireRun(goalRunId).lifecycle, "cancelled");
    const afterStop = loopService.listTasks();
    assert.equal(afterStop.length, 2);
    assert.ok(afterStop.some((t) => t.id === named.task.id));
    assert.ok(afterStop.some((t) => t.id === userLoopTask.id));
  });

  it("reload/reconcile retains goal identity/objective, recreates at most one linked task, and leaves paused goals idle", async () => {
    const session = new FakeSessionManager();
    const bus = new TestEventBus();
    const loopService = new FakeLoopService({ sessionId: "reload-gen-1" });
    bus.registerProvider(loopService);

    const registry = new WorkflowRunRegistry(session);
    const dispatcher = new WorkflowDispatcher(registry);
    const adapter = createLoopSchedulerAdapter({
      registry,
      dispatcher,
      events: bus,
      ownerId: "reload-owner-A",
    });
    adapter.beginSession("reload-session");
    await adapter.discover(bus, { timeoutMs: 200 });

    const workflowController = createWorkflowCommandController({ registry, adapter, dispatcher });
    const goalController = createGoalCommandController({ workflowController });

    const goalRes = await goalController.execute("survive reload with identity");
    const goalRunId = (goalRes.data as any).runId as string;
    const userLoopTask = loopService.scheduleFixed(5 * 60_000, "ordinary user /loop prompt");

    // Simulate a session reload: rebuild run state from the durable branch only.
    const reloadedRegistry = new WorkflowRunRegistry(session);
    reloadedRegistry.refresh();
    const reloadedRun = reloadedRegistry.requireRun(goalRunId);
    assert.equal(reloadedRun.type, "goal");
    assert.equal(reloadedRun.snapshot.type, "goal");
    assert.equal(reloadedRun.objective, "survive reload with identity");
    assert.equal(reloadedRun.snapshot.objective, "survive reload with identity");

    // Fresh adapter on the reloaded registry bound to the same session/service.
    // A different live owner must not be preempted until its lease lapses, so
    // model the reload as occurring after the previous lease expiry.
    const reloadedDispatcher = new WorkflowDispatcher(reloadedRegistry);
    const reloadedAdapter = createLoopSchedulerAdapter({
      registry: reloadedRegistry,
      dispatcher: reloadedDispatcher,
      events: bus,
      ownerId: "reload-owner-B",
    });
    reloadedAdapter.beginSession("reload-session");
    reloadedAdapter.attachService(loopService);

    const reloadedWorkflowController = createWorkflowCommandController({
      registry: reloadedRegistry,
      adapter: reloadedAdapter,
      dispatcher: reloadedDispatcher,
    });
    const reloadedGoalController = createGoalCommandController({ workflowController: reloadedWorkflowController });

    const afterLeaseExpiry = Date.now() + 20 * 60_000;
    await reloadedAdapter.reconcile({ now: afterLeaseExpiry });

    // At most one live task declares the goal run id, and the user /loop survives.
    const goalTasks = loopService
      .listTasks()
      .filter((t) => extractWorkflowRunId(t.prompt) === goalRunId);
    assert.ok(goalTasks.length <= 1, "at most one linked goal task after reconcile");
    assert.ok(loopService.listTasks().some((t) => t.id === userLoopTask.id));

    // The prompt rebuilt from the reconstructed snapshot still contains the objective.
    if (goalTasks.length === 1) {
      assert.ok(goalTasks[0].prompt.includes("survive reload with identity"));
    }

    // A paused goal reconciles to zero live tasks and never spontaneously runs.
    await reloadedGoalController.execute("pause");
    await reloadedAdapter.reconcile();
    assert.equal(reloadedRegistry.requireRun(goalRunId).lifecycle, "paused");
    assert.equal(
      loopService.listTasks().filter((t) => extractWorkflowRunId(t.prompt) === goalRunId).length,
      0
    );

    // A human-required blocked goal likewise retains no live task.
    reloadedRegistry.resumeRun(goalRunId, { reason: "test unblock" });
    reloadedRegistry.blockRun(goalRunId, {
      reason: "waiting for human authorization",
      category: "human-required",
      requiresHuman: true,
    });
    await reloadedAdapter.reconcile();
    assert.equal(reloadedRegistry.requireRun(goalRunId).lifecycle, "blocked");
    assert.equal(
      loopService.listTasks().filter((t) => extractWorkflowRunId(t.prompt) === goalRunId).length,
      0
    );
  });
});
