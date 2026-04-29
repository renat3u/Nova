import type { NovaMessageEvent, NovaRuntimeConfig, SilenceLevel } from '../core/types';
import type { ChannelAttrs } from '../world/entities';

export interface GroupPolicyDecision {
  allow: boolean;
  level: Exclude<SilenceLevel, 'none'>;
  reason: string;
  values: Record<string, unknown>;
}

export function evaluateGroupPolicy(input: {
  event?: NovaMessageEvent;
  channel?: ChannelAttrs;
  config: NovaRuntimeConfig;
}): GroupPolicyDecision | null {
  const { event, channel, config } = input;
  const chatType = event?.chatType ?? channel?.chat_type;
  if (chatType !== 'group') return null;

  const directed = event?.isDirected === true;
  const mentionedSelf = event?.mentionedSelf === true;
  const repliedToSelf = event?.repliedToSelf === true;

  if (directed || mentionedSelf || repliedToSelf) return null;
  if (!config.replyInGroupOnlyWhenMentioned) return null;

  return {
    allow: false,
    level: 'normal',
    reason: 'group_observe_only',
    values: {
      replyInGroupOnlyWhenMentioned: config.replyInGroupOnlyWhenMentioned,
      directed,
      mentionedSelf,
      repliedToSelf,
    },
  };
}
