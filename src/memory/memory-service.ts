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

export interface EngagementFeedback {

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

function truncateForFeedback(text: string, maxLen = 50): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLen ? compact : `${compact.slice(0, maxLen - 1)}…`;
}
