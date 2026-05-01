import type { NovaLogger } from './logger';
import type { NovaRuntime } from './runtime';

export interface NovaSchedulerOptions {
  runtime: NovaRuntime;
  intervalMs?: number;
  /** Separate interval for ActLoop processing; defaults to intervalMs. */
  actLoopIntervalMs?: number;
  logger?: NovaLogger;
}

const DEFAULT_SCHEDULED_TICK_MS = 60_000;
const DEFAULT_ACT_LOOP_MS = 15_000;

export class NovaScheduler {
  private scheduledTimer: ReturnType<typeof setInterval> | null = null;
  private actLoopTimer: ReturnType<typeof setInterval> | null = null;
  private readonly runtime: NovaRuntime;
  private readonly intervalMs: number;
  private readonly actLoopIntervalMs: number;
  private readonly logger?: NovaLogger;

  constructor(options: NovaSchedulerOptions) {
    this.runtime = options.runtime;
    this.intervalMs = normalizeInterval(options.intervalMs);
    this.actLoopIntervalMs = normalizeActLoopInterval(options.actLoopIntervalMs);
    this.logger = options.logger;
  }

  start(): void {
    if (this.scheduledTimer) return;

    // Scheduled tick: pressure computation, desire derivation, candidate
    // generation, gate evaluation, and enqueue.
    this.scheduledTimer = setInterval(() => {
      try {
        this.runtime.runScheduledTick(Date.now());
      } catch (error) {
        this.logger?.warn('Nova scheduled tick failed', error);
      }
    }, this.intervalMs);
    this.scheduledTimer.unref?.();

    // ActLoop tick: dequeue and execute one queued proactive action
    // per tick (if executor is configured).  Runs on a shorter interval
    // so queued actions don't wait a full pressure-tick cycle.
    this.actLoopTimer = setInterval(() => {
      this.runtime.processActionQueue(Date.now())?.catch((error) => {
        this.logger?.warn('Nova ActLoop tick failed', error);
      });
    }, this.actLoopIntervalMs);
    this.actLoopTimer.unref?.();
  }

  stop(): void {
    if (this.scheduledTimer) {
      clearInterval(this.scheduledTimer);
      this.scheduledTimer = null;
    }
    if (this.actLoopTimer) {
      clearInterval(this.actLoopTimer);
      this.actLoopTimer = null;
    }
  }

  get running(): boolean {
    return this.scheduledTimer !== null || this.actLoopTimer !== null;
  }
}

function normalizeInterval(intervalMs: number | undefined): number {
  if (intervalMs === undefined || !Number.isFinite(intervalMs)) return DEFAULT_SCHEDULED_TICK_MS;
  return Math.max(5_000, Math.trunc(intervalMs));
}

function normalizeActLoopInterval(intervalMs: number | undefined): number {
  if (intervalMs === undefined || !Number.isFinite(intervalMs)) return DEFAULT_ACT_LOOP_MS;
  return Math.max(5_000, Math.trunc(intervalMs));
}
