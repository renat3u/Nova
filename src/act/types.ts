import type { NovaAction } from '../core/types';

export type { NovaAction };

export type NovaActionType = NovaAction['type'];
export type SendTextAction = Extract<NovaAction, { type: 'send_text' }>;
export type SilenceAction = Extract<NovaAction, { type: 'silence' }>;

export interface SendTextTarget {
  chatType: 'private' | 'group';
  userId?: string;
  groupId?: string;
  channelId: string;
}

export interface SendTextOptions {
  quoteMessageId?: string;
  quoteReply?: boolean;
  maxReplyLength?: number;
}

export interface SendResult {
  ok: boolean;
  actionType: 'send_text';
  targetId: string;
  messageId?: string;
  text?: string;
  warning?: string;
  error?: string;
  createdMs: number;
}
