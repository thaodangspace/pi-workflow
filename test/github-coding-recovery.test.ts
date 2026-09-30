/**
 * Issue #12: crash/recovery and replay safety for the github-coding reference.
 *
 * Fake external reality lives outside the durable run record, so it persists
 * across `reconstructFromSession` exactly like a real remote. Each test starts
 * an effect, applies (or does not apply) the external mutation, then reloads
 * the run and asserts read-before-write reconciliation with no duplicate
 * mutation under a stable effect key.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createWorkflowCapabilityRegistry } from "../src/capabilities.ts";
import { WorkflowDispatcher } from "../src/dispatcher.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { WorkflowRunRegistry } from "../src/registry.ts";
import { LoopSchedulerAdapter } from "../src/scheduler-adapter.ts";
import { createWorkflowTools } from "../src/tools.ts";
import { WorkflowProviderCallError } from "../src/types.ts";
import { FakeLoopService } from "./fake-loop-service.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";
import {
  createFakeReality,
  FakeGitHubProvider,
  FakeWorkerRuntimeProvider,
} from "./fake-providers.ts";

const WORKFLOW_PATH = fileURLToPath(new URL("../.pi/workflows/github-coding.md", import.meta.url));
const DEF = parseWorkflowContent(readFileSync(WORKFLOW_PATH, "utf-8"), {
  path: WORKFLOW_PATH,
  scope: "project",
});

interface RecoveryHarness {
  session: FakeSessionManager;
  registry: WorkflowRunRegistry;
  dispatcher: WorkflowDispatcher;
  capabilityRegistry: ReturnType<typeof createWorkflowCapabilityRegistry>;
  loopService: FakeLoopService;
  reality: ReturnType<typeof createFakeReality>;
  github: FakeGitHubProvider;
  worker: FakeWorkerRuntimeProvider;
  tools: ReturnType<typeof createWorkflowTools>;
  runId: string;
}

function setupRecovery(initialData: Record<string, any> = {}): RecoveryHarness {
  const session = new FakeSessionManager({ sessionId: "recovery-session" });
  const registry = new WorkflowRunRegistry(session);
  const dispatcher = new WorkflowDispatcher(registry);
  const capabilityRegistry = createWorkflowCapabilityRegistry({ sessionId: "recovery-session" });
  const loopService = new FakeLoopService({ sessionId: "recovery-session" });
  const adapter = new LoopSchedulerAdapter({
    registry,
    dispatcher,
    service: loopService,
    capabilityRegistry,
  });
  const reality = createFakeReality();
  const github = new FakeGitHubProvider(reality);
  const worker = new FakeWorkerRuntimeProvider(reality);
  capabilityRegistry.register(github.registration());
  capabilityRegistry.register(worker.registration());
  const tools = createWorkflowTools({ dispatcher, registry, capabilityRegistry });
  const run = registry.createRun(DEF, { initialStep: "OPENING_PR", initialData });
  return {
    session,
    registry,
    dispatcher,
    capabilityRegistry,
    loopService,
    reality,
    github,
    worker,
    tools,
    runId: run.id,
  };
}

/** Reconstruct the run exactly as a session reload would. */
function reload(h: RecoveryHarness) {
  const registry = new WorkflowRunRegistry();
  registry.reconstructFromSession(h.session);
  const dispatcher = new WorkflowDispatcher(registry);
  const tools = createWorkflowTools({ dispatcher, registry, capabilityRegistry: h.capabilityRegistry });
  return { registry, dispatcher, tools };
}

async function callTool(
  dispatcher: WorkflowDispatcher,
  tools: ReturnType<typeof createWorkflowTools>,
  runId: string,
  name: string,
  params: Record<string, unknown>
): Promise<any> {
  const ac = new AbortController();
  const binding = dispatcher.beginIteration(runId, { signal: ac.signal, incrementTurns: false });
  try {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `tool ${name} must exist`);
    const result = await tool!.execute("call", params as any, ac.signal, undefined, {} as any);
    return result.details;
  } finally {
    dispatcher.endIteration(binding.token);
  }
}

describe("github-coding recovery and replay (Issue #12)", () => {
  it("reconciles a matching claim marker as committed without re-claiming", async () => {
    const h = setupRecovery();
    h.github.addIssue({ number: 12, title: "Fix", state: "open" });
    h.registry.beginEffect(h.runId, {
      key: "claim:acme/repo:12",
      kind: "github.issue.claim",
      inputSummary: { issue: 12 },
    });
    // The mutation actually happened before the crash.
    await h.github.invoke("claimIssue", { issue: 12, claimToken: "token-T" });

    const r = reload(h);
    assert.equal(r.registry.requireRun(h.runId).effects!["claim:acme/repo:12"].ambiguous, true);

    const state = await callTool(r.dispatcher, r.tools, h.runId, "workflow_provider_call", {
      capability: "github",
      operation: "readClaimState",
      input: { issue: 12 },
    });
    assert.equal(state.result.claimed, true);
    assert.equal(state.result.claimToken, "token-T");

    const rec = await callTool(r.dispatcher, r.tools, h.runId, "workflow_effect_reconcile", {
      key: "claim:acme/repo:12",
      resolution: "committed",
      reason: "authoritative claim marker matches this run",
      resultSummary: { issue: 12 },
    });
    assert.equal(rec.status, "committed");
    assert.equal(h.reality.counters.claimAttempts, 1, "must not re-claim after reconciliation");
  });

  it("blocks an ambiguous claim owned by another party", async () => {
    const h = setupRecovery();
    h.github.addIssue({ number: 12, title: "Fix", state: "open" });
    h.registry.beginEffect(h.runId, {
      key: "claim:acme/repo:12",
      kind: "github.issue.claim",
    });
    const issue = h.reality.issues.get(12)!;
    issue.owner = "other-agent";
    issue.claimToken = "token-OTHER";

    const r = reload(h);
    const state = await callTool(r.dispatcher, r.tools, h.runId, "workflow_provider_call", {
      capability: "github",
      operation: "readClaimState",
      input: { issue: 12 },
    });
    assert.equal(state.result.claimed, true);
    assert.equal(state.result.owner, "other-agent");

    await callTool(r.dispatcher, r.tools, h.runId, "workflow_block", {
      reason: "Issue 12 is already claimed by other-agent; refusing to proceed",
      category: "human-required",
      requiresHuman: true,
    });
    const blocked = r.registry.requireRun(h.runId);
    assert.equal(blocked.lifecycle, "blocked");
    assert.equal(h.reality.counters.claimAttempts, 0);
  });

  it("clears an ambiguous claim for retry only when provably unclaimed", async () => {
    const h = setupRecovery();
    h.github.addIssue({ number: 12, title: "Fix", state: "open" });
    h.registry.beginEffect(h.runId, {
      key: "claim:acme/repo:12",
      kind: "github.issue.claim",
    });
    // No external mutation occurred before the crash.

    const r = reload(h);
    const state = await callTool(r.dispatcher, r.tools, h.runId, "workflow_provider_call", {
      capability: "github",
      operation: "readClaimState",
      input: { issue: 12 },
    });
    assert.equal(state.result.claimed, false);

    await callTool(r.dispatcher, r.tools, h.runId, "workflow_effect_reconcile", {
      key: "claim:acme/repo:12",
      resolution: "retryable",
      reason: "issue is provably unclaimed; safe to retry",
    });
    assert.equal(r.registry.requireRun(h.runId).effects!["claim:acme/repo:12"].status, "reconciled");
    assert.equal(h.reality.counters.claimAttempts, 0);
  });

  it("reconciles a PR that already exists at OPENING_PR without creating a duplicate", async () => {
    const h = setupRecovery({ issue: { repo: "acme/repo", number: 12 } });
    h.github.addIssue({ number: 12, title: "Fix", state: "open" });
    h.registry.beginEffect(h.runId, {
      key: "pr:acme/repo:12:fix-12",
      kind: "github.pull_request.create",
    });
    await h.github.invoke("createPullRequest", {
      issue: 12,
      head: "fix-12",
      base: "main",
      headSha: "sha-1",
      title: "Fix #12",
    });

    const r = reload(h);
    const found = await callTool(r.dispatcher, r.tools, h.runId, "workflow_provider_call", {
      capability: "github",
      operation: "findPullRequest",
      input: { issue: 12, head: "fix-12", base: "main" },
    });
    assert.equal(found.result.matches, 1);
    assert.equal(found.result.pr.number, 1);

    await callTool(r.dispatcher, r.tools, h.runId, "workflow_effect_reconcile", {
      key: "pr:acme/repo:12:fix-12",
      resolution: "committed",
      reason: "PR already exists for issue+head+base",
      resultSummary: { prNumber: found.result.pr.number },
    });

    assert.equal(h.reality.counters.prCreateAttempts, 1, "no duplicate PR create attempt");
    assert.equal(h.reality.counters.prCreated, 1);
  });

  it("blocks when multiple PRs match at OPENING_PR", async () => {
    const h = setupRecovery();
    h.github.addIssue({ number: 12, title: "Fix", state: "open" });
    h.registry.beginEffect(h.runId, {
      key: "pr:acme/repo:12:fix-12",
      kind: "github.pull_request.create",
    });
    await h.github.invoke("createPullRequest", {
      issue: 12,
      head: "fix-12",
      base: "main",
      headSha: "sha-1",
      title: "Fix #12",
    });
    // Simulate an inconsistent remote with two matching PRs.
    h.reality.pullRequests.push({ ...h.reality.pullRequests[0], number: 99 });

    const r = reload(h);
    const found = await callTool(r.dispatcher, r.tools, h.runId, "workflow_provider_call", {
      capability: "github",
      operation: "findPullRequest",
      input: { issue: 12, head: "fix-12", base: "main" },
    });
    assert.equal(found.result.matches, 2);

    await callTool(r.dispatcher, r.tools, h.runId, "workflow_block", {
      reason: "Multiple matching pull requests; human must disambiguate",
      category: "human-required",
      requiresHuman: true,
    });
    assert.equal(r.registry.requireRun(h.runId).lifecycle, "blocked");
    assert.equal(h.reality.counters.prCreateAttempts, 1);
  });

  it("resumes from a worker that exited with a valid commit without respawning", async () => {
    const h = setupRecovery();
    h.github.addIssue({ number: 12, title: "Fix", state: "open" });
    const wt = await h.worker.invoke("createIsolatedWorktree", {
      issue: 12,
      branch: "fix-12",
      baseSha: "base-1",
    });
    const worktreeId = (wt as any).worktreeId;
    h.registry.beginEffect(h.runId, {
      key: `worker:impl:${worktreeId}:1`,
      kind: "worker.worker.run",
    });
    await h.worker.invoke("runWorker", { worktreeId, task: "implement", revision: 1 });

    const r = reload(h);
    const inspect = await callTool(r.dispatcher, r.tools, h.runId, "workflow_provider_call", {
      capability: "worker-runtime",
      operation: "inspectWorker",
      input: { worktreeId },
    });
    assert.equal(inspect.result.hasValidCommit, true);

    const verified = await callTool(r.dispatcher, r.tools, h.runId, "workflow_provider_call", {
      capability: "worker-runtime",
      operation: "verifyCommit",
      input: { worktreeId, expectedBranch: "fix-12" },
    });
    assert.equal(verified.result.verified, true);
    assert.equal(verified.result.verifiedBy, "independent-verifier");

    await callTool(r.dispatcher, r.tools, h.runId, "workflow_effect_reconcile", {
      key: `worker:impl:${worktreeId}:1`,
      resolution: "committed",
      reason: "authoritative commit verified independently of the worker report",
    });

    assert.equal(h.reality.counters.workerRuns, 1, "must not respawn the worker");
  });

  it("does not trust a worker report without an authoritative commit", async () => {
    const h = setupRecovery();
    h.github.addIssue({ number: 12, title: "Fix", state: "open" });
    const wt = await h.worker.invoke("createIsolatedWorktree", {
      issue: 12,
      branch: "fix-12",
      baseSha: "base-1",
    });
    const worktreeId = (wt as any).worktreeId;
    h.registry.beginEffect(h.runId, {
      key: `worker:impl:${worktreeId}:1`,
      kind: "worker.worker.run",
    });
    const run = await h.worker.invoke("runWorker", { worktreeId, task: "implement", revision: 1 });
    const commitSha = (run as any).commitSha;

    // The worker *reported* a commit, but authoritative reality lacks it.
    h.reality.commits.delete(commitSha);

    const r = reload(h);
    const verified = await callTool(r.dispatcher, r.tools, h.runId, "workflow_provider_call", {
      capability: "worker-runtime",
      operation: "verifyCommit",
      input: { worktreeId, expectedBranch: "fix-12" },
    });
    assert.equal(verified.result.verified, false);

    await callTool(r.dispatcher, r.tools, h.runId, "workflow_effect_reconcile", {
      key: `worker:impl:${worktreeId}:1`,
      resolution: "aborted",
      reason: "worker report had no authoritative commit",
    });
    assert.equal(r.registry.requireRun(h.runId).effects![`worker:impl:${worktreeId}:1`].status, "reconciled");
  });

  it("reconciles an already-merged PR at MERGING without a second merge", async () => {
    const h = setupRecovery();
    h.github.addIssue({ number: 12, title: "Fix", state: "open" });
    await h.github.invoke("claimIssue", { issue: 12, claimToken: "t" });
    await h.github.invoke("pushBranch", { head: "fix-12", headSha: "sha-1" });
    const pr = await h.github.invoke("createPullRequest", {
      issue: 12,
      head: "fix-12",
      base: "main",
      headSha: "sha-1",
      title: "Fix #12",
    });
    const prNumber = (pr as any).number;

    h.registry.beginEffect(h.runId, {
      key: `merge:acme/repo:${prNumber}:sha-1`,
      kind: "github.pull_request.merge",
      inputSummary: { pr: prNumber, expectedHeadSha: "sha-1" },
    });
    // The merge actually happened before the crash.
    await h.github.invoke("mergePullRequest", { pr: prNumber, expectedHeadSha: "sha-1" });

    const r = reload(h);
    const inspect = await callTool(r.dispatcher, r.tools, h.runId, "workflow_provider_call", {
      capability: "github",
      operation: "inspectPullRequest",
      input: { pr: prNumber },
    });
    assert.equal(inspect.result.merged, true);
    assert.equal(inspect.result.mergeSha, `merge-${prNumber}-sha-1`);

    await callTool(r.dispatcher, r.tools, h.runId, "workflow_effect_reconcile", {
      key: `merge:acme/repo:${prNumber}:sha-1`,
      resolution: "committed",
      reason: "PR already merged at the expected head",
      resultSummary: { prNumber, mergeSha: inspect.result.mergeSha },
    });

    assert.equal(h.reality.counters.mergeAttempts, 1, "no second merge attempt");
    assert.equal(h.reality.counters.mergesApplied, 1);
  });

  it("distinguishes a crash before vs after an external mutation", async () => {
    // Crash BEFORE the mutation: effect stays started, no external change.
    const before = setupRecovery();
    before.github.addIssue({ number: 12, title: "Fix", state: "open" });
    before.registry.beginEffect(before.runId, {
      key: "claim:acme/repo:12",
      kind: "github.issue.claim",
    });
    const rBefore = reload(before);
    const stateBefore = await callTool(rBefore.dispatcher, rBefore.tools, before.runId, "workflow_provider_call", {
      capability: "github",
      operation: "readClaimState",
      input: { issue: 12 },
    });
    assert.equal(stateBefore.result.claimed, false);
    await callTool(rBefore.dispatcher, rBefore.tools, before.runId, "workflow_effect_reconcile", {
      key: "claim:acme/repo:12",
      resolution: "aborted",
      reason: "proven unclaimed after crash",
    });
    assert.equal(before.reality.counters.claimAttempts, 0);

    // Crash AFTER the mutation: effect stays started but reality changed.
    const after = setupRecovery();
    after.github.addIssue({ number: 12, title: "Fix", state: "open" });
    after.registry.beginEffect(after.runId, {
      key: "claim:acme/repo:12",
      kind: "github.issue.claim",
    });
    await after.github.invoke("claimIssue", { issue: 12, claimToken: "t" });
    const rAfter = reload(after);
    const stateAfter = await callTool(rAfter.dispatcher, rAfter.tools, after.runId, "workflow_provider_call", {
      capability: "github",
      operation: "readClaimState",
      input: { issue: 12 },
    });
    assert.equal(stateAfter.result.claimed, true);
    await callTool(rAfter.dispatcher, rAfter.tools, after.runId, "workflow_effect_reconcile", {
      key: "claim:acme/repo:12",
      resolution: "committed",
      reason: "observed claim after crash",
    });
    assert.equal(after.reality.counters.claimAttempts, 1);
  });

  it("persists fake external reality across repeated reconstruction", async () => {
    const h = setupRecovery();
    h.github.addIssue({ number: 12, title: "Fix", state: "open" });
    await h.github.invoke("claimIssue", { issue: 12, claimToken: "t" });
    await h.github.invoke("pushBranch", { head: "fix-12", headSha: "sha-1" });
    await h.github.invoke("createPullRequest", {
      issue: 12,
      head: "fix-12",
      base: "main",
      headSha: "sha-1",
      title: "Fix #12",
    });

    const first = reload(h);
    const second = reload(h);

    // External reality is unchanged by reconstruction: same single PR.
    assert.equal(h.reality.pullRequests.length, 1);
    assert.equal(h.reality.counters.prCreated, 1);
    assert.equal(h.reality.counters.prCreateAttempts, 1);
    assert.equal(first.registry.requireRun(h.runId).id, second.registry.requireRun(h.runId).id);

    // A provider call after reload still sees the persisted PR.
    const found = await callTool(second.dispatcher, second.tools, h.runId, "workflow_provider_call", {
      capability: "github",
      operation: "findPullRequest",
      input: { issue: 12, head: "fix-12", base: "main" },
    });
    assert.equal(found.result.matches, 1);
    assert.equal(h.reality.counters.prCreateAttempts, 1, "reads must not create");
  });

  it("refuses a mutating call whose effect key is missing from durable state", async () => {
    const h = setupRecovery();
    h.github.addIssue({ number: 12, title: "Fix", state: "open" });
    const r = reload(h);
    await assert.rejects(
      async () =>
        callTool(r.dispatcher, r.tools, h.runId, "workflow_provider_call", {
          capability: "github",
          operation: "claimIssue",
          input: { issue: 12, claimToken: "t" },
          effectKey: "claim:acme/repo:12",
        }),
      (err: unknown) => {
        assert.ok(err instanceof WorkflowProviderCallError);
        assert.equal((err as WorkflowProviderCallError).code, "effect_not_started");
        return true;
      }
    );
  });
});
