//
// Nova ACT Loop — 行动执行闭环，对齐 Alice runtime/src/engine/react/orchestrator.ts
//
// 架构变更：
//   旧：单行动 FIFO 消费，每个 tick 处理一个 action
//   新：多 slot 交错调度，支持：
//     - 最多 MAX_CONCURRENT_ENGAGEMENTS 个 slot
//     - 阻塞 dequeue（第一个 slot）+ 非阻塞 tryDequeue（后续 slot）
//     - Staleness check
//     - Switch cost
//     - Watcher 机制
//     - 完整的 engagement 生命周期

import type { NovaLogger } from '../core/logger';
import type { NovaRuntimeConfig } from '../core/types';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { GateDecision } from '../gates/gates';
import {
  evaluateProactiveEnabledGate,
  evaluateWhitelistGate,
  evaluateQQRisk,
  SILENCE_REASONS,
} from '../gates/gates';
import type { RateLimitState } from '../gates/rate-limit';
import type { ChannelAttrs } from '../world/entities';
import type { NovaWorldRepository } from '../world/repository';
import type { WorldModel } from '../world/model';
import { qqIdFromNodeId } from '../world/constants';
import { ActionQueue, type QueuedAction } from './action-queue';
import {
  EngagementSM,
  MAX_CONCURRENT_ENGAGEMENTS,
  SWITCH_COST_MS,
} from './engagement';
import type { SendResult } from './types';
import type { NovaEventBuffer } from '../core/event-buffer';
import {
  initSlot,
  selectNextEngagement,
  stalenessCheck,
  cleanupDoneSlots,
  countActiveSlots,
  hasSlotForTarget,
  type EngagementSlot,
  type SessionOutcome,
  type SchedulerContext,
} from './scheduler';

// ── ActLoop context (legacy, 仍由 evaluatePreSendGates 使用) ──────────────────

export interface ActLoopContext {
  actionQueue: ActionQueue;
  world: WorldModel;
  repository: NovaWorldRepository;
  config: NovaRuntimeConfig;
  rateLimit: RateLimitState;
  logger: NovaLogger;
}

// ── Act executor ─────────────────────────────────────────────────────────────

export type ActExecutor = (
  action: QueuedAction,
  channel: ChannelAttrs | undefined,
) => Promise<SendResult>;

// ── ACT Context (new) ────────────────────────────────────────────────────────

export interface ActContext {
  client: unknown; // PluginBridge — 发送消息的桥接
  G: WorldModel;
  repository: NovaWorldRepository;
  config: NovaRuntimeConfig;
  queue: ActionQueue;
  buffer: NovaEventBuffer;
  rateLimit: RateLimitState;
  personality: { diligence: number; curiosity: number; sociability: number; caution: number };
  logger: NovaLogger;
  getCurrentTick: () => number;
  getCurrentPressures: () => PressureSnapshot;
  recordAction: (action: string, target: string | null) => void;
  reportLLMOutcome: (success: boolean) => void;
}

// ── startActLoop ─────────────────────────────────────────────────────────────

export interface ActLoopController {
  promise: Promise<void>;
  abort: () => void;
}

/**
 * 启动 ACT 协程（独立于 EVOLVE loop）。
 *
 * ACT loop 负责：
 *   - 从 ActionQueue 出队
 *   - 交错调度多个 engagement slot
 *   - 执行 subcycle（LLM 生成 + 发送）
 *   - 管理 engagement 生命周期
 */
export function startActLoop(
  ctx: ActContext,
  execute: ActExecutor,
): ActLoopController {
  const abortController = new AbortController();

  const promise = runActLoop(ctx, execute, abortController.signal);

  return {
    promise,
    abort: () => abortController.abort(),
  };
}

async function runActLoop(
  ctx: ActContext,
  execute: ActExecutor,
  signal: AbortSignal,
): Promise<void> {
  const logger = ctx.logger;
  const maxSlots = MAX_CONCURRENT_ENGAGEMENTS;

  // 活跃 slot 列表
  let activeSlots: EngagementSlot[] = [];
  const pendingFinalizations: Promise<void>[] = [];

  logger.info('Nova ACT loop started', { maxSlots });

  while (!signal.aborted && !ctx.queue.closed) {
    try {
      // 先清理 watcher 已完成的 slot，释放 target lock，避免后续同 target 消息被误丢。
      activeSlots = await cleanupDoneSlots(
        createSchedulerContext(ctx),
        activeSlots,
        pendingFinalizations,
      );

      // ── Step 1: 吸收新条目 ──────────────────────────────────────────────
      // 第一个 slot: 阻塞 dequeue
      if (countActiveSlots(activeSlots) < maxSlots) {
        const item = await ctx.queue.dequeue();
        if (item) {
          // 获取 target 锁
          const targetId = item.candidate.targetId ?? '';
          if (targetId && !ctx.queue.acquireTarget(targetId)) {
            // target 已被锁定，放回队列末尾等待 watcher/finalize 释放锁，不能丢弃。
            ctx.queue.requeue(item);
            activeSlots = await cleanupDoneSlots(
              createSchedulerContext(ctx),
              activeSlots,
              pendingFinalizations,
            );
            continue;
          }

          // Staleness check
          const currentPressure = ctx.getCurrentPressures();
          const { stale } = stalenessCheck(
            item.pressureSnapshot,
            currentPressure,
            ctx.config.minProactiveUtility,
          );

          if (stale) {
            logger.info('Nova ACT loop dropped stale action', {
              queueId: item.id,
              targetId: item.candidate.targetId,
              enqueuedAt: item.enqueuedMs,
            });
            ctx.queue.markComplete(targetId);
            if (item._completionResolve) {
              item._completionResolve();
              item._completionResolve = undefined;
            }
            continue;
          }

          // 跳过已在活跃 slot 中的 target
          if (hasSlotForTarget(activeSlots, targetId)) {
            ctx.queue.markComplete(targetId);
            if (item._completionResolve) {
              item._completionResolve();
              item._completionResolve = undefined;
            }
            continue;
          }

          // 创建新 slot
          const newSlot = initSlot(item, Date.now());
          activeSlots.push(newSlot);

          logger.info('Nova ACT loop absorbed new engagement', {
            sessionId: newSlot.session.id,
            queueId: item.id,
            targetId: item.candidate.targetId,
            action: item.candidate.action,
            activeSlots: countActiveSlots(activeSlots),
          });
        }
      }

      // 后续 slot: 非阻塞 tryDequeue
      while (countActiveSlots(activeSlots) < maxSlots) {
        const item = ctx.queue.tryDequeue();
        if (!item) break;

        const targetId = item.candidate.targetId ?? '';
        if (targetId && !ctx.queue.acquireTarget(targetId)) {
          ctx.queue.requeue(item);
          break;
        }

        const currentPressure = ctx.getCurrentPressures();
        const { stale } = stalenessCheck(
          item.pressureSnapshot,
          currentPressure,
          ctx.config.minProactiveUtility,
        );

        if (stale) {
          ctx.queue.markComplete(targetId);
          if (item._completionResolve) {
            item._completionResolve();
            item._completionResolve = undefined;
          }
          continue;
        }

        if (hasSlotForTarget(activeSlots, targetId)) {
          ctx.queue.markComplete(targetId);
          if (item._completionResolve) {
            item._completionResolve();
            item._completionResolve = undefined;
          }
          continue;
        }

        const newSlot = initSlot(item, Date.now());
        activeSlots.push(newSlot);
      }

      // ── Step 3: 选择下一个 ready engagement ────────────────────────────
      const nextSlot = selectNextEngagement(activeSlots);
      if (!nextSlot) {
        // 没有 ready 的 slot，如果也没有活跃 slot，短暂等待
        if (activeSlots.length === 0) {
          await sleep(500);
        } else {
          await sleep(1000);
        }
        continue;
      }

      // ── Step 4: Switch cost ────────────────────────────────────────────
      await enforceSwitchCost(nextSlot);

      // ── Step 5: 执行 subcycle ──────────────────────────────────────────
      nextSlot.state = 'running';
      nextSlot.session.state = 'running';
      nextSlot.session.lastActiveMs = Date.now();

      let outcome: SessionOutcome;
      try {
        outcome = await executeSubcycle(ctx, nextSlot, execute);
      } catch (error) {
        logger.warn('Nova ACT subcycle error', {
          sessionId: nextSlot.session.id,
          error: error instanceof Error ? error.message : String(error),
        });
        outcome = 'terminal';
      }

      nextSlot.session.outcome = outcome;

      // Signal EVOLVE that this specific action has been processed
      const completedItem = nextSlot.item;
      if (completedItem._completionResolve) {
        completedItem._completionResolve();
        completedItem._completionResolve = undefined;
      }

      // ── Step 6: 根据 outcome 分支 ──────────────────────────────────────
      switch (outcome) {
        case 'terminal':
        case 'empty':
        case 'resting':
        case 'fed_up':
        case 'cooling_down':
        case 'waiting_reply':
        case 'watching':
          nextSlot.state = 'done';
          nextSlot.session.state = 'done';
          break;
      }

      // ── Step 7: 清理 done slots ────────────────────────────────────────
      activeSlots = await cleanupDoneSlots(
        createSchedulerContext(ctx),
        activeSlots,
        pendingFinalizations,
      );

      // 背景清理 pending finalizations
      if (pendingFinalizations.length > 5) {
        await Promise.all(pendingFinalizations.splice(0));
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'aborted') {
        break;
      }
      logger.warn('Nova ACT loop iteration error', error instanceof Error ? error.message : String(error));
      await sleep(1000);
    }
  }

  // 清理
  for (const slot of activeSlots) {
    if (slot.item.candidate.targetId) {
      ctx.queue.markComplete(slot.item.candidate.targetId);
    }
  }
  await Promise.all(pendingFinalizations);
  activeSlots = [];

  logger.info('Nova ACT loop stopped');
}

// ── executeSubcycle ──────────────────────────────────────────────────────────

async function executeSubcycle(
  ctx: ActContext,
  slot: EngagementSlot,
  execute: ActExecutor,
): Promise<SessionOutcome> {
  const logger = ctx.logger;
  const item = slot.item;
  const candidate = item.candidate;
  const targetId = candidate.targetId ?? '';

  // 解析 channel
  const channel = targetId ? resolveChannel(ctx.G, targetId) : undefined;

  // 观察质量门控：如果 channel 没有新消息，可能终止
  const lastEventMs = channel?.last_incoming_ms ?? channel?.last_activity_ms;
  if (lastEventMs) {
    const idleMs = Date.now() - lastEventMs;
    if (idleMs > 30 * 60 * 1000) {
      logger.info('Nova subcycle dropped: channel idle > 30min', { targetId, idleMs: Math.round(idleMs / 60000) + 'min', lastEventMs, channelId: channel?.id });
      return 'resting';
    }
  }

  // 标记执行
  ctx.queue.markExecuting(item.id, Date.now());
  logger.info('Nova subcycle executing action', { queueId: item.id, actionType: candidate.action, targetId, kind: item.kind, hasChannel: channel != null });

  // 执行（LLM 生成 + 发送）
  let sendResult: SendResult;
  try {
    sendResult = await execute(item, channel);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    ctx.rateLimit.recordSendFailure();
    logger.warn('Nova subcycle execution failed', { queueId: item.id, error: errMsg });
    return 'terminal';
  }

  // 记录结果
  if (sendResult.ok) {
    ctx.rateLimit.recordAllowedAction(Date.now());
    ctx.repository.markNovaAction(sendResult.targetId, Date.now(), {
      proactive: true,
      text: sendResult.text,
      desireType: candidate.desireType,
      urgency: candidate.urgency,
    });
    ctx.repository.recordAction({
      tick: item.tick,
      action_type: 'proactive_send_text',
      target_id: sendResult.targetId,
      text: sendResult.text ?? '',
      status: 'success',
      created_ms: Date.now(),
    });

    // 更新 engagement
    const contactId = resolveContactId(ctx.G, targetId);
    slot.session.engagement = EngagementSM.create({
      channelId: sendResult.targetId,
      contactId,
      kind: 'proactive_action',
      proactiveActionId: item.id,
      nowMs: Date.now(),
    });

    logger.info('Nova subcycle executed', {
      queueId: item.id,
      targetId: sendResult.targetId,
      messageId: sendResult.messageId,
    });

    return 'waiting_reply';
  }

  // 发送失败
  ctx.rateLimit.recordSendFailure();
  ctx.repository.recordAction({
    tick: item.tick,
    action_type: 'proactive_send_text',
    target_id: sendResult.targetId,
    text: sendResult.text ?? '',
    status: 'failed',
    error: sendResult.error ?? 'unknown',
    created_ms: Date.now(),
  });

  logger.warn('Nova subcycle send failed', {
    queueId: item.id,
    error: sendResult.error,
  });

  return 'terminal';
}

function createSchedulerContext(ctx: ActContext): SchedulerContext {
  return {
    queue: {
      dequeue: () => ctx.queue.dequeue(),
      tryDequeue: () => ctx.queue.tryDequeue(),
      markComplete: (target: string) => ctx.queue.markComplete(target),
    },
    buffer: ctx.buffer,
    logger: ctx.logger,
    getCurrentPressures: ctx.getCurrentPressures,
    stalenessThreshold: ctx.config.minProactiveUtility,
    switchCostMs: SWITCH_COST_MS,
    maxConcurrentEngagements: MAX_CONCURRENT_ENGAGEMENTS,
    executeSubcycle: async () => 'terminal',
    recordAction: ctx.recordAction,
    reportLLMOutcome: ctx.reportLLMOutcome,
  };
}

// ── Pre-send gate re-check ───────────────────────────────────────────────────

export function evaluatePreSendGates(
  ctx: ActLoopContext,
  targetId: string | null,
  scene: 'private' | 'group' | undefined,
  nowMs: number,
): GateDecision {
  const proactiveGate = evaluateProactiveEnabledGate(ctx.config);
  if (proactiveGate) return proactiveGate;

  if (!ctx.config.enableScheduledActions) {
    return {
      allow: false, level: 'hard',
      reason: SILENCE_REASONS.SCHEDULED_ACTIONS_DISABLED,
      reasons: [SILENCE_REASONS.SCHEDULED_ACTIONS_DISABLED],
      values: { enableScheduledActions: false },
    };
  }

  if (scene === 'private' && targetId) {
    const contactQQ = resolveTargetQQForPreSend(ctx.world, targetId);
    const whitelistGate = evaluateWhitelistGate(targetId, contactQQ, ctx.config.proactiveWhitelistQQ);
    if (whitelistGate) return whitelistGate;
  }

  if (ctx.rateLimit.hasFailureBackoff(ctx.config)) {
    return {
      allow: false, level: 'safety', reason: SILENCE_REASONS.SEND_FAILURE_RISK,
      reasons: [SILENCE_REASONS.SEND_FAILURE_RISK], values: {},
    };
  }

  const qqRisk = evaluateQQRisk({
    nowMs, reason: 'scheduled',
    pressure: { p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0, p7: 0, p8: 0, pProspect: 0, api: 0, apiPeak: 0, tick: 0, createdMs: nowMs, contributions: {} },
    voice: { selected: 'diligence' as const, iausAction: 'diligence' as const, loudness: { diligence: 0, curiosity: 0, sociability: 0, caution: 0 }, fatigue: { diligence: 0, curiosity: 0, sociability: 0, caution: 0 }, probabilities: { diligence: 1, curiosity: 0, sociability: 0, caution: 0 }, temperature: 1, reasons: [] },
    config: ctx.config, rateLimit: ctx.rateLimit,
    lambdaMultiplier: 1.0,
  } as Parameters<typeof evaluateQQRisk>[0]);
  if (!qqRisk.pass) {
    return { allow: false, level: qqRisk.level, reason: qqRisk.reason, reasons: [qqRisk.reason], values: qqRisk.values };
  }

  if (targetId && ctx.world.has(targetId) && ctx.world.getNodeType(targetId) === 'channel') {
    const channel = ctx.world.getChannel(targetId);
    const lastActionMs = channel.last_nova_action_ms;
    if (lastActionMs !== undefined && lastActionMs > 0) {
      const cooldownMs = channel.chat_type === 'group' ? ctx.config.groupCooldownMs : ctx.config.privateCooldownMs;
      const elapsedMs = nowMs - lastActionMs;
      if (elapsedMs < cooldownMs) {
        return {
          allow: false, level: 'hard', reason: SILENCE_REASONS.ACTIVE_COOLING,
          reasons: [SILENCE_REASONS.ACTIVE_COOLING],
          values: { elapsedMs, cooldownMs, lastNovaActionMs: lastActionMs },
        };
      }
    }
  }

  return { allow: true, level: 'none', reason: SILENCE_REASONS.ALLOWED, reasons: [SILENCE_REASONS.ALLOWED], values: {} };
}

// ── Build NovaAction from QueuedAction ───────────────────────────────────────

export function queuedActionToSendTarget(queued: QueuedAction, channel: ChannelAttrs | undefined) {
  const candidate = queued.candidate;
  const targetId = candidate.targetId ?? '';
  const scene = candidate.scene ?? (channel?.chat_type ?? 'private');

  if (scene === 'group') {
    const groupId = channel?.group_id ?? qqIdFromNodeId(targetId);
    return { chatType: 'group' as const, groupId, channelId: channel?.id ?? targetId, userId: undefined };
  }

  const userId = channel?.chat_type === 'private'
    ? qqIdFromNodeId(channel.id)
    : targetId.startsWith('qq:user:')
      ? qqIdFromNodeId(targetId)
      : targetId.startsWith('qq:private:')
        ? qqIdFromNodeId(targetId)
        : undefined;
  const channelId = channel?.chat_type === 'private'
    ? channel.id
    : userId
      ? `qq:private:${userId}`
      : targetId;
  return { chatType: 'private' as const, userId, channelId, groupId: undefined };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enforceSwitchCost(slot: EngagementSlot): Promise<void> {
  const elapsed = Date.now() - slot.session.lastActiveMs;
  if (elapsed < SWITCH_COST_MS) {
    await sleep(SWITCH_COST_MS - elapsed);
  }
}

function resolveChannel(world: WorldModel, targetId: string): ChannelAttrs | undefined {
  if (!world.has(targetId)) return undefined;
  if (world.getNodeType(targetId) === 'channel') return world.getChannel(targetId);
  return undefined;
}

function resolveContactId(world: WorldModel, targetId: string | null): string | null {
  if (!targetId) return null;
  if (!world.has(targetId)) return null;
  const nodeType = world.getNodeType(targetId);
  if (nodeType === 'contact') return targetId;
  if (nodeType === 'channel') {
    const channel = world.getChannel(targetId);
    if (channel.chat_type === 'private') {
      const contactId = `qq:user:${qqIdFromNodeId(targetId)}`;
      if (world.has(contactId) && world.getNodeType(contactId) === 'contact') return contactId;
    }
  }
  return null;
}

function resolveTargetQQForPreSend(world: WorldModel, targetId: string): string | null {
  if (!world.has(targetId)) return null;
  const nodeType = world.getNodeType(targetId);
  if (nodeType === 'contact') return world.getContact(targetId).qq;
  if (nodeType === 'channel') {
    const channel = world.getChannel(targetId);
    if (channel.chat_type === 'private') return qqIdFromNodeId(targetId);
    return null;
  }
  return null;
}

// ── Re-export ────────────────────────────────────────────────────────────────

export { MAX_CONCURRENT_ENGAGEMENTS };
export { EngagementSM } from './engagement';
export type { EngagementRecord } from './engagement';
