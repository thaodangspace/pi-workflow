---
name: example
description: Example self-paced workflow demonstrating Workflow Spec v1.
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

# Example Workflow Policy

This is the prompt and policy body for the example workflow.
It is preserved byte-for-byte after the frontmatter boundary.

## Instructions

1. Inspect the task.
2. Advance state according to policy.
3. Submit completion claim with evidence when done.
