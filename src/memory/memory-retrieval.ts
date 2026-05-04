//
// Relevance-based memory retrieval.
//
// Retrieves long-term memories (facts) ranked by multi-factor relevance
// scoring: keyword overlap + entity match + recency decay + salience.
//
// This replaces the simple "most recent N" truncation approach with
// semantically ordered retrieval that surfaces shared experiences and
// topic-related memories naturally.
//

import type { FactAttrs } from '../world/entities';

export interface MemoryHit {
  factId: string;
  content: string;
  salience: number;
  recency: number;
  relevance: number;
  score: number;
  sharedExperience: boolean;
}

export interface RetrieveRelevantParams {
  currentText: string;
  senderId: string;
  channelId: string;
  longTermFacts: FactAttrs[];
  workingMemory: string[];
  limit?: number;
}

// Half-life for recency decay: 7 days
const RECENCY_HALF_LIFE_MS = 7 * 24 * 3600 * 1000;

// Weights for the multi-factor score
const RELEVANCE_WEIGHT = 0.5;
const SALIENCE_WEIGHT = 0.2;
const RECENCY_WEIGHT = 0.3;

/**
 * Given current conversation context, retrieve the most relevant memories
 * from long-term facts.
 *
 * Scoring: score = relevance * 0.5 + salience * 0.2 + recency * 0.3
 */
export function retrieveRelevantMemories(params: RetrieveRelevantParams): MemoryHit[] {
  const { currentText, senderId, longTermFacts, workingMemory, limit = 5 } = params;

  if (longTermFacts.length === 0) return [];

  const nowMs = Date.now();
  const hits: MemoryHit[] = [];

  for (const fact of longTermFacts) {
    const relevance = computeRelevance(currentText, fact, senderId, workingMemory);
    const salience = fact.importance;
    const ageMs = nowMs - fact.created_ms;
    const recency = Math.exp(-ageMs / RECENCY_HALF_LIFE_MS);

    const score = relevance * RELEVANCE_WEIGHT + salience * SALIENCE_WEIGHT + recency * RECENCY_WEIGHT;

    const sharedExperience = isSharedExperience(fact.content);

    hits.push({
      factId: fact.id,
      content: fact.content,
      salience,
      recency,
      relevance,
      score,
      sharedExperience,
    });
  }

  // Sort by score descending
  hits.sort((a, b) => b.score - a.score);

  // Separate shared experiences from regular memories
  const shared = hits.filter((h) => h.sharedExperience);
  const regular = hits.filter((h) => !h.sharedExperience);

  // Interleave: shared first, then top regular
  const result: MemoryHit[] = [];
  result.push(...shared.slice(0, 3));
  result.push(...regular.slice(0, limit - result.length));

  return result;
}

/**
 * Compute relevance between the current conversation text and a fact.
 * Uses lightweight token overlap + entity matching.
 */
function computeRelevance(
  currentText: string,
  fact: FactAttrs,
  senderId: string,
  _workingMemory: string[],
): number {
  const factContent = fact.content.toLowerCase();
  const text = currentText.toLowerCase();

  // 1. Keyword overlap (bigram-based)
  const textBigrams = extractBigrams(text);
  const factBigrams = extractBigrams(factContent);
  let overlap = 0;
  for (const bg of textBigrams) {
    if (factBigrams.has(bg)) overlap++;
  }
  const bigramScore = textBigrams.size > 0 ? overlap / textBigrams.size : 0;

  // 2. Entity match: does the fact belong to the current sender?
  let entityScore = 0;
  if (fact.subject_id) {
    if (fact.subject_id === senderId) entityScore = 0.3;
    else {
      // Check if sender's QQ or ID appears in the fact content
      const senderQQ = senderId.split(':').pop() ?? '';
      if (factContent.includes(senderQQ)) entityScore = 0.15;
    }
  }

  // 3. Content length penalty: very short facts are less useful
  const lengthScore = Math.min(1, factContent.length / 20);

  return Math.min(1, bigramScore * 0.6 + entityScore + lengthScore * 0.1);
}

/**
 * Check if a fact content describes a shared experience.
 * Detects "我们", "一起", "上次", "那天", etc.
 */
export function isSharedExperience(content: string): boolean {
  const sharedPatterns = /我们|一起|上次|那天|那次|当时|还记得|你.*和.*我|我.*和.*你/;
  return sharedPatterns.test(content);
}

/**
 * Extract character bigrams from text for overlap computation.
 */
function extractBigrams(text: string): Set<string> {
  const cleaned = text.replace(/\s+/g, '');
  const bigrams = new Set<string>();
  for (let i = 0; i < cleaned.length - 1; i++) {
    bigrams.add(cleaned.slice(i, i + 2));
  }
  return bigrams;
}

/**
 * Format memory hits for prompt injection, layered by type.
 *
 * Returns three sections:
 * 1. Related memories (shared experiences with high relevance)
 * 2. Recent facts (chronologically recent)
 * 3. Other remembered items (backlog)
 */
export function formatMemoriesForPrompt(hits: MemoryHit[]): {
  related: string[];
  recent: string[];
  other: string[];
} {
  const related: string[] = [];
  const recent: string[] = [];
  const other: string[] = [];

  for (const hit of hits) {
    if (hit.score < 0.05) continue;
    if (hit.sharedExperience && hit.relevance > 0.1) {
      related.push(`[shared] ${hit.content}`);
    } else if (hit.recency > 0.5) {
      recent.push(`[recent] ${hit.content}`);
    } else {
      other.push(hit.content);
    }
  }

  return { related, recent, other };
}
