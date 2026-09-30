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

## Programmatic API

```typescript
import {
  loadWorkflows,
  loadWorkflow,
  createWorkflowSnapshot,
} from "pi-workflow";

// Load all discovered workflows
const { workflows, diagnostics, shadowed } = await loadWorkflows();

// Load single workflow fresh from disk
const def = await loadWorkflow("github-coding");

if (def) {
  // Create an immutable snapshot for durable execution
  const snapshot = createWorkflowSnapshot(def);
  console.log(`Snapshot ID: ${snapshot.snapshotId}`);
}
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
