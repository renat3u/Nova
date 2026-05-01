import type { NovaSqliteDatabase } from '../db/sqlite';
import { makeId } from '../world/constants';
import type { FactAttrs, FactType } from '../world/entities';
import {
  CONSOLIDATION_WINDOW_MS,
  INITIAL_SALIENCE,
  MAX_SALIENCE,
  SALIENCE_BUMP,
  SIMILARITY_THRESHOLD,
} from './working-memory';

export interface AddFactCandidate {
  content: string;
  subjectId?: string;
  factType?: FactType;
  importance?: number;
  volatility?: number;
  stability?: number;
  tracked?: boolean;
  nowMs?: number;
}

export interface FactSearchContext {
  text?: string;
  subjectId?: string;
  limit?: number;
  nowMs?: number;
}

interface FactRow {
  id: string;
  subject_id: string | null;
  content: string;
  fact_type: FactType;
  importance: number;
  volatility: number;
  stability: number;
  tracked: number;
  created_ms: number;
  last_access_ms: number;
}

export class LongTermMemory {
  constructor(private readonly db: NovaSqliteDatabase) {}

  addFact(candidate: AddFactCandidate): FactAttrs {
    const now = candidate.nowMs ?? Date.now();
    const content = candidate.content.trim();

    // 查找可能合并的已有事实 (含 consolidation window)
    const existing = this.findSimilarFact(content, candidate.subjectId, now);
    if (existing) {
      // 合并: 提升 importance, 更新 stability, 刷新 access time
      const updated: FactAttrs = {
        ...existing,
        content: mergeContent(existing.content, content),
        importance: Math.min(MAX_SALIENCE, Math.max(existing.importance, candidate.importance ?? existing.importance) + SALIENCE_BUMP),
        stability: Math.max(existing.stability * 1.1, candidate.stability ?? existing.stability),
        last_access_ms: now,
      };
      this.writeFact(updated);
      return updated;
    }

    const fact: FactAttrs = {
      id: makeId('fact'),
      entity_type: 'fact',
      content,
      fact_type: candidate.factType ?? 'observation',
      importance: candidate.importance ?? INITIAL_SALIENCE,
      volatility: candidate.volatility ?? 0.01,
      stability: candidate.stability ?? defaultStability(candidate.factType),
      tracked: candidate.tracked ?? true,
      created_ms: now,
      last_access_ms: now,
      ...(candidate.subjectId === undefined ? {} : { subject_id: candidate.subjectId }),
    };
    this.writeFact(fact);
    return fact;
  }

  getRelevantFacts(context: FactSearchContext): FactAttrs[] {
    const limit = Math.max(0, Math.trunc(context.limit ?? 8));
    const rows = this.db.prepare(`
      SELECT id, subject_id, content, fact_type, importance, volatility, stability, tracked, created_ms, last_access_ms
      FROM facts
      WHERE (? IS NULL OR subject_id = ?)
      ORDER BY last_access_ms DESC, importance DESC
      LIMIT 100
    `).all(context.subjectId ?? null, context.subjectId ?? null) as FactRow[];

    const keywords = tokenize(context.text ?? '');
    const facts = rows
      .map(factFromRow)
      .map((fact) => ({ fact, score: scoreFact(fact, keywords, context.nowMs ?? Date.now()) }))
      .filter((item) => keywords.size === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || b.fact.last_access_ms - a.fact.last_access_ms)
      .slice(0, limit)
      .map((item) => item.fact);

    for (const fact of facts) this.markFactAccessed(fact.id, context.nowMs ?? Date.now());
    return facts;
  }

  markFactAccessed(factId: string, nowMs = Date.now()): void {
    this.db.prepare('UPDATE facts SET last_access_ms = ? WHERE id = ?').run(nowMs, factId);
  }

  private writeFact(fact: FactAttrs): void {
    this.db.prepare(`
      INSERT INTO facts (id, subject_id, content, fact_type, importance, volatility, stability, tracked, created_ms, last_access_ms)
      VALUES (@id, @subject_id, @content, @fact_type, @importance, @volatility, @stability, @tracked, @created_ms, @last_access_ms)
      ON CONFLICT(id) DO UPDATE SET
        subject_id = excluded.subject_id,
        content = excluded.content,
        fact_type = excluded.fact_type,
        importance = excluded.importance,
        volatility = excluded.volatility,
        stability = excluded.stability,
        tracked = excluded.tracked,
        last_access_ms = excluded.last_access_ms
    `).run({
      id: fact.id,
      subject_id: fact.subject_id ?? null,
      content: fact.content,
      fact_type: fact.fact_type,
      importance: fact.importance,
      volatility: fact.volatility,
      stability: fact.stability,
      tracked: fact.tracked ? 1 : 0,
      created_ms: fact.created_ms,
      last_access_ms: fact.last_access_ms,
    });
  }

  private findSimilarFact(
    content: string,
    subjectId: string | undefined,
    nowMs: number,
  ): FactAttrs | undefined {
    const cutoff = nowMs - CONSOLIDATION_WINDOW_MS;
    const normalized = normalize(content);
    const rows = this.db.prepare(`
      SELECT id, subject_id, content, fact_type, importance, volatility, stability, tracked, created_ms, last_access_ms
      FROM facts
      WHERE (? IS NULL OR subject_id = ?)
      ORDER BY last_access_ms DESC
      LIMIT 50
    `).all(subjectId ?? null, subjectId ?? null) as FactRow[];

    return rows.map(factFromRow).find((fact) => {
      // 超出合并窗口的不合并
      if (fact.last_access_ms < cutoff) return false;
      // 不同 subject 的不合并
      if (subjectId !== undefined && fact.subject_id !== subjectId) return false;
      const other = normalize(fact.content);
      if (normalized.includes(other) || other.includes(normalized)) return true;
      if (overlap(tokenize(normalized), tokenize(other)) >= (1 - SIMILARITY_THRESHOLD + 0.35)) return true;
      return false;
    });
  }
}

function factFromRow(row: FactRow): FactAttrs {
  return {
    id: row.id,
    entity_type: 'fact',
    content: row.content,
    fact_type: row.fact_type,
    importance: row.importance,
    volatility: row.volatility,
    stability: row.stability,
    tracked: Boolean(row.tracked),
    created_ms: row.created_ms,
    last_access_ms: row.last_access_ms,
    ...(row.subject_id === null ? {} : { subject_id: row.subject_id }),
  };
}

function defaultStability(factType: FactType | undefined): number {
  if (factType === 'preference') return 20;
  if (factType === 'commitment') return 10;
  if (factType === 'summary') return 5;
  return 1;
}

function scoreFact(fact: FactAttrs, keywords: Set<string>, nowMs: number): number {
  const keywordScore = overlap(tokenize(fact.content), keywords);
  const ageDays = Math.max(0, nowMs - fact.last_access_ms) / 86_400_000;
  const recency = 1 / (1 + ageDays);
  return keywordScore * 2 + fact.importance + recency * 0.25;
}

function tokenize(value: string): Set<string> {
  return new Set(normalize(value).split(/[^\p{L}\p{N}_]+/u).filter((token) => token.length >= 2));
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / Math.min(left.size, right.size);
}

function mergeContent(existing: string, next: string): string {
  if (existing.includes(next)) return existing;
  if (next.includes(existing)) return next;
  const merged = `${existing}\n${next}`;
  return merged.length > 300 ? merged.slice(0, 300).trimEnd() : merged;
}
