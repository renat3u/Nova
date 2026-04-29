import path from 'node:path';
import type { NapCatPluginContext, PluginConfigSchema } from './types';
import type { NovaGroupConfig, NovaPluginConfig } from './types';

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
  floodWindowMs: 10000,
  floodMessageLimit: 30,
  userFloodMessageLimit: 8,
  consecutiveSendFailureLimit: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultDbPath(dataPath?: string): string {
  return dataPath ? path.join(dataPath, DEFAULT_DB_FILENAME) : DEFAULT_DB_FILENAME;
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
    floodWindowMs: integerInRange(raw.floodWindowMs, defaults.floodWindowMs, 1000, 600000),
    floodMessageLimit: integerInRange(raw.floodMessageLimit, defaults.floodMessageLimit, 1, 10000),
    userFloodMessageLimit: integerInRange(raw.userFloodMessageLimit, defaults.userFloodMessageLimit, 1, 10000),
    consecutiveSendFailureLimit: integerInRange(raw.consecutiveSendFailureLimit, defaults.consecutiveSendFailureLimit, 1, 100),
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
    ctx.NapCatConfig.boolean('enableScheduledActions', '启用定时主动行为', false, '关闭时 scheduled tick 只观察和记录沉默', true),
    ctx.NapCatConfig.number('floodWindowMs', 'Flood 检测窗口毫秒', DEFAULT_NOVA_CONFIG.floodWindowMs, '短时间消息爆发检测窗口', true),
    ctx.NapCatConfig.number('floodMessageLimit', 'Flood 消息上限', DEFAULT_NOVA_CONFIG.floodMessageLimit, '窗口内会话消息超过该值触发安全沉默', true),
    ctx.NapCatConfig.number('userFloodMessageLimit', '用户刷屏上限', DEFAULT_NOVA_CONFIG.userFloodMessageLimit, '窗口内同一用户消息超过该值触发安全沉默', true),
    ctx.NapCatConfig.number('consecutiveSendFailureLimit', '连续发送失败上限', DEFAULT_NOVA_CONFIG.consecutiveSendFailureLimit, '连续发送失败过多时触发风控保护', true),
    ctx.NapCatConfig.text('enabledGroups', '群启用配置 JSON', '{}', '高级配置：{"群号":{"enabled":true}}', true),
  );
}
