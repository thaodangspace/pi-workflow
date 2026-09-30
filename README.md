# pi-workflow

Workflow engine for Pi coding agent.

`pi-workflow` enables deterministic, observable, multi-step agent workflows. A workflow definition consists of **configuration (YAML frontmatter) + prompt/policy (Markdown body)**.

The engine does not parse workflow states or state transitions out of prose; workflow definitions declare the governing policies, budgets, capabilities, and guidance for runs.

The ad-hoc `/goal` command is a thin facade over this same engine: a goal is an
ordinary durable workflow run, not a separate subsystem. See
[Goal Facade (`/goal`)](#goal-facade-goal).

---

## Workflow Spec v1

Workflows are authored as Markdown files with YAML frontmatter.

### Location

- **Project workflows**: `.pi/workflows/<name>.md`
- **User workflows**: `~/.pi/agent/workflows/<name>.md` (or `$PI_CODING_AGENT_DIR/workflows/`)

### File Format

```markdown
---
name: github-coding
description: Claim and complete ready GitHub coding tasks.
mode: self-paced

concurrency:
  maxRuns: 1

budget:
  maxTurns: 100
  maxDuration: 8h

wakeups:
  default: 5m
  idle: 15m
  retry: 1m

requires:
  - loop
  - tmux

completion:
  requireSummary: true
  requireEvidence: true
  verify: true
---

# Policy

You are an autonomous engineering agent executing tasks.

## Steps
1. Claim an open issue.
2. Create an isolated worktree.
3. Implement and verify local tests.
4. Open PR and wait for CI.
5. Complete when verification passes.
```

### Schema Specification

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | **Yes** | 1–64 characters matching `^[a-z0-9][a-z0-9_-]*$`. Unique per scope. |
| `description` | string | **Yes** | Concise summary of the workflow (1–1024 characters). |
| `mode` | string | **Yes** | Scheduling mode: `"self-paced"`, `"fixed"`, `"interval"`, `"cron"`, `"once"`, or `"manual"`. |
| `schedule` | object | No | Timing configuration for interval, fixed, or cron modes. |
| `schedule.interval` | string / number | No | Cadence interval (e.g. `"30m"`, `"2h"`). |
| `schedule.cron` | string | No | Standard 5-field cron expression (e.g. `"0 2 * * *"`). |
| `schedule.timeZone` | string | No | IANA timezone (e.g. `"America/New_York"`). |
| `concurrency` | object | No | Concurrency policy. Defaults to `{ maxRuns: 1 }`. |
| `concurrency.maxRuns` | integer | No | Maximum simultaneous runs (>= 1). |
| `budget` | object | No | Execution limits and safeguards. |
| `budget.maxTurns` | integer | No | Maximum agent iterations (>= 1). Hard budget prevents further iterations. |
| `budget.maxDuration` | string / number | No | Maximum wall-clock duration (e.g. `"8h"`, `"30m"`). Hard budget prevents further iterations. |
| `budget.maxAttempts` | integer | No | Maximum implementation or retry attempts (>= 1). |
| `budget.maxCost` | number | No | Optional monetary budget limit (unsupported; rejected fail-closed at start). |
| `budget.onExhaustion` | string | No | Policy on budget exhaustion: `"block"` (default, requires human) or `"cancel"`. |
| `wakeups` | object | No | Wakeup delay policy for self-paced runs. |
| `wakeups.default` | string / number | No | Default wakeup interval (e.g. `"5m"`). |
| `wakeups.min` | string / number | No | Minimum allowed wakeup delay. |
| `wakeups.max` | string / number | No | Maximum allowed wakeup delay. |
| `wakeups.named` | object | No | Named delays e.g. `{ idle: "15m", retry: "1m" }`. |
| `requires` | string[] / object[] | No | Required capability dependencies. Bare names (e.g. `["loop", "tmux"]`) or structured constraints `{ name, version?, features?, optional? }`. See [Capability Providers](docs/capability-providers.md). |
| `completion` | object | No | Completion gate and verification policies. |
| `completion.requireSummary` | boolean | No | Requires completion summary on finish. |
| `completion.requireEvidence` | boolean | No | Requires structured evidence references on finish. |
| `completion.verify` | boolean | No | Triggers an independent verification pass before completion. |
| `completion.verifierPrompt` | string | No | Custom verifier instructions. |
| `completion.maxVerificationAttempts` | integer | No | Maximum verification retries before blocking. |
| `completion.returnStep` | string | No | Target step to return to when verification is rejected. |
| `completion.onRejectionExhausted` | string | No | Policy when verification retries are exhausted: `"block"` (default) or `"fail"`. |
| `metadata` | object | No | Arbitrary custom metadata mapping. |

### Markdown Body

The content following the closing `---` frontmatter delimiter is preserved **byte-for-byte** (including indentation, newlines, and trailing spaces). It serves as the authoritative iteration policy and prompt for the workflow run.

---

## Loading & Discovery Rules

1. **Deterministic Discovery**: Workflow files in `.pi/workflows/` (and optional user directory) are scanned recursively and sorted lexicographically by relative path.
2. **Safe File Size Cap**: Workflow files are capped at **512 KiB** (524,288 bytes) to prevent accidental memory exhaustion or DoS. Oversized files are rejected before reading file content into memory.
3. **Strict Validation**: YAML frontmatter is parsed safely without code evaluation. Missing required fields, malformed YAML, or unexpected top-level fields produce file- and field-specific diagnostics.
4. **Same-Scope Duplicate Rejection**: Duplicate workflow names defined within the same scope (e.g., two project files with `name: deploy`) are deterministically rejected with an actionable error.
5. **Project-over-User Precedence**: If a workflow exists in both user scope and project scope, the project-scoped definition wins. Shadowed user workflows are recorded for observability.
6. **Fresh Loading**: `loadWorkflows()` and `loadWorkflow(name)` re-read directly from disk so modifications are immediately effective without reloading or reinstalling the extension.
7. **Immutable Snapshots**: Active workflow runs capture a `WorkflowSnapshotV1` containing a content-addressed snapshot ID, schema version, creation timestamp, source identity (including SHA-256), and deep-frozen configuration.

---

## Workflow Run Model & Registry

A workflow definition is reusable; a **workflow run** is a concrete, durable execution with its own stable identity, lifecycle, state, counters, scheduler linkage, and workflow-specific data.

### WorkflowRun Record

```typescript
interface WorkflowRun {
  readonly id: string;                     // Stable unique run identifier (e.g. wfrun-deploy-...)
  readonly workflow: string;               // Workflow definition name
  readonly type?: "workflow" | "goal";     // Durable kind discriminator (absent => ordinary workflow)
  readonly objective?: string;             // Goal objective (goal-kind runs only)
  readonly definitionVersion: number | string;
  readonly definitionSource: string;       // Origin file path / scope
  readonly snapshot: WorkflowSnapshotV1;   // Deep-frozen immutable definition snapshot

  readonly lifecycle: WorkflowRunLifecycle;// "active" | "paused" | "blocked" | "completed" | "cancelled"
  readonly step: string;                   // Workflow-defined step (e.g. "WAITING_CI", "IMPLEMENTING")

  readonly createdAt: number;              // Creation timestamp (Unix epoch ms)
  readonly updatedAt: number;              // Last updated timestamp (Unix epoch ms)
  readonly startedAt?: number;
  readonly completedAt?: number;

  readonly loopTaskId?: string;            // Optional scheduled loop task ID

  readonly attempts: number;               // Implementation / retry counter
  readonly turns: number;                  // Agent interaction / turn counter

  readonly data: Readonly<Record<string, JsonValue>>; // Bounded JSON-safe workflow state

  readonly blocker?: Readonly<{            // Present when lifecycle is "blocked"
    reason: string;
    requiresHuman?: boolean;
    blockedAt: number;
  }>;

  readonly completion?: Readonly<{         // Present when lifecycle is "completed"
    summary: string;
    evidence: WorkflowEvidence[];
    completedAt: number;
  }>;
}
```

### Lifecycle State Machine

- **`active`**: Currently executing or eligible to run.
- **`verifying`**: In the independent verification phase evaluating a submitted completion claim. Nonterminal.
- **`paused`**: Human/user-controlled suspension (`/workflow pause <run-id>`). Nonterminal. Zero automatic polling or wakeups. Resumed only via explicit human action (`/workflow resume <run-id>`).
- **`blocked`**: The workflow cannot currently proceed due to an environmental condition or unmet dependency. Nonterminal. Records concrete reason and category:
  - `external-retryable`: External prerequisite (e.g. CI in progress, waiting on webhook). May wake conservatively and re-check.
  - `human-required`: Requires human decision, approval, credentials, or budget extension. Automatic wakeups are stopped until explicit action.
  - `terminal`: Fatal blocker; no further autonomous progress is possible. Zero automatic polling.
- **`completed`**: Finished successfully (terminal). Requires an explicit completion claim, summary, and structured evidence references. Immutable.
- **`cancelled`**: Terminated early (terminal). Immutable.

### Budgets & Enforceable Limits

Workflows can configure definition-level and run-level execution budgets:
- **`maxTurns`**: Maximum agent iterations. Enforced before each turn dispatch and before follow-up scheduling (`workflow_continue`).
- **`maxDuration` / `maxDurationMs`**: Maximum wall-clock duration from start. Enforced before each dispatch, before follow-up scheduling, and linked to scheduler task expiration.
- **`maxAttempts`**: Maximum implementation or retry attempts.
- **Hard Budget Exhaustion**: When a hard budget is exhausted:
  1. No further autonomous iteration is scheduled;
  2. Linked scheduler tasks are immediately stopped/cancelled;
  3. The run transitions to `blocked` (category: `human-required`, `requiresHuman: true`) by default, preserving the exhaustion reason and last known run state, or `cancelled` if `budget.onExhaustion: "cancel"` is configured;
  4. Subsequent autonomous dispatches fail closed with `WorkflowBudgetExhaustedError`.
- **Unsupported Budget Dimensions**: Pi runtime does not expose authoritative cumulative execution token or billing cost accounting data. The engine refuses to guess or approximate; definitions requesting `budget.maxTokens` are rejected at parse time, and definitions specifying `budget.maxCost` fail closed with `WorkflowUnsupportedBudgetError` when started.
- **Persistence Across Reload**: Turn counts, attempt counts, creation timestamps, and budget policies are persisted in the append-only session log and reconstructed deterministically upon session restart or branch navigation.

### Completion Gate & Generic Verification

Completion in `pi-workflow` is an explicit engine concept rather than “the model stopped talking”:
1. **Explicit Completion Claim**: Calling `workflow_complete` submits an explicit completion claim with a required summary and structured evidence references (e.g. PR URLs, commit hashes, test results). The engine stores evidence references durably in session history without blindly assuming claims are true.
2. **Deterministic Phase Transition**:
   - If `completion.verify` is `false` (default): The claim is accepted and the run transitions to `completed`.
   - If `completion.verify` is `true`: The engine persists the completion claim and transitions the run to the `VERIFYING` step.
3. **Constrained Verifier Prompt**: When in the verification phase, the dispatcher builds a specialized verifier prompt detailing the submitted claim, evidence items, workflow verifier instructions, and current run state.
4. **Authoritative Decision**: The verifier must explicitly record a verification finding using `workflow_verify` (or `workflow_complete` with `decision`):
   - **`accept`**: Marks the run `completed`, records verification findings, and stops scheduler wakeups.
   - **`reject`**: Rejects the claim with evaluator findings. If verification attempts are below `maxVerificationAttempts` (default: 3), the run transitions back to active execution at `returnStep` (default: `completion.returnStep` or pre-verification step) for rework. If attempts are exhausted, the run transitions to `blocked` (`human-required`), preventing infinite loops and ensuring a rejected claim never leaves a run marked complete.
5. **No Auto-Approval**: If the model stops talking or turns settle without an explicit acceptance tool call, the run is NOT completed.

### Concurrency & Nonterminal Occupancy

Workflow definitions declare `concurrency.maxRuns` (default: 1).
- **Occupancy Decision**: All **nonterminal** runs (`active`, `paused`, and `blocked`) occupy concurrency slots against `concurrency.maxRuns`.
- **Rationale**: A run that is blocked or paused remains live with pending execution context, uncommitted state, or external resource reservations. Allowing new parallel runs while another is blocked/paused would violate single-stream execution invariants and invite duplicate work or race conditions.
- **Terminal States**: Only terminal runs (`completed` and `cancelled`) release concurrency slots.
- **Resolution**: `createRun()` throws `WorkflowConcurrencyError` when `maxRuns` is reached, or returns the existing nonterminal run if `existingPolicy: "returnExisting"` is configured.

### Bounded JSON Data & Safety

Arbitrary workflow state (`run.data`), evidence, blocker, and completion records are strictly bounded to prevent session bloat, DoS, and circular reference crashes:
- **JSON Primitives Only**: Strings, numbers (finite only), booleans, null, arrays, and plain objects. Functions, symbols, BigInts, undefined, and non-finite numbers (NaN, Infinity) are rejected.
- **Circular Reference Protection**: Cyclic object or array graphs are detected and rejected.
- **Size Limits**:
  - Max per-mutation data payload: **64 KiB** (`MAX_RUN_DATA_BYTES`).
  - Max total cumulative run data: **256 KiB** (`MAX_RUN_TOTAL_DATA_BYTES`).
  - Max scalar string length: **16 KiB** (`MAX_DATA_STRING_LENGTH`).
  - Max object nesting depth: **10** (`MAX_DATA_DEPTH`).
  - Max object key length: **128 characters** (`MAX_DATA_KEY_LENGTH`).
  - Max evidence items: **50 items** (`MAX_EVIDENCE_ITEMS`).
  - Max blocker reason: **2,048 characters** (`MAX_BLOCKER_REASON_LENGTH`).
  - Max completion summary: **4,096 characters** (`MAX_COMPLETION_SUMMARY_LENGTH`).

### Session Persistence & Active Branch Isolation

`pi-workflow` integrates natively with Pi's session tree storage via `CustomEntry` session primitives:
1. **Append-Only Mutation Log**: All run creations, step transitions, updates, blocks, pauses, resumes, completions, and cancellations append a versioned `workflow-run` entry to Pi's session JSONL.
2. **Deterministic Active Branch Replay**: Reconstructing run state replays entries along `ctx.sessionManager.getBranch()` (from root to the current active leaf).
3. **Branch Isolation**: Abandoned or alternate session-tree branches created via `/tree`, `/fork`, or branching navigation never leak run state into the active branch.
4. **Idempotent Replay**: Replaying session entries is deterministic and idempotent. Duplicate create entries in historical logs are detected and ignored without overwriting active run state.
5. **Safe Diagnostic Handling**: Malformed or unsupported session entries (e.g. unknown version, corrupted payloads) are captured as structured diagnostics (`registry.getDiagnostics()`) without crashing the session process.

---

## Iteration Context & Model-Callable Tools

When a workflow run is dispatched, `pi-workflow` binds an exclusive, ephemeral iteration context. The model interacts with the workflow engine using typed, scoped tools without needing to know internal scheduler identifiers or raw run IDs.

### Model-Callable Tools

| Tool | Description | Parameters |
|---|---|---|
| `workflow_get_context` | Inspects current run context, step, durable data, remaining budgets, definition metadata, and capability availability. | `{}` (none) |
| `workflow_transition` | Atomically advances workflow `step`, merges bounded JSON `data`, and appends an audit `reason`. | `{ toStep: string, data?: object, reason?: string }` |
| `workflow_continue` | Requests the next wakeup iteration for the run using named wakeup policy, explicit bounded delay, or default delay. | `{ delay?: string, delayMs?: number, wakeupName?: string, reason?: string }` |
| `workflow_block` | Moves run to `blocked` lifecycle with reason, records `requiresHuman` flag, and cancels pending wakeups. | `{ reason: string, requiresHuman?: boolean, data?: object }` |
| `workflow_complete` | Submits completion summary and evidence. Triggers verification gate (`VERIFYING` step) if policy specifies `verify: true`. During verification, accepts or rejects claim. | `{ summary?: string, decision?: "accept" \| "reject", findings?: string, checks?: object[], returnStep?: string, evidence?: object[], data?: object }` |
| `workflow_verify` | Evaluates a completion claim during verification, accepting to complete or rejecting with findings to return for rework or block. | `{ decision: "accept" \| "reject", findings?: string, checks?: object[], returnStep?: string, data?: object }` |
| `workflow_effect_begin` | Establishes an idempotent checkpoint before executing an external side effect (e.g. creating PR, issue, or deployment). | `{ key: string, kind: string, inputSummary?: object }` |
| `workflow_effect_commit` | Confirms and commits an external side effect after observing its success, preventing accidental re-execution. | `{ key: string, resultSummary?: object }` |
| `workflow_effect_reconcile` | Reconciles an interrupted or ambiguous effect checkpoint after inspecting external reality. | `{ key: string, resolution: "committed" \| "aborted" \| "retryable", reason: string, resultSummary?: object }` |

### Safety & Ownership Rules

- **Current-Run Scoping**: Model tools mutate only the currently executing workflow run. The model never passes raw run IDs or internal scheduler task IDs.
- **Fail-Closed Execution**: Calling tools outside an active iteration immediately fails closed with `WorkflowIterationError`.
- **Per-Instance Ownership**: Every scheduler adapter carries a durable owner identity. A run with a live lease may only be dispatched, reconnected, or mutated by its owning instance; other instances skip it, and dispatch/tool calls fail closed with `WorkflowOwnershipError`. Ownership is only transferred after the previous lease expires (or is released), and takeover is recorded durably.
- **Exclusivity**: Only one workflow iteration turn may hold the active mutation context at any time. Dispatching a new run or turn safely replaces the previous binding and increments the monotonic generation counter.
- **Strict Turn Signal Identity (No Unsafe Fallback)**: Model-facing tools FAIL CLOSED unless BOTH:
  1. The active iteration was dispatched with a turn-bound `AbortSignal` (`binding.signal`);
  2. The host environment passes an `AbortSignal` to the tool's `execute()` invocation (`signal`);
  3. The invocation signal is strictly identical (`===`) to the turn-bound signal.
  If either signal is absent, or if they differ, the tool call is rejected immediately (`WorkflowIterationError` / `WorkflowStaleIterationError`), ensuring a late or stale tool call from an earlier turn can never be mistaken for or mutate a newer run.
- **Stale Late Tool Call Protection**: Every iteration turn is assigned a unique token and a monotonic generation counter. Asynchronous tool calls capture the turn token/generation at execution start and re-verify before and after applying state mutations. If an earlier turn settled, aborted, or was replaced before the tool completed, the mutation is rejected with `WorkflowStaleIterationError`.
- **Lifecycle Guarantees**: Blocked or terminal runs cannot continue scheduling (`workflow_continue` fails closed). Blocking or completing a run cancels any scheduled wakeup via the scheduler port.
- **Automatic Lifecycle Cleanup**: Active iteration bindings are safely cleared on session reload (`session_start`), session tree switching (`session_tree`), agent settlement (`agent_settled`), and process shutdown (`session_shutdown`). The scheduler adapter session generation is bound on `session_start` / refreshed on `session_tree` before discovery/reconciliation, and ended on `session_shutdown` (see [Session Identity & Adapter Lifecycle](#session-identity--adapter-lifecycle)).
- **Trusted Direct Dispatcher & Registry APIs**: Programmatic extensions that need to address a run directly can use trusted registry and dispatcher APIs (`dispatcher.beginIteration`, `dispatcher.withIteration`, `registry.transitionStep`, `registry.blockRun`, `registry.completeRun`) with explicit run IDs. When a run carries a live ownership lease, `beginIteration` must be given the owning instance's `ownerId` (`adapter.dispatchIteration` does this automatically); dispatching a live-leased run without proof of ownership fails closed with `WorkflowOwnershipError`. Model-facing tools strictly enforce turn-bound signal identity and re-verify ownership.

### Dispatcher & Scheduler Port Boundary

A trusted dispatcher API (`WorkflowDispatcher`) provides an explicit interface for executing workflow turns:

```typescript
import {
  WorkflowRunRegistry,
  WorkflowDispatcher,
  type WorkflowSchedulerPort,
} from "pi-workflow";

const registry = new WorkflowRunRegistry();
const dispatcher = new WorkflowDispatcher(registry);

// External scheduler integration port (e.g. pi-loop in Issue #4)
const schedulerPort: WorkflowSchedulerPort = {
  async scheduleWakeup({ runId, delayMs, reason }) {
    console.log(`Schedule wakeup for run ${runId} in ${delayMs}ms: ${reason}`);
  },
  async cancelWakeup(runId) {
    console.log(`Cancel wakeup for run ${runId}`);
  },
};

// Dispatch turn with scoped execution
await dispatcher.withIteration(run.id, { schedulerPort }, async (binding) => {
  // Generates deterministic prompt for agent turn
  const prompt = dispatcher.buildPrompt(run.id);
  // Model tools execute within this iteration scope
});
```

---

## Scheduler Integration (pi-loop)

`pi-workflow` uses `pi-loop` as its single scheduling backend. `pi-workflow` owns workflow orchestration state, lifecycle, and model tools; `pi-loop` owns timers, due queues, wakeups, coalescing, and scheduler persistence.

`pi-workflow` never creates `setTimeout`/`setInterval` timers or a secondary due queue.

### Contract Source of Truth: `pi-loop/service`

`pi-loop/service` is the **single authoritative definition** of the scheduler
service protocol (`LoopServiceV1`). `pi-workflow` imports it directly and does
**not** copy or redefine its constants, types, errors, validators, or discovery
implementation. `pi-workflow` owns only workflow-specific adapter behavior:
run/task reconciliation, ownership and linkage, and translation of scheduler
failures into workflow-level errors.

- **Supported contract**: `pi-loop/service` **V1** (`LOOP_SERVICE_VERSION === 1`).
- **Resolved via a pinned dependency** (`package.json` → `dependencies["pi-loop"]`,
  metadata under `piWorkflow.piLoopService`) pointing at the upstream commit that
  exposes the `./service` entrypoint, so the consumed contract cannot drift
  silently. This is the same commit/origin as `thaodangspace/pi-loop`.
- **No private `pi-loop` modules** (registry, scheduler, due queue, or provider
  internals) are imported; only the public `pi-loop/service` entrypoint is used.
- **A missing or stale live service is handled dynamically**: discovery fails
  closed with `WorkflowSchedulerUnavailableError`, and no fallback scheduler or
  timers are created.

### Scheduler Adapter (`LoopSchedulerAdapter`)

The `LoopSchedulerAdapter` bridges workflow runs to the public, versioned `pi-loop` service contract (`LoopServiceV1`):

```typescript
import {
  WorkflowRunRegistry,
  WorkflowDispatcher,
  LoopSchedulerAdapter,
  createLoopSchedulerAdapter,
} from "pi-workflow";

const registry = new WorkflowRunRegistry();
const dispatcher = new WorkflowDispatcher(registry);

// Create scheduler adapter attached to discovery bus (pi.events)
const adapter = createLoopSchedulerAdapter({
  registry,
  dispatcher,
  events: pi.events,
});

// Discover pi-loop service on session start
await adapter.discover(pi.events);

// Start and schedule workflow run
const { run, task } = await adapter.startRun(workflowDefinition);
console.log(`Workflow run ${run.id} scheduled as pi-loop task ${task.id}`);
```

### Session Identity & Adapter Lifecycle

The adapter is constructed before the first concrete `session_start` (there is no
active session yet), so it begins with a **provisional placeholder** identity.
The extension then drives an explicit lifecycle on every session boundary:

```text
no session
  -> beginSession(activeSessionId)   # session_start
  -> discover / attach pi-loop service
  -> reconcile
  -> endSession()                    # session_shutdown
```

- `beginSession(sessionId)` binds the adapter to the concrete active workflow/Pi
  session, derives a fresh owner id of the form
  `<workflow-session-id>:inst-<random>`, clears ephemeral run↔task maps and
  pending turn correlation, detaches/invalidates the previous session's service
  handle and availability subscription, and clears active iteration state.
  Discovery and reconciliation run **after** this bind.
- `endSession()` detaches and invalidates the service handle, releases
  subscriptions, clears ephemeral mappings and pending turn correlation, and
  clears active iteration state — leaving no active session/service binding.
- **Same-session refresh**: `session_tree` navigation within one session
  preserves the owner identity and attached service handle while resetting
  ephemeral correlation so the new active branch can be reconciled. Only a
  *different* session id is a hard boundary that rotates ownership.
- **Session switch is a hard boundary**: state from the previous session can
  never claim, reschedule, cancel, or satisfy task-link lookup for the new
  session. Scheduler ports and pending turns captured in the old generation fail
  closed: a stale scheduler port throws `WorkflowSchedulerUnavailableError`, and
  a stale pending turn is dropped rather than bound.
- **Late discovery replies are generation-guarded**: `discover()` captures the
  session generation before awaiting `pi-loop`, and only attaches the handle when
  that generation is still active — a reply for session A that resolves after
  `beginSession(B)` is never bound into session B. A superseded reply is reported
  as `{ ok: false, reason: "unavailable", message: "…generation changed…" }`
  rather than a false-positive success. Availability-change broadcasts likewise
  capture their generation, so a queued/slow notification from a superseded
  session cannot clear the active handle. After the awaited discovery the
  extension re-checks the bound generation before reconciling, so a suspended
  `session_start` superseded by a newer one cannot reconcile the new session.
- **Missing/invalid concrete session id fails closed**: if `session_start`
  cannot resolve a non-empty session id, the adapter ends its session (detaching
  any previous handle) and skips discovery/reconciliation instead of retaining a
  previous session's service. `session_tree` with an unresolvable identity skips
  reconciliation entirely rather than assuming the previously bound session.

**Workflow session id vs `LoopServiceV1.sessionId`.** These are deliberately
distinct and are never treated as interchangeable. The workflow/Pi session id
scopes workflow ownership (`ownerId`), while `LoopServiceV1.sessionId` is the
pi-loop provider's own session-generation id
(`adapter.getService()?.sessionId`). A new workflow session always re-discovers
the provider (which may expose its own new generation id) instead of assuming
the two ids match.

`session_start` wiring order:

```text
session_start
  -> clear active iteration
  -> capabilityRegistry.beginSession(...)
  -> registry.bindSession(...) / registry.refresh()
  -> adapter.beginSession(...)        # bind identity BEFORE discovery
  -> discover pi-loop service
  -> reconcile
```

### Supported Scheduling Modes

| Workflow Mode | Scheduler Operation | Behavior |
|---|---|---|
| `self-paced` | `service.scheduleSelfPaced(prompt, options)` | First iteration runs immediately; each iteration paces its next wakeup with `workflow_continue`. Delays clamped to [1m, 1h]. |
| `fixed` / `interval` | `service.scheduleFixed(intervalMs, prompt, options)` | Repeats at fixed cadence (e.g. `15m`, `2h`). |
| `cron` | `service.scheduleCron(cron, prompt, options)` | 5-field calendar schedule with timezone support. |
| `once` | `service.scheduleOnce(at, prompt, options)` | Executes once at absolute epoch timestamp and then removes itself. |

### Runtime Behavior & Turn Signal Identity

1. **Start Run**: `adapter.startRun` creates the durable run record in `WorkflowRunRegistry` and schedules the independent task in `pi-loop`, linking `runId ↔ loopTaskId`.
2. **Scheduled Dispatch**: When due, `pi-loop` dispatches the task as a user message. The prompt carries the unique workflow run identifier (`- Run ID: <id>`).
3. **Turn Signal Binding**: On `before_agent_start` and `turn_start`, `pi-workflow` correlates the prompt to the active run and binds the iteration with the host's per-turn `AbortSignal` (`ctx.signal`).
4. **Execution & Next Wakeup**: The agent inspects context (`workflow_get_context`), advances state (`workflow_transition`), and requests the next wakeup (`workflow_continue`). `workflow_continue` calls `service.scheduleTaskWakeup(loopTaskId, delayMs, reason)`.
5. **Termination & Cancellation**: Completing (`workflow_complete`), blocking (`workflow_block`), or cancelling (`cancelWakeup`) the run stops only its linked scheduler task in `pi-loop`.

### Coexistence with `/loop`

- Workflow tasks are **independent** of the user's command-owned `/loop`.
- Starting, replacing, or stopping `/loop` never removes or cancels workflow scheduler tasks.
- Stopping or completing a workflow task never cancels the user's `/loop`.

### Authoritative Reconciliation on Reload

When a session restarts or navigates history (`session_tree`):
- `adapter.reconcile()` queries `service.listTasks()` from `pi-loop`.
- **Matched runs**: Live runs are reconnected to their authoritative scheduler task IDs.
- **Lost active runs**: Active self-paced runs whose ephemeral scheduler task was lost during restart are safely recreated without duplicating.
- **Orphan tasks**: Scheduled tasks in `pi-loop` with a workflow run prompt whose run was completed, cancelled, or missing are safely pruned with `deleteTask()`.
- **Non-workflow tasks**: User `/loop` tasks and ordinary scheduled tasks are strictly untouched.

### Failure Handling

- If `pi-loop` is unavailable or times out during discovery, workflow scheduling fails clearly with `WorkflowSchedulerUnavailableError`. Pi does not crash, and no local fallback timers are spawned.
- If the bound session generation is invalidated, calls fail closed with `WorkflowSchedulerUnavailableError`.

---

## Crash-Safe Recovery, Reconciliation, and Effect Checkpoints

Long-running agent workflows must assume the host process, machine, or session can crash or reload between durable state transitions and external side effects. `pi-workflow` implements a multi-layer crash-safe recovery and idempotency architecture:

### 1. Recovery Model & State Distinction

On session startup or history reconstruction (`session_start`, `session_tree`), the engine distinguishes four distinct layers:
1. **Durable Workflow State**: Reconstructed strictly from append-only custom entries on the active session branch (`WorkflowRunRegistry.reconstructFromSession()`).
2. **Authoritative Scheduler State**: Linked task status queried from the `pi-loop` service (`LoopSchedulerAdapter.reconcile()`).
3. **Declared External-Effect Intent**: Checkpoints established before attempting real-world side effects (`workflow_effect_begin`).
4. **Observed/Confirmed External Reality**: Confirmed results observed after the side effect (`workflow_effect_commit` or `workflow_effect_reconcile`).

Recovery always prefers **observed external reality** over stale assumptions and **fails closed** when ownership or state is ambiguous.

### 2. Idempotent Effect Checkpoints

Workflows record external side effects (such as creating GitHub pull requests, posting Slack notifications, or provisioning cloud infrastructure) using an explicit begin-commit lifecycle:

```text
workflow_effect_begin({
  key: "create-pr",
  kind: "github.pull_request.create",
  inputSummary: { title: "feat: auth", head: "feature", base: "main" }
})

// <perform external side effect>

workflow_effect_commit({
  key: "create-pr",
  resultSummary: { prNumber: 42, url: "https://github.com/org/repo/pull/42" }
})
```

- **Per-Run Key Uniqueness**: Effect keys are unique within a logical run.
- **Durable Pre-Intent**: `workflow_effect_begin` is persisted to session storage before the side effect executes.
- **Durable Confirmation**: `workflow_effect_commit` is persisted after the side effect succeeds.
- **Duplicate Prevention**: A committed effect cannot be repeated under the same key. Replaying `begin` returns the committed record with `{ status: "already_committed" }` and blocks duplicate execution.
- **Ambiguous Interruption Detection**: An effect left in `started` state after a session reload or crash is marked **ambiguous**, never automatically retried.

### 3. Recovery Prompt & Reconciliation Pass

When a run resumes with an ambiguous effect:
- The engine dispatches a specialized **Recovery & Reconciliation Prompt** rather than an ordinary step prompt.
- Standard step transitions (`workflow_transition`) and completion (`workflow_complete`) fail closed with `WorkflowAmbiguousEffectError`.
- The prompt instructs the agent to inspect the external system first:
  1. If the external resource exists in reality: confirm and commit it using `workflow_effect_commit({ key, resultSummary })`.
  2. If the external resource was not created or failed: reconcile or clear it using `workflow_effect_reconcile({ key, resolution: "aborted" | "retryable", reason })`.
  3. If external reality cannot be verified: block execution using `workflow_block({ reason, category: "human-required", requiresHuman: true })`.

### 4. Deterministic Scheduler Reconciliation

During `adapter.reconcile()`:
- **Terminal Task Cleanup**: Completed or cancelled runs cannot retain live scheduler tasks; any remaining tasks are deleted.
- **Orphan Pruning**: Tasks in `pi-loop` belonging to missing or deleted workflow runs are safely pruned, while ordinary non-workflow tasks (e.g. user `/loop`) are strictly preserved.
- **Missing Task Recreation**: Active runs with missing scheduler tasks (e.g. ephemeral self-paced tasks dropped across reload) are recreated according to policy (`recreateMissing: true`). When recreation is disabled, runs are blocked with `human-required`.
- **Ambiguous Mapping Detection**: If multiple scheduler tasks map to the same run ID, or a task maps to the wrong run, the engine fails closed: conflicting tasks are stopped, and the run is blocked with a human-required blocker to prevent duplicate execution.

### 5. Work Ownership & Lease Metadata

Durable lease metadata (`run.lease`) records owner identity and expiration timestamps. Duplicate workflow instances cannot both believe they own the same logical run:

- Every `LoopSchedulerAdapter` carries a **session-scoped** owner identity (`ownerId`, `<workflow-session-id>:inst-<random>`), derived by `beginSession` and stamped into durable leases and iteration prompts (`- Owner: <ownerId>`). The owner id is rotated on a session switch and preserved across a same-session `session_tree` refresh, so an owner from a previous session can never claim, mutate, or cancel the new session's runs.
- Acquiring or renewing an active lease held by another live owner fails closed with `WorkflowOwnershipError`.
- Production dispatch paths (`handleBeforeAgentStart`, `handleTurnStart`, `dispatchIteration`) always pass the real per-instance `ownerId` into the dispatcher. `beginIteration` refuses to dispatch a run while a *live* lease is held by a different owner or when ownership is not proven, and model tools re-verify ownership on every call (`assertToolBinding`), so a lease taken over mid-iteration causes the stale turn to fail closed.
- On session reconstruction, a nonterminal run leased by a **different, still-live** instance is skipped (diagnostic `run-leased-by-other`) rather than duplicated. After the lease **expires**, the reconciling instance takes it over deterministically, renewing the durable lease before reconnecting the *same* live task and recording a `scheduler_reconnected` recovery event.
- The lease is heartbeated (renewed) when an owning instance starts an iteration turn, so a crashed instance's lease lapses no later than `leaseDurationMs` (default 15 minutes) after its last turn, bounding fail-closed stall time before takeover.
- Generic claim tokens (`getEffectClaimToken(runId, effectKey)`) provide stable identifiers for external resource tagging and branching.

### 5b. Stale Linkage & Cross-Link Safety

- **Stale run↔task link**: If `run.loopTaskId` points at a task that no longer exists while exactly one live task declares the run (and ownership can be proven, e.g. the task's `- Owner:` marker matches or the previous lease expired), the adapter reconnects the live task in place, updates durable linkage, and records `scheduler_reconnected` — it never creates a duplicate task.
- **Unprovable ownership**: If a live task declares the run but its ownership cannot be proven and takeover is disallowed, the adapter fails closed: the run is blocked `human-required`, the unverified task is stopped, and `scheduler_ambiguous` is recorded.
- **Terminal cross-links**: A terminal run whose linkage points at a **user `/loop`** task or **another run's** task never stops or deletes that task; the bogus linkage is cleared (in-memory and durable) and a `cross-point-user-task` / `cross-point-other-run` diagnostic plus `scheduler_cleaned` recovery event are emitted.
- **Active run → user task**: An active run linked to a non-workflow task is blocked `human-required`, its bogus durable linkage is cleared, and the user task is strictly preserved.
- **Direct control safety**: `/workflow pause` / `/workflow stop` (via `cancelWakeup`) validates the authoritative task and its prompt before stopping anything. A linked task belonging to another run or a user `/loop` task is refused and left untouched (fail closed) rather than stopped blindly; stale links to absent tasks are cleared so pause/stop are not blocked forever.
- **Ownership before budget**: `scheduleRun` proves ownership *before* any registry mutation, so a non-owner can never trigger a budget-driven cancel/block of another live owner's run.


### 6. Durable History & Visibility

All recovery events (such as `effect_ambiguous`, `effect_reconciled`, `scheduler_reconnected`, `scheduler_recreated`, `scheduler_cleaned`, `scheduler_ambiguous`) are recorded in chronological run history:
- Accessible programmatically via `registry.getRunHistory(runId, { limit, order })` (a bounded, deterministic view) and `registry.getRunRecoveryEvents(runId)`.
- Visible to operators in `/workflow status <run-id>` with explicit warnings when reconciliation is required.

#### Bounded Recent-History Retention

The append-only Pi session JSONL log remains the **durable source of truth** for every workflow mutation. The in-memory `WorkflowRun.history` and `WorkflowRun.recoveryEvents` fields are **bounded recent-history projections**, not a second lifetime event store:

- Each projection retains at most a fixed capacity of the most recent entries (`MAX_RUN_HISTORY_ENTRIES` = 200 for history, `MAX_RUN_RECOVERY_EVENTS` = 200 for recovery events). Memory is therefore `O(capacity)`, independent of run lifetime.
- Appending an event copies at most `capacity` entries, so per-event cost is `O(capacity)` and never `O(total lifetime events)`.
- Truncation is observable on every run: `historyTotal` / `historyDropped` (and `recoveryEventsTotal` / `recoveryEventsDropped`) count lifetime entries and dropped-out entries. This distinguishes a short-lived run (few lifetime events) from a long-lived run whose history has been truncated.
- Auto-generated history event IDs are derived from the **lifetime total**, not the retained length, so they remain unique after truncation.
- Persisted recovery events (`recovery`, `effect_reconcile`, and the `effect_reconciled` event emitted when an ambiguous effect is committed) embed their event ID in the durable mutation entry, so replay reproduces identical recovery-event IDs rather than generating new random ones. Lease release is persisted with the releasing owner so replay re-clears the lease and appends the same `lease_release` history entry.
- Replay deterministically rebuilds the same projection: re-running reconstruction over the same branch yields identical retained history and identical `total`/`dropped` counters. Synthesized `effect_ambiguous` events keep their deterministic IDs and stay duplicate-free across repeated reconstruction/`refresh()`, and branch isolation is unchanged (only the active branch is replayed).
- The projection deliberately does **not** retain raw tool output or secret-bearing payloads; summaries/details remain bounded JSON-safe records.

`registry.getRunHistory(runId, options)` returns a deterministic view of the projection:
```ts
const view = registry.getRunHistory(runId, { limit: 20, order: "newest" });
// view.entries   -> most-recent-first, at most 20 retained entries
// view.total     -> lifetime history entries (retained + dropped)
// view.retained  -> entries currently retained in the projection
// view.dropped   -> lifetime entries dropped from the projection
// view.truncated -> true when dropped > 0
// view.limited   -> true when `limit` excluded retained entries
```
- `order` is `"oldest"` (default, chronological) or `"newest"`; both are deterministic.
- `limit` is clamped to `[0, MAX_RUN_HISTORY_QUERY_LIMIT]` (`= MAX_RUN_HISTORY_ENTRIES`).
- The accessor reads only the in-memory projection and never scans or materializes the lifetime session log, so it is cheap enough for ordinary status rendering.

Full historical forensic replay remains a separate future capability; the durable session log is never deleted or rewritten.

**Synthesized vs persisted recovery events:**
- **Persisted** events (e.g. `effect_reconciled`, `scheduler_reconnected`) are written through registry mutation methods and appended as session entries with their event ID; they are replayed on reconstruction with the same IDs and ordering.
- **Synthesized** events are derived during replay when a `started` effect on a non-terminal run is encountered (the run was interrupted before `workflow_effect_commit`). They are marked `details.synthesized === true`, use deterministic ids (`recov-<runId>-<effectKey>`) and the effect's `startedAt` timestamp, and are added to BOTH `recoveryEvents` and `history`. They are intentionally NOT persisted as new session entries, so repeated reconstruction/`refresh()` is idempotent and never duplicates them. If that effect is subsequently committed, the durable `effect_commit` entry records the `recovered` fact; a later replay therefore reproduces the persisted `effect_reconciled` event (and the `[recovered]` history marker) while correctly no longer synthesizing a (now-resolved) ambiguity event.



### Deterministic Prompt Construction

Each iteration prompt is assembled deterministically:
1. **Engine Preamble**: Describes current workflow name, run ID, definition schema version, source path, and model tool contract.
2. **Policy Body**: Markdown body preserved from the workflow definition.
3. **Current Run State**: Lifecycle, active step, turn counter / limit, attempts counter / limit, and deeply key-sorted JSON state data.
4. **Required Action Instructions**: Directives requiring the agent to conclude the turn using one of the workflow lifecycle tools (`workflow_transition`, `workflow_continue`, `workflow_block`, or `workflow_complete`).

---

## Programmatic API

```typescript
import {
  loadWorkflows,
  loadWorkflow,
  createWorkflowSnapshot,
  WorkflowRunRegistry,
  createWorkflowRunRegistry,
  createWorkflowCapabilityRegistry,
} from "pi-workflow";

// Load workflow definition and create immutable snapshot
const def = await loadWorkflow("github-coding");
const registry = new WorkflowRunRegistry();

// Session-scoped capability providers (loop is auto-provided by pi-loop).
const capabilities = createWorkflowCapabilityRegistry({ sessionId });
capabilities.register({ name: "tmux", version: 2, features: ["pty"], api: {/* trusted handle */} });

// 1. Create a run
const run = registry.createRun(def, {
  initialStep: "CLAIM_ISSUE",
  initialData: { issueId: 42 },
});

// 2. Advance step and update data
registry.transitionStep(run.id, {
  toStep: "IMPLEMENTING",
  data: { branch: "fix/issue-42" },
});

// 3. Block for external review
registry.blockRun(run.id, {
  reason: "Waiting for PR review and CI checks",
  requiresHuman: true,
});

// 4. Resume after unblocking
registry.resumeRun(run.id, {
  step: "MERGING",
});

// 5. Complete with evidence
registry.completeRun(run.id, {
  summary: "Issue 42 implemented and merged.",
  evidence: [
    { type: "pr", description: "PR #15 merged", url: "https://github.com/org/repo/pull/15" },
    { type: "test", description: "Unit tests passing" },
  ],
});
```

---

## Workflow Lifecycle Commands (`/workflow`)

`pi-workflow` registers the `/workflow` slash command family in Pi for discovering workflow definitions and controlling workflow runs.
The command surface exposes workflow concepts without exposing raw scheduler task IDs.

### Command Reference

| Command | Description |
|---|---|
| `/workflow list` | Show discovered workflow definitions with name, description, mode, required capabilities, and active run count. |
| `/workflow start <name>` | Validate definition & capabilities, enforce concurrency, create durable run, attach scheduler state, and trigger the first iteration. |
| `/workflow status` | Show active/nonterminal runs in deterministic order with concise fields (run ID, workflow, lifecycle, step, age, next wakeup, blocker/completion). |
| `/workflow status <run-id>` | Show safe detailed execution state of a specific run (lifecycle, step, scheduler linkage, capabilities, budget utilization, blocker/completion, latest reconciliation). User/model prose is sanitized and bounded; raw data values and evidence locations are omitted. |
| `/workflow history <run-id> [limit]` | Show a bounded, deterministic, oldest-first suffix of the run's recent durable event history (create, lifecycle/step, effects, budget exhaustion, block/pause/resume, completion submit/verify/reject, cancel, recovery), with retained/lifetime/dropped counts and a truncation notice. |
| `/workflow pause <run-id>` | Persist paused state and cancel/suspend future wakeups without deleting run history. Paused runs do not wake automatically. |
| `/workflow resume <run-id>` | Revalidate required capabilities, transition to active, and restore exactly one scheduler task linkage. |
| `/workflow stop <run-id>` | Cancel the run, stop its scheduler task, and retain durable history. Cancellation is isolated from other runs and the user's ordinary `/loop`. |
| `/workflow reload` | Refresh discovered definitions from disk for future runs. Running runs remain unaffected with their immutable definition snapshots. |
| `/workflow help` | Display command usage and available subcommands. |

### UX & Operational Guarantees

- **Disambiguation**: Definition names are strictly distinguished from run IDs (e.g. passing a run ID to `start` or a definition name to `stop`/`pause`/`resume` gives actionable guidance).
- **Prefix Matching**: Unambiguous run ID prefixes (e.g. `/workflow status wfrun-example-m7`) resolve directly to the matching run. Ambiguous prefixes report all matches.
- **Strict Argument Validation**: Subcommands reject unexpected extra arguments with usage instructions to prevent unintended executions.
- **Next Wakeup Transparency**: If the scheduler cannot provide the next wakeup, `unknown` is reported rather than guessing. Paused or blocked runs explicitly show `none (paused)` or `none (blocked)`.
- **Zero Transcript Spam**: Passive reconciliation (on session start or history navigation) is completely silent. Only explicit user command invocations output messages.
- **Data Privacy in Status**: `/workflow status <run-id>` reports data key names but omits raw values to avoid leaking secrets, tokens, or credentials into transcripts or logs. Free-text fields (blocker reason, summaries, verifier feedback, recovery notes, objective) are sanitized and bounded before display.
- **Non-TUI Mode Fallbacks**: In headless, RPC, or print modes (`!ctx.hasUI` or `ctx.mode !== "tui"`), commands output sensible formatted plain text. The persistent status line is TUI-only (see below).

### Observability, History, and the TUI Status Line (Issue #10)

Issue #10 adds three read-only surfaces over the authoritative run registry and the scheduler projection. None of them parse the chat transcript, hold a mutable service/run handle, or poll on a timer.

#### 1. Bounded run history: `/workflow history <run-id> [limit]`

`/workflow history` renders the retained UTF-8 suffix of a run's bounded history projection (see [Bounded Recent-History Retention](#bounded-recent-history-retention)):

- deterministic **oldest-first** ordering (unless the caller's limit selects the most recent window);
- one line per event with ISO timestamp, action and a short, sanitized summary;
- explicit `retained` / `lifetime` / `dropped` counts and a truncation notice when lifetime events exceeded the bounded projection;
- `limit` is an optional positive integer, clamped to `MAX_RUN_HISTORY_QUERY_LIMIT` (= `MAX_RUN_HISTORY_ENTRIES`, 200). Output is capped irrespective of lifetime event count.

High-value events recorded at the authoritative mutation boundary include run creation, step transitions, effect begin/commit/reconcile, block/pause/resume, completion claim, **verification accept/reject (including the return-to-step, block and cancel outcomes)**, cancellation, lease lifecycle milestones, budget exhaustion (recorded as the resulting block/cancel fact) and recovery events. The durable append-only session log remains the source of truth; the projection is never rendered wholesale and never persisted as raw tool output, terminal captures, env values or provider credentials.

**Resolved decisions (documented rationale):**

- *Wakeup scheduling is surfaced, not persisted.* pi-loop owns timers and does not persist `nextFireAt` in the workflow session log, so recording a wakeup "history" entry would invent durability that does not exist. Instead the authoritative live next-wakeup and linkage are shown by `/workflow status` and the TUI line via the read-only scheduler projection.
- *There is no separate budget "warning" event.* The runtime exposes no authoritative warning threshold; the only authoritative budget transition is exhaustion, which is already recorded through the resulting block/cancel fact. No synthetic warning is invented.

#### 2. Safe diagnostics: `/workflow status` and `/workflow status <run-id>`

`/workflow status` lists all nonterminal runs in deterministic `createdAt`/id order and derives counts from the registry plus the read-only scheduler projection:

```
◇ 2 workflows · 1 active · 1 blocked
```

`/workflow status <run-id>` exposes only safe, derived fields: run/workflow ID, durable kind (`workflow`/`goal`) and objective; definition source, schema version, short definition hash, mode and required capabilities; lifecycle/step and turn/attempt counters; configured budget limits with utilization/remaining duration; scheduler linkage health (`linked` / `absent` / `stale` / `ambiguous` / `unavailable` / `not-applicable`, plus next wakeup and lease expiry); capability availability (required/satisfied/missing/incompatible/degraded/optional-missing names); blocker category and sanitized reason; verification decision/attempt and sanitized feedback; sanitized completion summary with evidence **types and bounded descriptions (URL/path locations are omitted)**; sanitized effect and recovery summaries; and the latest reconciliation outcome.

A command's structured `data` is this safe projection: it never contains the raw `WorkflowRun`, arbitrary data values, evidence locations, service handles, or lease owner handles.

**Free-text safety policy.** Blocker reasons, completion summaries, verifier feedback, recovery notes, effect notes and goal objectives are user/model-controlled prose. Truncation alone cannot make arbitrary prose secret-free, so every such value crosses one shared bounded sanitizer before it is displayed or embedded in a command's `data`. It (1) strips control characters and collapses line breaks for inline rendering, (2) replaces obvious credential shapes — private keys, `sk-…`/`ghp_…`/`xox…`/AWS keys, JWTs, `password=`/`token:`/`bearer …` pairs, URL `user:pass@` userinfo — with a `[redacted …]` marker, and (3) truncates to an explicit bounded length with a visible `…[+N chars]` omission marker. This is best-effort defense-in-depth, **not** a guarantee; the durable session log is the only complete record.

#### 3. Persistent TUI status line

In interactive TUI mode the extension paints exactly **one** aggregate line via Pi's dedicated keyed `ctx.ui.setStatus("workflow", line)` API, for example:

```
◇ 2 workflows · 1 active · 1 blocked · next 10:42
```

- it is derived from the authoritative run registry plus the read-only scheduler projection (unrelated user `/loop` tasks are never counted);
- it is **cleared** (`setStatus("workflow", undefined)`) when no nonterminal workflows remain, on session-tree navigation to a branch with zero runs, and on `session_shutdown`;
- it refreshes only from a post-commit registry mutation observer and a scheduler change hook (attach/detach/discovery, reconcile completion, task link/unlink, wakeup reschedule) — buffered into a single microtask so bursts coalesce; identical rendered text is deduplicated; **no polling, timers, transcript parsing, notifications or message sending** are used;
- it uses the dedicated key `workflow` and never replaces the shared footer (`setFooter`), adds a widget per run, or touches pi-loop's independent `loop` status key, so both extensions coexist;
- it only attaches when `ctx.mode === "tui"` **and** `ctx.ui.setStatus` is present. RPC mode reports `hasUI: true`, so mode — not `hasUI` — gates the paint; headless/RPC/print modes use the command surface only.

> Pi compatibility note: the keyed `setStatus(key, text | undefined)` contract is present in the project's supported Pi peer range. Because status is an optional interactive surface, the extension **feature-detects** `ctx.ui.setStatus` at attach time rather than raising the minimum peer version; commands remain fully functional on older heads, and the peer range is unchanged.

### Definition Compatibility Policy on Resume

- **Missing On-Disk Definition**: When a workflow definition file is removed or moved from disk, existing runs remain execution-safe because their frozen `WorkflowSnapshotV1` preserves the definition body, schema version, and policies. Resume revalidates the snapshot's requirements against available runtime capabilities.
- **Present On-Disk Definition**: If an on-disk definition exists for the workflow, `resume` strictly checks:
  1. **Mode Compatibility**: The on-disk definition's mode must match `run.snapshot.mode`. A run started as `self-paced` cannot resume if the definition was changed to `cron` or `fixed`.
  2. **Schema Compatibility**: Schema version must match.
  3. **New Requirements**: Any additional capabilities in the on-disk definition's `requires` list must also be satisfied.
- **Rollback Guarantee**: If scheduling the next iteration in the scheduler fails during `resume`, the run is rolled back to its previous lifecycle (`paused` or `blocked`) rather than remaining in an un-scheduled active state.

### Capability Detection & Providers

Capabilities are resolved through a session-scoped, versioned provider registry.
Inspecting Pi tool names or namespaces (via `pi.getAllTools()`) is **not** used as
proof of a provider: a registered tool confirms only that a tool exists in the Pi
process, not that an external dependency (e.g. a `tmux` binary, GitHub token) is
installed, authenticated, or compatible.

- The public `pi-loop/service` `LoopServiceV1` contract registers/provides the `loop`
  capability; a workflow requiring `loop` fails clearly when no compatible loop
  provider exists.
- `tmux`/worker-runtime and `github` are logical capabilities satisfied by
  pluggable providers (extension/plugin/CLI-backed adapters), not hard-coded
  executables or GitHub policy.
- Version/feature mismatches produce actionable errors; `degraded` providers
  satisfy requirements but are surfaced in the iteration context and prompt.
- Optional capabilities never block unrelated workflow runs.
- Provider registration is bound to the active Pi session on `session_start`;
  event-bus register and unregister payloads must carry that session's
  non-empty id (missing/mismatched ids are ignored), and session-scoped
  providers are reset on session switch.

See [Capability Providers](docs/capability-providers.md) for the model, the
minimal third-party provider example, and session-scope/lifecycle guarantees.

---

## Goal Facade (`/goal`)

`/goal` is a **thin user-facing facade over the workflow engine**, not a second
orchestration subsystem. A goal is an ordinary, durable, self-paced workflow run
whose objective is supplied interactively. It uses the same run registry,
immutable snapshots, generic lifecycle controls, generic completion/evidence
gate, model tools, and the same single `pi-loop` scheduler adapter as any named
workflow. `/goal` adds **no** second scheduler, timer, continuation engine, or
`agent_settled` auto-continue loop.

### Usage

```text
/goal <objective>        Create an ad-hoc goal workflow run
/goal -- <objective>     Create a goal whose objective starts with a reserved word
/goal status             Show the active goal (or the most recent terminal goal)
/goal pause              Pause the active goal and suspend wakeups
/goal resume             Resume the paused/blocked active goal
/goal stop               Stop (cancel) the active goal and cancel its scheduler task
/goal help               Show usage
```

`status|pause|resume|stop|help` are reserved control subcommands. An objective
that begins with one of those words is ambiguous and is **rejected** with
guidance; use `/goal -- <objective>` to force it to be treated literally.

### Compilation to a workflow

`/goal fix all failing tests and verify the suite passes` builds the reserved
built-in definition `__pi_goal` (`type: "goal"`, in memory only) with:

| Property | Value |
|---|---|
| `mode` | `self-paced` |
| `requires` | `["loop"]` |
| `concurrency.maxRuns` | `1` (one command-owned goal) |
| `budget.maxTurns` | `50` |
| `budget.maxDuration` | `7d` |
| `budget.maxAttempts` | `10` |
| `budget.onExhaustion` | `block` |
| `wakeups.default` / `min` / `max` | `10m` / `1m` / `1h` |
| `completion.requireSummary` | `true` |
| `completion.requireEvidence` | `true` |
| `completion.verify` | `false` (disabled) by default |

Unsupported `maxCost`/`maxTokens` budgets are never generated and remain
rejected by the shared start validation.

The objective is embedded as **task data** in the definition body (the generic
workflow policy mechanism) and is preserved verbatim in the immutable snapshot's
`objective` field. It is never spliced into privileged engine directives.

### Goal iteration policy

The built-in policy instructs the agent to make progress each iteration, persist
concise progress in durable run data with the generic tools, request a bounded
next wakeup with `workflow_continue` when work remains, `workflow_block` with a
human-required reason when authorization/input is required, reconcile uncertain
external effects before repeating them, and submit `workflow_complete` only with
a summary and concrete evidence.

### Completion & verification

Completion uses the generic evidence gate: a summary and at least one evidence
item are required, and plain assistant text (for example “done”) never completes
a goal. The **generic verifier is disabled by default**. A goal completed with
the verifier disabled is recorded as an **unverified completion** and is shown
as such in `/workflow status` (`Verification: not configured (unverified
completion)`); it must never be presented as independently verified. When the
gate is enabled (`createGoalDefinition(objective, { verify: true })` or the goal
controller's `goalOptions`), completion is routed through the existing
`workflow_verify` accept/reject/rework path and its configured attempt limit.

### One-goal policy and terminal history

Exactly one command-owned goal may be **nonterminal** at a time. Starting a
second goal while one is active fails closed without creating a run. Terminal
goals remain visible by run ID through `/workflow status <id>`, and `/goal status`
explicitly reports the most recent terminal goal (with its run ID and lifecycle)
rather than pretending no goal ever existed. If more than one nonterminal goal
is somehow present (for example from manual state), `/goal` fails closed listing
the run IDs instead of controlling an arbitrary run.

### Recovery and reconstruction

Because a goal is a normal durable run, replay and recovery are the ordinary
generic ones: the goal is reconstructed from the session branch via
`WorkflowRunRegistry.reconstructFromSession`, and `session_start` /
`session_tree` reconciliation recreates at most one linked `pi-loop` task from
the durable snapshot. The goal's `type` and `objective` are persisted in the
create entry and survive reload/branch switches; a changed objective is never
recompiled. The built-in definition has a synthetic source identity
(`<builtin>/pi-goal.md`, deterministic SHA-256) and no on-disk file, so definition
compatibility checks are bypassed safely for goal-kind runs; the reserved name
begins with an underscore and can never be produced by the loader.

### Limitations

- One command-owned goal per session (multiple named goal runs are a possible
  future extension, still represented as ordinary runs).
- The verifier is opt-in; an unverified completion is never labelled verified.
- The bounded self-paced fallback is not proof of progress. Hard budgets,
  blockers, and pause/stop always take precedence over wakeups, and a paused,
  blocked (human-required), or terminal goal never spontaneously runs.
- A goal can always be inspected and controlled through the generic
  `/workflow status|pause|resume|stop <run-id>` commands.

---

## Development & Testing

### Prerequisites

- Node.js >= 22.0.0
- npm >= 10.0.0

### Commands

```bash
# Install dependencies
npm install

# Run TypeScript typecheck
npm run typecheck

# Run unit tests
npm test
```
