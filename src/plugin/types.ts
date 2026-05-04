import type { GatewayMode, GuardrailMode, IAUSScoringMode } from '../core/types';

export type NovaCoreMode = 'embedded';

export interface NovaGroupConfig {
  enabled: boolean;
}

export interface NovaDecisionAgentConfig {
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

export interface NovaPluginConfig {
  enabled: boolean;
  debug: boolean;
  coreMode: NovaCoreMode;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  replyInGroupOnlyWhenMentioned: boolean;
  enablePrivateChat: boolean;
  enableGroupChat: boolean;
  enabledGroups: Record<string, NovaGroupConfig>;
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
  proactiveEnabled: boolean;
  proactiveWhitelistQQ: string[];
  iausScoringMode: IAUSScoringMode;
  minProactiveUtility: number;
  groupMinProactiveUtility: number;
  iausCompensationFactor: number;
  socialSafetyMidpoint: number;
  socialSafetySlope: number;
  iausDesireBoost: number;
  iausMomentumBonus: number;
  iausMomentumDecayMs: number;
  iausCurveModulationStrength: number;
  iausThompsonEta: number;
  iausFairnessAlpha: number;
  iausFairnessMax: number;
  iausFairnessMinTotalService: number;
  floodWindowMs: number;
  floodMessageLimit: number;
  userFloodMessageLimit: number;
  consecutiveSendFailureLimit: number;

  /** Gateway mode: 'algorithmic' uses old gates; 'agent' uses LLM decision agent. */
  gatewayMode: GatewayMode;

  /** Decision agent LLM configuration, independent from the main reply LLM. */
  decisionAgent: NovaDecisionAgentConfig;

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

export interface NovaPluginStats {
  startedAt: number | null;
  processedMessages: number;
}

export interface NovaApiResponse<T = unknown> {
  code: number;
  message?: string;
  data?: T;
}

export interface PluginConfigItem {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'multi-select' | 'html' | 'text';
  label: string;
  description?: string;
  default?: unknown;
  options?: { label: string; value: string | number }[];
  reactive?: boolean;
  hidden?: boolean;
}

export type PluginConfigSchema = PluginConfigItem[];

export interface PluginConfigBuilder {
  text(key: string, label: string, defaultValue?: string, description?: string, reactive?: boolean): PluginConfigItem;
  number(key: string, label: string, defaultValue?: number, description?: string, reactive?: boolean): PluginConfigItem;
  boolean(key: string, label: string, defaultValue?: boolean, description?: string, reactive?: boolean): PluginConfigItem;
  html(content: string): PluginConfigItem;
  plainText(content: string): PluginConfigItem;
  combine(...items: PluginConfigItem[]): PluginConfigSchema;
}

export interface PluginLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface PluginHttpRequest {
  body: unknown;
  params: Record<string, string>;
}

export interface PluginHttpResponse {
  status(code: number): PluginHttpResponse;
  json(data: unknown): void;
}

export type PluginRequestHandler = (req: PluginHttpRequest, res: PluginHttpResponse) => void | Promise<void>;

export interface PluginRouterRegistry {
  getNoAuth(path: string, handler: PluginRequestHandler): void;
  postNoAuth(path: string, handler: PluginRequestHandler): void;
}

export interface PluginConfigUIController {
  updateSchema(schema: PluginConfigSchema): void;
  updateField(key: string, field: Partial<PluginConfigItem>): void;
  removeField(key: string): void;
  addField(field: PluginConfigItem, afterKey?: string): void;
  showField(key: string): void;
  hideField(key: string): void;
  getCurrentConfig(): Record<string, unknown>;
}

export interface NapCatPluginContext {
  actions: {
    call(actionName: string, params: unknown, adapterName: string, config: unknown): Promise<unknown>;
  };
  adapterName: string;
  pluginManager: {
    config: unknown;
  };
  configPath: string;
  dataPath: string;
  NapCatConfig: PluginConfigBuilder;
  logger: PluginLogger;
  router: PluginRouterRegistry;
}

export interface OneBotMessageEvent {
  post_type?: string;
  message_type?: string;
  message_id?: string | number;
  message_seq?: string | number;
  real_id?: string | number;
  user_id?: string | number;
  self_id?: string | number;
  group_id?: string | number;
  group_name?: string;
  sender?: {
    user_id?: string | number;
    nickname?: string;
    card?: string;
  };
  raw_message?: string;
  message?: unknown;
  time?: string | number;
}

export interface PluginModule<TEvent = unknown, TConfig = unknown> {
  plugin_init: (ctx: NapCatPluginContext) => void | Promise<void>;
  plugin_onmessage?: (ctx: NapCatPluginContext, event: OneBotMessageEvent) => void | Promise<void>;
  plugin_onevent?: (ctx: NapCatPluginContext, event: TEvent) => void | Promise<void>;
  plugin_cleanup?: (ctx: NapCatPluginContext) => void | Promise<void>;
  plugin_config_ui?: PluginConfigSchema;
  plugin_get_config?: (ctx: NapCatPluginContext) => TConfig | Promise<TConfig>;
  plugin_set_config?: (ctx: NapCatPluginContext, config: TConfig) => void | Promise<void>;
  plugin_on_config_change?: (
    ctx: NapCatPluginContext,
    ui: PluginConfigUIController,
    key: string,
    value: unknown,
    currentConfig: Record<string, unknown>,
  ) => void | Promise<void>;
}
