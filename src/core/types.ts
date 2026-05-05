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

  // ── Tick 控制（新增：对齐 Alice TickClock）─────────────────────────────────

  /** TickClock dtMin 覆盖（毫秒），默认 1000。 */
  tickDtMin?: number;
  /** TickClock dtMax 覆盖（毫秒），默认 300000。 */
  tickDtMax?: number;
  /** TickClock kappaT 覆盖，默认 1.0。 */
  tickKappaT?: number;

  // ── EventBuffer（新增）────────────────────────────────────────────────────

  /** EventBuffer 最大容量，默认 1000。 */
  eventBufferMaxSize?: number;
  /** EventBuffer protected 区最大容量（directed 消息），默认 100。 */
  eventBufferMaxProtected?: number;

  // ── EVOLVE（新增）─────────────────────────────────────────────────────────

  /** 最小 tick 间隔（毫秒），默认 3000。 */
  minTickIntervalMs?: number;

  // ── ACT（新增）────────────────────────────────────────────────────────────

  /** 最大并发 engagement 数，默认 3。 */
  maxConcurrentEngagements?: number;
  /** 目标切换成本（毫秒），默认 1500。 */
  switchCostMs?: number;
  /** 陈旧性检查阈值（L2 距离），默认 0.5。 */
  stalenessThreshold?: number;
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
  platform: string;
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
