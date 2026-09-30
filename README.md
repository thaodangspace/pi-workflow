# pi-workflow

Workflow engine for Pi coding agent.

`pi-workflow` enables deterministic, observable, multi-step agent workflows. A workflow definition consists of **configuration (YAML frontmatter) + prompt/policy (Markdown body)**.

The engine does not parse workflow states or state transitions out of prose; workflow definitions declare the governing policies, budgets, capabilities, and guidance for runs.

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
- **Automatic Lifecycle Cleanup**: Active iteration bindings are safely cleared on session reload (`session_start`), session tree switching (`session_tree`), agent settlement (`agent_settled`), and process shutdown (`session_shutdown`).
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

- Every `LoopSchedulerAdapter` instance carries a stable per-instance identity (`ownerId`, defaulting to `<sessionId>:inst-<random>`), which is stamped into durable leases and iteration prompts (`- Owner: <ownerId>`).
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
- Accessible programmatically via `registry.getRunHistory(runId)` and `registry.getRunRecoveryEvents(runId)`.
- Visible to operators in `/workflow status <run-id>` with explicit warnings when reconciliation is required.

**Synthesized vs persisted recovery events:**
- **Persisted** events (e.g. `effect_reconciled`, `scheduler_reconnected`) are written through registry mutation methods and appended as session entries; they are replayed on reconstruction.
- **Synthesized** events are derived during replay when a `started` effect on a non-terminal run is encountered (the run was interrupted before `workflow_effect_commit`). They are marked `details.synthesized === true`, use deterministic ids (`recov-<runId>-<effectKey>`) and the effect's `startedAt` timestamp, and are added to BOTH `recoveryEvents` and `history`. They are intentionally NOT persisted as new session entries, so repeated reconstruction/`refresh()` is idempotent and never duplicates them.



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
| `/workflow status <run-id>` | Show detailed execution state of a specific run (including turn counts, attempt counts, timestamps, data payload, blocker/completion details). |
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
- **Data Privacy in Status**: `/workflow status <run-id>` reports data key names but omits raw values to avoid leaking secrets, tokens, or credentials into transcripts or logs.
- **Non-TUI Mode Fallbacks**: In headless, RPC, or print modes (`!ctx.hasUI` or `ctx.mode !== "tui"`), commands output sensible formatted plain text.

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

- The public `pi-loop` `LoopServiceV1` contract registers/provides the `loop`
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
