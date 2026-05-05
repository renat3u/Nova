//
// Perceive Module — 感知 tick，对齐 Alice runtime/src/engine/perceive.ts
//
// perceiveTick() 批量消费 EventBuffer 中的事件，更新 WorldModel 图，
// 更新联系人 recv_window，衰减 consecutive_act_silences，生成感知 fact。

import type { WorldModel } from '../world/model';
import type { NovaWorldRepository } from '../world/repository';
import type { NovaEventBuffer, EventBufferDrainResult } from '../core/event-buffer';
import type { NovaPerturbation } from '../perception/perturbation';
import type { NovaLogger } from '../core/logger';
import { noopLogger } from '../core/logger';
import { conversationIdForChannel } from '../world/constants';

export interface PerceiveResult {
  /** 本轮消费的事件数量。 */
  eventCount: number;
  /** 本轮消费的实际事件列表。 */
  events: NovaPerturbation[];
  /** 本轮丢弃的普通事件数。 */
  droppedCount: number;
  /** 本轮丢弃的 directed 事件数。 */
  droppedDirectedCount: number;
  /** 按 channel 统计的事件数量。 */
  channelCounts: Map<string, number>;
}

export interface PerceiveOptions {
  /** 日志器。 */
  logger?: NovaLogger;
  /** 高活跃频道自动创建 observation fact 的事件数阈值。 */
  highActivityThreshold?: number;
}

const DEFAULT_HIGH_ACTIVITY_THRESHOLD = 5;

/**
 * 执行一次感知 tick：
 * 1. 从 buffer drain 所有事件
 * 2. 将每个事件应用到 WorldModel（批量更新）
 * 3. 更新联系人的 recv_window
 * 4. 衰减 consecutive_act_silences
 * 5. 对高活跃频道创建 observation fact
 */
export function perceiveTick(
  G: WorldModel,
  repository: NovaWorldRepository,
  buffer: NovaEventBuffer,
  tick?: number,
  options: PerceiveOptions = {},
): PerceiveResult {
  const logger = options.logger ?? noopLogger;
  const threshold = options.highActivityThreshold ?? DEFAULT_HIGH_ACTIVITY_THRESHOLD;

  const { events, droppedCount, droppedDirectedCount }: EventBufferDrainResult = buffer.drain();

  // 记录丢弃告警
  if (droppedCount > 0 || droppedDirectedCount > 0) {
    logger.warn('Nova EventBuffer dropped events', {
      droppedCount,
      droppedDirectedCount,
      currentTick: tick,
    });
  }

  // 批量应用扰动到 WorldModel
  const channelCounts = applyPerturbations(G, repository, events, logger);

  // 对高活跃频道创建 observation fact
  createPerceiveFacts(G, repository, channelCounts, threshold, Date.now());

  return {
    eventCount: events.length,
    events,
    droppedCount,
    droppedDirectedCount,
    channelCounts,
  };
}

// ── 内部函数 ─────────────────────────────────────────────────────────────────

/**
 * 批量应用扰动到 WorldModel。
 * 对每个事件：
 *   - 调用 repository.applyMessageEvent 更新基础状态
 *   - 递增联系人的 recv_window
 *   - 递减对方的 consecutive_act_silences（对方发消息说明没有沉默）
 *   - 更新 isContinuation 标记（如果对方在 Nova 最近发言后回复）
 */
function applyPerturbations(
  G: WorldModel,
  repository: NovaWorldRepository,
  events: NovaPerturbation[],
  logger: NovaLogger,
): Map<string, number> {
  const channelCounts = new Map<string, number>();

  for (const p of events) {
    const event = p.event;
    const channelId = p.channelId;

    // 统计 channel 事件数
    channelCounts.set(channelId, (channelCounts.get(channelId) ?? 0) + 1);

    // 应用消息到世界模型
    try {
      repository.applyMessageEvent(event);
    } catch (err) {
      logger.warn('Nova perceive failed to apply message event', {
        messageId: event.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 更新联系人 recv_window（递增接收窗口）
    if (event.senderId) {
      updateContactRecvWindow(G, event.senderId);
    }

    // 衰减对方的 consecutive_act_silences（对方发消息 = 交流恢复）
    if (event.senderId && event.chatId) {
      decayActSilences(G, event.senderId, event.chatId);
    }

    // 检查 isContinuation：如果此 channel 上 Nova 最近发过消息，则为延续
    if (
      G.has(channelId) &&
      G.getNodeType(channelId) === 'channel'
    ) {
      const channel = G.getChannel(channelId);
      const lastNovaMs = channel.last_nova_action_ms;
      if (lastNovaMs !== undefined && lastNovaMs > 0) {
        const elapsed = (event.timestamp || Date.now()) - lastNovaMs;
        if (elapsed < 24 * 60 * 60 * 1000) {
          p.isContinuation = true;
        }
      }
    }
  }

  return channelCounts;
}

/**
 * 递增联系人的 recv_window 计数。
 * 使用 contact_recv_window (ChannelAttrs) 或 contact.recv_window 动态字段。
 */
function updateContactRecvWindow(G: WorldModel, senderId: string): void {
  if (!G.has(senderId)) return;
  const nodeType = G.getNodeType(senderId);
  if (nodeType !== 'contact') return;

  const contact = G.getContact(senderId);
  // recv_window 可能在 contact 上作为动态属性
  const c = contact as unknown as Record<string, unknown>;
  const currentWindow = (c.recv_window as number) ?? 0;
  c.recv_window = currentWindow + 1;
}

/**
 * 对方发消息时递减 consecutive_act_silences。
 * 表示交流恢复，沉默计数衰减。
 */
function decayActSilences(G: WorldModel, _senderId: string, channelId: string): void {
  const conversationId = conversationIdForChannel(channelId);
  if (!G.has(conversationId)) return;
  if (G.getNodeType(conversationId) !== 'conversation') return;

  const conv = G.getConversation(conversationId);
  const c = conv as unknown as Record<string, unknown>;
  const currentSilences = (c.consecutive_act_silences as number) ?? 0;
  if (currentSilences > 0) {
    c.consecutive_act_silences = Math.floor(currentSilences / 2);
  }
}

/**
 * 对高活跃频道创建 observation fact。
 * 当某个 channel 在本轮 tick 中累积的事件数超过阈值时，
 * 标记此 channel 为"活跃"，供后续 desire 生成参考。
 */
function createPerceiveFacts(
  _G: WorldModel,
  repository: NovaWorldRepository,
  channelCounts: Map<string, number>,
  threshold: number,
  nowMs: number,
): void {
  for (const [channelId, count] of channelCounts) {
    if (count >= threshold) {
      // 记录高活跃频道标记
      try {
        repository.setRuntimeState(`high_activity:${channelId}`, {
          eventCount: count,
          detectedAt: nowMs,
        }, nowMs);
      } catch {
        // 静默处理
      }
    }
  }
}
