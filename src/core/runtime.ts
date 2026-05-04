import type { NovaLogger } from './logger';
import { noopLogger } from './logger';
import type { NovaAction, NovaMessageEvent, NovaRuntimeConfig } from './types';
import { NovaResponder } from '../act/responder';
import { ActionQueue, type QueuedAction } from '../act/action-queue';
import { ActLoop, type ActExecutor, type ActLoopTickResult } from '../act/act-loop';
import { openNovaDb, type NovaDbConnection } from '../db/sqlite';
import { runEvolveTick, type EvolveResult, type EvolveContext } from '../engine/evolve';
import { evaluateGates } from '../gates/gates';
import { RateLimitState } from '../gates/rate-limit';
import { buildSilenceLogEntry } from '../gates/silence-log';
import { LongTermMemory } from '../memory/long-term-memory';
import { MemoryService } from '../memory/memory-service';
import { WorkingMemory } from '../memory/working-memory';
import { DEFAULT_PERSONALITY_VECTOR, projectPersonalityVector, type PersonalityVector, type VoiceId } from '../personality/vector';
import { computeLoudness, rememberSelectedVoice, type VoiceFatigueState } from '../voices/loudness';
import { selectVoice, type VoiceSelectionResult } from '../voices/selection';
import { MoodTracker } from '../engine/mood';
import { buildSituationBriefing, checkSpeakingAlone, detectRhythmPattern } from '../engine/situation-briefing';
import { AdaptiveKappa, computeAllPressures, createPressureHistory, toPressureSnapshot, type PressureHistory, type PressureSnapshot } from '../pressure/aggregate';
import { DEFAULT_KAPPA, conversationIdForChannel, qqIdFromNodeId } from '../world/constants';
import type { ChannelAttrs } from '../world/entities';
import { NovaWorldRepository } from '../world/repository';
import type { WorldModel } from '../world/model';
import { buildTickTraceFromEvolve, buildActionTrace, buildDeliberationTrace, buildLlmStateWritebackSummary } from '../trace/writer';
import type { NovaTickTrace, NovaActionTrace, NovaDeliberationTrace } from '../trace/types';
import type { StateWritebackResult } from '../llm/state-writeback';
import { applyNovaStateUpdates } from '../llm/state-writeback';
import { readRV, readVelocity, renderRelationshipFacts } from '../world/relationship-vector';
import { generateGroupProfileSummary } from '../relationships/group-profile';
import { OpenAICompatibleDecisionClient } from '../decision/decision-client';
import { StickerDatabase } from '../stickers/sticker-db';
import { detectSentiment } from '../perception/sentiment';

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

  // ActLoop / ActionQueue fields
  private readonly actionQueue = new ActionQueue(50);
  private readonly actLoop = new ActLoop();
  private actExecutor: ActExecutor | null = null;

  // Mood tracker
  private moodTracker: MoodTracker = new MoodTracker(0.05);

  // Decision client (lazy-init)
  private decisionClient: OpenAICompatibleDecisionClient | null = null;

  // Sticker database (独立于 nova.sqlite)
  private stickerDb: StickerDatabase | null = null;

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

  get stickerCount(): number {
    return this.stickerDb?.count ?? 0;
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
      stickerCount: this.stickerCount,
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

    // Initialize sticker database (独立于 nova.sqlite)
    const stickerDbPath = this.config.dbPath.replace(/nova\.sqlite$/, 'nova-stickers.sqlite');
    this.stickerDb = new StickerDatabase(stickerDbPath);

    this.running = true;
    this.startedAt = Date.now();
    this.logger.info(`Nova Core started${this.selfId ? ` for self_id=${this.selfId}` : ''} (stickers: ${this.stickerDb.count})`);
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
      this.stickerDb?.close();
      this.stickerDb = null;
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

      // Save stickers to independent sticker database
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
            // Don't let sticker saving errors block message processing
            this.logger.debug('Nova sticker upsert failed', err instanceof Error ? err.message : String(err));
          }
        }
      }
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

      // ── Emotional contagion: detect sentiment from message and nudge mood ──
      const sentiment = detectSentiment(event.text);
      if (sentiment && sentiment.confidence > 0.5) {
        const contagionWeight = 0.05; // small weight — Nova won't be flipped by a single message
        this.moodTracker.nudge({
          valence: sentiment.valence,
          nowMs: event.timestamp || Date.now(),
          weight: contagionWeight,
        });

        // Store last detected sentiment for situation briefing injection
        if (event.chatId && this.repository) {
          this.repository.setRuntimeState(`last_sentiment:${event.chatId}`, {
            valence: sentiment.valence,
            confidence: sentiment.confidence,
            cues: sentiment.cues,
            updatedAt: event.timestamp || Date.now(),
          }, event.timestamp || Date.now());
        }

        this.logger.debug('Nova sentiment contagion', {
          valence: sentiment.valence.toFixed(3),
          confidence: sentiment.confidence.toFixed(2),
          cues: sentiment.cues,
        });
      }

      // Run evolve tick — this dispatches to algorithmic or agent mode internally.
      const evolveCtx = this.buildMessageEvolveContext(event, tickResult);
      const evolve = await runEvolveTick(evolveCtx);
      const plan = evolve.tickPlan;

      // Trace
      const tickTrace = buildTickTraceFromEvolve(plan, evolve);
      const actionTraces: NovaActionTrace[] = [];

      // Check for decision agent state updates (apply when no text is generated).
      let stateWriteback: StateWritebackResult | undefined;
      if (plan.decisionAgent?.action && plan.decisionAgent.action !== 'reply' && plan.decisionAgent.action !== 'ask' && plan.decisionAgent.action !== 'proactive') {
        // Non-text decision — apply state updates from decision agent.
        const updates = plan.decisionAgent.afterward
          ? [{ type: 'afterward' as const, value: plan.decisionAgent.afterward }]
          : undefined;
        if (updates && this.repository && this.memoryService) {
          stateWriteback = applyNovaStateUpdates(updates, {
            event,
            channelId: event.chatId,
            nowMs: event.timestamp || Date.now(),
            source: 'reply',
            pressure: tickResult.pressure,
            isGroup: event.chatType === 'group',
          }, {
            repository: this.repository,
            memoryService: this.memoryService,
            moodTracker: this.moodTracker,
            logger: this.logger,
          });
        }
      }

      // Apply decision based on agent or gate.
      if (plan.decisionAgent?.enabled) {
        const decision = plan.decisionAgent;
        switch (decision.action) {
          case 'reply':
          case 'ask': {
            if (!this.memoryService) {
              this.logSilence(event.chatId, tickResult, event, 'memory_service_unavailable');
              return [{ type: 'silence', reason: 'memory_service_unavailable', level: 'hard' }];
            }
            const stickers = this.getAvailableStickersForChannel(event.chatId);
            const reply = await this.buildReplyWithIntent(event, tickResult, decision.responderIntent, decision.reason, stickers);
            if (!reply.action) {
              this.logSilence(event.chatId, tickResult, event, reply.error ?? 'llm_reply_unavailable');
              return [{ type: 'silence', reason: reply.error ?? 'llm_reply_unavailable', level: 'normal' }];
            }

            // Trace
            actionTraces.push(buildActionTrace({
              tick: this.tick,
              actionType: 'send_text',
              targetId: event.chatId,
              text: typeof reply.action === 'object' && 'text' in reply.action ? (reply.action as { text: string }).text : undefined,
              voice: tickResult.voice.selected,
              reasoning: `agent_${decision.action}: ${decision.reason ?? ''}`,
              status: 'success',
              createdMs: Date.now(),
            }));

            this.traceDeliberation(tickTrace, actionTraces, stateWriteback);
            return [reply.action];
          }
          case 'proactive': {
            // Cross-target proactive: the action was already enqueued by evolve
            // to the action queue.  For the current message tick, Nova stays
            // silent in the group chat — the proactive PM will be sent by ActLoop.
            const silenceReason = 'DECISION_PROACTIVE_ENQUEUED';
            this.logSilence(event.chatId, tickResult, event, silenceReason, 'soft');

            actionTraces.push(buildActionTrace({
              tick: this.tick,
              actionType: 'proactive_enqueued',
              targetId: plan.selected?.targetId ?? event.chatId,
              voice: tickResult.voice.selected,
              reasoning: decision.reason,
              status: 'silence',
              createdMs: Date.now(),
            }));

            this.traceDeliberation(tickTrace, actionTraces, stateWriteback);
            return [{ type: 'silence', reason: silenceReason, level: 'soft' }];
          }
          case 'silence':
          case 'observe':
          case 'wait_reply':
          case 'cool_down': {
            const silenceLevel = decision.action === 'cool_down' ? 'normal' : 'soft';
            const silenceReason = `DECISION_${decision.action!.toUpperCase()}`;
            this.logSilence(event.chatId, tickResult, event, silenceReason, silenceLevel);

            actionTraces.push(buildActionTrace({
              tick: this.tick,
              actionType: decision.action!,
              targetId: event.chatId,
              voice: tickResult.voice.selected,
              reasoning: decision.reason,
              status: 'silence',
              createdMs: Date.now(),
            }));

            this.traceDeliberation(tickTrace, actionTraces, stateWriteback);
            return [{ type: 'silence', reason: silenceReason, level: silenceLevel as 'soft' | 'normal' }];
          }
          default:
            break;
        }
      }

      // Fallback: use gate decision.
      if (!plan.gateDecision.allow) {
        this.logSilence(event.chatId, tickResult, event, plan.gateDecision.reason, plan.gateDecision.level === 'none' ? 'soft' : plan.gateDecision.level);
        return [{ type: 'silence', reason: plan.gateDecision.reason, level: plan.gateDecision.level === 'none' ? 'soft' : plan.gateDecision.level }];
      }

      if (!this.memoryService) {
        this.logSilence(event.chatId, tickResult, event, 'memory_service_unavailable');
        return [{ type: 'silence', reason: 'memory_service_unavailable', level: 'hard' }];
      }

      const stickers = this.getAvailableStickersForChannel(event.chatId);
      const reply = await this.buildReplyWithIntent(event, tickResult, undefined, undefined, stickers);
      if (!reply.action) {
        this.logSilence(event.chatId, tickResult, event, reply.error ?? 'llm_reply_unavailable');
        return [{ type: 'silence', reason: reply.error ?? 'llm_reply_unavailable', level: 'normal' }];
      }

      this.traceDeliberation(tickTrace, actionTraces, stateWriteback);
      return [reply.action];
    } catch (error) {
      this.recordError(error);
      throw error;
    }
  }

  /** Build a reply action, optionally passing responderIntent from decision agent. */
  private async buildReplyWithIntent(
    event: NovaMessageEvent,
    tickResult: PressureTickResult,
    responderIntent?: string,
    decisionReason?: string,
    availableStickers?: Array<{
      emojiPackageId: number;
      emojiId: string;
      key: string;
      summary?: string;
    }>,
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
      pressure: tickResult.pressure,
      voice: tickResult.voice,
      ...(responderIntent ? { responderIntent } : {}),
      ...(decisionReason ? { decisionReason } : {}),
      ...(availableStickers && availableStickers.length > 0 ? { availableStickers } : {}),
    });
  }

  /** Get recently seen stickers for a channel to pass to the responder. */
  private getAvailableStickersForChannel(channelId: string): Array<{
    emojiPackageId: number;
    emojiId: string;
    key: string;
    summary?: string;
  }> {
    if (!this.stickerDb) return [];
    try {
      return this.stickerDb.listRecent(8).map((s) => ({
        emojiPackageId: s.emoji_package_id,
        emojiId: s.emoji_id,
        key: s.key,
        ...(s.summary ? { summary: s.summary } : {}),
      }));
    } catch {
      return [];
    }
  }

  /** Build evolve context for message ticks. */
  private buildMessageEvolveContext(event: NovaMessageEvent, tickResult: PressureTickResult): EvolveContext {
    const channel = this.repository!.world.has(event.chatId) && this.repository!.world.getNodeType(event.chatId) === 'channel'
      ? this.repository!.world.getChannel(event.chatId)
      : undefined;
    const conversationId = conversationIdForChannel(event.chatId);
    const conversation = this.repository!.world.has(conversationId) && this.repository!.world.getNodeType(conversationId) === 'conversation'
      ? this.repository!.world.getConversation(conversationId)
      : undefined;

    return {
      world: this.repository!.world,
      tick: this.tick,
      reason: 'message',
      pressure: tickResult.pressure,
      voice: tickResult.voice,
      config: this.config,
      rateLimit: this.rateLimit,
      nowMs: event.timestamp || Date.now(),
      repository: this.repository!,
      actionQueue: this.actionQueue,
      logger: this.logger,
      personality: this.personality,
      event,
      channel,
      conversation,
      memoryService: this.memoryService ?? undefined,
      moodTracker: this.moodTracker,
      decisionClient: this.getDecisionClient(),
    };
  }

  private getDecisionClient(): OpenAICompatibleDecisionClient | undefined {
    if (!this.config.decisionAgent.enabled) return undefined;
    if (!this.decisionClient) {
      this.decisionClient = new OpenAICompatibleDecisionClient(this.config.decisionAgent);
    }
    return this.decisionClient;
  }

  private logSilence(
    chatId: string,
    tickResult: PressureTickResult,
    event: NovaMessageEvent,
    reason: string,
    level: string = 'normal',
  ): void {
    const channel = this.repository!.world.has(chatId) && this.repository!.world.getNodeType(chatId) === 'channel'
      ? this.repository!.world.getChannel(chatId)
      : undefined;
    this.recordSilence(buildSilenceLogEntry({
      tick: this.tick,
      targetId: chatId,
      decision: {
        allow: false,
        level: level as 'soft' | 'normal' | 'hard' | 'safety',
        reason,
        reasons: [reason],
        values: {},
      },
      context: {
        nowMs: event.timestamp || Date.now(),
        reason: 'message',
        event,
        pressure: tickResult.pressure,
        voice: tickResult.voice,
        config: this.config,
        rateLimit: this.rateLimit,
      },
    }));
  }

  private traceDeliberation(
    tickTrace: NovaTickTrace,
    actionTraces: NovaActionTrace[],
    stateWriteback?: StateWritebackResult,
  ): void {
    if (!this.repository) return;
    const moodCtx = stateWriteback ? extractDeliberationMoodContext(stateWriteback) : {};
    const wbCtx = stateWriteback ? extractDeliberationWritebackContext(stateWriteback) : {};
    const deliberation = buildDeliberationTrace({
      tickTrace,
      actionTraces,
      ...moodCtx,
      ...wbCtx,
    });
    this.repository.recordDeliberationTrace(deliberation);
  }

  async runScheduledTick(nowMs = Date.now()): Promise<void> {
    if (!this.running || !this.config.enabled) return;

    try {
      const tickResult = this.computePressureTick({
        nowMs,
        reason: 'scheduled',
      });
      if (!tickResult || !this.repository) return;

      const evolveCtx: EvolveContext = {
        world: this.repository.world,
        tick: this.tick,
        reason: 'scheduled',
        pressure: tickResult.pressure,
        voice: tickResult.voice,
        config: this.config,
        rateLimit: this.rateLimit,
        nowMs,
        repository: this.repository,
        actionQueue: this.actionQueue,
        logger: this.logger,
        personality: this.personality,
        memoryService: this.memoryService ?? undefined,
        moodTracker: this.moodTracker,
        decisionClient: this.getDecisionClient(),
      };

      const evolve = await runEvolveTick(evolveCtx);
      const plan = evolve.tickPlan;

      // Record silence if nothing was enqueued.
      if (evolve.queuedActions.length === 0 && !plan.gateDecision.allow) {
        this.recordSilence(buildSilenceLogEntry({
          tick: this.tick,
          targetId: 'scheduled',
          decision: plan.gateDecision,
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

      // Trace
      if (this.repository) {
        const tickTrace = buildTickTraceFromEvolve(plan, evolve);
        this.repository.recordTickTrace(tickTrace);
      }
    } catch (error) {
      this.recordError(error);
      // Don't throw on scheduled ticks — let the scheduler continue.
      this.logger.warn('Nova scheduled tick failed', error instanceof Error ? error.message : String(error));
    }
  }

  /** Process the action queue (called by scheduler on ActLoop interval). */
  async processActionQueue(nowMs = Date.now()): Promise<ActLoopTickResult | null> {
    if (!this.running || !this.config.enabled || !this.actExecutor || !this.repository) return null;

    try {
      return await this.actLoop.tick(
        {
          actionQueue: this.actionQueue,
          world: this.repository.world,
          repository: this.repository,
          config: this.config,
          rateLimit: this.rateLimit,
          logger: this.logger,
        },
        this.actExecutor,
        nowMs,
      );
    } catch (error) {
      this.logger.warn('Nova ActLoop tick failed', error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /** Set the ActExecutor callback (wired by plugin layer). */
  setActExecutor(executor: ActExecutor): void {
    this.actExecutor = executor;
  }

  /** Build proactive message text via LLM (called by plugin layer). */
  async buildProactiveMessage(
    queuedAction: QueuedAction,
    channel: ChannelAttrs | undefined,
  ): Promise<string | null> {
    if (!this.memoryService || !this.repository) return null;

    try {
      const candidate = queuedAction.candidate;
      const targetId = candidate.targetId ?? '';
      const scene = candidate.scene ?? (channel?.chat_type ?? 'private');

      // Resolve target info
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

      // Get decision metadata from queued action if available
      const decision = (queuedAction as Record<string, unknown>).decision as
        | { action?: string; reason?: string; confidence?: number; responderIntent?: string }
        | undefined;

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

      return reply.text ?? null;
    } catch (error) {
      this.logger.warn('Nova proactive text generation error', error instanceof Error ? error.message : String(error));
      return null;
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

  /** Mark a sticker as sent in the sticker database. */
  markStickerSent(emojiPackageId: number, emojiId: string): void {
    if (!this.stickerDb) return;
    try {
      this.stickerDb.markSent(emojiPackageId, emojiId);
    } catch (err) {
      this.logger.debug('Nova sticker markSent failed', err instanceof Error ? err.message : String(err));
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
    p7: number;
    p8: number;
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
      p7: snapshot.p7 ?? 0,
      p8: snapshot.p8 ?? 0,
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
      moodValence: this.moodTracker.current,
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
      p7: snapshot.p7,
      p8: snapshot.p8,
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
      p7: pressure.P7,
      p8: pressure.P8,
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

// ── Trace helper functions ─────────────────────────────────────────────────

function extractDeliberationMoodContext(stateWriteback: StateWritebackResult): {
  afterward?: string;
  selfMoodBefore?: number;
  selfMoodAfter?: number;
} {
  const result: { afterward?: string; selfMoodBefore?: number; selfMoodAfter?: number } = {};
  if (stateWriteback.afterward) result.afterward = stateWriteback.afterward;
  if (stateWriteback.selfMoodBefore && typeof stateWriteback.selfMoodBefore === 'object') {
    result.selfMoodBefore = (stateWriteback.selfMoodBefore as { valence: number }).valence;
  }
  if (stateWriteback.selfMoodAfter && typeof stateWriteback.selfMoodAfter === 'object') {
    result.selfMoodAfter = (stateWriteback.selfMoodAfter as { valence: number }).valence;
  }
  return result;
}

function extractDeliberationWritebackContext(stateWriteback: StateWritebackResult): {
  llmStateUpdatesAccepted?: unknown;
  llmStateUpdatesRejected?: unknown;
} {
  const result: { llmStateUpdatesAccepted?: unknown; llmStateUpdatesRejected?: unknown } = {};
  if (stateWriteback.accepted.length > 0) result.llmStateUpdatesAccepted = stateWriteback.accepted;
  if (stateWriteback.rejected.length > 0) result.llmStateUpdatesRejected = stateWriteback.rejected;
  return result;
}

function sanitizeRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[-_ ]?key|authorization|token|secret)(["'\s:=]+)[^\s,"'}]+/gi, '$1$2[redacted]')
    .slice(0, 500);
}
