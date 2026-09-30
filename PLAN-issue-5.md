# Issue #5 implementation plan

Source: https://github.com/thaodangspace/pi-workflow/issues/5. Human-facing command surface for discovering workflow definitions and controlling workflow runs. Build on merged issues #1–#4.

## Implementation Steps

1. Inspect Pi extension command API, extension context in TUI and non-TUI modes, existing registry, snapshot facilities, dispatcher, and scheduler adapter.
2. Implement `WorkflowCommandController` and command parsing in `src/commands.ts`:
   - `/workflow list`: discover workflow definitions with name, description, mode, required capabilities, and active run count in deterministic alphabetical order.
   - `/workflow start <name>`: validate definition and required capabilities, enforce concurrency limits, create durable run, attach scheduler state, trigger initial iteration by mode.
   - `/workflow status`: show active/nonterminal runs in deterministic order with concise fields (run ID, workflow, lifecycle, step, age, next wakeup when known, blocker/completion summary).
   - `/workflow status <run-id>`: show detailed execution state for an individual run.
   - `/workflow pause <run-id>`: persist paused state and cancel/suspend future wakeups without deleting run history; ensure paused runs do not wake automatically.
   - `/workflow resume <run-id>`: revalidate required capabilities and definition compatibility, restore active lifecycle, restore exactly one scheduler task linkage.
   - `/workflow stop <run-id>`: cancel the run, stop its scheduler task, retain durable history, avoid treating cancellation as completed, and ensure strict isolation from other runs and user's ordinary `/loop`.
   - `/workflow reload`: refresh discovered definitions from disk for future starts only; running runs retain immutable snapshots.
   - `/workflow help`: display command usage summary.
3. Strict disambiguation between definition names and run IDs with actionable guidance when mismatched.
4. Non-TUI mode fallback providing clean formatted plain text via outputStream / stdout / stderr when `!ctx.hasUI` or `ctx.mode !== "tui"`.
5. Register `/workflow` command with `pi.registerCommand` in `workflowExtension`.
6. Add unit and integration tests covering parsing, autocomplete, discovery, lifecycle control, concurrency, invalid names/IDs, missing capabilities, scheduler cleanup, snapshot stability, and non-TUI fallback.
7. Verify all acceptance criteria, run `npm test`, `npm run typecheck`, and `git diff --check`.
