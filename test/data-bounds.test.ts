import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BLOCKER_REASON_LENGTH,
  MAX_COMPLETION_SUMMARY_LENGTH,
  MAX_DATA_DEPTH,
  MAX_DATA_KEY_LENGTH,
  MAX_DATA_STRING_LENGTH,
  MAX_EVIDENCE_ITEMS,
  MAX_RUN_DATA_BYTES,
  MAX_RUN_ID_LENGTH,
  MAX_STEP_NAME_LENGTH,
} from "../src/constants.ts";
import {
  validateBlockerInfo,
  validateCompletionInfo,
  validateEvidence,
  validateJsonValue,
  validateRunData,
  validateRunId,
  validateStepName,
} from "../src/data-bounds.ts";
import { WorkflowDataBoundsError } from "../src/types.ts";

describe("JSON Safety & Workflow Data Bounds", () => {
  it("accepts valid JSON primitives, arrays, and nested structures", () => {
    const valid = {
      str: "hello world",
      num: 123.45,
      bool: true,
      nil: null,
      arr: [1, "two", false, null, { nested: 1 }],
      obj: { a: { b: { c: "deep" } } },
    };

    const out = validateJsonValue(valid);
    assert.deepEqual(out, valid);
  });

  it("rejects non-finite numbers (NaN, Infinity)", () => {
    assert.throws(
      () => validateJsonValue({ bad: NaN }),
      (err) => err instanceof WorkflowDataBoundsError && err.message.includes("Non-finite")
    );
    assert.throws(
      () => validateJsonValue({ bad: Infinity }),
      (err) => err instanceof WorkflowDataBoundsError && err.message.includes("Non-finite")
    );
    assert.throws(
      () => validateJsonValue({ bad: -Infinity }),
      (err) => err instanceof WorkflowDataBoundsError && err.message.includes("Non-finite")
    );
  });

  it("rejects unsupported JS types: functions, symbols, BigInt, undefined", () => {
    assert.throws(
      () => validateJsonValue({ fn: () => {} }),
      (err) => err instanceof WorkflowDataBoundsError
    );
    assert.throws(
      () => validateJsonValue({ sym: Symbol("test") }),
      (err) => err instanceof WorkflowDataBoundsError
    );
    assert.throws(
      () => validateJsonValue({ big: BigInt(9007199254740991) }),
      (err) => err instanceof WorkflowDataBoundsError
    );
    assert.throws(
      () => validateJsonValue({ undef: undefined }),
      (err) => err instanceof WorkflowDataBoundsError
    );
  });

  it("detects and rejects circular references in objects and arrays", () => {
    const cyclicObj: any = { a: 1 };
    cyclicObj.self = cyclicObj;

    assert.throws(
      () => validateJsonValue(cyclicObj),
      (err) => err instanceof WorkflowDataBoundsError && err.message.includes("Circular reference")
    );

    const cyclicArr: any[] = [1, 2];
    cyclicArr.push(cyclicArr);

    assert.throws(
      () => validateJsonValue(cyclicArr),
      (err) => err instanceof WorkflowDataBoundsError && err.message.includes("Circular reference")
    );
  });

  it("enforces object key length limit", () => {
    const longKey = "k".repeat(MAX_DATA_KEY_LENGTH + 1);
    assert.throws(
      () => validateJsonValue({ [longKey]: "value" }),
      (err) => err instanceof WorkflowDataBoundsError && err.limit === MAX_DATA_KEY_LENGTH
    );
  });

  it("enforces maximum nesting depth limit", () => {
    let deep: any = { value: "leaf" };
    for (let i = 0; i < MAX_DATA_DEPTH + 1; i++) {
      deep = { child: deep };
    }

    assert.throws(
      () => validateJsonValue(deep),
      (err) => err instanceof WorkflowDataBoundsError && err.limit === MAX_DATA_DEPTH
    );
  });

  it("enforces maximum scalar string length limit", () => {
    const longString = "s".repeat(MAX_DATA_STRING_LENGTH + 1);
    assert.throws(
      () => validateJsonValue({ val: longString }),
      (err) => err instanceof WorkflowDataBoundsError && err.limit === MAX_DATA_STRING_LENGTH
    );
  });

  it("enforces max serialized payload size for run data", () => {
    const normalData = { greeting: "hi" };
    assert.deepEqual(validateRunData(normalData), normalData);

    // Build payload exceeding MAX_RUN_DATA_BYTES
    const bigArray: string[] = [];
    for (let i = 0; i < 20; i++) {
      bigArray.push("a".repeat(4000));
    }
    assert.throws(
      () => validateRunData({ items: bigArray }),
      (err) => err instanceof WorkflowDataBoundsError && err.limit === MAX_RUN_DATA_BYTES
    );
  });

  it("validates evidence items and enforces count limits", () => {
    const validEvidence = [
      { type: "pr", description: "PR #123 opened", url: "https://example.com" },
      { type: "test", description: "Unit tests passing", data: { count: 42 } },
    ];
    assert.equal(validateEvidence(validEvidence).length, 2);

    // Rejects non-array
    assert.throws(() => validateEvidence("not an array"), WorkflowDataBoundsError);

    // Rejects item missing type or description
    assert.throws(() => validateEvidence([{ type: "" }]), WorkflowDataBoundsError);
    assert.throws(() => validateEvidence([{ type: "pr", description: "" }]), WorkflowDataBoundsError);

    // Rejects count exceeding MAX_EVIDENCE_ITEMS
    const tooMany = Array.from({ length: MAX_EVIDENCE_ITEMS + 1 }, (_, i) => ({
      type: "item",
      description: `Item ${i}`,
    }));
    assert.throws(
      () => validateEvidence(tooMany),
      (err) => err instanceof WorkflowDataBoundsError && err.limit === MAX_EVIDENCE_ITEMS
    );
  });

  it("validates blocker info and enforces reason length limit", () => {
    const validBlocker = validateBlockerInfo({
      reason: "Waiting for human confirmation",
      requiresHuman: true,
    });
    assert.equal(validBlocker.reason, "Waiting for human confirmation");
    assert.equal(validBlocker.requiresHuman, true);
    assert(validBlocker.blockedAt > 0);

    // Rejects empty reason
    assert.throws(() => validateBlockerInfo({ reason: "  " }), WorkflowDataBoundsError);

    // Rejects excessively long reason
    const longReason = "r".repeat(MAX_BLOCKER_REASON_LENGTH + 1);
    assert.throws(
      () => validateBlockerInfo({ reason: longReason }),
      (err) => err instanceof WorkflowDataBoundsError && err.limit === MAX_BLOCKER_REASON_LENGTH
    );
  });

  it("validates completion info and enforces summary length limit", () => {
    const validCompletion = validateCompletionInfo({
      summary: "Goal achieved successfully",
      evidence: [{ type: "commit", description: "Merged main" }],
    });
    assert.equal(validCompletion.summary, "Goal achieved successfully");
    assert.equal(validCompletion.evidence.length, 1);

    // Rejects empty summary
    assert.throws(() => validateCompletionInfo({ summary: "" }), WorkflowDataBoundsError);

    // Rejects summary exceeding max length
    const longSummary = "s".repeat(MAX_COMPLETION_SUMMARY_LENGTH + 1);
    assert.throws(
      () => validateCompletionInfo({ summary: longSummary }),
      (err) => err instanceof WorkflowDataBoundsError && err.limit === MAX_COMPLETION_SUMMARY_LENGTH
    );
  });

  it("validates step name bounds and rejects control characters", () => {
    assert.equal(validateStepName("INITIAL"), "INITIAL");
    assert.equal(validateStepName("  WAITING_FOR_CI  "), "WAITING_FOR_CI");

    assert.throws(() => validateStepName(""), WorkflowDataBoundsError);
    assert.throws(() => validateStepName("step\x00bad"), WorkflowDataBoundsError);
    assert.throws(() => validateStepName("step\nbad"), WorkflowDataBoundsError);

    const longStep = "s".repeat(MAX_STEP_NAME_LENGTH + 1);
    assert.throws(
      () => validateStepName(longStep),
      (err) => err instanceof WorkflowDataBoundsError && err.limit === MAX_STEP_NAME_LENGTH
    );
  });

  it("validates run ID format and length", () => {
    assert.equal(validateRunId("run-123_abc"), "run-123_abc");

    assert.throws(() => validateRunId(""), WorkflowDataBoundsError);
    assert.throws(() => validateRunId("bad run id"), WorkflowDataBoundsError);
    assert.throws(() => validateRunId("-invalid-prefix"), WorkflowDataBoundsError);

    const longId = "r".repeat(MAX_RUN_ID_LENGTH + 1);
    assert.throws(
      () => validateRunId(longId),
      (err) => err instanceof WorkflowDataBoundsError && err.limit === MAX_RUN_ID_LENGTH
    );
  });
});
