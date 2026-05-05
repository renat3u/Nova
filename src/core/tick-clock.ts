//
// TickClock — 自适应 tick 时钟，完全对齐 Alice runtime/src/utils/time.ts
//
// 根据当前 AgentMode 和 API 压力动态计算最优 tick 间隔：
//   dt = dtMin + (dtMax - dtMin) * exp(-api / kappaT)
//
// API 高时 tick 变快（接近 dtMin），API 低时 tick 变慢（接近 dtMax）。

export type AgentMode = 'wakeup' | 'patrol' | 'conversation' | 'consolidation' | 'dormant';

export const MODE_TIMING: Record<AgentMode, { dtMin: number; dtMax: number }> = {
  wakeup:        { dtMin: 8_000,   dtMax: 20_000 },
  patrol:        { dtMin: 1_000,   dtMax: 300_000 },
  conversation:  { dtMin: 10_000,  dtMax: 30_000 },
  consolidation: { dtMin: 30_000,  dtMax: 600_000 },
  dormant:       { dtMin: 60_000,  dtMax: 1_800_000 },
};

export interface TickClockOptions {
  dtMin?: number;
  dtMax?: number;
  kappaT?: number;
}

const DEFAULT_DT_MIN = 1_000;
const DEFAULT_DT_MAX = 300_000;
const DEFAULT_KAPPA_T = 1.0;

export class TickClock {
  private _tick = 0;
  private _lastAdvanceMs = 0;
  readonly dtMin: number;
  readonly dtMax: number;
  readonly kappaT: number;

  constructor(options: TickClockOptions = {}) {
    this.dtMin = options.dtMin ?? DEFAULT_DT_MIN;
    this.dtMax = options.dtMax ?? DEFAULT_DT_MAX;
    this.kappaT = options.kappaT ?? DEFAULT_KAPPA_T;
  }

  get tick(): number {
    return this._tick;
  }

  get lastAdvanceMs(): number {
    return this._lastAdvanceMs;
  }

  /**
   * 根据当前 API 压力和 AgentMode 计算应使用的 tick 间隔（毫秒）。
   *
   * @param api 归一化 API 压力值 (0-1)
   * @param mode 当前 AgentMode，决定 dtMin/dtMax 边界
   * @returns 计算出的间隔（毫秒）
   */
  computeInterval(api: number, mode: AgentMode): number {
    const timing = MODE_TIMING[mode];
    const dtMin = timing.dtMin;
    const dtMax = timing.dtMax;
    // dt = dtMin + (dtMax - dtMin) * exp(-api / kappaT)
    const range = dtMax - dtMin;
    const decay = Math.exp(-api / this.kappaT);
    const dt = dtMin + range * decay;
    return Math.round(dt);
  }

  /**
   * 推进 tick 计数器，返回当前 tick 编号和自上次推进以来的 Δt（秒）。
   *
   * @param nowMs 当前时间戳（毫秒）
   * @returns { tick: 当前 tick 编号, dt: Δt 秒 }
   */
  advance(nowMs: number = Date.now()): { tick: number; dt: number } {
    this._tick += 1;
    const elapsedMs = this._lastAdvanceMs === 0 ? 0 : nowMs - this._lastAdvanceMs;
    this._lastAdvanceMs = nowMs;
    const dt = elapsedMs === 0 ? 60 : Math.max(1, elapsedMs / 1000);
    return { tick: this._tick, dt };
  }

  /** 重置 tick 计数器（用于重启等场景）。 */
  reset(): void {
    this._tick = 0;
    this._lastAdvanceMs = 0;
  }
}
