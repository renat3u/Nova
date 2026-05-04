import type { NovaMessageEvent } from '../core/types';
import type { DirectedState } from './directed';
import { determineDirected } from './directed';
import { extractMessageText, extractStickers } from './message-text';

export interface OneBotSenderLike {
  user_id?: string | number;
  nickname?: string;
  card?: string;
}

export interface OneBotMessageEventLike {
  post_type?: string;
  message_type?: 'private' | 'group' | string;
  message_id?: string | number;
  message_seq?: string | number;
  real_id?: string | number;
  user_id?: string | number;
  self_id?: string | number;
  group_id?: string | number;
  group_name?: string;
  sender?: OneBotSenderLike;
  raw_message?: string;
  message?: unknown;
  time?: string | number;
}

export interface NormalizeMessageOptions {
  selfId?: string;
  repliedToSelf?: boolean;
  directedState: DirectedState;
}

export function normalizeMessageEvent(
  rawEvent: OneBotMessageEventLike,
  options: NormalizeMessageOptions,
): NovaMessageEvent | null {
  const chatType = rawEvent.message_type === 'group'
    ? 'group'
    : rawEvent.message_type === 'private'
      ? 'private'
      : null;
  if (chatType === null) return null;

  const senderQQ = stringifyId(rawEvent.user_id ?? rawEvent.sender?.user_id);
  if (!senderQQ) return null;

  const rawMessageId = rawEvent.message_id ?? rawEvent.message_seq ?? rawEvent.real_id;
  if (rawMessageId === undefined) return null;

  const groupId = chatType === 'group' ? stringifyId(rawEvent.group_id) : undefined;
  if (chatType === 'group' && !groupId) return null;

  const senderId = `qq:user:${senderQQ}`;
  const chatId = chatType === 'private' ? `qq:private:${senderQQ}` : `qq:group:${groupId}`;
  const messageId = `qq:message:${String(rawMessageId)}`;
  const timestamp = normalizeTimestamp(rawEvent.time);
  const textParts = extractMessageText(rawEvent.message, rawEvent.raw_message, options.selfId);
  const stickerParts = extractStickers(rawEvent.message);
  const isSelf = options.selfId !== undefined && senderQQ === options.selfId;
  const repliedToSelf = options.repliedToSelf ?? Boolean(textParts.replyToMessageId && rawReplyMentionsSelf(rawEvent, options.selfId));
  const isDirected = determineDirected(
    {
      chatType,
      chatId,
      senderId,
      mentionedSelf: textParts.mentionedSelf,
      repliedToSelf,
      timestamp,
    },
    options.directedState,
  );

  return {
    id: `${chatId}:${messageId}`,
    platform: 'qq',
    rawEvent,
    messageId,
    rawMessageId,
    chatType,
    chatId,
    ...(groupId === undefined ? {} : { groupId }),
    ...(rawEvent.group_name === undefined ? {} : { groupName: rawEvent.group_name }),
    senderId,
    senderQQ,
    ...(resolveSenderName(rawEvent.sender) === undefined ? {} : { senderName: resolveSenderName(rawEvent.sender) }),
    text: textParts.text,
    rawText: textParts.rawText,
    timestamp,
    isSelf,
    mentionedSelf: textParts.mentionedSelf,
    repliedToSelf,
    isDirected,
    ...(textParts.replyToMessageId === undefined ? {} : { replyToMessageId: `qq:message:${textParts.replyToMessageId}` }),
    ...(textParts.mentionedContactQQs && textParts.mentionedContactQQs.length > 0
      ? { mentionedContactIds: [...new Set(textParts.mentionedContactQQs)].map((qq) => `qq:user:${qq}`) }
      : {}),
    ...(stickerParts.length > 0 ? { stickers: stickerParts.map((s) => ({
      emojiPackageId: s.emojiPackageId,
      emojiId: s.emojiId,
      key: s.key,
      ...(s.summary === undefined ? {} : { summary: s.summary }),
      ...(s.url === undefined ? {} : { url: s.url }),
    })) } : {}),
  };
}

function stringifyId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  return Date.now();
}

function resolveSenderName(sender: OneBotSenderLike | undefined): string | undefined {
  if (!sender) return undefined;
  const card = typeof sender.card === 'string' ? sender.card.trim() : '';
  if (card.length > 0) return card;
  const nickname = typeof sender.nickname === 'string' ? sender.nickname.trim() : '';
  return nickname.length > 0 ? nickname : undefined;
}

function rawReplyMentionsSelf(rawEvent: OneBotMessageEventLike, selfId: string | undefined): boolean {
  if (!selfId) return false;

  const raw = rawEvent.raw_message;
  if (typeof raw !== 'string' || raw.length === 0) return false;
  return raw.includes(`qq=${selfId}`) || raw.includes(`@${selfId}`);
}
