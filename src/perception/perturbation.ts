//
// NovaPerturbation — 扰动类型定义，对齐 Alice 的 GraphPerturbation
//
// 每个进入系统的事件（消息、编辑、反应等）被标准化为 NovaPerturbation，
// 推入 EventBuffer 供 EVOLVE loop 批量消费。

import type { NovaMessageEvent } from '../core/types';

export interface NovaPerturbation {
  /** 扰动类型。 */
  type: 'new_message' | 'edit_message' | 'reaction' | 'typing' | 'other';
  /** 来源频道 ID（Nova 内部节点 ID）。 */
  channelId: string;
  /** 发送者 ID（Nova 内部节点 ID，可选）。 */
  senderId?: string;
  /** 是否为 directed 消息（@提及 / 回复 Nova / 私聊）。 */
  isDirected: boolean;
  /** 是否为已有活跃会话的延续（对方在 Nova 发言后回复）。 */
  isContinuation: boolean;
  /** 推入时的 tick 序号（由 EventBuffer.push 设置）。 */
  tick: number;
  /** 事件发生的时间戳（毫秒）。 */
  timestamp: number;
  /** 原始 NovaMessageEvent 引用。 */
  event: NovaMessageEvent;
}

/**
 * 从 NovaMessageEvent 构造 NovaPerturbation。
 * tick 由 EventBuffer.push 填充。
 */
export function toPerturbation(event: NovaMessageEvent): NovaPerturbation {
  return {
    type: 'new_message',
    channelId: event.chatId,
    senderId: event.senderId,
    isDirected: event.isDirected,
    isContinuation: false, // 由 EventBuffer 或 Perceive 后续设置
    tick: 0,
    timestamp: event.timestamp || Date.now(),
    event,
  };
}
