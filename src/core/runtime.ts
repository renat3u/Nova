import type { NovaLogger } from './logger';
import { noopLogger } from './logger';
import type { NovaAction, NovaMessageEvent, NovaRuntimeConfig } from './types';
import { NovaResponder } from '../act/responder';
import { openNovaDb, type NovaDbConnection } from '../db/sqlite';
import { evaluateGates } from '../gates/gates';
import { RateLimitState } from '../gates/rate-limit';
import { buildSilenceLogEntry } from '../gates/silence-log';
import { LongTermMemory } from '../memory/long-term-memory';
import { MemoryService } from '../memory/memory-service';
import { WorkingMemory } from '../memory/working-memory';
import { DEFAULT_PERSONALITY_VECTOR, projectPersonalityVector, type PersonalityVector } from '../personality/vector';
import { computeLoudness, rememberSelectedVoice, type VoiceFatigueState } from '../voices/loudness';
import { selectVoice, type VoiceSelectionResult } from '../voices/selection';
import { AdaptiveKappa, computeAllPressures, createPressureHistory, toPressureSnapshot, type PressureHistory, type PressureSnapshot } from '../pressure/aggregate';
import { DEFAULT_KAPPA, conversationIdForChannel } from '../world/constants';
import { NovaWorldRepository } from '../world/repository';
import type { WorldModel } from '../world/model';

interface PressureTickContext {
  nowMs: number;
  reason: 'message' | 'scheduled';
  eventId?: string;
  channelId?: string;
  senderId?: string;
  directed?: boolean;
}

interface PressureTickResult {
  pressure: PressureSnapshot;
  voice: VoiceSelectionResult;
}

export interface NovaRuntimeOptions {
  config: NovaRuntimeConfig;
  logger?: NovaLogger;
  selfId?: string;
  startedAt?: number;
}

export interface NovaRuntimeStatus {
  online: boolean;
  initialized: boolean;
  selfId?: string;
  startedAt?: number;
  processedMessages: number;
  sentActions: number;
  silenceCount: number;
  lastTickAt?: number;
  lastError?: string;
}

export interface RuntimeActionRecordInput {
  tick?: number | null;
  actionType: string;
  targetId: string;
  text?: string;
  status: 'success' | 'failed' | string;
  error?: string;
  createdMs?: number;
}

export class NovaRuntime {
  private running = false;
  private startedAt: number | null;
  private config: NovaRuntimeConfig;
  private readonly logger: NovaLogger;
  private selfId?: string;
  private db: NovaDbConnection | null = null;
  private repository: NovaWorldRepository | null = null;
  private memoryService: MemoryService | null = null;
  private tick = 0;
  private lastTickMs: number | null = null;
  private readonly pressureHistory: PressureHistory = createPressureHistory();
  private readonly adaptiveKappa = new AdaptiveKappa(DEFAULT_KAPPA);
  private personality: PersonalityVector = projectPersonalityVector(DEFAULT_PERSONALITY_VECTOR);
  private readonly voiceFatigue: VoiceFatigueState = { recent: [], maxRecent: 6 };
  private readonly rateLimit = new RateLimitState();
  private lastVoiceSelection: VoiceSelectionResult | null = null;
  private processedMessages = 0;
  private sentActions = 0;
  private silenceCount = 0;
  private lastError?: string;

  constructor(options: NovaRuntimeOptions) {
    this.config = options.config;
    this.logger = options.logger ?? noopLogger;
    this.selfId = options.selfId;
    this.startedAt = options.startedAt ?? null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get startTime(): number | null {
    return this.startedAt;
  }

  get runtimeConfig(): NovaRuntimeConfig {
    return this.config;
  }

  get world(): WorldModel | null {
    return this.repository?.world ?? null;
  }

  get memory(): MemoryService | null {
    return this.memoryService;
  }

  get storagePath(): string | null {
    return this.db?.path ?? null;
  }

  get selectedVoice(): VoiceSelectionResult | null {
    return this.lastVoiceSelection;
  }

  get status(): NovaRuntimeStatus {
    return {
      online: this.running && this.config.enabled,
      initialized: this.running,
      ...(this.selfId === undefined ? {} : { selfId: this.selfId }),
      ...(this.startedAt === null ? {} : { startedAt: this.startedAt }),
      processedMessages: this.processedMessages,
      sentActions: this.sentActions,
      silenceCount: this.silenceCount,
      ...(this.lastTickMs === null ? {} : { lastTickAt: this.lastTickMs }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.db = openNovaDb(this.config.dbPath);
    this.repository = new NovaWorldRepository(this.db.db);
    this.repository.loadWorld();
    const workingMemory = new WorkingMemory(this.db.db);
    const longTermMemory = new LongTermMemory(this.db.db);
    this.memoryService = new MemoryService(workingMemory, longTermMemory);
    this.memoryService.load();

    this.running = true;
    this.startedAt = Date.now();
    this.logger.info(`Nova Core started${this.selfId ? ` for self_id=${this.selfId}` : ''}`);
  }

  async stop(): Promise<void> {
    if (!this.running && !this.db) return;

    try {
      this.memoryService?.flush();
    } finally {
      this.db?.close();
      this.db = null;
      this.repository = null;
      this.memoryService = null;
      this.running = false;
    }

    this.logger.info('Nova Core stopped');
  }

  async handleMessage(event: NovaMessageEvent): Promise<NovaAction[]> {
    if (!this.running || !this.config.enabled) return [];

    try {
      this.logger.debug(
        `Nova Core received ${event.chatType} message ${event.messageId} directed=${event.isDirected}`,
        {
          chatId: event.chatId,
          senderId: event.senderId,
          textLength: event.text.length,
        },
      );

      this.repository?.applyMessageEvent(event);
      this.processedMessages += 1;
      this.rateLimit.rememberMessage(event);
      const tickResult = this.computePressureTick({
        nowMs: event.timestamp || Date.now(),
        reason: 'message',
        eventId: event.id,
        channelId: event.chatId,
        senderId: event.senderId,
        directed: event.isDirected,
      });
      if (!tickResult || !this.repository) return [];

      const channel = this.repository.world.has(event.chatId) && this.repository.world.getNodeType(event.chatId) === 'channel'
        ? this.repository.world.getChannel(event.chatId)
        : undefined;
      const conversationId = conversationIdForChannel(event.chatId);
      const conversation = this.repository.world.has(conversationId) && this.repository.world.getNodeType(conversationId) === 'conversation'
        ? this.repository.world.getConversation(conversationId)
        : undefined;
      const gate = evaluateGates({
        nowMs: event.timestamp || Date.now(),
        reason: 'message',
        event,
        pressure: tickResult.pressure,
        voice: tickResult.voice,
        conversation,
        channel,
        config: this.config,
        rateLimit: this.rateLimit,
      });

      if (!gate.allow) {
        this.recordSilence(buildSilenceLogEntry({
          tick: this.tick,
          targetId: event.chatId,
          decision: gate,
          context: {
            nowMs: event.timestamp || Date.now(),
            reason: 'message',
            event,
            pressure: tickResult.pressure,
            voice: tickResult.voice,
            conversation,
            channel,
            config: this.config,
            rateLimit: this.rateLimit,
          },
        }));
        return [{ type: 'silence', reason: gate.reason, level: gate.level === 'none' ? 'soft' : gate.level }];
      }

      if (!this.memoryService) {
        const decision = { allow: false, level: 'hard' as const, reason: 'memory_service_unavailable', reasons: ['memory_service_unavailable'], values: {} };
        this.recordSilence(buildSilenceLogEntry({
          tick: this.tick,
          targetId: event.chatId,
          decision,
          context: {
            nowMs: event.timestamp || Date.now(),
            reason: 'message',
            event,
            pressure: tickResult.pressure,
            voice: tickResult.voice,
            conversation,
            channel,
            config: this.config,
            rateLimit: this.rateLimit,
          },
        }));
        return [{ type: 'silence', reason: 'memory_service_unavailable', level: 'hard' }];
      }

      const reply = await new NovaResponder({
        config: this.config,
        repository: this.repository,
        memoryService: this.memoryService,
        logger: this.logger,
        personality: this.personality,
      }).buildReplyAction({
        event,
        pressure: tickResult.pressure,
        voice: tickResult.voice,
      });

      if (!reply.action) {
        const reason = reply.error ?? 'llm_reply_unavailable';
        this.recordSilence(buildSilenceLogEntry({
          tick: this.tick,
          targetId: event.chatId,
          decision: { allow: false, level: 'normal', reason, reasons: [reason], values: {} },
          context: {
            nowMs: event.timestamp || Date.now(),
            reason: 'message',
            event,
            pressure: tickResult.pressure,
            voice: tickResult.voice,
            conversation,
            channel,
            config: this.config,
            rateLimit: this.rateLimit,
          },
        }));
        return [{ type: 'silence', reason, level: 'normal' }];
      }

      return [reply.action];
    } catch (error) {
      this.recordError(error);
      throw error;
    }
  }

  runScheduledTick(nowMs = Date.now()): void {
    if (!this.running || !this.config.enabled) return;

    try {
      const tickResult = this.computePressureTick({
        nowMs,
        reason: 'scheduled',
      });
      if (!tickResult || !this.repository) return;

      const gate = evaluateGates({
        nowMs,
        reason: 'scheduled',
        pressure: tickResult.pressure,
        voice: tickResult.voice,
        config: this.config,
        rateLimit: this.rateLimit,
      });

      if (!gate.allow) {
        this.recordSilence(buildSilenceLogEntry({
          tick: this.tick,
          targetId: 'scheduled',
          decision: gate,
          context: {
            nowMs,
            reason: 'scheduled',
            pressure: tickResult.pressure,
            voice: tickResult.voice,
            config: this.config,
            rateLimit: this.rateLimit,
          },
        }));
      }
    } catch (error) {
      this.recordError(error);
      throw error;
    }
  }

  recordActionResult(input: RuntimeActionRecordInput): void {
    const nowMs = input.createdMs ?? Date.now();
    this.repository?.recordAction({
      tick: input.tick ?? this.tick,
      action_type: input.actionType,
      target_id: input.targetId,
      text: input.text ?? '',
      status: input.status,
      error: input.error ?? '',
      created_ms: nowMs,
    });

    if (input.status === 'success') {
      this.sentActions += 1;
      this.rateLimit.recordAllowedAction(nowMs);
      this.repository?.markNovaAction(input.targetId, nowMs);
    } else if (input.status === 'failed') {
      this.rateLimit.recordSendFailure();
      if (input.error) this.lastError = input.error;
    }
  }

  getRecentActions(limit = 50): Array<{
    id: string;
    tick: number | null;
    actionType: string;
    targetId: string;
    text: string;
    status: string;
    error?: string;
    createdMs: number;
  }> {
    return this.repository?.listRecentActions(limit).map((entry) => ({
      id: entry.id ?? '',
      tick: entry.tick ?? null,
      actionType: entry.action_type,
      targetId: entry.target_id,
      text: entry.text ?? '',
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
      createdMs: entry.created_ms ?? Date.now(),
    })) ?? [];
  }

  getRecentSilences(limit = 50): Array<{
    id: string;
    tick: number | null;
    targetId: string;
    level: string;
    reason: string;
    values: Record<string, unknown>;
    createdMs: number;
  }> {
    return this.repository?.listRecentSilences(limit).map((entry) => ({
      id: entry.id ?? '',
      tick: entry.tick ?? null,
      targetId: entry.target_id,
      level: entry.level,
      reason: entry.reason,
      values: entry.values ?? {},
      createdMs: entry.created_ms ?? Date.now(),
    })) ?? [];
  }

  getPressureSnapshots(limit = 50): Array<{
    tick: number;
    p1: number;
    p2: number;
    p3: number;
    p4: number;
    p5: number;
    p6: number;
    pProspect: number;
    api: number;
    apiPeak: number;
    createdMs: number;
    contributions?: unknown;
  }> {
    return this.repository?.listPressureSnapshots(limit).map((snapshot) => ({
      tick: snapshot.tick,
      p1: snapshot.p1,
      p2: snapshot.p2,
      p3: snapshot.p3,
      p4: snapshot.p4,
      p5: snapshot.p5,
      p6: snapshot.p6,
      pProspect: snapshot.p_prospect,
      api: snapshot.api,
      apiPeak: snapshot.api_peak,
      createdMs: snapshot.created_ms ?? Date.now(),
      contributions: snapshot.contributions,
    })) ?? [];
  }

  getSeenGroupChannels(): Array<{ groupId: string; channelId: string; title?: string; enabled: boolean }> {
    const world = this.repository?.world;
    if (!world) return [];

    return world.getEntitiesByType('channel')
      .map((id) => world.getChannel(id))
      .filter((channel) => channel.chat_type === 'group')
      .map((channel) => {
        const groupId = channel.id.startsWith('qq:group:') ? channel.id.slice('qq:group:'.length) : channel.id;
        return {
          groupId,
          channelId: channel.id,
          ...(channel.title === undefined ? {} : { title: channel.title }),
          enabled: this.config.enabledGroups[groupId]?.enabled !== false,
        };
      });
  }

  private computePressureTick(context: PressureTickContext): PressureTickResult | null {
    if (!this.repository) return null;
    this.tick += 1;
    const dtS = this.lastTickMs === null ? 60 : Math.max(1, (context.nowMs - this.lastTickMs) / 1000);
    this.lastTickMs = context.nowMs;
    const kappa = this.adaptiveKappa.current();
    const pressure = computeAllPressures(this.repository.world, this.tick, {
      nowMs: context.nowMs,
      history: this.pressureHistory,
      kappa,
      tickDt: dtS,
    });
    this.adaptiveKappa.update([
      pressure.P1,
      pressure.P2,
      pressure.P3,
      pressure.P4,
      pressure.P5,
      pressure.P6,
    ], dtS);

    const snapshot = toPressureSnapshot(pressure, this.tick, context.nowMs);
    this.repository.recordPressureSnapshot({
      tick: snapshot.tick,
      created_ms: snapshot.createdMs,
      p1: snapshot.p1,
      p2: snapshot.p2,
      p3: snapshot.p3,
      p4: snapshot.p4,
      p5: snapshot.p5,
      p6: snapshot.p6,
      p_prospect: snapshot.pProspect,
      api: snapshot.api,
      api_peak: snapshot.apiPeak,
      contributions: {
        ...snapshot.contributions,
        tickContext: context,
        adaptiveKappa: this.adaptiveKappa.current(),
      },
    });

    this.repository.recordPersonalitySnapshot({
      tick: this.tick,
      created_ms: context.nowMs,
      pi_d: this.personality.diligence,
      pi_c: this.personality.curiosity,
      pi_s: this.personality.sociability,
      pi_x: this.personality.caution,
    });

    const loudness = computeLoudness({
      world: this.repository.world,
      pressure,
      personality: this.personality,
      channelId: context.channelId,
      senderId: context.senderId,
      chatType: context.channelId && this.repository.world.has(context.channelId) && this.repository.world.getNodeType(context.channelId) === 'channel'
        ? this.repository.world.getChannel(context.channelId).chat_type
        : undefined,
      directed: context.directed,
      nowMs: context.nowMs,
      fatigueState: this.voiceFatigue,
    });
    const voiceReasons = loudness.focalSets.diligence.reasons
      .concat(loudness.focalSets.curiosity.reasons)
      .concat(loudness.focalSets.sociability.reasons)
      .concat(loudness.focalSets.caution.reasons)
      .slice(0, 8);
    this.lastVoiceSelection = selectVoice(loudness.loudness, loudness.fatigue, voiceReasons, {
      deterministic: this.config.debug,
    });
    rememberSelectedVoice(this.voiceFatigue, this.lastVoiceSelection.selected);

    this.logger.debug('Nova pressure tick computed', {
      tick: this.tick,
      p1: pressure.P1,
      p2: pressure.P2,
      p3: pressure.P3,
      p4: pressure.P4,
      p5: pressure.P5,
      p6: pressure.P6,
      pProspect: pressure.P_prospect,
      api: pressure.API,
      apiPeak: pressure.API_peak,
      selectedVoice: this.lastVoiceSelection.selected,
      voiceLoudness: this.lastVoiceSelection.loudness,
      voiceProbabilities: this.lastVoiceSelection.probabilities,
      voiceTemperature: this.lastVoiceSelection.temperature,
    });

    return { pressure: snapshot, voice: this.lastVoiceSelection };
  }

  private recordSilence(entry: Parameters<NovaWorldRepository['recordSilence']>[0]): void {
    this.silenceCount += 1;
    this.repository?.recordSilence(entry);
  }

  private recordError(error: unknown): void {
    this.lastError = sanitizeRuntimeError(error);
    this.logger.error(`Nova Runtime error: ${this.lastError}`);
  }

  updateConfig(config: NovaRuntimeConfig): void {
    const dbPathChanged = this.config.dbPath !== config.dbPath;
    this.config = config;

    if (dbPathChanged) {
      this.logger.warn('Nova dbPath changed; database connection changes will take effect after restart');
    }

    this.logger.debug('Nova Core config updated');
  }

  updateSelfId(selfId: string | undefined): void {
    this.selfId = selfId;
  }
}

function sanitizeRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[-_ ]?key|authorization|token|secret)(["'\s:=]+)[^\s,"'}]+/gi, '$1$2[redacted]')
    .slice(0, 500);
}
