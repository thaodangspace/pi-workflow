import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WORKFLOW_RUN_ENTRY_TYPE } from "../src/constants.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { WorkflowRunRegistry } from "../src/registry.ts";
import {
  WorkflowPersistenceError,
  WorkflowRunNotFoundError,
} from "../src/types.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

describe("WorkflowRunRegistry & Session Replay", () => {
  const sampleDoc = `---
name: registry-test
description: Full registry lifecycle and persistence test.
mode: self-paced
concurrency:
  maxRuns: 2
---
# Policy
Steps to execute.
`;

  function createDef() {
    return parseWorkflowContent(sampleDoc, {
      path: "/test/registry.md",
      scope: "project",
    });
  }

  it("performs full lifecycle mutations and persists entries to session", () => {
    const session = new FakeSessionManager();
    const registry = new WorkflowRunRegistry(session);
    const def = createDef();

    // 1. Create run
    const run = registry.createRun(def, {
      initialStep: "STEP_1",
      initialData: { step: 1 },
      loopTaskId: "loop-1",
    });

    assert.equal(run.lifecycle, "active");
    assert.equal(run.step, "STEP_1");
    assert.deepEqual(run.data, { step: 1 });
    assert.equal(run.loopTaskId, "loop-1");

    // Check entry was appended to session
    const entries1 = session.getAllEntries();
    assert.equal(entries1.length, 1);
    assert.equal(entries1[0].customType, WORKFLOW_RUN_ENTRY_TYPE);
    assert.equal((entries1[0].data as any).action, "create");

    // 2. Update run
    registry.updateRun(run.id, {
      incrementAttempts: 1,
      incrementTurns: 5,
      data: { progress: "25%" },
    });
    assert.equal(registry.getRun(run.id)?.attempts, 1);
    assert.equal(registry.getRun(run.id)?.turns, 5);
    assert.deepEqual(registry.getRun(run.id)?.data, { step: 1, progress: "25%" });

    // 3. Transition step
    registry.transitionStep(run.id, {
      toStep: "STEP_2",
      data: { progress: "50%" },
    });
    assert.equal(registry.getRun(run.id)?.step, "STEP_2");

    // 4. Block run
    registry.blockRun(run.id, {
      reason: "Waiting on CI",
      requiresHuman: false,
    });
    assert.equal(registry.getRun(run.id)?.lifecycle, "blocked");
    assert.equal(registry.getRun(run.id)?.blocker?.reason, "Waiting on CI");

    // 5. Resume run
    registry.resumeRun(run.id, { step: "STEP_3" });
    assert.equal(registry.getRun(run.id)?.lifecycle, "active");
    assert.equal(registry.getRun(run.id)?.step, "STEP_3");
    assert.equal(registry.getRun(run.id)?.blocker, undefined);

    // 6. Pause run
    registry.pauseRun(run.id, { reason: "User break" });
    assert.equal(registry.getRun(run.id)?.lifecycle, "paused");

    // 7. Resume and complete run
    registry.resumeRun(run.id);
    registry.completeRun(run.id, {
      summary: "Completed successfully",
      evidence: [{ type: "log", description: "Verification log clean" }],
    });
    assert.equal(registry.getRun(run.id)?.lifecycle, "completed");
    assert.equal(registry.getRun(run.id)?.completion?.summary, "Completed successfully");
  });

  it("queries runs with getRun, requireRun, hasRun, listRuns, getActiveRuns, getNonterminalRuns", () => {
    const registry = new WorkflowRunRegistry();
    const def = createDef();

    const run1 = registry.createRun(def, { runId: "run-one" });
    const run2 = registry.createRun(def, { runId: "run-two" });

    assert.equal(registry.hasRun("run-one"), true);
    assert.equal(registry.hasRun("run-three"), false);

    assert.equal(registry.getRun("run-one")?.id, "run-one");
    assert.equal(registry.requireRun("run-one").id, "run-one");
    assert.throws(() => registry.requireRun("run-unknown"), WorkflowRunNotFoundError);

    registry.pauseRun(run2.id);

    // listRuns
    assert.equal(registry.listRuns().length, 2);
    assert.equal(registry.listRuns({ lifecycle: "active" }).length, 1);
    assert.equal(registry.listRuns({ lifecycle: ["active", "paused"] }).length, 2);
    assert.equal(registry.listRuns({ workflow: "registry-test" }).length, 2);
    assert.equal(registry.getActiveRuns().length, 1);
    assert.equal(registry.getNonterminalRuns().length, 2);

    registry.completeRun(run1.id, { summary: "Done" });
    assert.equal(registry.getNonterminalRuns().length, 1);
    assert.equal(registry.getActiveRuns().length, 0);
  });

  it("reconstructs exact run state from session entries and is idempotent", () => {
    const session = new FakeSessionManager();
    const registry1 = new WorkflowRunRegistry(session);
    const def = createDef();

    const run = registry1.createRun(def, {
      runId: "stable-run-1",
      initialStep: "BUILD",
      initialData: { env: "prod" },
    });
    registry1.updateRun(run.id, { incrementTurns: 3 });
    registry1.transitionStep(run.id, { toStep: "TEST" });

    // Reconstruct into a fresh registry
    const registry2 = new WorkflowRunRegistry();
    const result1 = registry2.reconstructFromSession(session);

    assert.equal(result1.runs.length, 1);
    const rec1 = result1.runs[0];
    assert.equal(rec1.id, "stable-run-1");
    assert.equal(rec1.step, "TEST");
    assert.equal(rec1.turns, 3);
    assert.deepEqual(rec1.data, { env: "prod" });

    // Idempotent replay: calling reconstruct again produces identical runs
    const result2 = registry2.reconstructFromSession(session);
    assert.equal(result2.runs.length, 1);
    assert.deepEqual(result2.runs[0], rec1);
  });

  it("handles duplicate create entries in session log idempotently without duplicating or resetting run", () => {
    const session = new FakeSessionManager();
    const registry = new WorkflowRunRegistry(session);
    const def = createDef();

    const run = registry.createRun(def, { runId: "dup-run", initialStep: "INITIAL" });
    registry.transitionStep(run.id, { toStep: "ADVANCED" });

    // Artificially append a duplicate create entry to the session for the same run ID
    const firstEntry = session.getAllEntries()[0];
    session.appendCustomEntry(WORKFLOW_RUN_ENTRY_TYPE, firstEntry.data);

    // Replay with duplicate entry
    const registry2 = new WorkflowRunRegistry();
    const { runs, diagnostics } = registry2.reconstructFromSession(session);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, "dup-run");
    assert.equal(runs[0].step, "ADVANCED"); // Did not get reset to INITIAL!

    // Warning diagnostic recorded
    const dupWarning = diagnostics.find((d) => d.code === "DUPLICATE_CREATE_IGNORED");
    assert(dupWarning !== undefined);
    assert.equal(dupWarning.type, "warning");
    assert.equal(dupWarning.runId, "dup-run");
  });

  it("diagnoses malformed or corrupted session entries safely without crashing", () => {
    const session = new FakeSessionManager();
    const def = createDef();

    // Valid run create
    const reg = new WorkflowRunRegistry(session);
    const run = reg.createRun(def, { runId: "good-run" });

    // Corrupted entry: missing version
    session.appendCustomEntry(WORKFLOW_RUN_ENTRY_TYPE, { runId: "bad-1", action: "create" });
    // Corrupted entry: unsupported version (999)
    session.appendCustomEntry(WORKFLOW_RUN_ENTRY_TYPE, { version: 999, runId: "bad-2", action: "create" });
    // Corrupted entry: unknown action
    session.appendCustomEntry(WORKFLOW_RUN_ENTRY_TYPE, { version: 1, runId: "bad-3", action: "explode" });
    // Corrupted entry: invalid payload (missing summary for complete)
    session.appendCustomEntry(WORKFLOW_RUN_ENTRY_TYPE, { version: 1, runId: run.id, action: "complete", payload: {} });

    // Normal replay should not throw; should record diagnostics
    const registry2 = new WorkflowRunRegistry();
    const { runs, diagnostics } = registry2.reconstructFromSession(session);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, "good-run");
    assert(diagnostics.some((d) => d.code === "MISSING_VERSION"));
    assert(diagnostics.some((d) => d.code === "UNSUPPORTED_VERSION"));
    assert(diagnostics.some((d) => d.code === "MALFORMED_ACTION"));
    assert(diagnostics.some((d) => d.code === "INVALID_PAYLOAD"));
  });

  it("throws WorkflowPersistenceError when strict replay is requested and malformed entries exist", () => {
    const session = new FakeSessionManager();
    session.appendCustomEntry(WORKFLOW_RUN_ENTRY_TYPE, { not: "valid" });

    const registry = new WorkflowRunRegistry();
    assert.throws(
      () => registry.reconstructFromSession(session, { strict: true }),
      (err) => err instanceof WorkflowPersistenceError
    );
  });

  it("fails closed with WorkflowPersistenceError and prevents in-memory mutations when sessionTarget lacks append methods", () => {
    // Bound session target without appendCustomEntry or appendEntry
    const brokenTarget: any = {
      getBranch: () => [],
    };

    const registry = new WorkflowRunRegistry(brokenTarget);
    const def = createDef();

    // 1. createRun fails and does not add run to memory
    assert.throws(
      () => registry.createRun(def, { runId: "persist-fail-run" }),
      (err) => err instanceof WorkflowPersistenceError && err.message.includes("does not implement appendCustomEntry")
    );
    assert.equal(registry.hasRun("persist-fail-run"), false);
    assert.equal(registry.listRuns().length, 0);

    // 2. Bound target whose append method throws prevents in-memory mutation on update
    const normalSession = new FakeSessionManager();
    const reg2 = new WorkflowRunRegistry(normalSession);
    const run = reg2.createRun(def, { runId: "live-run", initialStep: "ORIGINAL" });

    // Now bind a target that throws on append
    const throwingTarget: any = {
      getBranch: () => normalSession.getBranch(),
      appendCustomEntry: () => {
        throw new Error("Disk write error");
      },
    };
    reg2.bindSession(throwingTarget);

    assert.throws(
      () => reg2.transitionStep(run.id, { toStep: "MUTATED" }),
      (err) => err instanceof WorkflowPersistenceError && err.message.includes("Disk write error")
    );

    // In-memory step must still be ORIGINAL, not MUTATED!
    assert.equal(reg2.requireRun(run.id).step, "ORIGINAL");
  });

  it("checks custom runId collision before concurrency and never returns other-workflow run", () => {
    const registry = new WorkflowRunRegistry();
    const defA = parseWorkflowContent(
      `---
name: workflow-alpha
description: Workflow Alpha.
mode: self-paced
concurrency:
  maxRuns: 1
---
# Alpha
`,
      { path: "/test/alpha.md", scope: "project" }
    );

    const defB = parseWorkflowContent(
      `---
name: workflow-beta
description: Workflow Beta.
mode: self-paced
concurrency:
  maxRuns: 1
---
# Beta
`,
      { path: "/test/beta.md", scope: "project" }
    );

    // Create run in Alpha
    const runAlpha = registry.createRun(defA, { runId: "shared-id" });
    assert.equal(runAlpha.workflow, "workflow-alpha");

    // Attempt to create run in Beta with the SAME runId, requesting returnExisting
    // Must throw WorkflowRunError and NEVER return runAlpha!
    assert.throws(
      () => registry.createRun(defB, { runId: "shared-id", existingPolicy: "returnExisting" }),
      (err) => {
        assert(err instanceof Error);
        assert.equal(err.name, "WorkflowRunError");
        assert(err.message.includes('already exists for workflow "workflow-alpha"'));
        return true;
      }
    );

    // Ensure Beta still has no runs
    assert.equal(registry.listRuns({ workflow: "workflow-beta" }).length, 0);

    // Also verify when Beta's concurrency is already full, collision is still checked before concurrency
    // Create a normal run in Beta
    const runBeta = registry.createRun(defB, { runId: "beta-active" });
    assert.equal(runBeta.workflow, "workflow-beta");

    // Now Beta has 1/1 runs active. Attempting to create Beta run with runId="shared-id" (Alpha's ID)
    // with returnExisting must throw the ID collision error, NOT return Beta's existing run!
    assert.throws(
      () => registry.createRun(defB, { runId: "shared-id", existingPolicy: "returnExisting" }),
      (err) => {
        assert(err instanceof Error);
        assert.equal(err.name, "WorkflowRunError");
        assert(err.message.includes('already exists for workflow "workflow-alpha"'));
        return true;
      }
    );
  });

  it("reconstructs accurately after simulated session file reload (JSONL)", () => {
    const session1 = new FakeSessionManager();
    const registry1 = new WorkflowRunRegistry(session1);
    const def = createDef();

    const run1 = registry1.createRun(def, { runId: "reload-run-1" });
    registry1.transitionStep(run1.id, { toStep: "PHASE_2" });
    registry1.blockRun(run1.id, { reason: "Need token" });

    // Export to JSON Lines string
    const jsonl = session1.exportJsonl();

    // Simulate reloading session from file
    const session2 = FakeSessionManager.fromJsonl(jsonl);
    const registry2 = new WorkflowRunRegistry();
    registry2.reconstructFromSession(session2);

    const reloaded = registry2.requireRun("reload-run-1");
    assert.equal(reloaded.id, "reload-run-1");
    assert.equal(reloaded.lifecycle, "blocked");
    assert.equal(reloaded.step, "PHASE_2");
    assert.equal(reloaded.blocker?.reason, "Need token");
  });
});
