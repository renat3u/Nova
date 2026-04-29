export type SilenceLevel = 'none' | 'soft' | 'normal' | 'hard' | 'safety';

export interface NovaRuntimeConfig {
  enabled: boolean;
  debug: boolean;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  replyInGroupOnlyWhenMentioned: boolean;
  enablePrivateChat: boolean;
  enableGroupChat: boolean;
  enabledGroups: Record<string, { enabled: boolean }>;
  quoteReply: boolean;
  maxReplyLength: number;
  dbPath: string;
  minApiToSpeak: number;
  directedMinApiToSpeak: number;
  privateCooldownMs: number;
  groupCooldownMs: number;
  globalRateLimitPerMinute: number;
  channelRateLimitPerMinute: number;
  groupRateLimitPerMinute: number;
  enableScheduledActions: boolean;
  floodWindowMs: number;
  floodMessageLimit: number;
  userFloodMessageLimit: number;
  consecutiveSendFailureLimit: number;
}

export interface NovaMessageEvent {
  id: string;
  platform: 'qq';
  rawEvent: unknown;
  messageId: string;
  rawMessageId: string | number;
  chatType: 'private' | 'group';
  chatId: string;
  groupId?: string;
  groupName?: string;
  senderId: string;
  senderQQ: string;
  senderName?: string;
  text: string;
  rawText: string;
  timestamp: number;
  isSelf: boolean;
  mentionedSelf: boolean;
  repliedToSelf: boolean;
  isDirected: boolean;
  replyToMessageId?: string;
}

export type NovaAction =
  | {
      type: 'send_text';
      target: {
        chatType: 'private' | 'group';
        userId?: string;
        groupId?: string;
        channelId: string;
      };
      text: string;
      quoteMessageId?: string;
    }
  | {
      type: 'silence';
      reason: string;
      level: Exclude<SilenceLevel, 'none'>;
    };
