import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workflowExtension, {
  createLoopSchedulerAdapter,
  createWorkflowDispatcher,
  createWorkflowRunRegistry,
  createWorkflowTools,
  extractWorkflowRunId,
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
});
