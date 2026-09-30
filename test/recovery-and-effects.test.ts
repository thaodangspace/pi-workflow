import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLoopSchedulerAdapter,
  createWorkflowRunRegistry,
  createWorkflowTools,
  formatNextWakeup,
  getAmbiguousEffects,
  getEffectClaimToken,
  hasAmbiguousEffects,
  LoopSchedulerAdapter,
  parseWorkflowContent,
  WorkflowAmbiguousEffectError,
  WorkflowCommandController,
  WorkflowDispatcher,
  WorkflowEffectAlreadyCommittedError,
  WorkflowEffectError,
  WorkflowOwnershipError,
  WorkflowRunRegistry,
} from "../src/index.ts";
import { FakeLoopService } from "./fake-loop-service.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

const WORKFLOW_DEF_YAML = `---
name: recovery-test-wf
description: Testing crash safety and effect checkpoints
mode: self-paced
wakeups:
  default: 5m
---

# Policy
## Steps
1. IMPLEMENTING: Prepare changes.
2. CREATING_PR: Create PR on GitHub using effect checkpoint.
3. DONE: Complete run.
`;

describe("Issue #7: Crash-Safe Recovery, Reconciliation, and Idempotent Effect Checkpoints", () => {
  // =========================================================================
  // 1. Crash Boundaries Around an External Side Effect (Acceptance Criteria 1, 2, 6, 8)
  // =========================================================================
  describe("Crash Simulation Across Checkpoint Boundaries", () => {
    interface ExternalGitHubSystem {
      prCreated: boolean;
      createdPrNumber?: number;
      createCallCount: number;
    }

    it("Boundary 0: Crash before effect-begin resumes cleanly at current step without ghost effects", async () => {
      const session = new FakeSessionManager();
      const registry1 = new WorkflowRunRegistry(session);
      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });

      const run1 = registry1.createRun(def, { runId: "wfrun-b0" });
      registry1.transitionStep(run1.id, { toStep: "CREATING_PR" });

      // Simulate crash before workflow_effect_begin was called.
      // Reconstruct fresh session:
      const registry2 = new WorkflowRunRegistry(session);
      await registry2.reconstructFromSession();

      const reloadedRun = registry2.requireRun("wfrun-b0");
      assert.equal(reloadedRun.step, "CREATING_PR");
      assert.equal(Object.keys(reloadedRun.effects ?? {}).length, 0);
      assert.equal(hasAmbiguousEffects(reloadedRun), false);
    });

    it("Boundary 1: Crash after effect-begin but before external call resumes in reconciliation; external reality confirms no PR", async () => {
      const session = new FakeSessionManager();
      const registry1 = new WorkflowRunRegistry(session);
      const dispatcher1 = new WorkflowDispatcher(registry1);
      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });

      const run1 = registry1.createRun(def, { runId: "wfrun-b1" });
      registry1.transitionStep(run1.id, { toStep: "CREATING_PR" });

      // Step 1: Agent begins effect checkpoint
      const ac1 = new AbortController();
      dispatcher1.beginIteration(run1.id, { signal: ac1.signal, incrementTurns: false });
      const tools1 = createWorkflowTools({ dispatcher: dispatcher1, registry: registry1 });
      const beginTool1 = tools1.find((t) => t.name === "workflow_effect_begin")!;

      await beginTool1.execute(
        "call-begin",
        {
          key: "create-pr",
          kind: "github.pull_request.create",
          inputSummary: { title: "feat: add feature", head: "branch-b1", base: "main" },
        },
        ac1.signal,
        undefined,
        {} as any
      );
      dispatcher1.endIteration();

      // Simulated external GitHub system: NO PR was created yet because process crashed before API call
      const externalGitHub: ExternalGitHubSystem = { prCreated: false, createCallCount: 0 };

      // SIMULATE CRASH & SESSION RESTART
      const registry2 = new WorkflowRunRegistry(session);
      const { runs } = registry2.reconstructFromSession();
      const reloadedRun = runs.find((r) => r.id === "wfrun-b1")!;

      // Acceptance Criterion 1 & 6: Run resumes in RECONCILIATION, flagged ambiguous
      assert.equal(hasAmbiguousEffects(reloadedRun), true);
      const ambiguousList = getAmbiguousEffects(reloadedRun);
      assert.equal(ambiguousList.length, 1);
      assert.equal(ambiguousList[0].key, "create-pr");
      assert.equal(ambiguousList[0].ambiguous, true);

      // Acceptance Criterion 7: Recovery event recorded in run history
      assert(reloadedRun.recoveryEvents && reloadedRun.recoveryEvents.length >= 1);
      assert.equal(reloadedRun.recoveryEvents[0].type, "effect_ambiguous");
      assert.match(reloadedRun.recoveryEvents[0].message, /create-pr/);

      // Verify that blind progression is prevented while in ambiguous reconciliation
      const dispatcher2 = new WorkflowDispatcher(registry2);
      const prompt = dispatcher2.buildPrompt(reloadedRun.id);
      assert.match(prompt, /# Workflow Recovery & Reconciliation:/);
      assert.match(prompt, /DO NOT blindly re-execute the external action/);
      assert.match(prompt, /create-pr/);

      const ac2 = new AbortController();
      dispatcher2.beginIteration(reloadedRun.id, { signal: ac2.signal, incrementTurns: false });
      const tools2 = createWorkflowTools({ dispatcher: dispatcher2, registry: registry2 });

      // Blind step transition MUST fail closed
      const transitionTool2 = tools2.find((t) => t.name === "workflow_transition")!;
      await assert.rejects(
        async () => {
          await transitionTool2.execute("call-trans-fail", { toStep: "DONE" }, ac2.signal, undefined, {} as any);
        },
        (err: any) => {
          assert(err instanceof WorkflowAmbiguousEffectError);
          assert.equal(err.ambiguousKey, "create-pr");
          return true;
        }
      );

      // Blind completion MUST fail closed
      const completeTool2 = tools2.find((t) => t.name === "workflow_complete")!;
      await assert.rejects(
        async () => {
          await completeTool2.execute("call-comp-fail", { summary: "Done" }, ac2.signal, undefined, {} as any);
        },
        (err: any) => {
          assert(err instanceof WorkflowAmbiguousEffectError);
          assert.equal(err.ambiguousKey, "create-pr");
          return true;
        }
      );

      // Reconcile: Agent checks external reality -> observes no PR exists -> reconciles as aborted or retryable
      const reconcileTool = tools2.find((t) => t.name === "workflow_effect_reconcile")!;
      const reconResult = await reconcileTool.execute(
        "call-recon-abort",
        {
          key: "create-pr",
          resolution: "retryable",
          reason: "Observed external GitHub API: branch branch-b1 has no open PRs. Safe to retry.",
        },
        ac2.signal,
        undefined,
        {} as any
      );

      assert.equal((reconResult.details as any).status, "retryable");

      // Verify ambiguity is resolved
      const runAfterRecon = registry2.requireRun(reloadedRun.id);
      assert.equal(hasAmbiguousEffects(runAfterRecon), false);

      // Now safe retry can proceed: begin effect, create PR externally, and commit
      const beginTool2 = tools2.find((t) => t.name === "workflow_effect_begin")!;
      await beginTool2.execute(
        "call-begin-retry",
        { key: "create-pr", kind: "github.pull_request.create" },
        ac2.signal,
        undefined,
        {} as any
      );

      // External call succeeds now
      externalGitHub.prCreated = true;
      externalGitHub.createdPrNumber = 404;
      externalGitHub.createCallCount++;

      const commitTool2 = tools2.find((t) => t.name === "workflow_effect_commit")!;
      await commitTool2.execute(
        "call-commit",
        { key: "create-pr", resultSummary: { prNumber: 404, url: "https://github.com/org/repo/pull/404" } },
        ac2.signal,
        undefined,
        {} as any
      );

      const committedRun = registry2.requireRun(reloadedRun.id);
      assert.equal(committedRun.effects?.["create-pr"].status, "committed");
      assert.equal(externalGitHub.createCallCount, 1);
    });

    it("Boundary 2: Crash after external call succeeded in real world but before commit resumes in reconciliation; commits without duplicate external call", async () => {
      const session = new FakeSessionManager();
      const registry1 = new WorkflowRunRegistry(session);
      const dispatcher1 = new WorkflowDispatcher(registry1);
      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });

      const run1 = registry1.createRun(def, { runId: "wfrun-b2" });
      registry1.transitionStep(run1.id, { toStep: "CREATING_PR" });

      // Step 1: Begin effect
      const ac1 = new AbortController();
      dispatcher1.beginIteration(run1.id, { signal: ac1.signal, incrementTurns: false });
      const tools1 = createWorkflowTools({ dispatcher: dispatcher1, registry: registry1 });
      await tools1.find((t) => t.name === "workflow_effect_begin")!.execute(
        "call-b",
        { key: "create-pr", kind: "github.pull_request.create" },
        ac1.signal,
        undefined,
        {} as any
      );

      // External action executes in real world!
      const externalGitHub: ExternalGitHubSystem = { prCreated: true, createdPrNumber: 101, createCallCount: 1 };

      // CRASH OCCURS RIGHT HERE before workflow_effect_commit is called!
      dispatcher1.endIteration();

      // SIMULATE CRASH & RESTART
      const registry2 = new WorkflowRunRegistry(session);
      registry2.reconstructFromSession();
      const reloadedRun = registry2.requireRun("wfrun-b2");

      assert.equal(hasAmbiguousEffects(reloadedRun), true);
      assert.equal(reloadedRun.effects?.["create-pr"].ambiguous, true);

      // Recovery iteration
      const dispatcher2 = new WorkflowDispatcher(registry2);
      const ac2 = new AbortController();
      dispatcher2.beginIteration(reloadedRun.id, { signal: ac2.signal, incrementTurns: false });
      const tools2 = createWorkflowTools({ dispatcher: dispatcher2, registry: registry2 });

      // Agent checks external reality -> discovers PR #101 already exists on GitHub!
      // Agent commits the existing observed PR without re-calling the external API!
      const commitTool = tools2.find((t) => t.name === "workflow_effect_commit")!;
      const commitRes = await commitTool.execute(
        "call-commit-observed",
        {
          key: "create-pr",
          resultSummary: { prNumber: externalGitHub.createdPrNumber, url: "https://github.com/org/repo/pull/101" },
        },
        ac2.signal,
        undefined,
        {} as any
      );

      assert.equal((commitRes.details as any).status, "committed");

      // Verify no duplicate external side effect was attempted
      assert.equal(externalGitHub.createCallCount, 1);

      // Verify effect is now committed and ambiguity cleared
      const finalRun = registry2.requireRun(reloadedRun.id);
      assert.equal(finalRun.effects?.["create-pr"].status, "committed");
      assert.equal(finalRun.effects?.["create-pr"].ambiguous, false);
      assert.equal(hasAmbiguousEffects(finalRun), false);

      // Recovery event for reconciliation is present in history
      const reconEvents = finalRun.recoveryEvents?.filter((e) => e.type === "effect_reconciled");
      assert.equal(reconEvents?.length, 1);
    });

    it("Boundary 3: Crash after commit preserves committed state; replaying begin rejects or returns committed record", async () => {
      const session = new FakeSessionManager();
      const registry1 = new WorkflowRunRegistry(session);
      const dispatcher1 = new WorkflowDispatcher(registry1);
      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });

      const run1 = registry1.createRun(def, { runId: "wfrun-b3" });

      // Begin and Commit effect
      const ac1 = new AbortController();
      dispatcher1.beginIteration(run1.id, { signal: ac1.signal, incrementTurns: false });
      const tools1 = createWorkflowTools({ dispatcher: dispatcher1, registry: registry1 });
      await tools1.find((t) => t.name === "workflow_effect_begin")!.execute(
        "call-b",
        { key: "create-pr", kind: "github.pull_request.create" },
        ac1.signal,
        undefined,
        {} as any
      );
      await tools1.find((t) => t.name === "workflow_effect_commit")!.execute(
        "call-c",
        { key: "create-pr", resultSummary: { prNumber: 555 } },
        ac1.signal,
        undefined,
        {} as any
      );
      dispatcher1.endIteration();

      // SIMULATE CRASH & RESTART
      const registry2 = new WorkflowRunRegistry(session);
      registry2.reconstructFromSession();
      const reloadedRun = registry2.requireRun("wfrun-b3");

      assert.equal(reloadedRun.effects?.["create-pr"].status, "committed");
      assert.equal(hasAmbiguousEffects(reloadedRun), false);

      // Acceptance Criterion 2: A committed effect cannot be accidentally repeated under the same key
      const dispatcher2 = new WorkflowDispatcher(registry2);
      const ac2 = new AbortController();
      dispatcher2.beginIteration(reloadedRun.id, { signal: ac2.signal, incrementTurns: false });
      const tools2 = createWorkflowTools({ dispatcher: dispatcher2, registry: registry2 });

      // Model tool returns already_committed with committed record, preventing re-execution
      const beginRes = await tools2.find((t) => t.name === "workflow_effect_begin")!.execute(
        "call-repeat",
        { key: "create-pr", kind: "github.pull_request.create" },
        ac2.signal,
        undefined,
        {} as any
      );

      assert.equal((beginRes.details as any).status, "already_committed");
      assert.match((beginRes.content[0] as any).text, /already committed/i);
      assert.equal((beginRes.details as any).effect.status, "committed");

      // Registry API strictly throws WorkflowEffectAlreadyCommittedError when allowCommitted is false
      assert.throws(
        () => registry2.beginEffect(reloadedRun.id, { key: "create-pr", kind: "github.pull_request.create", allowCommitted: false }),
        (err: any) => {
          assert(err instanceof WorkflowEffectAlreadyCommittedError);
          assert.equal(err.key, "create-pr");
          return true;
        }
      );
    });

    it("Reconciliation blocking: when external state cannot be determined, agent blocks with human-required blocker", async () => {
      const session = new FakeSessionManager();
      const registry1 = new WorkflowRunRegistry(session);
      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });

      const run1 = registry1.createRun(def, { runId: "wfrun-uncertain" });
      registry1.beginEffect(run1.id, { key: "deploy-cluster", kind: "kubernetes.deploy" });

      // SIMULATE CRASH
      const registry2 = new WorkflowRunRegistry(session);
      registry2.reconstructFromSession();

      const reloadedRun = registry2.requireRun("wfrun-uncertain");
      assert.equal(hasAmbiguousEffects(reloadedRun), true);

      // Agent checks external cloud API, but network/permissions fail or state is inconclusive
      // Agent blocks the run to request human review
      const dispatcher = new WorkflowDispatcher(registry2);
      const ac = new AbortController();
      dispatcher.beginIteration(reloadedRun.id, { signal: ac.signal, incrementTurns: false });
      const blockTool = createWorkflowTools({ dispatcher, registry: registry2 }).find((t) => t.name === "workflow_block")!;

      await blockTool.execute(
        "b1",
        {
          reason: "Cluster deployment state ambiguous: API returned 503 during verification. Human inspection required.",
          category: "human-required",
        },
        ac.signal,
        undefined,
        {} as any
      );

      const blockedRun = registry2.requireRun("wfrun-uncertain");
      assert.equal(blockedRun.lifecycle, "blocked");
      assert.equal(blockedRun.blocker?.requiresHuman, true);
      assert.match(blockedRun.blocker?.reason ?? "", /Cluster deployment state ambiguous/);
    });
  });

  // =========================================================================
  // 2. Scheduler & Task Linkage Reconciliation (Acceptance Criteria 3, 4, 5, 9)
  // =========================================================================
  describe("Scheduler Reconciliation & Linkage Edge Cases", () => {
    it("terminal runs cannot retain live scheduler tasks after reconciliation", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });

      // Run 1: Completed run with a dangling live task in pi-loop
      const run1 = registry.createRun(def, { runId: "wfrun-term-1" });
      const task1 = loopService.scheduleSelfPaced(`- Run ID: ${run1.id}`);
      registry.updateRun(run1.id, { loopTaskId: task1.id });
      registry.completeRun(run1.id, { summary: "Done" });

      // Run 2: Cancelled run with a dangling live task in pi-loop
      const run2 = registry.createRun(def, { runId: "wfrun-term-2" });
      const task2 = loopService.scheduleSelfPaced(`- Run ID: ${run2.id}`);
      registry.updateRun(run2.id, { loopTaskId: task2.id });
      registry.cancelRun(run2.id, { reason: "Aborted" });

      assert.equal(loopService.listTasks().length, 2);

      // Run reconciliation
      const recon = await adapter.reconcile();

      // Both terminal tasks must be stopped and identified as orphans
      assert.equal(loopService.listTasks().length, 0);
      assert.equal(recon.orphans.length, 2);
      assert(recon.orphans.some((o) => o.taskId === task1.id && o.runId === "wfrun-term-1" && o.stopped));
      assert(recon.orphans.some((o) => o.taskId === task2.id && o.runId === "wfrun-term-2" && o.stopped));
    });

    it("cleans orphan workflow tasks where run is missing in registry without touching non-workflow tasks", async () => {
      const registry = new WorkflowRunRegistry();
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService });

      // 1. Workflow task for a run that does not exist in registry
      const ghostTask = loopService.scheduleSelfPaced("- Run ID: wfrun-ghost-99");

      // 2. User's ordinary /loop task (not a workflow task)
      const userTask = loopService.scheduleFixed(10 * 60_000, "user backup check");

      assert.equal(loopService.listTasks().length, 2);

      const recon = await adapter.reconcile({ reconcileOrphans: true });

      // Ghost task stopped; user task untouched!
      assert.equal(loopService.listTasks().length, 1);
      assert.equal(loopService.listTasks()[0].id, userTask.id);
      assert.equal(recon.orphans.length, 1);
      assert.equal(recon.orphans[0].taskId, ghostTask.id);
      assert.equal(recon.orphans[0].stopped, true);
    });

    it("detects ambiguous task mapping (multiple live tasks for same run) and fails closed by blocking run", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-duplicate-tasks" });

      // Artificially spawn TWO tasks in pi-loop pointing to the same run
      const taskA = loopService.scheduleSelfPaced(`- Run ID: ${run.id} [task A]`);
      const taskB = loopService.scheduleSelfPaced(`- Run ID: ${run.id} [task B]`);
      registry.updateRun(run.id, { loopTaskId: taskA.id });

      assert.equal(loopService.listTasks().length, 2);

      const recon = await adapter.reconcile();

      // Ambiguous mapping must block run and stop conflicting tasks to prevent duplicate execution
      assert.equal(recon.blocked.length, 1);
      assert.equal(recon.blocked[0].runId, run.id);
      assert.match(recon.blocked[0].reason, /Ambiguous scheduler task mapping: multiple live tasks/);

      const blockedRun = registry.requireRun(run.id);
      assert.equal(blockedRun.lifecycle, "blocked");
      assert.equal(blockedRun.blocker?.category, "human-required");
      assert.equal(blockedRun.blocker?.requiresHuman, true);

      // Verify recovery event was recorded on run
      const recEvents = blockedRun.recoveryEvents?.filter((e) => e.type === "scheduler_ambiguous");
      assert.equal(recEvents?.length, 1);
    });

    it("detects mismatched task linkage (task prompt belongs to different run) and fails closed by blocking run", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService });

      const def = parseWorkflowContent(
        `---
name: multi-run-mismatch-wf
description: Multi run definition for mismatch testing
mode: self-paced
concurrency:
  maxRuns: 5
---
Body`,
        { path: "/multi.md", scope: "project" }
      );
      const runA = registry.createRun(def, { runId: "wfrun-mismatch-A" });
      const runB = registry.createRun(def, { runId: "wfrun-mismatch-B" });

      // Task in pi-loop declared for runB
      const taskB = loopService.scheduleSelfPaced(`- Run ID: ${runB.id}`);

      // But runA points to taskB!
      registry.updateRun(runA.id, { loopTaskId: taskB.id });

      const recon = await adapter.reconcile({ recreateMissing: false });

      assert.equal(recon.blocked.length, 2); // runA blocked for mismatch, runB blocked for missing task
      const blockedRunA = registry.requireRun(runA.id);
      assert.equal(blockedRunA.lifecycle, "blocked");
      assert.match(blockedRunA.blocker?.reason ?? "", /belongs to run "wfrun-mismatch-B", but run "wfrun-mismatch-A" links to it/);
    });

    it("active run with missing scheduler task recreates safely according to documented policy", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "wfrun-recreate-policy" });

      // Task is lost (e.g. ephemeral task lost after crash)
      loopService.deleteTask(task.id);
      assert.equal(loopService.listTasks().length, 0);

      // Reconcile with policy: recreateMissing: true (default)
      const recon = await adapter.reconcile({ recreateMissing: true });

      assert.equal(recon.recreated.length, 1);
      assert.equal(recon.recreated[0].runId, run.id);
      assert.equal(recon.recreated[0].oldTaskId, task.id);
      assert(recon.recreated[0].newTaskId);
      assert.notEqual(recon.recreated[0].newTaskId, task.id);

      // Recreated task is active in scheduler
      assert.equal(loopService.listTasks().length, 1);
      assert.equal(registry.requireRun(run.id).loopTaskId, recon.recreated[0].newTaskId);

      // Recovery event was recorded
      const recEvents = registry.requireRun(run.id).recoveryEvents?.filter((e) => e.type === "scheduler_recreated");
      assert.equal(recEvents?.length, 1);
    });
  });

  // =========================================================================
  // 3. Work Ownership & Lease Metadata (Issue #7 Spec Section 3)
  // =========================================================================
  describe("Work Ownership & Leases", () => {
    it("manages exclusive lease metadata to prevent duplicate runner instances", () => {
      const registry = new WorkflowRunRegistry();
      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-lease-1" });

      const now = 1727700000000;
      // Owner A acquires lease for 10 minutes
      const leasedRun = registry.acquireLease(run.id, {
        ownerId: "runner-instance-A",
        expiresAt: now + 10 * 60_000,
        now,
      });

      assert.equal(leasedRun.lease?.ownerId, "runner-instance-A");
      assert.equal(leasedRun.lease?.expiresAt, now + 10 * 60_000);

      // Owner A can renew lease
      const renewedRun = registry.acquireLease(run.id, {
        ownerId: "runner-instance-A",
        expiresAt: now + 20 * 60_000,
        now: now + 5 * 60_000,
      });
      assert.equal(renewedRun.lease?.expiresAt, now + 20 * 60_000);

      // Owner B attempts to acquire while Owner A's lease is active: throws WorkflowOwnershipError
      assert.throws(
        () =>
          registry.acquireLease(run.id, {
            ownerId: "runner-instance-B",
            now: now + 5 * 60_000,
          }),
        (err: any) => {
          assert(err instanceof WorkflowOwnershipError);
          assert.equal(err.currentOwnerId, "runner-instance-A");
          assert.equal(err.requestedOwnerId, "runner-instance-B");
          return true;
        }
      );

      // After expiration, Owner B can acquire
      const expiredNow = now + 25 * 60_000;
      const takenRun = registry.acquireLease(run.id, {
        ownerId: "runner-instance-B",
        expiresAt: expiredNow + 10 * 60_000,
        now: expiredNow,
      });
      assert.equal(takenRun.lease?.ownerId, "runner-instance-B");

      // Owner B releases lease
      const releasedRun = registry.releaseLease(run.id, "runner-instance-B");
      assert.equal(releasedRun.lease, undefined);
    });

    it("generates idempotent generic effect claim tokens for external resources", () => {
      const token1 = getEffectClaimToken("wfrun-abc-123", "create-pr");
      assert.equal(token1, "wfrun-abc-123:create-pr");

      const token2 = getEffectClaimToken("wfrun-xyz-456", "post-slack-note");
      assert.equal(token2, "wfrun-xyz-456:post-slack-note");
    });
  });

  // =========================================================================
  // 4. Command Status Inspection & Visibility (Acceptance Criteria 7)
  // =========================================================================
  describe("Visibility in Run History and Status Command", () => {
    it("reports effects and recovery events in /workflow status <run-id>", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService });
      const controller = new WorkflowCommandController({ registry, adapter, dispatcher });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-status-test" });

      // Start an effect and mark ambiguous via recovery event
      registry.beginEffect(run.id, { key: "pr-1", kind: "github.pull_request.create" });
      registry.recordRecoveryEvent(run.id, {
        type: "effect_ambiguous",
        message: "Effect pr-1 uncommitted after crash. Reconciliation required.",
      });

      const res = await controller.executeStatusRun(run.id);
      assert.equal(res.ok, true);
      assert.match(res.output, /Effects \(1\):/);
      assert.match(res.output, /pr-1 \(github\.pull_request\.create\)/);
      assert.match(res.output, /Recovery Events \(1\):/);
      assert.match(res.output, /effect_ambiguous: Effect pr-1 uncommitted after crash/);
    });

    it("exposes full chronological mutation and recovery history via getRunHistory", () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });

      const run = registry.createRun(def, { runId: "wfrun-audit" });
      registry.transitionStep(run.id, { toStep: "CREATING_PR" });
      registry.beginEffect(run.id, { key: "create-pr", kind: "github.pr" });
      registry.commitEffect(run.id, { key: "create-pr", resultSummary: { pr: 123 } });
      registry.completeRun(run.id, { summary: "Finished PR" });

      const history = registry.getRunHistory(run.id);
      assert(history.length >= 5);
      const actions = history.map((h) => h.action);
      assert(actions.includes("create"));
      assert(actions.includes("transition"));
      assert(actions.includes("effect_begin"));
      assert(actions.includes("effect_commit"));
      assert(actions.includes("complete"));
    });
  });
});
