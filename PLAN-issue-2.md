# Issue #2 implementation plan

Source: https://github.com/thaodangspace/pi-workflow/issues/2. Build on merged issue #1, no scheduler or workflow prompt executor.

1. Read Pi session persistence/branch APIs from installed docs/extensions.md and related examples, and current issue. Model versioned WorkflowRun with immutable definition snapshot (including body or recoverable equivalent), lifecycle separate from step, bounded JSON data/evidence, timestamps, counters, optional scheduler linkage.
2. Implement a registry with create, bounded update/transition, block, complete, pause, resume, cancel and explicit invalid-transition/concurrency errors. Stable IDs; enforce maxRuns for nonterminal runs; document blocked/paused occupancy decision.
3. Persist append-only versioned Pi session entries, reconstruct from active branch only; validate and diagnose malformed/unsupported entries, idempotent replay, no accidental duplicate creates. Provide explicit reconstruction/refresh for branch changes and reload.
4. Tests with production-faithful fake Pi session manager/entry tree for lifecycle, concurrency, JSON bounds, replay, branch isolation, bad entries, snapshot stability and reload; run npm test, typecheck and diff check. Document integration/API and risks.

Child owns code/docs/tests except this plan. Do not push/create PR/merge. No private pi-loop imports; do not implement scheduling, adapters or arbitrary persisted project files.
