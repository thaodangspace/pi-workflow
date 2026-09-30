/**
 * Compatibility tests for the authoritative `pi-loop/service` V1 contract.
 *
 * These tests import the protocol, constants, validators and errors directly
 * from `pi-loop/service` (the single source of truth) with no local shims or
 * copied definitions, and prove the workflow adapter:
 *
 *  - discovers/attaches a handle that implements the imported V1 contract;
 *  - fails closed when the attached handle becomes stale/unavailable;
 *  - rejects an incompatible service version instead of attaching it.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  discoverLoopService,
  isLoopServiceV1,
  LOOP_SERVICE_DISCOVER_CHANNEL,
  LOOP_SERVICE_REPLY_CHANNEL_PREFIX,
  LOOP_SERVICE_VERSION,
  type LoopServiceV1,
} from "pi-loop/service";
import {
  LoopSchedulerAdapter,
  WorkflowDispatcher,
  WorkflowRunRegistry,
  WorkflowSchedulerUnavailableError,
} from "../src/index.ts";
import { FakeLoopService, TestEventBus } from "./fake-loop-service.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

describe("pi-loop/service V1 contract compatibility", () => {
  let session: FakeSessionManager;
  let registry: WorkflowRunRegistry;
  let dispatcher: WorkflowDispatcher;
  let eventBus: TestEventBus;
  let fakeService: FakeLoopService;
  let adapter: LoopSchedulerAdapter;

  beforeEach(() => {
    session = new FakeSessionManager();
    registry = new WorkflowRunRegistry(session);
    dispatcher = new WorkflowDispatcher(registry);
    eventBus = new TestEventBus();
    fakeService = new FakeLoopService();
    eventBus.registerProvider(fakeService);
    adapter = new LoopSchedulerAdapter({ registry, dispatcher, events: eventBus });
  });

  it("exposes contract version 1 and structurally validates V1 handles", () => {
    assert.equal(LOOP_SERVICE_VERSION, 1);
    assert.equal(isLoopServiceV1(fakeService), true);
    // Incompatible version and malformed handles are rejected by the contract.
    assert.equal(isLoopServiceV1({ version: 2, sessionId: "s" }), false);
    assert.equal(isLoopServiceV1({ ...fakeService, version: 2 }), false);
  });

  it("discovers a V1 handle implementing the imported contract without local shims", async () => {
    const discovery = await adapter.discover(eventBus, { timeoutMs: 50 });

    assert.equal(discovery.ok, true);
    if (!discovery.ok) return;
    // The discovered handle is the exact authoritative contract instance.
    assert.equal(isLoopServiceV1(discovery.service), true);
    assert.equal(discovery.service, fakeService);
    assert.equal(adapter.isAvailable(), true);
    assert.equal(adapter.getService(), fakeService);
    assert.equal(adapter.getService()?.version, LOOP_SERVICE_VERSION);
  });

  it("attaches a handle typed by the public pi-loop/service contract directly", () => {
    const service: LoopServiceV1 = new FakeLoopService();
    adapter.attachService(service);

    assert.equal(adapter.isAvailable(), true);
    assert.equal(adapter.getService(), service);
    assert.equal(adapter.getService()?.version, LOOP_SERVICE_VERSION);
  });

  it("rejects an incompatible service version during discovery and stays detached", async () => {
    const bus = new TestEventBus();
    bus.on(LOOP_SERVICE_DISCOVER_CHANNEL, (data: any) => {
      bus.emit(`${LOOP_SERVICE_REPLY_CHANNEL_PREFIX}${data.requestId}`, {
        version: 2,
        available: true,
        sessionId: "session-v2",
        service: { ...fakeService, version: 2 },
      });
    });

    const discovery = await discoverLoopService(bus, { timeoutMs: 50 });
    assert.equal(discovery.ok, false);
    assert.equal((discovery as any).reason, "invalid-response");

    const fresh = new LoopSchedulerAdapter({ registry, dispatcher });
    const viaAdapter = await fresh.discover(bus, { timeoutMs: 50 });
    assert.equal(viaAdapter.ok, false);
    assert.equal(fresh.isAvailable(), false);
  });

  it("ignores incompatible-version availability broadcasts and fails closed on unavailable ones", () => {
    adapter.attachService(fakeService);
    assert.equal(adapter.isAvailable(), true);

    // A V2 broadcast is not a V1 status and must be ignored by the V1 consumer.
    eventBus.broadcastChange({
      version: 2,
      available: false,
      reason: "future contract",
    } as any);
    assert.equal(adapter.isAvailable(), true);

    // A V1 unavailable broadcast (session generation invalidated) detaches the handle.
    eventBus.broadcastChange({
      version: LOOP_SERVICE_VERSION,
      available: false,
      reason: "session generation invalidated",
    });
    assert.equal(adapter.isAvailable(), false);
  });

  it("fails closed when an attached handle becomes stale", async () => {
    adapter.attachService(fakeService);
    assert.equal(adapter.isAvailable(), true);

    // Session generation invalidated: the handle reports itself unavailable.
    fakeService.setAvailable(false);
    assert.equal(adapter.isAvailable(), false);

    await assert.rejects(
      () => adapter.scheduleWakeup({ runId: "run-stale", delayMs: 5_000 }),
      (err: unknown) => err instanceof WorkflowSchedulerUnavailableError
    );
    await assert.rejects(
      () => adapter.cancelWakeup("run-stale"),
      (err: unknown) => err instanceof WorkflowSchedulerUnavailableError
    );
  });

  it("fails closed when discovery finds no live service", async () => {
    const disabled = new FakeLoopService({ initialAvailable: false });
    const bus = new TestEventBus();
    bus.registerProvider(disabled);

    const discovery = await adapter.discover(bus, { timeoutMs: 50 });
    assert.equal(discovery.ok, false);
    assert.equal((discovery as any).reason, "unavailable");
    assert.equal(adapter.isAvailable(), false);

    await assert.rejects(
      () => adapter.scheduleWakeup({ runId: "run-no-service", delayMs: 5_000 }),
      (err: unknown) => err instanceof WorkflowSchedulerUnavailableError
    );
  });
});
