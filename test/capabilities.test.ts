/**
 * Issue #8: Versioned capability/provider registry.
 *
 * Covers:
 * 1. Registry registration/disposal and trusted provider handles.
 * 2. Version + feature validation with actionable errors.
 * 3. Degraded/unavailable/optional capability semantics.
 * 4. Session-scoped isolation (no cross-session mutable state).
 * 5. Inter-extension event-bus registration.
 * 6. Workflow start/resume preflight before irreversible run state.
 * 7. Missing provider on one workflow not affecting others.
 * 8. Degradation surfaced in the iteration context.
 * 9. Structured `requires` parsing and snapshot immutability.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  CAPABILITY_BUS_VERSION,
  CAPABILITY_REGISTER_CHANNEL,
  CAPABILITY_REQUEST_CHANNEL,
  CAPABILITY_UNREGISTER_CHANNEL,
  createWorkflowCapabilityRegistry,
  WorkflowCapabilityRegistrationError,
  WorkflowCapabilityRegistry,
  type CapabilityStatus,
} from "../src/capabilities.ts";
import { WorkflowCommandController } from "../src/commands.ts";
import { WorkflowDispatcher } from "../src/dispatcher.ts";
import workflowExtension from "../src/index.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { WorkflowRunRegistry } from "../src/registry.ts";
import { LoopSchedulerAdapter } from "../src/scheduler-adapter.ts";
import { createWorkflowSnapshot } from "../src/snapshot.ts";
import { FakeLoopService, TestEventBus } from "./fake-loop-service.ts";
import { FakeSessionManager } from "./fake-session-manager.ts";

// -------------------------------------------------------------------------
// Registry unit tests
// -------------------------------------------------------------------------

describe("Workflow Capability Registry (Issue #8)", () => {
  it("registers, describes, lists, and disposes versioned providers", () => {
    const registry = createWorkflowCapabilityRegistry({ sessionId: "s1" });
    const handle = registry.register({
      name: "tmux",
      version: 2,
      features: ["pty", "capture"],
      api: { spawn: () => "ok" },
    });

    assert.equal(handle.capability, "tmux");
    assert.equal(handle.version, 2);
    assert.deepEqual([...handle.features], ["pty", "capture"]);

    const capability = registry.getCapability("tmux");
    assert.ok(capability);
    assert.equal(capability!.name, "tmux");
    assert.equal(capability!.version, 2);
    assert.equal(capability!.status, "available");
    assert.deepEqual([...capability!.features], ["pty", "capture"]);

    assert.deepEqual(
      registry.listCapabilities().map((c) => c.name),
      ["tmux"]
    );

    assert.equal(registry.unregister("tmux"), true);
    assert.equal(registry.has("tmux"), false);
    assert.equal(registry.getCapability("tmux"), undefined);
    assert.equal(registry.unregister("tmux"), false);

    registry.dispose();
    assert.equal(registry.isDisposed(), true);
    registry.dispose(); // idempotent
  });

  it("rejects duplicate registrations unless replace is requested", () => {
    const registry = createWorkflowCapabilityRegistry();
    registry.register({ name: "loop", version: 1 });

    assert.throws(
      () => registry.register({ name: "loop", version: 2 }),
      (err: unknown) => {
        assert(err instanceof WorkflowCapabilityRegistrationError);
        assert.match(err.message, /already registered/);
        return true;
      }
    );

    const replaced = registry.register({ name: "loop", version: 2 }, { replace: true });
    assert.equal(replaced.version, 2);
    assert.equal(registry.getCapability("loop")?.version, 2);
  });

  it("validates provider metadata (name, version, status)", () => {
    const registry = createWorkflowCapabilityRegistry();

    assert.throws(() => registry.register({ name: "  " }), /non-empty name/);
    assert.throws(() => registry.register({ name: "x", version: 0 }), /version must be a positive integer/);
    assert.throws(
      () => registry.register({ name: "x", status: "broken" as unknown as CapabilityStatus }),
      /status must be/
    );
    assert.throws(() => registry.register({ name: "y", version: 1, features: ["", "ok"] }), /non-empty strings/);
  });

  it("returns a trusted frozen provider API handle, never raw mutable state", () => {
    const registry = createWorkflowCapabilityRegistry();
    const api = { ping: () => "pong" };
    registry.register({ name: "github", version: 1, api });

    const trusted = registry.getProviderApi<typeof api>("github");
    assert.equal(trusted, api);
    assert.ok(Object.isFrozen(trusted));
    assert.equal(trusted!.ping(), "pong");

    // Capability metadata must never leak the API handle.
    const serialized = JSON.stringify(registry.getCapability("github"));
    assert.ok(!serialized.includes("ping"));
    assert.equal(registry.getProviderApi("github"), trusted);
  });

  it("treats tool names, versions, and features as explicit provider facts only", () => {
    const registry = createWorkflowCapabilityRegistry();

    // A missing provider is missing, regardless of any tool-name heuristic.
    let resolution = registry.resolveRequirements(["tmux"]);
    assert.equal(resolution.ok, false);
    assert.deepEqual(resolution.missing, ["tmux"]);

    registry.register({ name: "tmux", version: 1, features: ["pty"] });
    resolution = registry.resolveRequirements(["tmux"]);
    assert.equal(resolution.ok, true);
    assert.deepEqual(resolution.satisfied, ["tmux"]);
  });

  it("validates required versions and features with actionable reasons", () => {
    const registry = createWorkflowCapabilityRegistry();
    registry.register({ name: "tmux", version: 1, features: ["pty"] });

    const versionResolution = registry.resolveRequirements([
      { name: "tmux", version: 2, features: ["pty"] },
    ]);
    assert.equal(versionResolution.ok, false);
    assert.deepEqual(versionResolution.incompatible, ["tmux"]);
    assert.match(versionResolution.items[0].reason!, /requires version >= 2 but provider version 1/);

    const featureResolution = registry.resolveRequirements([
      { name: "tmux", version: 1, features: ["resize"] },
    ]);
    assert.equal(featureResolution.ok, false);
    assert.match(featureResolution.items[0].reason!, /requires feature\(s\) \[resize\]/);

    const okResolution = registry.resolveRequirements([{ name: "tmux", version: 1, features: ["pty"] }]);
    assert.equal(okResolution.ok, true);
  });

  it("treats unavailable as missing and degraded as satisfied-with-warning", () => {
    const registry = createWorkflowCapabilityRegistry();
    let status: CapabilityStatus = "degraded";
    let reason = "operating in reduced mode";
    registry.register({
      name: "github",
      version: 1,
      getStatus: () => ({ status, reason }),
    });

    let resolution = registry.resolveRequirements(["github"]);
    assert.equal(resolution.ok, true);
    assert.deepEqual(resolution.degraded, ["github"]);
    assert.match(resolution.items[0].reason!, /degraded/);

    status = "unavailable";
    resolution = registry.resolveRequirements(["github"]);
    assert.equal(resolution.ok, false);
    assert.deepEqual(resolution.missing, ["github"]);
    assert.match(resolution.items[0].reason!, /unavailable/);
  });

  it("does not fail a resolution for a missing optional capability", () => {
    const registry = createWorkflowCapabilityRegistry();
    registry.register({ name: "loop", version: 1 });

    const resolution = registry.resolveRequirements(["loop", { name: "github", optional: true }]);
    assert.equal(resolution.ok, true);
    assert.deepEqual(resolution.optionalMissing, ["github"]);
    assert.deepEqual(resolution.missing, []);
  });

  it("keeps registrations isolated between sessions/instances", () => {
    const sessionA = createWorkflowCapabilityRegistry({ sessionId: "A" });
    const sessionB = createWorkflowCapabilityRegistry({ sessionId: "B" });

    sessionA.register({ name: "tmux", version: 2, features: ["pty"] });

    assert.equal(sessionA.has("tmux"), true);
    assert.equal(sessionB.has("tmux"), false);
    assert.equal(sessionB.resolveRequirements(["tmux"]).ok, false);

    sessionB.register({ name: "tmux", version: 1, features: [] });
    assert.equal(sessionB.getCapability("tmux")?.version, 1);
    assert.equal(sessionA.getCapability("tmux")?.version, 2);

    sessionA.dispose();
    assert.equal(sessionB.has("tmux"), true, "disposing one session must not affect another");
  });

  it("accepts provider advertisements over the inter-extension event bus", () => {
    const registry = createWorkflowCapabilityRegistry({ sessionId: "s1" });
    const bus = new TestEventBus();
    registry.bindEventBus(bus as any);

    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "s1",
      provider: { name: "github", version: 3, features: ["prs"], api: { list: () => [] } },
    });
    assert.equal(registry.getCapability("github")?.version, 3);
    assert.ok(registry.getProviderApi("github"));

    bus.emit(CAPABILITY_UNREGISTER_CHANNEL, { version: CAPABILITY_BUS_VERSION, name: "github", sessionId: "s1" });
    assert.equal(registry.has("github"), false);

    // Malformed advertisements are ignored without crashing.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, { version: 999, provider: { name: "bogus" } });
    assert.equal(registry.has("bogus"), false);
  });

  it("requires a matching non-empty session id for bus register and unregister", () => {
    const registry = createWorkflowCapabilityRegistry({ sessionId: "s1" });
    const bus = new TestEventBus();
    registry.bindEventBus(bus as any);

    // Missing session id is refused even though a session is active.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      provider: { name: "github", version: 1 },
    });
    assert.equal(registry.has("github"), false);

    // Mismatched session id is refused.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "other-session",
      provider: { name: "github", version: 1 },
    });
    assert.equal(registry.has("github"), false);

    // Matching session id is accepted.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "s1",
      provider: { name: "github", version: 1 },
    });
    assert.equal(registry.has("github"), true);

    // A foreign session cannot withdraw the current session's provider.
    bus.emit(CAPABILITY_UNREGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      name: "github",
      sessionId: "other-session",
    });
    assert.equal(registry.has("github"), true, "foreign unregister must not withdraw a provider");

    // A sessionless withdrawal is refused too.
    bus.emit(CAPABILITY_UNREGISTER_CHANNEL, { version: CAPABILITY_BUS_VERSION, name: "github" });
    assert.equal(registry.has("github"), true, "sessionless unregister must not withdraw a provider");

    // The owning session can withdraw it.
    bus.emit(CAPABILITY_UNREGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      name: "github",
      sessionId: "s1",
    });
    assert.equal(registry.has("github"), false);
  });

  it("rejects cross-session provider advertisements", () => {
    const registry = createWorkflowCapabilityRegistry({ sessionId: "s1" });
    const bus = new TestEventBus();
    registry.bindEventBus(bus as any);

    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "other-session",
      provider: { name: "github", version: 1 },
    });
    assert.equal(registry.has("github"), false);
  });

  it("ignores bus advertisements until bound to an active session", () => {
    const registry = createWorkflowCapabilityRegistry();
    assert.equal(registry.getSessionId(), undefined);
    const bus = new TestEventBus();
    registry.bindEventBus(bus as any);

    // No active session identity yet: ads must NOT be accepted by default.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "session-A",
      provider: { name: "github", version: 1 },
    });
    assert.equal(registry.has("github"), false);

    registry.beginSession("session-A");
    assert.equal(registry.getSessionId(), "session-A");

    // Sessionless ad is still refused after binding.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      provider: { name: "github", version: 1 },
    });
    assert.equal(registry.has("github"), false);

    // Matching ad is accepted.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "session-A",
      provider: { name: "github", version: 1 },
    });
    assert.equal(registry.has("github"), true);
  });

  it("resets session-scoped providers on session switch and asks for re-advertisement", () => {
    const registry = createWorkflowCapabilityRegistry({ sessionId: "A" });
    const bus = new TestEventBus();
    const requests: any[] = [];
    bus.on(CAPABILITY_REQUEST_CHANNEL, (data) => requests.push(data));
    registry.bindEventBus(bus as any);

    // Direct, process-scoped provider (no session attribution) must survive.
    registry.register({ name: "host", version: 1 });
    // Bus provider is attributed to the active session.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "A",
      provider: { name: "github", version: 1 },
    });
    assert.equal(registry.has("github"), true);

    registry.beginSession("B");
    assert.equal(registry.getSessionId(), "B");
    assert.equal(registry.has("github"), false, "old-session bus provider must be reset");
    assert.equal(registry.has("host"), true, "process-scoped provider must persist");
    assert.equal(requests.at(-1)?.sessionId, "B", "re-advertisement requested for the new session");

    // Even an explicit old-session ad is refused after the switch.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "A",
      provider: { name: "github", version: 1 },
    });
    assert.equal(registry.has("github"), false);

    // New-session ad accepted.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "B",
      provider: { name: "github", version: 1 },
    });
    assert.equal(registry.has("github"), true);
  });
});

// -------------------------------------------------------------------------
// Parser + snapshot structured requirements
// -------------------------------------------------------------------------

describe("Structured capability requirements in workflow definitions", () => {
  const structuredDoc = `---
name: structured-reqs
description: Structured capability requirements.
mode: self-paced
requires:
  - loop
  - name: tmux
    version: 2
    features:
      - pty
  - name: github
    optional: true
---
Body.
`;

  it("normalizes structured requires while preserving legacy name list", () => {
    const def = parseWorkflowContent(structuredDoc, { path: "structured.md", scope: "project" });
    assert.deepEqual(def.requires, ["loop", "tmux", "github"]);
    assert.ok(def.capabilityRequirements);
    assert.deepEqual(
      def.capabilityRequirements!.map((r) => r.name),
      ["loop", "tmux", "github"]
    );
    const tmux = def.capabilityRequirements!.find((r) => r.name === "tmux")!;
    assert.equal(tmux.version, 2);
    assert.deepEqual(tmux.features, ["pty"]);
    const github = def.capabilityRequirements!.find((r) => r.name === "github")!;
    assert.equal(github.optional, true);
  });

  it("rejects malformed structured requirements with field diagnostics", () => {
    assert.throws(
      () =>
        parseWorkflowContent(
          `---\nname: t\ndescription: d\nmode: self-paced\nrequires:\n  - name: tmux\n    version: 0\n---\nbody`,
          { path: "t.md", scope: "project" }
        ),
      /version must be an integer >= 1/
    );

    assert.throws(
      () =>
        parseWorkflowContent(
          `---\nname: t\ndescription: d\nmode: self-paced\nrequires:\n  - loop\n  - name: loop\n---\nbody`,
          { path: "t.md", scope: "project" }
        ),
      /Duplicate capability "loop"/
    );
  });

  it("carries frozen structured requirements into the immutable snapshot", () => {
    const def = parseWorkflowContent(structuredDoc, { path: "structured.md", scope: "project" });
    const snapshot = createWorkflowSnapshot(def, { snapshotId: "snap-1", createdAt: "2026-01-01T00:00:00.000Z" });

    assert.deepEqual(snapshot.requires, ["loop", "tmux", "github"]);
    assert.ok(snapshot.capabilityRequirements);
    assert.equal(snapshot.capabilityRequirements!.length, 3);

    assert.throws(() => {
      // @ts-expect-error readonly
      snapshot.capabilityRequirements!.push({ name: "nope" });
    }, TypeError);

    // Mutating the source definition must not affect the snapshot.
    def.capabilityRequirements!.push({ name: "extra" });
    assert.equal(snapshot.capabilityRequirements!.length, 3);
  });
});

// -------------------------------------------------------------------------
// Command preflight + iteration context integration
// -------------------------------------------------------------------------

describe("Capability preflight and run-context visibility (Issue #8)", () => {
  let tempDir: string;
  let workflowsDir: string;
  let session: FakeSessionManager;
  let runRegistry: WorkflowRunRegistry;
  let dispatcher: WorkflowDispatcher;
  let loopService: FakeLoopService;
  let adapter: LoopSchedulerAdapter;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-wf-cap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    workflowsDir = join(tempDir, ".pi", "workflows");
    mkdirSync(workflowsDir, { recursive: true });

    session = new FakeSessionManager();
    runRegistry = new WorkflowRunRegistry(session);
    dispatcher = new WorkflowDispatcher(runRegistry);
    loopService = new FakeLoopService();
    adapter = new LoopSchedulerAdapter({ registry: runRegistry, dispatcher, service: loopService });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function writeWorkflow(name: string, requiresLines: string[], mode = "self-paced"): string {
    const lines = [
      "---",
      `name: ${name}`,
      `description: ${name} workflow`,
      `mode: ${mode}`,
      "requires:",
      ...requiresLines,
      "---",
      `# ${name} body`,
    ];
    const filePath = join(workflowsDir, `${name}.md`);
    writeFileSync(filePath, lines.join("\n"), "utf-8");
    return filePath;
  }

  it("fails clearly when a workflow requires loop and no compatible loop provider exists", async () => {
    writeWorkflow("needs-loop", ["  - loop"]);
    loopService.setAvailable(false);

    const controller = new WorkflowCommandController({
      registry: runRegistry,
      adapter,
      dispatcher,
      cwd: tempDir,
    });

    const res = await controller.execute("start needs-loop");
    assert.equal(res.ok, false);
    assert.match(res.output, /requires capabilities: \[loop\] which are not currently available/);
    assert.equal(runRegistry.listRuns().length, 0, "no run should be created on capability failure");
    assert.equal(loopService.tasks.size, 0, "no scheduler task should be created");
  });

  it("validates tmux version and feature compatibility before creating run state", async () => {
    writeWorkflow("needs-tmux", [
      "  - loop",
      "  - name: tmux",
      "    version: 2",
      "    features:",
      "      - pty",
    ]);

    const capabilityRegistry = createWorkflowCapabilityRegistry();
    capabilityRegistry.register({ name: "tmux", version: 1, features: ["pty"] });

    const controller = new WorkflowCommandController({
      registry: runRegistry,
      adapter,
      dispatcher,
      cwd: tempDir,
      capabilityRegistry,
    });

    // v1 provider cannot satisfy v2 requirement.
    const versionRes = await controller.execute("start needs-tmux");
    assert.equal(versionRes.ok, false);
    assert.match(versionRes.output, /requires version >= 2/);
    assert.equal(runRegistry.listRuns().length, 0);

    // v2 provider missing required feature.
    capabilityRegistry.register({ name: "tmux", version: 2, features: [] }, { replace: true });
    const featureRes = await controller.execute("start needs-tmux");
    assert.equal(featureRes.ok, false);
    assert.match(featureRes.output, /requires feature\(s\) \[pty\]/);
    assert.equal(runRegistry.listRuns().length, 0);

    // Compatible provider succeeds and creates exactly one run/task.
    capabilityRegistry.register({ name: "tmux", version: 2, features: ["pty"] }, { replace: true });
    const okRes = await controller.execute("start needs-tmux");
    assert.equal(okRes.ok, true);
    assert.equal(runRegistry.listRuns().length, 1);
    assert.equal(loopService.listTasks().length, 1);
  });

  it("detects a compatible worker provider via a fake provider without loading the real extension", () => {
    const capabilityRegistry = createWorkflowCapabilityRegistry();
    capabilityRegistry.register({
      name: "tmux",
      version: 1,
      features: ["pty"],
      api: { run: () => "worker" },
    });

    const resolution = capabilityRegistry.resolveRequirements([{ name: "tmux", features: ["pty"] }]);
    assert.equal(resolution.ok, true);
    assert.equal(capabilityRegistry.getProviderApi("tmux"), capabilityRegistry.getProviderApi("tmux"));
  });

  it("does not let a missing provider on one workflow affect another workflow", async () => {
    writeWorkflow("needs-github", ["  - loop", "  - github"]);
    writeWorkflow("ok-flow", ["  - loop"]);

    const controller = new WorkflowCommandController({
      registry: runRegistry,
      adapter,
      dispatcher,
      cwd: tempDir,
    });

    const failed = await controller.execute("start needs-github");
    assert.equal(failed.ok, false);
    assert.match(failed.output, /requires capabilities: \[github\]/);

    const ok = await controller.execute("start ok-flow");
    assert.equal(ok.ok, true);

    const runs = runRegistry.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].workflow, "ok-flow");
    assert.equal(loopService.listTasks().length, 1);
  });

  it("surfaces degradation and missing optional capabilities in the iteration context", async () => {
    const capabilityRegistry = createWorkflowCapabilityRegistry();
    let tmuxStatus: CapabilityStatus = "available";
    capabilityRegistry.register({
      name: "tmux",
      version: 2,
      features: ["pty"],
      getStatus: () => tmuxStatus,
    });

    const capAdapter = new LoopSchedulerAdapter({
      registry: runRegistry,
      dispatcher,
      service: loopService,
      capabilityRegistry,
    });

    const def = parseWorkflowContent(
      `---\nname: degrade-flow\ndescription: d\nmode: self-paced\nrequires:\n  - loop\n  - name: tmux\n    version: 2\n    features:\n      - pty\n  - name: github\n    optional: true\n---\nbody`,
      { path: "degrade.md", scope: "project" }
    );

    const { run } = await capAdapter.startRun(def);

    // Healthy dispatch: all required capabilities satisfied.
    const ac1 = new AbortController();
    const binding1 = capAdapter.dispatchIteration(run.id, { signal: ac1.signal });
    const ctx1 = dispatcher.getIterationContext(binding1);
    assert.equal(ctx1.capabilities.loop, true);
    assert.equal(ctx1.capabilities.tmux, true);
    assert.equal(ctx1.capabilitiesSatisfied, true);
    assert.deepEqual(ctx1.optionalCapabilitiesMissing, ["github"]);

    // Degrade the tmux provider mid-run; the next dispatch surfaces it.
    tmuxStatus = "unavailable";
    const ac2 = new AbortController();
    const binding2 = capAdapter.dispatchIteration(run.id, { signal: ac2.signal });
    const ctx2 = dispatcher.getIterationContext(binding2);
    assert.equal(ctx2.capabilities.tmux, false);
    assert.equal(ctx2.capabilitiesSatisfied, false);
    assert.ok(ctx2.missingCapabilities?.includes("tmux"));
    assert.equal(ctx2.capabilityStatus?.tmux, "missing");
    assert.ok(!JSON.stringify(ctx2).includes("pty-provider-secret"));
  });

  it("revalidates structured requirements on resume without creating scheduler linkage on failure", async () => {
    writeWorkflow("resume-flow", [
      "  - loop",
      "  - name: tmux",
      "    version: 2",
      "    features:",
      "      - pty",
    ]);

    const capabilityRegistry = createWorkflowCapabilityRegistry();
    capabilityRegistry.register({ name: "tmux", version: 2, features: ["pty"] });

    const controller = new WorkflowCommandController({
      registry: runRegistry,
      adapter,
      dispatcher,
      cwd: tempDir,
      capabilityRegistry,
    });

    const startRes = await controller.execute("start resume-flow");
    assert.equal(startRes.ok, true);
    const runId = (startRes.data as any).runId as string;

    await controller.execute(`pause ${runId}`);
    assert.equal(loopService.listTasks().length, 0);

    // Provider regresses to v1 while paused.
    capabilityRegistry.register({ name: "tmux", version: 1, features: ["pty"] }, { replace: true });

    const resumeRes = await controller.execute(`resume ${runId}`);
    assert.equal(resumeRes.ok, false);
    assert.match(resumeRes.output, /requires version >= 2/);
    assert.equal(runRegistry.getRun(runId)?.lifecycle, "paused");
    assert.equal(loopService.listTasks().length, 0);

    // Restore compatibility and resume successfully.
    capabilityRegistry.register({ name: "tmux", version: 2, features: ["pty"] }, { replace: true });
    const retry = await controller.execute(`resume ${runId}`);
    assert.equal(retry.ok, true);
    assert.equal(loopService.listTasks().length, 1);
  });

  it("does not treat registered Pi tool names as proof of a healthy provider", async () => {
    writeWorkflow("needs-tmux-only", ["  - tmux"]);

    const controller = new WorkflowCommandController({
      registry: runRegistry,
      adapter,
      dispatcher,
      cwd: tempDir,
    });

    // A Pi process may expose a "tmux" tool namespace, but that is not a provider.
    const piWithTools: any = {
      getAllTools: () => [{ name: "tmux", namespace: { name: "tmux" } }],
    };

    const available = await controller.getAvailableCapabilities(piWithTools);
    assert.equal(available.has("tmux"), false);

    const res = await controller.execute("start needs-tmux-only", { pi: piWithTools });
    assert.equal(res.ok, false);
    assert.match(res.output, /requires capabilities: \[tmux\]/);
  });
});

// -------------------------------------------------------------------------
// Default extension session binding (production path)
// -------------------------------------------------------------------------

describe("Default extension capability session binding (Issue #8)", () => {
  function makeFakePi() {
    const handlers = new Map<string, Function>();
    const bus = new TestEventBus();
    const pi: any = {
      events: bus,
      on(event: string, handler: Function) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      registerTool() {},
      registerCommand() {},
      appendEntry() {},
    };
    return { pi, handlers, bus };
  }

  async function triggerSessionStart(
    handlers: Map<string, Function>,
    sessionId: string
  ): Promise<FakeSessionManager> {
    const session = new FakeSessionManager({ sessionId });
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, { sessionManager: session });
    return session;
  }

  it("ignores cross-session ads and resets old-session providers on the default extension path", async () => {
    const { pi, handlers, bus } = makeFakePi();
    const handle = workflowExtension(pi);

    // Before session_start: not bound, so ads are ignored by default.
    assert.equal(handle.capabilityRegistry.getSessionId(), undefined);
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      provider: { name: "github", version: 5 },
    });
    assert.equal(handle.capabilityRegistry.has("github"), false);

    const requests: any[] = [];
    bus.on(CAPABILITY_REQUEST_CHANNEL, (data) => requests.push(data));

    await triggerSessionStart(handlers, "session-A");
    assert.equal(handle.capabilityRegistry.getSessionId(), "session-A");
    assert.equal(requests.at(-1)?.sessionId, "session-A", "providers must be asked to re-advertise for the bound session");

    // Ad from another session is refused even though it names a session id.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "session-B",
      provider: { name: "github", version: 5 },
    });
    assert.equal(handle.capabilityRegistry.has("github"), false);

    // Sessionless ad is refused on the shared bus while a session is bound.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      provider: { name: "github", version: 5 },
    });
    assert.equal(handle.capabilityRegistry.has("github"), false);

    // Ad for the bound session is accepted.
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "session-A",
      provider: { name: "github", version: 5 },
    });
    assert.equal(handle.capabilityRegistry.has("github"), true);
    assert.equal(handle.capabilityRegistry.getCapability("github")?.version, 5);

    // A foreign session cannot withdraw the current session's provider.
    bus.emit(CAPABILITY_UNREGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      name: "github",
      sessionId: "session-B",
    });
    assert.equal(handle.capabilityRegistry.has("github"), true, "foreign unregister must not withdraw");
    bus.emit(CAPABILITY_UNREGISTER_CHANNEL, { version: CAPABILITY_BUS_VERSION, name: "github" });
    assert.equal(handle.capabilityRegistry.has("github"), true, "sessionless unregister must not withdraw");

    // Session switch resets the old-session provider and refuses stale ads.
    await triggerSessionStart(handlers, "session-B");
    assert.equal(handle.capabilityRegistry.getSessionId(), "session-B");
    assert.equal(handle.capabilityRegistry.has("github"), false, "previous-session provider must be reset");
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "session-A",
      provider: { name: "github", version: 5 },
    });
    assert.equal(handle.capabilityRegistry.has("github"), false);
    bus.emit(CAPABILITY_REGISTER_CHANNEL, {
      version: CAPABILITY_BUS_VERSION,
      sessionId: "session-B",
      provider: { name: "github", version: 5 },
    });
    assert.equal(handle.capabilityRegistry.has("github"), true);
  });

  it("preserves an injected capability registry and its process-scoped providers", async () => {
    const injected = createWorkflowCapabilityRegistry();
    injected.register({ name: "host-provider", version: 1 });
    const { pi, handlers } = makeFakePi();

    const handle = workflowExtension(pi, { capabilityRegistry: injected });
    assert.equal(handle.capabilityRegistry, injected);

    await triggerSessionStart(handlers, "session-A");
    assert.equal(injected.getSessionId(), "session-A");
    assert.equal(injected.has("host-provider"), true);

    await triggerSessionStart(handlers, "session-B");
    assert.equal(injected.getSessionId(), "session-B");
    assert.equal(injected.has("host-provider"), true, "process-scoped injected provider must persist");
  });

  it("binds the session id even when the registry was created without one", async () => {
    const { pi, handlers } = makeFakePi();
    const handle = workflowExtension(pi);
    assert.equal(handle.capabilityRegistry.getSessionId(), undefined);
    await triggerSessionStart(handlers, "session-X");
    assert.equal(handle.capabilityRegistry.getSessionId(), "session-X");
  });
});
