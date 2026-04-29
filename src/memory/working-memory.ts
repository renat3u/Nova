import type { NovaSqliteDatabase } from '../db/sqlite';
import { WORKING_MEMORY_SLOTS, clamp01, makeId } from '../world/constants';

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

const DECAY_HALF_LIFE_MS = 6 * 60 * 60 * 1000;

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
    const content = candidate.content.trim();
    if (content.length === 0) return null;

    const now = candidate.nowMs ?? Date.now();
    this.decay(now);
    const similar = this.findSimilar(content);
    if (similar) {
      similar.content = mergeContent(similar.content, content);
      similar.salience = clamp01(Math.max(similar.salience, candidate.salience ?? 0.5) + 0.1);
      similar.updatedMs = now;
      if (candidate.sourceEventId) similar.sourceEventId = candidate.sourceEventId;
      this.flush();
      return similar;
    }

    const item: WorkingMemoryItem = {
      id: makeId('wm'),
      content,
      salience: clamp01(candidate.salience ?? 0.5),
      createdMs: now,
      updatedMs: now,
      ...(candidate.sourceEventId === undefined ? {} : { sourceEventId: candidate.sourceEventId }),
    };
    this.items.set(item.id, item);
    this.prune();
    this.flush();
    return item;
  }

  getTopItems(limit = this.slots, nowMs = Date.now()): WorkingMemoryItem[] {
    this.decay(nowMs);
    return Array.from(this.items.values())
      .sort((a, b) => b.salience - a.salience || b.updatedMs - a.updatedMs)
      .slice(0, Math.max(0, Math.trunc(limit)))
      .map((item) => ({ ...item }));
  }

  flush(): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM working_memory').run();
      const insert = this.db.prepare(`
        INSERT INTO working_memory (id, content, salience, created_ms, updated_ms, source_event_id)
        VALUES (@id, @content, @salience, @created_ms, @updated_ms, @source_event_id)
      `);
      for (const item of this.getTopItems(this.slots)) {
        insert.run({
          id: item.id,
          content: item.content,
          salience: item.salience,
          created_ms: item.createdMs,
          updated_ms: item.updatedMs,
          source_event_id: item.sourceEventId ?? null,
        });
      }
    });
    transaction();
  }

  private decay(nowMs: number): void {
    for (const item of this.items.values()) {
      const elapsed = Math.max(0, nowMs - item.updatedMs);
      const factor = 0.5 ** (elapsed / DECAY_HALF_LIFE_MS);
      item.salience = clamp01(item.salience * factor);
    }
  }

  private findSimilar(content: string): WorkingMemoryItem | undefined {
    const normalized = normalize(content);
    for (const item of this.items.values()) {
      const other = normalize(item.content);
      if (normalized.includes(other) || other.includes(normalized)) return item;
      if (jaccard(normalized, other) >= 0.55) return item;
    }
    return undefined;
  }

  private prune(): void {
    const sorted = Array.from(this.items.values()).sort((a, b) => b.salience - a.salience || b.updatedMs - a.updatedMs);
    for (const item of sorted.slice(this.slots)) {
      this.items.delete(item.id);
    }
  }
}

interface WorkingMemoryRow {
  id: string;
  content: string;
  salience: number;
  created_ms: number;
  updated_ms: number;
  source_event_id: string | null;
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
  return `${existing}\n${next}`;
}
