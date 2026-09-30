import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildIterationPrompt, deterministicJsonStringify } from "../src/prompt.ts";
import { parseWorkflowContent } from "../src/parser.ts";
import { createWorkflowRun } from "../src/run.ts";
import { createWorkflowSnapshot } from "../src/snapshot.ts";

const SAMPLE_WORKFLOW = `---
name: sample-workflow
description: A sample workflow definition for prompt testing.
mode: self-paced

budget:
  maxTurns: 50
  maxAttempts: 3
  maxDuration: 4h

wakeups:
  default: 5m

requires:
  - loop
---

# Policy Body
This is the policy body of the sample workflow.

## Guidelines
- Follow instructions.
- Transition steps carefully.
`;

describe("Deterministic Iteration Prompt Construction", () => {
  it("sorts JSON keys deterministically regardless of insertion order", () => {
    const obj1 = { z: 1, a: 2, m: { y: "hello", b: "world" }, arr: [{ d: 4, c: 3 }] };
    const obj2 = { a: 2, m: { b: "world", y: "hello" }, z: 1, arr: [{ c: 3, d: 4 }] };

    const json1 = deterministicJsonStringify(obj1);
    const json2 = deterministicJsonStringify(obj2);

    assert.equal(json1, json2);
    assert.equal(
      json1,
      `{\n  "a": 2,\n  "arr": [\n    {\n      "c": 3,\n      "d": 4\n    }\n  ],\n  "m": {\n    "b": "world",\n    "y": "hello"\n  },\n  "z": 1\n}`
    );
  });

  it("produces deterministic prompt matching exact snapshot", () => {
    const def = parseWorkflowContent(SAMPLE_WORKFLOW, {
      path: "/test/sample.md",
      scope: "project",
    });

    const snapshot = createWorkflowSnapshot(def, {
      snapshotId: "snap-sample-001",
      createdAt: "2026-03-30T00:00:00.000Z",
    });

    const run = createWorkflowRun({
      id: "wfrun-sample-12345",
      snapshot,
      initialStep: "ANALYZING",
      initialData: {
        taskName: "Issue 3",
        branch: "feature-branch",
        priority: 1,
      },
      createdAt: 1700000000000,
    });

    const prompt1 = buildIterationPrompt({ run });
    const prompt2 = buildIterationPrompt({ run });

    // Deterministic equality
    assert.equal(prompt1, prompt2);

    const expected = `# Workflow Execution: sample-workflow
- Run ID: wfrun-sample-12345
- Definition: sample-workflow (schema v1)
- Source: /test/sample.md

You are executing an iteration turn of the workflow "sample-workflow".
Interact with the workflow engine using the following model tools:
- \`workflow_get_context\`: Inspect current iteration state, counters, limits, and capabilities.
- \`workflow_transition\`: Atomically advance to another step and optionally update run data.
- \`workflow_continue\`: Request the next wakeup for this run via named policy or bounded delay.
- \`workflow_block\`: Halt execution if blocked by external conditions or requiring human action.
- \`workflow_complete\`: Submit completion summary and evidence to complete or verify the run.

## Workflow Policy
# Policy Body
This is the policy body of the sample workflow.

## Guidelines
- Follow instructions.
- Transition steps carefully.

## Current Run State
- Lifecycle: active
- Current Step: ANALYZING
- Turn: 0 / 50
- Attempts: 0 / 3
- Max Duration: 4h
- Data:
\`\`\`json
{
  "branch": "feature-branch",
  "priority": 1,
  "taskName": "Issue 3"
}
\`\`\`

## Required Action
You must choose and execute one of the following workflow actions during this turn:
1. \`workflow_transition({ toStep: "...", data?: { ... }, reason?: "..." })\` to advance step.
2. \`workflow_continue({ delay?: "...", wakeupName?: "...", reason?: "..." })\` to schedule the next iteration.
3. \`workflow_block({ reason: "...", requiresHuman?: boolean, data?: { ... } })\` if blocked.
4. \`workflow_complete({ summary: "...", evidence?: [...], data?: { ... } })\` when finished.`;

    assert.equal(prompt1, expected);
  });
});
