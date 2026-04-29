import type { NovaAction, NovaMessageEvent } from '../../core/types';
import type { SendTextOptions } from '../../act/types';
import { extractMessageText } from '../../perception/message-text';
import { normalizeMessageEvent, type OneBotMessageEventLike } from '../../perception/mapper';
import { sendText } from '../actions/send-message';
import type { NapCatPluginContext } from '../types';
import { novaPluginState } from '../state';

export async function handleMessage(ctx: NapCatPluginContext, rawEvent: OneBotMessageEventLike): Promise<void> {
  const runtime = novaPluginState.runtime;
  if (!runtime?.isRunning) {
    novaPluginState.loggerInstance?.debug('Nova ignored message because runtime is not running');
    ctx.logger.debug('Nova ignored message because runtime is not running');
    return;
  }

  const textParts = extractMessageText(rawEvent.message, rawEvent.raw_message, novaPluginState.selfId);
  const repliedToSelf = await resolveRepliedToSelf(ctx, textParts.replyToMessageId);
  const event = normalizeMessageEvent(rawEvent, {
    selfId: novaPluginState.selfId,
    repliedToSelf,
    directedState: novaPluginState.directedState,
  });

  if (!event) {
    novaPluginState.loggerInstance?.debug('Nova ignored unsupported message event');
    ctx.logger.debug('Nova ignored unsupported message event');
    return;
  }

  if (event.isSelf) {
    onSelfMessage(event);
    novaPluginState.loggerInstance?.debug(`Nova ignored self message: ${event.messageId}`);
    ctx.logger.debug(`Nova ignored self message: ${event.messageId}`);
    return;
  }

  if (novaPluginState.dedupe.isDuplicate(event)) {
    novaPluginState.loggerInstance?.debug(`Nova ignored duplicate message: ${event.messageId}`);
    ctx.logger.debug(`Nova ignored duplicate message: ${event.messageId}`);
    return;
  }

  if (!isChatEnabled(event)) {
    novaPluginState.loggerInstance?.debug(`Nova ignored disabled chat message: ${event.chatId}`);
    ctx.logger.debug(`Nova ignored disabled chat message: ${event.chatId}`);
    return;
  }

  const actions = await runtime.handleMessage(event);
  novaPluginState.stats.processedMessages += 1;

  novaPluginState.loggerInstance?.info('Nova message bridge processed event', {
    messageId: event.messageId,
    chatType: event.chatType,
    chatId: event.chatId,
    senderId: event.senderId,
    directed: event.isDirected,
    actionCount: actions.length,
  });

  if (actions.length > 0) {
    await executeActions(ctx, event, actions);
  }
}

function isChatEnabled(event: NovaMessageEvent): boolean {
  const config = novaPluginState.config;

  if (event.chatType === 'private') return config.enablePrivateChat;
  if (!config.enableGroupChat) return false;

  const groupId = event.groupId;
  if (!groupId) return false;

  const groupConfig = config.enabledGroups[groupId];
  return groupConfig?.enabled !== false;
}


function onSelfMessage(event: NovaMessageEvent): void {
  if (event.chatType === 'group') {
    novaPluginState.directedState.rememberNovaAction(event.chatId, undefined, event.timestamp);
  }
}

async function resolveRepliedToSelf(ctx: NapCatPluginContext, replyToMessageId: string | undefined): Promise<boolean | undefined> {
  if (!replyToMessageId || !novaPluginState.selfId) return undefined;

  try {
    const result = await ctx.actions.call(
      'get_msg',
      { message_id: replyToMessageId },
      ctx.adapterName,
      ctx.pluginManager.config,
    );

    const senderId = extractSenderId(result);
    return senderId === undefined ? undefined : senderId === novaPluginState.selfId;
  } catch (error) {
    ctx.logger.debug('Nova could not resolve replied message sender:', error);
    return undefined;
  }
}

function extractSenderId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;

  const data = isRecord(value.data) ? value.data : value;
  const sender = isRecord(data.sender) ? data.sender : undefined;
  const userId = sender?.user_id ?? data.user_id;

  if (typeof userId === 'string') return userId;
  if (typeof userId === 'number') return String(userId);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function executeActions(ctx: NapCatPluginContext, event: NovaMessageEvent, actions: NovaAction[]): Promise<void> {
  for (const action of actions) {
    if (action.type === 'send_text') {
      const options: SendTextOptions = {
        quoteMessageId: action.quoteMessageId,
        quoteReply: novaPluginState.config.quoteReply,
        maxReplyLength: novaPluginState.config.maxReplyLength,
      };
      const result = await sendText(action.target, action.text, { ...options, ctx });
      novaPluginState.actionLog.recordSend(result);
      novaPluginState.runtime?.recordActionResult({
        actionType: result.actionType,
        targetId: result.targetId,
        text: result.text,
        status: result.ok ? 'success' : 'failed',
        error: result.error,
        createdMs: result.createdMs,
      });

      if (result.ok) {
        novaPluginState.directedState.rememberNovaAction(event.chatId, event.senderId);
        novaPluginState.loggerInstance?.debug(`Nova sent text action to ${result.targetId}${result.messageId ? ` message_id=${result.messageId}` : ''}`);
        ctx.logger.debug(`Nova sent text action to ${result.targetId}${result.messageId ? ` message_id=${result.messageId}` : ''}`);
      } else {
        novaPluginState.loggerInstance?.warn(`Nova send_text action failed for ${result.targetId}: ${result.error}`);
        ctx.logger.warn(`Nova send_text action failed for ${result.targetId}: ${result.error}`);
      }
      continue;
    }

    novaPluginState.actionLog.recordSilence({
      targetId: event.chatId,
      reason: action.reason,
      level: action.level,
    });
    novaPluginState.loggerInstance?.debug(`Nova silence action recorded for ${event.chatId}: ${action.reason}`);
    ctx.logger.debug(`Nova silence action recorded for ${event.chatId}: ${action.reason}`);
  }
}
