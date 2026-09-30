/**
 * Issue #10 — interactive TUI aggregate workflow status line.
 *
 * Renders exactly one persistent aggregate line through Pi's dedicated keyed
 * `ctx.ui.setStatus(key, text)` API. It deliberately:
 *
 *  - uses its own key ({@link WORKFLOW_STATUS_KEY} = `"workflow"`), never
 *    pi-loop's `"loop"` key, so the two extensions coexist;
 *  - never replaces the shared footer (`setFooter`) or adds a widget per run;
 *  - never notifies, sends a message, or parses the transcript;
 *  - repaints only from the authoritative registry mutation stream and the
 *    read-only scheduler change stream, coalescing bursts into one microtask;
 *  - deduplicates identical rendered text and clears the key when no
 *    nonterminal workflows remain.
 *
 * TUI-only: the extension entrypoint only attaches this controller when
 * `ctx.mode === "tui"` and the status API is present. RPC/print modes get the
 * plain-text command surface instead.
 */

import {
  buildStatusProjection,
  formatStatusLine,
  type WorkflowStatusProjection,
} from "./observability.ts";
import type { WorkflowRunRegistry } from "./registry.ts";
import type { LoopSchedulerAdapter } from "./scheduler-adapter.ts";

/** Dedicated status key; never pi-loop's `"loop"`. */
export const WORKFLOW_STATUS_KEY = "workflow";

/** Minimal structural view of Pi's keyed status API. */
export interface ExtensionStatusUI {
  setStatus(key: string, text: string | undefined): void;
}

export interface WorkflowStatusControllerOptions {
  registry: WorkflowRunRegistry;
  adapter: LoopSchedulerAdapter;
  /** Injected clock for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export class WorkflowStatusController {
  private readonly options: WorkflowStatusControllerOptions;
  private readonly now: () => number;
  private ui?: ExtensionStatusUI;
  private unsubscribers: Array<() => void> = [];
  private scheduled = false;
  private lastText: string | undefined;

  constructor(options: WorkflowStatusControllerOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  /** True while an interactive status target is attached. */
  get attached(): boolean {
    return this.ui !== undefined;
  }

  /** Last rendered status text (undefined when cleared); exposed for tests. */
  get renderedText(): string | undefined {
    return this.lastText;
  }

  /**
   * Attach an interactive UI target. Re-attaching the same target is
   * idempotent. Attaching a new target first detaches the previous one so no
   * subscription or stale status can leak across sessions.
   */
  attach(ui: ExtensionStatusUI): void {
    if (this.ui === ui && this.unsubscribers.length > 0) {
      this.refresh();
      return;
    }
    this.detach();
    this.ui = ui;
    this.unsubscribers.push(this.options.registry.subscribeMutations(() => this.refresh()));
    this.unsubscribers.push(this.options.adapter.subscribeChanges(() => this.refresh()));
    this.refresh();
  }

  /**
   * Request a coalesced repaint. Multiple calls within the same microtask are
   * collapsed into one paint; no timer or polling loop is used.
   */
  refresh(): void {
    if (!this.ui || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.paint();
    });
  }

  /** Force a synchronous repaint (deterministic tests). */
  paintNow(): void {
    this.scheduled = false;
    this.paint();
  }

  private paint(): void {
    const ui = this.ui;
    if (!ui) return;
    const projection: WorkflowStatusProjection = buildStatusProjection(
      this.options.registry,
      this.options.adapter,
      { now: this.now() }
    );
    const line = formatStatusLine(projection);
    if (line === this.lastText) {
      return;
    }
    this.lastText = line;
    ui.setStatus(WORKFLOW_STATUS_KEY, line);
  }

  /**
   * Detach the UI target, release subscriptions and clear the dedicated status
   * key. Idempotent (safe on repeated shutdown/reload).
   */
  detach(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch {
        // Cleanup must never throw.
      }
    }
    this.unsubscribers = [];
    if (this.ui) {
      try {
        this.ui.setStatus(WORKFLOW_STATUS_KEY, undefined);
      } catch {
        // The UI may already be torn down.
      }
    }
    this.ui = undefined;
    this.lastText = undefined;
    this.scheduled = false;
  }
}
