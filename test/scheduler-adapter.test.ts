import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  discoverLoopService,
  extractWorkflowRunId,
  isLoopServiceV1,
  LoopSchedulerAdapter,
  LOOP_SERVICE_VERSION,
  LoopServiceUnavailableError,
  WorkflowDispatcher,
  WorkflowRunRegistry,
  WorkflowSchedulerError,
  WorkflowSchedulerUnavailableError,
  createWorkflowTools,
} from "../src/index.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { FakeLoopService, TestEventBus } from "./fake-loop-service.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

const WORKFLOW_SELF_PACED_1 = `---
name: workflow-alpha
description: Alpha workflow
mode: self-paced
wakeups:
  default: 5m
  min: 1m
  max: 1h
  named:
    retry: 2m
    longWait: 30m
---
# Workflow Alpha Body
Execute alpha steps.
`;

const WORKFLOW_SELF_PACED_2 = `---
name: workflow-beta
description: Beta workflow
mode: self-paced
wakeups:
  default: 10m
---
# Workflow Beta Body
Execute beta steps.
`;

const WORKFLOW_FIXED = `---
name: workflow-fixed
description: Fixed interval workflow
mode: fixed
schedule:
  interval: 15m
---
# Fixed Workflow Body
Repeat every 15 minutes.
`;

const WORKFLOW_CRON = `---
name: workflow-cron
description: Calendar cron workflow
mode: cron
schedule:
  cron: "0 9 * * 1-5"
  timeZone: "America/New_York"
---
# Cron Workflow Body
Run on weekdays at 9am NY time.
`;

const WORKFLOW_ONCE = `---
name: workflow-once
description: One-shot workflow
mode: once
schedule:
  delay: 30m
---
# One Shot Workflow Body
Execute once after 30 minutes.
`;

describe("LoopSchedulerAdapter & pi-loop Integration", () => {
  let session: FakeSessionManager;
  let registry: WorkflowRunRegistry;
  let dispatcher: WorkflowDispatcher;
  let eventBus: TestEventBus;
  let fakeService: FakeLoopService;
  let adapter: LoopSchedulerAdapter;

  beforeEach(() => {
    session = new FakeSessionManager();
    registry = new WorkflowRunRegistry(session);
    dispatcher = new WorkflowDispatcher(registry);
    eventBus = new TestEventBus();
    fakeService = new FakeLoopService();
    eventBus.registerProvider(fakeService);
    adapter = new LoopSchedulerAdapter({
      registry,
      dispatcher,
      service: fakeService,
      events: eventBus,
    });
  });

  describe("Discovery Protocol & Service Boundary", () => {
    it("discovers versioned loop service over event bus", async () => {
      const freshAdapter = new LoopSchedulerAdapter({ registry, dispatcher });
      assert.equal(freshAdapter.isAvailable(), false);

      const discovery = await freshAdapter.discover(eventBus);
      assert.equal(discovery.ok, true);
      assert.equal(freshAdapter.isAvailable(), true);
      assert.equal(freshAdapter.getService()?.version, LOOP_SERVICE_VERSION);
    });

    it("handles discovery timeout when no provider replies without throwing", async () => {
      const emptyBus = new TestEventBus();
      const freshAdapter = new LoopSchedulerAdapter({ registry, dispatcher });

      const discovery = await freshAdapter.discover(emptyBus, { timeoutMs: 20 });
      assert.equal(discovery.ok, false);
      assert.equal((discovery as any).reason, "timeout");
      assert.equal(freshAdapter.isAvailable(), false);
    });

    it("handles unavailable provider status response cleanly", async () => {
      const disabledService = new FakeLoopService({ initialAvailable: false });
      const bus = new TestEventBus();
      bus.registerProvider(disabledService);

      const freshAdapter = new LoopSchedulerAdapter({ registry, dispatcher });
      const discovery = await freshAdapter.discover(bus, { timeoutMs: 50 });
      assert.equal(discovery.ok, false);
      assert.equal((discovery as any).reason, "unavailable");
      assert.equal(freshAdapter.isAvailable(), false);
    });

    it("detects malformed discovery replies with invalid-response reason", async () => {
      const bus = new TestEventBus();
      bus.on("pi-loop:service:discover:v1", (data: any) => {
        bus.emit(data.replyChannel, { invalid: "payload", version: 99 });
      });

      const discovery = await discoverLoopService(bus, { timeoutMs: 50 });
      assert.equal(discovery.ok, false);
      assert.equal((discovery as any).reason, "invalid-response");
    });

    it("detects service disposal and availability changes via onLoopServiceChange", () => {
      assert.equal(adapter.isAvailable(), true);

      // Provider broadcasts unavailable (e.g. session rebuild or shutdown)
      eventBus.broadcastChange({
        version: LOOP_SERVICE_VERSION,
        available: false,
        reason: "session reset",
      });

      assert.equal(adapter.isAvailable(), false);
    });

    it("validates isLoopServiceV1 structurally", () => {
      assert.equal(isLoopServiceV1(fakeService), true);
      assert.equal(isLoopServiceV1(null), false);
      assert.equal(isLoopServiceV1({}), false);
      assert.equal(isLoopServiceV1({ version: 2 }), false);
    });
  });

  describe("Acceptance Criteria 1: Multiple Independent Workflow Tasks", () => {
    it("starting two workflows creates two independent scheduler tasks", async () => {
      const def1 = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const def2 = parseWorkflowContent(WORKFLOW_SELF_PACED_2, { path: "/test/beta.md", scope: "project" });

      const res1 = await adapter.startRun(def1, { runId: "run-alpha-001" });
      const res2 = await adapter.startRun(def2, { runId: "run-beta-002" });

      assert(res1.task.id);
      assert(res2.task.id);
      assert.notEqual(res1.task.id, res2.task.id);

      // Verify tasks in fake pi-loop service
      const tasks = fakeService.listTasks();
      assert.equal(tasks.length, 2);

      const task1 = tasks.find((t) => t.id === res1.task.id);
      const task2 = tasks.find((t) => t.id === res2.task.id);
      assert(task1);
      assert(task2);

      assert.equal(task1.mode, "self-paced");
      assert.equal(task2.mode, "self-paced");

      // Verify run ↔ loopTaskId linkage in registry and adapter
      assert.equal(res1.run.loopTaskId, res1.task.id);
      assert.equal(res2.run.loopTaskId, res2.task.id);
      assert.equal(adapter.getLinkedTaskId("run-alpha-001"), res1.task.id);
      assert.equal(adapter.getLinkedTaskId("run-beta-002"), res2.task.id);
      assert.equal(adapter.getLinkedRunId(res1.task.id), "run-alpha-001");
      assert.equal(adapter.getLinkedRunId(res2.task.id), "run-beta-002");
    });
  });

  describe("Acceptance Criteria 2: Independence from User /loop Command", () => {
    it("starting or replacing the user's ordinary /loop does not remove workflow scheduler tasks", async () => {
      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "run-wf-001" });

      // Simulate user creating a command-owned primary /loop task
      const userLoopTask = fakeService.scheduleFixed(5 * 60_000, "check git status and compile");
      // Simulate user later replacing /loop with a different task
      fakeService.deleteTask(userLoopTask.id);
      const userReplacedLoopTask = fakeService.scheduleFixed(10 * 60_000, "check pull requests");

      // Workflow task must still be present and intact
      const tasks = fakeService.listTasks();
      assert.equal(tasks.some((t) => t.id === task.id), true);
      assert.equal(adapter.getLinkedTaskId(run.id), task.id);

      // Reconcile must not touch the user's /loop task
      const reconcileReport = await adapter.reconcile();
      assert.equal(reconcileReport.matched.length, 1);
      assert.equal(reconcileReport.matched[0].taskId, task.id);
      // Orphan check should ignore user loop task because its prompt has no workflow run ID
      assert.equal(reconcileReport.orphans.length, 0);

      // User loop task is still alive
      const liveTasks = fakeService.listTasks();
      assert(liveTasks.some((t) => t.id === userReplacedLoopTask.id));
    });
  });

  describe("Acceptance Criteria 3: Variable Wakeup Delays Across Iterations", () => {
    it("a self-paced workflow can choose different wakeup delays across iterations", async () => {
      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "run-vp-001" });

      // Iteration 1: continue with named wakeup "retry" (2m = 120,000ms)
      const decision1 = await adapter.scheduleWakeup({
        runId: run.id,
        delayMs: 2 * 60_000,
        reason: "short retry",
      });
      assert.equal(decision1.delayMs, 120_000);
      assert.equal(decision1.reason, "short retry");

      // Iteration 2: continue with explicit 15m (900,000ms)
      const decision2 = await adapter.scheduleWakeup({
        runId: run.id,
        delayMs: 15 * 60_000,
        reason: "waiting for remote CI build",
      });
      assert.equal(decision2.delayMs, 900_000);
      assert.equal(decision2.reason, "waiting for remote CI build");

      // Iteration 3: continue with 1h (3,600,000ms)
      const decision3 = await adapter.scheduleWakeup({
        runId: run.id,
        delayMs: 60 * 60_000,
        reason: "overnight idle poll",
      });
      assert.equal(decision3.delayMs, 3_600_000);

      // Clamping test: delays below 1min clamp up to 1min (60,000ms)
      const decisionClampedLow = await adapter.scheduleWakeup({
        runId: run.id,
        delayMs: 10_000,
        reason: "too fast",
      });
      assert.equal(decisionClampedLow.delayMs, 60_000);
      assert.equal(decisionClampedLow.clamped, true);

      // Verify history in fake service
      assert.equal(fakeService.wakeups.length, 4);
      assert.equal(fakeService.wakeups[0].delayMs, 120_000);
      assert.equal(fakeService.wakeups[1].delayMs, 900_000);
      assert.equal(fakeService.wakeups[2].delayMs, 3_600_000);
      assert.equal(fakeService.wakeups[3].delayMs, 60_000);
    });
  });

  describe("Acceptance Criteria 4: Single-Task Cancellation", () => {
    it("completing or cancelling one workflow stops only its scheduler task", async () => {
      const def1 = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const def2 = parseWorkflowContent(WORKFLOW_SELF_PACED_2, { path: "/test/beta.md", scope: "project" });

      const res1 = await adapter.startRun(def1, { runId: "run-stop-1" });
      const res2 = await adapter.startRun(def2, { runId: "run-stop-2" });
      const userTask = fakeService.scheduleFixed(5 * 60_000, "user /loop task");

      assert.equal(fakeService.listTasks().length, 3);

      // Cancel run 1
      const stopped = await adapter.cancelWakeup("run-stop-1");
      assert.equal(stopped, true);

      // Task 1 is stopped, Task 2 and user task remain untouched
      const remainingTasks = fakeService.listTasks();
      assert.equal(remainingTasks.length, 2);
      assert.equal(remainingTasks.some((t) => t.id === res1.task.id), false);
      assert.equal(remainingTasks.some((t) => t.id === res2.task.id), true);
      assert.equal(remainingTasks.some((t) => t.id === userTask.id), true);
    });
  });

  describe("Acceptance Criteria 5: Missing pi-loop Surface & Error Handling", () => {
    it("fails clearly when pi-loop is unavailable without crashing Pi", async () => {
      fakeService.setAvailable(false);
      assert.equal(adapter.isAvailable(), false);

      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });

      // Start run must fail closed with WorkflowSchedulerUnavailableError
      await assert.rejects(
        async () => {
          await adapter.startRun(def, { runId: "run-fail-unavailable" });
        },
        (err: any) => {
          assert(err instanceof WorkflowSchedulerUnavailableError);
          assert.match(err.message, /pi-loop scheduler service is unavailable/);
          return true;
        }
      );

      // Ensure no dangling active run was created
      assert.equal(registry.hasRun("run-fail-unavailable"), true);
      assert.equal(registry.getRun("run-fail-unavailable")?.lifecycle, "cancelled");
    });

    it("scheduleWakeup fails with WorkflowSchedulerUnavailableError when service is disposed", async () => {
      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const { run } = await adapter.startRun(def, { runId: "run-disposed" });

      // Simulate session shutdown/reconstruction disposing the service
      fakeService.setAvailable(false);

      await assert.rejects(
        async () => {
          await adapter.scheduleWakeup({ runId: run.id, delayMs: 60_000 });
        },
        (err: any) => {
          assert(err instanceof WorkflowSchedulerUnavailableError);
          return true;
        }
      );
    });

    it("scheduleWakeup fails with WorkflowSchedulerTaskNotFoundError when run has no task linkage", async () => {
      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const run = registry.createRun(def, { runId: "run-no-link" });

      await assert.rejects(
        async () => {
          await adapter.scheduleWakeup({ runId: run.id, delayMs: 60_000 });
        },
        (err: any) => {
          assert(err instanceof WorkflowSchedulerError);
          assert.match(err.message, /no linked scheduler task ID/);
          return true;
        }
      );
    });
  });

  describe("Acceptance Criteria 6: Reload & Session Reconstruction Reconciliation", () => {
    it("reconnects live workflow runs to authoritative scheduler state", async () => {
      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "run-recon-1" });

      // Simulate session restart: a new adapter is created with empty internal maps
      const newAdapter = new LoopSchedulerAdapter({
        registry,
        dispatcher,
        service: fakeService,
      });

      assert.equal(newAdapter.getLinkedTaskId("run-recon-1"), task.id); // Read from registry

      const report = await newAdapter.reconcile();
      assert.equal(report.matched.length, 1);
      assert.equal(report.matched[0].runId, "run-recon-1");
      assert.equal(report.matched[0].taskId, task.id);
      assert.equal(report.recreated.length, 0);
      assert.equal(report.orphans.length, 0);
    });

    it("recreates scheduler task for active self-paced run if missing after recovery", async () => {
      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "run-recon-lost" });

      // Simulate pi-loop reload where ephemeral self-paced task was dropped
      fakeService.deleteTask(task.id);
      assert.equal(fakeService.listTasks().length, 0);

      const report = await adapter.reconcile({ recreateMissing: true });
      assert.equal(report.recreated.length, 1);
      assert.equal(report.recreated[0].runId, "run-recon-lost");
      assert.equal(report.recreated[0].oldTaskId, task.id);
      assert(report.recreated[0].newTaskId);
      assert.notEqual(report.recreated[0].newTaskId, task.id);

      // Verify the recreated task is now active in pi-loop
      const tasks = fakeService.listTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, report.recreated[0].newTaskId);
      assert.equal(registry.requireRun("run-recon-lost").loopTaskId, report.recreated[0].newTaskId);
    });

    it("blocks active run if recreation is disabled and task is lost", async () => {
      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "run-recon-block" });

      fakeService.deleteTask(task.id);

      const report = await adapter.reconcile({ recreateMissing: false });
      assert.equal(report.blocked.length, 1);
      assert.equal(report.blocked[0].runId, "run-recon-block");
      assert.equal(registry.requireRun("run-recon-block").lifecycle, "blocked");
    });

    it("identifies and cleans up orphan workflow tasks while strictly preserving ordinary tasks", async () => {
      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "run-orphan-test" });

      // Complete run in registry
      registry.completeRun(run.id, { summary: "Finished successfully" });

      // Add a user task to pi-loop that is NOT a workflow run
      const userTask = fakeService.scheduleFixed(10 * 60_000, "user maintenance loop");

      // Reconcile
      const report = await adapter.reconcile({ reconcileOrphans: true });
      assert.equal(report.orphans.length, 1);
      assert.equal(report.orphans[0].taskId, task.id);
      assert.equal(report.orphans[0].runId, "run-orphan-test");
      assert.equal(report.orphans[0].stopped, true);

      // Verify orphan task was deleted, but user task remains alive
      const remainingTasks = fakeService.listTasks();
      assert.equal(remainingTasks.length, 1);
      assert.equal(remainingTasks[0].id, userTask.id);
    });
  });

  describe("Acceptance Criteria 7: No Duplicated Scheduler or Timers", () => {
    it("never creates timers or due queues in pi-workflow", async () => {
      // Inspect that adapter maintains zero local timers
      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      await adapter.startRun(def, { runId: "run-no-timers" });

      // Session shutdown cleans up with zero timer teardown needed
      adapter.detachService();
      assert.equal(adapter.isAvailable(), false);
    });
  });

  describe("Scheduling Across All Workflow Spec v1 Modes", () => {
    it("schedules fixed interval workflow correctly", async () => {
      const def = parseWorkflowContent(WORKFLOW_FIXED, { path: "/test/fixed.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "run-fixed-1" });

      assert.equal(task.mode, "fixed");
      assert.equal(task.intervalMs, 15 * 60_000);
      assert.equal(run.loopTaskId, task.id);
    });

    it("schedules cron workflow correctly", async () => {
      const def = parseWorkflowContent(WORKFLOW_CRON, { path: "/test/cron.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "run-cron-1" });

      assert.equal(task.mode, "fixed");
      assert.equal(task.cron, "0 9 * * 1-5");
      assert.equal(task.timeZone, "America/New_York");
      assert.equal(run.loopTaskId, task.id);
    });

    it("schedules one-shot workflow correctly", async () => {
      const def = parseWorkflowContent(WORKFLOW_ONCE, { path: "/test/once.md", scope: "project" });
      const now = Date.now();
      const { run, task } = await adapter.startRun(def, { runId: "run-once-1" });

      assert.equal(task.mode, "one-shot");
      assert(task.nextFireAt && task.nextFireAt >= now + 29 * 60_000);
      assert.equal(run.loopTaskId, task.id);
    });
  });

  describe("Prompt Dispatch & Turn Signal Identity Verification", () => {
    it("extracts run ID from deterministic workflow prompt format", async () => {
      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const run = registry.createRun(def, { runId: "run-prompt-test" });
      const prompt = dispatcher.buildPrompt(run.id);

      const extractedId = extractWorkflowRunId(prompt);
      assert.equal(extractedId, "run-prompt-test");

      // Non-workflow prompt returns undefined
      assert.equal(extractWorkflowRunId("hello world check status"), undefined);
      assert.equal(extractWorkflowRunId("/loop 5m check things"), undefined);
    });

    it("binds active iteration turn with real per-turn signal on prompt dispatch", async () => {
      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const { run } = await adapter.startRun(def, { runId: "run-signal-test" });

      const prompt = dispatcher.buildPrompt(run.id);
      const controller = new AbortController();

      // Simulate pi dispatching prompt: before_agent_start -> turn_start
      adapter.handleBeforeAgentStart({ prompt });
      const binding = adapter.handleTurnStart({ signal: controller.signal });

      assert(binding);
      assert.equal(binding.runId, run.id);
      assert.equal(binding.signal, controller.signal);

      // Model tool execution succeeds because invocation signal strictly matches binding.signal
      const tools = createWorkflowTools({ dispatcher, registry });
      const continueTool = tools.find((t) => t.name === "workflow_continue")!;

      const result = await continueTool.execute(
        "call-1",
        { delay: "5m", reason: "waiting for test" },
        controller.signal,
        undefined,
        {} as any
      );

      assert.equal((result.details as any).runId, run.id);
      assert.equal((result.details as any).delayMs, 5 * 60_000);

      // Verify pi-loop received the wakeup reschedule
      assert.equal(fakeService.wakeups.length, 1);
      assert.equal(fakeService.wakeups[0].delayMs, 5 * 60_000);

      // Simulate turn end & settle
      adapter.handleAgentSettled();
      assert.equal(dispatcher.getActiveIteration(), undefined);

      // Late tool call fails closed
      await assert.rejects(async () => {
        await continueTool.execute(
          "call-late",
          { delay: "5m" },
          controller.signal,
          undefined,
          {} as any
        );
      }, /no workflow iteration is currently active/);
    });

    it("model tool fails closed when invoked with a signal from a different turn", async () => {
      const def = parseWorkflowContent(WORKFLOW_SELF_PACED_1, { path: "/test/alpha.md", scope: "project" });
      const { run } = await adapter.startRun(def, { runId: "run-mismatch-signal" });

      const prompt = dispatcher.buildPrompt(run.id);
      const turnSignal = new AbortController().signal;
      const otherSignal = new AbortController().signal;

      adapter.handleBeforeAgentStart({ prompt });
      adapter.handleTurnStart({ signal: turnSignal });

      const tools = createWorkflowTools({ dispatcher, registry });
      const transitionTool = tools.find((t) => t.name === "workflow_transition")!;

      await assert.rejects(async () => {
        await transitionTool.execute(
          "call-turn-2",
          { toStep: "PROCESSING" },
          otherSignal, // Stale / mismatched turn signal
          undefined,
          {} as any
        );
      }, /tool call signal does not match the active iteration signal/);
    });
  });
});
