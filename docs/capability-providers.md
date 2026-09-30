# Capability Providers

`pi-workflow` resolves a workflow's declared **logical capability requirements**
(`loop`, `tmux`, `github`, …) to **versioned providers** at runtime. Workflow
definitions never depend on a specific executable path, tool name, or plugin
implementation.

```
pi-loop       pi-tmux        github provider
   \             |              /
    \            |             /
       capability registry
              |
         pi-workflow
```

`pi-workflow` orchestrates. Providers execute domain-specific primitives. The
`capability registry` is the only shared boundary, so `pi-loop`/`pi-tmux` never
depend on `pi-workflow`.

## Model

A provider is described by:

```ts
interface WorkflowCapability {
  name: string;                              // stable logical name
  version: number;                           // provider major version
  features: string[];                        // advertised feature flags
  status: "available" | "degraded" | "unavailable";
  reason?: string;                           // when degraded/unavailable
}
```

Registration also carries an optional **trusted extension-facing API handle**
(`api`). The registry freezes that object on registration and exposes it only
through `registry.getProviderApi(name)`. Model-facing context
(`workflow_get_context`) receives availability metadata only — never the handle
or any raw mutable internal state.

Provider presence is explicit. A registered Pi tool, a namespace, or a binary
on `PATH` is **not** treated as proof of a compatible, healthy provider.

## Declaring requirements

Legacy bare names keep working:

```yaml
requires:
  - loop
  - tmux
```

Structured constraints add minimum version, required features, and
optionality:

```yaml
requires:
  - loop
  - name: tmux
    version: 2
    features:
      - pty
  - name: github
    optional: true
```

- `version` is a minimum provider version.
- `features` are all required for the requirement to be satisfied.
- `optional: true` capabilities never block a run. Their absence/degradation is
  surfaced in the iteration context and prompt instead.
- Parsed definitions still expose the flat `requires: string[]` name list for
  backwards compatibility, plus a normalized `capabilityRequirements` array.

Resolution distinguishes two failure modes with actionable messages:

- **missing** — no provider (or an `unavailable` provider) is registered;
- **incompatible** — a provider exists but is below the required version or
  lacks a required feature.

`degraded` providers satisfy required capabilities but are reported so the
model and operators can see reduced functionality.

## Minimal third-party provider

### 1. Announce over `pi.events` (recommended for external extensions)

A provider extension advertises its capability on the session-scoped inter-extension
bus. The workflow registry is bound to the same bus for the current session.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Channels match pi-workflow's public capability protocol (v1).
const REGISTER = "pi-workflow:capability:register:v1";
const UNREGISTER = "pi-workflow:capability:unregister:v1";
const REQUEST = "pi-workflow:capability:request:v1";

export default function githubCapabilityProvider(pi: ExtensionAPI) {
  // The trusted, narrow API that trusted callers receive.
  const api = Object.freeze({
    async listReadyIssues() {
      /* domain logic */
      return [];
    },
    async createPullRequest(input: { title: string; head: string; base: string }) {
      /* domain logic */
      return { number: 0 };
    },
  });

  const advertise = (sessionId: string) =>
    pi.events.emit(REGISTER, {
      version: 1,
      // A non-empty, matching session id is REQUIRED on the shared bus.
      sessionId,
      provider: { name: "github", version: 1, features: ["issues", "pull-requests"], api },
    });

  pi.on("session_start", async (_event, ctx) => {
    advertise(ctx.sessionManager.getSessionId());
  });

  // pi-workflow asks providers to (re-)advertise once it has bound to the
  // active session; echo the provided sessionId back. This guarantees
  // ordering and prevents cross-session ads.
  pi.events.on(REQUEST, (data) => advertise((data as { sessionId: string }).sessionId));

  pi.on("session_shutdown", async (_event, ctx) => {
    pi.events.emit(UNREGISTER, {
      version: 1,
      name: "github",
      sessionId: ctx.sessionManager.getSessionId(),
    });
  });
}
```

Advertisements and withdrawals are only honored while the registry is bound to
an active Pi session, and **both** must carry the same non-empty `sessionId`.
A missing or mismatched session id is ignored, so another session sharing the
process bus can neither register nor withdraw a provider for this session. All
bus-advertised providers are reset when the session changes.

### 2. Register directly on the session registry

Programmatic/embedded deployments can construct the registry and share it with
the scheduler adapter and command controller:

```ts
import {
  WorkflowRunRegistry,
  WorkflowDispatcher,
  createWorkflowCapabilityRegistry,
  createLoopSchedulerAdapter,
  createWorkflowCommandController,
} from "pi-workflow";

const capabilityRegistry = createWorkflowCapabilityRegistry({ sessionId });

let tmuxHealthy = true;
capabilityRegistry.register({
  name: "tmux",
  version: 2,
  features: ["pty", "capture"],
  api: Object.freeze({ spawn: (argv: string[]) => runWorker(argv) }),
  // Called on every read, so degradation is reflected immediately.
  getStatus: () => (tmuxHealthy ? "available" : { status: "unavailable", reason: "tmux server stopped" }),
});

const registry = new WorkflowRunRegistry();
const dispatcher = new WorkflowDispatcher(registry);
const adapter = createLoopSchedulerAdapter({
  registry,
  dispatcher,
  events: pi.events,
  capabilityRegistry,
});
const controller = createWorkflowCommandController({
  registry,
  adapter,
  dispatcher,
  capabilityRegistry,
});

// On session shutdown:
capabilityRegistry.dispose();
```

The `loop` capability is registered automatically from the public, versioned
`pi-loop` `LoopServiceV1` contract. Availability and version come from that
service, never from tool names or CLI presence.

## Session scope and isolation

- A `WorkflowCapabilityRegistry` belongs to one Pi process/session. It is never
  a module-level singleton, so registrations cannot leak between sessions.
- The extension binds the registry to the concrete active session identity on
  `session_start` (`beginSession(ctx.sessionManager.getSessionId())`).
  Advertisements received from the event bus are **only** honored while a
  session identity is bound, so pre-session or cross-session ads are never
  accepted by default.
- On a session switch, providers attributed to the previous session (all
  bus-advertised providers, plus direct providers that declared that session id)
  are reset; process-scoped direct providers are preserved. The registry then
  broadcasts `pi-workflow:capability:request:v1` so providers re-advertise for
  the new session.
- Event-bus register **and** unregister payloads must carry the same non-empty
  `sessionId` as the bound session; missing or mismatched ids are ignored, so a
  session sharing the process bus can neither register nor withdraw providers.
- The extension `dispose()`s the registry on `session_shutdown`, removing all
  providers and the bus subscription.

## Lifecycle guarantees

- **Preflight before irreversible state**: `/workflow start` and
  `/workflow resume` validate every required capability *before* a durable run
  or scheduler task is created. A missing provider never leaves an orphan run.
- **Deferred validation for optional capabilities**: a missing optional
  capability does not crash the run or unrelated workflows.
- **Degradation visibility**: each dispatched iteration captures a capability
  report, surfaced in `workflow_get_context` and the iteration prompt.
- **Failure isolation**: one workflow's unmet capability cannot affect another
  workflow's runs.

## Limitations

- `degraded` means "present but reduced"; it satisfies required capabilities by
  design. Use required `features` to fail closed when a specific capability of
  the provider is essential.
- There is no automatic probing of external systems (installed binaries,
  credentials, remote API health). Providers must report status explicitly.
- Capability registration is an in-process, session-scoped trust boundary.
  Only trusted extensions should advertise providers.
