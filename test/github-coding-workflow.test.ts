/**
 * Issue #12: `github-coding.md` reference workflow.
 *
 * Covers:
 * 1. On-disk reference workflow parses under Workflow Spec v1.
 * 2. A deterministic full-path run through fake `github` and `worker-runtime`
 *    providers (claim -> worktree -> implement -> independent verify -> PR/CI ->
 *    review/fix -> merge -> finalize -> complete -> verify).
 * 3. Provider preflight fails closed when an executable provider is absent.
 * 4. The worker boundary cannot call GitHub operations.
 * 5. The generic provider-action seam: allowlist, capability/version checks,
 *    effect gating, and no raw/secret leakage.
 * 6. Pure core has no GitHub/tmux/process imports.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createWorkflowCapabilityRegistry,
  type WorkflowCapabilityRegistry,
  type WorkflowProviderOperation,
} from "../src/capabilities.ts";
import { WorkflowCommandController } from "../src/commands.ts";
import { WorkflowDispatcher } from "../src/dispatcher.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { WorkflowRunRegistry } from "../src/registry.ts";
import { LoopSchedulerAdapter } from "../src/scheduler-adapter.ts";
import { createWorkflowProviderCallTool, createWorkflowTools } from "../src/tools.ts";
import { WorkflowProviderCallError } from "../src/types.ts";
import { FakeLoopService } from "./fake-loop-service.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";
import {
  createFakeReality,
  FakeGitHubProvider,
  FakeWorkerRuntimeProvider,
} from "./fake-providers.ts";

const WORKFLOW_PATH = fileURLToPath(new URL("../.pi/workflows/github-coding.md", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

function loadGithubCoding() {
  const content = readFileSync(WORKFLOW_PATH, "utf-8");
  return parseWorkflowContent(content, { path: WORKFLOW_PATH, scope: "project" });
}

interface Harness {
  session: FakeSessionManager;
  registry: WorkflowRunRegistry;
  dispatcher: WorkflowDispatcher;
  capabilityRegistry: WorkflowCapabilityRegistry;
  loopService: FakeLoopService;
  adapter: LoopSchedulerAdapter;
  reality: ReturnType<typeof createFakeReality>;
  github: FakeGitHubProvider;
  worker: FakeWorkerRuntimeProvider;
  tools: ReturnType<typeof createWorkflowTools>;
  def: ReturnType<typeof loadGithubCoding>;
}

function createHarness(options: { github?: boolean; worker?: boolean } = {}): Harness {
  const session = new FakeSessionManager({ sessionId: "gh-coding-session" });
  const registry = new WorkflowRunRegistry(session);
  const dispatcher = new WorkflowDispatcher(registry);
  const capabilityRegistry = createWorkflowCapabilityRegistry({ sessionId: "gh-coding-session" });
  const loopService = new FakeLoopService({ sessionId: "gh-coding-session" });
  const adapter = new LoopSchedulerAdapter({
    registry,
    dispatcher,
    service: loopService,
    capabilityRegistry,
  });
  const reality = createFakeReality();
  const github = new FakeGitHubProvider(reality);
  const worker = new FakeWorkerRuntimeProvider(reality);
  if (options.github !== false) capabilityRegistry.register(github.registration());
  if (options.worker !== false) capabilityRegistry.register(worker.registration());
  const tools = createWorkflowTools({ dispatcher, registry, capabilityRegistry });
  return {
    session,
    registry,
    dispatcher,
    capabilityRegistry,
    loopService,
    adapter,
    reality,
    github,
    worker,
    tools,
    def: loadGithubCoding(),
  };
}

// ---------------------------------------------------------------------------
// 1. Reference workflow parses
// ---------------------------------------------------------------------------

describe("github-coding reference workflow definition (Issue #12)", () => {
  it("parses the on-disk reference with validated self-paced frontmatter", () => {
    const def = loadGithubCoding();

    assert.equal(def.name, "github-coding");
    assert.equal(def.mode, "self-paced");
    assert.equal(def.concurrency.maxRuns, 1);
    assert.equal(def.budget.maxTurns, 120);
    assert.equal(def.budget.maxDuration, "8h");
    assert.equal(def.budget.maxAttempts, 6);
    assert.equal(def.budget.onExhaustion, "block");

    assert.equal(def.wakeups.default, "5m");
    assert.equal(def.wakeups.min, "1m");
    assert.equal(def.wakeups.max, "1h");
    assert.equal(def.wakeups.named?.worker, "2m");
    assert.equal(def.wakeups.named?.ci, "5m");
    assert.equal(def.wakeups.named?.review, "15m");
    assert.equal(def.wakeups.named?.idle, "15m");
    assert.equal(def.wakeups.named?.retry, "2m");

    const github = def.capabilityRequirements!.find((r) => r.name === "github")!;
    assert.equal(github.version, 1);
    assert.deepEqual(github.features, [
      "issues",
      "pull-requests",
      "ci",
      "reviews",
      "merge",
      "project-state",
    ]);

    const worker = def.capabilityRequirements!.find((r) => r.name === "worker-runtime")!;
    assert.deepEqual(worker.features, ["isolated-worktree", "spawn", "inspect", "verify"]);
    assert.ok(def.requires.includes("loop"));

    assert.equal(def.completion?.requireSummary, true);
    assert.equal(def.completion?.requireEvidence, true);
    assert.equal(def.completion?.verify, true);
    assert.equal(def.completion?.returnStep, "FIXING_REVIEW");
    assert.equal(def.completion?.onRejectionExhausted, "block");

    // Guidance body starts the run at INITIAL and directs IDLE, and names the
    // workflow data steps (not engine lifecycle states).
    assert.match(def.body, /INITIAL/);
    assert.match(def.body, /IDLE/);
    for (const step of [
      "CLAIMING",
      "IMPLEMENTING",
      "VERIFYING_IMPLEMENTATION",
      "OPENING_PR",
      "WAITING_CI",
      "REVIEWING",
      "FIXING_REVIEW",
      "MERGING",
      "FINALIZING",
      "BLOCKED",
      "COMPLETED",
    ]) {
      assert.ok(def.body.includes(step), `body should describe step ${step}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Full-path deterministic run
// ---------------------------------------------------------------------------

describe("github-coding full fake-provider run (Issue #12)", () => {
  it("claims, implements, verifies, opens PR/CI, reviews/fixes, merges and finalizes", async () => {
    const h = createHarness();
    h.github.addIssue({ number: 12, title: "Fix the widget", state: "open" });

    const { run } = await h.adapter.startRun(h.def);
    const runId = run.id;

    type Call = (name: string, params: Record<string, unknown>) => Promise<any>;

    async function turn(fn: (call: Call, data: Record<string, any>) => Promise<void>): Promise<void> {
      const ac = new AbortController();
      const binding = h.adapter.dispatchIteration(runId, { signal: ac.signal });
      const call: Call = async (name, params) => {
        const tool = h.tools.find((t) => t.name === name);
        assert.ok(tool, `tool ${name} must exist`);
        const result = await tool!.execute("call", params as any, ac.signal, undefined, {} as any);
        return result.details;
      };
      try {
        await fn(call, h.registry.requireRun(runId).data as Record<string, any>);
      } finally {
        h.dispatcher.endIteration(binding.token);
      }
    }

    let guard = 0;
    while (guard++ < 60) {
      const current = h.registry.requireRun(runId);
      if (
        current.lifecycle === "completed" ||
        current.lifecycle === "cancelled" ||
        current.lifecycle === "blocked"
      ) {
        break;
      }

      const step = current.step;
      const data = current.data as Record<string, any>;

      if (step === "INITIAL") {
        await turn(async (call) => {
          await call("workflow_transition", {
            toStep: "IDLE",
            data: {
              issueQueue: "ready",
              implBudget: { attempts: 0, limit: 3 },
              reviewBudget: { rounds: 0, limit: 2 },
              nextAction: "claim",
            },
            reason: "Initialized github-coding run",
          });
        });
      } else if (step === "IDLE") {
        await turn(async (call) => {
          const listed = await call("workflow_provider_call", {
            capability: "github",
            operation: "listReadyIssues",
            input: {},
          });
          const issues = listed.result.issues as Array<{ number: number; title: string }>;
          assert.ok(issues.length > 0, "expected a ready issue");
          const issue = issues[0];

          await call("workflow_effect_begin", {
            key: `claim:acme/repo:${issue.number}`,
            kind: "github.issue.claim",
            inputSummary: { issue: issue.number },
          });
          const claim = await call("workflow_provider_call", {
            capability: "github",
            operation: "claimIssue",
            input: { issue: issue.number, claimToken: `run:${runId}:${issue.number}` },
            effectKey: `claim:acme/repo:${issue.number}`,
          });
          assert.equal(claim.result.claimed, true);

          await call("workflow_transition", {
            toStep: "CLAIMING",
            data: {
              issue: { repo: "acme/repo", number: issue.number, title: issue.title },
              claimToken: claim.result.claimToken,
              nextAction: "worktree",
            },
            reason: "claimed issue",
          });
        });
      } else if (step === "CLAIMING") {
        await turn(async (call) => {
          const issue = data.issue;
          const branch = `fix-${issue.number}`;
          const key = `worktree:acme/repo:${issue.number}`;
          await call("workflow_effect_begin", {
            key,
            kind: "worker.worktree.create",
            inputSummary: { issue: issue.number, branch },
          });
          const wt = await call("workflow_provider_call", {
            capability: "worker-runtime",
            operation: "createIsolatedWorktree",
            input: { issue: issue.number, branch, baseSha: "base-sha-1" },
            effectKey: key,
          });
          await call("workflow_transition", {
            toStep: "IMPLEMENTING",
            data: {
              worker: { worktreeId: wt.result.worktreeId, branch, baseSha: "base-sha-1" },
              nextAction: "implement",
            },
            reason: "created isolated worktree",
          });
        });
      } else if (step === "IMPLEMENTING") {
        await turn(async (call, turnData) => {
          const workerInfo = turnData.worker;
          const budget = turnData.implBudget;
          await call("workflow_transition", {
            toStep: "IMPLEMENTING",
            data: { implBudget: { ...budget, attempts: budget.attempts + 1 } },
            reason: "increment implementation attempts",
          });
          const key = `worker:impl:${workerInfo.worktreeId}:1`;
          await call("workflow_effect_begin", {
            key,
            kind: "worker.worker.run",
            inputSummary: { worktreeId: workerInfo.worktreeId, task: "implement" },
          });
          const result = await call("workflow_provider_call", {
            capability: "worker-runtime",
            operation: "runWorker",
            input: { worktreeId: workerInfo.worktreeId, task: "implement", revision: 1 },
            effectKey: key,
          });
          await call("workflow_transition", {
            toStep: "VERIFYING_IMPLEMENTATION",
            data: {
              implementation: { headSha: result.result.commitSha, workerReportTestsPassed: result.result.testsPassed },
              nextAction: "verify",
            },
            reason: "worker produced a commit",
          });
          await call("workflow_continue", { wakeupName: "worker", reason: "wait for worker then verify" });
        });
      } else if (step === "VERIFYING_IMPLEMENTATION") {
        await turn(async (call, turnData) => {
          const workerInfo = turnData.worker;
          const verification = await call("workflow_provider_call", {
            capability: "worker-runtime",
            operation: "verifyCommit",
            input: { worktreeId: workerInfo.worktreeId, expectedBranch: workerInfo.branch },
          });
          assert.equal(verification.result.verifiedBy, "independent-verifier");
          if (!verification.result.verified) {
            await call("workflow_block", {
              reason: "Independent verification failed for the authoritative commit",
              category: "human-required",
              requiresHuman: true,
            });
            return;
          }
          await call("workflow_transition", {
            toStep: "OPENING_PR",
            data: {
              implementation: { ...turnData.implementation, commitVerified: true },
              nextAction: "open_pr",
            },
            reason: "independently verified commit",
          });
        });
      } else if (step === "OPENING_PR") {
        await turn(async (call, turnData) => {
          const issue = turnData.issue;
          const workerInfo = turnData.worker;
          const headSha = turnData.implementation.headSha;

          const pushKey = `push:acme/repo:${issue.number}:${headSha}`;
          await call("workflow_effect_begin", {
            key: pushKey,
            kind: "github.branch.push",
            inputSummary: { head: workerInfo.branch, headSha },
          });
          await call("workflow_provider_call", {
            capability: "github",
            operation: "pushBranch",
            input: { head: workerInfo.branch, headSha },
            effectKey: pushKey,
          });

          const existing = await call("workflow_provider_call", {
            capability: "github",
            operation: "findPullRequest",
            input: { issue: issue.number, head: workerInfo.branch, base: "main" },
          });

          let prNumber: number;
          if (existing.result.pr) {
            prNumber = existing.result.pr.number;
          } else {
            const prKey = `pr:acme/repo:${issue.number}:${workerInfo.branch}`;
            await call("workflow_effect_begin", {
              key: prKey,
              kind: "github.pull_request.create",
              inputSummary: { issue: issue.number, head: workerInfo.branch, base: "main", headSha },
            });
            const pr = await call("workflow_provider_call", {
              capability: "github",
              operation: "createPullRequest",
              input: {
                issue: issue.number,
                head: workerInfo.branch,
                base: "main",
                headSha,
                title: `Fix #${issue.number}`,
              },
              effectKey: prKey,
            });
            prNumber = pr.result.number;
          }

          await call("workflow_transition", {
            toStep: "WAITING_CI",
            data: {
              pr: { number: prNumber, headBranch: workerInfo.branch, headSha, ciStatus: "pending" },
              nextAction: "wait_ci",
            },
            reason: "pushed branch and opened PR",
          });
        });
      } else if (step === "WAITING_CI") {
        await turn(async (call, turnData) => {
          const pr = turnData.pr;
          const ci = await call("workflow_provider_call", {
            capability: "github",
            operation: "inspectCi",
            input: { pr: pr.number },
          });
          if (ci.result.status === "success") {
            await call("workflow_transition", {
              toStep: "REVIEWING",
              data: {
                pr: { ...pr, ciStatus: "success", ciRunId: ci.result.runId },
                nextAction: "review",
              },
              reason: "CI green",
            });
          } else if (ci.result.status === "failure") {
            await call("workflow_block", {
              reason: "CI failed on the pull request head",
              category: "human-required",
              requiresHuman: true,
            });
          } else {
            // Deterministically complete CI, then wait one bounded wakeup.
            h.reality && h.github.setCiStatus(pr.number, "success");
            await call("workflow_continue", { wakeupName: "ci", reason: "waiting for CI" });
          }
        });
      } else if (step === "REVIEWING") {
        await turn(async (call, turnData) => {
          const pr = turnData.pr;
          const revision = (turnData.review?.revision ?? 0) + 1;
          const key = `review:acme/repo:${pr.number}:${revision}`;
          await call("workflow_effect_begin", {
            key,
            kind: "github.review.record",
            inputSummary: { pr: pr.number, revision },
          });
          const review = await call("workflow_provider_call", {
            capability: "github",
            operation: "requestChanges",
            input: {
              pr: pr.number,
              revision,
              findings: revision === 1 ? "Please add regression tests" : "Looks good",
            },
            effectKey: key,
          });
          const decision = review.result.decision;
          await call("workflow_transition", {
            toStep: decision === "changes_requested" ? "FIXING_REVIEW" : "MERGING",
            data: {
              review: { revision, decision, attempt: revision },
              nextAction: decision === "changes_requested" ? "fix" : "merge",
            },
            reason: `review decision: ${decision}`,
          });
        });
      } else if (step === "FIXING_REVIEW") {
        await turn(async (call, turnData) => {
          const issue = turnData.issue;
          const workerInfo = turnData.worker;
          const budget = turnData.reviewBudget;
          const reviewRevision = turnData.review.revision;
          await call("workflow_transition", {
            toStep: "FIXING_REVIEW",
            data: { reviewBudget: { ...budget, rounds: budget.rounds + 1 } },
            reason: "increment review-fix rounds",
          });
          const fixKey = `worker:fix:${workerInfo.worktreeId}:${reviewRevision}`;
          await call("workflow_effect_begin", {
            key: fixKey,
            kind: "worker.worker.run",
            inputSummary: { worktreeId: workerInfo.worktreeId, task: "fix" },
          });
          const fixed = await call("workflow_provider_call", {
            capability: "worker-runtime",
            operation: "runWorker",
            input: { worktreeId: workerInfo.worktreeId, task: "fix", revision: reviewRevision },
            effectKey: fixKey,
          });
          const verification = await call("workflow_provider_call", {
            capability: "worker-runtime",
            operation: "verifyCommit",
            input: { worktreeId: workerInfo.worktreeId, expectedBranch: workerInfo.branch },
          });
          if (!verification.result.verified) {
            await call("workflow_block", {
              reason: "Independent verification failed after the review fix",
              category: "human-required",
              requiresHuman: true,
            });
            return;
          }
          const newSha = fixed.result.commitSha;
          const pushKey = `push:acme/repo:${issue.number}:${newSha}`;
          await call("workflow_effect_begin", {
            key: pushKey,
            kind: "github.branch.push",
            inputSummary: { head: workerInfo.branch, headSha: newSha },
          });
          await call("workflow_provider_call", {
            capability: "github",
            operation: "pushBranch",
            input: { head: workerInfo.branch, headSha: newSha },
            effectKey: pushKey,
          });
          await call("workflow_transition", {
            toStep: "WAITING_CI",
            data: {
              implementation: { ...turnData.implementation, headSha: newSha, commitVerified: true },
              pr: { ...turnData.pr, headSha: newSha, ciStatus: "pending" },
              nextAction: "wait_ci",
            },
            reason: "pushed review fix",
          });
        });
      } else if (step === "MERGING") {
        await turn(async (call, turnData) => {
          const pr = turnData.pr;
          const inspect = await call("workflow_provider_call", {
            capability: "github",
            operation: "inspectPullRequest",
            input: { pr: pr.number },
          });
          if (inspect.result.merged) {
            await call("workflow_transition", {
              toStep: "FINALIZING",
              data: {
                pr: { ...pr, state: "merged", mergeSha: inspect.result.mergeSha },
                nextAction: "finalize",
              },
              reason: "PR already merged",
            });
            return;
          }
          const headSha = inspect.result.headSha;
          const key = `merge:acme/repo:${pr.number}:${headSha}`;
          await call("workflow_effect_begin", {
            key,
            kind: "github.pull_request.merge",
            inputSummary: { pr: pr.number, expectedHeadSha: headSha },
          });
          const merged = await call("workflow_provider_call", {
            capability: "github",
            operation: "mergePullRequest",
            input: { pr: pr.number, expectedHeadSha: headSha },
            effectKey: key,
          });
          await call("workflow_transition", {
            toStep: "FINALIZING",
            data: {
              pr: { ...pr, state: "merged", headSha, mergeSha: merged.result.mergeSha },
              nextAction: "finalize",
            },
            reason: "merged PR at verified head SHA",
          });
        });
      } else if (step === "FINALIZING") {
        await turn(async (call, turnData) => {
          const issue = turnData.issue;
          const pr = turnData.pr;
          const key = `finalize:acme/repo:${issue.number}:${pr.number}`;
          await call("workflow_effect_begin", {
            key,
            kind: "github.issue.finalize",
            inputSummary: { issue: issue.number, pr: pr.number },
          });
          await call("workflow_provider_call", {
            capability: "github",
            operation: "finalizeIssue",
            input: { issue: issue.number, pr: pr.number },
            effectKey: key,
          });
          await call("workflow_transition", {
            toStep: "COMPLETED",
            data: { nextAction: "complete" },
            reason: "finalized issue/project state",
          });
        });
      } else if (step === "COMPLETED") {
        await turn(async (call, turnData) => {
          await call("workflow_complete", {
            summary: `Shipped issue #${turnData.issue.number}`,
            evidence: [
              {
                type: "pr",
                description: "Pull request merged",
                url: `https://github.com/acme/repo/pull/${turnData.pr.number}`,
              },
              {
                type: "commit",
                description: "Independently verified commit",
                data: { sha: turnData.implementation.headSha },
              },
              { type: "test", description: "CI green and independent verification passed" },
            ],
            data: { nextAction: "done" },
          });
        });
      } else if (step === "VERIFYING") {
        await turn(async (call) => {
          await call("workflow_verify", {
            decision: "accept",
            findings: "Independent verifier confirmed the merged PR and green CI",
          });
        });
      } else {
        throw new Error(`Unexpected step "${step}"`);
      }
    }

    const finalRun = h.registry.requireRun(runId);
    assert.equal(finalRun.lifecycle, "completed", `run should complete (step: ${finalRun.step})`);
    assert.equal(finalRun.verificationFindings?.decision, "accepted");
    assert.match(finalRun.completion?.summary ?? "", /Shipped issue #12/);
    assert.ok((finalRun.completion?.evidence?.length ?? 0) >= 1);

    // Bounded sub-budgets persisted in durable run data.
    assert.equal((finalRun.data.implBudget as any).attempts, 1);
    assert.equal((finalRun.data.reviewBudget as any).rounds, 1);

    // Exactly one PR creation and one merge under stable effect keys.
    assert.equal(h.reality.counters.prCreated, 1);
    assert.equal(h.reality.counters.prCreateAttempts, 1);
    assert.equal(h.reality.counters.mergeAttempts, 1);
    assert.equal(h.reality.counters.mergesApplied, 1);
    assert.equal(h.reality.counters.finalizeApplied, 1);
    assert.equal(h.reality.counters.workerRuns, 2);
    assert.ok(h.reality.counters.verifications >= 2);

    // Named external waits were used and reached the scheduler.
    const waitDelays = h.loopService.wakeups.map((w) => w.delayMs);
    assert.ok(waitDelays.includes(2 * 60_000), "worker wait scheduled");
    assert.ok(waitDelays.includes(5 * 60_000), "ci wait scheduled");
  });
});

// ---------------------------------------------------------------------------
// 3. Absent executable provider fails closed
// ---------------------------------------------------------------------------

describe("github-coding provider preflight (Issue #12)", () => {
  it("fails the /workflow start preflight when the github provider is absent", async () => {
    const h = createHarness({ github: false });
    const controller = new WorkflowCommandController({
      registry: h.registry,
      adapter: h.adapter,
      dispatcher: h.dispatcher,
      cwd: REPO_ROOT,
      capabilityRegistry: h.capabilityRegistry,
    });

    const res = await controller.execute("start github-coding");
    assert.equal(res.ok, false);
    assert.match(res.output, /requires capabilities: \[github\]/);
    assert.equal(h.registry.listRuns().length, 0, "no run created when a provider is absent");
    assert.equal(h.loopService.listTasks().length, 0, "no scheduler task created");
  });

  it("fails a provider call closed when the capability has no provider", async () => {
    const h = createHarness({ github: false });
    const { run } = await h.adapter.startRun(h.def);
    const ac = new AbortController();
    const binding = h.adapter.dispatchIteration(run.id, { signal: ac.signal });
    const tool = h.tools.find((t) => t.name === "workflow_provider_call")!;
    try {
      await assert.rejects(
        async () =>
          tool.execute(
            "call",
            { capability: "github", operation: "listReadyIssues", input: {} },
            ac.signal,
            undefined,
            {} as any
          ),
        (err: unknown) => {
          assert.ok(err instanceof WorkflowProviderCallError);
          assert.equal((err as WorkflowProviderCallError).code, "capability_missing");
          return true;
        }
      );
    } finally {
      h.dispatcher.endIteration(binding.token);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Worker boundary
// ---------------------------------------------------------------------------

describe("github-coding worker boundary (Issue #12)", () => {
  it("gives the worker no GitHub operations and cannot reach a github provider", async () => {
    const h = createHarness();
    const workerRegistry = createWorkflowCapabilityRegistry({ sessionId: "worker-session" });
    workerRegistry.register(h.worker.registration());

    // The worker-runtime provider advertises only worker operations.
    const workerOps = Object.keys(workerRegistry.getProviderOperations("worker-runtime")!);
    assert.deepEqual(workerOps.sort(), [
      "createIsolatedWorktree",
      "inspectWorker",
      "runWorker",
      "verifyCommit",
    ]);
    assert.ok(!workerOps.includes("mergePullRequest"));
    assert.ok(!workerOps.includes("createPullRequest"));
    assert.equal(workerRegistry.has("github"), false);

    // A worker-scoped tool bound to the same run cannot reach GitHub.
    const workerCallTool = createWorkflowProviderCallTool(
      h.dispatcher,
      h.registry,
      workerRegistry
    );
    const { run } = await h.adapter.startRun(h.def);
    const ac = new AbortController();
    const binding = h.adapter.dispatchIteration(run.id, { signal: ac.signal });
    try {
      await assert.rejects(
        async () =>
          workerCallTool.execute(
            "call",
            { capability: "github", operation: "listReadyIssues", input: {} },
            ac.signal,
            undefined,
            {} as any
          ),
        (err: unknown) => {
          assert.ok(err instanceof WorkflowProviderCallError);
          assert.equal((err as WorkflowProviderCallError).code, "capability_missing");
          return true;
        }
      );
    } finally {
      h.dispatcher.endIteration(binding.token);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Generic provider-action seam safety
// ---------------------------------------------------------------------------

const CUSTOM_WORKFLOW = `---
name: custom-provider-wf
description: Workflow declaring a custom provider capability.
mode: self-paced
requires:
  - custom
---
body
`;

function makeOperation(overrides: Partial<WorkflowProviderOperation> = {}): WorkflowProviderOperation {
  return {
    name: "doThing",
    validateInput: (input) => input as any,
    projectResult: () => ({ ok: true }),
    execute: () => ({ ok: true }),
    ...overrides,
  };
}

function setupCustomProvider(
  operations: WorkflowProviderOperation[],
  extras: { status?: "available" | "degraded" | "unavailable"; reason?: string } = {}
) {
  const session = new FakeSessionManager({ sessionId: "seam-session" });
  const registry = new WorkflowRunRegistry(session);
  const dispatcher = new WorkflowDispatcher(registry);
  const capabilityRegistry = createWorkflowCapabilityRegistry({ sessionId: "seam-session" });
  capabilityRegistry.register({ name: "custom", version: 1, features: ["x"], operations, ...extras });
  const def = parseWorkflowContent(CUSTOM_WORKFLOW, { path: "custom.md", scope: "project" });
  const run = registry.createRun(def);
  const tool = createWorkflowProviderCallTool(dispatcher, registry, capabilityRegistry);

  const invoke = async (params: Record<string, unknown>) => {
    const ac = new AbortController();
    const binding = dispatcher.beginIteration(run.id, { signal: ac.signal, incrementTurns: false });
    try {
      const result = await tool.execute("call", params as any, ac.signal, undefined, {} as any);
      return result.details as any;
    } finally {
      dispatcher.endIteration(binding.token);
    }
  };

  return { registry, capabilityRegistry, dispatcher, run, tool, invoke };
}

describe("workflow_provider_call seam (Issue #12)", () => {
  it("requires a validateInput and a model-safe projectResult at registration", () => {
    const registry = createWorkflowCapabilityRegistry({ sessionId: "s" });
    assert.throws(
      () =>
        registry.register({
          name: "a",
          operations: [{ name: "op", execute: () => ({}) } as any],
        }),
      /validateInput/
    );
    assert.throws(
      () =>
        registry.register({
          name: "b",
          operations: [{ name: "op", validateInput: (i: unknown) => i as any, execute: () => ({}) } as any],
        }),
      /projectResult/
    );
  });

  it("requires a non-empty effectKind for every mutating operation", () => {
    const registry = createWorkflowCapabilityRegistry({ sessionId: "s" });
    assert.throws(
      () =>
        registry.register({
          name: "c",
          operations: [
            { name: "op", mutating: true, validateInput: (i: unknown) => i as any, projectResult: () => ({}), execute: () => ({}) } as any,
          ],
        }),
      /effectKind/
    );
  });

  it("returns only the model-safe projection, never raw provider output", async () => {
    const secretToken = `ghp_${"a".repeat(30)}`;
    const secretKey = `sk-${"b".repeat(24)}`;
    const { invoke } = setupCustomProvider([
      makeOperation({
        name: "readSecret",
        execute: () => ({ ok: true, secretToken, apiKey: secretKey, internal: { handle: "raw" } }),
        projectResult: () => ({ ok: true }),
      }),
    ]);

    const details = await invoke({ capability: "custom", operation: "readSecret", input: {} });
    assert.deepEqual(details.result, { ok: true });
    const serialized = JSON.stringify(details);
    assert.ok(!serialized.includes("ghp_"), "raw token must not be exposed");
    assert.ok(!serialized.includes("sk-"), "raw key must not be exposed");
    assert.ok(!serialized.includes("raw"), "raw provider handle must not be exposed");
  });

  it("redacts secret-like values that survive a projectResult", async () => {
    const secretToken = `ghp_${"a".repeat(30)}`;
    const { invoke } = setupCustomProvider([
      makeOperation({
        name: "leakyProjection",
        execute: () => ({ token: secretToken }),
        projectResult: (r) => ({ token: (r as any).token }),
      }),
    ]);

    const details = await invoke({ capability: "custom", operation: "leakyProjection", input: {} });
    assert.equal(details.result.token, "[redacted token]");
    assert.ok(!JSON.stringify(details).includes("ghp_"));
  });

  it("bounds and redacts provider error text", async () => {
    const secretToken = `ghp_${"a".repeat(30)}`;
    const { invoke } = setupCustomProvider([
      makeOperation({
        name: "boom",
        execute: () => {
          throw new Error(`remote auth failed for token=${secretToken}`);
        },
      }),
    ]);

    await assert.rejects(
      async () => invoke({ capability: "custom", operation: "boom", input: {} }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowProviderCallError);
        assert.equal((err as WorkflowProviderCallError).code, "execution_failed");
        assert.ok(!err.message.includes("ghp_"), "error text must not leak the token");
        assert.match(err.message, /\[redacted/);
        return true;
      }
    );
  });

  it("bounds and redacts provider validator error text", async () => {
    const secretToken = `ghp_${"a".repeat(30)}`;
    const { invoke } = setupCustomProvider([
      makeOperation({
        name: "strict",
        validateInput: () => {
          throw new Error(`invalid input for token=${secretToken}`);
        },
      }),
    ]);

    await assert.rejects(
      async () => invoke({ capability: "custom", operation: "strict", input: {} }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowProviderCallError);
        assert.equal((err as WorkflowProviderCallError).code, "input_invalid");
        assert.ok(!err.message.includes("ghp_"), "validator error must not leak the token");
        assert.match(err.message, /\[redacted/);
        return true;
      }
    );
  });

  it("bounds and redacts provider reason text in unavailable/degraded refusals", async () => {
    const secretToken = `ghp_${"b".repeat(30)}`;
    const reader = makeOperation({ name: "read", execute: () => ({ ok: true }) });

    const unavailable = setupCustomProvider([reader], {
      status: "unavailable",
      reason: `remote down for token=${secretToken}`,
    });
    await assert.rejects(
      async () => unavailable.invoke({ capability: "custom", operation: "read", input: {} }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowProviderCallError);
        assert.equal((err as WorkflowProviderCallError).code, "capability_unavailable");
        assert.ok(!err.message.includes("ghp_"), "unavailable reason must not leak the token");
        assert.match(err.message, /\[redacted/);
        return true;
      }
    );

    const degraded = setupCustomProvider(
      [
        makeOperation({
          name: "mutate",
          mutating: true,
          effectKind: "custom.mutate",
          execute: () => ({ applied: true }),
          projectResult: () => ({ applied: true }),
        }),
      ],
      { status: "degraded", reason: `reduced mode for token=${secretToken}` }
    );
    await assert.rejects(
      async () =>
        degraded.invoke({ capability: "custom", operation: "mutate", input: {}, effectKey: "any" }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowProviderCallError);
        assert.equal((err as WorkflowProviderCallError).code, "provider_degraded");
        assert.ok(!err.message.includes("ghp_"), "degraded reason must not leak the token");
        assert.match(err.message, /\[redacted/);
        return true;
      }
    );
  });

  it("refuses operations not on the allowlist and undeclared capabilities", async () => {
    const { invoke } = setupCustomProvider([makeOperation()]);

    await assert.rejects(
      async () => invoke({ capability: "custom", operation: "notAllowed", input: {} }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowProviderCallError);
        assert.equal((err as WorkflowProviderCallError).code, "operation_not_allowlisted");
        return true;
      }
    );

    await assert.rejects(
      async () => invoke({ capability: "other", operation: "doThing", input: {} }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowProviderCallError);
        assert.equal((err as WorkflowProviderCallError).code, "capability_not_declared");
        return true;
      }
    );
  });

  it("requires and validates a durable effect checkpoint for mutations", async () => {
    const mutating = makeOperation({
      name: "mutate",
      mutating: true,
      effectKind: "custom.mutate",
      execute: () => ({ applied: true }),
      projectResult: () => ({ applied: true }),
    });
    const { invoke, registry, run } = setupCustomProvider([mutating]);

    // No effect key -> refused.
    await assert.rejects(
      async () => invoke({ capability: "custom", operation: "mutate", input: {} }),
      (err: unknown) => {
        assert.equal((err as WorkflowProviderCallError).code, "effect_required");
        return true;
      }
    );

    // Kind mismatch -> refused.
    registry.beginEffect(run.id, { key: "e1", kind: "custom.other" });
    await assert.rejects(
      async () => invoke({ capability: "custom", operation: "mutate", input: {}, effectKey: "e1" }),
      (err: unknown) => {
        assert.equal((err as WorkflowProviderCallError).code, "effect_kind_mismatch");
        return true;
      }
    );
    registry.reconcileEffect(run.id, { key: "e1", resolution: "aborted", reason: "test reset" });

    // Already committed -> refused (no duplicate mutation).
    registry.beginEffect(run.id, { key: "e2", kind: "custom.mutate" });
    registry.commitEffect(run.id, { key: "e2" });
    await assert.rejects(
      async () => invoke({ capability: "custom", operation: "mutate", input: {}, effectKey: "e2" }),
      (err: unknown) => {
        assert.equal((err as WorkflowProviderCallError).code, "effect_already_committed");
        return true;
      }
    );

    // Started, matching kind -> dispatch and auto-commit.
    registry.beginEffect(run.id, { key: "e3", kind: "custom.mutate" });
    const details = await invoke({ capability: "custom", operation: "mutate", input: {}, effectKey: "e3" });
    assert.equal(details.effectCommitted, true);
    assert.equal(registry.requireRun(run.id).effects!.e3.status, "committed");
  });

  it("marks a mutating effect ambiguous when result projection fails after execute", async () => {
    const secretToken = `ghp_${"c".repeat(30)}`;
    const { invoke, registry, run } = setupCustomProvider([
      makeOperation({
        name: "mutate",
        mutating: true,
        effectKind: "custom.mutate",
        execute: () => ({ ok: true }),
        projectResult: () => {
          throw new Error(`projection failed for token=${secretToken}`);
        },
      }),
    ]);
    registry.beginEffect(run.id, { key: "e1", kind: "custom.mutate" });

    // Raw validation/projection failure after execute must mark the effect
    // ambiguous (the mutation may already be applied) and redact the error.
    await assert.rejects(
      async () => invoke({ capability: "custom", operation: "mutate", input: {}, effectKey: "e1" }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowProviderCallError);
        assert.equal((err as WorkflowProviderCallError).code, "execution_failed");
        assert.ok(!err.message.includes("ghp_"));
        assert.match(err.message, /\[redacted/);
        return true;
      }
    );
    assert.equal(registry.requireRun(run.id).effects!.e1.ambiguous, true);

    // A same-session retry is refused until the effect is reconciled.
    await assert.rejects(
      async () => invoke({ capability: "custom", operation: "mutate", input: {}, effectKey: "e1" }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowProviderCallError);
        assert.equal((err as WorkflowProviderCallError).code, "effect_ambiguous");
        return true;
      }
    );
  });

  it("allows reads but refuses mutations while an effect is ambiguous after reload", async () => {
    const mutating = makeOperation({
      name: "mutate",
      mutating: true,
      effectKind: "custom.mutate",
      execute: () => ({ applied: true }),
      projectResult: () => ({ applied: true }),
    });
    const reader = makeOperation({ name: "read", execute: () => ({ ok: true }) });

    const session = new FakeSessionManager({ sessionId: "amb-session" });
    const registry1 = new WorkflowRunRegistry(session);
    const capabilityRegistry = createWorkflowCapabilityRegistry({ sessionId: "amb-session" });
    capabilityRegistry.register({ name: "custom", version: 1, features: ["x"], operations: [mutating, reader] });
    const def = parseWorkflowContent(CUSTOM_WORKFLOW, { path: "custom.md", scope: "project" });
    const run = registry1.createRun(def);
    registry1.beginEffect(run.id, { key: "amb", kind: "custom.mutate" });

    // Reload into a fresh registry: the started effect becomes ambiguous.
    const registry2 = new WorkflowRunRegistry();
    registry2.reconstructFromSession(session);
    const reloaded = registry2.requireRun(run.id);
    assert.equal(reloaded.effects!.amb.ambiguous, true);

    const dispatcher2 = new WorkflowDispatcher(registry2);
    const tool = createWorkflowProviderCallTool(dispatcher2, registry2, capabilityRegistry);
    const ac = new AbortController();
    const binding = dispatcher2.beginIteration(run.id, { signal: ac.signal, incrementTurns: false });
    try {
      // A read still works during reconciliation.
      const readResult = await tool.execute(
        "call",
        { capability: "custom", operation: "read", input: {} },
        ac.signal,
        undefined,
        {} as any
      );
      assert.equal((readResult.details as any).result.ok, true);

      // A mutating call using the ambiguous effect key is refused.
      await assert.rejects(
        async () =>
          tool.execute(
            "call",
            { capability: "custom", operation: "mutate", input: {}, effectKey: "amb" },
            ac.signal,
            undefined,
            {} as any
          ),
        (err: unknown) => {
          assert.ok(err instanceof WorkflowProviderCallError);
          assert.equal((err as WorkflowProviderCallError).code, "effect_ambiguous");
          return true;
        }
      );
    } finally {
      dispatcher2.endIteration(binding.token);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Pure-core boundary
// ---------------------------------------------------------------------------

describe("github-coding core boundary (Issue #12)", () => {
  it("imports no GitHub/tmux/process code into pure core", () => {
    const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"));
    assert.ok(files.includes("provider-actions.ts"));
    for (const file of files) {
      const content = readFileSync(`${SRC_DIR}/${file}`, "utf-8");
      assert.ok(!/child_process/.test(content), `${file} must not import child_process`);
      assert.ok(!/execSync\s*\(/.test(content), `${file} must not call execSync`);
      assert.ok(!/spawnSync\s*\(/.test(content), `${file} must not call spawnSync`);
      assert.ok(!/from\s+["']pi-tmux["']/.test(content), `${file} must not import pi-tmux`);
    }
  });
});
