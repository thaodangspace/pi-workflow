/**
 * Comprehensive test suite for Workflow Lifecycle Commands and Run Controls (Issue #5).
 *
 * Verifies:
 * 1. Command argument parsing & error handling
 * 2. Autocomplete suggestions (subcommands, workflow names, run IDs)
 * 3. Workflow definition discovery & listing in deterministic order
 * 4. Starting workflows: validation, capabilities, durable run creation, scheduler attachment
 * 5. Concurrency enforcement & clear error diagnostics
 * 6. Deterministic status listing & detailed inspection without raw scheduler task IDs
 * 7. Name vs Run ID disambiguation and actionable error messages
 * 8. Missing capability validation on start and resume
 * 9. Pause semantics & ensuring paused runs do not wake automatically
 * 10. Resume semantics & restoring exactly one scheduler linkage
 * 11. Stop isolation: stops only target task, retains history, preserves other runs and user /loop
 * 12. Definition reload affecting future runs only (immutable running snapshots)
 * 13. Sensible text fallbacks for non-TUI modes
 * 14. Extension command registration on ExtensionAPI
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  createWorkflowCommandController,
  formatAge,
  formatNextWakeup,
  parseWorkflowCommandArgs,
  WorkflowCommandController,
} from "../src/commands.ts";
import { createGoalCommandController } from "../src/index.ts";
import { MAX_RUN_HISTORY_ENTRIES } from "../src/constants.ts";
import { WorkflowDispatcher } from "../src/dispatcher.ts";
import workflowExtension from "../src/index.ts";
import { WorkflowRunRegistry } from "../src/registry.ts";
import { LoopSchedulerAdapter } from "../src/scheduler-adapter.ts";
import { WorkflowCapabilityError, WorkflowConcurrencyError } from "../src/types.ts";
import { FakeLoopService } from "./fake-loop-service.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

describe("Workflow Lifecycle Commands & Run Controls (Issue #5)", () => {
  let tempDir: string;
  let workflowsDir: string;
  let fakeSession: FakeSessionManager;
  let registry: WorkflowRunRegistry;
  let dispatcher: WorkflowDispatcher;
  let fakeLoopService: FakeLoopService;
  let adapter: LoopSchedulerAdapter;
  let capturedOutputs: string[];
  let controller: WorkflowCommandController;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-workflow-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    workflowsDir = join(tempDir, ".pi", "workflows");
    mkdirSync(workflowsDir, { recursive: true });

    fakeSession = new FakeSessionManager();
    registry = new WorkflowRunRegistry(fakeSession);
    dispatcher = new WorkflowDispatcher(registry);
    fakeLoopService = new FakeLoopService();

    adapter = new LoopSchedulerAdapter({
      registry,
      dispatcher,
      service: fakeLoopService,
    });

    capturedOutputs = [];

    // Helper to create test workflow definitions on disk
    writeTestWorkflow(workflowsDir, "example", {
      description: "Example self-paced workflow for task automation",
      mode: "self-paced",
      requires: ["loop", "tmux"],
      maxRuns: 1,
    });

    writeTestWorkflow(workflowsDir, "ci-watcher", {
      description: "Periodic CI status monitor",
      mode: "fixed",
      interval: "5m",
      requires: ["loop"],
      maxRuns: 2,
    });

    controller = createWorkflowCommandController({
      registry,
      adapter,
      dispatcher,
      cwd: tempDir,
      capabilities: ["loop", "tmux", "git"],
      outputStream: (text) => capturedOutputs.push(text),
    });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // -------------------------------------------------------------------------
  // Helper to generate valid workflow definition Markdown files
  // -------------------------------------------------------------------------
  function writeTestWorkflow(
    dir: string,
    name: string,
    opts: {
      description?: string;
      mode?: string;
      requires?: string[];
      maxRuns?: number;
      interval?: string;
      body?: string;
    } = {}
  ): string {
    const filePath = join(dir, `${name}.md`);
    const lines = [
      "---",
      `name: ${name}`,
      `description: ${JSON.stringify(opts.description ?? "Test workflow description")}`,
      `mode: ${opts.mode ?? "self-paced"}`,
    ];

    if (opts.interval) {
      lines.push("schedule:", `  interval: "${opts.interval}"`);
    }

    if (opts.maxRuns !== undefined) {
      lines.push("concurrency:", `  maxRuns: ${opts.maxRuns}`);
    }

    if (opts.requires) {
      lines.push("requires:");
      for (const req of opts.requires) {
        lines.push(`  - ${req}`);
      }
    }

    lines.push("---", opts.body ?? `# Workflow ${name}\nExecution instructions.`);
    writeFileSync(filePath, lines.join("\n"), "utf-8");
    return filePath;
  }

  // =========================================================================
  // 1. Argument Parsing & Formatting Helpers
  // =========================================================================
  describe("Argument Parsing & Formatting Helpers", () => {
    it("parses empty arguments to help", () => {
      const parsed = parseWorkflowCommandArgs("");
      assert.equal(parsed.subcommand, "help");
      assert.equal(parsed.target, undefined);
    });

    it("rejects unexpected extra arguments across all subcommands", async () => {
      // 1. list
      const resList = await controller.execute("list unexpected");
      assert.equal(resList.ok, false);
      assert.match(resList.output, /Unexpected argument\(s\) for '\/workflow list': "unexpected"/);
      assert.match(resList.output, /Usage: \/workflow list/);

      // 2. reload
      const resReload = await controller.execute("reload now");
      assert.equal(resReload.ok, false);
      assert.match(resReload.output, /Unexpected argument\(s\) for '\/workflow reload': "now"/);

      // 3. help
      const resHelp = await controller.execute("help extra");
      assert.equal(resHelp.ok, false);
      assert.match(resHelp.output, /Unexpected argument\(s\) for '\/workflow help': "extra"/);

      // 4. start
      const resStart = await controller.execute("start example extra-token");
      assert.equal(resStart.ok, false);
      assert.match(resStart.output, /Unexpected argument\(s\) for '\/workflow start': "extra-token"/);

      // 5. status
      const resStatus = await controller.execute("status id1 id2");
      assert.equal(resStatus.ok, false);
      assert.match(resStatus.output, /Unexpected argument\(s\) for '\/workflow status': "id2"/);

      // 6. pause
      const resPause = await controller.execute("pause id1 extra");
      assert.equal(resPause.ok, false);
      assert.match(resPause.output, /Unexpected argument\(s\) for '\/workflow pause': "extra"/);

      // 7. resume
      const resResume = await controller.execute("resume id1 extra");
      assert.equal(resResume.ok, false);
      assert.match(resResume.output, /Unexpected argument\(s\) for '\/workflow resume': "extra"/);

      // 8. stop
      const resStop = await controller.execute("stop id1 extra");
      assert.equal(resStop.ok, false);
      assert.match(resStop.output, /Unexpected argument\(s\) for '\/workflow stop': "extra"/);
    });

    it("parses subcommands with targets and flags", () => {
      const p1 = parseWorkflowCommandArgs("start example");
      assert.equal(p1.subcommand, "start");
      assert.equal(p1.target, "example");

      const p2 = parseWorkflowCommandArgs("status wfrun-test-123 extra-arg");
      assert.equal(p2.subcommand, "status");
      assert.equal(p2.target, "wfrun-test-123");
      assert.deepEqual(p2.extra, ["extra-arg"]);

      const p3 = parseWorkflowCommandArgs("PAUSE WFRUN-ABC");
      assert.equal(p3.subcommand, "pause");
      assert.equal(p3.target, "WFRUN-ABC");
    });

    it("formats age strings accurately across human intervals", () => {
      const now = 10000000;
      assert.equal(formatAge(now - 5000, now), "5s");
      assert.equal(formatAge(now - 120000, now), "2m");
      assert.equal(formatAge(now - 145000, now), "2m 25s");
      assert.equal(formatAge(now - 3600000, now), "1h");
      assert.equal(formatAge(now - 3720000, now), "1h 2m");
      assert.equal(formatAge(now - 86400000, now), "1d");
      assert.equal(formatAge(now - 90000000, now), "1d 1h");
    });

    it("formats next wakeup accurately without raw task IDs", async () => {
      // 1. Terminal or paused runs report clean status
      const { run } = await adapter.startRun(
        {
          schemaVersion: "v1",
          name: "example",
          description: "desc",
          mode: "self-paced",
          concurrency: { maxRuns: 1 },
          budget: {},
          wakeups: {},
          requires: [],
          body: "body",
          source: { path: "p", scope: "project", sha256: "s", loadedAt: "l" },
        },
        {}
      );

      // Scheduled self-paced run in fake loop service
      const wakeupStr = formatNextWakeup(run, adapter);
      assert.match(wakeupStr, /due now|in /);

      // Paused run
      const paused = registry.pauseRun(run.id);
      assert.equal(formatNextWakeup(paused, adapter), "none (paused)");

      // Blocked run
      registry.resumeRun(run.id);
      const blocked = registry.blockRun(run.id, { reason: "waiting" });
      assert.equal(formatNextWakeup(blocked, adapter), "none (blocked)");

      // Completed run
      registry.resumeRun(run.id);
      const completed = registry.completeRun(run.id, { summary: "done" });
      assert.equal(formatNextWakeup(completed, adapter), "none (completed)");
    });
  });

  // =========================================================================
  // 2. Command Autocomplete
  // =========================================================================
  describe("Command Autocomplete", () => {
    it("suggests subcommands matching prefix", async () => {
      const comp1 = await controller.getArgumentCompletions("");
      assert.ok(comp1 && comp1.length >= 7);
      const names = comp1.map((c) => c.label);
      assert.ok(names.includes("list"));
      assert.ok(names.includes("start"));
      assert.ok(names.includes("status"));
      assert.ok(names.includes("pause"));
      assert.ok(names.includes("resume"));
      assert.ok(names.includes("stop"));
      assert.ok(names.includes("reload"));

      const comp2 = await controller.getArgumentCompletions("st");
      assert.ok(comp2);
      const stLabels = comp2.map((c) => c.label);
      assert.ok(stLabels.includes("start"));
      assert.ok(stLabels.includes("status"));
      assert.ok(stLabels.includes("stop"));
      assert.ok(!stLabels.includes("list"));
    });

    it("suggests workflow definition names for start command", async () => {
      const comp = await controller.getArgumentCompletions("start ");
      assert.ok(comp && comp.length >= 2);
      const labels = comp.map((c) => c.label);
      assert.ok(labels.includes("example"));
      assert.ok(labels.includes("ci-watcher"));
    });

    it("suggests run IDs for lifecycle commands", async () => {
      const res = await controller.execute("start example");
      assert.equal(res.ok, true);
      const runId = (res.data as any).runId;

      // Status completions include active run
      const statusComp = await controller.getArgumentCompletions("status ");
      assert.ok(statusComp && statusComp.some((c) => c.label === runId));

      // Pause completions include active run
      const pauseComp = await controller.getArgumentCompletions("pause ");
      assert.ok(pauseComp && pauseComp.some((c) => c.label === runId));

      // Resume completions do NOT include active run yet
      const resumeCompBefore = await controller.getArgumentCompletions("resume ");
      assert.ok(!resumeCompBefore || !resumeCompBefore.some((c) => c.label === runId));

      // Pause the run
      await controller.execute(`pause ${runId}`);

      // Resume completions now include the paused run
      const resumeCompAfter = await controller.getArgumentCompletions("resume ");
      assert.ok(resumeCompAfter && resumeCompAfter.some((c) => c.label === runId));
    });
  });

  // =========================================================================
  // 3. Workflow Discovery & Listing (/workflow list)
  // =========================================================================
  describe("Workflow Discovery & Listing (/workflow list)", () => {
    it("discovers and lists workflow definitions in deterministic alphabetical order", async () => {
      const res = await controller.execute("list");
      assert.equal(res.ok, true);
      assert.equal(res.action, "list");

      // Verify all required fields are present in the output
      assert.match(res.output, /Discovered Workflows \(2\):/);
      assert.match(res.output, /ci-watcher \[fixed\]/);
      assert.match(res.output, /Description: Periodic CI status monitor/);
      assert.match(res.output, /Requires:\s+loop/);
      assert.match(res.output, /Active runs:\s+0/);

      assert.match(res.output, /example \[self-paced\]/);
      assert.match(res.output, /Description: Example self-paced workflow for task automation/);
      assert.match(res.output, /Requires:\s+loop, tmux/);
      assert.match(res.output, /Active runs:\s+0/);

      // Verify deterministic alphabetical ordering: "ci-watcher" before "example"
      const ciIndex = res.output.indexOf("ci-watcher");
      const exampleIndex = res.output.indexOf("example");
      assert.ok(ciIndex !== -1 && exampleIndex !== -1);
      assert.ok(ciIndex < exampleIndex, "ci-watcher should appear before example alphabetically");
    });

    it("displays active run count accurately when runs are running", async () => {
      await controller.execute("start example");
      const res = await controller.execute("list");
      assert.equal(res.ok, true);
      assert.match(res.output, /Active runs:\s+1/);
    });

    it("shows clean informative message when no definitions are found", async () => {
      const emptyDir = join(tempDir, "empty-proj");
      mkdirSync(emptyDir, { recursive: true });
      const emptyController = createWorkflowCommandController({
        registry,
        adapter,
        cwd: emptyDir,
      });

      const res = await emptyController.execute("list");
      assert.equal(res.ok, true);
      assert.match(res.output, /No workflow definitions found/);
    });
  });

  // =========================================================================
  // 4. Starting Workflows (/workflow start <name>)
  // =========================================================================
  describe("Starting Workflows (/workflow start <name>)", () => {
    it("validates definition, checks capabilities, creates durable run, and attaches scheduler", async () => {
      const res = await controller.execute("start example");
      assert.equal(res.ok, true);
      assert.equal(res.action, "start");
      assert.match(res.output, /Started workflow "example"/);
      assert.match(res.output, /run ID: wfrun-example-/);

      const runId = (res.data as any).runId;
      assert.ok(runId);

      // Verify durable run created in registry
      const run = registry.getRun(runId);
      assert.ok(run);
      assert.equal(run.workflow, "example");
      assert.equal(run.lifecycle, "active");
      assert.equal(run.step, "INITIAL");

      // Verify attached scheduler state
      const taskId = adapter.getLinkedTaskId(runId);
      assert.ok(taskId);
      const scheduledTasks = fakeLoopService.listTasks();
      assert.equal(scheduledTasks.length, 1);
      assert.equal(scheduledTasks[0].id, taskId);
    });

    it("requires workflow definition name argument", async () => {
      const res = await controller.execute("start");
      assert.equal(res.ok, false);
      assert.match(res.output, /Missing required argument <name>/);
    });

    it("fails with actionable error when definition is not found", async () => {
      const res = await controller.execute("start non-existent");
      assert.equal(res.ok, false);
      assert.match(res.output, /Workflow definition "non-existent" not found/);
      assert.match(res.output, /Run '\/workflow list'/);
    });

    it("fails with clear actionable error when required capabilities are missing", async () => {
      // Create controller with missing capabilities (lacks "tmux")
      const limitedController = createWorkflowCommandController({
        registry,
        adapter,
        cwd: tempDir,
        capabilities: ["loop"], // example requires "loop" and "tmux"
      });

      const res = await limitedController.execute("start example");
      assert.equal(res.ok, false);
      assert.match(res.output, /requires capabilities: \[tmux\] which are not currently available/);

      // Verify no orphan run was created
      assert.equal(registry.listRuns().length, 0);
      assert.equal(fakeLoopService.listTasks().length, 0);
    });

    it("fails cleanly when scheduler service is unavailable without creating orphaned run", async () => {
      fakeLoopService.setAvailable(false);

      const res = await controller.execute("start example");
      assert.equal(res.ok, false);
      assert.match(res.output, /pi-loop scheduler service is not available/);

      // Verify no active run remains in registry
      assert.equal(registry.getActiveRuns().length, 0);
    });
  });

  // =========================================================================
  // 5. Concurrency Enforcement & Clear Errors
  // =========================================================================
  describe("Concurrency Enforcement & Clear Errors", () => {
    it("enforces maxRuns: 1 and returns clear actionable concurrency error", async () => {
      const res1 = await controller.execute("start example");
      assert.equal(res1.ok, true);
      const runId1 = (res1.data as any).runId;

      // Attempting to start second concurrent run of "example" (maxRuns: 1)
      const res2 = await controller.execute("start example");
      assert.equal(res2.ok, false);
      assert.match(res2.output, /concurrency limit reached \(1\/1 nonterminal runs active\)/);
      assert.match(res2.output, new RegExp(`Active runs: \\[${runId1}\\]`));
    });

    it("treats paused runs as nonterminal and counting toward concurrency", async () => {
      const res1 = await controller.execute("start example");
      const runId1 = (res1.data as any).runId;

      // Pause the run
      await controller.execute(`pause ${runId1}`);

      // Concurrency limit is still occupied by paused run
      const res2 = await controller.execute("start example");
      assert.equal(res2.ok, false);
      assert.match(res2.output, /concurrency limit reached/);
    });

    it("frees concurrency slot when a run is stopped/cancelled", async () => {
      const res1 = await controller.execute("start example");
      const runId1 = (res1.data as any).runId;

      // Cancel the run
      await controller.execute(`stop ${runId1}`);

      // Now a new run can be started successfully
      const res2 = await controller.execute("start example");
      assert.equal(res2.ok, true);
      assert.match(res2.output, /Started workflow "example"/);
    });
  });

  // =========================================================================
  // 6. Status Inspection (/workflow status [run-id])
  // =========================================================================
  describe("Status Inspection (/workflow status [run-id])", () => {
    it("shows active runs in deterministic order with concise fields", async () => {
      const res1 = await controller.execute("start example");
      const runId1 = (res1.data as any).runId;

      await new Promise((r) => setTimeout(r, 5));

      const res2 = await controller.execute("start ci-watcher");
      const runId2 = (res2.data as any).runId;

      const statusRes = await controller.execute("status");
      assert.equal(statusRes.ok, true);
      assert.match(statusRes.output, /Active Workflow Runs \(2\):/);

      // Verify concise fields are present
      assert.match(statusRes.output, new RegExp(`• ${runId1}`));
      assert.match(statusRes.output, /Workflow:\s+example/);
      assert.match(statusRes.output, /Lifecycle:\s+active/);
      assert.match(statusRes.output, /Step:\s+INITIAL/);
      assert.match(statusRes.output, /Age:\s+\d+s/);
      assert.match(statusRes.output, /Next Wakeup:/);

      // Verify no raw scheduler task IDs (like task-self- or task-fixed-) appear in output
      assert.ok(!statusRes.output.includes("task-self-"));
      assert.ok(!statusRes.output.includes("task-fixed-"));

      // Verify deterministic order: runId1 (created first) before runId2
      const idx1 = statusRes.output.indexOf(runId1);
      const idx2 = statusRes.output.indexOf(runId2);
      assert.ok(idx1 !== -1 && idx2 !== -1);
      assert.ok(idx1 < idx2, "Earlier run must appear before later run");
    });

    it("displays blocker info when run is blocked", async () => {
      const res = await controller.execute("start example");
      const runId = (res.data as any).runId;

      registry.blockRun(runId, {
        reason: "Waiting for QA sign-off",
        requiresHuman: true,
      });

      const statusRes = await controller.execute("status");
      assert.equal(statusRes.ok, true);
      assert.match(statusRes.output, /Blocker:\s+Waiting for QA sign-off \(human action required\)/);
    });

    it("shows detailed inspection for a specific run ID (/workflow status <run-id>)", async () => {
      const res = await controller.execute("start example");
      const runId = (res.data as any).runId;

      registry.updateRun(runId, {
        data: { ticket: "PROJ-123", priority: "high" },
        incrementTurns: 3,
        incrementAttempts: 1,
      });

      const detailRes = await controller.execute(`status ${runId}`);
      assert.equal(detailRes.ok, true);
      assert.match(detailRes.output, new RegExp(`Workflow Run: ${runId}`));
      assert.match(detailRes.output, /Workflow:\s+example/);
      assert.match(detailRes.output, /Lifecycle:\s+active/);
      assert.match(detailRes.output, /Turns:\s+3/);
      assert.match(detailRes.output, /Attempts:\s+1/);
      // Privacy check: verify data keys are listed but secret values are NOT printed
      assert.match(detailRes.output, /Data Keys:\s+\[priority, ticket\] \(values omitted to prevent secret exposure\)/);
      assert.ok(!detailRes.output.includes("PROJ-123"), "Secret values must not be printed in status output");
      assert.ok(!detailRes.output.includes("high"));

      // Verify no raw scheduler task IDs are leaked
      assert.ok(!detailRes.output.includes("task-self-"));
    });

    it("supports unambiguous run ID prefix resolution", async () => {
      const res = await controller.execute("start example");
      const runId = (res.data as any).runId;
      const prefix = runId.slice(0, 16); // e.g. "wfrun-example-m7"

      const detailRes = await controller.execute(`status ${prefix}`);
      assert.equal(detailRes.ok, true);
      assert.match(detailRes.output, new RegExp(`Workflow Run: ${runId}`));
    });
  });

  // =========================================================================
  // 7. Workflow Definition Name vs Run ID Disambiguation
  // =========================================================================
  describe("Workflow Definition Name vs Run ID Disambiguation", () => {
    it("clearly rejects passing a run ID to 'start' with actionable guidance", async () => {
      const res1 = await controller.execute("start example");
      const runId = (res1.data as any).runId;

      const res2 = await controller.execute(`start ${runId}`);
      assert.equal(res2.ok, false);
      assert.match(res2.output, /appears to be a run ID, not a workflow definition name/);
      assert.match(res2.output, new RegExp(`\/workflow status ${runId}`));
      assert.match(res2.output, new RegExp(`\/workflow pause ${runId}`));
    });

    it("clearly rejects passing a definition name to run-targeted commands (status/pause/resume/stop)", async () => {
      // 1. status <definition-name>
      const resStatus = await controller.execute("status example");
      assert.equal(resStatus.ok, false);
      assert.match(resStatus.output, /"example" is a workflow definition name, not a run ID/);
      assert.match(resStatus.output, /\/workflow start example/);

      // 2. pause <definition-name>
      const resPause = await controller.execute("pause example");
      assert.equal(resPause.ok, false);
      assert.match(resPause.output, /"example" is a workflow definition name, not a run ID/);

      // 3. resume <definition-name>
      const resResume = await controller.execute("resume example");
      assert.equal(resResume.ok, false);
      assert.match(resResume.output, /"example" is a workflow definition name, not a run ID/);

      // 4. stop <definition-name>
      const resStop = await controller.execute("stop example");
      assert.equal(resStop.ok, false);
      assert.match(resStop.output, /"example" is a workflow definition name, not a run ID/);
    });

    it("gives clear actionable error when unknown run ID is provided", async () => {
      const res = await controller.execute("status wfrun-unknown-9999");
      assert.equal(res.ok, false);
      assert.match(res.output, /Workflow run "wfrun-unknown-9999" not found/);
      assert.match(res.output, /Run '\/workflow status' to see active runs/);
    });

    it("detects ambiguous run ID prefixes", async () => {
      // Manually register two runs with the same prefix using ci-watcher (maxRuns: 2)
      const def = (await controller.ensureDefinitionsLoaded()).get("ci-watcher")!;
      registry.createRun(def, { runId: "wfrun-test-ambig-1" });
      registry.createRun(def, { runId: "wfrun-test-ambig-2", existingPolicy: "fail" });

      const res = await controller.execute("status wfrun-test-ambig");
      assert.equal(res.ok, false);
      assert.match(res.output, /Ambiguous run ID prefix "wfrun-test-ambig"/);
      assert.match(res.output, /wfrun-test-ambig-1/);
      assert.match(res.output, /wfrun-test-ambig-2/);
    });
  });

  // =========================================================================
  // 8. Pausing Workflows (/workflow pause <run-id>)
  // =========================================================================
  describe("Pausing Workflows (/workflow pause <run-id>)", () => {
    it("persists paused state, stops scheduler task, and prevents automatic wakeups", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      assert.equal(fakeLoopService.listTasks().length, 1);

      const pauseRes = await controller.execute(`pause ${runId}`);
      assert.equal(pauseRes.ok, true);
      assert.match(pauseRes.output, /Paused workflow run/);
      assert.match(pauseRes.output, /Wakeups suspended/);

      // 1. Verify persisted in registry
      const run = registry.getRun(runId);
      assert.equal(run?.lifecycle, "paused");

      // 2. Verify scheduler task was stopped in pi-loop
      assert.equal(fakeLoopService.listTasks().length, 0);

      // 3. Verify durable loopTaskId is cleared on success
      assert.equal(run?.loopTaskId, undefined);

      // 4. Verify paused runs do NOT wake automatically on reconciliation
      await adapter.reconcile();
      assert.equal(fakeLoopService.listTasks().length, 0);
    });

    it("fails closed when scheduler service is unavailable during pause", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      assert.equal(fakeLoopService.listTasks().length, 1);

      // Disconnect scheduler service
      fakeLoopService.setAvailable(false);

      const pauseRes = await controller.execute(`pause ${runId}`);
      assert.equal(pauseRes.ok, false);
      assert.match(pauseRes.output, /pi-loop scheduler service is unavailable/);

      // Verify run remains active in registry (NOT silently set to paused)
      assert.equal(registry.getRun(runId)?.lifecycle, "active");
      assert.ok(adapter.getLinkedTaskId(runId));
    });

    it("fails closed and maintains mappings when a live task cannot be stopped by scheduler", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      const taskId = adapter.getLinkedTaskId(runId)!;

      // Mock stopTask to return false while keeping task in fakeLoopService.tasks
      const origStop = fakeLoopService.stopTask.bind(fakeLoopService);
      fakeLoopService.stopTask = () => false;

      try {
        const pauseRes = await controller.execute(`pause ${runId}`);
        assert.equal(pauseRes.ok, false);
        assert.match(pauseRes.output, /task is still active in scheduler service but could not be stopped/);

        // Verify run remains active in registry
        assert.equal(registry.getRun(runId)?.lifecycle, "active");
        // Verify internal mappings and linkage were NOT deleted
        assert.equal(adapter.getLinkedTaskId(runId), taskId);
      } finally {
        fakeLoopService.stopTask = origStop;
      }
    });

    it("clears stale linkage when listTasks confirms task absent and does not block pause forever", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      const taskId = adapter.getLinkedTaskId(runId)!;

      // Simulate task already absent from scheduler (e.g. expired or deleted externally)
      fakeLoopService.tasks.delete(taskId);

      // Pause should recognize the stale linkage, clear it, and succeed rather than blocking forever
      const pauseRes = await controller.execute(`pause ${runId}`);
      assert.equal(pauseRes.ok, true);
      assert.match(pauseRes.output, /Paused workflow run/);

      // Verify run is paused and stale linkage was cleared
      assert.equal(registry.getRun(runId)?.lifecycle, "paused");
      assert.equal(adapter.getLinkedTaskId(runId), undefined);
      assert.equal(registry.getRun(runId)?.loopTaskId, undefined);
    });

    it("is idempotent when pausing an already paused run", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;

      await controller.execute(`pause ${runId}`);
      const secondPause = await controller.execute(`pause ${runId}`);
      assert.equal(secondPause.ok, true);
      assert.match(secondPause.output, /is already paused/);
    });

    it("rejects pausing a terminal run", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;

      await controller.execute(`stop ${runId}`);
      const pauseRes = await controller.execute(`pause ${runId}`);
      assert.equal(pauseRes.ok, false);
      assert.match(pauseRes.output, /Cannot pause run.*run is in terminal state/);
    });
  });

  // =========================================================================
  // 9. Resuming Workflows (/workflow resume <run-id>)
  // =========================================================================
  describe("Resuming Workflows (/workflow resume <run-id>)", () => {
    it("revalidates capabilities, restores active state, and restores exactly one scheduler linkage", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;

      await controller.execute(`pause ${runId}`);
      assert.equal(fakeLoopService.listTasks().length, 0);

      // Resume run
      const resumeRes = await controller.execute(`resume ${runId}`);
      assert.equal(resumeRes.ok, true);
      assert.match(resumeRes.output, /Resumed workflow run/);
      assert.match(resumeRes.output, /Next iteration scheduled/);

      // 1. State restored to active
      const run = registry.getRun(runId);
      assert.equal(run?.lifecycle, "active");

      // 2. Exactly one scheduler task created and linked
      const tasks = fakeLoopService.listTasks();
      assert.equal(tasks.length, 1);
      assert.equal(adapter.getLinkedTaskId(runId), tasks[0].id);
      assert.equal(run?.loopTaskId, tasks[0].id);
    });

    it("fails resume when required capabilities have become unavailable", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      await controller.execute(`pause ${runId}`);

      // Reconfigure controller with missing "tmux" capability
      const revokedController = createWorkflowCommandController({
        registry,
        adapter,
        cwd: tempDir,
        capabilities: ["loop"], // example requires "loop" and "tmux"
      });

      const resumeRes = await revokedController.execute(`resume ${runId}`);
      assert.equal(resumeRes.ok, false);
      assert.match(resumeRes.output, /requires capabilities: \[tmux\] which are not currently available/);

      // Verify run stays paused and no scheduler task was created
      assert.equal(registry.getRun(runId)?.lifecycle, "paused");
      assert.equal(fakeLoopService.listTasks().length, 0);
    });

    it("safely resumes when on-disk definition was deleted (preserves frozen snapshot)", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      await controller.execute(`pause ${runId}`);

      // Delete the definition file from disk
      rmSync(join(workflowsDir, "example.md"), { force: true });
      await controller.reloadDefinitions();

      // Resume should succeed using frozen snapshot provenance
      const resumeRes = await controller.execute(`resume ${runId}`);
      assert.equal(resumeRes.ok, true);
      assert.match(resumeRes.output, /Resumed workflow run/);
      assert.equal(registry.getRun(runId)?.lifecycle, "active");
      assert.equal(fakeLoopService.listTasks().length, 1);
    });

    it("rejects resume with actionable error when on-disk definition mode conflicts with run snapshot", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      await controller.execute(`pause ${runId}`);

      // Modify definition on disk to conflict: change mode to "fixed"
      writeTestWorkflow(workflowsDir, "example", {
        mode: "fixed",
        interval: "10m",
        requires: ["loop", "tmux"],
      });
      await controller.reloadDefinitions();

      const resumeRes = await controller.execute(`resume ${runId}`);
      assert.equal(resumeRes.ok, false);
      assert.match(resumeRes.output, /conflicts with run snapshot mode "self-paced"/);
      assert.match(resumeRes.output, /Execution mode cannot change across iterations/);

      // Verify run was NOT resumed
      assert.equal(registry.getRun(runId)?.lifecycle, "paused");
      assert.equal(fakeLoopService.listTasks().length, 0);
    });

    it("rejects resume when on-disk definition has added unavailable required capabilities", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      await controller.execute(`pause ${runId}`);

      // Modify definition on disk to require an unavailable capability "docker"
      writeTestWorkflow(workflowsDir, "example", {
        mode: "self-paced",
        requires: ["loop", "tmux", "docker"],
      });
      await controller.reloadDefinitions();

      const resumeRes = await controller.execute(`resume ${runId}`);
      assert.equal(resumeRes.ok, false);
      assert.match(resumeRes.output, /requires additional capabilities: \[docker\]/);

      // Verify run stays paused
      assert.equal(registry.getRun(runId)?.lifecycle, "paused");
    });

    it("rolls back to previous lifecycle when task scheduling fails during resume", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      await controller.execute(`pause ${runId}`);
      assert.equal(registry.getRun(runId)?.lifecycle, "paused");

      // Temporarily break loop service scheduleSelfPaced by throwing error
      const origSchedule = fakeLoopService.scheduleSelfPaced.bind(fakeLoopService);
      fakeLoopService.scheduleSelfPaced = () => {
        throw new Error("Simulated loop service scheduling failure");
      };

      try {
        const resumeRes = await controller.execute(`resume ${runId}`);
        assert.equal(resumeRes.ok, false);
        assert.match(resumeRes.output, /Simulated loop service scheduling failure/);

        // Verify run was rolled back to "paused" in registry and not left in "active"
        const run = registry.getRun(runId)!;
        assert.equal(run.lifecycle, "paused", "Run must roll back to paused on scheduling error");
        assert.equal(fakeLoopService.listTasks().length, 0);
      } finally {
        fakeLoopService.scheduleSelfPaced = origSchedule;
      }
    });

    it("is idempotent when resuming an already active run", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;

      const resumeRes = await controller.execute(`resume ${runId}`);
      assert.equal(resumeRes.ok, true);
      assert.match(resumeRes.output, /is already active/);
    });
  });

  // =========================================================================
  // 10. Stopping Workflows (/workflow stop <run-id>) & Isolation
  // =========================================================================
  describe("Stopping Workflows (/workflow stop <run-id>) & Isolation", () => {
    it("cancels run, stops its scheduler task, retains durable history, and is not marked completed", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      assert.equal(fakeLoopService.listTasks().length, 1);

      const stopRes = await controller.execute(`stop ${runId}`);
      assert.equal(stopRes.ok, true);
      assert.match(stopRes.output, /Stopped workflow run/);
      assert.match(stopRes.output, /status: cancelled/);
      assert.match(stopRes.output, /Durable history retained/);

      // 1. Run is cancelled (not completed)
      const run = registry.getRun(runId);
      assert.equal(run?.lifecycle, "cancelled");
      assert.notEqual(run?.lifecycle, "completed");

      // 2. Scheduler task stopped
      assert.equal(fakeLoopService.listTasks().length, 0);

      // 3. Durable loopTaskId cleared in registry
      assert.equal(run?.loopTaskId, undefined);

      // 4. Durable session entries retained in branch
      const branchEntries = fakeSession.getBranch();
      assert.ok(branchEntries.length >= 2); // create + cancel
    });

    it("fails closed when scheduler service is unavailable during stop", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      assert.equal(fakeLoopService.listTasks().length, 1);

      // Disconnect scheduler service
      fakeLoopService.setAvailable(false);

      const stopRes = await controller.execute(`stop ${runId}`);
      assert.equal(stopRes.ok, false);
      assert.match(stopRes.output, /pi-loop scheduler service is unavailable/);

      // Verify run is NOT cancelled
      assert.equal(registry.getRun(runId)?.lifecycle, "active");
    });

    it("clears stale linkage when listTasks confirms task absent and does not block stop forever", async () => {
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      const taskId = adapter.getLinkedTaskId(runId)!;

      // Simulate task already absent from scheduler
      fakeLoopService.tasks.delete(taskId);

      const stopRes = await controller.execute(`stop ${runId}`);
      assert.equal(stopRes.ok, true);
      assert.match(stopRes.output, /Stopped workflow run/);

      // Verify run is cancelled and stale linkage was cleared
      assert.equal(registry.getRun(runId)?.lifecycle, "cancelled");
      assert.equal(adapter.getLinkedTaskId(runId), undefined);
    });

    it("strictly isolates cancellation from other workflow runs and the user's ordinary /loop", async () => {
      // 1. Create a user's ordinary /loop task (no workflow ID in prompt)
      const userLoopTask = fakeLoopService.scheduleSelfPaced("User interactive /loop prompt");

      // 2. Start two independent workflow runs
      const resA = await controller.execute("start example");
      const runIdA = (resA.data as any).runId;

      const resB = await controller.execute("start ci-watcher");
      const runIdB = (resB.data as any).runId;

      assert.equal(fakeLoopService.listTasks().length, 3);

      // 3. Stop Run A
      await controller.execute(`stop ${runIdA}`);

      // 4. Verify Run B and user /loop task are strictly preserved
      const remainingTasks = fakeLoopService.listTasks();
      assert.equal(remainingTasks.length, 2);

      const remainingIds = remainingTasks.map((t) => t.id);
      assert.ok(remainingIds.includes(userLoopTask.id), "User /loop task must NEVER be stopped");
      assert.ok(
        remainingIds.includes(adapter.getLinkedTaskId(runIdB)!),
        "Run B scheduler task must not be stopped"
      );

      assert.equal(registry.getRun(runIdA)?.lifecycle, "cancelled");
      assert.equal(registry.getRun(runIdB)?.lifecycle, "active");
    });
  });

  // =========================================================================
  // 11. Definition Reloading & Running Snapshot Stability
  // =========================================================================
  describe("Definition Reloading & Running Snapshot Stability (/workflow reload)", () => {
    it("refreshes definitions for future runs without mutating running run snapshot", async () => {
      // 1. Start run with original definition
      const startRes = await controller.execute("start example");
      const runId = (startRes.data as any).runId;
      const initialRun = registry.getRun(runId)!;
      assert.equal(initialRun.snapshot.description, "Example self-paced workflow for task automation");

      // 2. Modify workflow definition file on disk
      writeTestWorkflow(workflowsDir, "example", {
        description: "UPDATED: Completely new workflow description v2",
        mode: "self-paced",
        requires: ["loop", "tmux"],
      });

      // 3. Add a brand new workflow on disk
      writeTestWorkflow(workflowsDir, "deployer", {
        description: "Automated production deployment",
        mode: "self-paced",
        requires: ["loop"],
      });

      // 4. Execute /workflow reload
      const reloadRes = await controller.execute("reload");
      assert.equal(reloadRes.ok, true);
      assert.match(reloadRes.output, /Reloaded workflow definitions \(3 discovered\)/);
      assert.match(reloadRes.output, /existing runs remain unaffected/);

      // 5. Authoritative verification: the running run's snapshot is COMPLETELY unchanged
      const runningRun = registry.getRun(runId)!;
      assert.equal(
        runningRun.snapshot.description,
        "Example self-paced workflow for task automation",
        "Running snapshot must never be mutated by reload"
      );

      // 6. Future run of the new workflow uses updated definitions
      const deployRes = await controller.execute("start deployer");
      assert.equal(deployRes.ok, true);
      const deployRunId = (deployRes.data as any).runId;
      assert.equal(registry.getRun(deployRunId)?.workflow, "deployer");
    });
  });

  // =========================================================================
  // 12. Non-TUI Mode Sensible Text Fallback
  // =========================================================================
  describe("Non-TUI Mode Sensible Text Fallback", () => {
    it("emits sensible text fallback to outputStream when mode is not TUI or hasUI is false", async () => {
      const mockCtx: any = {
        mode: "print",
        hasUI: false,
        ui: {
          notify: (msg: string, type: string) => {
            // Test mock notify
          },
        },
      };

      capturedOutputs = [];
      const res = await controller.handleCommand("list", mockCtx);
      assert.equal(res.ok, true);
      assert.ok(capturedOutputs.length > 0);
      assert.match(capturedOutputs[0], /Discovered Workflows/);
    });

    it("notifies via ctx.ui.notify when available", async () => {
      let notifiedMsg = "";
      let notifyType = "";

      const mockCtx: any = {
        mode: "tui",
        hasUI: true,
        ui: {
          notify: (msg: string, type: string) => {
            notifiedMsg = msg;
            notifyType = type;
          },
        },
      };

      await controller.handleCommand("help", mockCtx);
      assert.equal(notifyType, "info");
      assert.match(notifiedMsg, /Workflow Commands/);
    });
  });

  // =========================================================================
  // 13. Pi Extension Command Registration
  // =========================================================================
  describe("Pi Extension Command Registration", () => {
    it("registers /workflow and /goal commands with description, completions, and handler", () => {
      const registered = new Map<string, any>();

      const mockPi: any = {
        events: null,
        registerTool: () => {},
        registerCommand: (name: string, options: any) => {
          registered.set(name, options);
        },
        on: () => () => {},
        appendEntry: () => {},
      };

      workflowExtension(mockPi);

      const workflowOptions = registered.get("workflow");
      assert.ok(workflowOptions, "expected /workflow to be registered");
      assert.match(workflowOptions.description, /Manage workflow definitions and runs/);
      assert.equal(typeof workflowOptions.handler, "function");
      assert.equal(typeof workflowOptions.getArgumentCompletions, "function");

      const goalOptions = registered.get("goal");
      assert.ok(goalOptions, "expected /goal to be registered");
      assert.match(goalOptions.description, /goal/i);
      assert.equal(typeof goalOptions.handler, "function");
      assert.equal(typeof goalOptions.getArgumentCompletions, "function");
    });
  });

  // =========================================================================
  // 14. Goal visibility in /workflow status (Issue #9)
  // =========================================================================
  describe("Goal visibility in /workflow status", () => {
    it("labels goal runs with type goal while named workflows remain type workflow", async () => {
      const goalController = createGoalCommandController({ workflowController: controller });

      const started = await goalController.execute("verify goal visibility");
      assert.equal(started.ok, true, started.output);
      const goalRunId = (started.data as any).runId as string;

      const detail = await controller.executeStatusRun(goalRunId);
      assert.equal(detail.ok, true);
      assert.match(detail.output, /Type:\s+goal/);
      assert.match(detail.output, /Objective:\s+verify goal visibility/);
      assert.match(detail.output, /Verification:\s+not configured/);
      assert.equal((detail.data as any).type, "goal");

      const list = await controller.executeStatusList();
      assert.match(list.output, /Type:\s+goal/);
      const listed = (list.data as any).runs.find((r: any) => r.id === goalRunId);
      assert.equal(listed.type, "goal");

      // A named workflow run remains an ordinary workflow.
      const namedStart = await controller.executeStart("example");
      assert.equal(namedStart.ok, true, namedStart.output);
      const namedRunId = (namedStart.data as any).runId as string;
      const namedDetail = await controller.executeStatusRun(namedRunId);
      assert.match(namedDetail.output, /Type:\s+workflow/);
    });
  });

  // =========================================================================
  // 15. Bounded run history command (Issue #10)
  // =========================================================================
  describe("/workflow history", () => {
    it("shows a deterministic oldest-first bounded history without raw task ids or data values", async () => {
      const started = await controller.execute("start example");
      const runId = (started.data as any).runId as string;
      registry.transitionStep(runId, { toStep: "STEP_A", reason: "progress made" });
      registry.updateRun(runId, { data: { secretValue: "TOP-SECRET-VALUE" } });

      const hist = await controller.execute(`history ${runId}`);
      assert.equal(hist.ok, true, hist.output);
      assert.match(hist.output, new RegExp(`Run History: ${runId}`));
      assert.match(hist.output, /create/);
      assert.match(hist.output, /transition/);

      const entries = (hist.data as any).entries as Array<{ action: string; eventId: string }>;
      assert.equal(entries[0].action, "create");
      assert.ok(entries.some((e) => e.action === "transition"));

      // Privacy: no raw scheduler task IDs, data values, or secrets.
      assert.ok(!hist.output.includes("task-self-"));
      assert.ok(!hist.output.includes("TOP-SECRET-VALUE"));
      assert.ok(!JSON.stringify(hist.data).includes("TOP-SECRET-VALUE"));
    });

    it("bounds the output with limit and reports truncation over the lifetime window", async () => {
      const started = await controller.execute("start example");
      const runId = (started.data as any).runId as string;

      const lifetime = MAX_RUN_HISTORY_ENTRIES + 20;
      for (let i = 0; i < lifetime; i++) {
        registry.transitionStep(runId, { toStep: `STEP_${i}` });
      }

      const full = (await controller.execute(`history ${runId}`)).data as any;
      const hist = await controller.execute(`history ${runId} 5`);
      assert.equal(hist.ok, true, hist.output);
      const data = hist.data as any;
      assert.equal(data.entries.length, 5);
      assert.equal(data.limited, true);
      assert.equal(data.truncated, true);
      assert.equal(data.total, full.total);
      assert.equal(data.dropped, full.dropped);
      assert.match(hist.output, /5 shown/);
      assert.match(hist.output, /Older events are not shown/);
      // Newest retained events are the most recent transitions.
      assert.match(data.entries[data.entries.length - 1].summary, new RegExp(`STEP_${lifetime - 1}\\b`));
    });

    it("rejects missing, ambiguous, definition, unknown and invalid-limit arguments", async () => {
      const missing = await controller.execute("history");
      assert.equal(missing.ok, false);
      assert.match(missing.output, /Missing required argument/);

      const asDefinition = await controller.execute("history example");
      assert.equal(asDefinition.ok, false);
      assert.match(asDefinition.output, /workflow definition name, not a run ID/);

      const unknown = await controller.execute("history wfrun-does-not-exist");
      assert.equal(unknown.ok, false);
      assert.match(unknown.output, /not found/);

      const started = await controller.execute("start example");
      const runId = (started.data as any).runId as string;

      const extra = await controller.execute(`history ${runId} 5 extra`);
      assert.equal(extra.ok, false);
      assert.match(extra.output, /Unexpected argument\(s\) for '\/workflow history'/);

      const badLimit = await controller.execute(`history ${runId} abc`);
      assert.equal(badLimit.ok, false);
      assert.match(badLimit.output, /Invalid history limit/);
    });

    it("is offered in help and argument completions", async () => {
      const help = await controller.execute("help");
      assert.match(help.output, /\/workflow history <run-id>/);

      const completions = await controller.getArgumentCompletions("hi");
      assert.ok(completions);
      assert.ok(completions!.some((c) => c.value.trim() === "history"));
    });
  });
});
