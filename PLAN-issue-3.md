# Issue #3 implementation plan

Source: https://github.com/thaodangspace/pi-workflow/issues/3; depends on merged #2. Issue #4 will integrate actual pi-loop scheduler.

1. Read installed Pi extension docs and relevant model-tool/dispatch/session examples plus current issue. Define exclusive ephemeral iteration binding with generation/token ownership so stale asynchronous tool calls never mutate a newer run. Clear safely on settle/abort/replacement/session_start/session_tree and errors.
2. Register typed model-facing `workflow_get_context`, `workflow_transition`, `workflow_continue`, `workflow_block`, `workflow_complete` tools. Validate inputs; tools fail closed outside an active iteration, never take raw run IDs or expose loopTaskId. Provide trusted dispatcher API with explicit run ID and scheduler port; continue should resolve named/default/explicit bounded delay and call only current run's port, not duplicate timer implementation.
3. Context includes run ID/name, lifecycle/step/data, counters and remaining budget, definition snapshot/version/source, capability availability. Build deterministic prompt (engine preamble, policy body, state, required next action). Persist transition via #2 registry before subsequent dispatch. Respect blocked/terminal states, verification metadata and evidence.
4. Tests for exclusivity, stale late tool calls, cleanup/reconstruction, lifecycle failures, validation, scheduler port invocation and deterministic prompt snapshots; full tests/typecheck/diff check, README docs. Child owns implementation/docs/tests except this plan; may commit but not push/PR/merge or delegate.

Boundary: no private pi-loop imports or homegrown timers; issue #4 owns real pi-loop service integration. If Pi's tool context cannot carry per-invocation identity, explicitly document fail-closed limits and test realistic dispatch model rather than claiming unsupported safety.
