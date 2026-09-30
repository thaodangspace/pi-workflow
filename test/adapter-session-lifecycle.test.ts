/**
 * Production-faithful tests for LoopSchedulerAdapter session identity lifecycle.
 *
 * Covers the issue #23 acceptance surface: pre-session construction, first bind,
 * A→B isolation (ephemeral state, ownership, pending turns, stale service/port),
 * B-branch reconciliation, same-session tree refresh, and shutdown.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOOP_SERVICE_CHANGED_CHANNEL,
  LOOP_SERVICE_DISCOVER_CHANNEL,
  LOOP_SERVICE_VERSION,
} from "pi-loop/service";
import workflowExtension, {
  LoopSchedulerAdapter,
  WorkflowDispatcher,
  WorkflowOwnershipError,
  WorkflowRunRegistry,
  WorkflowSchedulerUnavailableError,
} from "../src/index.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { FakeLoopService, TestEventBus } from "./fake-loop-service.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

const WORKFLOW = `---
name: session-lifecycle-wf
description: Session lifecycle workflow
mode: self-paced
wakeups:
  default: 5m
---
# Body
Do lifecycle work.
`;

function parseDef() {
  return parseWorkflowContent(WORKFLOW, { path: "/test/session-lifecycle.md", scope: "project" });
}

interface Harness {
  session: FakeSessionManager;
  registry: WorkflowRunRegistry;
  dispatcher: WorkflowDispatcher;
  bus: TestEventBus;
  service: FakeLoopService;
  adapter: LoopSchedulerAdapter;
}

function createHarness(): Harness {
  const session = new FakeSessionManager();
  const registry = new WorkflowRunRegistry(session);
  const dispatcher = new WorkflowDispatcher(registry);
  const bus = new TestEventBus();
  const service = new FakeLoopService({ sessionId: "loop-generation-1" });
  bus.registerProvider(service);
  const adapter = new LoopSchedulerAdapter({ registry, dispatcher, events: bus });
  return { session, registry, dispatcher, bus, service, adapter };
}

describe("LoopSchedulerAdapter session lifecycle", () => {
  // 1. Extension constructed before any session exists.
  it("starts unbound with a provisional placeholder identity", () => {
    const { adapter } = createHarness();

    assert.equal(adapter.isSessionActive(), false);
    assert.equal(adapter.getActiveSessionId(), undefined);
    assert.equal(adapter.sessionId, "default");
    assert.match(adapter.ownerId, /^default:inst-/);
    assert.equal(adapter.isAvailable(), false);
    assert.equal(adapter.getService(), undefined);
  });

  // 2. First session_start replaces the placeholder with the concrete session.
  it("replaces the placeholder identity with the concrete session on first bind", () => {
    const { adapter } = createHarness();
    const placeholderOwner = adapter.ownerId;

    adapter.beginSession("session-A");

    assert.equal(adapter.isSessionActive(), true);
    assert.equal(adapter.getActiveSessionId(), "session-A");
    assert.equal(adapter.sessionId, "session-A");
    assert.match(adapter.ownerId, /^session-A:inst-/);
    assert.notEqual(adapter.ownerId, placeholderOwner);
    assert.equal(adapter.getSessionGeneration(), 1);
  });

  it("rejects an empty session id without mutating identity", () => {
    const { adapter } = createHarness();
    adapter.beginSession("session-A");
    const owner = adapter.ownerId;

    assert.throws(() => adapter.beginSession("   "), /non-empty workflow session id/);
    assert.equal(adapter.ownerId, owner);
    assert.equal(adapter.getActiveSessionId(), "session-A");
  });

  // 3. Session A -> B switch clears all ephemeral task mappings.
  it("clears ephemeral run/task correlation on a session switch while preserving durable linkage", async () => {
    const { adapter, registry, service } = createHarness();
    adapter.beginSession("session-A");
    adapter.attachService(service);

    const { run, task } = await adapter.startRun(parseDef(), { runId: "run-A" });
    assert.equal(adapter.getLinkedRunId(task.id), "run-A");

    adapter.beginSession("session-B");

    // Ephemeral task->run correlation is gone.
    assert.equal(adapter.getLinkedRunId(task.id), undefined);
    // Durable registry linkage is authoritative and survives.
    assert.equal(registry.requireRun(run.id).loopTaskId, task.id);
    assert.equal(adapter.getLinkedTaskId(run.id), task.id);
    // The previous session's service handle is detached.
    assert.equal(adapter.getService(), undefined);
  });

  it("clears pending turn correlation on a session switch", async () => {
    const { adapter, dispatcher, service } = createHarness();
    adapter.beginSession("session-A");
    adapter.attachService(service);
    const { run } = await adapter.startRun(parseDef(), { runId: "run-pending" });

    adapter.handleBeforeAgentStart({ prompt: dispatcher.buildPrompt(run.id) });
    adapter.beginSession("session-B");

    // 5. A pending turn from session A cannot bind during session B.
    const binding = adapter.handleTurnStart({ signal: new AbortController().signal });
    assert.equal(binding, undefined);
    assert.equal(dispatcher.getActiveIteration(), undefined);
  });

  // 4. An owner from session A cannot mutate or cancel session B work.
  it("refuses to let a previous session's owner mutate or cancel new-session work", async () => {
    const { adapter, registry, service } = createHarness();
    adapter.beginSession("session-A");
    adapter.attachService(service);
    const { run } = await adapter.startRun(parseDef(), { runId: "run-owned-A" });

    const ownerA = adapter.ownerId;
    assert.equal(registry.requireRun(run.id).lease?.ownerId, ownerA);

    // Hard session boundary with the same durable registry.
    adapter.beginSession("session-B");
    assert.notEqual(adapter.ownerId, ownerA);
    adapter.attachService(service); // freshly discovered service for session B

    await assert.rejects(
      () => adapter.cancelWakeup(run.id),
      (err: unknown) => err instanceof WorkflowOwnershipError
    );
    await assert.rejects(
      () => adapter.scheduleWakeup({ runId: run.id, delayMs: 60_000 }),
      (err: unknown) => err instanceof WorkflowOwnershipError
    );
    await assert.rejects(
      () => adapter.scheduleRun(run.id),
      (err: unknown) => err instanceof WorkflowOwnershipError
    );

    // The run's scheduler task was never stopped by the new session.
    assert.equal(service.listTasks().some((t) => t.prompt.includes("run-owned-A")), true);
  });

  it("refuses a scheduler port captured in a previous session generation", async () => {
    const { adapter, service } = createHarness();
    adapter.beginSession("session-A");
    adapter.attachService(service);
    const { run } = await adapter.startRun(parseDef(), { runId: "run-stale-port" });
    const stalePort = adapter.getSchedulerPort(run.id);

    adapter.beginSession("session-B");
    adapter.attachService(service);

    await assert.rejects(
      async () => {
        await stalePort.scheduleWakeup({ runId: run.id, delayMs: 60_000 });
      },
      (err: unknown) => err instanceof WorkflowSchedulerUnavailableError
    );
    await assert.rejects(
      async () => {
        await stalePort.cancelWakeup?.(run.id);
      },
      (err: unknown) => err instanceof WorkflowSchedulerUnavailableError
    );
  });

  // 6. Stale service handle from session A is detached/invalidated.
  it("detaches and invalidates the previous session's service handle", async () => {
    const { adapter, registry, service } = createHarness();
    adapter.beginSession("session-A");
    adapter.attachService(service);
    assert.equal(adapter.isAvailable(), true);
    const run = registry.createRun(parseDef(), { runId: "run-stale-service" });

    adapter.beginSession("session-B");

    assert.equal(adapter.getService(), undefined);
    assert.equal(adapter.isAvailable(), false);

    // Operations fail closed rather than touching the stale handle.
    await assert.rejects(
      () => adapter.scheduleWakeup({ runId: run.id, delayMs: 60_000 }),
      (err: unknown) => err instanceof WorkflowSchedulerUnavailableError
    );
  });

  // 7. Reconciliation after session B uses only B's durable branch + scheduler tasks.
  it("reconciles a new session against only its own durable branch and scheduler tasks", async () => {
    const def = parseDef();

    // Session A branch: a run that must not leak into session B.
    const sessionA = new FakeSessionManager({ sessionId: "session-A" });
    const registryA = new WorkflowRunRegistry(sessionA);
    const dispatcherA = new WorkflowDispatcher(registryA);
    const runA = registryA.createRun(def, { runId: "run-from-A" });

    // Session B branch: the active durable run.
    const sessionB = new FakeSessionManager({ sessionId: "session-B" });
    const registryB = new WorkflowRunRegistry(sessionB);
    const dispatcherB = new WorkflowDispatcher(registryB);
    const runB = registryB.createRun(def, { runId: "run-from-B" });

    // Authoritative scheduler state holds tasks for BOTH runs.
    const bus = new TestEventBus();
    const service = new FakeLoopService({ sessionId: "loop-generation-B" });
    bus.registerProvider(service);
    const taskA = service.scheduleSelfPaced(dispatcherA.buildPrompt(runA.id));
    const taskB = service.scheduleSelfPaced(dispatcherB.buildPrompt(runB.id));

    const adapter = new LoopSchedulerAdapter({ registry: registryB, dispatcher: dispatcherB, events: bus });
    adapter.beginSession("session-B");
    adapter.attachService(service);

    const report = await adapter.reconcile();

    // Only session B's run is known or matched.
    assert.equal(registryB.hasRun("run-from-A"), false);
    assert.equal(report.matched.some((m) => m.runId === "run-from-B" && m.taskId === taskB.id), true);
    assert.equal(report.matched.some((m) => m.runId === "run-from-A"), false);
    assert.equal(adapter.getLinkedTaskId("run-from-B"), taskB.id);
    // Session A's leftover task is treated as an orphan of a missing run.
    assert.equal(report.orphans.some((o) => o.taskId === taskA.id && o.stopped), true);
    assert.equal(service.listTasks().some((t) => t.id === taskA.id), false);
  });

  // 8. Same-session session_tree refresh does not rotate ownership identity.
  it("preserves ownership identity across a same-session tree refresh", () => {
    const { adapter } = createHarness();
    adapter.beginSession("session-A");
    const owner = adapter.ownerId;
    const generation = adapter.getSessionGeneration();

    adapter.beginSession("session-A");

    assert.equal(adapter.ownerId, owner);
    assert.equal(adapter.getSessionGeneration(), generation);
    assert.equal(adapter.getActiveSessionId(), "session-A");
  });

  // 9. Shutdown leaves the adapter with no active session/service binding.
  it("leaves no active session or service binding after endSession", () => {
    const { adapter, service } = createHarness();
    adapter.beginSession("session-A");
    adapter.attachService(service);
    const generation = adapter.getSessionGeneration();

    adapter.endSession();

    assert.equal(adapter.isSessionActive(), false);
    assert.equal(adapter.getActiveSessionId(), undefined);
    assert.equal(adapter.getService(), undefined);
    assert.equal(adapter.isAvailable(), false);
    assert.equal(adapter.sessionId, "default");
    assert.match(adapter.ownerId, /^default:inst-/);
    assert.equal(adapter.getSessionGeneration(), generation + 1);
  });

  it("honors an explicit owner override across session boundaries", () => {
    const session = new FakeSessionManager();
    const registry = new WorkflowRunRegistry(session);
    const dispatcher = new WorkflowDispatcher(registry);
    const adapter = new LoopSchedulerAdapter({
      registry,
      dispatcher,
      ownerId: "fixed-owner",
    });

    adapter.beginSession("session-A");
    assert.equal(adapter.ownerId, "fixed-owner");
    adapter.beginSession("session-B");
    assert.equal(adapter.ownerId, "fixed-owner");
  });
});

describe("Workflow extension session lifecycle wiring", () => {
  function createFakePi() {
    const handlers = new Map<string, Function>();
    const bus = new TestEventBus();
    const service = new FakeLoopService({ sessionId: "loop-generation-ext" });
    bus.registerProvider(service);
    const registeredTools: unknown[] = [];
    const fakePi: any = {
      events: bus,
      on(event: string, handler: Function) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      registerTool(tool: unknown) {
        registeredTools.push(tool);
      },
      appendEntry() {
        // no-op: the FakeSessionManager owns persistence in these tests.
      },
    };
    return { fakePi, handlers, bus, service, registeredTools };
  }

  it("binds adapter identity before discovery on session_start", async () => {
    const { fakePi, handlers } = createFakePi();
    const handle = workflowExtension(fakePi);

    assert.equal(handle.adapter.isSessionActive(), false);
    assert.equal(handle.adapter.sessionId, "default");
    assert.equal(handle.adapter.getService(), undefined);

    const session = new FakeSessionManager({ sessionId: "ext-session-1" });
    await handlers.get("session_start")!({ type: "session_start" }, { sessionManager: session });

    assert.equal(handle.adapter.getActiveSessionId(), "ext-session-1");
    assert.match(handle.adapter.ownerId, /^ext-session-1:inst-/);
    // Discovery ran after the bind and attached the advertised pi-loop service.
    assert.equal(handle.adapter.isAvailable(), true);
  });

  it("treats a new session id as a hard boundary and rotates ownership", async () => {
    const { fakePi, handlers } = createFakePi();
    const handle = workflowExtension(fakePi);

    await handlers.get("session_start")!(
      { type: "session_start" },
      { sessionManager: new FakeSessionManager({ sessionId: "ext-A" }) }
    );
    const ownerA = handle.adapter.ownerId;

    await handlers.get("session_start")!(
      { type: "session_start" },
      { sessionManager: new FakeSessionManager({ sessionId: "ext-B" }) }
    );

    assert.notEqual(handle.adapter.ownerId, ownerA);
    assert.match(handle.adapter.ownerId, /^ext-B:inst-/);
    assert.equal(handle.adapter.getActiveSessionId(), "ext-B");
  });

  it("preserves ownership on a same-session session_tree refresh", async () => {
    const { fakePi, handlers } = createFakePi();
    const handle = workflowExtension(fakePi);
    const ctx = { sessionManager: new FakeSessionManager({ sessionId: "ext-session-tree" }) };

    await handlers.get("session_start")!({ type: "session_start" }, ctx);
    const owner = handle.adapter.ownerId;

    await handlers.get("session_tree")!({ type: "session_tree" }, ctx);

    assert.equal(handle.adapter.ownerId, owner);
    assert.equal(handle.adapter.getActiveSessionId(), "ext-session-tree");
    assert.equal(handle.adapter.isAvailable(), true);
  });

  it("detaches and clears adapter session state on session_shutdown", async () => {
    const { fakePi, handlers } = createFakePi();
    const handle = workflowExtension(fakePi);
    const ctx = { sessionManager: new FakeSessionManager({ sessionId: "ext-shutdown" }) };

    await handlers.get("session_start")!({ type: "session_start" }, ctx);
    assert.equal(handle.adapter.isAvailable(), true);

    await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);

    assert.equal(handle.adapter.isSessionActive(), false);
    assert.equal(handle.adapter.getService(), undefined);
    assert.equal(handle.adapter.isAvailable(), false);
  });

  it("fails closed on session_start when the concrete session id is missing or invalid", async () => {
    const { fakePi, handlers } = createFakePi();
    const handle = workflowExtension(fakePi);

    // First a valid session binds and attaches its service.
    await handlers.get("session_start")!(
      { type: "session_start" },
      { sessionManager: new FakeSessionManager({ sessionId: "ext-A" }) }
    );
    assert.equal(handle.adapter.isSessionActive(), true);
    assert.equal(handle.adapter.isAvailable(), true);
    const ownerA = handle.adapter.ownerId;

    // session_start with no getSessionId: must end session state and skip
    // discovery/reconciliation rather than retain A's service handle.
    await handlers.get("session_start")!({ type: "session_start" }, { sessionManager: { getBranch: () => [] } });
    assert.equal(handle.adapter.isSessionActive(), false);
    assert.equal(handle.adapter.getService(), undefined);
    assert.equal(handle.adapter.isAvailable(), false);
    assert.notEqual(handle.adapter.ownerId, ownerA);

    // An empty-string id is equally invalid.
    const emptyIdCtx = { sessionManager: { getSessionId: () => "", getBranch: () => [] } };
    await handlers.get("session_start")!({ type: "session_start" }, emptyIdCtx);
    assert.equal(handle.adapter.isSessionActive(), false);
    assert.equal(handle.adapter.getService(), undefined);
    assert.equal(handle.adapter.isAvailable(), false);
  });

  it("an overlapping earlier session_start cannot reconcile the newer session", async () => {
    const handlers = new Map<string, Function>();
    const bus = new TestEventBus();
    const serviceA = new FakeLoopService({ sessionId: "loop-gen-overlap-A" });
    const serviceB = new FakeLoopService({ sessionId: "loop-gen-overlap-B" });

    // First discovery reply (session A) is delayed; the second (session B) is immediate.
    let discoveries = 0;
    bus.on(LOOP_SERVICE_DISCOVER_CHANNEL, (data: any) => {
      if (!data || typeof data.replyChannel !== "string") {
        return;
      }
      discoveries += 1;
      const first = discoveries === 1;
      const service = first ? serviceA : serviceB;
      const reply = () =>
        bus.emit(data.replyChannel, {
          version: LOOP_SERVICE_VERSION,
          available: true,
          sessionId: service.sessionId,
          service,
        });
      if (first) {
        setTimeout(reply, 40);
      } else {
        reply();
      }
    });

    const fakePi: any = {
      events: bus,
      on(event: string, handler: Function) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      registerTool() {},
      appendEntry() {},
    };
    const handle = workflowExtension(fakePi);

    // Record which session each reconcile call observed.
    const reconciledSessions: Array<string | undefined> = [];
    const originalReconcile = handle.adapter.reconcile.bind(handle.adapter);
    handle.adapter.reconcile = async (options?: any) => {
      reconciledSessions.push(handle.adapter.getActiveSessionId());
      return originalReconcile(options);
    };

    const sessionA = new FakeSessionManager({ sessionId: "overlap-A" });
    const sessionB = new FakeSessionManager({ sessionId: "overlap-B" });

    // Kick off A (slow discovery) first; B starts and completes before A resolves.
    const startA = handlers.get("session_start")!({ type: "session_start" }, { sessionManager: sessionA });
    const startB = handlers.get("session_start")!({ type: "session_start" }, { sessionManager: sessionB });
    await Promise.all([startA, startB]);

    assert.equal(handle.adapter.getActiveSessionId(), "overlap-B");
    // Only the newer session may reconcile; the suspended A handler must bail out.
    assert.equal(reconciledSessions.length, 1);
    assert.equal(reconciledSessions[0], "overlap-B");
  });
});

describe("LoopSchedulerAdapter discovery & broadcast races", () => {
  function replyAfter(bus: TestEventBus, service: FakeLoopService, delayMs: number): void {
    bus.on(LOOP_SERVICE_DISCOVER_CHANNEL, (data: any) => {
      if (!data || typeof data.replyChannel !== "string") {
        return;
      }
      setTimeout(() => {
        bus.emit(data.replyChannel, {
          version: LOOP_SERVICE_VERSION,
          available: true,
          sessionId: service.sessionId,
          service,
        });
      }, delayMs);
    });
  }

  class ChangeCapturingBus extends TestEventBus {
    readonly changeHandlers: Array<(data: unknown) => void> = [];
    on(channel: string, handler: (data: unknown) => void): () => void {
      if (channel === LOOP_SERVICE_CHANGED_CHANNEL) {
        this.changeHandlers.push(handler);
      }
      return super.on(channel, handler);
    }
  }

  it("attaches a discovery reply that resolves within the active session generation", async () => {
    const session = new FakeSessionManager();
    const registry = new WorkflowRunRegistry(session);
    const dispatcher = new WorkflowDispatcher(registry);
    const bus = new TestEventBus();
    const serviceA = new FakeLoopService({ sessionId: "loop-gen-A" });
    replyAfter(bus, serviceA, 20);

    const adapter = new LoopSchedulerAdapter({ registry, dispatcher });
    adapter.beginSession("session-A");

    const discovery = await adapter.discover(bus, { timeoutMs: 500 });

    assert.equal(discovery.ok, true);
    assert.equal(adapter.getService(), serviceA);
    assert.equal(adapter.isAvailable(), true);
  });

  it("does not attach a discovery reply that resolves after a session switch", async () => {
    const session = new FakeSessionManager();
    const registry = new WorkflowRunRegistry(session);
    const dispatcher = new WorkflowDispatcher(registry);
    const bus = new TestEventBus();
    const serviceA = new FakeLoopService({ sessionId: "loop-gen-A" });
    replyAfter(bus, serviceA, 30);

    const adapter = new LoopSchedulerAdapter({ registry, dispatcher });
    adapter.beginSession("session-A");
    const pending = adapter.discover(bus, { timeoutMs: 500 });

    // Session switch happens before the slow reply resolves.
    adapter.beginSession("session-B");

    const discovery = await pending;

    assert.equal(discovery.ok, false);
    if (!discovery.ok) {
      assert.equal(discovery.reason, "unavailable");
      assert.match(discovery.message, /generation changed/);
    }
    assert.equal(adapter.getActiveSessionId(), "session-B");
    assert.equal(adapter.getService(), undefined);
    assert.equal(adapter.isAvailable(), false);
  });

  it("reports a generation-changed failure even when the stale reply is unavailable", async () => {
    const session = new FakeSessionManager();
    const registry = new WorkflowRunRegistry(session);
    const dispatcher = new WorkflowDispatcher(registry);
    const bus = new TestEventBus();
    // Delayed *unavailable* reply: the generation guard must still take precedence.
    bus.on(LOOP_SERVICE_DISCOVER_CHANNEL, (data: any) => {
      if (!data || typeof data.replyChannel !== "string") {
        return;
      }
      setTimeout(() => {
        bus.emit(data.replyChannel, {
          version: LOOP_SERVICE_VERSION,
          available: false,
          reason: "provider went away",
        });
      }, 30);
    });

    const adapter = new LoopSchedulerAdapter({ registry, dispatcher });
    adapter.beginSession("session-A");
    const pending = adapter.discover(bus, { timeoutMs: 500 });
    adapter.beginSession("session-B");

    const discovery = await pending;

    assert.equal(discovery.ok, false);
    if (!discovery.ok) {
      assert.equal(discovery.reason, "unavailable");
      assert.match(discovery.message, /generation changed/);
      assert.doesNotMatch(discovery.message, /provider went away/);
    }
    assert.equal(adapter.getService(), undefined);
  });

  it("ignores a stale availability broadcast captured by a superseded session generation", () => {
    const session = new FakeSessionManager();
    const registry = new WorkflowRunRegistry(session);
    const dispatcher = new WorkflowDispatcher(registry);
    const bus = new ChangeCapturingBus();

    const adapter = new LoopSchedulerAdapter({ registry, dispatcher });
    adapter.beginSession("session-A");
    adapter.bindEvents(bus);
    const staleHandler = bus.changeHandlers.at(-1);
    assert.ok(staleHandler);
    adapter.attachService(new FakeLoopService({ sessionId: "loop-gen-A" }));

    // New session generation with its own valid handle.
    adapter.beginSession("session-B");
    const serviceB = new FakeLoopService({ sessionId: "loop-gen-B" });
    adapter.attachService(serviceB);

    // A queued/duplicated broadcast from session A must not clear session B.
    staleHandler({ version: LOOP_SERVICE_VERSION, available: false, reason: "session A ended" });

    assert.equal(adapter.getService(), serviceB);
    assert.equal(adapter.isAvailable(), true);
  });
});
