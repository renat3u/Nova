import type { NovaSqliteDatabase } from '../db/sqlite';
import { WORKING_MEMORY_SLOTS, makeId } from '../world/constants';

// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════

export const DIARY_CAPACITY = WORKING_MEMORY_SLOTS; // 7

export const DIARY_CAP_PER_TURN = 2;

export const MAX_ENTRY_LENGTH = 200;

export const INJECT_LIMIT = 5;

export const SIMILARITY_THRESHOLD = 0.35;

export const SALIENCE_HALF_LIFE_MS = 6 * 3600 * 1000;

export const INITIAL_SALIENCE = 1.0;

export const SALIENCE_BUMP = 0.15;

export const MAX_SALIENCE = 2.0;

export const INJECT_FLOOR = 0.05;

export const CONSOLIDATION_WINDOW_MS = 24 * 3600 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════════════════

export interface WorkingMemoryItem {
  id: string;
  content: string;
  salience: number;
  createdMs: number;
  updatedMs: number;
  sourceEventId?: string;
}

export interface WorkingMemoryCandidate {
  content: string;
  salience?: number;
  sourceEventId?: string;
  nowMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// WorkingMemory
// ═══════════════════════════════════════════════════════════════════════════

export class WorkingMemory {
  private readonly items = new Map<string, WorkingMemoryItem>();

  constructor(
    private readonly db: NovaSqliteDatabase,
    private readonly slots = WORKING_MEMORY_SLOTS,
  ) {}

  load(): void {
    this.items.clear();
    const rows = this.db.prepare(`
      SELECT id, content, salience, created_ms, updated_ms, source_event_id
      FROM working_memory
      ORDER BY salience DESC, updated_ms DESC
      LIMIT ?
    `).all(this.slots) as WorkingMemoryRow[];

    for (const row of rows) {
      this.items.set(row.id, {
        id: row.id,
        content: row.content,
        salience: row.salience,
        createdMs: row.created_ms,
        updatedMs: row.updated_ms,
        ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
      });
    }
  }

  addCandidate(candidate: WorkingMemoryCandidate): WorkingMemoryItem | null {
    let content = candidate.content.trim();
    if (content.length === 0) return null;

    if (content.length > MAX_ENTRY_LENGTH) {
      content = content.slice(0, MAX_ENTRY_LENGTH).trimEnd();
    }

    const now = candidate.nowMs ?? Date.now();
    this.decay(now);

    // 相似合并 (含 24h consolidation window)
    const similar = this.findSimilar(content, now);
    if (similar) {
      similar.content = mergeContent(similar.content, content);
      similar.salience = Math.min(
        MAX_SALIENCE,
        Math.max(similar.salience, candidate.salience ?? INITIAL_SALIENCE) + SALIENCE_BUMP,
      );
      similar.updatedMs = now;
      if (candidate.sourceEventId) similar.sourceEventId = candidate.sourceEventId;
      this.flush();
      return similar;
    }

    const item: WorkingMemoryItem = {
      id: makeId('wm'),
      content,
      salience: Math.min(MAX_SALIENCE, candidate.salience ?? INITIAL_SALIENCE),
      createdMs: now,
      updatedMs: now,
      ...(candidate.sourceEventId === undefined ? {} : { sourceEventId: candidate.sourceEventId }),
    };
    this.items.set(item.id, item);
    this.prune();
    this.flush();
    return item;
  }

  private findSimilar(content: string, nowMs: number): WorkingMemoryItem | undefined {
    const cutoff = nowMs - CONSOLIDATION_WINDOW_MS;
    const normalized = normalize(content);
    for (const item of this.items.values()) {
      // 超出合并窗口的不合并
      if (item.updatedMs < cutoff) continue;
      const other = normalize(item.content);
      if (normalized.includes(other) || other.includes(normalized)) return item;
      if (jaccard(normalized, other) >= SIMILARITY_THRESHOLD) return item;
    }
    return undefined;
  }

  private prune(): void {
    const sorted = Array.from(this.items.values())
      .sort((a, b) => b.salience - a.salience || b.updatedMs - a.updatedMs);
    for (const item of sorted.slice(this.slots)) {
      this.items.delete(item.id);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 内部类型
// ═══════════════════════════════════════════════════════════════════════════

interface WorkingMemoryRow {
  id: string;
  content: string;
  salience: number;
  created_ms: number;
  updated_ms: number;
  source_event_id: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════

export function effectiveSalience(
  item: { salience: number; updatedMs: number },
  nowMs: number,
): number {
  const age = nowMs - item.updatedMs;
  if (age <= 0) return item.salience;
  return item.salience * 0.5 ** (age / SALIENCE_HALF_LIFE_MS);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function jaccard(a: string, b: string): number {
  const left = new Set(a.split(' ').filter(Boolean));
  const right = new Set(b.split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function mergeContent(existing: string, next: string): string {
  if (existing.includes(next)) return existing;
  if (next.includes(existing)) return next;
  const merged = `${existing}\n${next}`;
  // 防止合并后超出长度限制
  return merged.length > MAX_ENTRY_LENGTH ? merged.slice(0, MAX_ENTRY_LENGTH).trimEnd() : merged;
}
