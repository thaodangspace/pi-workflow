import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workflowExtension, { createWorkflowRunRegistry, WorkflowRunRegistry } from "../src/index.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

describe("Workflow Extension Entrypoint", () => {
  it("creates a WorkflowRunRegistry via factory function", () => {
    const session = new FakeSessionManager();
    const registry = createWorkflowRunRegistry(session);
    assert(registry instanceof WorkflowRunRegistry);
    assert.equal(registry.getSessionTarget(), session);
  });

  it("subscribes to session_start and session_tree events on ExtensionAPI", async () => {
    const handlers = new Map<string, Function>();
    const fakePi: any = {
      on(event: string, handler: Function) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      appendEntry(customType: string, data?: unknown) {
        session.appendCustomEntry(customType, data);
      },
    };

    const session = new FakeSessionManager();
    workflowExtension(fakePi);

    assert(handlers.has("session_start"));
    assert(handlers.has("session_tree"));

    // Simulate session_start
    const fakeCtx: any = {
      sessionManager: session,
    };
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, fakeCtx);

    // Simulate session_tree
    await handlers.get("session_tree")!({ type: "session_tree" }, fakeCtx);
  });
});
