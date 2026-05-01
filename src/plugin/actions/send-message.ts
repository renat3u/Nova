import type { SendResult, SendTextOptions, SendTextTarget } from '../../act/types';
import type { NapCatPluginContext } from '../types';

interface SendMessageOptions extends SendTextOptions {
  ctx: NapCatPluginContext;
}

interface OneBotMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

type OneBotMessage = string | OneBotMessageSegment[];

interface PreparedText {
  ok: boolean;
  text?: string;
  warning?: string;
  error?: string;
}

export async function sendPrivateText(
  ctx: NapCatPluginContext,
  userId: string | number,
  text: string,
  options: SendTextOptions = {},
): Promise<SendResult> {
  const targetId = `qq:private:${String(userId)}`;
  const createdMs = Date.now();
  const prepared = prepareText(text, options.maxReplyLength);

  if (!prepared.ok || prepared.text === undefined) {
    return failedResult(targetId, prepared.error ?? 'invalid text', createdMs);
  }

  return callSendMsg(ctx, targetId, {
    message_type: 'private',
    user_id: String(userId),
    message: buildMessage(prepared.text, options),
  }, prepared.text, prepared.warning, createdMs);
}

export async function sendGroupText(
  ctx: NapCatPluginContext,
  groupId: string | number,
  text: string,
  options: SendTextOptions = {},
): Promise<SendResult> {
  const targetId = `qq:group:${String(groupId)}`;
  const createdMs = Date.now();
  const prepared = prepareText(text, options.maxReplyLength);

  if (!prepared.ok || prepared.text === undefined) {
    return failedResult(targetId, prepared.error ?? 'invalid text', createdMs);
  }

  return callSendMsg(ctx, targetId, {
    message_type: 'group',
    group_id: String(groupId),
    message: buildMessage(prepared.text, options),
  }, prepared.text, prepared.warning, createdMs);
}

export async function sendText(
  target: SendTextTarget,
  text: string,
  options: SendMessageOptions,
): Promise<SendResult> {
  if (target.chatType === 'private') {
    if (!target.userId) {
      return failedResult(target.channelId, 'send_text target missing userId', Date.now());
    }

    return sendPrivateText(options.ctx, target.userId, text, options);
  }

  if (!target.groupId) {
    return failedResult(target.channelId, 'send_text target missing groupId', Date.now());
  }

  return sendGroupText(options.ctx, target.groupId, text, options);
}

function prepareText(text: string, maxReplyLength?: number): PreparedText {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'send_text text is empty' };
  }

  if (hasNovaIdentityResidue(trimmed)) {
    return { ok: false, error: 'send_text text contains Alice identity residue' };
  }

  const limit = normalizeMaxReplyLength(maxReplyLength);
  if (limit !== undefined && trimmed.length > limit) {
    return {
      ok: true,
      text: trimmed.slice(0, limit),
      warning: `send_text truncated from ${trimmed.length} to ${limit} characters`,
    };
  }

  return { ok: true, text: trimmed };
}

function normalizeMaxReplyLength(maxReplyLength: number | undefined): number | undefined {
  if (maxReplyLength === undefined) return undefined;
  if (!Number.isFinite(maxReplyLength)) return undefined;
  return Math.max(1, Math.trunc(maxReplyLength));
}

function hasNovaIdentityResidue(text: string): boolean {
  return /(?:我是|我叫|这里是|This is|I am|I'm|my name is)\s*Alice\b/i.test(text)
    || /\bAlice\s*(?:在这里|为你|should|will|can)/i.test(text);
}

function buildMessage(text: string, options: SendTextOptions): OneBotMessage {
  if (!options.quoteReply || !options.quoteMessageId) return text;

  return [
    { type: 'reply', data: { id: String(options.quoteMessageId) } },
    { type: 'text', data: { text } },
  ];
}

async function callSendMsg(
  ctx: NapCatPluginContext,
  targetId: string,
  params: Record<string, unknown>,
  text: string,
  warning: string | undefined,
  createdMs: number,
): Promise<SendResult> {
  if (warning) ctx.logger.warn(`Nova ${warning}`);

  try {
    const result = await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
    return {
      ok: true,
      actionType: 'send_text',
      targetId,
      messageId: extractMessageId(result),
      text,
      warning,
      createdMs,
    };
  } catch (error) {
    const errorMessage = sanitizeError(error);
    ctx.logger.warn(`Nova send_msg failed for ${targetId}: ${errorMessage}`);

    if (params.message !== text) {
      return callSendMsg(ctx, targetId, { ...params, message: text }, text, 'quote reply failed; fallback to plain text', createdMs);
    }

    return {
      ok: false,
      actionType: 'send_text',
      targetId,
      text,
      warning,
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

function failedResult(targetId: string, error: string, createdMs: number): SendResult {
  return {
    ok: false,
    actionType: 'send_text',
    targetId,
    error,
    createdMs,
  };
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
