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

  it("subscribes to session_start, session_tree, agent_start, agent_settled, and session_shutdown events on ExtensionAPI and registers tools", async () => {
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
    assert(handlers.has("agent_start"));
    assert(handlers.has("agent_settled"));
    assert(handlers.has("session_shutdown"));

    assert.equal(registeredTools.length, 10);
    const toolNames = registeredTools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "workflow_block",
      "workflow_complete",
      "workflow_continue",
      "workflow_effect_begin",
      "workflow_effect_commit",
      "workflow_effect_reconcile",
      "workflow_get_context",
      "workflow_provider_call",
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

// ===========================================================================
// Issue #10 — aggregate interactive TUI status line
// ===========================================================================

class RecordingStatusUI {
  statusCalls: Array<{ key: string; text: string | undefined }> = [];
  footerCalls = 0;
  widgetCalls = 0;
  notifyCalls = 0;
  setStatus(key: string, text: string | undefined): void {
    this.statusCalls.push({ key, text });
  }
  setFooter(): void {
    this.footerCalls += 1;
  }
  setWidget(): void {
    this.widgetCalls += 1;
  }
  notify(): void {
    this.notifyCalls += 1;
  }
  lastText(key = "workflow"): string | undefined {
    const calls = this.statusCalls.filter((c) => c.key === key);
    return calls.length > 0 ? calls[calls.length - 1].text : undefined;
  }
}

function makeExtensionHarness() {
  const handlers = new Map<string, Function>();
  const session = new FakeSessionManager();
  const fakePi: any = {
    on(event: string, handler: Function) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerTool() {},
    registerCommand() {},
    appendEntry(customType: string, data?: unknown) {
      session.appendCustomEntry(customType, data);
    },
  };
  const handle = workflowExtension(fakePi);
  return { handlers, session, fakePi, handle };
}

const STATUS_DEF_YAML = `---
name: status-example
description: TUI status workflow.
mode: self-paced
concurrency:
  maxRuns: 10
---
# Status
`;

describe("Aggregate TUI workflow status line (issue #10)", () => {
  it("is one aggregate line under a dedicated key, refreshed from registry mutations and cleared when empty", async () => {
    const { handlers, session, handle } = makeExtensionHarness();
    const ui = new RecordingStatusUI();
    const ctx: any = { mode: "tui", hasUI: true, ui, sessionManager: session };

    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(ui.lastText(), undefined, "no runs -> key cleared");

    const def = parseWorkflowContent(STATUS_DEF_YAML, { path: "/status.md", scope: "project" });
    const a = handle.registry.createRun(def, { runId: "wfrun-status-a" });
    const b = handle.registry.createRun(def, { runId: "wfrun-status-b" });
    handle.registry.blockRun(b.id, { reason: "Waiting on review", requiresHuman: true });

    handle.statusLine.paintNow();
    const line = ui.lastText()!;
    assert.match(line, /^◇ 2 workflows · 1 active · 1 blocked/);

    // Every paint uses the dedicated `workflow` key; pi-loop's `loop` key and
    // the shared footer/widget/notify surfaces are never touched.
    assert.ok(ui.statusCalls.every((c) => c.key === "workflow"));
    assert.equal(ui.footerCalls, 0);
    assert.equal(ui.widgetCalls, 0);
    assert.equal(ui.notifyCalls, 0);

    // Completing/cancelling all runs clears the key.
    handle.registry.cancelRun(a.id, { reason: "done" });
    handle.registry.cancelRun(b.id, { reason: "done" });
    handle.statusLine.paintNow();
    assert.equal(ui.lastText(), undefined);
  });

  it("does not paint in non-TUI modes (RPC has hasUI=true) even with a UI object", async () => {
    const { handlers, session } = makeExtensionHarness();
    const ui = new RecordingStatusUI();
    const ctx: any = { mode: "rpc", hasUI: true, ui, sessionManager: session };

    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(ui.statusCalls.length, 0, "RPC must not receive setStatus paints");
  });

  it("coalesces burst mutations into a single microtask paint", async () => {
    const { handlers, session, handle } = makeExtensionHarness();
    const ui = new RecordingStatusUI();
    const ctx: any = { mode: "tui", hasUI: true, ui, sessionManager: session };
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    const def = parseWorkflowContent(STATUS_DEF_YAML, { path: "/status.md", scope: "project" });
    const run = handle.registry.createRun(def, { runId: "wfrun-burst" });
    handle.registry.transitionStep(run.id, { toStep: "STEP_A" });
    handle.registry.transitionStep(run.id, { toStep: "STEP_B" });

    const before = ui.statusCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Coalesced to at most one repaint for the burst.
    assert.ok(ui.statusCalls.length - before <= 1, "burst updates must coalesce");
  });

  it("clears on session-tree switch to a branch with zero runs and on shutdown", async () => {
    const { handlers, session, handle } = makeExtensionHarness();
    const ui = new RecordingStatusUI();
    const ctx: any = { mode: "tui", hasUI: true, ui, sessionManager: session };
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    const beforeCreateLeaf = session.getLeafId();
    const def = parseWorkflowContent(STATUS_DEF_YAML, { path: "/status.md", scope: "project" });
    handle.registry.createRun(def, { runId: "wfrun-tree" });
    handle.statusLine.paintNow();
    assert.ok(ui.lastText());

    // Navigate to a branch point before the run existed: zero nonterminal runs.
    session.setLeafId(beforeCreateLeaf);
    await handlers.get("session_tree")!({ type: "session_tree" }, ctx);
    handle.statusLine.paintNow();
    assert.equal(ui.lastText(), undefined, "branch with zero runs clears the status line");

    // Re-create and then shut down: the key is cleared and subscriptions removed.
    handle.registry.createRun(def, { runId: "wfrun-tree-2" });
    handle.statusLine.paintNow();
    assert.ok(ui.lastText());
    await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
    assert.equal(ui.lastText(), undefined);

    const callsAfterShutdown = ui.statusCalls.length;
    handle.registry.createRun(def, { runId: "wfrun-tree-3" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ui.statusCalls.length, callsAfterShutdown, "no repaint after detach");
  });
});
