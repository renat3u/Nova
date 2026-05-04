export type SilenceLevel = 'none' | 'soft' | 'normal' | 'hard' | 'safety';
export type IAUSScoringMode = 'legacy_nsv' | 'consideration';

// ── Agent gateway config types ─────────────────────────────────────────────

export type GatewayMode = 'algorithmic' | 'agent';
export type GuardrailMode = 'off' | 'soft' | 'hard';

export interface DecisionAgentConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs?: number;
  responseFormat: 'json_object';
  failMode: 'fallback_algorithmic' | 'silence' | 'allow_reply_only';
}

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
  proactiveEnabled: boolean;
  proactiveWhitelistQQ: string[];
  iausScoringMode: IAUSScoringMode;
  minProactiveUtility: number;
  groupMinProactiveUtility: number;
  iausCompensationFactor: number;
  socialSafetyMidpoint: number;
  socialSafetySlope: number;
  iausDesireBoost?: number;
  iausMomentumBonus?: number;
  iausMomentumDecayMs?: number;
  iausCurveModulationStrength?: number;
  iausThompsonEta?: number;
  iausFairnessAlpha?: number;
  iausFairnessMax?: number;
  iausFairnessMinTotalService?: number;

  /** Gateway mode: 'algorithmic' uses old gates; 'agent' uses LLM decision agent. */
  gatewayMode: GatewayMode;

  /** Decision agent LLM configuration, independent from the main reply LLM. */
  decisionAgent: DecisionAgentConfig;

  /**
   * Code guardrail mode for agent decisions.
   * off: do not block agent decisions with old gates.
   * soft: record guardrail violations but allow execution.
   * hard: block decisions that violate guardrails.
   * Default: off.
   */
  decisionGuardrails: GuardrailMode;

  /**
   * Whether ActLoop performs pre-send gate recheck for queued proactive actions.
   * Default: false for agent gateway.
   */
  enablePreSendGuardrails: boolean;

  /**
   * Whether old algorithmic gates should still be evaluated for trace/audit.
   * Does not block unless decisionGuardrails === 'hard'.
   * Default: true.
   */
  auditAlgorithmicGates: boolean;
}

export interface NovaStickerRef {
  emojiPackageId: number;
  emojiId: string;
  key: string;
  summary?: string;
  url?: string;
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
  /** Nova-formatted contact node IDs (qq:user:xxx) of third-party contacts @-mentioned in the message. */
  mentionedContactIds?: string[];
  /** Stickers / mface images found in this message. */
  stickers?: NovaStickerRef[];
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
      /** Optional sticker to send alongside the text. */
      sticker?: NovaStickerRef;
    }
  | {
      type: 'silence';
      reason: string;
      level: Exclude<SilenceLevel, 'none'>;
    };
