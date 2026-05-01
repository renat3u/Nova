import type { NovaAction, NovaMessageEvent, NovaRuntimeConfig } from '../core/types';
import type { NovaLogger } from '../core/logger';
import type { MemoryService } from '../memory/memory-service';
import type { PersonalityVector } from '../personality/vector';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { VoiceSelectionResult } from '../voices/selection';
import type { NovaWorldRepository } from '../world/repository';
import { OpenAICompatibleLLMClient } from '../llm/client';
import { buildNovaChatMessages, buildNovaProactiveChatMessages } from '../llm/prompts';
import { LLMGenerationError, type LLMConfig, type NovaLLMResponse, type NovaProactivePromptInput, type NovaPromptInput } from '../llm/response-schema';
import { readRV, readVelocity, renderRelationshipFacts } from '../world/relationship-vector';
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

    const relationshipFacts = options.contactId ? this.relationshipFactsForContact(options.contactId, options.targetName) : [];

    const groupProfileSummary = options.scene === 'group'
      ? generateGroupProfileSummary(this.options.repository.getGroupProfile(options.targetQQ))
      : null;

    // 活跃叙事线程 —— 从 repository 获取当前 channel 的活跃 threads
    const activeThreads = this.getActiveThreadsForChannel(options.channelId);

    const nowMs = Date.now();

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
      relationshipFacts: relationshipFacts.length > 0 ? relationshipFacts : undefined,
      groupProfileSummary,
      activeThreads,
      maxReplyLength: options.scene === 'group'
        ? Math.max(40, Math.ceil(this.options.config.maxReplyLength * 0.55))
        : this.options.config.maxReplyLength,
      nowMs,
      selfMood: this.options.moodTracker?.current,
    };
  }

export function validateProactiveResponse(
  response: NovaLLMResponse,
  options: BuildProactiveActionOptions,
  maxReplyLength: number,
): ProactiveValidationResult {
  const text = unwrapText(response.text).trim();
  if (text.length === 0) return { ok: false, text: '', reason: 'empty_llm_text' };
  if (hasSelfNovaIdentity(text)) return { ok: false, text, reason: 'identity_residue' };
  if (containsPromptLeak(text)) return { ok: false, text, reason: 'prompt_leak' };
  if (looksLikeJsonEnvelope(text)) return { ok: false, text, reason: 'json_envelope_residue' };

  // 主动消息特有校验
  if (hasHighPressureExpression(text, options.desireType)) {
    return { ok: false, text, reason: 'proactive_high_pressure_expression' };
  }
  if (exposesSystemMotivation(text)) {
    return { ok: false, text, reason: 'proactive_system_motivation_exposed' };
  }
  // Step 15: 审问/问卷模式检测 —— 防止探索消息变成调查问卷
  if (hasInterrogationPattern(text)) {
    return { ok: false, text, reason: 'proactive_interrogation_pattern' };
  }

  const effectiveMax = Math.max(20, maxReplyLength);
  const limited = text.length > effectiveMax ? text.slice(0, effectiveMax).trimEnd() : text;
  return limited.length > 0 ? { ok: true, text: limited } : { ok: false, text: '', reason: 'empty_after_truncate' };
}

/**
 * 检测高压表达。
 * 如 "你怎么不说话了"、"为什么不理我"、"消失了" 等。
 * reconnect desire 且高 urgency 时适当放宽，但仍不能像质问。
 */
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
  // reconnect + high urgency: 允许 1 条匹配，其余不允许
  if (desireType === 'reconnect') return matchCount > 1;
  return matchCount > 0;
}

/**
 * 检测系统动机暴露。
 * 如 "我因为好奇所以来找你"、"系统说..."、"我的压力..."、"IAUS" 等。
 */
function exposesSystemMotivation(text: string): boolean {
  return /因为好奇.*来找你|我.*好奇.*所以|内部系统|压力值|声部选择|IAUS|gate|whitelist|白名单|主动发言|proactive/i.test(text)
    || /系统.*让我|按照.*规则|根据.*算法/i.test(text);
}

/**
 * 检测审问/问卷模式 (Step 15)。
 *
 * 主动探索消息不能像调查问卷一样连续抛出问题。
 * 触发条件：
 *   - 3 个以上问号（连续追问）
 *   - 问卷式开头："请回答以下问题"、"以下几个问题"
 *   - 问句 + "?" 出现 3 次以上（短文本中）
 */
function hasInterrogationPattern(text: string): boolean {
  // 问卷式开头
  if (/请回答以下|以下几个问题|回答下列|请告诉我[：:]|回答一下[：:]/.test(text)) {
    return true;
  }

  // 统计问号数量
  const questionMarkCount = (text.match(/[？?]/g) ?? []).length;
  if (questionMarkCount >= 3) return true;

  // 短文本中 2 个以上疑问句式（如 "XX吗？YY呢？"）
  const interrogativeCount = (text.match(/(吗|呢|吧)[？?]/g) ?? []).length;
  if (interrogativeCount >= 2 && text.length < 100) return true;

  return false;
}

function containsForbiddenPromptIdentity(input: NovaPromptInput): boolean {
  const serialized = buildNovaChatMessages(input).map((message) => message.content).join('\n');
  return /\bYou are Alice\b|\bAlice should\b/i.test(serialized);
}

function unwrapText(text: string): string {
  return text.replace(/^```(?:text)?\s*([\s\S]*?)\s*```$/i, '$1');
}

function hasSelfNovaIdentity(text: string): boolean {
  return /\b(?:I am|I'm|my name is|call me)\s+Alice\b/i.test(text)
    || /\bAlice\s+here\b/i.test(text)
    || /(我是|我叫|这里是|叫我)\s*爱丽丝/i.test(text)
    || /(我是|我叫|这里是|叫我)\s*Alice/i.test(text);
}

function containsPromptLeak(text: string): boolean {
  return /system prompt|developer prompt|JSON schema|internal pressure|pressure\b|voice selection|\bgate\b|\bIAUS\b|whitelist|\btick\b/i.test(text)
    || /系统提示词|开发者提示|内部压力|压力数值|声部选择|沉默门控|白名单/.test(text);
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
