//
// Nova 表情包发送函数
//
// 通过 NapCat OneBot send_msg API 发送 mface segment。
// 发送 mface 不需要上传文件、不需要额外权限。
// 四个字段 (emoji_package_id, emoji_id, key, summary) 填对即可。
//

import type { SendResult } from '../act/types';
import type { NapCatPluginContext } from '../plugin/types';

export interface SendStickerOptions {
  emojiPackageId: number;
  emojiId: string;
  key: string;
  summary?: string;
}

interface OneBotMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

/** 发送纯贴纸到私聊（无文本） */
export async function sendPrivateSticker(
  ctx: NapCatPluginContext,
  userId: string,
  sticker: SendStickerOptions,
): Promise<SendResult> {
  const targetId = `qq:private:${userId}`;
  const createdMs = Date.now();

  const message: OneBotMessageSegment[] = [buildMfaceSegment(sticker)];

  return callSendSticker(ctx, targetId, {
    message_type: 'private',
    user_id: userId,
    message,
  }, createdMs);
}

/** 发送纯贴纸到群聊（无文本） */
export async function sendGroupSticker(
  ctx: NapCatPluginContext,
  groupId: string,
  sticker: SendStickerOptions,
): Promise<SendResult> {
  const targetId = `qq:group:${groupId}`;
  const createdMs = Date.now();

  const message: OneBotMessageSegment[] = [buildMfaceSegment(sticker)];

  return callSendSticker(ctx, targetId, {
    message_type: 'group',
    group_id: groupId,
    message,
  }, createdMs);
}

/**
 * 发送组合消息：文本 + 表情。
 * OneBot 消息格式：
 * [
 *   { type: 'text', data: { text: '...' } },
 *   { type: 'mface', data: { emoji_package_id: ..., emoji_id: '...', key: '...', summary: '...' } }
 * ]
 */
export async function sendTextWithSticker(
  ctx: NapCatPluginContext,
  target: { chatType: 'private' | 'group'; userId?: string; groupId?: string; channelId: string },
  text: string,
  sticker: SendStickerOptions,
): Promise<SendResult> {
  const createdMs = Date.now();

  const message: OneBotMessageSegment[] = [
    { type: 'text', data: { text } },
    buildMfaceSegment(sticker),
  ];

  const params: Record<string, unknown> = {
    message_type: target.chatType,
    message,
  };

  if (target.chatType === 'private' && target.userId) {
    params.user_id = target.userId;
  } else if (target.chatType === 'group' && target.groupId) {
    params.group_id = target.groupId;
  }

  try {
    const result = await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
    const messageId = extractMessageId(result);

    return {
      ok: true,
      actionType: 'send_text',
      targetId: target.channelId,
      messageId,
      text,
      createdMs,
    };
  } catch (error) {
    const errorMessage = sanitizeError(error);
    ctx.logger.warn(`Nova sendTextWithSticker failed for ${target.channelId}: ${errorMessage}`);

    // Fallback: try sending just the text without sticker
    ctx.logger.info(`Nova sendTextWithSticker fallback: sending text only to ${target.channelId}`);
    try {
      const fallbackParams: Record<string, unknown> = {
        message_type: target.chatType,
        message: text,
      };
      if (target.chatType === 'private' && target.userId) {
        fallbackParams.user_id = target.userId;
      } else if (target.chatType === 'group' && target.groupId) {
        fallbackParams.group_id = target.groupId;
      }
      const fallbackResult = await ctx.actions.call('send_msg', fallbackParams, ctx.adapterName, ctx.pluginManager.config);
      const fallbackMessageId = extractMessageId(fallbackResult);

      return {
        ok: true,
        actionType: 'send_text',
        targetId: target.channelId,
        messageId: fallbackMessageId,
        text,
        warning: `sticker send failed, fallback to text only: ${errorMessage}`,
        createdMs,
      };
    } catch (fallbackError) {
      return {
        ok: false,
        actionType: 'send_text',
        targetId: target.channelId,
        text,
        error: sanitizeError(fallbackError),
        createdMs,
      };
    }
  }
}

function buildMfaceSegment(sticker: SendStickerOptions): OneBotMessageSegment {
  return {
    type: 'mface',
    data: {
      emoji_package_id: sticker.emojiPackageId,
      emoji_id: sticker.emojiId,
      key: sticker.key,
      summary: sticker.summary ?? '',
    },
  };
}

async function callSendSticker(
  ctx: NapCatPluginContext,
  targetId: string,
  params: Record<string, unknown>,
  createdMs: number,
): Promise<SendResult> {
  try {
    const result = await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
    const messageId = extractMessageId(result);

    return {
      ok: true,
      actionType: 'send_text',
      targetId,
      messageId,
      createdMs,
    };
  } catch (error) {
    const errorMessage = sanitizeError(error);
    ctx.logger.warn(`Nova sticker send failed for ${targetId}: ${errorMessage}`);

    return {
      ok: false,
      actionType: 'send_text',
      targetId,
      error: errorMessage,
      createdMs,
    };
  }
}

function extractMessageId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;

  const data = isRecord(value.data) ? value.data : value;
  const messageId = data.message_id;

  if (typeof messageId === 'string') return messageId;
  if (typeof messageId === 'number') return String(messageId);
  return undefined;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[-_ ]?key|authorization|token|secret)(["'\s:=]+)[^\s,"'}]+/gi, '$1$2[redacted]')
    .slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
