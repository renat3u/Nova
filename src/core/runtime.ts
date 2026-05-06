import type { NovaLogger } from './logger';
import { noopLogger } from './logger';
import type { NovaAction, NovaMessageEvent, NovaRuntimeConfig } from './types';
import { NovaResponder } from '../act/responder';
import { ActionQueue, type QueuedAction } from '../act/action-queue';
import { type ActExecutor, startActLoop, type ActContext } from '../act/act-loop';
import { openNovaDb, type NovaDbConnection } from '../db/sqlite';
import { RateLimitState } from '../gates/rate-limit';
import { LongTermMemory } from '../memory/long-term-memory';
import { MemoryService } from '../memory/memory-service';
import { WorkingMemory } from '../memory/working-memory';
import { DEFAULT_PERSONALITY_VECTOR, projectPersonalityVector, type PersonalityVector, type VoiceId } from '../personality/vector';
import type { VoiceFatigueState } from '../voices/loudness';
import type { VoiceSelectionResult } from '../voices/selection';
import { MoodTracker } from '../engine/mood';
import { AdaptiveKappa, createPressureHistory, type PressureHistory, type PressureSnapshot } from '../pressure/aggregate';
import { DEFAULT_KAPPA, qqIdFromNodeId } from '../world/constants';
import type { ChannelAttrs } from '../world/entities';
import { NovaWorldRepository } from '../world/repository';
import type { WorldModel } from '../world/model';
import type { NovaTickTrace, NovaActionTrace, NovaDeliberationTrace } from '../trace/types';
import { OpenAICompatibleDecisionClient } from '../decision/decision-client';
import { StickerDatabase } from '../stickers/sticker-db';
import { detectSentiment } from '../perception/sentiment';

// ── 新增架构组件 ─────────────────────────────────────────────────────────────

import { NovaEventBuffer } from './event-buffer';
import { TickClock } from './tick-clock';
import { createModeState, type ModeState } from '../engine/mode-fsm';
import { startEvolveLoop, type EvolveState, type EvolveLoopController, type ActionRecord } from './scheduler';
import { toPerturbation } from '../perception/perturbation';
import { evolveTick as unifiedEvolveTick } from '../engine/evolve-tick';

// ── 公共接口 ─────────────────────────────────────────────────────────────────

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
  stickerCount?: number;
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

// ── NovaRuntime ──────────────────────────────────────────────────────────────

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
  private readonly voiceFatigue: VoiceFatigueState = { recent: [], maxRecent: 6, voiceLastWonMs: {} as Record<VoiceId, number> };
  private readonly rateLimit = new RateLimitState();
  private lastVoiceSelection: VoiceSelectionResult | null = null;
  private processedMessages = 0;
  private sentActions = 0;
  private silenceCount = 0;
  private lastError?: string;

  // ActionQueue
  readonly actionQueue = new ActionQueue(50);
  private _lastActionTrace: NovaActionTrace | null = null;
  private actExecutor: ActExecutor | null = null;

  // Mood tracker
  private moodTracker: MoodTracker = new MoodTracker(0.05);

  // Decision client (lazy-init)
  private decisionClient: OpenAICompatibleDecisionClient | null = null;

  // Sticker database
  private stickerDb: StickerDatabase | null = null;

  // ── 新增：Alice 架构字段 ──────────────────────────────────────────────────

  /** 事件缓冲区 — 消息不再当场处理，全部推入 buffer。 */
  readonly buffer: NovaEventBuffer;

  /** 自适应 tick 时钟。 */
  readonly clock: TickClock;

  /** AgentMode 状态机。 */
  modeState: ModeState;

  /** LLM 退避状态。 */
  llmBackoff: { consecutiveFailures: number; lastFailureMs: number };

  /** 近期行动记录（供 EVOLVE 读取）。 */
  recentActions: ActionRecord[];

  /** 最近一次压力快照引用（供 ACT loop 的 staleness check 使用，evolveTick 更新 .current）。 */
  private readonly pressureRef = { current: null as PressureSnapshot | null };

  /** 用户活动追踪（Task 6: 静默惩罚）。 */
  userActivity: {
    lastUserInputMs: number;
    lastNovaProactiveMs: number;
    consecutiveUnansweredProactive: number;
  } = {
    lastUserInputMs: 0,
    lastNovaProactiveMs: 0,
    consecutiveUnansweredProactive: 0,
  };

  /** EVOLVE loop 控制器。 */
  private evolveController: EvolveLoopController | null = null;

  /** ACT loop 控制器。 */
  private actLoopController: ReturnType<typeof startActLoop> | null = null;

  constructor(options: NovaRuntimeOptions) {
    this.config = options.config;
    this.logger = options.logger ?? noopLogger;
    this.selfId = options.selfId;
    this.startedAt = options.startedAt ?? null;

    // 新架构初始化
    this.buffer = new NovaEventBuffer(
      options.config.eventBufferMaxSize,
      options.config.eventBufferMaxProtected,
    );
    this.clock = new TickClock({
      dtMin: options.config.tickDtMin,
      dtMax: options.config.tickDtMax,
      kappaT: options.config.tickKappaT,
    });
    this.modeState = createModeState();
    this.llmBackoff = { consecutiveFailures: 0, lastFailureMs: 0 };
    this.recentActions = [];
  }

  // ── 公共 getter ────────────────────────────────────────────────────────────

  get isRunning(): boolean { return this.running; }
  get startTime(): number | null { return this.startedAt; }
  get runtimeConfig(): NovaRuntimeConfig { return this.config; }
  get world(): WorldModel | null { return this.repository?.world ?? null; }
  get memory(): MemoryService | null { return this.memoryService; }
  get storagePath(): string | null { return this.db?.path ?? null; }
  get stickerCount(): number { return this.stickerDb?.count ?? 0; }
  get selectedVoice(): VoiceSelectionResult | null { return this.lastVoiceSelection; }

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
      stickerCount: this.stickerCount,
    };
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    this.db = openNovaDb(this.config.dbPath);
    this.repository = new NovaWorldRepository(this.db.db);
    this.repository.loadWorld();
    const workingMemory = new WorkingMemory(this.db.db);
    const longTermMemory = new LongTermMemory(this.db.db);
    this.memoryService = new MemoryService(workingMemory, longTermMemory);
    this.memoryService.load();

    const stickerDbPath = this.config.dbPath.replace(/nova\.sqlite$/, 'nova-stickers.sqlite');
    this.stickerDb = new StickerDatabase(stickerDbPath);

    this.running = true;
    this.startedAt = Date.now();
    this.logger.info(`Nova Core started${this.selfId ? ` for self_id=${this.selfId}` : ''} (stickers: ${this.stickerDb.count})`);

    // 启动 EVOLVE + ACT 协程
    if (this.repository) {
      this.startLoops();
    }
  }

  async stop(): Promise<void> {
    if (!this.running && !this.db) return;

    // 停止新架构协程
    if (this.evolveController) {
      this.evolveController.abort();
      this.evolveController = null;
    }
    if (this.actLoopController) {
      this.actLoopController.abort();
      this.actLoopController = null;
    }

    // 关闭队列
    this.actionQueue.close();

    try {
      this.memoryService?.flush();
    } finally {
      this.db?.close();
      this.db = null;
      this.repository = null;
      this.memoryService = null;
      this.stickerDb?.close();
      this.stickerDb = null;
      this.running = false;
    }

    this.logger.info('Nova Core stopped');
  }

  // ── 新架构：启动协程 ──────────────────────────────────────────────────────

  private startLoops(): void {
    if (!this.repository) return;

    const G = this.repository.world;
    const repository = this.repository;
    const logger = this.logger;

    // 构造 EvolveState
    const evolveState: EvolveState = {
      G,
      repository,
      buffer: this.buffer,
      queue: this.actionQueue,
      clock: this.clock,
      config: this.config,
      personality: this.personality,
      rateLimit: this.rateLimit,
      logger,
      memoryService: this.memoryService ?? undefined,
      moodTracker: this.moodTracker,
      modeState: this.modeState,
      getDecisionClient: () => this.getDecisionClient(),
      pressureHistory: this.pressureHistory,
      adaptiveKappa: this.adaptiveKappa,
      voiceFatigue: this.voiceFatigue,
      lastVoiceSelection: this.lastVoiceSelection,
      processedMessages: this.processedMessages,
      silenceCount: this.silenceCount,
      llmBackoff: this.llmBackoff,
      recentActions: this.recentActions,
      pressureRef: this.pressureRef,
      systemLock: 'idle',
      lastEnqueuedAction: null,
      evolveTickFn: async (state: EvolveState) => {
        return await unifiedEvolveTick(state);
      },
      // Task 6: 用户活动追踪
      userActivity: this.userActivity,
      // Task 3: 自动停止
      onAutoStop: () => {
        logger.info('Nova auto-stop callback invoked, stopping core...');
        // 异步停止（不阻塞 EVOLVE loop 退出）
        this.stop().catch((err) => logger.warn('Nova auto-stop error', err instanceof Error ? err.message : String(err)));
      },
    };

    // Task 5: 日志记录 proactive 配置状态
    logger.info(`Nova proactive: ${this.config.proactiveEnabled ? 'enabled' : 'disabled'}, mode: ${this.config.gatewayMode}, guardrails: ${this.config.decisionGuardrails}`);

    // 启动 EVOLVE loop
    this.evolveController = startEvolveLoop(evolveState);
    logger.info('Nova EVOLVE loop started');

    // 构造 ActContext 并启动 ACT loop
    if (this.actExecutor) {
      const actCtx: ActContext = {
        client: null,
        G,
        repository,
        config: this.config,
        queue: this.actionQueue,
        buffer: this.buffer,
        rateLimit: this.rateLimit,
        personality: this.personality,
        logger,
        getCurrentTick: () => this.clock.tick,
        getCurrentPressures: () => this.pressureRef.current ?? {
          tick: 0, createdMs: Date.now(),
          p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0, p7: 0, p8: 0,
          pProspect: 0, api: 0.5, apiPeak: 0.5, contributions: {},
        },
        recordAction: (action: string, target: string | null) => {
          this.recentActions.push({
            tick: this.clock.tick,
            actionType: action,
            targetId: target ?? '',
            status: 'success',
            createdMs: Date.now(),
          });
          if (this.recentActions.length > 100) {
            this.recentActions = this.recentActions.slice(-100);
          }
        },
        reportLLMOutcome: (success: boolean) => {
          if (!success) {
            this.llmBackoff.consecutiveFailures += 1;
            this.llmBackoff.lastFailureMs = Date.now();
          } else {
            this.llmBackoff.consecutiveFailures = 0;
          }
        },
      };

      this.actLoopController = startActLoop(actCtx, this.actExecutor);
      logger.info('Nova ACT loop started');
    }
  }

  // ── 消息处理（简化为仅推入 buffer）────────────────────────────────────────

  async handleMessage(event: NovaMessageEvent): Promise<NovaAction[]> {
    if (!this.running || !this.config.enabled) return [];

    // 记录用户活动（Task 6: 静默惩罚）
    this.userActivity.lastUserInputMs = Date.now();
    this.userActivity.consecutiveUnansweredProactive = 0;

    try {
      this.logger.debug(
        `Nova Core received ${event.chatType} message ${event.messageId} directed=${event.isDirected}`,
        { chatId: event.chatId, senderId: event.senderId, textLength: event.text.length },
      );

      // 注意：applyMessageEvent 不在此处调用
      // EVOLVE loop 的 perceiveTick 会在 drain buffer 后统一应用事件到世界模型
      // 避免双重写入（handleMessage + perceiveTick）

      // 保存贴纸
      if (event.stickers && event.stickers.length > 0 && this.stickerDb) {
        for (const sticker of event.stickers) {
          try {
            this.stickerDb.upsert({
              emoji_package_id: sticker.emojiPackageId,
              emoji_id: sticker.emojiId,
              key: sticker.key,
              summary: sticker.summary,
              url: sticker.url,
              sender_id: event.senderId,
              channel_id: event.chatId,
              message_id: event.messageId,
              chatType: event.chatType,
            });
          } catch (err) {
            this.logger.warn('Nova sticker upsert failed', err instanceof Error ? err.message : String(err));
          }
        }
      }

      this.rateLimit.rememberMessage(event);

      // 情感传染
      const sentiment = detectSentiment(event.text);
      if (sentiment && sentiment.confidence > 0.5) {
        this.moodTracker.nudge({
          valence: sentiment.valence,
          nowMs: event.timestamp || Date.now(),
          weight: 0.05,
        });
        if (event.chatId && this.repository) {
          this.repository.setRuntimeState(`last_sentiment:${event.chatId}`, {
            valence: sentiment.valence,
            confidence: sentiment.confidence,
            cues: sentiment.cues,
            updatedAt: event.timestamp || Date.now(),
          }, event.timestamp || Date.now());
        }
      }

      // 推入 EventBuffer — 不再当场回复
      const perturbation = toPerturbation(event);
      this.buffer.push(perturbation);
      this.processedMessages += 1;

      // ACT loop 统一负责所有消息发送
      return [];
    } catch (error) {
      this.recordError(error);
      throw error;
    }
  }

  // ── 用户活动追踪（Task 6: 静默惩罚）─────────────────────────────────────────

  /** 记录 proactive 消息已发送。 */
  recordProactiveSent(): void {
    this.userActivity.lastNovaProactiveMs = Date.now();
    this.userActivity.consecutiveUnansweredProactive += 1;
  }

  /** 用户回复后重置 proactive 计数器。 */
  recordUserReply(): void {
    this.userActivity.consecutiveUnansweredProactive = 0;
  }

  // ── Reply 构建（供 ACT loop 使用）──────────────────────────────────────────

  private async buildReplyWithIntent(
    event: NovaMessageEvent,
    pressure: PressureSnapshot,
    voice: VoiceSelectionResult,
    responderIntent?: string,
    decisionReason?: string,
    availableStickers?: Array<{
      emojiPackageId: number; emojiId: string; key: string; summary?: string;
    }>,
    preSelectedSticker?: {
      emojiPackageId: number; emojiId: string; key: string; summary?: string;
    },
  ) {
    return new NovaResponder({
      config: this.config,
      repository: this.repository!,
      memoryService: this.memoryService!,
      logger: this.logger,
      personality: this.personality,
      moodTracker: this.moodTracker,
    }).buildReplyAction({
      event,
      pressure,
      voice,
      ...(responderIntent ? { responderIntent } : {}),
      ...(decisionReason ? { decisionReason } : {}),
      ...(availableStickers && availableStickers.length > 0 ? { availableStickers } : {}),
      ...(preSelectedSticker ? { preSelectedSticker } : {}),
    });
  }

  getAvailableStickersForChannel(channelId: string): Array<{
    emojiPackageId: number; emojiId: string; key: string; summary?: string;
  }> {
    if (!this.stickerDb) return [];
    try {
      return this.stickerDb.listRecentByChannel(channelId, 8).map((s) => ({
        emojiPackageId: s.emoji_package_id,
        emojiId: s.emoji_id,
        key: s.key,
        ...(s.summary ? { summary: s.summary } : {}),
      }));
    } catch {
      return [];
    }
  }

  private getDecisionClient(): OpenAICompatibleDecisionClient | undefined {
    if (!this.config.decisionAgent.enabled) return undefined;
    if (!this.decisionClient) {
      this.decisionClient = new OpenAICompatibleDecisionClient(this.config.decisionAgent);
    }
    return this.decisionClient;
  }

  setActExecutor(executor: ActExecutor): void {
    this.actExecutor = executor;
  }

  // ── Reply / Proactive message 构建（保留供 ACT loop 使用）───────────────────

  /**
   * 为回复动作生成回复文本（使用原始消息事件作为上下文）。
   * 供 ACT loop 的 reply 执行路径使用。
   * 使用入队时保存的 pressureSnapshot 和 lastVoiceSelection，
   * 避免在 ACT 阶段重新计算压力（压力已在 EVOLVE 阶段确定）。
   */
  async buildReplyText(queuedAction: QueuedAction): Promise<string | null> {
    if (!this.memoryService || !this.repository) return null;
    const event = queuedAction.originalEvent;
    if (!event) return null;

    try {
      const pressure = queuedAction.pressureSnapshot ?? {
        tick: queuedAction.tick,
        createdMs: Date.now(),
        p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0, p7: 0, p8: 0,
        pProspect: 0, api: 0.5, apiPeak: 0.5, contributions: {},
      };
      const voice = this.lastVoiceSelection ?? defaultVoice();

      const stickers = this.getAvailableStickersForChannel(event.chatId);
      const reply = await this.buildReplyWithIntent(
        event,
        pressure,
        voice,
        queuedAction.decision?.responderIntent,
        queuedAction.decision?.reason,
        stickers,
      );
      return typeof reply.action === 'object' && 'text' in reply.action
        ? (reply.action as { text: string }).text
        : null;
    } catch (error) {
      this.logger.warn('Nova reply text generation error', error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async buildProactiveMessage(
    queuedAction: QueuedAction,
    channel: ChannelAttrs | undefined,
  ): Promise<string | null> {
    if (!this.memoryService || !this.repository) {
      this.logger.warn('Nova buildProactiveMessage: memoryService or repository unavailable');
      return null;
    }

    try {
      const candidate = queuedAction.candidate;
      const targetId = candidate.targetId ?? '';
      this.logger.info('Nova generating proactive message', { targetId, desireType: candidate.desireType, voice: this.lastVoiceSelection?.selected });
      const scene = candidate.scene ?? (channel?.chat_type ?? 'private');

      let targetName = 'someone';
      let targetQQ = '';
      let contactId: string | undefined;
      if (channel?.chat_type === 'private') {
        targetQQ = qqIdFromNodeId(channel.id);
        contactId = `qq:user:${targetQQ}`;
        if (this.repository.world.has(contactId)) {
          const contact = this.repository.world.getContact(contactId);
          targetName = contact.name ?? contact.nickname ?? targetQQ;
        }
      }

      const decision = (queuedAction as unknown as { decision?: { action?: string; reason?: string; confidence?: number; responderIntent?: string } }).decision;

      const reply = await new NovaResponder({
        config: this.config,
        repository: this.repository,
        memoryService: this.memoryService,
        logger: this.logger,
        personality: this.personality,
        moodTracker: this.moodTracker,
      }).buildProactiveAction({
        targetName,
        targetQQ,
        channelId: targetId,
        contactId,
        scene,
        voice: this.lastVoiceSelection ?? {
          selected: 'diligence' as const,
          iausAction: 'diligence' as const,
          loudness: { diligence: 0.5, curiosity: 0.5, sociability: 0.5, caution: 0.5 },
          fatigue: { diligence: 0, curiosity: 0, sociability: 0, caution: 0 },
          probabilities: { diligence: 0.4, curiosity: 0.3, sociability: 0.2, caution: 0.1 },
          temperature: 1.0,
          reasons: [],
        },
        desireType: candidate.desireType ?? 'reconnect',
        desireUrgency: candidate.urgency ?? 'medium',
        ...(decision?.responderIntent ? { responderIntent: decision.responderIntent } : {}),
        ...(decision?.reason ? { decisionReason: decision.reason } : {}),
      });

      const result = reply.text ?? null;
      this.logger.info('Nova proactive message generated', { targetId, hasText: result != null, textLen: result?.length ?? 0, hasError: reply.error != null, error: reply.error });
      return result;
    } catch (error) {
      this.logger.warn('Nova proactive text generation error', error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  // ── 动作记录 ──────────────────────────────────────────────────────────────

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

  markStickerSent(emojiPackageId: number, emojiId: string): void {
    if (!this.stickerDb) return;
    try {
      this.stickerDb.markSent(emojiPackageId, emojiId);
    } catch (err) {
      this.logger.debug('Nova sticker markSent failed', err instanceof Error ? err.message : String(err));
    }
  }

  // ── 查询方法 ──────────────────────────────────────────────────────────────

  getRecentActions(limit = 50): Array<{
    id: string; tick: number | null; actionType: string; targetId: string;
    text: string; status: string; error?: string; createdMs: number;
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
    id: string; tick: number | null; targetId: string; level: string;
    reason: string; values: Record<string, unknown>; createdMs: number;
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
    tick: number; p1: number; p2: number; p3: number; p4: number;
    p5: number; p6: number; p7: number; p8: number;
    pProspect: number; api: number; apiPeak: number;
    createdMs: number; contributions?: unknown;
  }> {
    return this.repository?.listPressureSnapshots(limit).map((snapshot) => ({
      tick: snapshot.tick,
      p1: snapshot.p1,
      p2: snapshot.p2,
      p3: snapshot.p3,
      p4: snapshot.p4,
      p5: snapshot.p5,
      p6: snapshot.p6,
      p7: snapshot.p7 ?? 0,
      p8: snapshot.p8 ?? 0,
      pProspect: snapshot.p_prospect,
      api: snapshot.api,
      apiPeak: snapshot.api_peak,
      createdMs: snapshot.created_ms ?? Date.now(),
      contributions: snapshot.contributions,
    })) ?? [];
  }

  get lastActionTrace(): NovaActionTrace | null { return this._lastActionTrace; }

  getTickTraces(limit = 50, reason?: 'message' | 'scheduled'): NovaTickTrace[] {
    return this.repository?.listTickTraces(limit, reason) ?? [];
  }

  getActionTraces(limit = 50): NovaActionTrace[] {
    return this.repository?.listActionTraces(limit) ?? [];
  }

  getDeliberationTraces(limit = 50, reason?: 'message' | 'scheduled'): NovaDeliberationTrace[] {
    return this.repository?.listDeliberationTraces(limit, reason) ?? [];
  }

  getProactiveTraceSummaries(limit = 50): Array<Record<string, unknown>> {
    return this.repository?.listProactiveTraceSummaries(limit) ?? [];
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

  private recordError(error: unknown): void {
    this.lastError = sanitizeRuntimeError(error);
    this.logger.error(`Nova Runtime error: ${this.lastError}`);
  }

  // ── 配置管理 ──────────────────────────────────────────────────────────────

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

function defaultVoice(): VoiceSelectionResult {
  return {
    selected: 'diligence' as const,
    iausAction: 'diligence' as const,
    loudness: { diligence: 0.5, curiosity: 0.5, sociability: 0.5, caution: 0.5 },
    fatigue: { diligence: 0, curiosity: 0, sociability: 0, caution: 0 },
    probabilities: { diligence: 0.4, curiosity: 0.3, sociability: 0.2, caution: 0.1 },
    temperature: 1.0,
    reasons: [],
  };
}

function sanitizeRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[-_ ]?key|authorization|token|secret)(["'\s:=]+)[^\s,"'}]+/gi, '$1$2[redacted]')
    .slice(0, 500);
}
