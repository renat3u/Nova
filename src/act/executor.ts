import type { NovaAction } from '../core/types';
import type { NapCatPluginContext } from '../plugin/types';
import type { SendTextOptions } from './types';
import { sendText } from '../plugin/actions/send-message';
import { InMemoryActionLog } from './action-log';

export interface ExecuteActionsOptions {
  ctx: NapCatPluginContext;
  actionLog: InMemoryActionLog;
  quoteReply: boolean;
  maxReplyLength: number;
  defaultTargetId?: string;
}

export async function executeNovaActions(
  actions: NovaAction[],
  options: ExecuteActionsOptions,
): Promise<void> {
  for (const action of actions) {
    if (action.type === 'send_text') {
      const sendOptions: SendTextOptions = {
        quoteMessageId: action.quoteMessageId,
        quoteReply: options.quoteReply,
        maxReplyLength: options.maxReplyLength,
      };
      const result = await sendText(action.target, action.text, { ...sendOptions, ctx: options.ctx });
      options.actionLog.recordSend(result);
      continue;
    }

    options.actionLog.recordSilence({
      targetId: options.defaultTargetId ?? 'unknown',
      reason: action.reason,
      level: action.level,
    });
  }
}
