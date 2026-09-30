# PLAN: GitHub Issue #8 — Versioned Capability/Provider Registry

## Goal

Let workflow definitions declare required capabilities (`loop`, `tmux`,
`github`, …) without hard-coding each integration into the workflow engine.
`pi-workflow` resolves those requirements to versioned providers at runtime.

## Implemented Components

### 1. Session-scoped registry (`src/capabilities.ts`)

- `WorkflowCapabilityRegistry` — one instance per Pi process/session, never a
  module global, so registrations cannot leak across sessions.
- `WorkflowCapability { name, version, features, status, reason? }` with
  `status: "available" | "degraded" | "unavailable"`.
- `CapabilityProviderRegistration` accepts an optional trusted `api` handle and
  a dynamic `getStatus()` resolver for degradation during a run.
- `register` / `unregister` / `dispose` provide controlled registration and
  lifetime. Duplicate names fail closed unless `{ replace: true }`.
- `getProviderApi(name)` is the only accessor for the provider handle; model
  context never receives it.
- Requirement resolution distinguishes **missing** from **incompatible**
  (version/feature) with actionable reasons, and reports degraded/optional
  capabilities separately.

### 2. Structured requirements

- The parser accepts bare names and structured entries
  `{ name, version?, features?, optional? }`.
- `definition.requires` remains a flat `string[]` for compatibility; the
  normalized `capabilityRequirements` array is carried into the immutable
  snapshot (deep-frozen).

### 3. Scheduler/provider wiring

- The `loop` capability is registered from the public, versioned
  `LoopServiceV1` contract. Availability/version come from the service, never
  from tool names or CLI presence.
- `LoopSchedulerAdapter` captures a capability report per dispatched iteration
  and passes it to the dispatcher.
- `WorkflowCommandController` validates all required capabilities *before*
  creating durable run state on `start` and `resume`.
- `pi.getAllTools()` name heuristics were removed from capability discovery.
  Explicit `capabilities` supplied by the host remain authoritative.

### 4. Visibility

- `WorkflowIterationContext` exposes `capabilityStatus`, `capabilityIssues`,
  `missingCapabilities`, `incompatibleCapabilities`, `degradedCapabilities`,
  optional capability gaps, and `capabilitiesSatisfied`.
- The iteration prompt renders a `## Capability Status` section only when a
  report exists and reports a concern, keeping default prompts byte-stable.

### 5. Inter-extension protocol

- `bindEventBus(events)` subscribes to
  `pi-workflow:capability:register:v1` / `...:unregister:v1`, enabling external
  extensions to advertise providers without holding the registry instance.
- Advertisements are honored **only while the registry is bound to an active
  session** (`beginSession(sessionId)`), called from `session_start` with
  `ctx.sessionManager.getSessionId()`. Both register and unregister payloads on
  the shared bus must carry the same non-empty session id; missing or mismatched
  ids are ignored, so a foreign session can neither register nor withdraw a
  provider.
- On a session switch, providers attributed to the previous session are reset
  (bus providers always; direct providers that declared that session). A
  `pi-workflow:capability:request:v1` broadcast asks providers to re-advertise
  for the new session. The binding is removed on `dispose()`.

### 6. Documentation

- `docs/capability-providers.md` documents the model, structured requirements,
  a minimal third-party provider example (event bus and direct registration),
  session scope, lifecycle guarantees, and limitations.
- README schema and capability sections updated.

## Acceptance Criteria

- [x] A workflow requiring `loop` fails clearly when no compatible loop provider exists.
- [x] A workflow requiring `tmux` can detect whether a compatible worker provider is present.
- [x] Capability version/feature requirements are validated with actionable errors.
- [x] Starting one workflow with a missing provider does not affect other workflows.
- [x] Provider loss/degradation is visible in the current run context.
- [x] A fake provider can be registered in tests without loading the real extension.
- [x] Documentation includes a minimal third-party capability provider example.

## Preserved Behavior

- Issues #5–#7 lifecycle commands, budgets/completion gates, recovery,
  reconciliation, ownership leases, and scheduler integration are unchanged.
- All pre-existing tests continue to pass.
