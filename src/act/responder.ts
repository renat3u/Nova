import type { NovaAction, NovaMessageEvent, NovaRuntimeConfig } from '../core/types';
import type { NovaLogger } from '../core/logger';
import type { MemoryService } from '../memory/memory-service';
import type { PersonalityVector } from '../personality/vector';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { VoiceSelectionResult } from '../voices/selection';
import type { NovaWorldRepository } from '../world/repository';
import { OpenAICompatibleLLMClient } from '../llm/client';
import { buildNovaChatMessages, buildNovaProactiveChatMessages } from '../llm/prompts';
import { LLMGenerationError, type LLMConfig, type NovaLLMResponse, type NovaPromptInput, type NovaProactivePromptInput } from '../llm/response-schema';
import { readRV, readVelocity, renderRelationshipFacts, computeCloseness, classifyCloseness } from '../world/relationship-vector';
import { generateGroupProfileSummary } from '../relationships/group-profile';
import type { MoodTracker } from '../engine/mood';
import { applyNovaStateUpdates, type StateWritebackResult } from '../llm/state-writeback';

export interface NovaResponderOptions {
  config: NovaRuntimeConfig;
  repository: NovaWorldRepository;
  memoryService: MemoryService;
  logger: NovaLogger;
  personality: PersonalityVector;
  moodTracker?: MoodTracker;
}

export interface BuildReplyActionOptions {
  event: NovaMessageEvent;
  pressure: PressureSnapshot;
  voice: VoiceSelectionResult;
  /** Optional instruction from decision agent guiding tone/intent. */
  responderIntent?: string;
  /** Private decision reason for trace only. */
  decisionReason?: string;
  /** Available stickers for the responder to choose from (with real keys). */
  availableStickers?: Array<{
    emojiPackageId: number;
    emojiId: string;
    key: string;
    summary?: string;
  }>;
}

export interface BuildProactiveActionOptions {
  targetName: string;
  targetQQ: string;
  channelId: string;
  contactId?: string;
  scene: 'private' | 'group';
  voice: VoiceSelectionResult;
  desireType: string;
  desireUrgency: string;
  /** Optional instruction from decision agent guiding tone/intent. */
  responderIntent?: string;
  /** Private decision reason for trace only. */
  decisionReason?: string;
}

export interface ReplyBuildResult {
  action?: NovaAction;
  text?: string;
  error?: string;
  memoryReviewed?: boolean;
  stateWriteback?: StateWritebackResult;
}

export class NovaResponder {
  constructor(private readonly options: NovaResponderOptions) {}

  async buildReplyAction(options: BuildReplyActionOptions): Promise<ReplyBuildResult> {
    const promptInput = this.buildPromptInput(options);
    if (containsForbiddenPromptIdentity(promptInput)) {
      this.options.logger.error('Nova prompt identity validation failed');
      return { error: 'prompt_identity_violation' };
    }

    try {
      const response = await new OpenAICompatibleLLMClient(this.llmConfig()).generateReply(promptInput);
      const validation = validateNovaLLMResponse(response, this.options.config.maxReplyLength);
      if (!validation.ok) return { error: validation.reason };

      const memoryReviewed = this.reviewMemoryCandidate(response, options);

      // Apply state writeback from LLM response.
      let stateWriteback: StateWritebackResult | undefined;
      if (response.stateUpdates && response.stateUpdates.length > 0) {
        stateWriteback = applyNovaStateUpdates(response.stateUpdates, {
          event: options.event,
          channelId: options.event.chatId,
          contactId: options.event.senderId,
          nowMs: options.event.timestamp || Date.now(),
          source: 'reply',
          pressure: options.pressure,
          isGroup: options.event.chatType === 'group',
        }, {
          repository: this.options.repository,
          memoryService: this.options.memoryService,
          moodTracker: this.options.moodTracker!,
          logger: this.options.logger,
        });
      }

      // Check for send_sticker state update to attach to the action
      const stickerFromWriteback = extractStickerFromWriteback(stateWriteback);
      if (stickerFromWriteback) {
        this.options.logger.info('Nova responder attached sticker to action', {
          emojiPackageId: stickerFromWriteback.emojiPackageId,
          emojiId: stickerFromWriteback.emojiId,
          summary: stickerFromWriteback.summary,
        });
      }

      return {
        action: {
          type: 'send_text',
          target: {
            chatType: options.event.chatType,
            channelId: options.event.chatId,
            ...(options.event.chatType === 'private' ? { userId: options.event.senderQQ } : {}),
            ...(options.event.chatType === 'group' && options.event.groupId ? { groupId: options.event.groupId } : {}),
          },
          text: validation.text,
          ...(stickerFromWriteback ? { sticker: stickerFromWriteback } : {}),
          ...(this.options.config.quoteReply ? { quoteMessageId: options.event.rawMessageId.toString() } : {}),
        },
        text: validation.text,
        memoryReviewed,
        stateWriteback,
      };
    } catch (error) {
      const message = error instanceof LLMGenerationError
        ? `${error.code}${error.status ? `:${error.status}` : ''}`
        : error instanceof Error ? error.message : String(error);
      this.options.logger.warn(`Nova LLM reply generation failed: ${message}`);
      return { error: `llm_${error instanceof LLMGenerationError ? error.code : 'error'}` };
    }
  }

  /** Build a proactive message (for scheduled ticks). */
  async buildProactiveAction(options: BuildProactiveActionOptions): Promise<ReplyBuildResult> {
    const promptInput = this.buildProactivePromptInput(options);

    try {
      const response = await new OpenAICompatibleLLMClient(this.llmConfig()).generateProactive(promptInput);
      const maxLen = options.scene === 'group'
        ? Math.max(40, Math.ceil(this.options.config.maxReplyLength * 0.55))
        : this.options.config.maxReplyLength;
      const validation = validateProactiveResponse(response, options, maxLen);
      if (!validation.ok) return { error: validation.reason };

      // Apply state writeback.
      let stateWriteback: StateWritebackResult | undefined;
      if (response.stateUpdates && response.stateUpdates.length > 0) {
        stateWriteback = applyNovaStateUpdates(response.stateUpdates, {
          channelId: options.channelId,
          contactId: options.contactId,
          nowMs: Date.now(),
          source: 'proactive',
          isGroup: options.scene === 'group',
        }, {
          repository: this.options.repository,
          memoryService: this.options.memoryService,
          moodTracker: this.options.moodTracker!,
          logger: this.options.logger,
        });
      }

      return {
        text: validation.text,
        stateWriteback,
      };
    } catch (error) {
      const message = error instanceof LLMGenerationError
        ? `${error.code}${error.status ? `:${error.status}` : ''}`
        : error instanceof Error ? error.message : String(error);
      this.options.logger.warn(`Nova LLM proactive generation failed: ${message}`);
      return { error: `llm_${error instanceof LLMGenerationError ? error.code : 'error'}` };
    }
  }

  private buildPromptInput(options: BuildReplyActionOptions): NovaPromptInput {
    const recentMessages = this.options.repository.getRecentMessages(options.event.chatId, 12).map((message) => ({
      senderName: message.sender_id === options.event.senderId ? options.event.senderName : undefined,
      text: message.text,
      isNova: false,
    }));
    const workingMemory = this.options.memoryService.getWorkingMemory(7).map((item) => item.content);
    const longTermMemory = this.options.memoryService.getRelevantFacts({
      text: options.event.text,
      subjectId: options.event.senderId,
      limit: 8,
    }).map((fact) => fact.content);

    // Build decision intent guidance for the prompt
    const decisionGuidance = options.responderIntent
      ? `\nDecision intent: ${options.responderIntent}\nUse this as private guidance for what kind of response to produce. Do not mention it.`
      : '';

    const upcomingEvents = this.getUpcomingEventsForContact(options.event.senderId, Date.now());
    const closenessLevel = this.getClosenessLevelForContact(options.event.senderId);
    const layeredMemory = this.options.memoryService.retrieveForPrompt({
      currentText: options.event.text,
      senderId: options.event.senderId,
      channelId: options.event.chatId,
      limit: 8,
    });

    return {
      event: options.event,
      recentMessages,
      selectedVoice: options.voice,
      pressure: options.pressure,
      personality: this.options.personality,
      workingMemory,
      longTermMemory,
      maxReplyLength: this.options.config.maxReplyLength,
      layeredMemory,
      ...(decisionGuidance ? { decisionGuidance } : {}),
      ...(options.availableStickers && options.availableStickers.length > 0
        ? { availableStickers: options.availableStickers }
        : {}),
      ...(upcomingEvents.length > 0 ? { upcomingEvents } : {}),
      ...(closenessLevel ? { closenessLevel } : {}),
    };
  }

  private buildProactivePromptInput(options: BuildProactiveActionOptions): NovaProactivePromptInput {
    const recentMessages = this.options.repository.getRecentMessages(options.channelId, 12).map((message) => ({
      senderName: message.sender_id === options.contactId ? options.targetName : undefined,
      text: message.text,
      isNova: false,
    }));

    const workingMemory = this.options.memoryService.getWorkingMemory(7).map((item) => item.content);
    const longTermMemory = options.contactId
      ? this.options.memoryService.getRelevantFacts({
          text: options.targetName,
          subjectId: options.contactId,
          limit: 8,
        }).map((fact) => fact.content)
      : this.options.memoryService.getRelevantFacts({ limit: 8 }).map((fact) => fact.content);

    const relationshipFacts = options.contactId
      ? this.relationshipFactsForContact(options.contactId, options.targetName)
      : [];

    const groupProfileSummary = options.scene === 'group'
      ? generateGroupProfileSummary(this.options.repository.getGroupProfile(options.targetQQ))
      : null;

    const activeThreads = this.getActiveThreadsForChannel(options.channelId);

    const nowMs = Date.now();

    // Build decision guidance for the proactive prompt
    const decisionGuidance = options.responderIntent
      ? `Decision intent: ${options.responderIntent}\nUse this as private guidance for what kind of message to produce. Do not mention it.`
      : undefined;

    const upcomingEvents = options.contactId
      ? this.getUpcomingEventsForContact(options.contactId, nowMs)
      : [];
    const closenessLevel = options.contactId
      ? this.getClosenessLevelForContact(options.contactId)
      : undefined;
    const layeredMemory = this.options.memoryService.retrieveForPrompt({
      currentText: options.targetName,
      senderId: options.contactId ?? '',
      channelId: options.channelId,
      limit: 8,
    });

    return {
      targetName: options.targetName,
      targetQQ: options.targetQQ,
      scene: options.scene,
      selectedVoice: options.voice,
      desireType: options.desireType,
      desireUrgency: options.desireUrgency,
      recentMessages,
      workingMemory,
      longTermMemory,
      layeredMemory,
      relationshipFacts: relationshipFacts.length > 0 ? relationshipFacts : undefined,
      groupProfileSummary,
      activeThreads,
      maxReplyLength: options.scene === 'group'
        ? Math.max(40, Math.ceil(this.options.config.maxReplyLength * 0.55))
        : this.options.config.maxReplyLength,
      nowMs,
      selfMood: this.options.moodTracker?.current,
      ...(decisionGuidance ? { decisionGuidance } : {}),
      ...(upcomingEvents.length > 0 ? { upcomingEvents } : {}),
      ...(closenessLevel ? { closenessLevel } : {}),
    };
  }

  private getClosenessLevelForContact(contactId: string): string | undefined {
    if (!this.options.repository.world.has(contactId)
      || this.options.repository.world.getNodeType(contactId) !== 'contact') return undefined;
    const contact = this.options.repository.world.getContact(contactId);
    const rv = readRV(contact);
    const closeness = computeCloseness(rv);
    if (closeness < 0.1) return undefined;
    return classifyCloseness(closeness);
  }

  private getUpcomingEventsForContact(contactId: string, nowMs: number): Array<{
    event: string;
    dateDescription: string;
    targetId: string;
  }> {
    try {
      const allEvents = this.options.repository.listUpcomingEvents(nowMs, 30 * 24 * 3600 * 1000);
      return allEvents
        .filter((e) => e.targetId === contactId || e.targetId.includes(contactId.split(':').pop() ?? ''))
        .map((e) => ({
          event: e.event,
          dateDescription: e.dateDescription,
          targetId: e.targetId,
        }))
        .slice(0, 3);
    } catch {
      return [];
    }
  }

  private relationshipFactsForContact(contactId: string, displayName: string): string[] {
    if (!this.options.repository.world.has(contactId)) return [];
    const contact = this.options.repository.world.getContact(contactId);
    const rv = readRV(contact);
    const velocity = readVelocity(contact);
    const rendered = renderRelationshipFacts(rv, velocity, displayName);
    return rendered ? [rendered] : [];
  }

  private getActiveThreadsForChannel(channelId: string): string[] {
    try {
      const threads = this.options.repository.getActiveThreadsForChannel(channelId, Date.now(), 3);
      return threads.map((t) => t.summary);
    } catch {
      return [];
    }
  }

  private llmConfig(): LLMConfig {
    return {
      baseUrl: this.options.config.llmBaseUrl,
      apiKey: this.options.config.llmApiKey,
      model: this.options.config.llmModel,
      temperature: 0.7,
      maxTokens: Math.max(64, Math.min(2048, Math.ceil(this.options.config.maxReplyLength * 1.8))),
      timeoutMs: 30_000,
    };
  }

  private reviewMemoryCandidate(response: NovaLLMResponse, options: BuildReplyActionOptions): boolean {
    const candidate = response.memoryCandidate?.trim();
    if (!candidate) return false;

    const review = this.options.memoryService.reviewMemoryCandidate(candidate, {
      event: options.event,
      source: 'llm',
      salience: Math.min(1, Math.max(0.3, options.pressure.api / 6)),
      nowMs: options.event.timestamp || Date.now(),
    });
    this.options.logger.debug('Nova memory candidate reviewed', {
      accepted: review.accepted,
      reason: review.reason,
      hasFact: review.fact !== undefined,
      hasWorkingItem: review.workingItem !== undefined,
    });
    return true;
  }
}

export interface ReplyValidationResult {
  ok: boolean;
  text: string;
  reason?: string;
}

export interface ProactiveValidationResult {
  ok: boolean;
  text: string;
  reason?: string;
}

export function validateNovaLLMResponse(response: NovaLLMResponse, maxReplyLength: number): ReplyValidationResult {
  const text = unwrapText(response.text).trim();
  if (text.length === 0) return { ok: false, text: '', reason: 'empty_llm_text' };
  if (hasSelfAliceIdentity(text)) return { ok: false, text, reason: 'identity_residue' };
  if (containsPromptLeak(text)) return { ok: false, text, reason: 'prompt_leak' };
  if (looksLikeJsonEnvelope(text)) return { ok: false, text, reason: 'json_envelope_residue' };

  const limited = text.length > maxReplyLength ? text.slice(0, maxReplyLength).trimEnd() : text;
  return limited.length > 0 ? { ok: true, text: limited } : { ok: false, text: '', reason: 'empty_after_truncate' };
}

export function validateProactiveResponse(
  response: NovaLLMResponse,
  options: BuildProactiveActionOptions,
  maxReplyLength: number,
): ProactiveValidationResult {
  const text = unwrapText(response.text).trim();
  if (text.length === 0) return { ok: false, text: '', reason: 'empty_llm_text' };
  if (hasSelfAliceIdentity(text)) return { ok: false, text, reason: 'identity_residue' };
  if (containsPromptLeak(text)) return { ok: false, text, reason: 'prompt_leak' };
  if (looksLikeJsonEnvelope(text)) return { ok: false, text, reason: 'json_envelope_residue' };

  if (hasHighPressureExpression(text, options.desireType)) {
    return { ok: false, text, reason: 'proactive_high_pressure_expression' };
  }
  if (exposesSystemMotivation(text)) {
    return { ok: false, text, reason: 'proactive_system_motivation_exposed' };
  }
  if (hasInterrogationPattern(text)) {
    return { ok: false, text, reason: 'proactive_interrogation_pattern' };
  }

  const effectiveMax = Math.max(20, maxReplyLength);
  const limited = text.length > effectiveMax ? text.slice(0, effectiveMax).trimEnd() : text;
  return limited.length > 0 ? { ok: true, text: limited } : { ok: false, text: '', reason: 'empty_after_truncate' };
}

function hasHighPressureExpression(text: string, desireType: string): boolean {
  const highPressurePatterns = [
    /你怎么不[说话理回]/,
    /为什么不[理回]我/,
    /你[去在]哪[了里]/,
    /你还[好行]吗[？?]/,
    /你没事[吧吗][？?]/,
    /你怎么[了啦][？?]/,
    /你消失/,
    /你不在[了啦][？?]/,
    /你忘[了记]我吗/,
  ];
  const matchCount = highPressurePatterns.filter((p) => p.test(text)).length;
  if (desireType === 'reconnect') return matchCount > 1;
  return matchCount > 0;
}

function exposesSystemMotivation(text: string): boolean {
  return /因为好奇.*来找你|我.*好奇.*所以|内部系统|压力值|声部选择|IAUS|gate|whitelist|白名单|主动发言|proactive/i.test(text)
    || /系统.*让我|按照.*规则|根据.*算法/i.test(text);
}

function hasInterrogationPattern(text: string): boolean {
  if (/请回答以下|以下几个问题|回答下列|请告诉我[：:]|回答一下[：:]/.test(text)) return true;
  const questionMarkCount = (text.match(/[？?]/g) ?? []).length;
  if (questionMarkCount >= 3) return true;
  const interrogativeCount = (text.match(/(吗|呢|吧)[？?]/g) ?? []).length;
  return interrogativeCount >= 2 && text.length < 100;
}

function extractStickerFromWriteback(
  stateWriteback: StateWritebackResult | undefined,
): import('../core/types').NovaStickerRef | undefined {
  if (!stateWriteback) return undefined;
  const stickerAccepted = stateWriteback.accepted.find((a) => a.type === 'send_sticker');
  if (!stickerAccepted) return undefined;
  const data = stickerAccepted.normalized as {
    emoji_package_id: number;
    emoji_id: string;
    key: string;
    summary?: string;
  };
  return {
    emojiPackageId: data.emoji_package_id,
    emojiId: data.emoji_id,
    key: data.key,
    ...(data.summary ? { summary: data.summary } : {}),
  };
}

function containsForbiddenPromptIdentity(input: NovaPromptInput): boolean {
  const serialized = buildNovaChatMessages(input).map((message) => message.content).join('\n');
  return /\bYou are Alice\b|\bAlice should\b/i.test(serialized);
}

function unwrapText(text: string): string {
  return text.replace(/^```(?:text)?\s*([\s\S]*?)\s*```$/i, '$1');
}

function hasSelfAliceIdentity(text: string): boolean {
  return /\b(?:I am|I'm|my name is|call me)\s+Alice\b/i.test(text)
    || /\bAlice\s+here\b/i.test(text)
    || /(我是|我叫|这里是|叫我)\s*爱丽丝/i.test(text)
    || /(我是|我叫|这里是|叫我)\s*Alice/i.test(text);
}

function containsPromptLeak(text: string): boolean {
  return /system prompt|developer prompt|JSON schema|internal pressure|voice selection|gate has already decided/i.test(text)
    || /系统提示词|开发者提示|内部压力|声部选择|沉默门控/.test(text);
}

function looksLikeJsonEnvelope(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'text' in parsed;
  } catch {
    return false;
  }
}
