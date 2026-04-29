import type { NovaMessageEvent } from '../core/types';
import { clamp01 } from '../world/constants';
import type { FactAttrs, FactType } from '../world/entities';
import type { LongTermMemory } from './long-term-memory';
import type { WorkingMemory, WorkingMemoryItem } from './working-memory';

export interface MemoryCandidateContext {
  event?: NovaMessageEvent;
  source: 'message' | 'llm' | 'interaction';
  salience?: number;
  nowMs?: number;
}

export interface MemoryReviewResult {
  accepted: boolean;
  reason: string;
  fact?: FactAttrs;
  workingItem?: WorkingMemoryItem;
}

export class MemoryService {
  constructor(
    readonly workingMemory: WorkingMemory,
    readonly longTermMemory: LongTermMemory,
  ) {}

  load(): void {
    this.workingMemory.load();
  }

  flush(): void {
    this.workingMemory.flush();
  }

  getWorkingMemory(limit?: number): WorkingMemoryItem[] {
    return this.workingMemory.getTopItems(limit);
  }

  getRelevantFacts(input: { text?: string; subjectId?: string; limit?: number }): FactAttrs[] {
    return this.longTermMemory.getRelevantFacts(input);
  }

  reviewMemoryCandidate(candidate: string, context: MemoryCandidateContext): MemoryReviewResult {
    const content = candidate.trim();
    if (content.length < 6) return { accepted: false, reason: 'too_short' };
    if (isGreeting(content)) return { accepted: false, reason: 'ordinary_greeting' };
    if (looksHallucinated(content)) return { accepted: false, reason: 'unverified_model_claim' };

    const event = context.event;
    const factType = inferFactType(content);
    const salience = clamp01(context.salience ?? inferSalience(content, event));
    const isPrivate = event?.chatType === 'private';
    const highSalienceGroup = event?.chatType === 'group' && salience >= 0.75;

    if (containsSensitivePersonalInfo(content) && event?.chatType === 'group') {
      return { accepted: false, reason: 'sensitive_group_personal_info' };
    }

    const allowed = isPrivate
      || factType === 'commitment'
      || factType === 'preference'
      || highSalienceGroup
      || context.source === 'interaction';
    if (!allowed) return { accepted: false, reason: 'low_confidence_context' };

    const workingItem = this.workingMemory.addCandidate({
      content,
      salience,
      sourceEventId: event?.id,
      nowMs: context.nowMs,
    }) ?? undefined;

    const fact = this.longTermMemory.addFact({
      content,
      subjectId: event?.senderId,
      factType,
      importance: Math.max(0.3, salience),
      volatility: factType === 'observation' ? 0.03 : 0.01,
      tracked: true,
      nowMs: context.nowMs,
    });

    return { accepted: true, reason: 'accepted', fact, workingItem };
  }
}

function inferFactType(content: string): FactType {
  if (/\b(喜欢|偏好|讨厌|希望|prefer|like|dislike|favorite)\b/i.test(content)) return 'preference';
  if (/\b(承诺|答应|约定|todo|deadline|明天|下周|promise|will)\b/i.test(content)) return 'commitment';
  if (content.length > 80) return 'summary';
  return 'observation';
}

function inferSalience(content: string, event: NovaMessageEvent | undefined): number {
  let score = event?.isDirected ? 0.55 : 0.35;
  if (/[!！?？]/.test(content)) score += 0.1;
  if (/\b(重要|记住|别忘|必须|deadline|urgent|important)\b/i.test(content)) score += 0.25;
  if (content.length > 60) score += 0.1;
  return score;
}

function isGreeting(content: string): boolean {
  return /^(你好|您好|嗨|哈喽|hello|hi|hey|早|晚安)[。.!！\s]*$/i.test(content);
}

function looksHallucinated(content: string): boolean {
  return /^(用户可能|也许|看起来|我猜|可能是|the user may|it seems)/i.test(content);
}

function containsSensitivePersonalInfo(content: string): boolean {
  return /(身份证|手机号|电话|住址|地址|银行卡|密码|token|api key|apikey|secret)/i.test(content);
}
