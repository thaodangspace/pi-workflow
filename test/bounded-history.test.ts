/**
 * Issue #24 — bounded recent run history.
 *
 * Stress and replay coverage proving that:
 *  - `WorkflowRun.history` / `WorkflowRun.recoveryEvents` are fixed-capacity
 *    projections whose retained size is independent of lifetime event count;
 *  - per-append work is bounded by capacity, never by total lifetime events;
 *  - truncation is observable via total/dropped metadata;
 *  - deterministic replay rebuilds the same projection and keeps synthesized
 *    recovery events duplicate-free;
 *  - the `getRunHistory` accessor is deterministic, bounded and does not read
 *    the session log.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflowContent } from "../src/parser.ts";
import { WorkflowRunRegistry } from "../src/registry.ts";
import {
  MAX_RUN_HISTORY_ENTRIES,
  MAX_RUN_HISTORY_QUERY_LIMIT,
  MAX_RUN_RECOVERY_EVENTS,
} from "../src/constants.ts";
import { appendHistoryEntry } from "../src/run.ts";
import type { WorkflowRunHistoryEntry } from "../src/types.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

const WORKFLOW_YAML = `---
name: bounded-history-workflow
description: Bounded history stress and replay workflow.
mode: self-paced
concurrency:
  maxRuns: 5
---
# Bounded History Policy
`;

const VERIFY_WORKFLOW_YAML = `---
name: verify-history-workflow
description: Verification history workflow.
mode: self-paced
concurrency:
  maxRuns: 5
completion:
  verify: true
  maxVerificationAttempts: 2
  onRejectionExhausted: block
---
# Verify History Policy
`;

function parseDef() {
  return parseWorkflowContent(WORKFLOW_YAML, { path: "/bounded.md", scope: "project" });
}

describe("Bounded run history (issue #24)", () => {
  describe("projection bounds and truncation metadata", () => {
    it("retains at most capacity across thousands of events (>10x capacity)", () => {
      const registry = new WorkflowRunRegistry();
      const run = registry.createRun(parseDef(), { runId: "wfrun-stress" });

      const lifetimeTransitions = MAX_RUN_HISTORY_ENTRIES * 12; // > 10x capacity
      for (let i = 0; i < lifetimeTransitions; i++) {
        registry.transitionStep(run.id, { toStep: `STEP_${i}` });
        // Invariant: retained window never grows with lifetime events.
        assert.ok(
          registry.requireRun(run.id).history!.length <= MAX_RUN_HISTORY_ENTRIES,
          `history exceeded capacity at event ${i}`
        );
      }

      const finalRun = registry.requireRun(run.id);
      assert.equal(finalRun.history!.length, MAX_RUN_HISTORY_ENTRIES);
      assert.equal(finalRun.historyTotal, lifetimeTransitions + 1); // create + transitions
      assert.equal(
        finalRun.historyDropped,
        finalRun.historyTotal! - MAX_RUN_HISTORY_ENTRIES
      );

      // Newest events remain; the create entry is long gone.
      const last = finalRun.history![finalRun.history!.length - 1];
      assert.equal(last.action, "transition");
      assert.match(last.summary, new RegExp(`STEP_${lifetimeTransitions - 1}\\b`));
      assert.equal(finalRun.history![0].action, "transition");
      assert.equal(finalRun.history!.some((h) => h.eventId === "create-1"), false);

      // Auto-generated IDs stay unique after truncation.
      const ids = new Set(finalRun.history!.map((h) => h.eventId));
      assert.equal(ids.size, finalRun.history!.length);
    });

    it("keeps a fixed retained window for a million lifetime events (O(MAX) append)", () => {
      // Structural proof of the complexity contract: `appendBounded` copies at
      // most `capacity` entries (see src/bounded-history.ts) and never iterates
      // the lifetime total. A source reporting a million lifetime events with a
      // full window must still return exactly capacity entries, with the oldest
      // dropped entry never materialized.
      const base = 1_000_000 - MAX_RUN_HISTORY_ENTRIES + 1;
      const entries: WorkflowRunHistoryEntry[] = Array.from(
        { length: MAX_RUN_HISTORY_ENTRIES },
        (_, i) => ({
          eventId: `transition-${base + i}`,
          action: "transition",
          timestamp: i,
          summary: `step ${i}`,
        })
      );
      const source = {
        history: entries,
        historyTotal: 1_000_000,
        historyDropped: 1_000_000 - MAX_RUN_HISTORY_ENTRIES,
      };

      const update = appendHistoryEntry(source, "transition", "after-million-lifetime");

      assert.equal(update.history.length, MAX_RUN_HISTORY_ENTRIES);
      assert.equal(update.historyTotal, 1_000_001);
      assert.equal(update.historyDropped, 1_000_001 - MAX_RUN_HISTORY_ENTRIES);
      // Oldest retained entry is `base + 1` (only the true oldest was dropped).
      assert.equal(update.history[0].eventId, `transition-${base + 1}`);
      assert.equal(update.history[update.history.length - 1].summary, "after-million-lifetime");
    });

    it("counts transition, effect and recovery events consistently", () => {
      const registry = new WorkflowRunRegistry();
      const run = registry.createRun(parseDef(), { runId: "wfrun-consistency" });

      registry.transitionStep(run.id, { toStep: "STEP_A" });
      registry.beginEffect(run.id, { key: "pr-1", kind: "github.pr" });
      registry.commitEffect(run.id, { key: "pr-1", resultSummary: { pr: 1 } });
      registry.recordRecoveryEvent(run.id, {
        type: "scheduler_reconnected",
        message: "reconnected",
      });

      const finalRun = registry.requireRun(run.id);
      const actions = finalRun.history!.map((h) => h.action);
      for (const action of ["create", "transition", "effect_begin", "effect_commit", "recovery"]) {
        assert.ok(actions.includes(action), `history missing action "${action}"`);
      }
      assert.equal(finalRun.historyTotal, actions.length + finalRun.historyDropped!);
      assert.equal(
        finalRun.recoveryEvents!.some((e) => e.type === "scheduler_reconnected"),
        true
      );
      assert.equal(
        finalRun.recoveryEventsTotal,
        finalRun.recoveryEvents!.length + finalRun.recoveryEventsDropped!
      );
    });

    it("bounds recoveryEvents with the same fixed-capacity projection principles", () => {
      const registry = new WorkflowRunRegistry();
      const run = registry.createRun(parseDef(), { runId: "wfrun-recovery-bound" });

      const lifetimeRecoveries = MAX_RUN_RECOVERY_EVENTS * 8;
      for (let i = 0; i < lifetimeRecoveries; i++) {
        registry.recordRecoveryEvent(run.id, {
          type: "scheduler_reconnected",
          message: `recover ${i}`,
        });
      }

      const finalRun = registry.requireRun(run.id);
      assert.equal(finalRun.recoveryEvents!.length, MAX_RUN_RECOVERY_EVENTS);
      assert.equal(finalRun.recoveryEventsTotal, lifetimeRecoveries);
      assert.equal(
        finalRun.recoveryEventsDropped,
        lifetimeRecoveries - MAX_RUN_RECOVERY_EVENTS
      );
      assert.equal(
        finalRun.recoveryEvents![0].message,
        `recover ${lifetimeRecoveries - MAX_RUN_RECOVERY_EVENTS}`
      );
      assert.equal(
        finalRun.recoveryEvents![finalRun.recoveryEvents!.length - 1].message,
        `recover ${lifetimeRecoveries - 1}`
      );

      // History shares the lifetime event stream and is bounded too.
      assert.equal(finalRun.history!.length, MAX_RUN_HISTORY_ENTRIES);
      assert.equal(finalRun.historyTotal, lifetimeRecoveries + 1);
    });
  });

  describe("deterministic replay", () => {
    it("reconstructs an identical bounded projection on repeated replay", () => {
      const session = new FakeSessionManager();
      const live = new WorkflowRunRegistry(session);
      const run = live.createRun(parseDef(), { runId: "wfrun-replay" });

      const lifetimeTransitions = MAX_RUN_HISTORY_ENTRIES * 5;
      for (let i = 0; i < lifetimeTransitions; i++) {
        live.transitionStep(run.id, { toStep: `STEP_${i}` });
      }

      const replayed1 = new WorkflowRunRegistry();
      const first = replayed1.reconstructFromSession(session).runs[0];
      const replayed2 = new WorkflowRunRegistry();
      const second = replayed2.reconstructFromSession(session).runs[0];

      // Replay reproduces the live projection byte-for-byte.
      assert.deepEqual(first.history, live.requireRun(run.id).history);
      // And repeated replay is itself deterministic.
      assert.deepEqual(first.history, second.history);
      assert.equal(first.historyTotal, lifetimeTransitions + 1);
      assert.equal(first.historyTotal, second.historyTotal);
      assert.equal(first.historyDropped, first.historyTotal! - MAX_RUN_HISTORY_ENTRIES);
      assert.equal(first.historyDropped, second.historyDropped);

      // refresh() on the same registry is idempotent.
      replayed1.refresh();
      assert.deepEqual(replayed1.requireRun("wfrun-replay").history, first.history);
      assert.equal(replayed1.requireRun("wfrun-replay").historyTotal, first.historyTotal);
      assert.equal(replayed1.requireRun("wfrun-replay").historyDropped, first.historyDropped);
    });

    it("keeps synthesized recovery events idempotent after bounded replay", () => {
      const session = new FakeSessionManager();
      const live = new WorkflowRunRegistry(session);
      const run = live.createRun(parseDef(), { runId: "wfrun-ambig" });
      live.beginEffect(run.id, { key: "create-pr", kind: "github.pr" });

      const replayed = new WorkflowRunRegistry();
      replayed.reconstructFromSession(session);

      const eventId = "recov-wfrun-ambig-create-pr";
      const countSynthesized = () =>
        replayed.requireRun("wfrun-ambig").recoveryEvents!.filter((e) => e.eventId === eventId).length;

      assert.equal(countSynthesized(), 1);
      assert.equal(
        replayed.requireRun("wfrun-ambig").history!.filter((h) => h.eventId === eventId).length,
        1
      );

      replayed.refresh();
      replayed.refresh();

      assert.equal(countSynthesized(), 1);
      assert.equal(
        replayed.requireRun("wfrun-ambig").history!.filter((h) => h.eventId === eventId).length,
        1
      );
    });

    it("persists recovery-event ids so replay reproduces them deterministically", () => {
      const session = new FakeSessionManager();
      const live = new WorkflowRunRegistry(session);
      const run = live.createRun(parseDef(), { runId: "wfrun-rec-ids" });
      live.recordRecoveryEvent(run.id, { type: "scheduler_reconnected", message: "one" });
      live.beginEffect(run.id, { key: "pr", kind: "github.pr" });
      live.reconcileEffect(run.id, { key: "pr", resolution: "aborted", reason: "gone" });

      const liveIds = live.requireRun(run.id).recoveryEvents!.map((e) => e.eventId);
      assert.equal(new Set(liveIds).size, liveIds.length);

      const replayedA = new WorkflowRunRegistry();
      replayedA.reconstructFromSession(session);
      const replayedB = new WorkflowRunRegistry();
      replayedB.reconstructFromSession(session);

      // Recovery ids come from the durable session entries, not randomUUID.
      assert.deepEqual(replayedA.requireRun("wfrun-rec-ids").recoveryEvents!.map((e) => e.eventId), liveIds);
      assert.deepEqual(replayedB.requireRun("wfrun-rec-ids").recoveryEvents!.map((e) => e.eventId), liveIds);
    });

    it("preserves the effect_reconciled audit event when an ambiguous effect is committed", () => {
      const session = new FakeSessionManager();
      const live = new WorkflowRunRegistry(session);
      const run = live.createRun(parseDef(), { runId: "wfrun-rec-commit" });
      live.beginEffect(run.id, { key: "pr", kind: "github.pr" });

      // Reload marks the started effect ambiguous, then the agent commits it.
      const reload = new WorkflowRunRegistry(session);
      reload.reconstructFromSession();
      reload.commitEffect("wfrun-rec-commit", { key: "pr", resultSummary: { ok: true } });

      const replayedA = new WorkflowRunRegistry();
      replayedA.reconstructFromSession(session);
      const replayedB = new WorkflowRunRegistry();
      replayedB.reconstructFromSession(session);

      for (const registry of [replayedA, replayedB]) {
        const replayedRun = registry.requireRun("wfrun-rec-commit");
        assert.equal(
          replayedRun.recoveryEvents!.filter((e) => e.type === "effect_reconciled").length,
          1
        );
        // The durable recovered fact also restores the history suffix.
        assert.equal(replayedRun.history!.some((h) => h.summary.includes("[recovered]")), true);
      }

      assert.deepEqual(
        replayedA.requireRun("wfrun-rec-commit").recoveryEvents,
        replayedB.requireRun("wfrun-rec-commit").recoveryEvents
      );
      assert.deepEqual(
        replayedA.requireRun("wfrun-rec-commit").history,
        replayedB.requireRun("wfrun-rec-commit").history
      );
    });

    it("replays lease release to the same cleared lease and history projection", () => {
      const session = new FakeSessionManager();
      const live = new WorkflowRunRegistry(session);
      const run = live.createRun(parseDef(), { runId: "wfrun-lease" });
      live.acquireLease(run.id, { ownerId: "owner-A" });
      live.releaseLease(run.id, "owner-A");

      const liveRun = live.requireRun(run.id);
      assert.equal(liveRun.lease, undefined);

      const replayed = new WorkflowRunRegistry();
      const replayedRun = replayed.reconstructFromSession(session).runs.find((r) => r.id === "wfrun-lease")!;

      assert.equal(replayedRun.lease, undefined);
      assert.deepEqual(
        replayedRun.history!.map((h) => h.action),
        ["create", "lease_acquire", "lease_release"]
      );
      assert.deepEqual(replayedRun.history, liveRun.history);
      assert.equal(replayedRun.historyTotal, liveRun.historyTotal);
      assert.equal(replayedRun.historyDropped, liveRun.historyDropped);
    });
  });

  describe("bounded recent-history accessor", () => {
    it("exposes deterministic order, clamped limit and truncation metadata", () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const run = registry.createRun(parseDef(), { runId: "wfrun-accessor" });

      const lifetimeTransitions = MAX_RUN_HISTORY_ENTRIES + 50;
      for (let i = 0; i < lifetimeTransitions; i++) {
        registry.transitionStep(run.id, { toStep: `STEP_${i}` });
      }

      const all = registry.getRunHistory(run.id);
      assert.equal(all.order, "oldest");
      assert.equal(all.entries.length, MAX_RUN_HISTORY_ENTRIES);
      assert.equal(all.retained, MAX_RUN_HISTORY_ENTRIES);
      assert.equal(all.total, lifetimeTransitions + 1);
      assert.equal(all.dropped, lifetimeTransitions + 1 - MAX_RUN_HISTORY_ENTRIES);
      assert.equal(all.truncated, true);
      assert.equal(all.limited, false);
      assert.equal(all.entries[all.entries.length - 1].eventId, `transition-${lifetimeTransitions + 1}`);

      const newest = registry.getRunHistory(run.id, { order: "newest", limit: 5 });
      assert.equal(newest.order, "newest");
      assert.equal(newest.entries.length, 5);
      assert.equal(newest.limited, true);
      assert.match(newest.entries[0].summary, new RegExp(`STEP_${lifetimeTransitions - 1}\\b`));
      assert.deepEqual(
        newest.entries,
        registry.getRunHistory(run.id, { order: "newest", limit: 5 }).entries
      );

      const oldestWindow = registry.getRunHistory(run.id, { limit: 5 });
      assert.deepEqual([...oldestWindow.entries], [...newest.entries].reverse());

      // Limit clamping: never below 0, never above the safe maximum.
      assert.equal(registry.getRunHistory(run.id, { limit: -100 }).entries.length, 0);
      assert.equal(registry.getRunHistory(run.id, { limit: 0 }).entries.length, 0);
      assert.equal(registry.getRunHistory(run.id, { limit: 2.9 }).entries.length, 2);
      const huge = registry.getRunHistory(run.id, { limit: 1_000_000 });
      assert.equal(huge.limit, MAX_RUN_HISTORY_QUERY_LIMIT);
      assert.equal(huge.entries.length, MAX_RUN_HISTORY_ENTRIES);
      assert.equal(
        registry.getRunHistory(run.id, { limit: Number.NaN }).entries.length,
        MAX_RUN_HISTORY_ENTRIES
      );
    });

    it("does not scan or materialize the session branch", () => {
      const registry = new WorkflowRunRegistry();
      const run = registry.createRun(parseDef(), { runId: "wfrun-no-scan" });
      registry.transitionStep(run.id, { toStep: "STEP_A" });

      let branchReads = 0;
      registry.bindSession({
        appendCustomEntry: () => "",
        getBranch: () => {
          branchReads++;
          return [];
        },
      });

      registry.getRunHistory(run.id, { limit: 1, order: "newest" });
      registry.getRunRecoveryEvents(run.id);
      assert.equal(branchReads, 0);
    });
  });

  describe("branch isolation", () => {
    it("records verification accept/reject outcomes and replays them deterministically (issue #10)", () => {
      const session = new FakeSessionManager();
      const live = new WorkflowRunRegistry(session);
      const def = parseWorkflowContent(VERIFY_WORKFLOW_YAML, { path: "/verify.md", scope: "project" });

      // Rejection path: two rejected attempts exhaust maxVerificationAttempts and block.
      const rejected = live.createRun(def, { runId: "wfrun-verify-reject" });
      live.claimCompletion(rejected.id, { summary: "first attempt" });
      live.verifyRun(rejected.id, { decision: "reject", feedback: "not yet" });
      live.claimCompletion(rejected.id, { summary: "second attempt" });
      live.verifyRun(rejected.id, { decision: "reject", feedback: "still not" });

      const rejectedRun = live.requireRun(rejected.id);
      assert.equal(rejectedRun.lifecycle, "blocked");
      const rejectActions = rejectedRun.history!.filter((h) => h.action === "verify");
      assert.equal(rejectActions.length, 2);
      assert.match(rejectActions[0].summary, /returning to step/);
      assert.match(rejectActions[1].summary, /blocked for human review/);

      // Accepted path: records the accepted verification and completes.
      const accepted = live.createRun(def, { runId: "wfrun-verify-accept" });
      live.claimCompletion(accepted.id, { summary: "done" });
      live.verifyRun(accepted.id, { decision: "accept" });
      const acceptedRun = live.requireRun(accepted.id);
      assert.equal(acceptedRun.lifecycle, "completed");
      assert.equal(
        acceptedRun.history!.some((h) => h.action === "verify" && /accepted/.test(h.summary)),
        true
      );

      // Replay reproduces the verification history byte-for-byte.
      const replayed = new WorkflowRunRegistry();
      replayed.reconstructFromSession(session);
      assert.deepEqual(replayed.requireRun("wfrun-verify-reject").history, rejectedRun.history);
      assert.deepEqual(replayed.requireRun("wfrun-verify-accept").history, acceptedRun.history);
    });

    it("reconstructs only the active branch's bounded projection", () => {
      const session = new FakeSessionManager();
      const registry = new WorkflowRunRegistry(session);
      const run = registry.createRun(parseDef(), { runId: "wfrun-branch" });
      const forkLeaf = session.getLeafId()!;

      // Branch A: enough transitions to truncate.
      const branchATransitions = MAX_RUN_HISTORY_ENTRIES + 20;
      for (let i = 0; i < branchATransitions; i++) {
        registry.transitionStep(run.id, { toStep: `BRANCH_A_${i}` });
      }
      const leafA = session.getLeafId()!;

      // Fork Branch B from the create point and take a different path.
      session.setLeafId(forkLeaf);
      registry.refresh();
      registry.transitionStep("wfrun-branch", { toStep: "BRANCH_B_ONLY" });
      const leafB = session.getLeafId()!;

      session.setLeafId(leafA);
      registry.refresh();
      const onA = registry.requireRun("wfrun-branch");
      assert.equal(onA.historyTotal, branchATransitions + 1);
      assert.equal(onA.history!.length, MAX_RUN_HISTORY_ENTRIES);
      assert.equal(onA.history!.some((h) => h.summary.includes("BRANCH_B_ONLY")), false);
      assert.match(
        onA.history![onA.history!.length - 1].summary,
        new RegExp(`BRANCH_A_${branchATransitions - 1}\\b`)
      );

      session.setLeafId(leafB);
      registry.refresh();
      const onB = registry.requireRun("wfrun-branch");
      assert.equal(onB.historyTotal, 2); // create + one transition
      assert.equal(onB.historyDropped, 0);
      assert.deepEqual(
        onB.history!.map((h) => h.action),
        ["create", "transition"]
      );
      assert.match(onB.history![1].summary, /BRANCH_B_ONLY/);
      assert.equal(onB.history!.length, 2);
    });
  });
});
