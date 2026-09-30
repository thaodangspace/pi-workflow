/**
 * Fake in-memory LoopServiceV1 implementation for unit and integration testing.
 */

import { randomUUID } from "node:crypto";
import {
  type EventBusLike,
  isLoopServiceV1,
  LOOP_SERVICE_CHANGED_CHANNEL,
  LOOP_SERVICE_DISCOVER_CHANNEL,
  LOOP_SERVICE_VERSION,
  type LoopCronOptions,
  type LoopScheduleOptions,
  type LoopSelfPacedOptions,
  type LoopServiceStatus,
  type LoopServiceV1,
  type LoopServiceWakeupDecision,
  type LoopTaskMode,
  type LoopTaskSummary,
  LoopServiceInputError,
  LoopServiceUnavailableError,
} from "../src/scheduler-adapter.ts";

export interface FakeLoopServiceOptions {
  sessionId?: string;
  initialAvailable?: boolean;
}

export class FakeLoopService implements LoopServiceV1 {
  readonly version = LOOP_SERVICE_VERSION;
  sessionId: string;
  private available: boolean;

  tasks = new Map<string, LoopTaskSummary>();
  wakeups: Array<{ taskId: string; delayMs: number; reason?: string }> = [];
  deletedTaskIds: string[] = [];
  stoppedTaskIds: string[] = [];

  constructor(options: FakeLoopServiceOptions = {}) {
    this.sessionId = options.sessionId ?? `session-${randomUUID()}`;
    this.available = options.initialAvailable ?? true;
  }

  isAvailable(): boolean {
    return this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new LoopServiceUnavailableError("Fake loop service is unavailable");
    }
  }

  scheduleFixed(intervalMs: number, prompt: string, options?: LoopScheduleOptions): LoopTaskSummary {
    this.assertAvailable();
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new LoopServiceInputError(`Interval must be positive, got ${intervalMs}`);
    }
    const id = `task-fixed-${randomUUID()}`;
    const task: LoopTaskSummary = {
      id,
      mode: "fixed",
      prompt,
      maintenance: false,
      intervalMs,
      nextFireAt: Date.now() + intervalMs,
      expiresAt: options?.expiresAt,
      pending: false,
    };
    this.tasks.set(id, task);
    return task;
  }

  scheduleCron(expression: string, prompt: string, options?: LoopCronOptions): LoopTaskSummary {
    this.assertAvailable();
    if (!expression || expression.trim().split(/\s+/).length !== 5) {
      throw new LoopServiceInputError(`Invalid cron expression "${expression}"`);
    }
    const id = `task-cron-${randomUUID()}`;
    const task: LoopTaskSummary = {
      id,
      mode: "fixed",
      prompt,
      maintenance: false,
      cron: expression,
      timeZone: options?.timeZone,
      nextFireAt: Date.now() + 60_000,
      expiresAt: options?.expiresAt,
      pending: false,
    };
    this.tasks.set(id, task);
    return task;
  }

  scheduleOnce(at: number, prompt: string, options?: LoopScheduleOptions): LoopTaskSummary {
    this.assertAvailable();
    if (!Number.isFinite(at) || at <= 0) {
      throw new LoopServiceInputError(`Execution time at must be positive epoch ms, got ${at}`);
    }
    const id = `task-once-${randomUUID()}`;
    const task: LoopTaskSummary = {
      id,
      mode: "one-shot",
      prompt,
      maintenance: false,
      nextFireAt: at,
      expiresAt: options?.expiresAt,
      pending: false,
    };
    this.tasks.set(id, task);
    return task;
  }

  scheduleSelfPaced(prompt: string, options?: LoopSelfPacedOptions): LoopTaskSummary {
    this.assertAvailable();
    const id = `task-self-${randomUUID()}`;
    const task: LoopTaskSummary = {
      id,
      mode: "self-paced",
      prompt,
      maintenance: false,
      nextFireAt: Date.now(), // Due immediately
      expiresAt: options?.expiresAt,
      pending: false,
    };
    this.tasks.set(id, task);
    return task;
  }

  listTasks(): LoopTaskSummary[] {
    this.assertAvailable();
    return Array.from(this.tasks.values());
  }

  deleteTask(id: string): boolean {
    this.assertAvailable();
    if (this.tasks.has(id)) {
      this.tasks.delete(id);
      this.deletedTaskIds.push(id);
      return true;
    }
    return false;
  }

  scheduleTaskWakeup(id: string, delayMs: number, reason?: string): LoopServiceWakeupDecision {
    this.assertAvailable();
    const task = this.tasks.get(id);
    if (!task) {
      throw new LoopServiceInputError(`Cannot reschedule unknown task "${id}"`);
    }
    if (task.mode !== "self-paced") {
      throw new LoopServiceInputError(`Task "${id}" is mode "${task.mode}", only self-paced can be rescheduled.`);
    }

    // Clamping to [1min, 1hour] exactly like pi-loop
    const requestedMs = delayMs;
    const clampedMs = Math.max(60_000, Math.min(3_600_000, Math.round(delayMs)));
    const clamped = clampedMs !== requestedMs;
    const nextFireAt = Date.now() + clampedMs;

    const updatedTask: LoopTaskSummary = {
      ...task,
      nextFireAt,
      reason,
    };
    this.tasks.set(id, updatedTask);
    this.wakeups.push({ taskId: id, delayMs: clampedMs, reason });

    return {
      requestedMs,
      delayMs: clampedMs,
      clamped,
      nextFireAt,
      reason,
    };
  }

  stopTask(id: string): boolean {
    this.assertAvailable();
    if (this.tasks.has(id)) {
      this.tasks.delete(id);
      this.stoppedTaskIds.push(id);
      return true;
    }
    return false;
  }
}

/**
 * In-memory test event bus reproducing pi.events semantics.
 */
export class TestEventBus implements EventBusLike {
  private handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    const set = this.handlers.get(channel);
    if (set) {
      for (const handler of Array.from(set)) {
        try {
          handler(data);
        } catch (err) {
          console.error(`Error in event handler for ${channel}:`, err);
        }
      }
    }
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
    }
    this.handlers.get(channel)!.add(handler);
    return () => {
      this.handlers.get(channel)?.delete(handler);
    };
  }

  /**
   * Registers a mock provider answering discovery requests on this bus.
   */
  registerProvider(service: FakeLoopService): () => void {
    const unsubs: Array<() => void> = [];

    const unsubDiscover = this.on(LOOP_SERVICE_DISCOVER_CHANNEL, (data: any) => {
      if (!data || typeof data.replyChannel !== "string") return;

      if (!service.isAvailable()) {
        this.emit(data.replyChannel, {
          version: LOOP_SERVICE_VERSION,
          available: false,
          reason: "Fake loop service is currently disabled",
        });
        return;
      }

      this.emit(data.replyChannel, {
        version: LOOP_SERVICE_VERSION,
        available: true,
        sessionId: service.sessionId,
        service,
      });
    });

    unsubs.push(unsubDiscover);

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }

  broadcastChange(status: LoopServiceStatus): void {
    this.emit(LOOP_SERVICE_CHANGED_CHANNEL, status);
  }
}
