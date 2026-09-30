import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadWorkflows,
  loadWorkflow,
  loadWorkflowFromFile,
} from "../src/loader.ts";
import { WorkflowValidationError } from "../src/types.ts";

describe("Workflow Loader & Discovery", () => {
  let tempRoot: string;
  let projectWorkflowsDir: string;
  let userWorkflowsDir: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "pi-workflow-test-"));
    projectWorkflowsDir = join(tempRoot, "project", ".pi", "workflows");
    userWorkflowsDir = join(tempRoot, "user", "agent", "workflows");

    mkdirSync(projectWorkflowsDir, { recursive: true });
    mkdirSync(userWorkflowsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("discovers and parses repository example workflow .pi/workflows/example.md", async () => {
    const cwd = process.cwd();
    const result = await loadWorkflows({ cwd });

    assert(result.workflows.has("example"), "Expected 'example' workflow to be discovered in .pi/workflows");
    const def = result.workflows.get("example")!;
    assert.equal(def.name, "example");
    assert.equal(def.mode, "self-paced");
    assert.equal(def.concurrency.maxRuns, 1);
    assert.equal(def.budget.maxTurns, 100);
    assert.equal(def.budget.maxDuration, "8h");
    assert.equal(def.wakeups.default, "5m");
    assert.deepEqual(def.requires, ["loop", "tmux"]);
    assert.match(def.body, /# Example Workflow Policy/);
    assert.equal(def.source.scope, "project");
  });

  it("loads a single workflow definition fresh from disk with loadWorkflow", async () => {
    const wfPath = join(projectWorkflowsDir, "test-wf.md");
    writeFileSync(
      wfPath,
      `---
name: test-wf
description: Dynamic workflow.
mode: self-paced
budget:
  maxTurns: 10
---
Initial policy body.`
    );

    const def1 = await loadWorkflow("test-wf", {
      projectDir: projectWorkflowsDir,
      userDir: userWorkflowsDir,
    });
    assert(def1 !== null);
    assert.equal(def1.budget.maxTurns, 10);
    assert.equal(def1.body, "Initial policy body.");

    // Update definition file on disk
    writeFileSync(
      wfPath,
      `---
name: test-wf
description: Dynamic workflow updated.
mode: self-paced
budget:
  maxTurns: 42
---
Updated policy body.`
    );

    // Re-reading immediately reflects edits without reinstalling
    const def2 = await loadWorkflow("test-wf", {
      projectDir: projectWorkflowsDir,
      userDir: userWorkflowsDir,
    });
    assert(def2 !== null);
    assert.equal(def2.budget.maxTurns, 42);
    assert.equal(def2.description, "Dynamic workflow updated.");
    assert.equal(def2.body, "Updated policy body.");
  });

  it("discovers files deterministically in lexicographical order", async () => {
    writeFileSync(
      join(projectWorkflowsDir, "z-flow.md"),
      `---\nname: z-flow\ndescription: Z\nmode: self-paced\n---\nZ body`
    );
    writeFileSync(
      join(projectWorkflowsDir, "a-flow.md"),
      `---\nname: a-flow\ndescription: A\nmode: self-paced\n---\nA body`
    );
    writeFileSync(
      join(projectWorkflowsDir, "m-flow.md"),
      `---\nname: m-flow\ndescription: M\nmode: self-paced\n---\nM body`
    );

    const result = await loadWorkflows({
      projectDir: projectWorkflowsDir,
      userDir: userWorkflowsDir,
    });

    const loadedNames = result.definitions.map((d) => d.name);
    assert.deepEqual(loadedNames, ["a-flow", "m-flow", "z-flow"]);
  });

  it("rejects duplicate workflow names in the same project scope", async () => {
    writeFileSync(
      join(projectWorkflowsDir, "first.md"),
      `---\nname: collision\ndescription: First definition.\nmode: self-paced\n---\nBody 1`
    );
    writeFileSync(
      join(projectWorkflowsDir, "second.md"),
      `---\nname: collision\ndescription: Second definition.\nmode: self-paced\n---\nBody 2`
    );

    const result = await loadWorkflows({
      projectDir: projectWorkflowsDir,
      userDir: userWorkflowsDir,
    });

    assert.equal(result.workflows.has("collision"), false);
    const collisionDiag = result.diagnostics.find(
      (d) => d.field === "name" && d.message.includes("Duplicate workflow name")
    );
    assert(collisionDiag !== undefined, "Expected duplicate workflow error diagnostic");
    assert.match(collisionDiag.message, /project scope/);
  });

  it("rejects duplicate workflow names in the same user scope", async () => {
    writeFileSync(
      join(userWorkflowsDir, "user1.md"),
      `---\nname: user-collision\ndescription: First user definition.\nmode: self-paced\n---\nBody 1`
    );
    writeFileSync(
      join(userWorkflowsDir, "user2.md"),
      `---\nname: user-collision\ndescription: Second user definition.\nmode: self-paced\n---\nBody 2`
    );

    const result = await loadWorkflows({
      projectDir: projectWorkflowsDir,
      userDir: userWorkflowsDir,
    });

    assert.equal(result.workflows.has("user-collision"), false);
    const collisionDiag = result.diagnostics.find(
      (d) => d.field === "name" && d.message.includes("Duplicate workflow name")
    );
    assert(collisionDiag !== undefined, "Expected duplicate workflow error diagnostic in user scope");
    assert.match(collisionDiag.message, /user scope/);
  });

  it("enforces project-over-user precedence on workflow name collision", async () => {
    // User-scope definition
    writeFileSync(
      join(userWorkflowsDir, "deploy.md"),
      `---
name: deploy
description: User global deploy workflow.
mode: self-paced
budget:
  maxTurns: 5
---
User global deployment policy.`
    );

    // Project-scope definition with same name
    writeFileSync(
      join(projectWorkflowsDir, "deploy.md"),
      `---
name: deploy
description: Project customized deploy workflow.
mode: self-paced
budget:
  maxTurns: 25
---
Project specific deployment policy.`
    );

    const result = await loadWorkflows({
      projectDir: projectWorkflowsDir,
      userDir: userWorkflowsDir,
    });

    // Project definition wins
    const active = result.workflows.get("deploy");
    assert(active !== undefined);
    assert.equal(active.description, "Project customized deploy workflow.");
    assert.equal(active.budget.maxTurns, 25);
    assert.equal(active.source.scope, "project");

    // Shadowed record tracks overridden user workflow
    assert.equal(result.shadowed.length, 1);
    assert.equal(result.shadowed[0].name, "deploy");
    assert.equal(result.shadowed[0].userWorkflow.description, "User global deploy workflow.");
    assert.equal(result.shadowed[0].projectWorkflow.description, "Project customized deploy workflow.");
  });

  it("enforces max file size limit and skips oversized files with diagnostic", async () => {
    const hugeFilePath = join(projectWorkflowsDir, "oversized.md");
    // Write 600 KiB file
    const hugeContent =
      `---\nname: oversized\ndescription: Oversized file\nmode: self-paced\n---\n` +
      "a".repeat(600 * 1024);
    writeFileSync(hugeFilePath, hugeContent);

    const result = await loadWorkflows({
      projectDir: projectWorkflowsDir,
      userDir: userWorkflowsDir,
      maxFileSize: 512 * 1024,
    });

    assert.equal(result.workflows.has("oversized"), false);
    const sizeDiag = result.diagnostics.find((d) => d.message.includes("exceeds maximum workflow file size limit"));
    assert(sizeDiag !== undefined);
    assert.equal(sizeDiag.path, hugeFilePath);
  });

  it("supports explicitPaths option to load targeted files or folders", async () => {
    const customPath = join(tempRoot, "custom-workflow.md");
    writeFileSync(
      customPath,
      `---
name: custom-path-wf
description: Explicit path workflow.
mode: manual
---
Custom path body.`
    );

    const result = await loadWorkflows({
      projectDir: projectWorkflowsDir,
      userDir: userWorkflowsDir,
      explicitPaths: [customPath],
    });

    assert(result.workflows.has("custom-path-wf"));
    const def = result.workflows.get("custom-path-wf")!;
    assert.equal(def.name, "custom-path-wf");
    assert.equal(def.source.scope, "explicit");
  });

  it("throws WorkflowValidationError when strict mode is enabled", async () => {
    writeFileSync(
      join(projectWorkflowsDir, "malformed.md"),
      `---\nname: malformed\nmode: [invalid\n---\nbody`
    );

    await assert.rejects(
      () =>
        loadWorkflows({
          projectDir: projectWorkflowsDir,
          userDir: userWorkflowsDir,
          strict: true,
        }),
      (err: unknown) => {
        assert(err instanceof WorkflowValidationError);
        assert.equal(err.path, join(projectWorkflowsDir, "malformed.md"));
        return true;
      }
    );
  });

  it("loads a specific file with loadWorkflowFromFile", () => {
    const singleFile = join(projectWorkflowsDir, "single.md");
    writeFileSync(
      singleFile,
      `---
name: single-wf
description: Loaded directly from file.
mode: self-paced
concurrency:
  maxRuns: 2
---
Direct file body.`
    );

    const def = loadWorkflowFromFile(singleFile, "project");
    assert.equal(def.name, "single-wf");
    assert.equal(def.concurrency.maxRuns, 2);
    assert.equal(def.body, "Direct file body.");
  });

  it("skips and rejects directory and file symlinks during discovery to prevent loops and scope escapes", async () => {
    const externalDir = join(tempRoot, "external-scope");
    mkdirSync(externalDir, { recursive: true });

    writeFileSync(
      join(externalDir, "escaped.md"),
      `---\nname: escaped-wf\ndescription: Escaped\nmode: self-paced\n---\nEscaped body`
    );

    // Symlink pointing outside scope
    const symlinkSubdir = join(projectWorkflowsDir, "external-link");
    symlinkSync(externalDir, symlinkSubdir, "dir");

    // Circular symlink pointing to parent/self to test loop prevention
    const circularLink = join(projectWorkflowsDir, "loop-link");
    symlinkSync(projectWorkflowsDir, circularLink, "dir");

    // Symlink file pointing to external file
    const symlinkFile = join(projectWorkflowsDir, "escaped-link.md");
    symlinkSync(join(externalDir, "escaped.md"), symlinkFile, "file");

    const result = await loadWorkflows({
      projectDir: projectWorkflowsDir,
      userDir: userWorkflowsDir,
    });

    // Escaped workflow from symlink must NOT be discovered
    assert.equal(result.workflows.has("escaped-wf"), false);
  });

  it("ensures loadWorkflow fails closed for invalid definitions", async () => {
    writeFileSync(
      join(projectWorkflowsDir, "broken-flow.md"),
      `---\nname: broken-flow\ndescription: Broken\nmode: invalid-mode\n---\nBody`
    );

    // Default loadWorkflow (strict: true) must fail closed
    await assert.rejects(
      () =>
        loadWorkflow("broken-flow", {
          projectDir: projectWorkflowsDir,
          userDir: userWorkflowsDir,
        }),
      (err: unknown) => {
        assert(err instanceof WorkflowValidationError);
        assert.match(err.message, /Field "mode" must be one of/);
        return true;
      }
    );

    // Even with strict: false explicitly passed, loading the invalid target fails closed
    await assert.rejects(
      () =>
        loadWorkflow("broken-flow", {
          projectDir: projectWorkflowsDir,
          userDir: userWorkflowsDir,
          strict: false,
        }),
      (err: unknown) => {
        assert(err instanceof WorkflowValidationError);
        assert.match(err.message, /Field "mode" must be one of/);
        return true;
      }
    );

    // Truly non-existent workflow in a clean directory returns null
    rmSync(join(projectWorkflowsDir, "broken-flow.md"));
    const nonExistent = await loadWorkflow("non-existent", {
      projectDir: projectWorkflowsDir,
      userDir: userWorkflowsDir,
    });
    assert.equal(nonExistent, null);
  });
});
