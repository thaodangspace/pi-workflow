import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLoopSchedulerAdapter,
  createWorkflowRunRegistry,
  createWorkflowTools,
  extractWorkflowOwnerId,
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

      assert.equal(recon.blocked.length, 1); // runA blocked; runB safely reconnects its matching task
      assert.equal(recon.matched.length, 1);
      assert.equal(recon.matched[0].runId, runB.id);
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
  // 3b. Production Ownership Enforcement, Takeover, and Linkage Safety
  // =========================================================================
  describe("Production Ownership Enforcement, Takeover & Linkage Safety", () => {
    it("same-session dual instances: only the lease owner may intercept, bind, or dispatch", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcherA = new WorkflowDispatcher(registry);
      const dispatcherB = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapterA = createLoopSchedulerAdapter({
        registry,
        dispatcher: dispatcherA,
        service: loopService,
        ownerId: "owner-A",
      });
      const adapterB = createLoopSchedulerAdapter({
        registry,
        dispatcher: dispatcherB,
        service: loopService,
        ownerId: "owner-B",
      });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const { run, task } = await adapterA.startRun(def, { runId: "wfrun-dual" });

      const leased = registry.requireRun(run.id);
      assert.equal(leased.lease?.ownerId, "owner-A");
      assert.equal(extractWorkflowOwnerId(task.prompt), "owner-A");
      assert.equal(loopService.listTasks().length, 1);

      // Non-owner must not reconnect, adopt, or recreate the run's task.
      const reconB = await adapterB.reconcile();
      assert.equal(reconB.matched.length, 0);
      assert.equal(reconB.recreated.length, 0);
      assert(reconB.diagnostics.some((d) => d.code === "run-leased-by-other"));
      assert.equal(loopService.listTasks().length, 1);

      // Non-owner must not intercept or bind the run's turn.
      assert.equal(adapterB.handleBeforeAgentStart({ prompt: task.prompt }), undefined);
      assert.equal(adapterB.handleTurnStart({ signal: new AbortController().signal }, task.prompt), undefined);

      // Non-owner programmatic dispatch fails closed with owner diagnostics.
      assert.throws(
        () => adapterB.dispatchIteration(run.id),
        (err: any) => {
          assert(err instanceof WorkflowOwnershipError);
          assert.equal(err.currentOwnerId, "owner-A");
          assert.equal(err.requestedOwnerId, "owner-B");
          return true;
        }
      );

      // Non-owner programmatic wakeup reschedule also fails closed.
      await assert.rejects(
        async () => {
          await adapterB.scheduleWakeup({ runId: run.id, delayMs: 60_000 });
        },
        (err: any) => {
          assert(err instanceof WorkflowOwnershipError);
          assert.equal(err.currentOwnerId, "owner-A");
          return true;
        }
      );

      // Non-owner cancellation also fails closed; the owner's task remains alive.
      await assert.rejects(
        async () => {
          await adapterB.cancelWakeup(run.id);
        },
        (err: any) => {
          assert(err instanceof WorkflowOwnershipError);
          assert.equal(err.currentOwnerId, "owner-A");
          return true;
        }
      );
      assert.equal(loopService.listTasks().length, 1);

      // Owner still intercepts, binds, and can use model tools.
      const before = adapterA.handleBeforeAgentStart({ prompt: task.prompt });
      assert(before?.message);
      const ac = new AbortController();
      const binding = adapterA.handleTurnStart({ signal: ac.signal });
      assert(binding);
      assert.equal(binding.ownerId, "owner-A");

      const getContextTool = createWorkflowTools({ dispatcher: dispatcherA, registry }).find(
        (t) => t.name === "workflow_get_context"
      )!;
      const ctxResult = await getContextTool.execute("ctx", {}, ac.signal, undefined, {} as any);
      assert.equal((ctxResult.details as any).runId, run.id);

      adapterA.handleAgentSettled();
      assert.equal(dispatcherA.getActiveIteration(), undefined);
    });

    it("expired lease is taken over by another instance, then the former owner is denied", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcherA = new WorkflowDispatcher(registry);
      const dispatcherB = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapterA = createLoopSchedulerAdapter({
        registry,
        dispatcher: dispatcherA,
        service: loopService,
        ownerId: "owner-A",
      });
      const adapterB = createLoopSchedulerAdapter({
        registry,
        dispatcher: dispatcherB,
        service: loopService,
        ownerId: "owner-B",
      });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const { run, task } = await adapterA.startRun(def, { runId: "wfrun-takeover" });
      const expiry = registry.requireRun(run.id).lease!.expiresAt!;

      // B tries before expiry: denied/skipped, no duplicate task.
      const beforeExpiry = await adapterB.reconcile({ now: expiry - 1 });
      assert.equal(beforeExpiry.matched.length, 0);
      assert.equal(loopService.listTasks().length, 1);
      assert.equal(registry.requireRun(run.id).lease?.ownerId, "owner-A");

      // After expiry: B deterministically takes over the SAME task and records the lease.
      const afterExpiry = await adapterB.reconcile({ now: expiry + 1 });
      assert.equal(afterExpiry.matched.length, 1);
      assert.equal(afterExpiry.matched[0].taskId, task.id);
      assert.equal(afterExpiry.recreated.length, 0);
      assert.equal(loopService.listTasks().length, 1);
      assert.equal(registry.requireRun(run.id).lease?.ownerId, "owner-B");

      // Former owner A is now denied dispatch of the run it no longer owns.
      assert.throws(
        () => adapterA.dispatchIteration(run.id),
        (err: any) => {
          assert(err instanceof WorkflowOwnershipError);
          assert.equal(err.currentOwnerId, "owner-B");
          return true;
        }
      );

      // New owner B can dispatch.
      const binding = adapterB.dispatchIteration(run.id, { incrementTurns: false });
      assert.equal(binding.ownerId, "owner-B");
      dispatcherB.endIteration();
    });

    it("model tools fail closed if ownership of the run is taken over mid-iteration", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({
        registry,
        dispatcher,
        service: loopService,
        ownerId: "owner-A",
      });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "wfrun-mid-takeover" });

      const ac = new AbortController();
      const binding = adapter.handleTurnStart({ signal: ac.signal }, task.prompt);
      assert(binding);

      // Simulate another instance forcibly taking over after expiry while this turn is live.
      const future = Date.now() + 60 * 60_000;
      registry.acquireLease(run.id, {
        ownerId: "owner-B",
        expiresAt: Date.now() + 90 * 60_000,
        now: future,
      });

      const continueTool = createWorkflowTools({ dispatcher, registry }).find(
        (t) => t.name === "workflow_continue"
      )!;
      await assert.rejects(
        async () => {
          await continueTool.execute("call", { delay: "5m" }, ac.signal, undefined, {} as any);
        },
        (err: any) => {
          assert(err instanceof WorkflowOwnershipError);
          assert.equal(err.currentOwnerId, "owner-B");
          assert.equal(err.requestedOwnerId, "owner-A");
          return true;
        }
      );
    });

    it("live task with stale run linkage is reconnected deterministically without creating a duplicate", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({
        registry,
        dispatcher,
        service: loopService,
        ownerId: "owner-A",
      });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "wfrun-stale-link" });

      // The original task is gone and run.loopTaskId is stale; a replacement live task
      // exists in pi-loop whose prompt declares this run (and its owner).
      loopService.deleteTask(task.id);
      const liveTask = loopService.scheduleSelfPaced(dispatcher.buildPrompt(run.id));
      registry.updateRun(run.id, { loopTaskId: "task-ghost-missing" });

      const recon = await adapter.reconcile();

      assert.equal(recon.matched.length, 1);
      assert.equal(recon.matched[0].runId, run.id);
      assert.equal(recon.matched[0].taskId, liveTask.id);
      assert.equal(recon.recreated.length, 0);
      assert.equal(loopService.listTasks().length, 1);
      assert.equal(loopService.listTasks()[0].id, liveTask.id);
      assert.equal(registry.requireRun(run.id).loopTaskId, liveTask.id);
      assert.equal(adapter.getLinkedTaskId(run.id), liveTask.id);

      const recEvents = registry.requireRun(run.id).recoveryEvents?.filter((e) => e.type === "scheduler_reconnected");
      assert.equal(recEvents?.length, 1);
    });

    it("terminal run linked to a user /loop task clears linkage but never touches the user task", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService, ownerId: "owner-A" });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-term-userlink" });
      const userTask = loopService.scheduleFixed(5 * 60_000, "user maintenance loop");
      registry.updateRun(run.id, { loopTaskId: userTask.id });
      registry.completeRun(run.id, { summary: "Done" });

      const recon = await adapter.reconcile();

      // User /loop task is strictly preserved.
      assert.equal(loopService.listTasks().length, 1);
      assert.equal(loopService.listTasks()[0].id, userTask.id);
      assert(recon.diagnostics.some((d) => d.code === "cross-point-user-task" && d.runId === run.id));
      assert.equal(recon.orphans.length, 0);
    });

    it("terminal run linked to another live run's task never stops the other run's task", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService, ownerId: "owner-A" });

      const def = parseWorkflowContent(
        `---
name: multi-run-crosslink-wf
description: cross link definition
mode: self-paced
concurrency:
  maxRuns: 5
---
Body`,
        { path: "/multi.md", scope: "project" }
      );
      const runT = registry.createRun(def, { runId: "wfrun-term-T" });
      const runU = registry.createRun(def, { runId: "wfrun-term-U" });
      const taskU = loopService.scheduleSelfPaced(`- Run ID: ${runU.id}`);
      registry.updateRun(runT.id, { loopTaskId: taskU.id });
      registry.completeRun(runT.id, { summary: "T done" });

      const recon = await adapter.reconcile();

      // Other run's task stays alive and is reconnected to its true owner.
      assert(loopService.listTasks().some((t) => t.id === taskU.id));
      assert(recon.diagnostics.some((d) => d.code === "cross-point-other-run" && d.runId === runT.id));
      assert.equal(recon.matched.some((m) => m.runId === runU.id && m.taskId === taskU.id), true);
      assert.equal(registry.requireRun(runT.id).lifecycle, "completed");
    });

    it("active run linked to a user task blocks fail-closed and preserves the user task", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService, ownerId: "owner-A" });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-active-userlink" });
      const userTask = loopService.scheduleFixed(5 * 60_000, "user maintenance loop");
      registry.updateRun(run.id, { loopTaskId: userTask.id });

      const recon = await adapter.reconcile();

      assert(loopService.listTasks().some((t) => t.id === userTask.id));
      assert.equal(recon.blocked.length, 1);
      assert.equal(recon.blocked[0].runId, run.id);
      const blocked = registry.requireRun(run.id);
      assert.equal(blocked.lifecycle, "blocked");
      assert.equal(blocked.blocker?.category, "human-required");
      assert.equal(blocked.loopTaskId, undefined);
    });

    it("crash after effect-begin: blind re-begin and unrelated new effects are refused until reconciled", async () => {
      const session = new FakeSessionManager();
      const registry1 = new WorkflowRunRegistry(session);
      const dispatcher1 = new WorkflowDispatcher(registry1);
      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });

      const run1 = registry1.createRun(def, { runId: "wfrun-blind-rebegin" });
      registry1.transitionStep(run1.id, { toStep: "CREATING_PR" });

      const ac1 = new AbortController();
      dispatcher1.beginIteration(run1.id, { signal: ac1.signal, incrementTurns: false });
      const tools1 = createWorkflowTools({ dispatcher: dispatcher1, registry: registry1 });
      await tools1.find((t) => t.name === "workflow_effect_begin")!.execute(
        "begin",
        { key: "create-pr", kind: "github.pull_request.create" },
        ac1.signal,
        undefined,
        {} as any
      );
      dispatcher1.endIteration();

      // Crash & restart
      const registry2 = new WorkflowRunRegistry(session);
      registry2.reconstructFromSession();
      const reloaded = registry2.requireRun("wfrun-blind-rebegin");
      assert.equal(hasAmbiguousEffects(reloaded), true);

      const dispatcher2 = new WorkflowDispatcher(registry2);
      const ac2 = new AbortController();
      dispatcher2.beginIteration(reloaded.id, { signal: ac2.signal, incrementTurns: false });
      const tools2 = createWorkflowTools({ dispatcher: dispatcher2, registry: registry2 });
      const beginTool = tools2.find((t) => t.name === "workflow_effect_begin")!;

      // Re-begin of the same ambiguous key must be refused (no blind replay).
      await assert.rejects(
        async () => {
          await beginTool.execute("rebegin", { key: "create-pr", kind: "github.pull_request.create" }, ac2.signal, undefined, {} as any);
        },
        (err: any) => {
          assert(err instanceof WorkflowAmbiguousEffectError);
          assert.equal(err.ambiguousKey, "create-pr");
          return true;
        }
      );

      // An unrelated new effect is also refused while an ambiguous effect is outstanding.
      await assert.rejects(
        async () => {
          await beginTool.execute("other", { key: "post-notice", kind: "slack.post" }, ac2.signal, undefined, {} as any);
        },
        (err: any) => {
          assert(err instanceof WorkflowAmbiguousEffectError);
          return true;
        }
      );

      const stillAmbiguous = registry2.requireRun(reloaded.id);
      assert.equal(stillAmbiguous.effects?.["create-pr"].status, "started");
      assert.equal(stillAmbiguous.effects?.["post-notice"], undefined);
    });

    it("scheduled run interrupted after effect-begin resumes reconciliation after lease takeover", async () => {
      const session = new FakeSessionManager();
      const registry1 = new WorkflowRunRegistry(session);
      const dispatcher1 = new WorkflowDispatcher(registry1);
      const loopService = new FakeLoopService();
      const adapterA = createLoopSchedulerAdapter({
        registry: registry1,
        dispatcher: dispatcher1,
        service: loopService,
        ownerId: "owner-A",
      });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const { run, task } = await adapterA.startRun(def, { runId: "wfrun-crash-leased" });
      registry1.transitionStep(run.id, { toStep: "CREATING_PR" });

      // Real external action intent persisted, then process crashes before commit.
      const ac1 = new AbortController();
      dispatcher1.beginIteration(run.id, {
        ownerId: "owner-A",
        signal: ac1.signal,
        schedulerPort: adapterA.getSchedulerPort(run.id),
        incrementTurns: false,
      });
      await createWorkflowTools({ dispatcher: dispatcher1, registry: registry1 })
        .find((t) => t.name === "workflow_effect_begin")!
        .execute("b", { key: "create-pr", kind: "github.pull_request.create" }, ac1.signal, undefined, {} as any);
      dispatcher1.endIteration();

      // CRASH & RELOAD: reconstruct durable state; started effect becomes ambiguous.
      const registry2 = new WorkflowRunRegistry(session);
      registry2.reconstructFromSession();
      const reloaded = registry2.requireRun(run.id);
      assert.equal(hasAmbiguousEffects(reloaded), true);

      const dispatcher2 = new WorkflowDispatcher(registry2);
      assert.match(dispatcher2.buildPrompt(run.id), /RECOVERY REQUIRED/);

      // New instance must not steal the still-leased run before expiry.
      const adapterB = createLoopSchedulerAdapter({
        registry: registry2,
        dispatcher: dispatcher2,
        service: loopService,
        ownerId: "owner-B",
      });
      const preExpiry = await adapterB.reconcile();
      assert.equal(preExpiry.matched.length, 0);
      assert(preExpiry.diagnostics.some((d) => d.code === "run-leased-by-other"));

      // After expiry, the new instance takes over the SAME task and resumes reconciliation.
      const expiry = reloaded.lease!.expiresAt!;
      const postExpiry = await adapterB.reconcile({ now: expiry + 1 });
      assert.equal(postExpiry.matched.length, 1);
      assert.equal(postExpiry.matched[0].taskId, task.id);
      assert.equal(registry2.requireRun(run.id).lease?.ownerId, "owner-B");

      const acB = new AbortController();
      const binding = adapterB.handleTurnStart({ signal: acB.signal }, dispatcher2.buildPrompt(run.id));
      assert(binding);
      assert.equal(binding.ownerId, "owner-B");

      // Blind completion is refused while the effect remains ambiguous.
      const completeTool = createWorkflowTools({ dispatcher: dispatcher2, registry: registry2 }).find(
        (t) => t.name === "workflow_complete"
      )!;
      await assert.rejects(
        async () => {
          await completeTool.execute("c", { summary: "done" }, acB.signal, undefined, {} as any);
        },
        (err: any) => {
          assert(err instanceof WorkflowAmbiguousEffectError);
          assert.equal(err.ambiguousKey, "create-pr");
          return true;
        }
      );
      adapterB.handleAgentSettled();
    });

    it("scheduleRun denies a non-owner BEFORE budget exhaustion can cancel/block the run", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapterA = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService, ownerId: "owner-A" });
      const adapterB = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService, ownerId: "owner-B" });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-budget-owner", budget: { maxTurns: 1 } });
      // Exhaust the turn budget and place a live lease owned by A.
      registry.updateRun(run.id, { turns: 1 });
      registry.acquireLease(run.id, { ownerId: "owner-A", expiresAt: Date.now() + 15 * 60_000 });

      assert.equal(registry.requireRun(run.id).lifecycle, "active");

      // Non-owner scheduling must fail on ownership WITHOUT running the budget
      // cancel/block mutation first.
      await assert.rejects(
        async () => {
          await adapterB.scheduleRun(run.id);
        },
        (err: any) => {
          assert(err instanceof WorkflowOwnershipError);
          assert.equal(err.currentOwnerId, "owner-A");
          return true;
        }
      );

      const after = registry.requireRun(run.id);
      assert.equal(after.lifecycle, "active");
      assert.equal(after.blocker, undefined);
      assert.equal(after.lease?.ownerId, "owner-A");
      assert.equal(loopService.listTasks().length, 0);
    });

    it("beginIteration denies a non-owner BEFORE budget exhaustion can cancel/block the run", () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const def = parseWorkflowContent(
        `---
name: begin-budget-wf
description: begin iteration budget ownership definition
mode: self-paced
concurrency:
  maxRuns: 2
---
Body`,
        { path: "/begin-budget.md", scope: "project" }
      );

      // Case 1: default onExhaustion "block".
      const blockRun = registry.createRun(def, {
        runId: "wfrun-begin-budget-block",
        budget: { maxTurns: 1 },
      });
      registry.updateRun(blockRun.id, { turns: 1 });
      registry.acquireLease(blockRun.id, { ownerId: "owner-A", expiresAt: Date.now() + 15 * 60_000 });
      assert.equal(registry.requireRun(blockRun.id).lifecycle, "active");

      // Case 2: onExhaustion "cancel".
      const cancelRun = registry.createRun(def, {
        runId: "wfrun-begin-budget-cancel",
        budget: { maxTurns: 1, onExhaustion: "cancel" },
      });
      registry.updateRun(cancelRun.id, { turns: 1 });
      registry.acquireLease(cancelRun.id, { ownerId: "owner-A", expiresAt: Date.now() + 15 * 60_000 });
      assert.equal(registry.requireRun(cancelRun.id).lifecycle, "active");

      for (const run of [blockRun, cancelRun]) {
        // Explicit non-owner dispatch is refused.
        assert.throws(
          () => dispatcher.beginIteration(run.id, { ownerId: "owner-B" }),
          (err: any) => {
            assert(err instanceof WorkflowOwnershipError);
            assert.equal(err.currentOwnerId, "owner-A");
            return true;
          }
        );

        // Omitting the owner must not be treated as takeover of a live lease.
        assert.throws(
          () => dispatcher.beginIteration(run.id),
          (err: any) => {
            assert(err instanceof WorkflowOwnershipError);
            return true;
          }
        );

        // Crucially, the exhausted run was NOT mutated by the budget check.
        const after = registry.requireRun(run.id);
        assert.equal(after.lifecycle, "active", "non-owner dispatch must not mutate the run to blocked/cancelled");
        assert.equal(after.blocker, undefined);
        assert.equal(after.completion, undefined);
        assert.equal(after.lease?.ownerId, "owner-A");
      }
    });

    it("direct control refuses to stop a task cross-linked to another run and preserves it", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService, ownerId: "owner-A" });
      const controller = new WorkflowCommandController({ registry, adapter, dispatcher, cwd: process.cwd() });

      const def = parseWorkflowContent(
        `---
name: ctrl-crosslink-wf
description: control cross link definition
mode: self-paced
concurrency:
  maxRuns: 5
---
Body`,
        { path: "/multi.md", scope: "project" }
      );
      const runA = registry.createRun(def, { runId: "wfrun-ctrl-A" });
      const runB = registry.createRun(def, { runId: "wfrun-ctrl-B" });
      const taskB = loopService.scheduleSelfPaced(`- Run ID: ${runB.id}`);
      // Corrupt linkage: runA points at runB's live task.
      registry.updateRun(runA.id, { loopTaskId: taskB.id });

      const pauseRes = await controller.executePause(runA.id);
      assert.equal(pauseRes.ok, false);
      assert.match(pauseRes.output, /Refusing to stop scheduler task/);
      assert(loopService.listTasks().some((t) => t.id === taskB.id));
      assert.equal(registry.requireRun(runA.id).lifecycle, "active");

      const stopRes = await controller.executeStop(runA.id);
      assert.equal(stopRes.ok, false);
      assert.match(stopRes.output, /Refusing to stop scheduler task/);
      assert(loopService.listTasks().some((t) => t.id === taskB.id));
      assert.equal(registry.requireRun(runA.id).lifecycle, "active");
    });

    it("direct control refuses to stop a user /loop task cross-linked to a run and preserves it", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService, ownerId: "owner-A" });
      const controller = new WorkflowCommandController({ registry, adapter, dispatcher, cwd: process.cwd() });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-ctrl-userlink" });
      const userTask = loopService.scheduleFixed(5 * 60_000, "user maintenance loop");
      registry.updateRun(run.id, { loopTaskId: userTask.id });

      const pauseRes = await controller.executePause(run.id);
      assert.equal(pauseRes.ok, false);
      assert.match(pauseRes.output, /Refusing to stop scheduler task/);
      assert(loopService.listTasks().some((t) => t.id === userTask.id));
      assert.equal(registry.requireRun(run.id).lifecycle, "active");

      const stopRes = await controller.executeStop(run.id);
      assert.equal(stopRes.ok, false);
      assert(loopService.listTasks().some((t) => t.id === userTask.id));
      assert.equal(registry.requireRun(run.id).lifecycle, "active");
    });

    it("direct control still stops a correctly linked task and preserves unrelated user tasks", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService, ownerId: "owner-A" });
      const controller = new WorkflowCommandController({ registry, adapter, dispatcher, cwd: process.cwd() });

      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "wfrun-ctrl-ok" });
      const userTask = loopService.scheduleFixed(5 * 60_000, "user maintenance loop");

      const pauseRes = await controller.executePause(run.id);
      assert.equal(pauseRes.ok, true);
      assert.equal(registry.requireRun(run.id).lifecycle, "paused");
      assert.equal(loopService.listTasks().some((t) => t.id === task.id), false);
      assert(loopService.listTasks().some((t) => t.id === userTask.id));
      assert.equal(adapter.getLinkedTaskId(run.id), undefined);
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

    it("records the synthesized effect_ambiguous recovery event in run history after reload", () => {
      const session = new FakeSessionManager();
      const registry1 = new WorkflowRunRegistry(session);
      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });

      const run1 = registry1.createRun(def, { runId: "wfrun-history-ambig" });
      registry1.beginEffect(run1.id, { key: "create-pr", kind: "github.pull_request.create" });

      // Reload from durable session entries.
      const registry2 = new WorkflowRunRegistry();
      const result1 = registry2.reconstructFromSession(session);
      const reloaded1 = result1.runs.find((r) => r.id === "wfrun-history-ambig")!;
      assert.equal(hasAmbiguousEffects(reloaded1), true);

      const expectedEventId = "recov-wfrun-history-ambig-create-pr";
      const startedAt = reloaded1.effects!["create-pr"].startedAt;

      // The synthesized recovery event is exposed in run history (issue #7 acceptance).
      const historyHit = registry2
        .getRunHistory(reloaded1.id)
        .filter((h) => h.eventId === expectedEventId);
      assert.equal(historyHit.length, 1);
      assert.equal(historyHit[0].action, "recovery");
      assert.match(historyHit[0].summary, /effect_ambiguous/);
      assert.match(historyHit[0].summary, /create-pr/);
      assert.equal(historyHit[0].timestamp, startedAt);
      assert.equal((historyHit[0].details as any)?.synthesized, true);

      // The recovery event itself carries the same deterministic id and flags synthesized.
      const recEvent = reloaded1.recoveryEvents!.find((e) => e.eventId === expectedEventId)!;
      assert.equal(recEvent.type, "effect_ambiguous");
      assert.equal((recEvent.details as any)?.synthesized, true);

      // Repeated reconstruction is deterministic and never duplicates the synthesized entry.
      const result2 = registry2.reconstructFromSession(session);
      const reloaded2 = result2.runs.find((r) => r.id === "wfrun-history-ambig")!;
      assert.deepEqual(reloaded2, reloaded1);
      assert.equal(reloaded2.history!.filter((h) => h.eventId === expectedEventId).length, 1);
      assert.equal(reloaded2.recoveryEvents!.filter((e) => e.eventId === expectedEventId).length, 1);

      // The refresh() path (session_start/session_tree) is idempotent too.
      registry2.refresh();
      const reloaded3 = registry2.requireRun("wfrun-history-ambig");
      assert.deepEqual(reloaded3, reloaded1);
      assert.equal(reloaded3.history!.filter((h) => h.eventId === expectedEventId).length, 1);
    });

    it("marks started effects ambiguous after reload even for paused/blocked nonterminal runs", () => {
      const session = new FakeSessionManager();
      const registry1 = new WorkflowRunRegistry(session);
      const def = parseWorkflowContent(WORKFLOW_DEF_YAML, { path: "/rec.md", scope: "project" });

      const run1 = registry1.createRun(def, { runId: "wfrun-paused-ambig" });
      registry1.beginEffect(run1.id, { key: "deploy", kind: "kubernetes.deploy" });
      registry1.pauseRun(run1.id, { reason: "Paused mid-effect" });

      const registry2 = new WorkflowRunRegistry(session);
      registry2.reconstructFromSession();
      const reloaded = registry2.requireRun("wfrun-paused-ambig");

      assert.equal(reloaded.lifecycle, "paused");
      assert.equal(hasAmbiguousEffects(reloaded), true);
      assert.equal(
        reloaded.recoveryEvents!.some(
          (e) => e.type === "effect_ambiguous" && e.eventId === "recov-wfrun-paused-ambig-deploy"
        ),
        true
      );
      assert.equal(
        reloaded.history!.some((h) => h.eventId === "recov-wfrun-paused-ambig-deploy"),
        true
      );
    });
  });
});
