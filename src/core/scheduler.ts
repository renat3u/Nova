//
// Nova EVOLVE Loop — 自适应 tick 循环，对齐 Alice runtime/src/engine/evolve.ts
//
// 替换原有的 setInterval 定时器，改为 Promise.race 自适应间隔：
//   - buffer.onDirected 回调（2s debounce → 立即唤醒）
//   - buffer.onAnyEvent 回调（30s debounce → 立即唤醒）
//   - 自适应间隔 = clock.computeInterval(api, mode)
//   - 退避乘数 = 2^consecutiveFailures (max 16x)
//   - 最小间隔保护 (MIN_TICK_INTERVAL_MS)

import type { NovaLogger } from './logger';
import type { NovaRuntimeConfig } from './types';
import type { WorldModel } from '../world/model';
import type { NovaWorldRepository } from '../world/repository';
import type { NovaEventBuffer } from './event-buffer';
import type { ActionQueue } from '../act/action-queue';
import type { TickClock, SilencePenalty } from './tick-clock';
import type { ModeState } from '../engine/mode-fsm';
import { markDirected, markAnyEvent } from '../engine/mode-fsm';
import type { VoiceSelectionResult } from '../voices/selection';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { PersonalityVector } from '../personality/vector';
import type { RateLimitState } from '../gates/rate-limit';
import type { MemoryService } from '../memory/memory-service';
import type { MoodTracker } from '../engine/mood';

// ── 常量 ─────────────────────────────────────────────────────────────────────

const DIRECTED_DEBOUNCE_MS = 2_000;
const ANY_EVENT_DEBOUNCE_MS = 30_000;
const MIN_TICK_INTERVAL_MS = 3_000;
const BACKOFF_RESET_MS = 60_000;
const MAX_CONSECUTIVE_ERRORS = 10;

// ── EVOLVE State ─────────────────────────────────────────────────────────────

export interface EvolveState {
  G: WorldModel;
  repository: NovaWorldRepository;
  buffer: NovaEventBuffer;
  queue: ActionQueue;
  clock: TickClock;
  config: NovaRuntimeConfig;
  personality: PersonalityVector;
  rateLimit: RateLimitState;
  logger: NovaLogger;
  memoryService?: MemoryService;
  moodTracker?: MoodTracker;
  modeState: ModeState;
  getDecisionClient?: () => unknown;

  // 压力追踪
  pressureHistory: unknown;
  adaptiveKappa: unknown;
  voiceFatigue: unknown;
  lastVoiceSelection: VoiceSelectionResult | null;
  processedMessages: number;
  silenceCount: number;

  // LLM 退避状态
  llmBackoff: {
    consecutiveFailures: number;
    lastFailureMs: number;
  };

  // 近期行动记录
  recentActions: ActionRecord[];

  // 最近一次压力快照引用（供 ACT loop staleness check，evolveTick 更新 .current）
  pressureRef: { current: PressureSnapshot | null };

  // 系统锁：确保 EVOLVE（思考）和 ACT（说话）互斥
  systemLock: 'idle' | 'thinking' | 'speaking';
  // 最近一次入队的 action 引用（EVOLVE 用它等待 ACT 完成）
  lastEnqueuedAction: import('../act/action-queue').QueuedAction | null;

  // 执行 evolve tick 的核心函数（由外部注入以打破循环依赖）
  evolveTickFn: (state: EvolveState) => Promise<boolean>;

  // ── 用户活动追踪（Task 6: 静默惩罚）───────────────────────────────────────
  /** 用户活动状态，用于动态延长 tick 间隔。 */
  userActivity?: {
    lastUserInputMs: number;
    lastNovaProactiveMs: number;
    consecutiveUnansweredProactive: number;
  };

  // ── 自动停止（Task 3）─────────────────────────────────────────────────────
  /** 自动停止是否已触发。 */
  autoStopTriggered?: boolean;
  /** 自动停止回调（EVOLVE loop 退出时调用）。 */
  onAutoStop?: () => void;
}

export interface ActionRecord {
  tick: number;
  actionType: string;
  targetId: string;
  text?: string;
  status: string;
  createdMs: number;
}

// ── Promise 工具 ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建一个可被外部 resolve 的 Promise 和对应的 trigger 函数。
 */
/**
 * 创建一个 Promise 和 trigger，支持多次触发。
 * trigger() 使当前 promise resolve，后续 getPromise() 返回已 resolved 的 promise，
 * 直到调用方 consume() 后才分配新的未 resolved promise。
 */
function createTriggerPromise(): {
  trigger: () => void;
  getPromise: () => Promise<void>;
  consume: () => void;
} {
  let resolve: (() => void) | null = null;
  let promise: Promise<void> = new Promise<void>((r) => { resolve = r; });

  return {
    getPromise: () => promise,
    trigger: () => {
      resolve?.();
    },
    consume: () => {
      // 仅当当前 promise 已 resolved 时才创建新的
      // 这样 EVOLVE loop 消费完 trigger 后会分配新 promise 等待下一次事件
      promise = new Promise<void>((r) => { resolve = r; });
    },
  };
}

// ── Debounce 包装 ────────────────────────────────────────────────────────────

function createDebouncedTrigger(debounceMs: number): {
  trigger: () => void;
  getPromise: () => Promise<void>;
  consume: () => void;
} {
  let lastTrigger = 0;
  const tp = createTriggerPromise();

  return {
    trigger: () => {
      const now = Date.now();
      if (now - lastTrigger >= debounceMs) {
        lastTrigger = now;
        tp.trigger();
      }
    },
    getPromise: () => tp.getPromise(),
    consume: () => tp.consume(),
  };
}

// ── startEvolveLoop ──────────────────────────────────────────────────────────

export interface EvolveLoopController {
  abort: () => void;
}

/**
 * 启动 EVOLVE 协程。
 *
 * EVOLVE loop 是系统的统一 tick 来源：
 *   - 消费 EventBuffer 中的消息事件
 *   - 即使 buffer 为空也照常执行（维持心跳）
 *   - directed 消息 2s debounce 唤醒
 *   - 任意事件 30s debounce 唤醒
 *   - 自适应间隔根据 mode 和 api 动态调整
 */
export function startEvolveLoop(state: EvolveState): EvolveLoopController {
  const abortController = new AbortController();
  const { signal } = abortController;
  const logger = state.logger;

  // directed 唤醒（2s debounce）
  const directedTrigger = createDebouncedTrigger(DIRECTED_DEBOUNCE_MS);

  // 任意事件唤醒（30s debounce）
  const anyEventTrigger = createDebouncedTrigger(ANY_EVENT_DEBOUNCE_MS);

  // 注册 buffer 回调
  state.buffer.onDirected = (event) => {
    markDirected(state.modeState, event.timestamp || Date.now());
    directedTrigger.trigger();
  };

  state.buffer.onAnyEvent = () => {
    markAnyEvent(state.modeState, Date.now());
    anyEventTrigger.trigger();
  };

  // 启动异步循环
  runEvolveLoop(
    state,
    directedTrigger.getPromise,
    directedTrigger.consume,
    anyEventTrigger.getPromise,
    anyEventTrigger.consume,
    signal,
  ).catch((error) => {
    logger.error('Nova EVOLVE loop fatal error', error instanceof Error ? error.message : String(error));
  });

  return {
    abort: () => {
      abortController.abort();
      // 清除回调
      state.buffer.onDirected = null;
      state.buffer.onAnyEvent = null;
    },
  };
}

async function runEvolveLoop(
  state: EvolveState,
  getDirectedPromise: () => Promise<void>,
  consumeDirected: () => void,
  getAnyEventPromise: () => Promise<void>,
  consumeAnyEvent: () => void,
  signal: AbortSignal,
): Promise<void> {
  const logger = state.logger;
  let consecutiveErrors = 0;

  while (!signal.aborted && !state.queue.closed) {
    // ── 锁检查：系统忙时（thinking/speaking）跳过 tick，缓冲消息等待下一次 ──
    if (state.systemLock !== 'idle') {
      try {
        await Promise.race([
          sleep(500),
          getDirectedPromise(),
          getAnyEventPromise(),
          new Promise((_, reject) => {
            const onAbort = () => reject(new Error('aborted'));
            signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      } catch (err) {
        if (err instanceof Error && err.message === 'aborted') break;
      }
      consumeDirected();
      consumeAnyEvent();
      continue;
    }

    let tickStartMs = Date.now();
    // 清理上轮残留，避免本轮 silence 时误判为有 action
    state.lastEnqueuedAction = null;

    try {
      // 获取思考锁
      state.systemLock = 'thinking';

      // 执行一次 evolve tick
      void await state.evolveTickFn(state);

      // 如果决策 agent 决定回复/主动，等待 ACT 完成该 action
      // （evolveTickFn 内部可能已通过 applyPlan 重新赋值，用类型断言解除 null 缩窄）
      const enqueuedAction = state.lastEnqueuedAction as import('../act/action-queue').QueuedAction | null;
      if (enqueuedAction) {
        state.systemLock = 'speaking';
        await Promise.race([
          new Promise<void>((resolve) => {
            enqueuedAction._completionResolve = resolve;
          }),
          sleep(120_000), // 2 分钟安全超时，防止死锁
        ]);
        // 防止 double-fire（超时 + 完成信号竞态）
        enqueuedAction._completionResolve = undefined;
        // 重置计时：说话时间不计入思考间隔，确保下次 tick 前有最小等待窗口接收消息
        tickStartMs = Date.now();
      }

      state.systemLock = 'idle';

      // 安全网：如果 buffer 中还有未消费的事件（例如消息在 thinking 期间到达），
      // 强制跳过 sleep，立即进入下一轮 tick 消费它们
      const pendingEvents = state.buffer.length;

      // 成功，重置退避
      if (consecutiveErrors > 0) {
        const msSinceLastFailure = tickStartMs - state.llmBackoff.lastFailureMs;
        if (msSinceLastFailure > BACKOFF_RESET_MS) {
          consecutiveErrors = 0;
        }
      }

      // 使用最近压力快照中的 api 用于间隔计算
      const actualApi = state.pressureRef.current?.api ?? 0.5;

      // 静默检测（Task 6）
      const nowForPenalty = Date.now();
      const userSilenceSeconds = state.userActivity?.lastUserInputMs
        ? (nowForPenalty - state.userActivity.lastUserInputMs) / 1000
        : 0;
      const unansweredCount = state.userActivity?.consecutiveUnansweredProactive ?? 0;
      const penalty: SilencePenalty = { userSilenceSeconds, unansweredProactiveCount: unansweredCount };

      // 计算自适应间隔（带静默惩罚）
      const mode = state.modeState.current;
      const adaptiveInterval = state.clock.computeIntervalWithPenalty(actualApi, mode, penalty, {
        silencePenaltyStartSeconds: state.config.silencePenaltyStartSeconds,
        silenceMaxMultiplier: state.config.silenceMaxMultiplier,
        silenceUnansweredProactiveThreshold: state.config.silenceUnansweredProactiveThreshold,
      });

      // 极长时间静默 → 强制 dormant（Task 6.5）
      const userSilenceMinutes = userSilenceSeconds / 60;
      if (userSilenceMinutes > 30 && state.modeState.current !== 'dormant' && state.modeState.current !== 'wakeup') {
        state.modeState.current = 'dormant';
        state.modeState.ticksInMode = 0;
        state.modeState.enteredModeMs = Date.now();
        logger.info('Nova entered dormant mode due to prolonged user silence', {
          userSilenceMinutes: userSilenceMinutes.toFixed(1),
        });
      }

      // 自动停止检查（Task 3）
      const autoStopAt = state.config.autoStopAfterTick;
      if (autoStopAt && autoStopAt > 0 && state.clock.tick >= autoStopAt) {
        logger.info(`Nova auto-stop triggered at tick ${state.clock.tick} (limit: ${autoStopAt})`);
        state.autoStopTriggered = true;
        state.onAutoStop?.();
        break;
      }

      // 退避乘数
      const backoffMult = Math.min(16, Math.pow(2, consecutiveErrors));
      const backedOffInterval = adaptiveInterval * backoffMult;
      const remaining = Math.max(MIN_TICK_INTERVAL_MS, backedOffInterval);

      // 计算已经过去的 tick 耗时
      const elapsed = Date.now() - tickStartMs;
      // 有未消费事件时强制立即处理，不等间隔
      const waitMs = pendingEvents > 0 ? 0 : Math.max(0, remaining - elapsed);

      logger.debug('Nova EVOLVE loop waiting', {
        tick: state.clock.tick,
        mode,
        adaptiveInterval,
        backoffMult,
        waitMs,
        api: actualApi,
        pendingEvents,
      });

      // Promise.race: 等待休眠、directed 唤醒、任意事件唤醒、或 abort
      if (!signal.aborted) {
        // 即使 waitMs=0，也做一次极短的检查，给消息到达留窗口
        const effectiveWait = waitMs > 0 ? waitMs : 100;
        const sleepPromise = sleep(effectiveWait);
        const directedPromise = getDirectedPromise();
        const anyEventPromise = getAnyEventPromise();
        await Promise.race([
          sleepPromise,
          directedPromise,
          anyEventPromise,
          new Promise((_, reject) => {
            const onAbort = () => reject(new Error('aborted'));
            signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]).catch((err) => {
          if (err instanceof Error && err.message === 'aborted') {
            return;
          }
          throw err;
        });
        // 消费 trigger：分配新的 promise 等待下一次事件
        consumeDirected();
        consumeAnyEvent();
      }
    } catch (error) {
      state.systemLock = 'idle'; // 错误时释放锁

      if (error instanceof Error && error.message === 'aborted') {
        break;
      }

      consecutiveErrors = Math.min(MAX_CONSECUTIVE_ERRORS, consecutiveErrors + 1);
      state.llmBackoff.consecutiveFailures = consecutiveErrors;
      state.llmBackoff.lastFailureMs = Date.now();

      logger.warn('Nova EVOLVE tick failed', {
        error: error instanceof Error ? error.message : String(error),
        consecutiveErrors,
      });

      // 错误后短暂等待
      if (!signal.aborted) {
        const errorWaitMs = Math.min(MIN_TICK_INTERVAL_MS * Math.pow(2, consecutiveErrors), 60000);
        await sleep(errorWaitMs);
      }
    }
  }

  logger.info('Nova EVOLVE loop stopped');
}

