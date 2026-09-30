import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workflowExtension, {
  createWorkflowDispatcher,
  createWorkflowRunRegistry,
  WorkflowDispatcher,
  WorkflowRunRegistry,
} from "../src/index.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

describe("Workflow Extension Entrypoint", () => {
  it("creates a WorkflowRunRegistry via factory function", () => {
    const session = new FakeSessionManager();
    const registry = createWorkflowRunRegistry(session);
    assert(registry instanceof WorkflowRunRegistry);
    assert.equal(registry.getSessionTarget(), session);
  });

  it("creates a WorkflowDispatcher via factory function", () => {
    const session = new FakeSessionManager();
    const registry = createWorkflowRunRegistry(session);
    const dispatcher = createWorkflowDispatcher(registry);
    assert(dispatcher instanceof WorkflowDispatcher);
  });

  it("subscribes to session_start, session_tree, agent_settled, and session_shutdown events on ExtensionAPI and registers tools", async () => {
    const handlers = new Map<string, Function>();
    const registeredTools: any[] = [];
    const registeredCommands = new Map<string, any>();
    const session = new FakeSessionManager();

    const fakePi: any = {
      on(event: string, handler: Function) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, options: any) {
        registeredCommands.set(name, options);
      },
      appendEntry(customType: string, data?: unknown) {
        session.appendCustomEntry(customType, data);
      },
    };

    const handle = workflowExtension(fakePi);

    assert(handlers.has("session_start"));
    assert(handlers.has("session_tree"));
    assert(handlers.has("agent_settled"));
    assert(handlers.has("session_shutdown"));

    assert.equal(registeredTools.length, 9);
    const toolNames = registeredTools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "workflow_block",
      "workflow_complete",
      "workflow_continue",
      "workflow_effect_begin",
      "workflow_effect_commit",
      "workflow_effect_reconcile",
      "workflow_get_context",
      "workflow_transition",
      "workflow_verify",
    ]);

    // Both slash-command families are registered on the same extension.
    assert.ok(registeredCommands.has("workflow"));
    assert.ok(registeredCommands.has("goal"));
    assert.equal(typeof registeredCommands.get("goal").handler, "function");
    assert.equal(typeof registeredCommands.get("goal").getArgumentCompletions, "function");
    assert.ok(handle.goalController, "extension handle exposes the goal controller");

    // Simulate session_start
    const fakeCtx: any = {
      sessionManager: session,
    };
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, fakeCtx);

    // Simulate session_tree
    await handlers.get("session_tree")!({ type: "session_tree" }, fakeCtx);

    // Simulate agent_settled
    await handlers.get("agent_settled")!({ type: "agent_settled" }, fakeCtx);

    // Simulate session_shutdown
    await handlers.get("session_shutdown")!({ type: "session_shutdown" }, fakeCtx);
  });
});
