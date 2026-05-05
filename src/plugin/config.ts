import path from 'node:path';
import type { GatewayMode, GuardrailMode, IAUSScoringMode } from '../core/types';
import type { NapCatPluginContext, PluginConfigSchema } from './types';
import type { NovaDecisionAgentConfig, NovaGroupConfig, NovaPluginConfig } from './types';

const DEFAULT_DB_FILENAME = 'nova.sqlite';

export const DEFAULT_NOVA_CONFIG: NovaPluginConfig = {
  enabled: true,
  debug: false,
  coreMode: 'embedded',
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
  replyInGroupOnlyWhenMentioned: true,
  enablePrivateChat: true,
  enableGroupChat: true,
  enabledGroups: {},
  quoteReply: false,
  maxReplyLength: 1000,
  dbPath: DEFAULT_DB_FILENAME,
  minApiToSpeak: 1.2,
  directedMinApiToSpeak: 0.15,
  privateCooldownMs: 3000,
  groupCooldownMs: 30000,
  globalRateLimitPerMinute: 20,
  channelRateLimitPerMinute: 6,
  groupRateLimitPerMinute: 4,
  enableScheduledActions: false,
  proactiveEnabled: false,
  proactiveWhitelistQQ: [],
  iausScoringMode: 'consideration',
  minProactiveUtility: 0.05,
  groupMinProactiveUtility: 0.08,
  iausCompensationFactor: 0.5,
  socialSafetyMidpoint: 0.45,
  socialSafetySlope: 0.15,
  iausDesireBoost: 0.15,
  iausMomentumBonus: 0.2,
  iausMomentumDecayMs: 300_000,
  iausCurveModulationStrength: 0.5,
  iausThompsonEta: 0,
  iausFairnessAlpha: 2.0,
  iausFairnessMax: 4.0,
  iausFairnessMinTotalService: 5,
  floodWindowMs: 10000,
  floodMessageLimit: 30,
  userFloodMessageLimit: 8,
  consecutiveSendFailureLimit: 3,

  // ── Agent gateway configuration ──────────────────────────────────────────
  //
  // gatewayMode: 'agent' | 'algorithmic'
  //   'agent' — Nova's behavior decisions are made by a separate LLM (Decision Agent).
  //   'algorithmic' — Original pure-gate-driven behavior (for regression/comparison).
  //
  // decisionAgent: LLM config for the Decision Agent (independent from main reply LLM).
  //   - enabled: master switch for the decision agent.
  //   - baseUrl / apiKey / model: OpenAI-compatible endpoint, key, and model name.
  //   - temperature: 0.2 recommended (low creativity for consistent decision-making).
  //   - maxTokens: 1200 recommended (enough for structured JSON response).
  //   - timeoutMs: 60000 recommended.
  //   - failMode: 'fallback_algorithmic' | 'silence' | 'allow_reply_only'
  //     - fallback_algorithmic: Use old gates when decision LLM fails.
  //     - silence: Go silent when decision LLM fails.
  //     - allow_reply_only: Only allow directed replies when decision LLM fails.
  //
  // decisionGuardrails: 'off' | 'soft' | 'hard'
  //   - off: Old algorithmic gates do NOT block agent decisions (default for dev/QQ).
  //   - soft: Record gate violations in trace but still allow execution.
  //   - hard: Old algorithmic gates can block agent decisions.
  //
  // enablePreSendGuardrails: ActLoop pre-send gate re-check.
  //   - false: (default) Queued proactive actions skip pre-send re-check.
  //   - true: Restore old pre-send gate behavior.
  //
  // auditAlgorithmicGates: Record old gate results for trace/debug.
  //   - true: (default) Run old gates alongside agent decisions for audit.
  //
  // Environment variable overrides (highest priority):
  //   NOVA_GATEWAY_MODE=agent|algorithmic
  //   NOVA_DECISION_LLM_BASE_URL=<url>
  //   NOVA_DECISION_LLM_API_KEY=<key>
  //   NOVA_DECISION_LLM_MODEL=<model>
  //   NOVA_DECISION_GUARDRAILS=off|soft|hard
  //   NOVA_ENABLE_PRE_SEND_GUARDRAILS=true|false
  //
  // Example config JSON:
  // {
  //   "gatewayMode": "agent",
  //   "decisionGuardrails": "off",
  //   "enablePreSendGuardrails": false,
  //   "auditAlgorithmicGates": true,
  //   "decisionAgent": {
  //     "enabled": true,
  //     "baseUrl": "http://localhost:11434/v1",
  //     "apiKey": "local",
  //     "model": "decision-model",
  //     "temperature": 0.2,
  //     "maxTokens": 1200,
  //     "timeoutMs": 60000,
  //     "responseFormat": "json_object",
  //     "failMode": "fallback_algorithmic"
  //   }
  // }

  // Agent gateway defaults
  gatewayMode: 'agent' as GatewayMode,
  decisionAgent: {
    enabled: true,
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.2,
    maxTokens: 1200,
    timeoutMs: 60_000,
    responseFormat: 'json_object' as const,
    failMode: 'fallback_algorithmic' as const,
  } satisfies NovaDecisionAgentConfig,
  decisionGuardrails: 'off' as GuardrailMode,
  enablePreSendGuardrails: false,
  auditAlgorithmicGates: true,

  // 新架构字段
  tickDtMin: undefined,
  tickDtMax: undefined,
  tickKappaT: undefined,
  eventBufferMaxSize: undefined,
  eventBufferMaxProtected: undefined,
  minTickIntervalMs: undefined,
  maxConcurrentEngagements: undefined,
  switchCostMs: undefined,
  stalenessThreshold: undefined,
};

/**
 * Normalize a raw proactive whitelist input into a clean, deduplicated string array.
 *
 * Rules (per Phase 2 Step 10 QQ format requirements):
 *  - Trim leading / trailing whitespace from each entry.
 *  - Discard empty strings.
 *  - Keep every QQ number as a string — never convert to number (avoids
 *    precision loss and leading-zero stripping).
 *  - Deduplicate.
 */
export function normalizeWhitelistQQ(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultDbPath(dataPath?: string): string {
  return dataPath ? path.join(dataPath, DEFAULT_DB_FILENAME) : DEFAULT_DB_FILENAME;
}

function normalizeIausScoringMode(value: unknown): IAUSScoringMode {
  return value === 'legacy_nsv' || value === 'consideration' ? value : DEFAULT_NOVA_CONFIG.iausScoringMode;
}

export function normalizeGatewayMode(value: unknown): GatewayMode {
  return value === 'algorithmic' || value === 'agent' ? value : DEFAULT_NOVA_CONFIG.gatewayMode;
}

export function normalizeGuardrailMode(value: unknown): GuardrailMode {
  return value === 'off' || value === 'soft' || value === 'hard' ? value : DEFAULT_NOVA_CONFIG.decisionGuardrails;
}

function normalizeFailMode(value: unknown): 'fallback_algorithmic' | 'silence' | 'allow_reply_only' {
  return value === 'fallback_algorithmic' || value === 'silence' || value === 'allow_reply_only'
    ? value
    : DEFAULT_NOVA_CONFIG.decisionAgent.failMode;
}

function normalizeDecisionAgentConfig(raw: unknown): NovaDecisionAgentConfig {
  const defaults = DEFAULT_NOVA_CONFIG.decisionAgent;
  if (!isRecord(raw)) return { ...defaults };
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : defaults.baseUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : defaults.apiKey,
    model: typeof raw.model === 'string' ? raw.model : defaults.model,
    temperature: numberInRange(raw.temperature, defaults.temperature, 0, 2),
    maxTokens: integerInRange(raw.maxTokens, defaults.maxTokens, 1, 8192),
    timeoutMs: typeof raw.timeoutMs === 'number' ? integerInRange(raw.timeoutMs, defaults.timeoutMs ?? 30000, 1000, 300000) : defaults.timeoutMs,
    responseFormat: 'json_object' as const,
    failMode: normalizeFailMode(raw.failMode),
  };
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  return Math.trunc(numberInRange(value, fallback, min, max));
}

export function createDefaultConfig(dataPath?: string): NovaPluginConfig {
  return {
    ...DEFAULT_NOVA_CONFIG,
    enabledGroups: {},
    dbPath: defaultDbPath(dataPath),
  };
}

export function normalizePluginConfig(raw: unknown, dataPath?: string): NovaPluginConfig {
  const defaults = createDefaultConfig(dataPath);
  if (!isRecord(raw)) return defaults;

  const enabledGroups: Record<string, NovaGroupConfig> = {};
  if (isRecord(raw.enabledGroups)) {
    for (const [groupId, groupConfig] of Object.entries(raw.enabledGroups)) {
      if (!isRecord(groupConfig)) continue;
      enabledGroups[groupId] = {
        enabled: typeof groupConfig.enabled === 'boolean' ? groupConfig.enabled : true,
      };
    }
  }

  const maxReplyLength = typeof raw.maxReplyLength === 'number'
    ? Math.max(1, Math.min(4000, Math.trunc(raw.maxReplyLength)))
    : defaults.maxReplyLength;

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    debug: typeof raw.debug === 'boolean' ? raw.debug : defaults.debug,
    coreMode: raw.coreMode === 'embedded' ? 'embedded' : defaults.coreMode,
    llmBaseUrl: typeof raw.llmBaseUrl === 'string' ? raw.llmBaseUrl : defaults.llmBaseUrl,
    llmApiKey: typeof raw.llmApiKey === 'string' ? raw.llmApiKey : defaults.llmApiKey,
    llmModel: typeof raw.llmModel === 'string' ? raw.llmModel : defaults.llmModel,
    replyInGroupOnlyWhenMentioned: typeof raw.replyInGroupOnlyWhenMentioned === 'boolean'
      ? raw.replyInGroupOnlyWhenMentioned
      : defaults.replyInGroupOnlyWhenMentioned,
    enablePrivateChat: typeof raw.enablePrivateChat === 'boolean'
      ? raw.enablePrivateChat
      : defaults.enablePrivateChat,
    enableGroupChat: typeof raw.enableGroupChat === 'boolean'
      ? raw.enableGroupChat
      : defaults.enableGroupChat,
    enabledGroups,
    quoteReply: typeof raw.quoteReply === 'boolean' ? raw.quoteReply : defaults.quoteReply,
    maxReplyLength,
    dbPath: typeof raw.dbPath === 'string' && raw.dbPath.trim().length > 0
      ? raw.dbPath
      : defaults.dbPath,
    minApiToSpeak: numberInRange(raw.minApiToSpeak, defaults.minApiToSpeak, 0, 7),
    directedMinApiToSpeak: numberInRange(raw.directedMinApiToSpeak, defaults.directedMinApiToSpeak, 0, 7),
    privateCooldownMs: integerInRange(raw.privateCooldownMs, defaults.privateCooldownMs, 0, 600000),
    groupCooldownMs: integerInRange(raw.groupCooldownMs, defaults.groupCooldownMs, 0, 3600000),
    globalRateLimitPerMinute: integerInRange(raw.globalRateLimitPerMinute, defaults.globalRateLimitPerMinute, 1, 1000),
    channelRateLimitPerMinute: integerInRange(raw.channelRateLimitPerMinute, defaults.channelRateLimitPerMinute, 1, 1000),
    groupRateLimitPerMinute: integerInRange(raw.groupRateLimitPerMinute, defaults.groupRateLimitPerMinute, 1, 1000),
    enableScheduledActions: typeof raw.enableScheduledActions === 'boolean'
      ? raw.enableScheduledActions
      : defaults.enableScheduledActions,
    proactiveEnabled: typeof raw.proactiveEnabled === 'boolean'
      ? raw.proactiveEnabled
      : defaults.proactiveEnabled,
    proactiveWhitelistQQ: normalizeWhitelistQQ(raw.proactiveWhitelistQQ),
    iausScoringMode: normalizeIausScoringMode(raw.iausScoringMode),
    minProactiveUtility: numberInRange(raw.minProactiveUtility, defaults.minProactiveUtility, 0, 1),
    groupMinProactiveUtility: numberInRange(raw.groupMinProactiveUtility, defaults.groupMinProactiveUtility, 0, 1),
    iausCompensationFactor: numberInRange(raw.iausCompensationFactor, defaults.iausCompensationFactor, 0, 1),
    socialSafetyMidpoint: numberInRange(raw.socialSafetyMidpoint, defaults.socialSafetyMidpoint, 0, 1),
    socialSafetySlope: numberInRange(raw.socialSafetySlope, defaults.socialSafetySlope, 0.01, 1),
    iausDesireBoost: numberInRange(raw.iausDesireBoost, defaults.iausDesireBoost, 0, 2),
    iausMomentumBonus: numberInRange(raw.iausMomentumBonus, defaults.iausMomentumBonus, 0, 2),
    iausMomentumDecayMs: integerInRange(raw.iausMomentumDecayMs, defaults.iausMomentumDecayMs, 0, 86_400_000),
    iausCurveModulationStrength: numberInRange(raw.iausCurveModulationStrength, defaults.iausCurveModulationStrength, 0, 1),
    iausThompsonEta: numberInRange(raw.iausThompsonEta, defaults.iausThompsonEta, 0, 2),
    iausFairnessAlpha: numberInRange(raw.iausFairnessAlpha, defaults.iausFairnessAlpha, 0, 8),
    iausFairnessMax: numberInRange(raw.iausFairnessMax, defaults.iausFairnessMax, 1, 20),
    iausFairnessMinTotalService: integerInRange(raw.iausFairnessMinTotalService, defaults.iausFairnessMinTotalService, 0, 1000),
    floodWindowMs: integerInRange(raw.floodWindowMs, defaults.floodWindowMs, 1000, 600000),
    floodMessageLimit: integerInRange(raw.floodMessageLimit, defaults.floodMessageLimit, 1, 10000),
    userFloodMessageLimit: integerInRange(raw.userFloodMessageLimit, defaults.userFloodMessageLimit, 1, 10000),
    consecutiveSendFailureLimit: integerInRange(raw.consecutiveSendFailureLimit, defaults.consecutiveSendFailureLimit, 1, 100),
    gatewayMode: normalizeGatewayMode(raw.gatewayMode),
    decisionAgent: normalizeDecisionAgentConfig(raw.decisionAgent),
    decisionGuardrails: normalizeGuardrailMode(raw.decisionGuardrails),
    enablePreSendGuardrails: typeof raw.enablePreSendGuardrails === 'boolean'
      ? raw.enablePreSendGuardrails
      : defaults.enablePreSendGuardrails,
    auditAlgorithmicGates: typeof raw.auditAlgorithmicGates === 'boolean'
      ? raw.auditAlgorithmicGates
      : defaults.auditAlgorithmicGates,
    // 新架构字段
    tickDtMin: numberInRange(raw.tickDtMin, defaults.tickDtMin, 500, 60_000),
    tickDtMax: numberInRange(raw.tickDtMax, defaults.tickDtMax, 5_000, 3_600_000),
    tickKappaT: numberInRange(raw.tickKappaT, defaults.tickKappaT, 0.1, 10),
    eventBufferMaxSize: integerInRange(raw.eventBufferMaxSize, defaults.eventBufferMaxSize, 50, 10_000),
    eventBufferMaxProtected: integerInRange(raw.eventBufferMaxProtected, defaults.eventBufferMaxProtected, 10, 1_000),
    minTickIntervalMs: integerInRange(raw.minTickIntervalMs, defaults.minTickIntervalMs, 500, 60_000),
    maxConcurrentEngagements: integerInRange(raw.maxConcurrentEngagements, defaults.maxConcurrentEngagements, 1, 10),
    switchCostMs: integerInRange(raw.switchCostMs, defaults.switchCostMs, 0, 30_000),
    stalenessThreshold: numberInRange(raw.stalenessThreshold, defaults.stalenessThreshold, 0, 5),
  };
}

export function mergePluginConfig(
  current: NovaPluginConfig,
  patch: unknown,
  dataPath?: string,
): NovaPluginConfig {
  return normalizePluginConfig(
    isRecord(patch) ? { ...current, ...patch } : current,
    dataPath,
  );
}

export function buildConfigSchema(ctx: NapCatPluginContext): PluginConfigSchema {
  return ctx.NapCatConfig.combine(
    ctx.NapCatConfig.html(`
      <div style="padding: 16px; border-radius: 12px; margin-bottom: 16px; background: #4f46e5; color: white;">
        <h3 style="margin: 0 0 6px 0; font-size: 18px; font-weight: 600;">Nova</h3>
        <p style="margin: 0; font-size: 13px; opacity: 0.88;">QQ 纯文字拟人认知 Bot 插件配置</p>
      </div>
    `),
    ctx.NapCatConfig.boolean('enabled', '启用 Nova', true, '关闭后 Nova 不处理消息', true),
    ctx.NapCatConfig.boolean('debug', '调试日志', false, '启用更详细的 Nova 调试日志', true),
    ctx.NapCatConfig.text('llmBaseUrl', 'LLM Base URL', '', 'OpenAI-compatible API 地址', true),
    ctx.NapCatConfig.text('llmApiKey', 'LLM API Key', '', '用于后续 LLM 接入；不会写入日志', true),
    ctx.NapCatConfig.text('llmModel', 'LLM Model', '', '用于后续 LLM 接入的模型名', true),
    ctx.NapCatConfig.boolean('enablePrivateChat', '启用私聊', true, '允许 Nova 处理私聊文本', true),
    ctx.NapCatConfig.boolean('enableGroupChat', '启用群聊', true, '允许 Nova 观察或处理群聊文本', true),
    ctx.NapCatConfig.boolean(
      'replyInGroupOnlyWhenMentioned',
      '群聊仅 @ 回复',
      true,
      '第一阶段群聊默认保守，仅 @ 或定向消息回复',
      true,
    ),
    ctx.NapCatConfig.boolean('quoteReply', '引用回复', false, '后续发送消息时尝试引用原消息', true),
    ctx.NapCatConfig.number('maxReplyLength', '最大回复长度', 1000, 'Nova 单次文本回复长度上限', true),
    ctx.NapCatConfig.text('dbPath', '数据库路径', defaultDbPath(ctx.dataPath), '修改后建议重启 Nova 插件生效', true),
    ctx.NapCatConfig.number('minApiToSpeak', '主动发言 API 下限', DEFAULT_NOVA_CONFIG.minApiToSpeak, '压力低于该值时默认沉默', true),
    ctx.NapCatConfig.number('directedMinApiToSpeak', '定向消息 API 下限', DEFAULT_NOVA_CONFIG.directedMinApiToSpeak, '私聊、@、回复 Nova 时使用的较低下限', true),
    ctx.NapCatConfig.number('privateCooldownMs', '私聊冷却毫秒', DEFAULT_NOVA_CONFIG.privateCooldownMs, '私聊连续回复最小间隔', true),
    ctx.NapCatConfig.number('groupCooldownMs', '群聊冷却毫秒', DEFAULT_NOVA_CONFIG.groupCooldownMs, '群聊连续回复最小间隔', true),
    ctx.NapCatConfig.number('globalRateLimitPerMinute', '全局每分钟上限', DEFAULT_NOVA_CONFIG.globalRateLimitPerMinute, 'Nova 全局发送频率上限', true),
    ctx.NapCatConfig.number('channelRateLimitPerMinute', '单会话每分钟上限', DEFAULT_NOVA_CONFIG.channelRateLimitPerMinute, '单个私聊或群聊发送频率上限', true),
    ctx.NapCatConfig.number('groupRateLimitPerMinute', '单群每分钟上限', DEFAULT_NOVA_CONFIG.groupRateLimitPerMinute, '单个 QQ 群发送频率上限', true),
    ctx.NapCatConfig.boolean('enableScheduledActions', '启用定时主动行为', false, 'scheduled tick 是否允许产生主动行为计划；关闭时 scheduled tick 只观察和记录沉默', true),
    ctx.NapCatConfig.boolean('proactiveEnabled', '启用主动发言', false, '主动发言总开关；关闭后 scheduled tick 仅观察和记录，绝不发送消息', true),
    {
      key: 'iausScoringMode',
      type: 'select',
      label: 'IAUS 评分模式',
      default: DEFAULT_NOVA_CONFIG.iausScoringMode,
      description: 'legacy_nsv 使用 ΔP-λ·C_social；consideration 使用 Nova-style 多因素效用评分',
      options: [
        { label: 'consideration', value: 'consideration' },
        { label: 'legacy_nsv', value: 'legacy_nsv' },
      ],
      reactive: true,
    },
    ctx.NapCatConfig.number('minProactiveUtility', '主动效用下限', DEFAULT_NOVA_CONFIG.minProactiveUtility, 'consideration 模式下私聊主动行为最低效用；越低越容易主动说话', true),
    ctx.NapCatConfig.number('groupMinProactiveUtility', '群主动效用下限', DEFAULT_NOVA_CONFIG.groupMinProactiveUtility, 'consideration 模式下群聊主动行为最低效用，建议略高于私聊', true),
    ctx.NapCatConfig.number('iausCompensationFactor', 'IAUS 补偿因子', DEFAULT_NOVA_CONFIG.iausCompensationFactor, '缓解多 consideration 相乘导致分数过低，范围 0~1', true),
    ctx.NapCatConfig.number('socialSafetyMidpoint', '社交安全曲线 midpoint', DEFAULT_NOVA_CONFIG.socialSafetyMidpoint, '控制 social cost 软惩罚的中点，范围 0~1', true),
    ctx.NapCatConfig.number('socialSafetySlope', '社交安全曲线 slope', DEFAULT_NOVA_CONFIG.socialSafetySlope, '控制 social cost 软惩罚的斜率，范围 0.01~1', true),
    ctx.NapCatConfig.number('iausDesireBoost', 'IAUS desire 加成', DEFAULT_NOVA_CONFIG.iausDesireBoost, 'Nova-style desire 乘法加成系数', true),
    ctx.NapCatConfig.number('iausMomentumBonus', 'IAUS momentum 加成', DEFAULT_NOVA_CONFIG.iausMomentumBonus, '上一赢家延续时的乘法加成系数', true),
    ctx.NapCatConfig.number('iausMomentumDecayMs', 'IAUS momentum 衰减毫秒', DEFAULT_NOVA_CONFIG.iausMomentumDecayMs, '上一赢家 momentum 生效窗口', true),
    ctx.NapCatConfig.number('iausCurveModulationStrength', 'IAUS 曲线人格调制', DEFAULT_NOVA_CONFIG.iausCurveModulationStrength, '人格权重调制 consideration 曲线的强度，范围 0~1', true),
    ctx.NapCatConfig.number('iausThompsonEta', 'IAUS Thompson 噪声', DEFAULT_NOVA_CONFIG.iausThompsonEta, '候选选择探索噪声；0 表示关闭随机扰动', true),
    ctx.NapCatConfig.number('iausFairnessAlpha', 'IAUS fairness alpha', DEFAULT_NOVA_CONFIG.iausFairnessAlpha, 'CFS-inspired 服务公平性幂律强度', true),
    ctx.NapCatConfig.number('iausFairnessMax', 'IAUS fairness 上限', DEFAULT_NOVA_CONFIG.iausFairnessMax, '欠服务目标最多获得的 fairness 加成', true),
    ctx.NapCatConfig.number('iausFairnessMinTotalService', 'IAUS fairness 最小服务数', DEFAULT_NOVA_CONFIG.iausFairnessMinTotalService, '近期服务样本达到该数量后启用 fairness', true),
    ctx.NapCatConfig.text('proactiveWhitelistQQ', '主动发言 QQ 白名单', '[]', '允许 Nova 主动私聊的 QQ 号，JSON 字符串数组格式。例如 ["123456","789012"]。空白字符自动去除，空字符串丢弃，保持字符串格式不做数字转换，重复项自动去重', true),
    ctx.NapCatConfig.number('floodWindowMs', 'Flood 检测窗口毫秒', DEFAULT_NOVA_CONFIG.floodWindowMs, '短时间消息爆发检测窗口', true),
    ctx.NapCatConfig.number('floodMessageLimit', 'Flood 消息上限', DEFAULT_NOVA_CONFIG.floodMessageLimit, '窗口内会话消息超过该值触发安全沉默', true),
    ctx.NapCatConfig.number('userFloodMessageLimit', '用户刷屏上限', DEFAULT_NOVA_CONFIG.userFloodMessageLimit, '窗口内同一用户消息超过该值触发安全沉默', true),
    ctx.NapCatConfig.number('consecutiveSendFailureLimit', '连续发送失败上限', DEFAULT_NOVA_CONFIG.consecutiveSendFailureLimit, '连续发送失败过多时触发风控保护', true),
    ctx.NapCatConfig.text('enabledGroups', '群启用配置 JSON', '{}', '高级配置：{"群号":{"enabled":true}}', true),
  );
}
