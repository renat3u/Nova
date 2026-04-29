import type { NovaLogger } from './logger';
import type { NovaRuntime } from './runtime';

export interface NovaSchedulerOptions {
  runtime: NovaRuntime;
  intervalMs?: number;
  logger?: NovaLogger;
}

const DEFAULT_SCHEDULED_TICK_MS = 60_000;

export class NovaScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly runtime: NovaRuntime;
  private readonly intervalMs: number;
  private readonly logger?: NovaLogger;

  constructor(options: NovaSchedulerOptions) {
    this.runtime = options.runtime;
    this.intervalMs = normalizeInterval(options.intervalMs);
    this.logger = options.logger;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      try {
        this.runtime.runScheduledTick(Date.now());
      } catch (error) {
        this.logger?.warn('Nova scheduled tick failed', error);
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }
}

function normalizeInterval(intervalMs: number | undefined): number {
  if (intervalMs === undefined || !Number.isFinite(intervalMs)) return DEFAULT_SCHEDULED_TICK_MS;
  return Math.max(5_000, Math.trunc(intervalMs));
}
