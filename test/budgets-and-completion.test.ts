import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workflowExtension, {
  createLoopSchedulerAdapter,
  createWorkflowDispatcher,
  createWorkflowRunRegistry,
  createWorkflowTools,
  createWorkflowVerifyTool,
  extractWorkflowRunId,
  formatNextWakeup,
  parseWorkflowContent,
  WorkflowBudgetExhaustedError,
  WorkflowCommandController,
  WorkflowDispatcher,
  WorkflowRunError,
  WorkflowRunRegistry,
  WorkflowUnsupportedBudgetError,
  WorkflowValidationError,
} from "../src/index.ts";
import { FakeLoopService, TestEventBus } from "./fake-loop-service.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

const WORKFLOW_WITH_TURNS_BUDGET = `---
name: bounded-workflow
description: Workflow with maxTurns hard budget
mode: self-paced
budget:
  maxTurns: 2
  maxAttempts: 3
wakeups:
  default: 5m
---
# Bounded Workflow
Work carefully within budget.
`;

const WORKFLOW_WITH_DURATION_BUDGET = `---
name: duration-workflow
description: Workflow with maxDuration hard budget
mode: self-paced
budget:
  maxDuration: 100ms
wakeups:
  default: 5m
---
# Duration Workflow
`;

const WORKFLOW_WITH_VERIFY = `---
name: verify-workflow
description: Workflow with completion verification gate
mode: self-paced
budget:
  maxTurns: 10
wakeups:
  default: 5m
completion:
  requireSummary: true
  requireEvidence: true
  verify: true
  maxVerificationAttempts: 2
  returnStep: IMPLEMENTING
  verifierPrompt: |
    Verify all deliverables and ensure evidence is verifiable.
---
# Verify Workflow
Follow the strict verification gate.
`;

describe("Issue #6: Budgets, Completion Gates, and Blocked/Paused Semantics", () => {
  // =========================================================================
  // 1. Enforceable Budgets & Hard Limit Enforcement
  // =========================================================================
  describe("Hard Budget Enforcement", () => {
    it("enforces maxTurns budget: prevents autonomous iteration and follow-up when exhausted", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      const def = parseWorkflowContent(WORKFLOW_WITH_TURNS_BUDGET, { path: "/test.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-budget-turns-1" });

      const ac1 = new AbortController();
      const binding1 = dispatcher.beginIteration(run.id, { signal: ac1.signal });
      assert.equal(binding1.runId, run.id);
      assert.equal(registry.requireRun(run.id).turns, 1);
      dispatcher.endIteration(binding1.token);

      const ac2 = new AbortController();
      const binding2 = dispatcher.beginIteration(run.id, { signal: ac2.signal });
      assert.equal(registry.requireRun(run.id).turns, 2); // Reached maxTurns: 2

      // During turn 2, attempting workflow_continue must detect budget exhaustion, block run, and throw
      const tools = createWorkflowTools({ dispatcher, registry });
      const continueTool = tools.find((t) => t.name === "workflow_continue")!;

      const fakeSchedulerPort = {
        cancelled: [] as string[],
        scheduled: [] as any[],
        scheduleWakeup(params: any) {
          this.scheduled.push(params);
        },
        cancelWakeup(runId: string) {
          this.cancelled.push(runId);
        },
      };

      // Set schedulerPort on active binding
      (binding2 as any).schedulerPort = fakeSchedulerPort;

      await assert.rejects(
        async () => {
          await continueTool.execute(
            "call-c-exhaust",
            { wakeupName: "default" },
            ac2.signal,
            undefined,
            {} as any
          );
        },
        (err: any) => {
          assert(err instanceof WorkflowBudgetExhaustedError);
          assert.equal(err.dimension, "turns");
          assert.equal(err.limit, 2);
          assert.equal(err.actual, 2);
          return true;
        }
      );

      // Verify run was moved to blocked state
      const blockedRun = registry.requireRun(run.id);
      assert.equal(blockedRun.lifecycle, "blocked");
      assert.equal(blockedRun.blocker?.category, "human-required");
      assert.equal(blockedRun.blocker?.requiresHuman, true);
      assert.match(blockedRun.blocker?.reason ?? "", /maximum turns limit of 2 reached/);
      assert(fakeSchedulerPort.cancelled.includes(run.id));

      dispatcher.endIteration(binding2.token);

      // Further autonomous dispatch is strictly prevented
      assert.throws(
        () => dispatcher.beginIteration(run.id),
        (err: any) => {
          assert(err instanceof Error);
          return true;
        }
      );
    });

    it("enforces maxDuration wall-clock budget when elapsed duration exceeds limit", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      const def = parseWorkflowContent(WORKFLOW_WITH_DURATION_BUDGET, { path: "/dur.md", scope: "project" });
      const pastTime = Date.now() - 500; // 500ms ago, exceeding 100ms maxDuration
      const run = registry.createRun(def, { runId: "wfrun-dur-1", createdAt: pastTime });

      // Attempting to begin iteration on expired run fails closed and blocks run
      assert.throws(
        () => dispatcher.beginIteration(run.id),
        (err: any) => {
          assert(err instanceof WorkflowBudgetExhaustedError);
          assert.equal(err.dimension, "duration");
          return true;
        }
      );

      const blockedRun = registry.requireRun(run.id);
      assert.equal(blockedRun.lifecycle, "blocked");
      assert.equal(blockedRun.blocker?.category, "human-required");
      assert.match(blockedRun.blocker?.reason ?? "", /maximum duration of 100ms reached/);
    });

    it("enforces maxAttempts budget when implementation attempts reach limit", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      const def = parseWorkflowContent(WORKFLOW_WITH_TURNS_BUDGET, { path: "/attempts.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-attempts-1" });

      // Update attempts to reach limit of 3
      registry.updateRun(run.id, { attempts: 3 });

      assert.throws(
        () => dispatcher.beginIteration(run.id),
        (err: any) => {
          assert(err instanceof WorkflowBudgetExhaustedError);
          assert.equal(err.dimension, "attempts");
          assert.equal(err.limit, 3);
          assert.equal(err.actual, 3);
          return true;
        }
      );

      const blockedRun = registry.requireRun(run.id);
      assert.equal(blockedRun.lifecycle, "blocked");
      assert.match(blockedRun.blocker?.reason ?? "", /maximum attempts limit of 3 reached/);
    });
  });

  // =========================================================================
  // 2. Unsupported Budgets (Tokens & Cost) Fail Closed
  // =========================================================================
  describe("Unsupported Budget Rejection", () => {
    it("rejects token budget in workflow definition parsing", () => {
      const yamlWithTokens = `---
name: token-workflow
description: Workflow attempting token budget
mode: self-paced
budget:
  maxTokens: 50000
---
Body
`;
      assert.throws(
        () => parseWorkflowContent(yamlWithTokens, { path: "/tokens.md", scope: "project" }),
        (err: any) => {
          assert(err instanceof WorkflowValidationError);
          assert.match(err.message, /Field "budget.maxTokens" is not supported/);
          return true;
        }
      );
    });

    it("rejects starting a workflow with unsupported maxCost budget without guessing", async () => {
      const yamlWithCost = `---
name: cost-workflow
description: Workflow with maxCost
mode: self-paced
budget:
  maxCost: 15.5
wakeups:
  default: 5m
---
Body
`;
      const def = parseWorkflowContent(yamlWithCost, { path: "/cost.md", scope: "project" });
      assert.equal(def.budget.maxCost, 15.5); // Parsed for schema compatibility

      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService });

      // Attempting to start run in scheduler adapter throws WorkflowUnsupportedBudgetError
      await assert.rejects(
        async () => {
          await adapter.startRun(def);
        },
        (err: any) => {
          assert(err instanceof WorkflowUnsupportedBudgetError);
          assert.equal(err.dimension, "maxCost");
          assert.match(err.message, /unsupported because Pi runtime does not expose authoritative cost accounting/);
          return true;
        }
      );
    });

    it("reports costStatus unavailable in iteration context when maxCost is present", () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      const def = parseWorkflowContent(
        `---
name: cost-ctx-test
description: Testing context cost status
mode: self-paced
budget:
  maxCost: 20
---
Body`,
        { path: "/c.md", scope: "project" }
      );

      const run = registry.createRun(def, { runId: "wfrun-cost-ctx" });
      const binding = dispatcher.beginIteration(run.id, { incrementTurns: false });
      const ctx = dispatcher.getIterationContext(binding);

      assert.equal(ctx.budget.maxCost, 20);
      assert.equal(ctx.budget.costStatus, "unavailable");
      dispatcher.endIteration(binding.token);
    });
  });

  // =========================================================================
  // 3. Budgets Survive Reload and Reconstruction
  // =========================================================================
  describe("Budget Durability & Reconstruction", () => {
    it("persists and reconstructs turn, attempt, and wall-clock budgets across session reload", async () => {
      const session = new FakeSessionManager();
      const registry1 = new WorkflowRunRegistry(session);

      const def = parseWorkflowContent(WORKFLOW_WITH_TURNS_BUDGET, { path: "/test.md", scope: "project" });
      const run1 = registry1.createRun(def, {
        runId: "wfrun-durable-1",
        createdAt: 1700000000000,
        budget: { maxTurns: 8, maxAttempts: 4 },
      });

      // Advance turns and attempts
      registry1.updateRun(run1.id, { turns: 5, attempts: 2 });

      // Reconstruct fresh registry from session log
      const registry2 = new WorkflowRunRegistry(session);
      await registry2.reconstructFromSession();

      const reconstructed = registry2.requireRun("wfrun-durable-1");
      assert.equal(reconstructed.turns, 5);
      assert.equal(reconstructed.attempts, 2);
      assert.equal(reconstructed.createdAt, 1700000000000);
      assert.equal(reconstructed.budget?.maxTurns, 8);
      assert.equal(reconstructed.budget?.maxAttempts, 4);

      // Reconcile with scheduler
      const dispatcher2 = new WorkflowDispatcher(registry2);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry: registry2, dispatcher: dispatcher2, service: loopService });

      const reconResult = await adapter.reconcile();
      assert.equal(reconResult.matched.length + reconResult.recreated.length, 1);
    });

    it("reconcile cleans up tasks and blocks reconstructed runs whose budget is exhausted", async () => {
      const session = new FakeSessionManager();
      const registry1 = new WorkflowRunRegistry(session);

      const def = parseWorkflowContent(WORKFLOW_WITH_TURNS_BUDGET, { path: "/test.md", scope: "project" });
      const run1 = registry1.createRun(def, {
        runId: "wfrun-exhausted-reload",
        loopTaskId: "task-exhausted-1",
      });

      // Update turns to match limit (2)
      registry1.updateRun(run1.id, { turns: 2 });

      // Scheduler service has an orphaned task for this run
      const loopService = new FakeLoopService();
      loopService.scheduleSelfPaced(`- Run ID: ${run1.id}`);
      assert.equal(loopService.listTasks().length, 1);

      // Reconstruct
      const registry2 = new WorkflowRunRegistry(session);
      await registry2.reconstructFromSession();
      const dispatcher2 = new WorkflowDispatcher(registry2);
      const adapter = createLoopSchedulerAdapter({ registry: registry2, dispatcher: dispatcher2, service: loopService });

      const reconResult = await adapter.reconcile();

      // Exhausted run was blocked and task deleted
      assert.equal(reconResult.blocked.length, 1);
      assert.equal(reconResult.blocked[0].runId, "wfrun-exhausted-reload");
      const reloadedRun = registry2.requireRun("wfrun-exhausted-reload");
      assert.equal(reloadedRun.lifecycle, "blocked");
      assert.equal(reloadedRun.blocker?.category, "human-required");
    });
  });

  // =========================================================================
  // 4. Completion Gate: Explicit Claims & Verification Flow
  // =========================================================================
  describe("Completion Claim & Verification Gate", () => {
    it("requires explicit summary and evidence when completing", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      const def = parseWorkflowContent(WORKFLOW_WITH_VERIFY, { path: "/v.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-claim-1" });

      const ac = new AbortController();
      dispatcher.beginIteration(run.id, { signal: ac.signal, incrementTurns: false });
      const tools = createWorkflowTools({ dispatcher, registry });
      const completeTool = tools.find((t) => t.name === "workflow_complete")!;

      // 1. Missing summary throws
      await assert.rejects(
        async () => {
          await completeTool.execute("call-1", { summary: "" } as any, ac.signal, undefined, {} as any);
        },
        (err: any) => {
          assert(err instanceof WorkflowRunError);
          assert.match(err.message, /requires a non-empty summary/i);
          return true;
        }
      );

      // 2. Missing evidence when requireEvidence is true throws
      await assert.rejects(
        async () => {
          await completeTool.execute(
            "call-2",
            { summary: "Finished work" },
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

    it("full verification cycle: submits claim -> verifies and accepts -> run completed", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      const def = parseWorkflowContent(WORKFLOW_WITH_VERIFY, { path: "/v.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-verify-accept" });

      // Turn 1: Workflow implementation turn submits completion claim
      const ac1 = new AbortController();
      dispatcher.beginIteration(run.id, { signal: ac1.signal, incrementTurns: false });
      const tools1 = createWorkflowTools({ dispatcher, registry });
      const completeTool1 = tools1.find((t) => t.name === "workflow_complete")!;

      const claimResult = await completeTool1.execute(
        "call-claim",
        {
          summary: "Implemented authentication module and added tests",
          evidence: [
            { type: "pr", description: "PR #123", url: "https://github.com/org/repo/pull/123" },
            { type: "test", description: "All 15 auth tests passing" },
          ],
        },
        ac1.signal,
        undefined,
        {} as any
      );

      assert.equal((claimResult.details as any).status, "verifying");
      assert.equal((claimResult.details as any).step, "VERIFYING");
      assert.equal((claimResult.details as any).lifecycle, "verifying");

      const inVerifyRun = registry.requireRun(run.id);
      assert.equal(inVerifyRun.lifecycle, "verifying");
      assert.equal(inVerifyRun.step, "VERIFYING");
      assert.equal(inVerifyRun.completionClaim?.summary, "Implemented authentication module and added tests");
      assert.equal(inVerifyRun.completionClaim?.evidence.length, 2);

      // Verify completion claim survived into session entries
      const claimEntry = session.getBranch().find((e: any) => e.data?.action === "claim");
      assert(claimEntry);
      assert.equal((claimEntry.data as any).payload.summary, "Implemented authentication module and added tests");

      dispatcher.endIteration();

      // Turn 2: Verifier turn receives constrained verifier prompt and accepts
      const verifierPrompt = dispatcher.buildPrompt(run.id);
      assert.match(verifierPrompt, /# Workflow Completion Verification:/);
      assert.match(verifierPrompt, /Implemented authentication module and added tests/);
      assert.match(verifierPrompt, /PR #123/);

      const ac2 = new AbortController();
      dispatcher.beginIteration(run.id, { signal: ac2.signal, incrementTurns: false });
      const tools2 = createWorkflowTools({ dispatcher, registry });
      const verifyTool = tools2.find((t) => t.name === "workflow_verify")!;

      const verifyResult = await verifyTool.execute(
        "call-verify-accept",
        {
          decision: "accept",
          findings: "Verified all auth unit tests pass and PR is clean",
          checks: [
            { name: "unit-tests", passed: true },
            { name: "code-review", passed: true },
          ],
        },
        ac2.signal,
        undefined,
        {} as any
      );

      assert.equal((verifyResult.details as any).status, "completed");
      assert.equal((verifyResult.details as any).lifecycle, "completed");

      const completedRun = registry.requireRun(run.id);
      assert.equal(completedRun.lifecycle, "completed");
      assert.equal(completedRun.completion?.summary, "Implemented authentication module and added tests");
      assert.equal(completedRun.completion?.evidence.length, 2);
      assert.equal(completedRun.verificationFindings?.decision, "accepted");
      assert.equal(completedRun.verificationFindings?.checks?.length, 2);
    });

    it("verification rejection: returns run to configured returnStep for rework", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      const def = parseWorkflowContent(WORKFLOW_WITH_VERIFY, { path: "/v.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-verify-reject" });

      // Turn 1: Submit completion claim
      const ac1 = new AbortController();
      dispatcher.beginIteration(run.id, { signal: ac1.signal, incrementTurns: false });
      const completeTool = createWorkflowTools({ dispatcher, registry }).find((t) => t.name === "workflow_complete")!;

      await completeTool.execute(
        "call-claim",
        {
          summary: "Initial attempt",
          evidence: [{ type: "commit", description: "git commit c1" }],
        },
        ac1.signal,
        undefined,
        {} as any
      );
      dispatcher.endIteration();

      // Turn 2: Verifier rejects claim
      const ac2 = new AbortController();
      dispatcher.beginIteration(run.id, { signal: ac2.signal, incrementTurns: false });
      const verifyTool = createWorkflowVerifyTool(dispatcher, registry);

      const rejectResult = await verifyTool.execute(
        "call-reject",
        {
          decision: "reject",
          findings: "Integration test failed: auth token missing expiry",
          returnStep: "IMPLEMENTING",
        },
        ac2.signal,
        undefined,
        {} as any
      );

      assert.equal((rejectResult.details as any).status, "rejected");
      assert.equal((rejectResult.details as any).step, "IMPLEMENTING");

      // Verify run is NOT completed
      const reworkedRun = registry.requireRun(run.id);
      assert.notEqual(reworkedRun.lifecycle, "completed");
      assert.equal(reworkedRun.lifecycle, "active");
      assert.equal(reworkedRun.step, "IMPLEMENTING");
      assert.equal(reworkedRun.verificationAttempts, 1);
      assert.equal(reworkedRun.verificationFindings?.decision, "rejected");
      assert.match(reworkedRun.verificationFindings?.feedback ?? "", /Integration test failed/);
    });

    it("verification retry exhaustion: moves run to blocked after maxVerificationAttempts", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      // maxVerificationAttempts is 2 in WORKFLOW_WITH_VERIFY
      const def = parseWorkflowContent(WORKFLOW_WITH_VERIFY, { path: "/v.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-verify-exhaust" });

      // Claim 1
      const ac1 = new AbortController();
      dispatcher.beginIteration(run.id, { signal: ac1.signal, incrementTurns: false });
      const completeTool = createWorkflowTools({ dispatcher, registry }).find((t) => t.name === "workflow_complete")!;
      await completeTool.execute("c1", { summary: "attempt 1", evidence: [{ type: "t", description: "e" }] }, ac1.signal, undefined, {} as any);
      dispatcher.endIteration();

      // Rejection 1
      const ac2 = new AbortController();
      dispatcher.beginIteration(run.id, { signal: ac2.signal, incrementTurns: false });
      const verifyTool = createWorkflowVerifyTool(dispatcher, registry);
      await verifyTool.execute("v1", { decision: "reject", findings: "First rejection" }, ac2.signal, undefined, {} as any);
      dispatcher.endIteration();

      assert.equal(registry.requireRun(run.id).verificationAttempts, 1);
      assert.equal(registry.requireRun(run.id).lifecycle, "active");

      // Claim 2
      const ac3 = new AbortController();
      dispatcher.beginIteration(run.id, { signal: ac3.signal, incrementTurns: false });
      await completeTool.execute("c2", { summary: "attempt 2", evidence: [{ type: "t", description: "e" }] }, ac3.signal, undefined, {} as any);
      dispatcher.endIteration();

      // Rejection 2 (reaches maxVerificationAttempts: 2)
      const ac4 = new AbortController();
      dispatcher.beginIteration(run.id, { signal: ac4.signal, incrementTurns: false });
      const finalRejectResult = await verifyTool.execute(
        "v2",
        { decision: "reject", findings: "Second rejection - criteria still unmet" },
        ac4.signal,
        undefined,
        {} as any
      );

      assert.equal((finalRejectResult.details as any).status, "blocked");
      assert.equal((finalRejectResult.details as any).lifecycle, "blocked");

      const blockedRun = registry.requireRun(run.id);
      assert.equal(blockedRun.lifecycle, "blocked");
      assert.equal(blockedRun.blocker?.category, "human-required");
      assert.equal(blockedRun.blocker?.requiresHuman, true);
      assert.match(blockedRun.blocker?.reason ?? "", /Verification rejected \(attempt 2\/2\)/);
      assert.notEqual(blockedRun.lifecycle, "completed");
    });
  });

  // =========================================================================
  // 5. Blocked vs. Paused Semantics
  // =========================================================================
  describe("Blocked vs. Paused Semantics", () => {
    it("distinguishes human-required blocker from paused: different representation and zero polling", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService });

      const def = parseWorkflowContent(WORKFLOW_WITH_TURNS_BUDGET, { path: "/t.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "wfrun-sem-1" });
      assert.equal(loopService.listTasks().length, 1);

      // 1. Block run with human-required blocker
      const ac1 = new AbortController();
      const binding1 = dispatcher.beginIteration(run.id, { signal: ac1.signal, schedulerPort: adapter.getSchedulerPort(run.id), incrementTurns: false });
      const blockTool = createWorkflowTools({ dispatcher, registry }).find((t) => t.name === "workflow_block")!;

      await blockTool.execute(
        "call-block",
        {
          reason: "Waiting for manual production deployment approval",
          category: "human-required",
        },
        ac1.signal,
        undefined,
        {} as any
      );
      dispatcher.endIteration();

      const blocked = registry.requireRun(run.id);
      assert.equal(blocked.lifecycle, "blocked");
      assert.equal(blocked.blocker?.category, "human-required");
      assert.equal(blocked.blocker?.requiresHuman, true);

      // Verify scheduler task was stopped: zero polling for human-required blocker
      assert.equal(loopService.listTasks().length, 0);

      // formatNextWakeup reports "none (blocked - human required)"
      const wakeupStr = formatNextWakeup(blocked, adapter);
      assert.match(wakeupStr, /none \(blocked/);

      // Reconcile verifies human-required blocker NEVER recreates task
      const reconResult = await adapter.reconcile();
      assert.equal(reconResult.recreated.length, 0);
      assert.equal(loopService.listTasks().length, 0);

      // 2. Resume and pause run: verify paused representation
      registry.resumeRun(run.id);
      await adapter.scheduleRun(run.id);
      assert.equal(loopService.listTasks().length, 1);

      await adapter.cancelWakeup(run.id);
      registry.pauseRun(run.id, { reason: "User paused workflow" });

      const paused = registry.requireRun(run.id);
      assert.equal(paused.lifecycle, "paused");
      assert.equal(paused.blocker, undefined); // Paused has NO blocker info

      assert.equal(formatNextWakeup(paused, adapter), "none (paused)");

      // Reconcile verifies paused run NEVER recreates task
      const reconResult2 = await adapter.reconcile();
      assert.equal(reconResult2.recreated.length, 0);
      assert.equal(loopService.listTasks().length, 0);
    });

    it("supports external-retryable blocker: conservative wakeup scheduled and reconciled", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService });

      const def = parseWorkflowContent(WORKFLOW_WITH_TURNS_BUDGET, { path: "/t.md", scope: "project" });
      const { run } = await adapter.startRun(def, { runId: "wfrun-retryable-1" });

      // Block with external-retryable category and 15m delay
      const ac = new AbortController();
      dispatcher.beginIteration(run.id, { signal: ac.signal, schedulerPort: adapter.getSchedulerPort(run.id), incrementTurns: false });
      const blockTool = createWorkflowTools({ dispatcher, registry }).find((t) => t.name === "workflow_block")!;

      await blockTool.execute(
        "b1",
        {
          reason: "Waiting for external webhook",
          category: "external-retryable",
          retryDelay: "15m",
        },
        ac.signal,
        undefined,
        {} as any
      );
      dispatcher.endIteration();

      const blockedRun = registry.requireRun(run.id);
      assert.equal(blockedRun.lifecycle, "blocked");
      assert.equal(blockedRun.blocker?.category, "external-retryable");
      assert.equal(blockedRun.blocker?.requiresHuman, false);

      // Verify a conservative retry wakeup was scheduled on the scheduler service
      assert(loopService.wakeups.length >= 1);
      const lastWakeup = loopService.wakeups[loopService.wakeups.length - 1];
      assert.equal(lastWakeup.delayMs, 15 * 60_000);

      // Reconcile retains the matching conservative retry task
      const reconResult = await adapter.reconcile();
      assert.equal(reconResult.matched.length, 1);
    });
  });

  // =========================================================================
  // 6. Production-Faithful Extension Composition with Verification & Tools
  // =========================================================================
  describe("Production Extension Composition", () => {
    it("executes production-faithful extension lifecycle with verification, tools, and scheduler", async () => {
      const session = new FakeSessionManager();
      const eventBus = new TestEventBus();
      const loopService = new FakeLoopService({ sessionId: "session-prod-1" });
      eventBus.registerProvider(loopService);

      const handlers = new Map<string, Function>();
      const registeredTools = new Map<string, any>();

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
      };

      // Register extension
      workflowExtension(pi);

      // Verify all tools registered in extension entrypoint
      assert.equal(registeredTools.size, 9);
      assert(registeredTools.has("workflow_get_context"));
      assert(registeredTools.has("workflow_transition"));
      assert(registeredTools.has("workflow_continue"));
      assert(registeredTools.has("workflow_block"));
      assert(registeredTools.has("workflow_complete"));
      assert(registeredTools.has("workflow_verify"));
      assert(registeredTools.has("workflow_effect_begin"));
      assert(registeredTools.has("workflow_effect_commit"));
      assert(registeredTools.has("workflow_effect_reconcile"));

      // Simulate session_start
      const sessionCtx: any = { sessionManager: session };
      await handlers.get("session_start")!({ type: "session_start" }, sessionCtx);

      // Start workflow run with verification gate
      const registry = new WorkflowRunRegistry(session);
      registry.refresh();
      const dispatcher = new WorkflowDispatcher(registry);
      const adapter = createLoopSchedulerAdapter({ registry, dispatcher, service: loopService, events: eventBus });

      const def = parseWorkflowContent(WORKFLOW_WITH_VERIFY, { path: "/v.md", scope: "project" });
      const { run, task } = await adapter.startRun(def, { runId: "wfrun-prod-verify" });
      assert(task.id);

      // Step 1: Turn 1 - model submits completion claim
      const turn1Ac = new AbortController();
      const prompt1 = dispatcher.buildPrompt(run.id);
      adapter.handleBeforeAgentStart({ prompt: prompt1 });
      adapter.handleTurnStart({ signal: turn1Ac.signal });

      const boundTools = createWorkflowTools({ dispatcher, registry });
      const completeTool = boundTools.find((t) => t.name === "workflow_complete")!;

      const claimRes = await completeTool.execute(
        "claim-1",
        {
          summary: "Feature fully built",
          evidence: [{ type: "test", description: "all unit tests pass" }],
        },
        turn1Ac.signal,
        undefined,
        {} as any
      );

      assert.equal((claimRes.details as any).status, "verifying");
      assert.equal((claimRes.details as any).lifecycle, "verifying");
      assert.equal(registry.requireRun(run.id).lifecycle, "verifying");
      adapter.handleAgentSettled();

      // Step 2: Turn 2 - verifier iteration prompt
      const prompt2 = dispatcher.buildPrompt(run.id);
      assert.match(prompt2, /# Workflow Completion Verification:/);
      assert.match(prompt2, /Feature fully built/);

      const turn2Ac = new AbortController();
      adapter.handleBeforeAgentStart({ prompt: prompt2 });
      adapter.handleTurnStart({ signal: turn2Ac.signal });

      const verifyTool = boundTools.find((t) => t.name === "workflow_verify")!;
      const verifyRes = await verifyTool.execute(
        "verify-1",
        {
          decision: "accept",
          findings: "Verified all unit tests passed with 100% coverage",
        },
        turn2Ac.signal,
        undefined,
        {} as any
      );

      assert.equal((verifyRes.details as any).status, "completed");
      adapter.handleAgentSettled();

      // Run is fully and cleanly completed
      const finalRun = registry.requireRun(run.id);
      assert.equal(finalRun.lifecycle, "completed");
      assert.equal(finalRun.completion?.summary, "Feature fully built");
      assert.equal(finalRun.verificationFindings?.decision, "accepted");
    });
  });

  // =========================================================================
  // 7. Regression Tests: Verification Gate Integrity & Scheduler Ordering
  // =========================================================================
  describe("Regression Tests: Verification Gate Integrity & Scheduler Ordering", () => {
    it("workflow_complete strictly rejects when called in VERIFYING step to prevent gate bypass", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      const def = parseWorkflowContent(WORKFLOW_WITH_VERIFY, { path: "/v.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-reg-bypass" });

      const ac1 = new AbortController();
      dispatcher.beginIteration(run.id, { signal: ac1.signal, incrementTurns: false });
      const completeTool = createWorkflowTools({ dispatcher, registry }).find((t) => t.name === "workflow_complete")!;

      await completeTool.execute(
        "claim",
        {
          summary: "Initial claim",
          evidence: [{ type: "test", description: "tests passed" }],
        },
        ac1.signal,
        undefined,
        {} as any
      );
      dispatcher.endIteration();

      // In VERIFYING step: calling completeTool again must fail closed
      const ac2 = new AbortController();
      dispatcher.beginIteration(run.id, { signal: ac2.signal, incrementTurns: false });

      await assert.rejects(
        async () => {
          await completeTool.execute(
            "bypass-attempt",
            { summary: "Trying to complete directly" },
            ac2.signal,
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

      // Verify run was NOT completed
      assert.notEqual(registry.requireRun(run.id).lifecycle, "completed");
      assert.equal(registry.requireRun(run.id).lifecycle, "verifying");
      assert.equal(registry.requireRun(run.id).step, "VERIFYING");
    });

    it("claim submission fails closed to blocked state if scheduleWakeup throws", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      const def = parseWorkflowContent(WORKFLOW_WITH_VERIFY, { path: "/v.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-reg-claim-sched-fail" });

      const ac = new AbortController();
      const failingSchedulerPort = {
        scheduleWakeup() {
          throw new Error("pi-loop timer allocation failed");
        },
        cancelWakeup() {},
      };

      dispatcher.beginIteration(run.id, {
        signal: ac.signal,
        schedulerPort: failingSchedulerPort as any,
        incrementTurns: false,
      });

      const completeTool = createWorkflowTools({ dispatcher, registry }).find((t) => t.name === "workflow_complete")!;

      await assert.rejects(
        async () => {
          await completeTool.execute(
            "claim-sched-err",
            {
              summary: "Claim that will fail scheduling",
              evidence: [{ type: "test", description: "suite passed" }],
            },
            ac.signal,
            undefined,
            {} as any
          );
        },
        (err: any) => {
          assert(err instanceof WorkflowRunError);
          assert.match(err.message, /Failed to schedule verification iteration: pi-loop timer allocation failed/);
          return true;
        }
      );

      // Verify run moved to actionable blocked state rather than being left unscheduled in verifying
      const blockedRun = registry.requireRun(run.id);
      assert.equal(blockedRun.lifecycle, "blocked");
      assert.equal(blockedRun.blocker?.category, "human-required");
      assert.equal(blockedRun.blocker?.requiresHuman, true);
      assert.match(blockedRun.blocker?.reason ?? "", /Failed to schedule verification iteration/);
    });

    it("verification rejection fails closed to blocked state if scheduleWakeup throws", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      const def = parseWorkflowContent(WORKFLOW_WITH_VERIFY, { path: "/v.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-reg-reject-sched-fail" });

      // Enter verification
      registry.claimCompletion(run.id, {
        summary: "Pending claim",
        evidence: [{ type: "test", description: "tests passed" }],
      });

      const ac = new AbortController();
      const failingSchedulerPort = {
        scheduleWakeup() {
          throw new Error("pi-loop connection severed");
        },
        cancelWakeup() {},
      };

      dispatcher.beginIteration(run.id, {
        signal: ac.signal,
        schedulerPort: failingSchedulerPort as any,
        incrementTurns: false,
      });

      const verifyTool = createWorkflowVerifyTool(dispatcher, registry);

      await assert.rejects(
        async () => {
          await verifyTool.execute(
            "reject-sched-err",
            {
              decision: "reject",
              findings: "Tests failed on edge case",
              returnStep: "IMPLEMENTING",
            },
            ac.signal,
            undefined,
            {} as any
          );
        },
        (err: any) => {
          assert(err instanceof WorkflowRunError);
          assert.match(err.message, /Failed to schedule rework iteration following verification rejection/);
          return true;
        }
      );

      // Verify run moved to actionable blocked state rather than being left unscheduled
      const blockedRun = registry.requireRun(run.id);
      assert.equal(blockedRun.lifecycle, "blocked");
      assert.equal(blockedRun.blocker?.category, "human-required");
      assert.equal(blockedRun.blocker?.requiresHuman, true);
    });

    it("safe terminal ordering: if cancelWakeup throws on direct complete, run is not marked completed", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      const defNoVerify = parseWorkflowContent(
        `---
name: direct-complete-wf
description: Direct complete without verify
mode: self-paced
---
Body`,
        { path: "/d.md", scope: "project" }
      );

      const run = registry.createRun(defNoVerify, { runId: "wfrun-reg-term-order-direct" });

      const ac = new AbortController();
      const failingCancelPort = {
        scheduleWakeup() {},
        cancelWakeup() {
          throw new Error("pi-loop stopTask failed: service unavailable");
        },
      };

      dispatcher.beginIteration(run.id, {
        signal: ac.signal,
        schedulerPort: failingCancelPort as any,
        incrementTurns: false,
      });

      const completeTool = createWorkflowTools({ dispatcher, registry }).find((t) => t.name === "workflow_complete")!;

      await assert.rejects(
        async () => {
          await completeTool.execute(
            "direct-complete",
            { summary: "Ready to complete" },
            ac.signal,
            undefined,
            {} as any
          );
        },
        (err: any) => {
          assert.match(err.message, /service unavailable/);
          return true;
        }
      );

      // Verify run was NOT marked completed
      const unchangedRun = registry.requireRun(run.id);
      assert.notEqual(unchangedRun.lifecycle, "completed");
      assert.equal(unchangedRun.lifecycle, "active");
      assert.equal(unchangedRun.completion, undefined);
    });

    it("safe terminal ordering: if cancelWakeup throws on verify accept, run is not marked completed", async () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const dispatcher = new WorkflowDispatcher(registry);

      const def = parseWorkflowContent(WORKFLOW_WITH_VERIFY, { path: "/v.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-reg-term-order-verify" });

      registry.claimCompletion(run.id, {
        summary: "Claim ready for verification",
        evidence: [{ type: "test", description: "suite ok" }],
      });

      const ac = new AbortController();
      const failingCancelPort = {
        scheduleWakeup() {},
        cancelWakeup() {
          throw new Error("pi-loop stopTask failed: lock timeout");
        },
      };

      dispatcher.beginIteration(run.id, {
        signal: ac.signal,
        schedulerPort: failingCancelPort as any,
        incrementTurns: false,
      });

      const verifyTool = createWorkflowVerifyTool(dispatcher, registry);

      await assert.rejects(
        async () => {
          await verifyTool.execute(
            "verify-accept-err",
            {
              decision: "accept",
              findings: "All good",
            },
            ac.signal,
            undefined,
            {} as any
          );
        },
        (err: any) => {
          assert.match(err.message, /lock timeout/);
          return true;
        }
      );

      // Verify run was NOT marked completed
      const unchangedRun = registry.requireRun(run.id);
      assert.notEqual(unchangedRun.lifecycle, "completed");
      assert.equal(unchangedRun.lifecycle, "verifying");
      assert.equal(unchangedRun.step, "VERIFYING");
      assert.equal(unchangedRun.completion, undefined);
    });
  });

  // =========================================================================
  // 8. Verifying Lifecycle Invariants & Session Reconstruction
  // =========================================================================
  describe("Verifying Lifecycle Strict State Transitions & Reconstruction", () => {
    it("enforces claimCompletion only from active lifecycle", () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const def = parseWorkflowContent(WORKFLOW_WITH_VERIFY, { path: "/v.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-claim-strict" });

      // Pause run
      registry.pauseRun(run.id);
      assert.throws(
        () => registry.claimCompletion(run.id, { summary: "claim" }),
        (err: any) => {
          assert.equal(err.fromLifecycle, "paused");
          assert.equal(err.toLifecycle, "verifying");
          return true;
        }
      );

      // Resume and block run
      registry.resumeRun(run.id);
      registry.blockRun(run.id, { reason: "blocked" });
      assert.throws(
        () => registry.claimCompletion(run.id, { summary: "claim" }),
        (err: any) => {
          assert.equal(err.fromLifecycle, "blocked");
          assert.equal(err.toLifecycle, "verifying");
          return true;
        }
      );

      // Resume to active, then claim completion -> lifecycle becomes verifying
      registry.resumeRun(run.id);
      assert.equal(registry.requireRun(run.id).lifecycle, "active");
      registry.claimCompletion(run.id, { summary: "claim" });
      assert.equal(registry.requireRun(run.id).lifecycle, "verifying");

      // Claiming again while in verifying lifecycle throws
      assert.throws(
        () => registry.claimCompletion(run.id, { summary: "second claim" }),
        (err: any) => {
          assert.equal(err.fromLifecycle, "verifying");
          assert.equal(err.toLifecycle, "verifying");
          return true;
        }
      );
    });

    it("enforces verifyRun only from verifying lifecycle", () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const def = parseWorkflowContent(WORKFLOW_WITH_VERIFY, { path: "/v.md", scope: "project" });
      const run = registry.createRun(def, { runId: "wfrun-verify-strict" });

      // Calling verifyRun while run is still active throws
      assert.equal(run.lifecycle, "active");
      assert.throws(
        () => registry.verifyRun(run.id, { decision: "accept" }),
        (err: any) => {
          assert.equal(err.fromLifecycle, "active");
          assert.match(err.message, /must be in "verifying" lifecycle/);
          return true;
        }
      );

      // Claim completion -> transitions active -> verifying
      registry.claimCompletion(run.id, { summary: "Submitted work", evidence: [{ type: "commit", description: "c1" }] });
      assert.equal(registry.requireRun(run.id).lifecycle, "verifying");

      // Now verifyRun is valid from verifying lifecycle
      const verified = registry.verifyRun(run.id, { decision: "accept", findings: "All tests pass" });
      assert.equal(verified.lifecycle, "completed");

      // Calling verifyRun on completed run throws
      assert.throws(
        () => registry.verifyRun(run.id, { decision: "accept" }),
        (err: any) => {
          assert.equal(err.fromLifecycle, "completed");
          return true;
        }
      );
    });

    it("verifying lifecycle and claims survive session reload and reconstruction across restart", async () => {
      const session = new FakeSessionManager();
      const registry1 = new WorkflowRunRegistry(session);

      const def = parseWorkflowContent(WORKFLOW_WITH_VERIFY, { path: "/v.md", scope: "project" });
      const run = registry1.createRun(def, { runId: "wfrun-verifying-reload" });
      assert.equal(run.lifecycle, "active");

      // Submit claim to enter verifying lifecycle
      registry1.claimCompletion(run.id, {
        summary: "Full feature implementation ready for inspection",
        evidence: [
          { type: "pr", description: "PR #42", url: "https://github.com/org/repo/pull/42" },
          { type: "test", description: "100% test coverage" },
        ],
      });

      const inVerify1 = registry1.requireRun(run.id);
      assert.equal(inVerify1.lifecycle, "verifying");
      assert.equal(inVerify1.step, "VERIFYING");

      // Simulate session reload and rebuild registry from session log
      const registry2 = new WorkflowRunRegistry(session);
      await registry2.reconstructFromSession();

      const reconstructed = registry2.requireRun(run.id);
      // Strictly asserts lifecycle is verifying across restart!
      assert.equal(reconstructed.lifecycle, "verifying");
      assert.equal(reconstructed.step, "VERIFYING");
      assert.equal(reconstructed.completionClaim?.summary, "Full feature implementation ready for inspection");
      assert.equal(reconstructed.completionClaim?.evidence.length, 2);

      // Verify nonterminal occupancy includes verifying runs
      const nonterminals = registry2.getNonterminalRuns();
      assert.equal(nonterminals.length, 1);
      assert.equal(nonterminals[0].id, run.id);
      assert.equal(nonterminals[0].lifecycle, "verifying");

      // Reconcile connects scheduler task for verifying run
      const dispatcher2 = new WorkflowDispatcher(registry2);
      const loopService = new FakeLoopService();
      const adapter = createLoopSchedulerAdapter({ registry: registry2, dispatcher: dispatcher2, service: loopService });
      const recon = await adapter.reconcile();
      assert.equal(recon.recreated.length + recon.matched.length, 1);

      // Verifier can evaluate and accept the reconstructed verifying run
      const ac = new AbortController();
      dispatcher2.beginIteration(run.id, { signal: ac.signal, schedulerPort: adapter.getSchedulerPort(run.id), incrementTurns: false });
      const verifyTool = createWorkflowVerifyTool(dispatcher2, registry2);

      const verifyResult = await verifyTool.execute(
        "verify-reconstructed",
        {
          decision: "accept",
          findings: "Reconstructed claim verified and approved",
        },
        ac.signal,
        undefined,
        {} as any
      );

      assert.equal((verifyResult.details as any).status, "completed");
      assert.equal((verifyResult.details as any).lifecycle, "completed");

      const finalRun = registry2.requireRun(run.id);
      assert.equal(finalRun.lifecycle, "completed");
      assert.equal(finalRun.completion?.summary, "Full feature implementation ready for inspection");
      assert.equal(finalRun.completion?.evidence.length, 2);
      assert.equal(finalRun.verificationFindings?.decision, "accepted");
    });
  });
});
