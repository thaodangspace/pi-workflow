/**
 * Issue #10 — observability projections, safe diagnostics, history formatting,
 * sanitization policy, and the registry/adapter change hooks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWorkflowCapabilityRegistry } from "../src/capabilities.ts";
import { MAX_RUN_HISTORY_ENTRIES } from "../src/constants.ts";
import { WorkflowDispatcher } from "../src/dispatcher.ts";
import {
  buildHistoryData,
  buildRunDiagnostic,
  buildStatusProjection,
  formatRunDiagnostic,
  formatRunHistory,
  formatStatusLine,
  formatStatusList,
  projectSchedulerLinkage,
  sanitizeDiagnosticText,
  sanitizeHistoryDetails,
} from "../src/observability.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { WorkflowRunRegistry } from "../src/registry.ts";
import { LoopSchedulerAdapter } from "../src/scheduler-adapter.ts";
import { FakeLoopService } from "./fake-loop-service.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

const SELF_PACED_YAML = `---
name: obs-self-paced
description: Observability self-paced workflow.
mode: self-paced
concurrency:
  maxRuns: 5
requires:
  - loop
budget:
  maxTurns: 10
  maxAttempts: 3
completion:
  verify: true
---
# Observability
`;

function parseDef(name = "obs-self-paced", yaml = SELF_PACED_YAML) {
  return parseWorkflowContent(yaml, { path: `/${name}.md`, scope: "project" });
}

interface Harness {
  session: FakeSessionManager;
  registry: WorkflowRunRegistry;
  adapter: LoopSchedulerAdapter;
  service: FakeLoopService;
}

function harness(options: { withService?: boolean } = {}): Harness {
  const session = new FakeSessionManager();
  const registry = new WorkflowRunRegistry(session);
  const dispatcher = new WorkflowDispatcher(registry);
  const service = new FakeLoopService();
  const adapter = new LoopSchedulerAdapter({
    registry,
    dispatcher,
    ...(options.withService === false ? {} : { service }),
  });
  return { session, registry, adapter, service };
}

describe("diagnostic text sanitization policy (issue #10)", () => {
  it("bounds length with a visible omission marker", () => {
    const long = "x".repeat(600);
    const out = sanitizeDiagnosticText(long, 100);
    assert.equal(out.omitted, false);
    assert.equal(out.truncated, true);
    assert.equal(out.text.length <= 100 + "…[+500 chars]".length, true);
    assert.match(out.text, /…\[\+\d+ chars\]$/);
  });

  it("omits undefined/empty/whitespace-only values", () => {
    for (const value of [undefined, null, "", "   \n\t "]) {
      const out = sanitizeDiagnosticText(value);
      assert.equal(out.omitted, true);
      assert.equal(out.text, "");
    }
  });

  it("strips control characters and collapses line breaks for inline display", () => {
    const out = sanitizeDiagnosticText("line1\n\tline2\u0007\u001b[31m");
    assert.ok(!out.text.includes("\n"));
    assert.ok(!/[\u0000-\u001F\u007F]/.test(out.text));
    assert.match(out.text, /line1 line2/);
  });

  it("redacts obvious credential shapes and flags the redaction", () => {
    const out = sanitizeDiagnosticText(
      "failed with token=supersecretvalue and sk-ABCDEFGHIJKLMNOPQRSTUV and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
    );
    assert.equal(out.redacted, true);
    assert.ok(!out.text.includes("supersecretvalue"));
    assert.ok(!out.text.includes("sk-ABCDEFGHIJKLMNOPQRSTUV"));
    assert.ok(!out.text.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"));
    assert.match(out.text, /\[redacted/);
  });

  it("redacts URL userinfo credentials", () => {
    const out = sanitizeDiagnosticText("clone https://user:p4ssw0rd@example.com/repo.git");
    assert.equal(out.redacted, true);
    assert.ok(!out.text.includes("p4ssw0rd"));
  });

  it("redacts natural-language copula forms (password is …, token is …, api key was …)", () => {
    const cases: Array<[string, string]> = [
      ["password is hunter2", "hunter2"],
      ["token is abcdef123456", "abcdef123456"],
      ["secret: shhhh-value", "shhhh-value"],
      ["api key was zzzyyy123456", "zzzyyy123456"],
      ["passwd = p@ss", "p@ss"],
    ];
    for (const [input, secret] of cases) {
      const out = sanitizeDiagnosticText(input);
      assert.equal(out.redacted, true, `expected redaction for ${input}`);
      assert.ok(!out.text.includes(secret), `value "${secret}" leaked for "${input}"`);
      assert.match(out.text, /\[redacted\]/);
    }
  });

  it("recursively sanitizes and bounds history detail values", () => {
    const out = sanitizeHistoryDetails({
      reason: "token is abcdef123456",
      nested: { note: "password is hunter2", codes: [1, 2, true, null, "secret is zzzyyy"] },
      count: 3,
    })!;
    const json = JSON.stringify(out);
    assert.ok(!json.includes("abcdef123456"));
    assert.ok(!json.includes("hunter2"));
    assert.ok(!json.includes("zzzyyy"));
    assert.equal((out.nested as any).codes[0], 1);
    assert.equal((out.nested as any).codes[2], true);
    assert.equal((out.nested as any).codes[3], null);
    assert.equal(out.count, 3);
  });
});

describe("aggregate status projection (issue #10)", () => {
  it("counts multiple nonterminal runs deterministically and ignores unrelated /loop tasks", async () => {
    const { registry, adapter, service } = harness();
    const a = registry.createRun(parseDef(), { runId: "wfrun-a" });
    const b = registry.createRun(parseDef(), { runId: "wfrun-b" });
    registry.blockRun(b.id, { reason: "Waiting on review", requiresHuman: true });

    // An unrelated user /loop task exists in the scheduler but is not a workflow run.
    service.scheduleFixed(60_000, "user loop task");

    const projection = buildStatusProjection(registry, adapter, { now: Date.now() });
    assert.equal(projection.total, 2);
    assert.equal(projection.active, 1);
    assert.equal(projection.blocked, 1);
    assert.deepEqual(
      projection.runs.map((r) => r.id),
      ["wfrun-a", "wfrun-b"]
    );
    assert.equal(projection.runs[1].blocker?.reason, "Waiting on review");

    const line = formatStatusLine(projection);
    assert.ok(line);
    assert.match(line!, /^◇ 2 workflows · 1 active · 1 blocked/);

    const list = formatStatusList(projection);
    assert.match(list, /Active Workflow Runs \(2\):/);
    assert.match(list, /Blocker:\s+Waiting on review \(human action required\)/);
  });

  it("returns undefined when no nonterminal runs remain and clears the line", () => {
    const { registry, adapter } = harness();
    const run = registry.createRun(parseDef(), { runId: "wfrun-done" });
    assert.ok(formatStatusLine(buildStatusProjection(registry, adapter)));

    registry.cancelRun(run.id, { reason: "finished" });
    const after = buildStatusProjection(registry, adapter);
    assert.equal(after.total, 0);
    assert.equal(formatStatusLine(after), undefined);
  });

  it("selects the earliest linked future wakeup", async () => {
    const { registry, adapter } = harness();
    const later = registry.createRun(parseDef(), { runId: "wfrun-z" });
    const earlier = registry.createRun(parseDef(), { runId: "wfrun-a" });
    await adapter.scheduleRun(later.id);
    await adapter.scheduleRun(earlier.id);

    const projection = buildStatusProjection(registry, adapter);
    const expected = Math.min(
      adapter.getService()!.listTasks().find((t) => t.id === adapter.getLinkedTaskId(later.id))!.nextFireAt!,
      adapter.getService()!.listTasks().find((t) => t.id === adapter.getLinkedTaskId(earlier.id))!.nextFireAt!
    );
    assert.equal(projection.earliestNextWakeupAt, expected);
    assert.ok(projection.earliestNextWakeupAt! >= projection.now);
  });

});

describe("scheduler linkage projection (issue #10)", () => {
  it("distinguishes absent, linked, stale, unavailable and not-applicable", async () => {
    const { registry, adapter, service } = harness();
    const run = registry.createRun(parseDef(), { runId: "wfrun-link" });

    assert.equal(projectSchedulerLinkage(run, adapter).state, "absent");

    await adapter.scheduleRun(run.id);
    const linked = projectSchedulerLinkage(registry.requireRun(run.id), adapter);
    assert.equal(linked.state, "linked");
    assert.equal(typeof linked.nextFireAt, "number");

    const taskId = adapter.getLinkedTaskId(run.id)!;
    service.deleteTask(taskId);
    assert.equal(projectSchedulerLinkage(registry.requireRun(run.id), adapter).state, "stale");

    // Re-link then drop the service handle: linkage cannot be verified.
    await adapter.scheduleRun(run.id);
    adapter.detachService();
    const unavailable = projectSchedulerLinkage(registry.requireRun(run.id), adapter);
    assert.equal(unavailable.state, "unavailable");

    // Paused/blocked/terminal runs have no active wakeup.
    const paused = registry.pauseRun(run.id, { reason: "pause" });
    assert.equal(projectSchedulerLinkage(paused, adapter).state, "not-applicable");
  });

  it("classifies a durable link to a user /loop task or another run's task as ambiguous", async () => {
    const { registry, adapter, service } = harness();
    const runA = registry.createRun(parseDef(), { runId: "wfrun-cross-a" });
    const runB = registry.createRun(parseDef(), { runId: "wfrun-cross-b" });
    await adapter.scheduleRun(runA.id);
    const taskA = adapter.getLinkedTaskId(runA.id)!;

    // Corrupt cross-link: run B durably points at run A's task.
    registry.updateRun(runB.id, { loopTaskId: taskA });
    assert.equal(projectSchedulerLinkage(registry.requireRun(runB.id), adapter).state, "ambiguous");

    // Durable link to a user /loop task (no workflow prompt identity).
    const userTask = service.scheduleFixed(60_000, "ordinary user /loop task");
    registry.updateRun(runB.id, { loopTaskId: userTask.id });
    assert.equal(projectSchedulerLinkage(registry.requireRun(runB.id), adapter).state, "ambiguous");

    // The genuine owner still resolves as linked.
    assert.equal(projectSchedulerLinkage(registry.requireRun(runA.id), adapter).state, "linked");
  });

  it("never exposes a raw scheduler task id in the projection detail", async () => {
    const { registry, adapter } = harness();
    const run = registry.createRun(parseDef(), { runId: "wfrun-nosecret" });
    await adapter.scheduleRun(run.id);
    const linkage = projectSchedulerLinkage(registry.requireRun(run.id), adapter);
    const taskId = adapter.getLinkedTaskId(run.id)!;
    assert.ok(!linkage.detail.includes(taskId));
    assert.ok(!JSON.stringify(linkage).includes(taskId));
  });
});

describe("safe detailed run diagnostics (issue #10)", () => {
  it("exposes safe derived fields and never the raw run/data/service handles", () => {
    const { registry, adapter } = harness();
    const capabilities = createWorkflowCapabilityRegistry({ sessionId: "s1" });
    capabilities.register({ name: "loop", version: 1 });

    const run = registry.createRun(parseDef(), { runId: "wfrun-diag" });
    registry.updateRun(run.id, { data: { secretValue: "TOP-SECRET-VALUE", ticket: "PROJ-1" }, incrementTurns: 2 });
    registry.blockRun(run.id, {
      reason: "needs password=hunter2 from operator",
      category: "human-required",
      requiresHuman: true,
    });

    const view = registry.requireRun(run.id);
    const diag = buildRunDiagnostic(view, adapter, { capabilityRegistry: capabilities });

    assert.equal(diag.id, "wfrun-diag");
    assert.equal(diag.type, "workflow");
    assert.deepEqual(diag.dataKeys, ["secretValue", "ticket"]);
    assert.equal(diag.turns, 2);
    assert.equal(diag.definition.schemaVersion, "v1");
    assert.equal(diag.capabilities?.required.includes("loop"), true);

    // Raw run shape / secrets must not leak through the diagnostic view.
    const json = JSON.stringify(diag);
    assert.ok(!json.includes("TOP-SECRET-VALUE"), "raw data value leaked");
    assert.ok(!json.includes("hunter2"), "blocker secret leaked");
    assert.ok(!("data" in (diag as any)), "raw run data object exposed");
    assert.ok(!("snapshot" in (diag as any)), "raw snapshot exposed");
    assert.ok(!/ownerId/.test(json), "lease owner handle exposed");

    const output = formatRunDiagnostic(diag);
    assert.match(output, /Workflow Run: wfrun-diag/);
    assert.match(output, /Blocker:/);
    assert.match(output, /\[redacted\]/);
    assert.ok(!output.includes("hunter2"));
    assert.ok(!output.includes("TOP-SECRET-VALUE"));
    assert.match(output, /Data Keys:\s+\[secretValue, ticket\] \(values omitted to prevent secret exposure\)/);
    assert.match(output, /Scheduler:/);
  });

  it("omits completion evidence locations and sanitizes descriptions", () => {
    const { registry, adapter } = harness();
    const run = registry.createRun(parseDef(), { runId: "wfrun-evidence" });
    registry.completeRun(run.id, {
      summary: "done token=abc123456789",
      evidence: [
        {
          type: "pr",
          description: "opened PR with token=abc123456789",
          url: "https://user:secretpw@example.com/org/repo/pull/1",
          path: "/home/me/secret/file",
        },
      ],
    });

    const diag = buildRunDiagnostic(registry.requireRun(run.id), adapter);
    const json = JSON.stringify(diag);
    assert.ok(!json.includes("secretpw"));
    assert.ok(!json.includes("/home/me/secret/file"));
    assert.ok(!json.includes("abc123456789"));
    const output = formatRunDiagnostic(diag);
    assert.match(output, /\(description omitted\)|\[redacted\]/);
  });

  it("renders goal type and objective without mutating the raw run", () => {
    const { registry, adapter } = harness();
    const yaml = SELF_PACED_YAML.replace("name: obs-self-paced", "name: obs-goal").replace(
      "# Observability",
      "# Observability"
    );
    const goalDef = { ...parseDef("obs-goal", yaml), type: "goal" as const, objective: "ship the thing" };
    const run = registry.createRun(goalDef, { runId: "wfrun-goal" });
    const diag = buildRunDiagnostic(registry.requireRun(run.id), adapter);
    assert.equal(diag.type, "goal");
    assert.equal(diag.objective, "ship the thing");
  });
});

describe("history formatting and bounds (issue #10)", () => {
  it("renders a deterministic oldest-first bounded suffix with truncation notice", () => {
    const { registry } = harness();
    const run = registry.createRun(parseDef(), { runId: "wfrun-history" });
    const transitions = MAX_RUN_HISTORY_ENTRIES + 25;
    for (let i = 0; i < transitions; i++) {
      registry.transitionStep(run.id, { toStep: `STEP_${i}` });
    }

    const view = registry.getRunHistory(run.id, { limit: 5, order: "oldest" });
    const output = formatRunHistory(view);
    assert.match(output, /Run History: wfrun-history/);
    assert.match(output, /5 shown/);
    assert.match(output, /lifetime/);
    assert.match(output, /dropped from the bounded/);

    const data = buildHistoryData(view);
    assert.equal(data.entries.length, 5);
    assert.equal(data.runId, "wfrun-history");
    assert.ok(data.entries.every((e) => e.action === "transition"));
  });

  it("does not copy wholesale secret-bearing payloads into history output", () => {
    const { registry } = harness();
    const run = registry.createRun(parseDef(), { runId: "wfrun-hist-secret" });
    registry.transitionStep(run.id, { toStep: "NEXT", reason: "carrying token=abcdef123456789" });
    const output = formatRunHistory(registry.getRunHistory(run.id));
    assert.ok(!output.includes("abcdef123456789"));
    assert.match(output, /\[redacted\]/);
  });
});

describe("registry mutation observer (issue #10)", () => {
  it("notifies after commit, is idempotent on unsubscribe, and swallows listener errors", () => {
    const { registry } = harness();
    let calls = 0;
    const unsubscribe = registry.subscribeMutations(() => {
      calls += 1;
      throw new Error("observer boom");
    });

    // A throwing observer must never break the durable mutation.
    const run = registry.createRun(parseDef(), { runId: "wfrun-observer" });
    assert.equal(calls, 1);

    registry.transitionStep(run.id, { toStep: "STEP_A" });
    assert.equal(calls, 2);

    unsubscribe();
    unsubscribe(); // idempotent
    registry.transitionStep(run.id, { toStep: "STEP_B" });
    assert.equal(calls, 2);
  });
});

describe("scheduler adapter change hook (issue #10)", () => {
  it("notifies on service attach, task scheduling and wakeup changes", async () => {
    const { registry, adapter, service } = harness({ withService: false });
    let calls = 0;
    const unsubscribe = adapter.subscribeChanges(() => {
      calls += 1;
    });

    adapter.attachService(service);
    assert.ok(calls >= 1);

    const run = registry.createRun(parseDef(), { runId: "wfrun-hook" });
    const before = calls;
    await adapter.scheduleRun(run.id);
    assert.ok(calls > before);

    const afterSchedule = calls;
    await adapter.scheduleWakeup({ runId: run.id, delayMs: 120_000, reason: "test wakeup" });
    assert.ok(calls > afterSchedule);

    const afterWakeup = calls;
    unsubscribe();
    adapter.detachService();
    assert.equal(calls, afterWakeup);
  });
});
