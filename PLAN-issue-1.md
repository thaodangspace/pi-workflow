# Issue #1 implementation plan

Source: https://github.com/thaodangspace/pi-workflow/issues/1 (read current issue before coding). Repository starts with an empty main; bootstrap only the minimal TypeScript/package/test infrastructure needed for this issue, not the unrelated engine or scheduler.

1. Read Pi extension docs (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`) and linked relevant docs/examples, and inspect issue #1. Define a versioned typed `WorkflowDefinitionV1` with explicit scheduling, concurrency, budgets, wakeups, required capabilities, optional completion/verification policy, Markdown body and source identity/snapshot.
2. Implement safe YAML-frontmatter parsing and strict actionable validation with path and field, documented max file size, no arbitrary code evaluation. Preserve body byte-for-byte after frontmatter boundary. Define deterministic discovery in project `.pi/workflows/*.md` and documented optional user directory, same-scope duplicate rejection and project-over-user precedence. Re-read on each new load/start; snapshots are immutable copies for runs.
3. Add unit tests for valid/malformed YAML, invalid/missing fields, duplicates, precedence, size cap, body preservation and snapshot identity; README with spec/example and execution instructions.
4. Run tests/typecheck with actual exit codes, inspect diff for scope/security. Deliver code on issue-1 branch, a concise report with changed files, exact commands/results and limitations. Do not push, create PR or merge; parent handles review and GitHub actions. Do not modify this plan file.

Scope boundary: do not implement runtime registry, transitions, scheduling, GitHub-specific workflow logic, or private pi-loop imports. If issue #11 bootstrap requirements are essential, implement only minimal supporting scaffolding and explain the limitation.
