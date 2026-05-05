import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { NovaFileLogger, type NovaLogger } from '../core/logger';
import type { ActExecutor } from '../act/act-loop';
import { NovaRuntime, type NovaRuntimeStatus } from '../core/runtime';
import type { NovaRuntimeConfig } from '../core/types';
import type { NovaStandaloneConfig } from './web-types';

const DEFAULT_STANDALONE_CONFIG_FILENAME = 'nova-standalone-config.json';

function defaultStandaloneConfig(dbPath: string): NovaStandaloneConfig {
  return {
    enabled: true,
    debug: false,
    llmBaseUrl: '',
    llmApiKey: '',
    llmModel: '',
    enablePrivateChat: true,
    maxReplyLength: 1000,
    dbPath,
    minApiToSpeak: 0.15,
    directedMinApiToSpeak: 0.1,
    proactiveEnabled: true,
    iausScoringMode: 'consideration',
    gatewayMode: 'agent',
    decisionAgent: {
      enabled: true,
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.2,
      maxTokens: 1200,
      timeoutMs: 60000,
      responseFormat: 'json_object',
      failMode: 'fallback_algorithmic',
    },
    decisionGuardrails: 'off',
    enablePreSendGuardrails: false,
    auditAlgorithmicGates: true,
    port: 3721,
  };
}

function loadStandaloneConfig(configPath: string): NovaStandaloneConfig {
  try {
    if (!fs.existsSync(configPath)) {
      const dir = path.dirname(configPath);
      const dbPath = path.join(dir, 'nova-standalone.sqlite');
      const defaults = defaultStandaloneConfig(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), 'utf-8');
      return defaults;
    }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<NovaStandaloneConfig>;
    const dbPath = raw.dbPath ?? path.join(path.dirname(configPath), 'nova-standalone.sqlite');
    const defaults = defaultStandaloneConfig(dbPath);
    return { ...defaults, ...raw, decisionAgent: { ...defaults.decisionAgent, ...(raw.decisionAgent ?? {}) } };
  } catch {
    const dir = path.dirname(configPath);
    const dbPath = path.join(dir, 'nova-standalone.sqlite');
    return defaultStandaloneConfig(dbPath);
  }
}

function generateStandaloneUserId(): string {
  const shortId = uuid().replace(/-/g, '').slice(0, 16);
  return `qq:user:web_${shortId}`;
}

function deleteDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = dbPath + suffix;
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  }
  const stickerDbPath = dbPath.replace(/nova-standalone\.sqlite$/, 'nova-standalone-stickers.sqlite');
  for (const suffix of ['', '-wal', '-shm']) {
    const p = stickerDbPath + suffix;
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

export class NovaStandaloneState {
  private runtime: NovaRuntime | null = null;
  private logger: NovaLogger | null = null;
  private config: NovaStandaloneConfig;
  private readonly configPath: string;
  private _startedAt: number | null = null;
  private _actExecutor: ActExecutor | undefined;

  /** 当前 session 用户 ID（重启或重置会话时更新） */
  sessionUserId: string;
  /** 默认用户名 */
  readonly sessionUsername = '爱丽丝';

  constructor(configPath?: string) {
    this.configPath = configPath ?? path.resolve(DEFAULT_STANDALONE_CONFIG_FILENAME);
    this.config = loadStandaloneConfig(this.configPath);
    this.sessionUserId = generateStandaloneUserId();
  }

  get startedAt(): number | null { return this._startedAt; }
  get isRunning(): boolean { return this.runtime?.isRunning ?? false; }
  get logPath(): string { return path.join(path.dirname(this.configPath), 'logs', 'nova.log'); }

  getRuntime(): NovaRuntime | null { return this.runtime; }
  getLogger(): NovaLogger | null { return this.logger; }

  get status(): NovaRuntimeStatus {
    return this.runtime?.status ?? {
      online: false,
      initialized: false,
      processedMessages: 0,
      sentActions: 0,
      silenceCount: 0,
    };
  }

  async start(actExecutor?: ActExecutor): Promise<void> {
    if (this.runtime?.isRunning) return;

    this._actExecutor = actExecutor;

    // 1. 清理日志 + 数据库
    this.cleanupFiles();

    // 2. Create logger
    const logDir = path.join(path.dirname(this.configPath), 'logs');
    this.logger = new NovaFileLogger(logDir);
    this.logger.info(`Nova Standalone starting... sessionUser=${this.sessionUserId}`);

    // 3. Build + run
    await this.bootRuntime();
  }

  /** 重置会话 — 删除旧 DB、生成新用户、重启 Runtime */
  async resetSession(): Promise<string> {
    if (!this.runtime?.isRunning) {
      throw new Error('Runtime not running');
    }

    // 1. Stop
    await this.stop();

    // 2. 清理文件 + 新 ID
    this.cleanupFiles();
    this.sessionUserId = generateStandaloneUserId();

    // 3. 重建 logger（旧 logger 的 fd 已在 stop 时关闭）
    const logDir = path.join(path.dirname(this.configPath), 'logs');
    this.logger = new NovaFileLogger(logDir);
    this.logger.info(`Nova session reset... sessionUser=${this.sessionUserId}`);

    // 4. Restart
    await this.bootRuntime();

    return this.sessionUserId;
  }

  async stop(): Promise<void> {
    try {
      this.runtime?.setActExecutor(null as unknown as import('../act/act-loop').ActExecutor);
      await this.runtime?.stop();
    } finally {
      this.runtime = null;
      this._startedAt = null;
      this.logger?.info('Nova Standalone stopped');
    }
  }

  updateConfig(patch: Partial<NovaStandaloneConfig>): void {
    this.config = { ...this.config, ...patch };
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch {
      this.logger?.warn('Failed to save standalone config');
    }
    if (this.runtime) {
      this.runtime.updateConfig(this.toRuntimeConfig());
    }
  }

  sanitizedConfig(): Omit<NovaStandaloneConfig, 'llmApiKey'> & { llmApiKeyConfigured: boolean } {
    const { llmApiKey, ...rest } = this.config;
    return { ...rest, llmApiKeyConfigured: llmApiKey.trim().length > 0 };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private cleanupFiles(): void {
    const logDir = path.join(path.dirname(this.configPath), 'logs');
    const logFile = path.join(logDir, 'nova.log');
    try { if (fs.existsSync(logFile)) fs.unlinkSync(logFile); } catch { /* ok */ }
    deleteDbFiles(this.config.dbPath);
  }

  private async bootRuntime(): Promise<void> {
    const runtimeConfig = this.toRuntimeConfig();

    this.runtime = new NovaRuntime({
      config: runtimeConfig,
      logger: this.logger!,
      selfId: 'nova-standalone',
    });

    if (this._actExecutor) {
      this.runtime.setActExecutor(this._actExecutor);
    }

    await this.runtime.start();

    // EVOLVE + ACT 协程在 runtime.start() 中自动启动
    this._startedAt = Date.now();
    this.logger!.info('Nova Standalone started');
  }

  private toRuntimeConfig(): NovaRuntimeConfig {
    const c = this.config;
    return {
      enabled: c.enabled,
      debug: c.debug,
      llmBaseUrl: c.llmBaseUrl,
      llmApiKey: c.llmApiKey,
      llmModel: c.llmModel,
      replyInGroupOnlyWhenMentioned: true,
      enablePrivateChat: c.enablePrivateChat,
      enableGroupChat: false,
      enabledGroups: {},
      quoteReply: false,
      maxReplyLength: c.maxReplyLength,
      dbPath: c.dbPath,
      minApiToSpeak: c.minApiToSpeak,
      directedMinApiToSpeak: c.directedMinApiToSpeak,
      privateCooldownMs: 1000,
      groupCooldownMs: 30000,
      globalRateLimitPerMinute: 20,
      channelRateLimitPerMinute: 10,
      groupRateLimitPerMinute: 4,
      enableScheduledActions: false,
      proactiveEnabled: c.proactiveEnabled,
      proactiveWhitelistQQ: [],
      iausScoringMode: c.iausScoringMode,
      minProactiveUtility: 0.05,
      groupMinProactiveUtility: 0.08,
      iausCompensationFactor: 0.5,
      socialSafetyMidpoint: 0.45,
      socialSafetySlope: 0.15,
      floodWindowMs: 10000,
      floodMessageLimit: 30,
      userFloodMessageLimit: 8,
      consecutiveSendFailureLimit: 5,
      gatewayMode: c.gatewayMode,
      decisionAgent: { ...c.decisionAgent },
      decisionGuardrails: c.decisionGuardrails,
      enablePreSendGuardrails: c.enablePreSendGuardrails,
      auditAlgorithmicGates: c.auditAlgorithmicGates,
    };
  }
}
