import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractFrontmatterAndBody,
  parseWorkflowContent,
} from "../src/parser.ts";
import { parseDuration, formatDuration } from "../src/duration.ts";
import { WorkflowValidationError } from "../src/types.ts";
import { MAX_WORKFLOW_FILE_SIZE_BYTES } from "../src/constants.ts";

describe("Workflow Parser & Spec v1", () => {
  describe("Duration Utilities", () => {
    it("parses standard duration strings to milliseconds", () => {
      assert.equal(parseDuration("30s"), 30000);
      assert.equal(parseDuration("5m"), 300000);
      assert.equal(parseDuration("8h"), 28800000);
      assert.equal(parseDuration("1d"), 86400000);
      assert.equal(parseDuration("500ms"), 500);
    });

    it("parses multi-part duration strings", () => {
      assert.equal(parseDuration("1h 30m"), 5400000);
      assert.equal(parseDuration("2 days 4 hours"), 187200000);
    });

    it("accepts numeric milliseconds directly", () => {
      assert.equal(parseDuration(15000), 15000);
      assert.equal(parseDuration(0), 0);
    });

    it("rejects invalid or negative durations", () => {
      assert.throws(() => parseDuration("invalid"), /Invalid duration format/);
      assert.throws(() => parseDuration(-10), /must be a non-negative finite number/);
      assert.throws(() => parseDuration(""), /must be a non-empty string/);
    });

    it("formats duration back to readable string", () => {
      assert.equal(formatDuration(30000), "30s");
      assert.equal(formatDuration(300000), "5m");
      assert.equal(formatDuration(28800000), "8h");
      assert.equal(formatDuration(86400000), "1d");
    });
  });

  describe("Frontmatter & Body Extraction", () => {
    it("extracts frontmatter and preserves body byte-for-byte", () => {
      const markdown = `---
name: test-wf
description: A test workflow.
mode: self-paced
---

# Policy Header

  Indented line 1
  Indented line 2

Trailing whitespace:   
`;
      const { yamlString, body } = extractFrontmatterAndBody(markdown, "test.md");
      assert.match(yamlString, /name: test-wf/);

      // Verify body is preserved byte-for-byte after delimiter line
      const expectedBody = `\n# Policy Header\n\n  Indented line 1\n  Indented line 2\n\nTrailing whitespace:   \n`;
      assert.equal(body, expectedBody);
    });

    it("handles UTF-8 BOM transparently", () => {
      const markdown = `\uFEFF---
name: bom-wf
description: BOM workflow.
mode: self-paced
---
Body text`;
      const { yamlString, body } = extractFrontmatterAndBody(markdown, "bom.md");
      assert.match(yamlString, /name: bom-wf/);
      assert.equal(body, "Body text");
    });

    it("handles Windows CRLF line endings cleanly while preserving CRLF in body", () => {
      const markdown = "---\r\nname: crlf-wf\r\ndescription: CRLF.\r\nmode: self-paced\r\n---\r\n\r\n# Windows Body\r\nLine 2\r\n";
      const { yamlString, body } = extractFrontmatterAndBody(markdown, "crlf.md");
      assert.match(yamlString, /name: crlf-wf/);
      assert.equal(body, "\r\n# Windows Body\r\nLine 2\r\n");
    });

    it("preserves embedded horizontal rules (---) inside Markdown body", () => {
      const markdown = `---
name: hr-wf
description: Workflow with horizontal rule.
mode: self-paced
---
# Section 1

---

# Section 2
`;
      const { body } = extractFrontmatterAndBody(markdown, "hr.md");
      assert.equal(body, "# Section 1\n\n---\n\n# Section 2\n");
    });

    it("handles empty body after closing delimiter", () => {
      const markdown = `---
name: empty-body
description: Empty body workflow.
mode: self-paced
---`;
      const { body } = extractFrontmatterAndBody(markdown, "empty.md");
      assert.equal(body, "");
    });

    it("throws if frontmatter does not start with ---", () => {
      const markdown = `# Just markdown\nNo frontmatter`;
      assert.throws(
        () => extractFrontmatterAndBody(markdown, "bad.md"),
        (err: unknown) => {
          assert(err instanceof WorkflowValidationError);
          assert.match(err.message, /must start with YAML frontmatter delimiter/);
          assert.equal(err.path, "bad.md");
          return true;
        }
      );
    });

    it("throws if frontmatter is not closed with ---", () => {
      const markdown = `---
name: unclosed
description: Missing closing delimiter.`;
      assert.throws(
        () => extractFrontmatterAndBody(markdown, "unclosed.md"),
        (err: unknown) => {
          assert(err instanceof WorkflowValidationError);
          assert.match(err.message, /missing closing "---" delimiter/);
          return true;
        }
      );
    });
  });

  describe("Workflow Spec v1 Schema Validation", () => {
    const validFullDoc = `---
name: github-coding
description: Claim and complete ready GitHub coding tasks.
mode: self-paced

concurrency:
  maxRuns: 1

budget:
  maxTurns: 100
  maxDuration: 8h
  maxAttempts: 3
  maxCost: 25.50

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
  verifierPrompt: Verify the fix thoroughly.
  maxVerificationAttempts: 2

metadata:
  team: engineering
  tier: 1
---

# Policy Guidance
Autonomous agent iteration policy.
`;

    it("parses valid full workflow specification into typed WorkflowDefinitionV1", () => {
      const def = parseWorkflowContent(validFullDoc, {
        path: "/path/to/github-coding.md",
        scope: "project",
        relativePath: ".pi/workflows/github-coding.md",
      });

      assert.equal(def.schemaVersion, "v1");
      assert.equal(def.name, "github-coding");
      assert.equal(def.description, "Claim and complete ready GitHub coding tasks.");
      assert.equal(def.mode, "self-paced");
      assert.equal(def.concurrency.maxRuns, 1);
      assert.equal(def.budget.maxTurns, 100);
      assert.equal(def.budget.maxDuration, "8h");
      assert.equal(def.budget.maxDurationMs, 28800000);
      assert.equal(def.budget.maxAttempts, 3);
      assert.equal(def.budget.maxCost, 25.5);
      assert.equal(def.wakeups.default, "5m");
      assert.equal(def.wakeups.defaultMs, 300000);
      assert.equal(def.wakeups.named?.idle, "15m");
      assert.equal(def.wakeups.namedMs?.idle, 900000);
      assert.equal(def.wakeups.named?.retry, "1m");
      assert.equal(def.wakeups.namedMs?.retry, 60000);
      assert.deepEqual(def.requires, ["loop", "tmux"]);
      assert.equal(def.completion?.requireSummary, true);
      assert.equal(def.completion?.requireEvidence, true);
      assert.equal(def.completion?.verify, true);
      assert.equal(def.completion?.verifierPrompt, "Verify the fix thoroughly.");
      assert.equal(def.completion?.maxVerificationAttempts, 2);
      assert.deepEqual(def.metadata, { team: "engineering", tier: 1 });
      assert.equal(def.body, "\n# Policy Guidance\nAutonomous agent iteration policy.\n");
      assert.equal(def.source.scope, "project");
      assert.equal(def.source.relativePath, ".pi/workflows/github-coding.md");
      assert(typeof def.source.sha256 === "string" && def.source.sha256.length === 64);
    });

    it("parses minimal valid definition with default values", () => {
      const minimalDoc = `---
name: minimal-flow
description: Minimal workflow.
mode: self-paced
---
Body content`;
      const def = parseWorkflowContent(minimalDoc, {
        path: "/path/to/minimal.md",
        scope: "user",
      });

      assert.equal(def.name, "minimal-flow");
      assert.equal(def.mode, "self-paced");
      assert.equal(def.concurrency.maxRuns, 1);
      assert.deepEqual(def.budget, {});
      assert.deepEqual(def.wakeups, {});
      assert.deepEqual(def.requires, []);
      assert.equal(def.completion, undefined);
      assert.equal(def.body, "Body content");
    });

    it("parses schedule configuration for interval and cron modes", () => {
      const cronDoc = `---
name: nightly-audit
description: Run nightly security audit.
mode: cron
schedule:
  cron: "0 2 * * *"
  timeZone: "America/New_York"
---
Audit body`;
      const def = parseWorkflowContent(cronDoc, {
        path: "cron.md",
        scope: "project",
      });
      assert.equal(def.mode, "cron");
      assert.equal(def.schedule?.cron, "0 2 * * *");
      assert.equal(def.schedule?.timeZone, "America/New_York");
    });

    it("rejects unknown top-level frontmatter fields", () => {
      const doc = `---
name: typo-wf
description: Has typo in budget.
mode: self-paced
budgets:
  maxTurns: 10
---
Body`;
      assert.throws(
        () => parseWorkflowContent(doc, { path: "typo.md", scope: "project" }),
        (err: unknown) => {
          assert(err instanceof WorkflowValidationError);
          assert.equal(err.field, "budgets");
          assert.match(err.message, /Unexpected field "budgets"/);
          return true;
        }
      );
    });

    it("rejects missing or empty required fields", () => {
      // Missing name
      assert.throws(
        () =>
          parseWorkflowContent(
            `---\ndescription: test\nmode: self-paced\n---\nbody`,
            { path: "f.md", scope: "project" }
          ),
        /Field "name" is required/
      );

      // Missing description
      assert.throws(
        () =>
          parseWorkflowContent(
            `---\nname: test\nmode: self-paced\n---\nbody`,
            { path: "f.md", scope: "project" }
          ),
        /Field "description" is required/
      );

      // Empty description
      assert.throws(
        () =>
          parseWorkflowContent(
            `---\nname: test\ndescription: "   "\nmode: self-paced\n---\nbody`,
            { path: "f.md", scope: "project" }
          ),
        /Field "description" cannot be empty/
      );

      // Missing mode
      assert.throws(
        () =>
          parseWorkflowContent(
            `---\nname: test\ndescription: test\n---\nbody`,
            { path: "f.md", scope: "project" }
          ),
        /Field "mode" is required/
      );
    });

    it("rejects invalid name formats", () => {
      const invalidNames = [
        "UPPERCASE",
        "has spaces",
        "-starts-with-dash",
        "has/slash",
        "has..dots",
        "a".repeat(65),
      ];

      for (const badName of invalidNames) {
        assert.throws(
          () =>
            parseWorkflowContent(
              `---\nname: "${badName}"\ndescription: desc\nmode: self-paced\n---\nbody`,
              { path: "f.md", scope: "project" }
            ),
          /Field "name" must consist of 1-64 lowercase alphanumeric/,
          `Expected rejection for name: ${badName}`
        );
      }
    });

    it("rejects invalid modes", () => {
      assert.throws(
        () =>
          parseWorkflowContent(
            `---\nname: test\ndescription: desc\nmode: nonexistent-mode\n---\nbody`,
            { path: "f.md", scope: "project" }
          ),
        /Field "mode" must be one of/
      );
    });

    it("rejects invalid concurrency values", () => {
      assert.throws(
        () =>
          parseWorkflowContent(
            `---\nname: test\ndescription: desc\nmode: self-paced\nconcurrency:\n  maxRuns: 0\n---\nbody`,
            { path: "f.md", scope: "project" }
          ),
        /Field "concurrency.maxRuns" must be an integer >= 1/
      );
    });

    it("rejects invalid budget values", () => {
      assert.throws(
        () =>
          parseWorkflowContent(
            `---\nname: test\ndescription: desc\nmode: self-paced\nbudget:\n  maxTurns: -5\n---\nbody`,
            { path: "f.md", scope: "project" }
          ),
        /Field "budget.maxTurns" must be an integer >= 1/
      );

      assert.throws(
        () =>
          parseWorkflowContent(
            `---\nname: test\ndescription: desc\nmode: self-paced\nbudget:\n  maxDuration: not-a-duration\n---\nbody`,
            { path: "f.md", scope: "project" }
          ),
        /Invalid duration format/
      );
    });

    it("rejects invalid or duplicate capabilities in requires", () => {
      assert.throws(
        () =>
          parseWorkflowContent(
            `---\nname: test\ndescription: desc\nmode: self-paced\nrequires:\n  - loop\n  - loop\n---\nbody`,
            { path: "f.md", scope: "project" }
          ),
        /Duplicate capability "loop" in field "requires"/
      );
    });

    it("rejects malformed YAML syntax with line/field details", () => {
      const malformedYaml = `---
name: test
description: [unclosed array
mode: self-paced
---
body`;
      assert.throws(
        () =>
          parseWorkflowContent(malformedYaml, { path: "broken.md", scope: "project" }),
        (err: unknown) => {
          assert(err instanceof WorkflowValidationError);
          assert.match(err.message, /Malformed YAML frontmatter/);
          assert.equal(err.path, "broken.md");
          return true;
        }
      );
    });

    it("rejects YAML frontmatter that is not a mapping", () => {
      const arrayYaml = `---
- item1
- item2
---
body`;
      assert.throws(
        () => parseWorkflowContent(arrayYaml, { path: "array.md", scope: "project" }),
        /Frontmatter must be a YAML mapping/
      );
    });

    it("rejects file content exceeding the maximum file size limit", () => {
      const largeContent =
        `---\nname: huge-flow\ndescription: Huge\nmode: self-paced\n---\n` +
        "x".repeat(MAX_WORKFLOW_FILE_SIZE_BYTES + 100);

      assert.throws(
        () =>
          parseWorkflowContent(
            largeContent,
            { path: "huge.md", scope: "project" },
            { maxFileSize: MAX_WORKFLOW_FILE_SIZE_BYTES }
          ),
        /exceeds maximum limit/
      );
    });
  });
});
