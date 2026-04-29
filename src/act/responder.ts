import type { NovaAction, NovaMessageEvent, NovaRuntimeConfig } from '../core/types';
import type { NovaLogger } from '../core/logger';
import type { MemoryService } from '../memory/memory-service';
import type { PersonalityVector } from '../personality/vector';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { VoiceSelectionResult } from '../voices/selection';
import type { NovaWorldRepository } from '../world/repository';
import { OpenAICompatibleLLMClient } from '../llm/client';
import { buildNovaChatMessages } from '../llm/prompts';
import { LLMGenerationError, type LLMConfig, type NovaLLMResponse, type NovaPromptInput } from '../llm/response-schema';

export interface NovaResponderOptions {
  config: NovaRuntimeConfig;
  repository: NovaWorldRepository;
  memoryService: MemoryService;
  logger: NovaLogger;
  personality: PersonalityVector;
}

export interface BuildReplyActionOptions {
  event: NovaMessageEvent;
  pressure: PressureSnapshot;
  voice: VoiceSelectionResult;
}

export interface ReplyBuildResult {
  action?: NovaAction;
  error?: string;
  memoryReviewed?: boolean;
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
          ...(this.options.config.quoteReply ? { quoteMessageId: options.event.rawMessageId.toString() } : {}),
        },
        memoryReviewed,
      };
    } catch (error) {
      const message = error instanceof LLMGenerationError
        ? `${error.code}${error.status ? `:${error.status}` : ''}`
        : error instanceof Error ? error.message : String(error);
      this.options.logger.warn(`Nova LLM reply generation failed: ${message}`);
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

    return {
      event: options.event,
      recentMessages,
      selectedVoice: options.voice,
      pressure: options.pressure,
      personality: this.options.personality,
      workingMemory,
      longTermMemory,
      maxReplyLength: this.options.config.maxReplyLength,
    };
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

export function validateNovaLLMResponse(response: NovaLLMResponse, maxReplyLength: number): ReplyValidationResult {
  const text = unwrapText(response.text).trim();
  if (text.length === 0) return { ok: false, text: '', reason: 'empty_llm_text' };
  if (hasSelfAliceIdentity(text)) return { ok: false, text, reason: 'identity_residue' };
  if (containsPromptLeak(text)) return { ok: false, text, reason: 'prompt_leak' };
  if (looksLikeJsonEnvelope(text)) return { ok: false, text, reason: 'json_envelope_residue' };

  const limited = text.length > maxReplyLength ? text.slice(0, maxReplyLength).trimEnd() : text;
  return limited.length > 0 ? { ok: true, text: limited } : { ok: false, text: '', reason: 'empty_after_truncate' };
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
