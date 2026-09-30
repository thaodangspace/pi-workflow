/**
 * Deterministic fake `github` and `worker-runtime` providers.
 *
 * These register through the SAME production action contract used by real
 * adapters: `WorkflowProviderOperation[]` on a `CapabilityProviderRegistration`.
 * They hold in-memory "external reality" that is deliberately separate from the
 * durable workflow run so tests can persist it across run reconstruction.
 *
 * No test using these fakes ever invokes live `gh`, `tmux`, `git push`, or a
 * merge: all operations are pure in-memory state machines.
 */

import type {
  CapabilityProviderRegistration,
  WorkflowProviderCallContext,
  WorkflowProviderOperation,
} from "../src/capabilities.ts";
import type { JsonValue } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Shared external reality
// ---------------------------------------------------------------------------

export interface FakeIssue {
  number: number;
  title: string;
  owner?: string;
  claimToken?: string;
  state: "open" | "closed";
}

export interface FakeReview {
  revision: number;
  decision: "changes_requested" | "approved";
  findings: string;
}

export interface FakePullRequest {
  number: number;
  issue: number;
  head: string;
  base: string;
  headSha: string;
  state: "open" | "merged";
  mergeSha?: string;
  ciStatus: "pending" | "success" | "failure";
  reviews: FakeReview[];
}

export interface FakeWorktree {
  id: string;
  issue: number;
  branch: string;
  baseSha: string;
  present: boolean;
  workerId?: string;
  workerRunning: boolean;
  exitStatus?: number;
  commitSha?: string;
  testsPassed: boolean;
  /** The worker's own (untrusted) report, kept separate from authoritative state. */
  workerReport?: { summary: string; testsPassed: boolean; commitSha?: string };
}

export type FaultPhase = "before" | "after";

export interface FakeReality {
  issues: Map<number, FakeIssue>;
  pullRequests: FakePullRequest[];
  worktrees: Map<string, FakeWorktree>;
  /** Authoritative commit registry keyed by SHA. */
  commits: Map<string, { branch: string; testsPassed: boolean; worktreeId: string }>;
  branches: Map<string, string>;
  counters: {
    claimAttempts: number;
    claimsGranted: number;
    pushAttempts: number;
    prCreateAttempts: number;
    prCreated: number;
    mergeAttempts: number;
    mergesApplied: number;
    finalizeAttempts: number;
    finalizeApplied: number;
    workerRuns: number;
    verifications: number;
  };
  /** One-shot fault injection keyed by operation name. */
  faults: Map<string, FaultPhase>;
  nextPrNumber: number;
  nextWorktreeId: number;
  /** Review decision per PR review index; defaults to changes then approve. */
  reviewPlan: ("changes_requested" | "approved")[];
}

export function createFakeReality(): FakeReality {
  return {
    issues: new Map(),
    pullRequests: [],
    worktrees: new Map(),
    commits: new Map(),
    branches: new Map(),
    counters: {
      claimAttempts: 0,
      claimsGranted: 0,
      pushAttempts: 0,
      prCreateAttempts: 0,
      prCreated: 0,
      mergeAttempts: 0,
      mergesApplied: 0,
      finalizeAttempts: 0,
      finalizeApplied: 0,
      workerRuns: 0,
      verifications: 0,
    },
    faults: new Map(),
    nextPrNumber: 1,
    nextWorktreeId: 1,
    reviewPlan: ["changes_requested", "approved"],
  };
}

function maybeFault(reality: FakeReality, operation: string, phase: FaultPhase): void {
  if (reality.faults.get(operation) === phase) {
    reality.faults.delete(operation);
    throw new Error(`Injected ${phase}-mutation fault in "${operation}"`);
  }
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function asRecord(input: JsonValue, operation: string): Record<string, JsonValue> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${operation} input must be an object`);
  }
  return input as Record<string, JsonValue>;
}

function numField(input: Record<string, JsonValue>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`input.${key} must be a finite number`);
  }
  return value;
}

function strField(input: Record<string, JsonValue>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`input.${key} must be a non-empty string`);
  }
  return value;
}

function optionalStrField(input: Record<string, JsonValue>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`input.${key} must be a non-empty string when provided`);
  }
  return value;
}

function issueExists(reality: FakeReality, issue: number): FakeIssue {
  const found = reality.issues.get(issue);
  if (!found) throw new Error(`unknown issue #${issue}`);
  return found;
}

function findPr(reality: FakeReality, number: number): FakePullRequest {
  const pr = reality.pullRequests.find((p) => p.number === number);
  if (!pr) throw new Error(`unknown pull request #${number}`);
  return pr;
}

// ---------------------------------------------------------------------------
// GitHub fake provider
// ---------------------------------------------------------------------------

export const FAKE_GITHUB_FEATURES = [
  "issues",
  "pull-requests",
  "ci",
  "reviews",
  "merge",
  "project-state",
] as const;

export class FakeGitHubProvider {
  readonly name = "github";
  readonly version = 1;
  readonly features: readonly string[] = [...FAKE_GITHUB_FEATURES];
  readonly operations: WorkflowProviderOperation[];

  constructor(private readonly reality: FakeReality) {
    this.operations = [
      this.op("listReadyIssues", false, undefined, (input) => this.listReadyIssues(input), (r) => ({
        issues: (r as any).issues,
      })),
      this.op("readClaimState", false, undefined, (input) => this.readClaimState(input), (r) => ({
        issue: (r as any).issue,
        claimed: (r as any).claimed,
        owner: (r as any).owner ?? null,
        claimToken: (r as any).claimToken ?? null,
      })),
      this.op("claimIssue", true, "github.issue.claim", (input) => this.claimIssue(input), (r) => ({
        issue: (r as any).issue,
        claimed: (r as any).claimed,
        claimToken: (r as any).claimToken ?? null,
      })),
      this.op("pushBranch", true, "github.branch.push", (input) => this.pushBranch(input), (r) => ({
        branch: (r as any).branch,
        headSha: (r as any).headSha,
        created: (r as any).created,
      })),
      this.op("findPullRequest", false, undefined, (input) => this.findPullRequest(input), (r) => ({
        matches: (r as any).matches,
        pr: (r as any).pr ?? null,
      })),
      this.op("createPullRequest", true, "github.pull_request.create", (input) => this.createPullRequest(input), (r) => ({
        number: (r as any).number,
        head: (r as any).head,
        base: (r as any).base,
        headSha: (r as any).headSha ?? null,
        ciStatus: (r as any).ciStatus ?? null,
      })),
      this.op("inspectPullRequest", false, undefined, (input) => this.inspectPullRequest(input), (r) => ({
        number: (r as any).number,
        state: (r as any).state,
        headSha: (r as any).headSha,
        merged: (r as any).merged,
        mergeSha: (r as any).mergeSha ?? null,
        ciStatus: (r as any).ciStatus,
        reviews: (r as any).reviews,
      })),
      this.op("inspectCi", false, undefined, (input) => this.inspectCi(input), (r) => ({
        pr: (r as any).pr,
        status: (r as any).status,
        runId: (r as any).runId,
      })),
      this.op("requestChanges", true, "github.review.record", (input) => this.requestChanges(input), (r) => ({
        prNumber: (r as any).prNumber,
        revision: (r as any).revision,
        decision: (r as any).decision,
      })),
      this.op("mergePullRequest", true, "github.pull_request.merge", (input) => this.mergePullRequest(input), (r) => ({
        prNumber: (r as any).prNumber,
        merged: (r as any).merged,
        mergeSha: (r as any).mergeSha ?? null,
      })),
      this.op("finalizeIssue", true, "github.issue.finalize", (input) => this.finalizeIssue(input), (r) => ({
        issue: (r as any).issue,
        state: (r as any).state,
        finalized: (r as any).finalized,
      })),
    ];
  }

  private op(
    name: string,
    mutating: boolean,
    effectKind: string | undefined,
    execute: (input: JsonValue, context: WorkflowProviderCallContext) => JsonValue,
    projectResult: (result: JsonValue) => Record<string, JsonValue>
  ): WorkflowProviderOperation {
    return {
      name,
      mutating,
      ...(effectKind ? { effectKind } : {}),
      validateInput: (raw) => asRecord(raw as JsonValue, name) as unknown as JsonValue,
      projectResult,
      execute: (input, context) => execute(input, context),
    };
  }

  /** Direct invocation for tests simulating external reality changes/crashes. */
  async invoke(operation: string, input: JsonValue): Promise<JsonValue> {
    const op = this.operations.find((o) => o.name === operation);
    if (!op) throw new Error(`Unknown fake github operation "${operation}"`);
    return await op.execute(input, {
      capability: "github",
      operation,
      runId: "external",
      workflow: "external",
      step: "external",
      iterationToken: "external",
      generation: -1,
      now: Date.now(),
    });
  }

  registration(): CapabilityProviderRegistration {
    return {
      name: this.name,
      version: this.version,
      features: this.features,
      operations: this.operations,
      api: Object.freeze({}),
    };
  }

  // ---- operations ----

  addIssue(issue: FakeIssue): void {
    this.reality.issues.set(issue.number, issue);
  }

  setCiStatus(prNumber: number, status: FakePullRequest["ciStatus"]): void {
    findPr(this.reality, prNumber).ciStatus = status;
  }

  private listReadyIssues(input: JsonValue): JsonValue {
    asRecord(input, "listReadyIssues");
    const issues = [...this.reality.issues.values()]
      .filter((i) => i.state === "open" && i.owner === undefined)
      .sort((a, b) => a.number - b.number)
      .map((i) => ({ number: i.number, title: i.title }));
    return { issues };
  }

  private readClaimState(input: JsonValue): JsonValue {
    const record = asRecord(input, "readClaimState");
    const issue = issueExists(this.reality, numField(record, "issue"));
    return {
      issue: issue.number,
      claimed: issue.owner !== undefined,
      ...(issue.owner ? { owner: issue.owner } : {}),
      ...(issue.claimToken ? { claimToken: issue.claimToken } : {}),
    };
  }

  private claimIssue(input: JsonValue): JsonValue {
    const record = asRecord(input, "claimIssue");
    const issue = issueExists(this.reality, numField(record, "issue"));
    const claimToken = strField(record, "claimToken");
    this.reality.counters.claimAttempts += 1;

    let result: JsonValue;
    if (issue.owner === undefined) {
      issue.owner = "main";
      issue.claimToken = claimToken;
      this.reality.counters.claimsGranted += 1;
      result = { issue: issue.number, claimed: true, claimToken };
    } else if (issue.claimToken === claimToken) {
      result = { issue: issue.number, claimed: true, alreadyOwned: true, claimToken };
    } else {
      result = { issue: issue.number, claimed: false, owner: issue.owner };
    }
    // "after" faults fire only once the external state change has been applied.
    maybeFault(this.reality, "claimIssue", "after");
    return result;
  }

  private pushBranch(input: JsonValue): JsonValue {
    const record = asRecord(input, "pushBranch");
    const head = strField(record, "head");
    const headSha = strField(record, "headSha");
    const created = !this.reality.branches.has(head);
    this.reality.counters.pushAttempts += 1;
    this.reality.branches.set(head, headSha);
    // A push to an existing PR branch advances the PR head and re-runs CI.
    for (const pr of this.reality.pullRequests) {
      if (pr.head === head && pr.state === "open") {
        pr.headSha = headSha;
        pr.ciStatus = "pending";
      }
    }
    maybeFault(this.reality, "pushBranch", "after");
    return { branch: head, headSha, created };
  }

  private findPullRequest(input: JsonValue): JsonValue {
    const record = asRecord(input, "findPullRequest");
    const issue = numField(record, "issue");
    const head = strField(record, "head");
    const base = optionalStrField(record, "base") ?? "main";
    const matches = this.reality.pullRequests.filter(
      (p) => p.issue === issue && p.head === head && p.base === base
    );
    if (matches.length !== 1) {
      return { matches: matches.length, pr: null };
    }
    const pr = matches[0];
    return {
      matches: 1,
      pr: { number: pr.number, issue: pr.issue, head: pr.head, base: pr.base, headSha: pr.headSha, state: pr.state },
    };
  }

  private createPullRequest(input: JsonValue): JsonValue {
    const record = asRecord(input, "createPullRequest");
    const issue = numField(record, "issue");
    const head = strField(record, "head");
    const base = strField(record, "base");
    const headSha = strField(record, "headSha");
    const title = strField(record, "title");
    this.reality.counters.prCreateAttempts += 1;

    const existing = this.reality.pullRequests.find(
      (p) => p.issue === issue && p.head === head && p.base === base
    );
    if (existing) {
      maybeFault(this.reality, "createPullRequest", "after");
      return { number: existing.number, head, base, alreadyExists: true, headSha: existing.headSha, ciStatus: existing.ciStatus };
    }
    const number = this.reality.nextPrNumber++;
    const pr: FakePullRequest = {
      number,
      issue,
      head,
      base,
      headSha,
      state: "open",
      ciStatus: "pending",
      reviews: [],
    };
    this.reality.pullRequests.push(pr);
    this.reality.counters.prCreated += 1;
    maybeFault(this.reality, "createPullRequest", "after");
    return { number, head, base, title, headSha, ciStatus: pr.ciStatus };
  }

  private inspectPullRequest(input: JsonValue): JsonValue {
    const record = asRecord(input, "inspectPullRequest");
    const pr = findPr(this.reality, numField(record, "pr"));
    return {
      number: pr.number,
      state: pr.state,
      head: pr.head,
      base: pr.base,
      headSha: pr.headSha,
      ciStatus: pr.ciStatus,
      merged: pr.state === "merged",
      ...(pr.mergeSha ? { mergeSha: pr.mergeSha } : {}),
      reviews: pr.reviews.map((r) => ({ revision: r.revision, decision: r.decision })),
    };
  }

  private inspectCi(input: JsonValue): JsonValue {
    const record = asRecord(input, "inspectCi");
    const pr = findPr(this.reality, numField(record, "pr"));
    return { pr: pr.number, status: pr.ciStatus, runId: `ci-${pr.number}-${pr.headSha}` };
  }

  private requestChanges(input: JsonValue): JsonValue {
    const record = asRecord(input, "requestChanges");
    const pr = findPr(this.reality, numField(record, "pr"));
    const revision = numField(record, "revision");
    const findings = optionalStrField(record, "findings") ?? "review findings";
    const planned = this.reality.reviewPlan[pr.reviews.length] ?? "approved";
    pr.reviews.push({ revision, decision: planned, findings });
    return { prNumber: pr.number, revision, decision: planned, findings };
  }

  private mergePullRequest(input: JsonValue): JsonValue {
    const record = asRecord(input, "mergePullRequest");
    const pr = findPr(this.reality, numField(record, "pr"));
    const expectedHeadSha = strField(record, "expectedHeadSha");
    this.reality.counters.mergeAttempts += 1;

    if (pr.state === "merged") {
      maybeFault(this.reality, "mergePullRequest", "after");
      return { prNumber: pr.number, merged: true, alreadyMerged: true, mergeSha: pr.mergeSha ?? null };
    }
    if (pr.headSha !== expectedHeadSha) {
      throw new Error(
        `Merge refused: expected head ${expectedHeadSha} but pull request #${pr.number} is at ${pr.headSha}`
      );
    }
    pr.state = "merged";
    pr.mergeSha = `merge-${pr.number}-${expectedHeadSha}`;
    this.reality.counters.mergesApplied += 1;
    maybeFault(this.reality, "mergePullRequest", "after");
    return { prNumber: pr.number, merged: true, mergeSha: pr.mergeSha, headSha: pr.headSha };
  }

  private finalizeIssue(input: JsonValue): JsonValue {
    const record = asRecord(input, "finalizeIssue");
    const issue = issueExists(this.reality, numField(record, "issue"));
    this.reality.counters.finalizeAttempts += 1;
    issue.state = "closed";
    this.reality.counters.finalizeApplied += 1;
    maybeFault(this.reality, "finalizeIssue", "after");
    return { issue: issue.number, state: issue.state, finalized: true };
  }
}

// ---------------------------------------------------------------------------
// worker-runtime fake provider
// ---------------------------------------------------------------------------

export const FAKE_WORKER_FEATURES = [
  "isolated-worktree",
  "spawn",
  "inspect",
  "verify",
] as const;

export class FakeWorkerRuntimeProvider {
  readonly name = "worker-runtime";
  readonly version = 1;
  readonly features: readonly string[] = [...FAKE_WORKER_FEATURES];
  readonly operations: WorkflowProviderOperation[];

  constructor(private readonly reality: FakeReality) {
    this.operations = [
      this.op("createIsolatedWorktree", true, "worker.worktree.create", (input) => this.createWorktree(input), (r) => ({
        worktreeId: (r as any).worktreeId,
        branch: (r as any).branch,
        baseSha: (r as any).baseSha,
        created: (r as any).created,
      })),
      this.op("runWorker", true, "worker.worker.run", (input) => this.runWorker(input), (r) => ({
        worktreeId: (r as any).worktreeId,
        workerId: (r as any).workerId,
        exitStatus: (r as any).exitStatus,
        commitSha: (r as any).commitSha,
        testsPassed: (r as any).testsPassed,
      })),
      this.op("inspectWorker", false, undefined, (input) => this.inspectWorker(input), (r) => ({
        worktreeId: (r as any).worktreeId,
        present: (r as any).present,
        running: (r as any).running,
        exitStatus: (r as any).exitStatus ?? null,
        commitSha: (r as any).commitSha ?? null,
        hasValidCommit: (r as any).hasValidCommit,
      })),
      this.op("verifyCommit", false, undefined, (input) => this.verifyCommit(input), (r) => ({
        verified: (r as any).verified,
        worktreeId: (r as any).worktreeId,
        commitSha: (r as any).commitSha ?? null,
        branch: (r as any).branch ?? null,
        testsPassed: (r as any).testsPassed,
        verifiedBy: (r as any).verifiedBy,
        reason: (r as any).reason,
      })),
    ];
  }

  private op(
    name: string,
    mutating: boolean,
    effectKind: string | undefined,
    execute: (input: JsonValue, context: WorkflowProviderCallContext) => JsonValue,
    projectResult: (result: JsonValue) => Record<string, JsonValue>
  ): WorkflowProviderOperation {
    return {
      name,
      mutating,
      ...(effectKind ? { effectKind } : {}),
      validateInput: (raw) => asRecord(raw as JsonValue, name) as unknown as JsonValue,
      projectResult,
      execute: (input, context) => execute(input, context),
    };
  }

  async invoke(operation: string, input: JsonValue): Promise<JsonValue> {
    const op = this.operations.find((o) => o.name === operation);
    if (!op) throw new Error(`Unknown fake worker-runtime operation "${operation}"`);
    return await op.execute(input, {
      capability: "worker-runtime",
      operation,
      runId: "external",
      workflow: "external",
      step: "external",
      iterationToken: "external",
      generation: -1,
      now: Date.now(),
    });
  }

  registration(): CapabilityProviderRegistration {
    return {
      name: this.name,
      version: this.version,
      features: this.features,
      operations: this.operations,
      api: Object.freeze({}),
    };
  }

  // ---- operations ----

  private createWorktree(input: JsonValue): JsonValue {
    const record = asRecord(input, "createIsolatedWorktree");
    const issue = numField(record, "issue");
    const branch = strField(record, "branch");
    const baseSha = strField(record, "baseSha");
    issueExists(this.reality, issue);
    const id = `wt-${this.reality.nextWorktreeId++}`;
    const worktree: FakeWorktree = {
      id,
      issue,
      branch,
      baseSha,
      present: true,
      workerRunning: false,
      testsPassed: false,
    };
    this.reality.worktrees.set(id, worktree);
    maybeFault(this.reality, "createIsolatedWorktree", "after");
    return { worktreeId: id, path: `/fake/worktrees/${id}`, branch, baseSha, created: true };
  }

  private runWorker(input: JsonValue): JsonValue {
    const record = asRecord(input, "runWorker");
    const worktreeId = strField(record, "worktreeId");
    const task = strField(record, "task");
    const revision = typeof record.revision === "number" ? record.revision : 1;
    const worktree = this.reality.worktrees.get(worktreeId);
    if (!worktree) throw new Error(`unknown worktree "${worktreeId}"`);

    this.reality.counters.workerRuns += 1;
    maybeFault(this.reality, "runWorker", "before");

    worktree.workerId = `worker-${worktreeId}-${this.reality.counters.workerRuns}`;
    worktree.workerRunning = true;
    worktree.exitStatus = 0;
    worktree.commitSha = `sha-${worktreeId}-${task}-${revision}`;
    worktree.testsPassed = true;
    worktree.workerReport = {
      summary: `worker completed task ${task} on ${worktree.branch}`,
      testsPassed: true,
      commitSha: worktree.commitSha,
    };
    this.reality.commits.set(worktree.commitSha, {
      branch: worktree.branch,
      testsPassed: true,
      worktreeId,
    });
    worktree.workerRunning = false;

    maybeFault(this.reality, "runWorker", "after");

    return {
      worktreeId,
      workerId: worktree.workerId,
      exitStatus: 0,
      commitSha: worktree.commitSha,
      testsPassed: true,
      summary: worktree.workerReport.summary,
    };
  }

  private inspectWorker(input: JsonValue): JsonValue {
    const record = asRecord(input, "inspectWorker");
    const worktreeId = strField(record, "worktreeId");
    const worktree = this.reality.worktrees.get(worktreeId);
    if (!worktree) {
      return { worktreeId, present: false, running: false, hasValidCommit: false };
    }
    const commit = worktree.commitSha ? this.reality.commits.get(worktree.commitSha) : undefined;
    return {
      worktreeId,
      present: worktree.present,
      running: worktree.workerRunning,
      exitStatus: worktree.exitStatus ?? null,
      commitSha: worktree.commitSha ?? null,
      hasValidCommit: Boolean(commit),
      workerReportedSummary: worktree.workerReport?.summary ?? null,
    };
  }

  private verifyCommit(input: JsonValue): JsonValue {
    const record = asRecord(input, "verifyCommit");
    const worktreeId = strField(record, "worktreeId");
    const expectedBranch = strField(record, "expectedBranch");
    this.reality.counters.verifications += 1;
    const worktree = this.reality.worktrees.get(worktreeId);
    if (!worktree || !worktree.present || !worktree.commitSha) {
      return { verified: false, reason: "no authoritative worktree commit", verifiedBy: "independent-verifier" };
    }
    // Authoritative check: read the commit registry, never the worker's report.
    const commit = this.reality.commits.get(worktree.commitSha);
    const branchMatches = commit?.branch === expectedBranch && worktree.branch === expectedBranch;
    const verified = Boolean(commit && branchMatches && commit.testsPassed);
    return {
      verified,
      worktreeId,
      commitSha: worktree.commitSha,
      branch: worktree.branch,
      testsPassed: commit?.testsPassed ?? false,
      verifiedBy: "independent-verifier",
      reason: verified ? "authoritative commit verified" : "authoritative commit failed verification",
    };
  }
}
