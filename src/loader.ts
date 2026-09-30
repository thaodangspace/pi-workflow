/**
 * Deterministic discovery and loading of workflow definitions
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_PROJECT_WORKFLOWS_DIR,
  DEFAULT_USER_WORKFLOWS_SUBDIR,
  MAX_WORKFLOW_FILE_SIZE_BYTES,
} from "./constants.ts";
import { parseWorkflowContent } from "./parser.ts";
import {
  type WorkflowDefinitionV1,
  type WorkflowDiagnostic,
  type WorkflowScope,
  WorkflowValidationError,
} from "./types.ts";

export interface LoadWorkflowsOptions {
  /** Project root / working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Custom project workflows directory (defaults to <cwd>/.pi/workflows) */
  projectDir?: string;
  /** Custom user workflows directory (defaults to ~/.pi/agent/workflows) */
  userDir?: string;
  /** Include default project and user directories (defaults to true) */
  includeDefaults?: boolean;
  /** Explicit workflow file or directory paths to load */
  explicitPaths?: string[];
  /** Maximum file size in bytes (defaults to 512 KiB) */
  maxFileSize?: number;
  /**
   * If true, throws WorkflowValidationError on any fatal diagnostic.
   * If false, returns diagnostics in the result.
   */
  strict?: boolean;
}

export interface ShadowedWorkflowInfo {
  name: string;
  userWorkflow: WorkflowDefinitionV1;
  projectWorkflow: WorkflowDefinitionV1;
}

export interface WorkflowLoadResult {
  /** Active workflows keyed by workflow name */
  workflows: Map<string, WorkflowDefinitionV1>;
  /** Array of active workflow definitions */
  definitions: WorkflowDefinitionV1[];
  /** Validation and loading diagnostics */
  diagnostics: WorkflowDiagnostic[];
  /** User workflows that were shadowed by project workflows */
  shadowed: ShadowedWorkflowInfo[];
}

interface DiscoveredFile {
  fullPath: string;
  relativePath: string;
  scope: WorkflowScope;
}

/**
 * Get default user workflows directory (~/.pi/agent/workflows)
 */
export function getDefaultUserWorkflowsDir(): string {
  const envAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (envAgentDir) {
    return join(envAgentDir, DEFAULT_USER_WORKFLOWS_SUBDIR);
  }
  return join(homedir(), ".pi", "agent", DEFAULT_USER_WORKFLOWS_SUBDIR);
}

/**
 * Normalizes path separators to POSIX forward slashes
 */
function toPosixPath(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Recursively scans a directory deterministically for .md files.
 * Ignores hidden files/directories and node_modules.
 */
function scanDirectoryDeterministic(dir: string, baseDir: string, scope: WorkflowScope): DiscoveredFile[] {
  if (!existsSync(dir)) {
    return [];
  }

  const results: DiscoveredFile[] = [];

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  // Sort entries deterministically by name
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    // Ignore hidden files and directories (starting with '.')
    if (entry.name.startsWith(".")) {
      continue;
    }

    // Ignore node_modules
    if (entry.name === "node_modules") {
      continue;
    }

    const fullPath = join(dir, entry.name);

    let isFile = entry.isFile();
    let isDirectory = entry.isDirectory();

    if (entry.isSymbolicLink()) {
      try {
        const stat = statSync(fullPath);
        isFile = stat.isFile();
        isDirectory = stat.isDirectory();
      } catch {
        continue;
      }
    }

    if (isFile && entry.name.endsWith(".md")) {
      results.push({
        fullPath,
        relativePath: toPosixPath(relative(baseDir, fullPath)),
        scope,
      });
    } else if (isDirectory) {
      results.push(...scanDirectoryDeterministic(fullPath, baseDir, scope));
    }
  }

  return results;
}

/**
 * Load a single workflow definition file from disk.
 */
export function loadWorkflowFromFile(
  filePath: string,
  scope: WorkflowScope = "explicit",
  options: { maxFileSize?: number } = {}
): WorkflowDefinitionV1 {
  const resolvedPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

  if (!existsSync(resolvedPath)) {
    throw new WorkflowValidationError(`Workflow file does not exist: "${resolvedPath}"`, resolvedPath);
  }

  const stat = statSync(resolvedPath);
  const maxFileSize = options.maxFileSize ?? MAX_WORKFLOW_FILE_SIZE_BYTES;

  if (stat.size > maxFileSize) {
    throw new WorkflowValidationError(
      `File size (${stat.size} bytes) exceeds maximum workflow file size limit of ${maxFileSize} bytes (${Math.round(
        maxFileSize / 1024
      )} KiB)`,
      resolvedPath
    );
  }

  let content: string;
  try {
    content = readFileSync(resolvedPath, "utf-8");
  } catch (err) {
    throw new WorkflowValidationError(
      `Failed to read workflow file: ${err instanceof Error ? err.message : String(err)}`,
      resolvedPath
    );
  }

  return parseWorkflowContent(
    content,
    {
      path: resolvedPath,
      scope,
      relativePath: toPosixPath(relative(process.cwd(), resolvedPath)),
    },
    options
  );
}

/**
 * Load all workflow definitions from configured scopes (project, user, explicit).
 *
 * Enforces:
 * - Deterministic discovery ordering
 * - Safe file size limit
 * - Strict schema validation
 * - Same-scope duplicate rejection
 * - Project-over-user scope precedence
 * - Re-reads fresh from disk on every invocation
 */
export async function loadWorkflows(options: LoadWorkflowsOptions = {}): Promise<WorkflowLoadResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const projectDir = resolve(options.projectDir ?? join(cwd, DEFAULT_PROJECT_WORKFLOWS_DIR));
  const userDir = resolve(options.userDir ?? getDefaultUserWorkflowsDir());
  const includeDefaults = options.includeDefaults ?? true;
  const maxFileSize = options.maxFileSize ?? MAX_WORKFLOW_FILE_SIZE_BYTES;
  const strict = options.strict ?? false;

  const diagnostics: WorkflowDiagnostic[] = [];
  const shadowed: ShadowedWorkflowInfo[] = [];

  const userFiles: DiscoveredFile[] = [];
  const projectFiles: DiscoveredFile[] = [];
  const explicitFiles: DiscoveredFile[] = [];

  if (includeDefaults) {
    if (existsSync(userDir)) {
      userFiles.push(...scanDirectoryDeterministic(userDir, userDir, "user"));
    }
    if (existsSync(projectDir)) {
      projectFiles.push(...scanDirectoryDeterministic(projectDir, projectDir, "project"));
    }
  }

  if (options.explicitPaths) {
    for (const rawPath of options.explicitPaths) {
      const absPath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
      if (!existsSync(absPath)) {
        diagnostics.push({
          type: "error",
          path: absPath,
          message: `Explicit workflow path does not exist: "${absPath}"`,
        });
        continue;
      }

      try {
        const stat = statSync(absPath);
        if (stat.isDirectory()) {
          explicitFiles.push(...scanDirectoryDeterministic(absPath, absPath, "explicit"));
        } else if (stat.isFile() && absPath.endsWith(".md")) {
          explicitFiles.push({
            fullPath: absPath,
            relativePath: toPosixPath(relative(cwd, absPath)),
            scope: "explicit",
          });
        } else {
          diagnostics.push({
            type: "warning",
            path: absPath,
            message: `Explicit workflow path is not a .md file or directory: "${absPath}"`,
          });
        }
      } catch (err) {
        diagnostics.push({
          type: "error",
          path: absPath,
          message: `Cannot access path "${absPath}": ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // Sort discovered files deterministically by relative path
  userFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  projectFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  explicitFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  // Helper to load files in a specific scope and detect same-scope duplicates
  function loadScopeFiles(files: DiscoveredFile[], scopeName: "user" | "project" | "explicit") {
    const validDefs = new Map<string, WorkflowDefinitionV1>();
    const seenNames = new Map<string, string>(); // name -> fullPath
    const duplicateNames = new Set<string>();

    for (const file of files) {
      try {
        const stat = statSync(file.fullPath);
        if (stat.size > maxFileSize) {
          diagnostics.push({
            type: "error",
            path: file.fullPath,
            message: `File size (${stat.size} bytes) exceeds maximum workflow file size limit of ${maxFileSize} bytes (${Math.round(
              maxFileSize / 1024
            )} KiB)`,
          });
          continue;
        }

        const content = readFileSync(file.fullPath, "utf-8");
        const def = parseWorkflowContent(
          content,
          {
            path: file.fullPath,
            scope: file.scope,
            relativePath: file.relativePath,
          },
          { maxFileSize }
        );

        const existingPath = seenNames.get(def.name);
        if (existingPath) {
          duplicateNames.add(def.name);
          validDefs.delete(def.name);
          diagnostics.push({
            type: "error",
            path: file.fullPath,
            field: "name",
            message: `Duplicate workflow name "${def.name}" in ${scopeName} scope: defined in "${existingPath}" and "${file.fullPath}"`,
          });
        } else if (!duplicateNames.has(def.name)) {
          seenNames.set(def.name, file.fullPath);
          validDefs.set(def.name, def);
        }
      } catch (err) {
        if (err instanceof WorkflowValidationError) {
          diagnostics.push(...err.diagnostics);
        } else {
          diagnostics.push({
            type: "error",
            path: file.fullPath,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return validDefs;
  }

  // 1. Load user scope
  const userDefs = loadScopeFiles(userFiles, "user");

  // 2. Load project scope
  const projectDefs = loadScopeFiles(projectFiles, "project");

  // 3. Load explicit scope
  const explicitDefs = loadScopeFiles(explicitFiles, "explicit");

  // Assemble active workflows with project-over-user precedence
  const workflows = new Map<string, WorkflowDefinitionV1>();

  // Add user workflows
  for (const [name, userDef] of userDefs.entries()) {
    workflows.set(name, userDef);
  }

  // Overlay project workflows (project takes precedence on name collision)
  for (const [name, projectDef] of projectDefs.entries()) {
    const existingUserDef = workflows.get(name);
    if (existingUserDef && existingUserDef.source.scope === "user") {
      shadowed.push({
        name,
        userWorkflow: existingUserDef,
        projectWorkflow: projectDef,
      });
    }
    workflows.set(name, projectDef);
  }

  // Overlay explicit workflows (highest precedence)
  for (const [name, explicitDef] of explicitDefs.entries()) {
    const existing = workflows.get(name);
    if (existing && existing.source.scope === "user") {
      shadowed.push({
        name,
        userWorkflow: existing,
        projectWorkflow: explicitDef,
      });
    }
    workflows.set(name, explicitDef);
  }

  if (strict) {
    const errorDiagnostics = diagnostics.filter((d) => d.type === "error");
    if (errorDiagnostics.length > 0) {
      const first = errorDiagnostics[0];
      throw new WorkflowValidationError(first.message, first.path, first.field, errorDiagnostics);
    }
  }

  return {
    workflows,
    definitions: Array.from(workflows.values()),
    diagnostics,
    shadowed,
  };
}

/**
 * Load a single workflow definition by name, re-reading freshly from disk.
 */
export async function loadWorkflow(
  name: string,
  options: LoadWorkflowsOptions = {}
): Promise<WorkflowDefinitionV1 | null> {
  const result = await loadWorkflows(options);
  return result.workflows.get(name) ?? null;
}
