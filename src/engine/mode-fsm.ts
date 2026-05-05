//
// Mode FSM — AgentMode 状态机，对齐 Alice runtime/src/engine/evolve.ts 的 transitionMode
//
// 状态转换规则：
//   wakeup → (wakeupTicksElapsed >= 6) → patrol
//   patrol → (API 持续高) → conversation
//   patrol → (API 持续低 + 长时间无事件) → dormant
//   dormant → (收到 directed 消息) → wakeup
//   conversation → (无活跃对话) → patrol

import type { AgentMode } from '../core/tick-clock';

export interface ModeState {
  current: AgentMode;
  /** 当前模式已持续的 tick 数。 */
  ticksInMode: number;
  /** 进入当前模式时的系统时间戳（毫秒）。 */
  enteredModeMs: number;
  /** 最近一次收到 directed 消息的时间戳。 */
  lastDirectedMs: number;
  /** 最近一次收到任意消息事件的时间戳。 */
  lastAnyEventMs: number;
  /** API 压力滑动窗口（最近 N 个 tick 的 api 值）。 */
  apiHistory: number[];
}

export interface ModeFsmConfig {
  /** wakeup 阶段持续 tick 数（达到后进入 patrol）。 */
  wakeupTicks: number;
  /** 从 patrol 进入 dormant 需要连续低 API 的 tick 数。 */
  dormantLowApiTicks: number;
  /** API 低于此阈值视为"低"。 */
  lowApiThreshold: number;
  /** API 高于此阈值视为"高"（触发 conversation）。 */
  highApiThreshold: number;
  /** 从 patrol 进入 conversation 需要连续高 API 的 tick 数。 */
  conversationHighApiTicks: number;
  /** 从 conversation 回退 patrol：无活跃对话的毫秒数。 */
  conversationIdleMs: number;
  /** 最近一次 directed 消息后的毫秒内视为尚有活跃对话。 */
  conversationActiveWindowMs: number;
  /** apiHistory 滑动窗口大小。 */
  apiHistorySize: number;
}

export const DEFAULT_MODE_FSM_CONFIG: ModeFsmConfig = {
  wakeupTicks: 6,
  dormantLowApiTicks: 5,
  lowApiThreshold: 0.05,
  highApiThreshold: 0.3,
  conversationHighApiTicks: 3,
  conversationIdleMs: 5 * 60_000,
  conversationActiveWindowMs: 10 * 60_000,
  apiHistorySize: 10,
};

export function createModeState(nowMs: number = Date.now()): ModeState {
  return {
    current: 'wakeup',
    ticksInMode: 0,
    enteredModeMs: nowMs,
    lastDirectedMs: 0,
    lastAnyEventMs: nowMs,
    apiHistory: [],
  };
}

/**
 * 根据当前状态和输入信号推进 AgentMode。
 * 返回更新后的 ModeState（会修改传入的 state）。
 */
export function transitionMode(
  state: ModeState,
  api: number,
  nowMs: number,
  config: ModeFsmConfig = DEFAULT_MODE_FSM_CONFIG,
): AgentMode {
  // 更新滑动窗口
  state.apiHistory.push(api);
  if (state.apiHistory.length > config.apiHistorySize) {
    state.apiHistory.shift();
  }

  state.ticksInMode += 1;

  const prev = state.current;

  switch (prev) {
    case 'wakeup': {
      if (state.ticksInMode >= config.wakeupTicks) {
        state.current = 'patrol';
        state.ticksInMode = 0;
        state.enteredModeMs = nowMs;
      }
      break;
    }
    case 'patrol': {
      // 长时间无事件 + 持续低 API → dormant
      const idleMs = nowMs - state.lastAnyEventMs;
      const lowApiCount = state.apiHistory.filter((v) => v < config.lowApiThreshold).length;
      if (idleMs > config.conversationIdleMs && lowApiCount >= config.dormantLowApiTicks) {
        state.current = 'dormant';
        state.ticksInMode = 0;
        state.enteredModeMs = nowMs;
        break;
      }
      // 持续高 API → conversation
      const highApiCount = state.apiHistory.filter((v) => v > config.highApiThreshold).length;
      if (highApiCount >= config.conversationHighApiTicks) {
        state.current = 'conversation';
        state.ticksInMode = 0;
        state.enteredModeMs = nowMs;
      }
      break;
    }
    case 'conversation': {
      // 最近有 directed 消息则保持
      const directedRecent = nowMs - state.lastDirectedMs < config.conversationActiveWindowMs;
      if (!directedRecent) {
        const idleMs = nowMs - state.lastAnyEventMs;
        if (idleMs > config.conversationIdleMs) {
          state.current = 'patrol';
          state.ticksInMode = 0;
          state.enteredModeMs = nowMs;
        }
      }
      break;
    }
    case 'consolidation': {
      // consolidation → patrol（单次 tick 后回退）
      state.current = 'patrol';
      state.ticksInMode = 0;
      state.enteredModeMs = nowMs;
      break;
    }
    case 'dormant': {
      // 收到 directed 消息 → 唤醒
      if (state.lastDirectedMs > state.enteredModeMs) {
        state.current = 'wakeup';
        state.ticksInMode = 0;
        state.enteredModeMs = nowMs;
      }
      break;
    }
  }

  return state.current;
}

/**
 * 标记收到 directed 消息。
 */
export function markDirected(state: ModeState, nowMs: number): void {
  state.lastDirectedMs = nowMs;
  state.lastAnyEventMs = nowMs;
}

/**
 * 标记收到任意消息事件。
 */
export function markAnyEvent(state: ModeState, nowMs: number): void {
  state.lastAnyEventMs = nowMs;
}
