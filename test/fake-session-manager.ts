/**
 * Production-faithful fake Pi SessionManager and session tree for testing.
 * Implements tree-based branching, parentId pointer chains, getBranch(),
 * and JSONL serialization/deserialization matching Pi's SessionManager.
 */

import { randomUUID } from "node:crypto";
import type { SessionBranchProvider, SessionEntryAppender } from "../src/types.ts";

export interface FakeSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface FakeSessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
}

export class FakeSessionManager implements SessionBranchProvider, SessionEntryAppender {
  private sessionId: string;
  private entries: FakeSessionEntry[] = [];
  private byId = new Map<string, FakeSessionEntry>();
  private leafId: string | null = null;
  private cwd: string;

  constructor(options: { sessionId?: string; cwd?: string } = {}) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.cwd = options.cwd ?? process.cwd();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getCwd(): string {
    return this.cwd;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  setLeafId(leafId: string | null): void {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new Error(`Leaf entry "${leafId}" does not exist in session tree.`);
    }
    this.leafId = leafId;
  }

  /**
   * Append a custom entry to the current branch, advancing leafId.
   */
  appendCustomEntry(customType: string, data?: unknown): string {
    const id = `entry-${randomUUID().slice(0, 8)}`;
    const timestamp = new Date().toISOString();
    const entry: FakeSessionEntry = {
      type: "custom",
      id,
      parentId: this.leafId,
      timestamp,
      customType,
      data,
    };

    this.entries.push(entry);
    this.byId.set(id, entry);
    this.leafId = id;
    return id;
  }

  /**
   * ExtensionAPI compatibility method: appendEntry
   */
  appendEntry(customType: string, data?: unknown): void {
    this.appendCustomEntry(customType, data);
  }

  /**
   * Append arbitrary non-custom entry (e.g. message)
   */
  appendRawEntry(entry: { type: string; [key: string]: unknown }): string {
    const id = `entry-${randomUUID().slice(0, 8)}`;
    const timestamp = new Date().toISOString();
    const fullEntry: FakeSessionEntry = {
      id,
      parentId: this.leafId,
      timestamp,
      ...entry,
    };

    this.entries.push(fullEntry);
    this.byId.set(id, fullEntry);
    this.leafId = id;
    return id;
  }

  /**
   * Production-identical topological path walk from leaf to root, reversed to root -> leaf.
   */
  getBranch(fromId?: string): FakeSessionEntry[] {
    const path: FakeSessionEntry[] = [];
    const startId = fromId ?? this.leafId;
    let current = startId ? this.byId.get(startId) : undefined;

    while (current) {
      path.push(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }

    path.reverse();
    return path;
  }

  /**
   * Get all entries in insertion order.
   */
  getAllEntries(): readonly FakeSessionEntry[] {
    return [...this.entries];
  }

  /**
   * Export session to JSONL string matching Pi session file format.
   */
  exportJsonl(): string {
    const header: FakeSessionHeader = {
      type: "session",
      version: 3,
      id: this.sessionId,
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
    };

    const lines = [JSON.stringify(header)];
    for (const entry of this.entries) {
      lines.push(JSON.stringify(entry));
    }
    return lines.join("\n") + "\n";
  }

  /**
   * Reconstitute a FakeSessionManager from JSONL file content.
   */
  static fromJsonl(jsonl: string, explicitLeafId?: string): FakeSessionManager {
    const lines = jsonl.trim().split("\n").filter((l) => l.trim().length > 0);
    const mgr = new FakeSessionManager();
    mgr.entries = [];
    mgr.byId.clear();

    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (parsed.type === "session") {
        mgr.sessionId = parsed.id;
        mgr.cwd = parsed.cwd ?? process.cwd();
        continue;
      }

      mgr.entries.push(parsed);
      mgr.byId.set(parsed.id, parsed);
    }

    if (explicitLeafId !== undefined) {
      mgr.setLeafId(explicitLeafId);
    } else if (mgr.entries.length > 0) {
      mgr.leafId = mgr.entries[mgr.entries.length - 1].id;
    } else {
      mgr.leafId = null;
    }

    return mgr;
  }
}
