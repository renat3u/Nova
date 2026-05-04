import type { NovaMessageEvent } from '../core/types';
import type { FactAttrs, FactType } from '../world/entities';
import type { LongTermMemory } from './long-term-memory';
import type { WorkingMemory, WorkingMemoryItem } from './working-memory';
import {
  DIARY_CAP_PER_TURN,
  INJECT_LIMIT,
  MAX_ENTRY_LENGTH,
  SIMILARITY_THRESHOLD,
} from './working-memory';
import { retrieveRelevantMemories, formatMemoriesForPrompt, type MemoryHit, type RetrieveRelevantParams } from './memory-retrieval';

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

export interface MemoryCandidateContext {
  event?: NovaMessageEvent;
  source: 'message' | 'llm' | 'llm_state_update' | 'interaction' | 'engagement' | 'group_profile';
  salience?: number;
  nowMs?: number;
}

export interface MemoryReviewResult {
  accepted: boolean;
  reason: string;
  fact?: FactAttrs;
  workingItem?: WorkingMemoryItem;
}

export interface RelevantFactsOptions {
  text?: string;
  subjectId?: string;
  limit?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// MemoryService
// ═══════════════════════════════════════════════════════════════════════════

export class MemoryService {
  private turnWriteCount = 0;

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

  resetTurnCount(): void {
    this.turnWriteCount = 0;
  }

  getWorkingMemory(limit = INJECT_LIMIT): WorkingMemoryItem[] {
    return this.workingMemory.getTopItems(limit);
  }

  getRelevantFacts(options: RelevantFactsOptions): FactAttrs[] {
    return this.longTermMemory.getRelevantFacts({
      text: options.text,
      subjectId: options.subjectId,
      limit: options.limit ?? 8,
    });
  }

  /**
   * Retrieve the most relevant long-term memories for the current conversation
   * context, using multi-factor scoring (relevance + salience + recency).
   *
   * Shared experiences (共同经历) are prioritized and surfaced first.
   */
  retrieveRelevant(params: Omit<RetrieveRelevantParams, 'longTermFacts' | 'workingMemory'> & { limit?: number }): MemoryHit[] {
    const workingMemory = this.workingMemory.getTopItems(10).map((item) => item.content);
    const longTermFacts = this.longTermMemory.getRelevantFacts({
      text: params.currentText,
      subjectId: params.senderId,
      limit: 20,
    });
    return retrieveRelevantMemories({
      ...params,
      longTermFacts,
      workingMemory,
    });
  }

  /**
   * Retrieve and format memories for prompt injection, with layered display:
   * related (shared experiences) → recent → other.
   */
  retrieveForPrompt(params: Omit<RetrieveRelevantParams, 'longTermFacts' | 'workingMemory'> & { limit?: number }): {
    related: string[];
    recent: string[];
    other: string[];
  } {
    const hits = this.retrieveRelevant(params);
    return formatMemoriesForPrompt(hits);
  }

  reviewMemoryCandidate(
    content: string,
    context: MemoryCandidateContext,
  ): MemoryReviewResult {
    const summary = summarizeSignificantContent(content);
    if (!summary) {
      return { accepted: false, reason: 'empty_content' };
    }

    // Check similarity with existing working memory items to avoid duplicates
    const existing = this.workingMemory.getTopItems(20);
    for (const item of existing) {
      const similarity = jaccardSimilarity(summary, item.content);
      if (similarity >= SIMILARITY_THRESHOLD) {
        return { accepted: false, reason: 'duplicate_content' };
      }
    }

    // Add to working memory
    const salience = context.salience ?? 0.5;
    const item = this.workingMemory.addItem(summary, salience);
    if (item) {
      this.turnWriteCount++;
      return { accepted: true, reason: 'added_to_working_memory', workingItem: item };
    }

    return { accepted: false, reason: 'working_memory_full' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════

function jaccardSimilarity(a: string, b: string): number {
  const sa = charBigrams(a);
  const sb = charBigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const x of sa) {
    if (sb.has(x)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function charBigrams(text: string): Set<string> {
  const chars = [...text];
  const bg = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) {
    const a = chars[i];
    const b = chars[i + 1];
    if (a !== undefined && b !== undefined) bg.add(a + b);
  }
  return bg;
}

/** 将显著内容转为简洁摘要 (不存原文) */
function summarizeSignificantContent(text: string): string | null {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_ENTRY_LENGTH) return compact;
  return compact.slice(0, MAX_ENTRY_LENGTH - 1).trimEnd() + '…';
}
