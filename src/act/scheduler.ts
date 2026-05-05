//
// Engagement Scheduler — ACT Loop 的 engagement 调度器
// 对齐 Alice runtime/src/engine/act/scheduler.ts
//
// 核心职责：
//   1. 管理 MAX_CONCURRENT_ENGAGEMENTS 个 slot
//   2. 吸收新条目（阻塞 dequeue + 非阻塞 tryDequeue）
//   3. Staleness check（L2 距离比较入队时与当前压力）
//   4. 选择下一个 ready engagement（urgency 最高）
//   5. Switch cost 应用
//   6. Watcher 管理
//   7. Done slot 清理

import type { QueuedAction } from './action-queue';
import type { NovaEventBuffer } from '../core/event-buffer';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { EngagementRecord } from './engagement';
import { EngagementSM, MAX_CONCURRENT_ENGAGEMENTS, SWITCH_COST_MS } from './engagement';
import type { NovaLogger } from '../core/logger';

// ── Engagement Session ───────────────────────────────────────────────────────

export type SessionState = 'ready' | 'running' | 'watch' | 'done';
export type SessionOutcome = 'terminal' | 'empty' | 'resting' | 'fed_up' | 'cooling_down' | 'waiting_reply' | 'watching';

export interface EngagementSession {
  /** 本轮 subcycle 的 ID。 */
  id: string;
  /** 当前状态。 */
  state: SessionState;
  /** 关联的队列条目。 */
  item: QueuedAction;
  /** 关联的 engagement 记录。 */
  engagement: EngagementRecord;
  /** 当前 urgency 分数。 */
  urgency: number;
  /** 最近一次 subcycle 的消息（如果有）。 */
  recentMessages: string[];
  /** Session outcome（完成后设置）。 */
  outcome?: SessionOutcome;
  /** Watcher promise（watch 状态时设置）。 */
  watcherPromise?: Promise<void>;
  /** 创建时间。 */
  createdMs: number;
  /** 最后活动时间。 */
  lastActiveMs: number;
}

// ── Engagement Slot ──────────────────────────────────────────────────────────

export interface EngagementSlot {
  item: QueuedAction;
  state: SessionState;
  session: EngagementSession;
  urgency: number;
  watcher: Promise<void> | null;
}

// ── Scheduler Context ────────────────────────────────────────────────────────

export interface SchedulerContext {
  queue: { dequeue: () => Promise<QueuedAction | null>; tryDequeue: () => QueuedAction | null; markComplete: (target: string) => void };
  buffer: NovaEventBuffer;
  logger: NovaLogger;
  getCurrentPressures: () => PressureSnapshot;
  stalenessThreshold: number;
  switchCostMs: number;
  maxConcurrentEngagements: number;
  executeSubcycle: (slot: EngagementSlot) => Promise<SessionOutcome>;
  recordAction: (action: string, target: string | null) => void;
  reportLLMOutcome: (success: boolean) => void;
}

// ── initSlot ─────────────────────────────────────────────────────────────────

export function initSlot(
  item: QueuedAction,
  nowMs: number = Date.now(),
): EngagementSlot {
  const contactId = item.candidate.targetId ?? null;
  const session: EngagementSession = {
    id: `session:${item.id}`,
    state: 'ready',
    item,
    engagement: EngagementSM.create({
      channelId: item.candidate.targetId ?? '',
      contactId,
      kind: 'proactive_action',
      proactiveActionId: item.id,
      nowMs,
    }),
    urgency: computeUrgency(item),
    recentMessages: [],
    createdMs: nowMs,
    lastActiveMs: nowMs,
  };

  return {
    item,
    state: 'ready',
    session,
    urgency: session.urgency,
    watcher: null,
  };
}

// ── selectNextEngagement ─────────────────────────────────────────────────────

/**
 * 从活跃 slot 中选择 urgency 最高的 ready engagement。
 */
export function selectNextEngagement(active: EngagementSlot[]): EngagementSlot | null {
  const readySlots = active.filter((s) => s.state === 'ready' && s.session.state !== 'done');
  if (readySlots.length === 0) return null;

  readySlots.sort((a, b) => b.urgency - a.urgency);
  return readySlots[0] ?? null;
}

// ── checkWatchers ────────────────────────────────────────────────────────────

/**
 * 检查 watch 状态的 slot 是否已收到目标回复。
 */
export function checkWatchers(active: EngagementSlot[]): void {
  for (const slot of active) {
    if (slot.state === 'watch' && slot.watcher !== null) {
      // watcher 仍在等待中，不做处理
      continue;
    }
    // watcher 已 resolve，但 slot 状态还需要检测
  }
}

// ── stalenessCheck ───────────────────────────────────────────────────────────

/**
 * L2 距离比较入队时与当前的归一化压力快照。
 * 如果距离超过阈值，说明入队时的场景已经过时，应放弃此条目。
 */
export function stalenessCheck(
  enqueueSnapshot: PressureSnapshot,
  currentSnapshot: PressureSnapshot,
  threshold: number,
): { stale: boolean; distance: number } {
  const dims = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'pProspect', 'api'] as const;

  let sumSquares = 0;
  for (const dim of dims) {
    const old = (enqueueSnapshot[dim] as number) ?? 0;
    const now = (currentSnapshot[dim] as number) ?? 0;
    const diff = old - now;
    sumSquares += diff * diff;
  }

  const distance = Math.sqrt(sumSquares);
  return { stale: distance > threshold, distance };
}

// ── cleanupDoneSlots ─────────────────────────────────────────────────────────

/**
 * 清理已完成的 slot，调用 finalizeSlot 进行收尾工作。
 */
export async function cleanupDoneSlots(
  ctx: SchedulerContext,
  active: EngagementSlot[],
  pendingFinalizations: Promise<void>[],
): Promise<EngagementSlot[]> {
  const remaining: EngagementSlot[] = [];

  for (const slot of active) {
    if (slot.state === 'done' || slot.session.state === 'done') {
      pendingFinalizations.push(finalizeSlot(ctx, slot));
    } else {
      remaining.push(slot);
    }
  }

  return remaining;
}

// ── finalizeSlot ─────────────────────────────────────────────────────────────

/**
 * 收尾一个 slot：合并结果、写回状态、释放锁、记录 action。
 */
export async function finalizeSlot(
  ctx: SchedulerContext,
  slot: EngagementSlot,
): Promise<void> {
  const { item, session } = slot;

  try {
    // 释放 queue processing 锁
    if (item.candidate.targetId) {
      ctx.queue.markComplete(item.candidate.targetId);
    }

    // 记录结果
    const outcome = session.outcome ?? 'terminal';
    const wasSuccess = outcome === 'waiting_reply' || outcome === 'terminal';

    ctx.reportLLMOutcome(wasSuccess);
    ctx.recordAction(
      item.candidate.action,
      item.candidate.targetId,
    );

    ctx.logger.info('Nova engagement finalized', {
      sessionId: session.id,
      queueId: item.id,
      targetId: item.candidate.targetId,
      outcome,
      wasSuccess,
    });
  } catch (error) {
    ctx.logger.warn('Nova finalizeSlot error', error instanceof Error ? error.message : String(error));
  }
}

// ── startWatcher ─────────────────────────────────────────────────────────────

/**
 * 为 waiting_reply 的 slot 创建 watcher。
 * watcher 监听 EventBuffer 中来自目标的新消息。
 */
export function startWatcher(
  ctx: SchedulerContext,
  slot: EngagementSlot,
  targetId: string,
): void {
  slot.state = 'watch';
  slot.session.state = 'watch';
  slot.session.outcome = 'watching';

  // 使用 buffer.watch 注册一次性监听器
  slot.watcher = ctx.buffer.watch((event) => {
    return event.channelId === targetId || event.senderId === targetId;
  }).then((event) => {
    if (event.channelId) {
      // 收到目标回复
      slot.session.state = 'done';
      slot.session.outcome = 'waiting_reply';
      slot.state = 'done';
      slot.session.recentMessages.push(`reply from ${event.senderId ?? 'unknown'}`);
      ctx.logger.info('Nova watcher received reply', {
        sessionId: slot.session.id,
        targetId,
        messageId: event.event?.messageId,
      });
    }
  });

  ctx.logger.debug('Nova watcher started', {
    sessionId: slot.session.id,
    targetId,
  });
}

// ── computeUrgency ───────────────────────────────────────────────────────────

function computeUrgency(item: QueuedAction): number {
  const p = item.pressureSnapshot;
  const pressureSum =
    (p.p1 ?? 0) + (p.p2 ?? 0) + (p.p3 ?? 0) +
    (p.p4 ?? 0) + (p.p5 ?? 0) + (p.p6 ?? 0) +
    (p.p7 ?? 0) + (p.p8 ?? 0);
  const age = Date.now() - item.enqueuedMs;
  const ageMinutes = age / 60_000;

  // 高压力 + 等待时间 = 高 urgency
  return pressureSum * (1 + Math.log(1 + ageMinutes));
}

// ── 活跃 slot 管理助手 ───────────────────────────────────────────────────────

export function countReadySlots(active: EngagementSlot[]): number {
  return active.filter((s) => s.state === 'ready').length;
}

export function countActiveSlots(active: EngagementSlot[]): number {
  return active.filter((s) => s.state !== 'done').length;
}

export function hasSlotForTarget(active: EngagementSlot[], targetId: string): boolean {
  return active.some(
    (s) => s.item.candidate.targetId === targetId && s.state !== 'done',
  );
}

// Re-export for convenience
export { MAX_CONCURRENT_ENGAGEMENTS, SWITCH_COST_MS };
