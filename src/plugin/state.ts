import fs from 'node:fs';
import path from 'node:path';
import type { NapCatPluginContext } from './types';
import { InMemoryActionLog } from '../act/action-log';
import { NovaFileLogger, type NovaLogger } from '../core/logger';
import { NovaRuntime } from '../core/runtime';
import { NovaScheduler } from '../core/scheduler';
import type { NovaRuntimeConfig } from '../core/types';
import { MessageDedupe } from '../perception/dedupe';
import { InMemoryDirectedState } from '../perception/directed';
import { createDefaultConfig, mergePluginConfig, normalizePluginConfig } from './config';
import type { NovaGroupConfig, NovaPluginConfig, NovaPluginStats } from './types';

export interface NovaPluginStateSnapshot {
  initialized: boolean;
  selfId?: string;
  config: NovaPluginConfig;
  startedAt?: number;
  lastError?: string;
  stats: NovaPluginStats;
}

class NovaPluginState {
  private ctx: NapCatPluginContext | null = null;
  private logger: NovaLogger | null = null;

  initialized = false;
  selfId?: string;
  config: NovaPluginConfig = createDefaultConfig();
  runtime: NovaRuntime | null = null;
  scheduler: NovaScheduler | null = null;
  readonly dedupe = new MessageDedupe();
  readonly directedState = new InMemoryDirectedState();
  readonly actionLog = new InMemoryActionLog();
  startedAt?: number;
  lastError?: string;
  stats: NovaPluginStats = {
    startedAt: null,
    processedMessages: 0,
  };

  async init(ctx: NapCatPluginContext): Promise<void> {
    this.ctx = ctx;
    this.initialized = false;
    this.lastError = undefined;
    this.startedAt = Date.now();
    this.stats.startedAt = this.startedAt;
    this.config = this.loadConfig();
    this.logger = this.createRuntimeLogger(ctx);
    this.logger.info('Nova file logger initialized', { logPath: this.getLogPath(ctx) });
    this.selfId = await this.fetchSelfId();
    this.runtime = new NovaRuntime({
      config: this.toRuntimeConfig(this.config),
      logger: this.logger,
      selfId: this.selfId,
    });
    await this.runtime.start();
    this.scheduler = new NovaScheduler({
      runtime: this.runtime,
      logger: this.logger,
    });
    this.scheduler.start();
    this.initialized = true;
  }

  async cleanup(): Promise<void> {
    this.initialized = false;
    try {
      this.scheduler?.stop();
      this.scheduler = null;
      await this.runtime?.stop();
    } catch (error) {
      this.lastError = stringifyError(error);
      this.ctx?.logger.warn('Nova cleanup stop failed:', error);
    } finally {
      this.runtime = null;
      this.dedupe.clear();
      this.directedState.clear();
      this.actionLog.clear();
      this.saveConfig();
      this.logger = null;
      this.ctx = null;
    }
  }

  getSnapshot(): NovaPluginStateSnapshot {
    return {
      initialized: this.initialized,
      selfId: this.selfId,
      config: this.config,
      startedAt: this.startedAt,
      lastError: this.lastError,
      stats: this.stats,
    };
  }

  replaceConfig(raw: unknown): NovaPluginConfig {
    const previousDbPath = this.config.dbPath;
    this.config = normalizePluginConfig(raw, this.ctx?.dataPath);
    this.saveConfig();
    this.syncRuntimeConfig(previousDbPath);
    return this.config;
  }

  updateConfig(patch: unknown): NovaPluginConfig {
    const previousDbPath = this.config.dbPath;
    this.config = mergePluginConfig(this.config, patch, this.ctx?.dataPath);
    this.saveConfig();
    this.syncRuntimeConfig(previousDbPath);
    return this.config;
  }

  updateGroupConfig(groupId: string, config: Partial<NovaGroupConfig>): void {
    this.updateConfig({
      enabledGroups: {
        ...this.config.enabledGroups,
        [groupId]: {
          ...this.config.enabledGroups[groupId],
          ...config,
        },
      },
    });
  }

  get loggerInstance(): NovaLogger | null {
    return this.logger;
  }

  isGroupEnabled(groupId: string): boolean {
    return this.config.enabledGroups[groupId]?.enabled !== false;
  }

  private loadConfig(): NovaPluginConfig {
    if (!this.ctx?.configPath) return createDefaultConfig(this.ctx?.dataPath);

    try {
      if (!fs.existsSync(this.ctx.configPath)) {
        const config = createDefaultConfig(this.ctx.dataPath);
        this.writeConfig(config);
        return config;
      }

      const raw = JSON.parse(fs.readFileSync(this.ctx.configPath, 'utf-8')) as unknown;
      return normalizePluginConfig(raw, this.ctx.dataPath);
    } catch (error) {
      this.lastError = stringifyError(error);
      this.ctx.logger.error('Nova config load failed; using defaults:', error);
      return createDefaultConfig(this.ctx.dataPath);
    }
  }

  private saveConfig(): void {
    if (!this.ctx?.configPath) return;
    this.writeConfig(this.config);
  }

  private writeConfig(config: NovaPluginConfig): void {
    if (!this.ctx?.configPath) return;

    try {
      const configDir = path.dirname(this.ctx.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(this.ctx.configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
      this.lastError = stringifyError(error);
      this.ctx.logger.error('Nova config save failed:', error);
    }
  }

  private async fetchSelfId(): Promise<string | undefined> {
    if (!this.ctx) return undefined;

    try {
      const result = await this.ctx.actions.call(
        'get_login_info',
        {},
        this.ctx.adapterName,
        this.ctx.pluginManager.config,
      ) as { user_id?: string | number } | undefined;

      const selfId = result?.user_id === undefined ? undefined : String(result.user_id);
      if (selfId) {
        this.ctx.logger.info(`Nova self_id detected: ${selfId}`);
      } else {
        this.ctx.logger.warn('Nova self_id not found in get_login_info response');
      }
      return selfId;
    } catch (error) {
      this.lastError = stringifyError(error);
      this.ctx.logger.warn('Nova failed to get self_id:', error);
      return undefined;
    }
  }

  private syncRuntimeConfig(previousDbPath: string): void {
    this.runtime?.updateConfig(this.toRuntimeConfig(this.config));
    if (previousDbPath !== this.config.dbPath) {
      this.logger?.warn('Nova dbPath changed; restart plugin to reopen storage with the new path');
    }
  }

  private toRuntimeConfig(config: NovaPluginConfig): NovaRuntimeConfig {
    return {
      enabled: config.enabled,
      debug: config.debug,
      llmBaseUrl: config.llmBaseUrl,
      llmApiKey: config.llmApiKey,
      llmModel: config.llmModel,
      replyInGroupOnlyWhenMentioned: config.replyInGroupOnlyWhenMentioned,
      enablePrivateChat: config.enablePrivateChat,
      enableGroupChat: config.enableGroupChat,
      enabledGroups: config.enabledGroups,
      quoteReply: config.quoteReply,
      maxReplyLength: config.maxReplyLength,
      dbPath: config.dbPath,
      minApiToSpeak: config.minApiToSpeak,
      directedMinApiToSpeak: config.directedMinApiToSpeak,
      privateCooldownMs: config.privateCooldownMs,
      groupCooldownMs: config.groupCooldownMs,
      globalRateLimitPerMinute: config.globalRateLimitPerMinute,
      channelRateLimitPerMinute: config.channelRateLimitPerMinute,
      groupRateLimitPerMinute: config.groupRateLimitPerMinute,
      enableScheduledActions: config.enableScheduledActions,
      floodWindowMs: config.floodWindowMs,
      floodMessageLimit: config.floodMessageLimit,
      userFloodMessageLimit: config.userFloodMessageLimit,
      consecutiveSendFailureLimit: config.consecutiveSendFailureLimit,
    };
  }

  private createRuntimeLogger(ctx: NapCatPluginContext): NovaLogger {
    const mirror: NovaLogger = {
      debug: (message, ...args) => {
        if (this.config.debug) ctx.logger.debug(message, ...args);
      },
      info: (message, ...args) => ctx.logger.info(message, ...args),
      warn: (message, ...args) => ctx.logger.warn(message, ...args),
      error: (message, ...args) => ctx.logger.error(message, ...args),
    };

    return new NovaFileLogger(this.getLogDir(ctx), mirror);
  }

  private getLogDir(ctx: NapCatPluginContext): string {
    return path.join(ctx.dataPath || path.dirname(ctx.configPath), 'logs');
  }

  private getLogPath(ctx: NapCatPluginContext): string {
    return path.join(this.getLogDir(ctx), 'nova.log');
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const novaPluginState = new NovaPluginState();
