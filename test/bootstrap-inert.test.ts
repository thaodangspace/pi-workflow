/**
 * Issue #11 bootstrap acceptance: the extension module and factory must be
 * inert at load time.
 *
 * Pi's extension contract (docs/extensions.md) requires that extensions do not
 * start "processes, sockets, watchers, or timers in the factory because some
 * invocations load extensions without starting a session". This file therefore
 * deliberately does NOT statically import `../src/index.ts`: node:test isolates
 * each test file in its own process, so the guarded dynamic import below is the
 * first and only evaluation of the extension module graph in this process.
 *
 * It complements (does not replace) the lifecycle suites in
 * `test/adapter-session-lifecycle.test.ts` and `test/extension.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeLoopService, TestEventBus } from "./fake-loop-service.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

interface TimerSpy {
  setTimeout: number;
  setInterval: number;
}

/**
 * Runs `fn` while counting synchronous global timer registrations. The real
 * timer functions are still invoked, so async work that legitimately arms a
 * timer is not broken; this test only asserts the count is zero for
 * import/factory loading.
 */
async function withTimerSpy<T>(fn: () => T | Promise<T>): Promise<{ result: T; timers: TimerSpy }> {
  const timers: TimerSpy = { setTimeout: 0, setInterval: 0 };
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  (globalThis as any).setTimeout = (...args: any[]) => {
    timers.setTimeout += 1;
    return (realSetTimeout as any)(...args);
  };
  (globalThis as any).setInterval = (...args: any[]) => {
    timers.setInterval += 1;
    return (realSetInterval as any)(...args);
  };
  try {
    return { result: await fn(), timers };
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
    (globalThis as any).setInterval = realSetInterval;
  }
}

describe("Extension bootstrap inertness (issue #11)", () => {
  it("evaluates the module and factory without timers or workflow resources", async () => {
    const service = new FakeLoopService({ sessionId: "bootstrap-loop-generation" });
    const bus = new TestEventBus();
    bus.registerProvider(service);

    const handlers = new Map<string, Function>();
    const unsubscribers: Array<() => void> = [];
    const registeredTools: string[] = [];
    const registeredCommands: string[] = [];
    const session = new FakeSessionManager({ sessionId: "bootstrap-session" });

    // Synchronous, Pi-faithful ExtensionAPI mock: `on()` registers immediately
    // and returns an unsubscribe function; `registerTool`/`registerCommand`
    // are synchronous and return void, exactly like the real ExtensionAPI.
    const pi: any = {
      events: bus,
      on(event: string, handler: Function) {
        handlers.set(event, handler);
        const unsubscribe = () => handlers.delete(event);
        unsubscribers.push(unsubscribe);
        return unsubscribe;
      },
      registerTool(tool: { name: string }) {
        registeredTools.push(tool.name);
      },
      registerCommand(name: string) {
        registeredCommands.push(name);
      },
      appendEntry(customType: string, data?: unknown) {
        session.appendCustomEntry(customType, data);
      },
    };

    // 1. Module import must have no timer side effects.
    const { result: mod, timers: importTimers } = await withTimerSpy(() => import("../src/index.ts"));
    assert.deepEqual(importTimers, { setTimeout: 0, setInterval: 0 }, "module import must not schedule timers");

    // 2. Factory load must be equally inert.
    const { result: handle, timers: factoryTimers } = await withTimerSpy(() => mod.default(pi));
    assert.deepEqual(factoryTimers, { setTimeout: 0, setInterval: 0 }, "factory must not schedule timers");

    // 3. Registration is synchronous, and the mock preserves real unsubscribe
    //    semantics: removing one registration does not affect the others.
    for (const event of [
      "session_start",
      "session_tree",
      "before_agent_start",
      "turn_start",
      "agent_settled",
      "session_shutdown",
    ]) {
      assert.ok(handlers.has(event), `handler registered synchronously for ${event}`);
    }
    assert.equal(typeof unsubscribers[0], "function", "pi.on returns an unsubscribe function");
    assert.equal(handlers.size, unsubscribers.length);
    assert.equal(registeredTools.length, 9);
    assert.ok(registeredCommands.includes("workflow"));
    assert.ok(registeredCommands.includes("goal"));

    // 4. No session-scoped scheduler/service or run resources exist yet.
    assert.equal(handle.adapter.isSessionActive(), false);
    assert.equal(handle.adapter.getService(), undefined);
    assert.equal(handle.adapter.isAvailable(), false);
    assert.equal(handle.dispatcher.getActiveIteration(), undefined);
    assert.equal(handle.registry.listRuns().length, 0);
    assert.equal(service.listTasks().length, 0, "no scheduler task is created before an explicit run");

    // 5. Binding a session alone must not start a scheduler run.
    const ctx = { sessionManager: session };
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(service.listTasks().length, 0, "session_start must not schedule a workflow run");

    // 6. Cleanup is idempotent (repeated shutdown/reload must not throw).
    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "reload" }, ctx);
    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);

    // 7. The recorded unsubscriber removes exactly its own registration.
    const sizeBeforeUnsubscribe = handlers.size;
    unsubscribers[0]!();
    assert.equal(handlers.size, sizeBeforeUnsubscribe - 1);
  });
});
