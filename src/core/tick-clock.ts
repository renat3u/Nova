//
// TickClock — 自适应 tick 时钟，完全对齐 Alice runtime/src/utils/time.ts
//
// 根据当前 AgentMode 和 API 压力动态计算最优 tick 间隔：
//   dt = dtMin + (dtMax - dtMin) * exp(-api / kappaT)
//
// API 高时 tick 变快（接近 dtMin），API 低时 tick 变慢（接近 dtMax）。

export type AgentMode = 'wakeup' | 'patrol' | 'conversation' | 'consolidation' | 'dormant';

/** 静默惩罚参数 — 用于延长长时间无交互时的 tick 间隔。 */
export interface SilencePenalty {
  /** 用户无输入的秒数。 */
  userSilenceSeconds: number;
  /** 连续无回应的 proactive 数量。 */
  unansweredProactiveCount: number;
}

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

  /**
   * 计算带静默惩罚的 tick 间隔。
   *
   * 当用户长时间无输入或 proactive 无回应时，在基础间隔上叠加乘数。
   * 规则：
   *   1. 用户无输入超过 5 分钟，每超出 1 分钟增加 0.2x，最大 10x
   *   2. 连续 5 条 proactive 无回应，每多一条增加 0.5x，最大额外 5x
   *   3. 连续 3 条无回应 + conversation 模式 → 强制 ≥ 3x 乘数
   */
  computeIntervalWithPenalty(
    api: number,
    mode: AgentMode,
    penalty: SilencePenalty,
    config?: { silencePenaltyStartSeconds?: number; silenceMaxMultiplier?: number; silenceUnansweredProactiveThreshold?: number },
  ): number {
    const baseInterval = this.computeInterval(api, mode);
    const startSeconds = config?.silencePenaltyStartSeconds ?? 300;
    const maxMultiplier = config?.silenceMaxMultiplier ?? 10;
    const proactiveThreshold = config?.silenceUnansweredProactiveThreshold ?? 3;

    let silenceMultiplier = 1.0;

    // 规则 1: 用户无输入超过阈值，开始延长
    const silenceMinutes = penalty.userSilenceSeconds / 60;
    const thresholdMinutes = startSeconds / 60;
    if (silenceMinutes > thresholdMinutes) {
      silenceMultiplier = Math.min(maxMultiplier, 1 + (silenceMinutes - thresholdMinutes) * 0.2);
    }

    // 规则 2: 连续 proactive 无回应，进一步延长
    if (penalty.unansweredProactiveCount >= 5) {
      const proactivePenalty = Math.min(5, (penalty.unansweredProactiveCount - 4) * 0.5);
      silenceMultiplier = Math.max(silenceMultiplier, 1 + proactivePenalty);
    }

    // 规则 3: proactive 连续无回应 + conversation 模式 → 强制更长的间隔
    if (penalty.unansweredProactiveCount >= proactiveThreshold && mode === 'conversation') {
      silenceMultiplier = Math.max(silenceMultiplier, 3);
    }

    return Math.round(baseInterval * silenceMultiplier);
  }

  /** 重置 tick 计数器（用于重启等场景）。 */
  reset(): void {
    this._tick = 0;
    this._lastAdvanceMs = 0;
  }
}
