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
| `budget.maxTurns` | integer | No | Maximum agent iterations (>= 1). |
| `budget.maxDuration` | string / number | No | Maximum wall-clock duration (e.g. `"8h"`, `"30m"`). |
| `budget.maxAttempts` | integer | No | Maximum implementation or retry attempts (>= 1). |
| `budget.maxCost` | number | No | Optional monetary budget limit. |
| `wakeups` | object | No | Wakeup delay policy for self-paced runs. |
| `wakeups.default` | string / number | No | Default wakeup interval (e.g. `"5m"`). |
| `wakeups.min` | string / number | No | Minimum allowed wakeup delay. |
| `wakeups.max` | string / number | No | Maximum allowed wakeup delay. |
| `wakeups.named` | object | No | Named delays e.g. `{ idle: "15m", retry: "1m" }`. |
| `requires` | string[] | No | Required capability dependencies (e.g. `["loop", "tmux"]`). |
| `completion` | object | No | Completion gate and verification policies. |
| `completion.requireSummary` | boolean | No | Requires completion summary on finish. |
| `completion.requireEvidence` | boolean | No | Requires structured evidence references on finish. |
| `completion.verify` | boolean | No | Triggers an independent verification pass before completion. |
| `completion.verifierPrompt` | string | No | Custom verifier instructions. |
| `completion.maxVerificationAttempts` | integer | No | Maximum verification retries. |
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
- **`paused`**: Suspended by user or policy. Nonterminal. Can be resumed to `active` or cancelled.
- **`blocked`**: Waiting on an external condition (e.g., human approval, PR review, CI run). Nonterminal. Can be resumed to `active` (clearing blocker) or cancelled.
- **`completed`**: Finished successfully (terminal). Requires summary and structured evidence references. Immutable.
- **`cancelled`**: Terminated early (terminal). Immutable.

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
| `workflow_complete` | Submits completion summary and evidence. Triggers verification gate (`VERIFYING` step) if policy specifies `verify: true`. | `{ summary: string, evidence?: object[], data?: object }` |

### Safety & Ownership Rules

- **Current-Run Scoping**: Model tools mutate only the currently executing workflow run. The model never passes raw run IDs or internal scheduler task IDs.
- **Fail-Closed Execution**: Calling tools outside an active iteration immediately fails closed with `WorkflowIterationError`.
- **Exclusivity**: Only one workflow iteration turn may hold the active mutation context at any time. Dispatching a new run or turn safely replaces the previous binding and increments the monotonic generation counter.
- **Stale Late Tool Call Protection**: Every iteration turn is assigned a unique token and a monotonic generation counter. Asynchronous tool calls capture the turn token/generation at execution start and re-verify before and after applying state mutations. If an earlier turn settled, aborted, or was replaced before the tool completed, the mutation is rejected with `WorkflowStaleIterationError`, preventing in-flight calls from mutating a newer run.
- **Signal Identity Verification (Production-Faithful)**: Dispatched turns bind their turn-scoped `AbortSignal`. When tools execute, the dispatcher compares the tool invocation's `signal` with the active binding's `signal`. If a tool call originating from turn A only starts executing after run B has been bound, the mismatched signal identity is detected and rejected with `WorkflowStaleIterationError`, preventing cross-run confusion.
- **Host Context Identity Limitation**:
  > **Important Architecture Limitation**: Pi's `ExtensionToolContext` does not natively pass workflow-specific invocation tokens or run IDs to tool `execute()` handlers. While signal identity protects against cross-turn confusion when distinct `AbortSignal`s are supplied, if the host agent environment does not provide a turn-scoped `AbortSignal` (or passes `undefined`), any tool invocation that *starts after* run B has been bound cannot be distinguished by the engine from a legitimate invocation of run B. To guarantee complete fail-closed isolation across turns, the hosting environment must always supply turn-scoped `AbortSignal`s to `beginIteration()`.
- **Lifecycle Guarantees**: Blocked or terminal runs cannot continue scheduling (`workflow_continue` fails closed). Blocking or completing a run cancels any scheduled wakeup via the scheduler port.
- **Automatic Lifecycle Cleanup**: Active iteration bindings are safely cleared on session reload (`session_start`), session tree switching (`session_tree`), agent settlement (`agent_settled`), and process shutdown (`session_shutdown`).

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

> **Boundary Note**: In accordance with the modular design, `pi-workflow` does not use private `pi-loop` imports or homegrown timer implementations (`setTimeout`/`setInterval`). Integration with the live `pi-loop` scheduler service is owned by Issue #4. Because Pi's `ExtensionToolContext` does not natively carry per-invocation workflow identities, `pi-workflow` enforces in-process exclusive token and generation binding to guarantee fail-closed safety for all model-facing tool calls.

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
} from "pi-workflow";

// Load workflow definition and create immutable snapshot
const def = await loadWorkflow("github-coding");
const registry = new WorkflowRunRegistry();

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
