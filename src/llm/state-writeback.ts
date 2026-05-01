import type { NovaLogger } from '../core/logger';
import type { NovaMessageEvent } from '../core/types';
import type { MoodTracker, SelfMoodSnapshot } from '../engine/mood';
import type { MemoryService } from '../memory/memory-service';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { NovaWorldRepository } from '../world/repository';
import { createObservationBeat } from '../world/threads';
import type { NovaAfterward, NovaStateUpdate } from './response-schema';

export interface StateWritebackContext {
  event?: NovaMessageEvent;
  channelId?: string;
  contactId?: string;
  nowMs: number;
  source: 'reply' | 'proactive';
  pressure?: PressureSnapshot;
  isGroup?: boolean;
  /**
   * Contents of old `memoryCandidate` fields that have already been reviewed
   * by MemoryService this round.  When a `memory_note` has identical content
   * it is silently deduplicated instead of being reviewed twice.
   */
  reviewedMemoryCandidates?: string[];
  /**
   * Recent message texts in this channel, used by thread_note handler to
   * verify that the LLM-proposed summary is actually related to the ongoing
   * conversation.  Texts should be the raw message content, not formatted.
   */
  recentMessageTexts?: string[];
}

export interface AcceptedStateWriteback {
  type: NovaStateUpdate['type'];
  /** The validated, clamped, and normalized update values actually applied. */
  normalized: unknown;
  /** Human-readable description of what the writeback did. */
  effect: string;
}

export interface RejectedStateWriteback {
  type?: string;
  /** The raw update value that was rejected, for audit trace. */
  raw: unknown;
  reason: string;
}

export interface StateWritebackResult {
  accepted: AcceptedStateWriteback[];
  rejected: RejectedStateWriteback[];
  /** Full self-mood snapshot before any self_mood updates were applied (Step 4). */
  selfMoodBefore?: SelfMoodSnapshot;
  /** Full self-mood snapshot after all self_mood updates were applied (Step 4). */
  selfMoodAfter?: SelfMoodSnapshot;
  /** The last afterward value accepted in this batch (if any). */
  afterward?: NovaAfterward;
}

export interface StateWritebackServices {
  repository: NovaWorldRepository;
  memoryService: MemoryService;
  moodTracker: MoodTracker;
  logger: NovaLogger;
}

const MAX_UPDATES = 3;
const MAX_REASON_LENGTH = 120;
const MAX_MEMORY_CONTENT_LENGTH = 500;
const MAX_THREAD_SUMMARY_LENGTH = 300;
/** 同一 channel 内 thread_note 去重窗口（毫秒）。 */
const THREAD_NOTE_DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 min
/** 相关性校验：summary 与 recent messages 的最小 bigram 重叠率。 */
const THREAD_NOTE_MIN_RELEVANCE_OVERLAP = 0.08;
/** 去重校验：两段 summary 之间的最小 bigram 相似度（Jaccard）。 */
const THREAD_NOTE_DEDUP_SIMILARITY_THRESHOLD = 0.65;
const AFTERWARD_VALUES = new Set<NovaAfterward>(['done', 'waiting_reply', 'watching', 'cooling_down']);
const LEAK_PATTERN = /prompt|system|pressure|gate|IAUS|whitelist|白名单|系统提示|bypass|rate limit|shell|bash|command/i;

/**
 * Apply LLM-proposed state updates through a controlled validation → apply → trace
 * pipeline.  Every state change must pass validation, clamping, prompt-leak
 * filtering, and context-permission checks before any writeback occurs.
 *
 * This is Nova's controlled syscall / instruction layer: the LLM may only propose
 * state intentions; all actual state mutations happen here.
 */
export function applyNovaStateUpdates(
  updates: unknown,
  context: StateWritebackContext,
  services: StateWritebackServices,
): StateWritebackResult {
  const result: StateWritebackResult = { accepted: [], rejected: [] };
  if (updates === undefined || updates === null) return result;

  if (!Array.isArray(updates)) {
    result.rejected.push({
      reason: 'state_updates_not_array',
      raw: updates,
    });
    return result;
  }

  // Reject excess beyond MAX_UPDATES
  updates.slice(MAX_UPDATES).forEach((update, _offset) => {
    result.rejected.push({
      type: readType(update),
      reason: 'too_many_state_updates',
      raw: update,
    });
  });

  // Process up to MAX_UPDATES entries
  updates.slice(0, MAX_UPDATES).forEach((update, _index) => {
    if (!isRecord(update)) {
      result.rejected.push({
        reason: 'state_update_not_object',
        raw: update,
      });
      return;
    }

    switch (update.type) {
      case 'self_mood':
        applySelfMood(update, context, services, result);
        return;
      case 'memory_note':
        applyMemoryNote(update, context, services, result);
        return;
      case 'thread_note':
        applyThreadNote(update, context, services, result);
        return;
      case 'afterward':
        applyAfterward(update, context, services, result);
        return;
      default:
        result.rejected.push({
          type: typeof update.type === 'string' ? update.type : undefined,
          reason: 'unsupported_state_update_type',
          raw: update,
        });
    }
  });

  // ── Privacy redaction: rejected entries with forbidden internal terms ───
  for (const rejected of result.rejected) {
    if (typeof rejected.raw === 'string' && LEAK_PATTERN.test(rejected.raw)) {
      rejected.raw = '[redacted:forbidden_internal_term]';
    } else if (isRecord(rejected.raw)) {
      // Redact individual string fields that contain forbidden terms.
      const redacted: Record<string, unknown> = {};
      let hasRedaction = false;
      for (const [key, val] of Object.entries(rejected.raw)) {
        if (typeof val === 'string' && LEAK_PATTERN.test(val)) {
          redacted[key] = '[redacted:forbidden_internal_term]';
          hasRedaction = true;
        } else {
          redacted[key] = val;
        }
      }
      if (hasRedaction) rejected.raw = redacted;
    }
  }

  // ── Audit log ──────────────────────────────────────────────────────────
  if (result.accepted.length > 0 || result.rejected.length > 0) {
    const rejectedCategories = result.rejected.length > 0
      ? countRejectedCategories(result.rejected)
      : undefined;
    services.logger.debug('llm_state_writeback source=' + context.source +
      ' channel=' + (context.channelId ?? 'none') +
      ' accepted=' + result.accepted.length +
      ' rejected=' + result.rejected.length +
      ' types=' + result.accepted.map((a) => a.type).join(',') +
      (rejectedCategories ? ' rejectedReasons=' + Object.entries(rejectedCategories).map(([k, v]) => k + ':' + v).join(';') : ''));
  }

  // ── Persist per-channel writeback summary to runtime_state ──────────────
  if (context.channelId && (result.accepted.length > 0 || result.rejected.length > 0)) {
    const summary: Record<string, unknown> = {
      updatedAt: context.nowMs,
      source: context.source,
      accepted: result.accepted.map((a) => a.type),
      rejected: result.rejected.map((r) => r.type ?? r.reason),
    };
    if (result.afterward) summary.afterward = result.afterward;
    services.repository.setRuntimeState(
      `last_llm_state_writeback:${context.channelId}`,
      summary,
      context.nowMs,
    );
  }

  return result;
}

// ── self_mood handler ─────────────────────────────────────────────────────

function applySelfMood(
  update: Record<string, unknown>,
  context: StateWritebackContext,
  services: StateWritebackServices,
  result: StateWritebackResult,
): void {
  if (typeof update.valence !== 'number' || !Number.isFinite(update.valence)) {
    result.rejected.push({
      type: 'self_mood',
      reason: 'invalid_self_mood_valence',
      raw: update,
    });
    return;
  }

  const reason = validateReasonString(update.reason, 'self_mood', result, update);
  if (reason === false) return;

  const before = services.moodTracker.getCurrent(context.nowMs);
  const target = clamp(update.valence, -1, 1);
  const arousalTarget = typeof update.arousal === 'number' && Number.isFinite(update.arousal)
    ? clamp(update.arousal, 0, 1)
    : undefined;
  const weight = context.source === 'proactive' ? 0.1 : 0.2;

  const after = services.moodTracker.nudge({
    valence: target,
    arousal: arousalTarget,
    nowMs: context.nowMs,
    weight,
  });

  // Persist full SelfMoodSnapshot to runtime_state (Step 4: includes arousal).
  services.repository.setRuntimeState('self_mood', {
    valence: after.valence,
    arousal: after.arousal,
    updatedAt: after.updatedAt,
    source: 'llm_state_writeback',
  }, context.nowMs);

  // Track mood deltas on the result for deliberation trace (Step 4: full snapshot).
  if (result.selfMoodBefore === undefined) result.selfMoodBefore = before;
  result.selfMoodAfter = after;

  const normalized: Record<string, unknown> = {
    before: before.valence,
    after: after.valence,
    target,
    weight,
    arousalBefore: before.arousal,
    arousalAfter: after.arousal,
  };
  if (arousalTarget !== undefined) normalized.arousal = arousalTarget;
  if (reason) normalized.reason = reason;

  const arousalNote = arousalTarget !== undefined
    ? `, arousal ${before.arousal.toFixed(2)}→${after.arousal.toFixed(2)}`
    : '';

  result.accepted.push({
    type: 'self_mood',
    normalized,
    effect: `nudged self mood from ${before.valence.toFixed(3)} toward ${target.toFixed(3)} (weight=${weight}) → ${after.valence.toFixed(3)}${arousalNote}`,
  });
}

// ── memory_note handler ───────────────────────────────────────────────────

function applyMemoryNote(
  update: Record<string, unknown>,
  context: StateWritebackContext,
  services: StateWritebackServices,
  result: StateWritebackResult,
): void {
  // Validate content
  if (typeof update.content !== 'string' || update.content.trim().length === 0) {
    result.rejected.push({
      type: 'memory_note',
      reason: 'invalid_memory_note_content',
      raw: update,
    });
    return;
  }
  const content = update.content.trim().length > MAX_MEMORY_CONTENT_LENGTH
    ? update.content.trim().slice(0, MAX_MEMORY_CONTENT_LENGTH).trimEnd()
    : update.content.trim();

  if (LEAK_PATTERN.test(content)) {
    result.rejected.push({
      type: 'memory_note',
      reason: 'content_prompt_leak',
      raw: update,
    });
    return;
  }

  // ── Dedup against old memoryCandidate reviewed this round ──────────────
  if (context.reviewedMemoryCandidates && context.reviewedMemoryCandidates.length > 0) {
    const normalizedContent = content.toLowerCase().replace(/\s+/g, '');
    for (const reviewed of context.reviewedMemoryCandidates) {
      if (reviewed.toLowerCase().replace(/\s+/g, '') === normalizedContent) {
        // Silently skip — already reviewed via old memoryCandidate path.
        return;
      }
    }
  }

  // ── Group chat: reject sensitive / unexpressed inferences ──────────────
  if (context.isGroup && isSensitiveGroupInference(content)) {
    result.rejected.push({
      type: 'memory_note',
      reason: 'sensitive_group_inference',
      raw: update,
    });
    return;
  }

  // Validate reason
  const reason = validateReasonString(update.reason, 'memory_note', result, update);
  if (reason === false) return;

  // Validate salience
  let salience: number | undefined;
  if (update.salience !== undefined && update.salience !== null) {
    if (typeof update.salience !== 'number' || !Number.isFinite(update.salience)) {
      result.rejected.push({
        type: 'memory_note',
        reason: 'invalid_memory_note_salience',
        raw: update,
      });
      return;
    }
    salience = clamp(update.salience, 0, 1);
  }

  // Submit to MemoryService for review
  const review = services.memoryService.reviewMemoryCandidate(content, {
    event: context.event,
    source: 'llm_state_update',
    salience,
    nowMs: context.nowMs,
  });

  if (review.accepted) {
    const normalized: Record<string, unknown> = {
      content,
      salience: salience ?? 'context_default',
      reviewResult: review.reason,
    };
    if (review.fact) normalized.factType = review.fact.fact_type;
    if (reason) normalized.reason = reason;

    const effectParts: string[] = ['memory candidate accepted'];
    if (review.fact) effectParts.push(`fact_type=${review.fact.fact_type}`);
    effectParts.push(`review=${review.reason}`);

    result.accepted.push({
      type: 'memory_note',
      normalized,
      effect: effectParts.join(', '),
    });
  } else {
    result.rejected.push({
      type: 'memory_note',
      reason: `memory_review_rejected:${review.reason}`,
      raw: update,
    });
  }
}

/**
 * Detect group-chat memory_notes that make unexpressed sensitive inferences
 * about a person — attributing long-term personality traits, emotional states,
 * or character judgments based on limited interaction.
 *
 * These are prohibited in group contexts where the user may not have
 * explicitly expressed these attributes.
 */
function isSensitiveGroupInference(content: string): boolean {
  // Personality trait attributions: "是一个...的人"
  if (/是[一|个]?[\u4e00-\u9fff]{1,8}的人/.test(content)) return true;

  // Character / temper claims
  if (/[的]?(性格|脾气|为人|品行|秉性|天性|本性)[是为]/.test(content)) return true;

  // Mood / emotional state claims attributed to a person
  // Match "心情很差", "情绪很低落", "心态不好" etc. — allow degree adverbs
  if (/(心情|情绪|心态)\S{0,4}?[好坏差糟低沉落差糟躁]/u.test(content)) return true;

  // Definite trait labels without quoting
  if (/(内向|外向|开朗|孤僻|古怪|暴躁|温柔|冷漠|热情|自私|大方|小气|懒惰|勤奋)[的]?[，。]/.test(content)) return true;

  return false;
}

// ── thread_note handler ───────────────────────────────────────────────────

function applyThreadNote(
  update: Record<string, unknown>,
  context: StateWritebackContext,
  services: StateWritebackServices,
  result: StateWritebackResult,
): void {
  // ── 1. Validate summary ──────────────────────────────────────────────────
  if (typeof update.summary !== 'string' || update.summary.trim().length === 0) {
    result.rejected.push({
      type: 'thread_note',
      reason: 'invalid_thread_note_summary',
      raw: update,
    });
    return;
  }
  const summaryTruncated = update.summary.trim().length > MAX_THREAD_SUMMARY_LENGTH;
  const summary = update.summary.trim().length > MAX_THREAD_SUMMARY_LENGTH
    ? update.summary.trim().slice(0, MAX_THREAD_SUMMARY_LENGTH).trimEnd()
    : update.summary.trim();

  if (LEAK_PATTERN.test(summary)) {
    result.rejected.push({
      type: 'thread_note',
      reason: summaryTruncated ? 'summary_too_long' : 'summary_prompt_leak',
      raw: update,
    });
    return;
  }

  // ── 2. Validate weight ───────────────────────────────────────────────────
  let weight: number;
  if (update.weight !== undefined && update.weight !== null) {
    if (typeof update.weight !== 'number' || !Number.isFinite(update.weight)) {
      result.rejected.push({
        type: 'thread_note',
        reason: 'invalid_thread_note_weight',
        raw: update,
      });
      return;
    }
    weight = clamp(update.weight, 0, 1);
  } else {
    weight = 0.5;
  }

  // ── 3. Validate reason ───────────────────────────────────────────────────
  const reason = validateReasonString(update.reason, 'thread_note', result, update);
  if (reason === false) return;

  // ── 4. Resolve channelId ─────────────────────────────────────────────────
  const channelId = resolveThreadNoteChannelId(update, context);
  if (channelId === null) {
    result.rejected.push({
      type: 'thread_note',
      reason: 'channel_mismatch',
      raw: update,
    });
    return;
  }
  if (!channelId) {
    result.rejected.push({
      type: 'thread_note',
      reason: 'missing_channel_context',
      raw: update,
    });
    return;
  }

  // ── 5. Relevance check — summary must relate to recent messages ──────────
  if (context.recentMessageTexts && context.recentMessageTexts.length > 0) {
    if (!isRelevantToContext(summary, context.recentMessageTexts)) {
      result.rejected.push({
        type: 'thread_note',
        reason: 'not_relevant_to_context',
        raw: update,
      });
      return;
    }
  }

  // ── 6. Dedup — reject near-duplicate summaries in the same channel ───────
  if (isDuplicateThreadNote(channelId, summary, context.nowMs, services)) {
    result.rejected.push({
      type: 'thread_note',
      reason: 'duplicate_thread_note_summary',
      raw: update,
    });
    return;
  }

  // ── 7. Proactive group: conservative policy ──────────────────────────────
  if (context.source === 'proactive' && context.isGroup) {
    // Reject weak thread_notes
    if (weight < 0.4) {
      result.rejected.push({
        type: 'thread_note',
        reason: 'proactive_group_too_weak',
        raw: update,
      });
      return;
    }
    // Reject when there's no active thread — LLM shouldn't create new threads
    // in group chats from a proactive context.
    const existingActive = services.repository.getActiveThreadsForChannel(channelId, context.nowMs, 1);
    if (existingActive.length === 0) {
      result.rejected.push({
        type: 'thread_note',
        reason: 'proactive_group_no_active_thread',
        raw: update,
      });
      return;
    }
  }

  // ── 8. Write as observation beat ─────────────────────────────────────────
  const activeThreads = services.repository.getActiveThreadsForChannel(channelId, context.nowMs, 1);
  let threadId: string;
  let beatSummary: string;
  let effect: string;

  if (activeThreads.length > 0) {
    const thread = activeThreads[0]!;
    threadId = thread.id;
    beatSummary = summary;
    const beat = createObservationBeat(threadId, channelId, beatSummary, context.nowMs);
    beat.weight = weight;
    services.repository.addBeat(beat);
    effect = `observation beat written to existing thread ${threadId} (weight=${weight.toFixed(2)})`;
  } else {
    // No active thread exists — only for reply source: create a new thread
    // with this note as the kernel. Proactive without active thread was
    // already rejected above for group; for private proactive we allow it.
    const newThread = services.repository.createThread({
      channelId,
      summary,
      nowMs: context.nowMs,
    });
    threadId = newThread.id;
    beatSummary = summary;
    effect = `new thread created ${threadId} with kernel beat (weight=${weight.toFixed(2)})`;
  }

  const normalized: Record<string, unknown> = {
    channelId,
    threadId,
    summary: beatSummary,
    weight,
  };
  if (reason) normalized.reason = reason;

  result.accepted.push({
    type: 'thread_note',
    normalized,
    effect,
  });
}

// ── Thread note helpers ─────────────────────────────────────────────────────

/**
 * Check whether the thread_note summary has minimal relevance to the ongoing
 * conversation.  Uses character bigram overlap — a lightweight approach that
 * works well for Chinese text without requiring NLP libraries.
 *
 * A summary with zero meaningful overlap with recent messages is considered
 * hallucinated / off-topic and should be rejected.
 */
function isRelevantToContext(summary: string, recentTexts: string[]): boolean {
  const summaryBigrams = extractCharacterBigrams(summary);
  if (summaryBigrams.size === 0) return true; // too short to judge

  const contextBigrams = new Set<string>();
  for (const text of recentTexts) {
    for (const bg of extractCharacterBigrams(text)) {
      contextBigrams.add(bg);
    }
  }

  if (contextBigrams.size === 0) return true; // no context to compare against

  let overlap = 0;
  for (const bg of summaryBigrams) {
    if (contextBigrams.has(bg)) overlap++;
  }

  return overlap / summaryBigrams.size >= THREAD_NOTE_MIN_RELEVANCE_OVERLAP;
}

/**
 * Extract overlapping character bigrams from a string.
 * Whitespace is stripped before extraction.  Returns at most one bigram
 * per unique pair for efficient set-based overlap computation.
 */
function extractCharacterBigrams(text: string): Set<string> {
  const cleaned = text.replace(/\s+/g, '');
  const bigrams = new Set<string>();
  for (let i = 0; i < cleaned.length - 1; i++) {
    bigrams.add(cleaned.slice(i, i + 2));
  }
  return bigrams;
}

/**
 * Check whether a similar thread_note summary was already recorded in the
 * same channel within the dedup window.
 *
 * Uses bigram similarity against recent observation beats.  If a highly
 * similar note already exists, the new one is considered a duplicate.
 */
function isDuplicateThreadNote(
  channelId: string,
  summary: string,
  nowMs: number,
  services: StateWritebackServices,
): boolean {
  const sinceMs = nowMs - THREAD_NOTE_DEDUP_WINDOW_MS;
  const recentBeats = services.repository.getRecentBeatsForChannel(channelId, sinceMs, 20);

  if (recentBeats.length === 0) return false;

  const summaryBigrams = extractCharacterBigrams(summary);
  if (summaryBigrams.size === 0) return false;

  for (const beat of recentBeats) {
    const beatBigrams = extractCharacterBigrams(beat.summary);
    if (beatBigrams.size === 0) continue;

    const intersection = [...summaryBigrams].filter((bg) => beatBigrams.has(bg)).length;
    const union = new Set([...summaryBigrams, ...beatBigrams]).size;
    const similarity = intersection / union;

    if (similarity > THREAD_NOTE_DEDUP_SIMILARITY_THRESHOLD) return true;
  }

  return false;
}

/**
 * Resolve the channelId for a thread_note update.
 * - If context.channelId exists and update.channelId is absent → use context
 * - If context.channelId exists and update.channelId matches → use context
 * - If context.channelId is absent and update.channelId exists → use update
 * - If both exist and differ → reject (null = conflict)
 * - If neither exists → reject (undefined = missing)
 */
function resolveThreadNoteChannelId(
  update: Record<string, unknown>,
  context: StateWritebackContext,
): string | null | undefined {
  const updateChannelId = typeof update.channelId === 'string' && update.channelId.length > 0
    ? update.channelId
    : undefined;

  if (context.channelId) {
    if (updateChannelId && updateChannelId !== context.channelId) return null; // conflict
    return context.channelId;
  }
  return updateChannelId ?? undefined;
}

// ── afterward handler ─────────────────────────────────────────────────────

function applyAfterward(
  update: Record<string, unknown>,
  context: StateWritebackContext,
  services: StateWritebackServices,
  result: StateWritebackResult,
): void {
  if (typeof update.value !== 'string' || !AFTERWARD_VALUES.has(update.value as NovaAfterward)) {
    result.rejected.push({
      type: 'afterward',
      reason: 'invalid_afterward_value',
      raw: update,
    });
    return;
  }
  if (!context.channelId) {
    result.rejected.push({
      type: 'afterward',
      reason: 'missing_channel_id',
      raw: update,
    });
    return;
  }

  // Proactive group: reject waiting_reply
  if (context.source === 'proactive' && context.isGroup && update.value === 'waiting_reply') {
    result.rejected.push({
      type: 'afterward',
      reason: 'proactive_group_waiting_reply_not_allowed',
      raw: update,
    });
    return;
  }

  const reason = validateReasonString(update.reason, 'afterward', result, update);
  if (reason === false) return;

  const value = update.value as NovaAfterward;
  const nowMs = context.nowMs;

  // Compute TTL based on afterward type
  const ttlMs = afterwardTtl(value);
  const expiresAt = value === 'done' ? undefined : nowMs + ttlMs;

  const payload: Record<string, unknown> = {
    value,
    channelId: context.channelId,
    contactId: context.contactId,
    updatedAt: nowMs,
    source: context.source,
  };
  if (expiresAt !== undefined) payload.expiresAt = expiresAt;
  if (reason) payload.reason = reason;

  // Track afterward on the result
  result.afterward = value;

  // Handle 'done' — clean up previous waiting/watching/cooling states
  if (value === 'done') {
    const previous = services.repository.getRuntimeState<Record<string, unknown>>(`last_afterward:${context.channelId}`);
    services.repository.setRuntimeState(`last_afterward:${context.channelId}`, payload, nowMs);

    const normalized: Record<string, unknown> = { ...payload };
    if (previous?.value) normalized.clearedPrevious = previous.value;

    const effectSuffix = previous?.value
      ? `, cleared previous ${String(previous.value)}`
      : '';

    result.accepted.push({
      type: 'afterward',
      normalized,
      effect: `set afterward to done for channel ${context.channelId}${effectSuffix}`,
    });
    return;
  }

  services.repository.setRuntimeState(`last_afterward:${context.channelId}`, payload, nowMs);

  const ttlLabel = ttlMs >= 60_000 ? `${Math.round(ttlMs / 60_000)}m` : `${Math.round(ttlMs / 1000)}s`;

  result.accepted.push({
    type: 'afterward',
    normalized: payload,
    effect: `set afterward to ${value} for channel ${context.channelId} (TTL=${ttlLabel})`,
  });
}

function afterwardTtl(value: NovaAfterward): number {
  switch (value) {
    case 'waiting_reply': return 10 * 60 * 1000;  // 10 min
    case 'watching': return 7 * 60 * 1000;        // 7 min
    case 'cooling_down': return 20 * 60 * 1000;   // 20 min
    default: return 5 * 60 * 1000;
  }
}

// ── Shared validation helpers ─────────────────────────────────────────────

function validateReasonString(
  value: unknown,
  type: string,
  result: StateWritebackResult,
  rawUpdate: Record<string, unknown>,
): string | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    result.rejected.push({
      type,
      reason: 'invalid_reason',
      raw: rawUpdate,
    });
    return false;
  }
  const reason = value.trim();
  if (reason.length > MAX_REASON_LENGTH) {
    result.rejected.push({
      type,
      reason: 'reason_too_long',
      raw: rawUpdate,
    });
    return false;
  }
  if (LEAK_PATTERN.test(reason)) {
    result.rejected.push({
      type,
      reason: 'reason_prompt_leak',
      raw: rawUpdate,
    });
    return false;
  }
  return reason.length > 0 ? reason : undefined;
}

function readType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === 'string' ? value.type : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Count rejected reason categories for audit logging. */
function countRejectedCategories(rejected: RejectedStateWriteback[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rejected) {
    const key = r.reason;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
