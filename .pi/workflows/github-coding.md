---
name: github-coding
description: Claim ready GitHub issues and drive each one through implementation, independent verification, PR/CI, review, merge, and finalization.
mode: self-paced

concurrency:
  maxRuns: 1

budget:
  maxTurns: 120
  maxDuration: 8h
  maxAttempts: 6
  onExhaustion: block

wakeups:
  default: 5m
  min: 1m
  max: 1h
  named:
    idle: 15m
    worker: 2m
    ci: 5m
    review: 15m
    retry: 2m

requires:
  - loop
  - name: github
    version: 1
    features:
      - issues
      - pull-requests
      - ci
      - reviews
      - merge
      - project-state
  - name: worker-runtime
    version: 1
    features:
      - isolated-worktree
      - spawn
      - inspect
      - verify

completion:
  requireSummary: true
  requireEvidence: true
  verify: true
  maxVerificationAttempts: 3
  returnStep: FIXING_REVIEW
  onRejectionExhausted: block
---

# github-coding — reference workflow policy

This Markdown is **policy and guidance**, not an executable state machine. The
durable runtime state (current step, counters, issue/branch/PR identifiers, and
effect checkpoints) lives in the workflow **run record**. Advance it explicitly
with the generic workflow tools.

> **Providers are required and are not shipped here.** This definition needs an
> executable `github` provider and an executable `worker-runtime` provider
> (for example a `pi-tmux`-backed adapter) registered under those logical
> capability names. This file ships no real GitHub or tmux adapter, and no
> ordinary test in this repository performs a live `gh`, `tmux`, `git push`, or
> merge. When a provider is absent, stale, or incompatible, provider calls and
> the `/workflow start` preflight fail closed with a clear error. See the
> README for the fake-provider integration and for opt-in real-provider smoke
> instructions.

## Concurrency: MAX runs limits concurrent runs, not queue items

`concurrency.maxRuns: 1` means **one run of this workflow executes at a time**.
It is **not** a per-issue queue limit. A single run claims issues **one at a
time** and may process many issues before it completes. Only terminal runs
(`completed` / `cancelled`) release the concurrency slot.

## Steps (workflow data)

The engine starts every run at step `INITIAL`. Drive the workflow through these
workflow-defined steps. They are durable data, not engine lifecycle states.

```
INITIAL -> IDLE -> CLAIMING -> IMPLEMENTING -> VERIFYING_IMPLEMENTATION
        -> OPENING_PR -> WAITING_CI -> REVIEWING -> FIXING_REVIEW -> WAITING_CI
        -> MERGING -> FINALIZING -> COMPLETED
                           \-> BLOCKED (diagnosable policy stop)
```

- `INITIAL`: first iteration. Initialise the per-run budgets below in durable
  run data, then transition to `IDLE`.
- `IDLE`: claim the next ready issue while implementation budget remains, or
  submit completion when the queue/batch is exhausted.
- `CLAIMING`: claim exactly one issue and record its identifiers.
- `IMPLEMENTING`: create one isolated worktree and run the coding worker.
- `VERIFYING_IMPLEMENTATION`: independently verify the authoritative commit.
- `OPENING_PR`: push the branch and open (or find) the pull request.
- `WAITING_CI`: wait for CI on the PR head; re-run CI after each fix.
- `REVIEWING`: obtain an independent review and record its decision.
- `FIXING_REVIEW`: run a bounded fix worker for requested changes.
- `MERGING`: merge the reviewed, green PR at the expected head SHA.
- `FINALIZING`: update the issue/project state and clean up the worktree.
- `COMPLETED`: workflow-defined completion marker for the current issue; this
  is **not** engine-completed. The engine only records completion after
  `workflow_complete`/`workflow_verify` accept.
- `BLOCKED`: use `workflow_block` for missing permissions, an uncertain
  irreversible action, a failed independent verification, or exhausted
  attempts. A real block pauses automatic wakeups.

## Durable run data (bounded JSON)

Persist only identifiers and small records — never credentials, tokens, logs,
diffs, or raw provider payloads:

- `issue`: `{ repo, number, title }` and `claimToken`.
- `worker`: `{ worktreeId, branch, baseSha, workerId }`.
- `implementation`: `{ headSha, commitVerified: boolean }`.
- `pr`: `{ number, headBranch, headSha, ciRunId, ciStatus }`.
- `review`: `{ revision, attempt, decision, findings }`.
- `effects`: effect keys are durable run effects, not run data.
- `budget`: implementation/review sub-budgets described below.
- `nextAction`: a short human-readable pointer to the next step.

## Bounded implementation/review sub-budgets (durable run data)

The engine-wide `budget` is a hard ceiling. Track per-issue work inside durable
run data so a single issue cannot consume the whole run:

```json
{ "implBudget": { "attempts": 0, "limit": 3 },
  "reviewBudget": { "rounds": 0, "limit": 2 } }
```

Increment `implBudget.attempts` before each implementation worker run and
`reviewBudget.rounds` before each review-fix round. When a sub-budget is
exhausted, `workflow_block` with `category: "human-required"` rather than
looping forever.

## External waits (named wakeups)

Finish each waiting iteration with `workflow_continue`:

- `worker` (2m) after spawning a worker,
- `ci` (5m) while waiting on CI,
- `review` (15m) while waiting on a human/independent review,
- `retry` (2m) for a retryable block,
- `idle` (15m) when the ready queue is empty before re-checking.

## Effect protocol (non-idempotent actions)

Every mutating provider operation must be preceded by a durable checkpoint:

1. `workflow_effect_begin({ key, kind, inputSummary })` with a **stable key**
   derived from the immutable target, for example:
   - `claim:<owner/repo>:<issueNumber>`
   - `push:<issueNumber>:<headSha>`
   - `pr:<issueNumber>:<headBranch>`
   - `merge:<prNumber>:<expectedHeadSha>`
   - `finalize:<issueNumber>:<prNumber>`
2. If begin returns `already_committed`, **do not repeat** the action; use the
   recorded result.
3. Otherwise call `workflow_provider_call` for the mutating operation with that
   `effectKey`. The seam refuses a mutating call unless the checkpoint is
   `started`, non-ambiguous, and of the matching kind; on success it commits the
   checkpoint with the observed result summary.
4. Never reuse a committed key for a new revision. Build a new key from the new
   immutable target (e.g. the new head SHA).

There is **no exactly-once guarantee** from a checkpoint alone: if the process
dies after the remote mutation but before the checkpoint commits, the effect is
**ambiguous** on reload. In that case, inspect external reality first, then
`workflow_effect_reconcile({ key, resolution, reason })`:

- `committed` when the external object exists (record its identifiers),
- `aborted` when it does not,
- `retryable` only when you have proof no mutation happened.

True replay safety therefore also requires provider-side idempotency or
compare-and-set on the action itself (unique claim marker, PR lookup by
deterministic head+base, push SHA verification, merge state lookup).

## Worker boundary

- The **main workflow** owns all GitHub credentials and every GitHub mutation.
- A worker gets only an isolated worktree plus code/test/commit permissions.
  It **cannot** claim work, push, open PRs, or merge.
- Create exactly one isolated worker/worktree per claimed issue; reuse it for
  that issue's fix rounds and remove it during finalization.
- A worker's self-report is **not** evidence. Before advancing, independently
  verify the authoritative worktree/commit (ancestry, expected branch, tests)
  via the worker-runtime/verifier operations.

## Recovery on resume

If a run resumes with an ambiguous effect, the engine dispatches a recovery
prompt instead of a step prompt, and transitions/completion fail closed until
the effect is reconciled. Handle these cases explicitly:

- **Ambiguous claim**: read the issue's current claim marker. Matching token →
  reconcile `committed`; a different owner → `workflow_block`; provably
  unclaimed → retryable claim with a new conditional attempt.
- **PR already exists while in `OPENING_PR`**: find the PR by deterministic
  issue + head + base. Exactly one match → reconcile `committed` and skip
  creation; multiple/no confident match → block.
- **Worker exited with a valid commit**: inspect the worktree/commit, verify it
  independently, and continue from `VERIFYING_IMPLEMENTATION` rather than
  discarding worker state or respawning blindly.
- **PR already merged while in `MERGING`**: query the merge/state, reconcile the
  merge effect as `committed` with the observed merge SHA, and finalize; never
  issue a second merge.

## Completion

At `FINALIZING` completion: finish the issue/project update, remove the
worktree, then `workflow_complete` with a summary and concrete evidence (issue
and PR references, the verified commit SHA, and the CI result). Because
`completion.verify: true`, an independent verifier must then accept with
`workflow_verify`. If the queue still has ready issues and budget remains,
return to `IDLE`; otherwise submit completion for the run.
