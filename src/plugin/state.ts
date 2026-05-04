import fs from 'node:fs';
import path from 'node:path';
import type { NapCatPluginContext } from './types';
import { InMemoryActionLog } from '../act/action-log';
import { queuedActionToSendTarget } from '../act/act-loop';
import type { SendResult } from '../act/types';
import { NovaFileLogger, type NovaLogger } from '../core/logger';
import { NovaRuntime } from '../core/runtime';
import { NovaScheduler } from '../core/scheduler';
import type { NovaRuntimeConfig } from '../core/types';
import { MessageDedupe } from '../perception/dedupe';
import { InMemoryDirectedState } from '../perception/directed';
import { createDefaultConfig, mergePluginConfig, normalizeGatewayMode, normalizeGuardrailMode, normalizePluginConfig } from './config';
import { sendText } from './actions/send-message';
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

    // Wire the ActLoop executor: this callback bridges the core ActLoop to
    // NapCat's OneBot send_msg action.  Called whenever the ActLoop dequeues
    // a queued proactive action for execution.
    this.runtime.setActExecutor(async (queuedAction, channel) => {
      return await this.executeProactiveAction(ctx, queuedAction, channel);
    });

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
      this.runtime?.setActExecutor(null as unknown as import('../act/act-loop').ActExecutor);
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
      let config: NovaPluginConfig;
      if (!fs.existsSync(this.ctx.configPath)) {
        config = createDefaultConfig(this.ctx.dataPath);
        this.writeConfig(config);
      } else {
        const raw = JSON.parse(fs.readFileSync(this.ctx.configPath, 'utf-8')) as unknown;
        config = normalizePluginConfig(raw, this.ctx.dataPath);
      }
      // Environment variable overrides for decision agent (lowest priority:
      // code defaults < config file < env vars).
      return this.applyEnvOverrides(config);
    } catch (error) {
      this.lastError = stringifyError(error);
      this.ctx.logger.error('Nova config load failed; using defaults:', error);
      return createDefaultConfig(this.ctx.dataPath);
    }
  }

  /**
   * Override decision agent config with environment variables when set.
   * Env vars take highest priority for deployment flexibility.
   */
  private applyEnvOverrides(config: NovaPluginConfig): NovaPluginConfig {
    const envGatewayMode = process.env.NOVA_GATEWAY_MODE;
    const envDecisionBaseUrl = process.env.NOVA_DECISION_LLM_BASE_URL;
    const envDecisionApiKey = process.env.NOVA_DECISION_LLM_API_KEY;
    const envDecisionModel = process.env.NOVA_DECISION_LLM_MODEL;
    const envGuardrails = process.env.NOVA_DECISION_GUARDRAILS;
    const envPreSendGuardrails = process.env.NOVA_ENABLE_PRE_SEND_GUARDRAILS;

    if (!envGatewayMode && !envDecisionBaseUrl && !envDecisionApiKey && !envDecisionModel && !envGuardrails && !envPreSendGuardrails) {
      return config;
    }

    return {
      ...config,
      ...(envGatewayMode ? { gatewayMode: normalizeGatewayMode(envGatewayMode) } : {}),
      ...(envDecisionBaseUrl || envDecisionApiKey || envDecisionModel ? {
        decisionAgent: {
          ...config.decisionAgent,
          ...(envDecisionBaseUrl ? { baseUrl: envDecisionBaseUrl } : {}),
          ...(envDecisionApiKey ? { apiKey: envDecisionApiKey } : {}),
          ...(envDecisionModel ? { model: envDecisionModel } : {}),
        },
      } : {}),
      ...(envGuardrails ? { decisionGuardrails: normalizeGuardrailMode(envGuardrails) } : {}),
      ...(envPreSendGuardrails !== undefined ? { enablePreSendGuardrails: envPreSendGuardrails === 'true' } : {}),
    };
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
      proactiveEnabled: config.proactiveEnabled,
      proactiveWhitelistQQ: config.proactiveWhitelistQQ,
      iausScoringMode: config.iausScoringMode,
      minProactiveUtility: config.minProactiveUtility,
      groupMinProactiveUtility: config.groupMinProactiveUtility,
      iausCompensationFactor: config.iausCompensationFactor,
      socialSafetyMidpoint: config.socialSafetyMidpoint,
      socialSafetySlope: config.socialSafetySlope,
      iausDesireBoost: config.iausDesireBoost,
      iausMomentumBonus: config.iausMomentumBonus,
      iausMomentumDecayMs: config.iausMomentumDecayMs,
      iausCurveModulationStrength: config.iausCurveModulationStrength,
      iausThompsonEta: config.iausThompsonEta,
      iausFairnessAlpha: config.iausFairnessAlpha,
      iausFairnessMax: config.iausFairnessMax,
      iausFairnessMinTotalService: config.iausFairnessMinTotalService,
      floodWindowMs: config.floodWindowMs,
      floodMessageLimit: config.floodMessageLimit,
      userFloodMessageLimit: config.userFloodMessageLimit,
      consecutiveSendFailureLimit: config.consecutiveSendFailureLimit,
      gatewayMode: config.gatewayMode,
      decisionAgent: {
        enabled: config.decisionAgent.enabled,
        baseUrl: config.decisionAgent.baseUrl,
        apiKey: config.decisionAgent.apiKey,
        model: config.decisionAgent.model,
        temperature: config.decisionAgent.temperature,
        maxTokens: config.decisionAgent.maxTokens,
        timeoutMs: config.decisionAgent.timeoutMs,
        responseFormat: config.decisionAgent.responseFormat,
        failMode: config.decisionAgent.failMode,
      },
      decisionGuardrails: config.decisionGuardrails,
      enablePreSendGuardrails: config.enablePreSendGuardrails,
      auditAlgorithmicGates: config.auditAlgorithmicGates,
    };
  }

  /**
   * Execute a queued proactive action through the NapCat bridge.
   *
   * This is the ActExecutor callback wired into NovaRuntime.  It converts
   * the QueuedAction into a send_text target, generates the message text
   * via the runtime's LLM-based proactive responder (Step 12), and sends
   * via the OneBot API.
   */
  private async executeProactiveAction(
    ctx: NapCatPluginContext,
    queuedAction: import('../act/action-queue').QueuedAction,
    channel: import('../world/entities').ChannelAttrs | undefined,
  ): Promise<SendResult> {
    const target = queuedActionToSendTarget(queuedAction, channel);

    // Step 12: LLM-generated proactive text via NovaResponder.
    // Falls back gracefully if the runtime is unavailable or generation fails.
    const text = await this.buildProactiveText(queuedAction, channel);
    if (text === null) {
      this.logger?.warn('Nova proactive text generation failed — action abandoned', {
        queueId: queuedAction.id,
        targetId: target.channelId,
        desireType: queuedAction.candidate.desireType,
      });
      return {
        ok: false,
        actionType: 'send_text',
        targetId: target.channelId,
        error: 'proactive_text_generation_failed',
        messageId: undefined,
        createdMs: Date.now(),
      };
    }

    const result = await sendText(
      {
        chatType: target.chatType,
        userId: target.userId,
        groupId: target.groupId,
        channelId: target.channelId,
      },
      text,
      {
        ctx,
        quoteReply: false,
        maxReplyLength: this.config.maxReplyLength,
      },
    );

    // Record in the in-memory action log for immediate observability.
    // The persistent DB record and world update are handled by ActLoop.tick().
    this.actionLog.recordSend(result);

    if (result.ok) {
      this.directedState.rememberNovaAction(
        target.channelId,
        target.chatType === 'private' ? target.userId : undefined,
      );
      this.logger?.info('Nova ActLoop sent proactive message', {
        queueId: queuedAction.id,
        tick: queuedAction.tick,
        targetId: result.targetId,
        scene: queuedAction.candidate.scene,
        desireType: queuedAction.candidate.desireType,
        textLength: text.length,
        messageId: result.messageId,
      });
    } else {
      this.logger?.warn('Nova ActLoop proactive send failed', {
        queueId: queuedAction.id,
        targetId: result.targetId,
        error: result.error,
      });
    }

    return result;
  }

  /**
   * Step 12: Generate proactive message text via the LLM.
   *
   * Delegates to NovaRuntime.buildProactiveMessage(), which uses
   * NovaResponder.buildProactiveAction() with soul, relationship,
   * memory, and thread context. Returns null if generation fails.
   */
  private async buildProactiveText(
    queuedAction: import('../act/action-queue').QueuedAction,
    channel: import('../world/entities').ChannelAttrs | undefined,
  ): Promise<string | null> {
    if (!this.runtime) return null;

    try {
      return await this.runtime.buildProactiveMessage(queuedAction, channel);
    } catch (error) {
      this.logger?.warn('Nova proactive text generation error', {
        queueId: queuedAction.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
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
