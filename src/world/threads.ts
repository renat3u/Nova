
// with runtime/src/mods/threads.mod.ts
//
// Threads record narrative continuity between Nova and contacts/channels.
// Each thread is a semantic topic line composed of Beats — discrete moments
// (messages, proactive actions, observations) that advance or resolve the topic.
//
// Key principles:
//   - Not every message creates a thread.  Only meaningful topic transitions do.
//   - Resolved threads should not re-trigger proactive candidates frequently.
//   - Thread relevance decays exponentially with a 7-day half-life.
//   - Beats carry type semantics (engagement, observation, misstep, etc.) for
//     relationship-aware narrative tracking.

// ── Beat types ──────────────────────────────────────────────────────────────

export type BeatType =
  | 'kernel'
  | 'ambient'
  | 'observation'
  | 'engagement'
  | 'assistance'
  | 'misstep'
  | 'connection'
  | 'insight'
  | 'prudence'
  | 'breakthrough';

// ── Thread operation types ──────────────────────────────────────────────────

export type ThreadOperation =
  | 'begin_topic'
  | 'advance_topic'
  | 'resolve_topic'
  | 'thread_review'
  | 'affect_thread';

// ── Beat interface ──────────────────────────────────────────────────────────

export interface BeatAttrs {
  id: string;
  thread_id: string;
  channel_id?: string;
  message_id?: string;

export const RELEVANCE_THRESHOLD = 0.15;

/** Threshold above which a thread is considered stale (still exists, but low priority). */
export const STALE_THRESHOLD = RELEVANCE_THRESHOLD * 2; // 0.30

/** Exponential decay half-life for thread relevance (7 days in seconds). */
export const DECAY_HALF_LIFE_S = 7 * 86400; // 604800

/** Maximum number of active threads to inject into prompts. */
export const MAX_ACTIVE_THREADS_INJECT = 5;

/** Maximum number of unresolved threads to consider for proactive desire generation. */
export const MAX_UNRESOLVED_THREADS_SCAN = 10;

/** Minimum age (ms) before a new thread can be auto-created for the same channel.
 *  Prevents thread fragmentation from rapid-fire messages. */
export const THREAD_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** Weight multiplier for a beat of type 'kernel' (topic initiation carries more weight). */
export const KERNEL_BEAT_WEIGHT = 2.0;

/** Weight multiplier for engagement beats (proactive actions and replies). */
export const ENGAGEMENT_BEAT_WEIGHT = 1.5;

/** Default initial weight for a new thread. */
export const DEFAULT_THREAD_WEIGHT = 1.0;

// ── Relevance computation ───────────────────────────────────────────────────

/**
 * Compute the relevance of a thread at a given timestamp.
 *
 * Uses exponential decay with a 7-day half-life:
 *   w(t) = w_0 * exp(-lambda * dt)
 * where lambda = ln(2) / DECAY_HALF_LIFE_S
 *
 * The thread's `w` field stores the *initial* weight at creation time;
 * effective relevance decays from that baseline.  Each beat added to the
 * thread can bump the weight back up (handled by advanceThread).
 */
export function computeThreadRelevance(
  initialWeight: number,
  createdMs: number,
  nowMs: number,
): number {
  const ageS = Math.max(0, (nowMs - createdMs) / 1000);
  const lambda = Math.LN2 / DECAY_HALF_LIFE_S;
  return initialWeight * Math.exp(-lambda * ageS);
}

/**
 * Check whether a thread is active (relevant enough for prompt injection
 * and proactive candidate generation).
 */
export function isThreadActive(relevance: number): boolean {
  return relevance >= RELEVANCE_THRESHOLD;
}

/**
 * Check whether a thread is stale — it exists but has low priority.
 * Stale threads should not generate proactive candidates but may still
 * be referenced if the user brings up the topic.
 */
export function isThreadStale(relevance: number): boolean {
  return relevance <= STALE_THRESHOLD && relevance > RELEVANCE_THRESHOLD * 0.5;
}

/**
 * Check whether a thread is effectively dead (relevance below half the
 * active threshold).  These threads should not be injected into prompts
 * or trigger proactive actions.
 */
export function isThreadDead(relevance: number): boolean {
  return relevance < RELEVANCE_THRESHOLD * 0.5;
}

// ── Thread lifecycle helpers ────────────────────────────────────────────────

/**
 * Compute the new weight for a thread after adding a beat.
 *
 * Each beat bumps the thread weight by its own weight, capped to prevent
 * indefinite accumulation.  The bump formula:
 *   w_new = min(w_current + beatWeight, w_current * 3)
 *
 * This ensures a single important beat (kernel, engagement) can raise the
 * thread substantially, but no single beat can inflate it beyond 3x.
 */
export function advanceThreadWeight(
  currentWeight: number,
  beatWeight: number,
): number {
  // Cap at 3x the current weight to prevent runaway inflation.
  return Math.min(currentWeight + beatWeight, currentWeight * 3);
}

/**
 * Compute weight for resolving a thread.
 *
 * Resolution doesn't immediately zero the weight — it drops to a low
 * residual so the thread can still be referenced if the user brings it
 * up, but won't generate proactive candidates.
 */
export function resolveThreadWeight(currentWeight: number): number {
  return currentWeight * 0.05;
}

// ── Beat creation helpers ───────────────────────────────────────────────────

/**
 * Create a beat for a kernel (new thread) event.
 */
export function createKernelBeat(
  threadId: string,
  channelId: string | undefined,
  summary: string,
  messageId: string | undefined,
  nowMs: number,
): BeatAttrs {
  return {
    id: `beat:${threadId}:${nowMs.toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    thread_id: threadId,
    channel_id: channelId,
    message_id: messageId,
    summary,
    beat_type: 'kernel',
    operation: 'begin_topic',
    weight: KERNEL_BEAT_WEIGHT,
    created_ms: nowMs,
  };
}

/**
 * Create a beat for an engagement event (Nova proactive message or user reply
 * to a proactive message).
 */
export function createEngagementBeat(
  threadId: string,
  channelId: string | undefined,
  summary: string,
  messageId: string | undefined,
  nowMs: number,
): BeatAttrs {
  return {
    id: `beat:${threadId}:${nowMs.toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    thread_id: threadId,
    channel_id: channelId,
    message_id: messageId,
    summary,
    beat_type: 'engagement',
    operation: 'advance_topic',
    weight: ENGAGEMENT_BEAT_WEIGHT,
    created_ms: nowMs,
  };
}

/**
 * Create a beat for an ambient (light conversation) event.
 */
export function createAmbientBeat(
  threadId: string,
  channelId: string | undefined,
  summary: string,
  messageId: string | undefined,
  nowMs: number,
): BeatAttrs {
  return {
    id: `beat:${threadId}:${nowMs.toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    thread_id: threadId,
    channel_id: channelId,
    message_id: messageId,
    summary,
    beat_type: 'ambient',
    operation: 'advance_topic',
    weight: 1.0,
    created_ms: nowMs,
  };
}

/**
 * Create a beat for an observation event.
 */
export function createObservationBeat(
  threadId: string,
  channelId: string | undefined,
  summary: string,
  nowMs: number,
): BeatAttrs {
  return {
    id: `beat:${threadId}:${nowMs.toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    thread_id: threadId,
    channel_id: channelId,
    summary,
    beat_type: 'observation',
    operation: 'advance_topic',
    weight: 0.8,
    created_ms: nowMs,
  };
}

/**
 * Create a beat for a misstep or prudence event.
 */
export function createPrudenceBeat(
  threadId: string,
  channelId: string | undefined,
  summary: string,
  nowMs: number,
): BeatAttrs {
  return {
    id: `beat:${threadId}:${nowMs.toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    thread_id: threadId,
    channel_id: channelId,
    summary,
    beat_type: 'prudence',
    operation: 'affect_thread',
    weight: 0.5,
    created_ms: nowMs,
  };
}

// ── Thread auto-detection heuristics ────────────────────────────────────────

/**
 * Heuristic to decide whether a message should begin a new thread or advance
 * an existing one.
 *
 * Returns the suggested operation and a brief topic summary derived from the
 * message text.  This is a lightweight, rule-based approach that avoids
 * calling the LLM for every message.
 *
 * The caller should:
 *   1. Check if an active unresolved thread already exists for this channel.
 *   2. If yes → advance that thread.
 *   3. If no → begin a new thread (if the message is substantial enough).
 */
export interface ThreadDetectionResult {
  /** Suggested operation. */
  operation: 'begin_topic' | 'advance_topic' | null;
  /** Short topic summary (truncated from message text). */
  topicSummary: string;
  /** Whether this message is substantial enough to warrant a thread. */
  isSubstantial: boolean;
}

/**
 * Detect thread operation from an incoming message.
 *
 * A message is "substantial" enough to begin a new thread if:
 *   - It has at least 8 non-whitespace characters.
 *   - It is not a pure greeting / acknowledgment.
 *   - It is directed or part of an active conversation.
 *
 * This is intentionally conservative — we don't want every "哈哈" or "嗯"
 * to spawn a thread.
 */
export function detectThreadFromMessage(params: {
  text: string;
  isDirected: boolean;
  hasActiveConversation: boolean;
  existingUnresolvedThreadCount: number;
  lastThreadCreatedMs?: number;
  nowMs: number;
}): ThreadDetectionResult {
  const { text, isDirected, hasActiveConversation, existingUnresolvedThreadCount, lastThreadCreatedMs, nowMs } = params;

  const trimmed = text.trim();
  const charCount = trimmed.replace(/\s/g, '').length;

  // Build a short topic summary from the message text.
  const topicSummary = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;

  // Greeting / acknowledgment patterns that don't warrant a new thread.
  const trivialPatterns = [
    /^[哈哈嗯哦啊嘿嗨]{1,6}$/,
    /^(ok|OK|Ok|好的|知道了|收到|明白了|懂了|嗯嗯|哦哦|哈哈)+[!！~～。.]?$/,
    /^(早|晚安|再见|拜拜|bye|hi|hello|在吗|在么|在不)[!！~～。.]?$/i,
    /^[.。!！?？~～…]{1,6}$/,
  ];

  const isTrivial = trivialPatterns.some((p) => p.test(trimmed));

  // A message is substantial if it has meaningful content and isn't trivial.
  const isSubstantial = charCount >= 8 && !isTrivial && (isDirected || hasActiveConversation);

  // Don't create a new thread if one was created very recently (cooldown).
  const inCooldown = lastThreadCreatedMs !== undefined && (nowMs - lastThreadCreatedMs) < THREAD_COOLDOWN_MS;

  if (!isSubstantial) {
    // Not substantial enough to stand alone → don't begin, but can advance
    // an existing thread if one is active.
    return {
      operation: existingUnresolvedThreadCount > 0 ? 'advance_topic' : null,
      topicSummary,
      isSubstantial: false,
    };
  }

  // Substantial message with no existing unresolved threads → begin new.
  if (existingUnresolvedThreadCount === 0 && !inCooldown) {
    return { operation: 'begin_topic', topicSummary, isSubstantial: true };
  }

  // Existing unresolved threads exist → advance the most recent one.
  if (existingUnresolvedThreadCount > 0) {
    return { operation: 'advance_topic', topicSummary, isSubstantial: true };
  }

  // Substantial but in cooldown and no existing threads → skip.
  return { operation: null, topicSummary, isSubstantial: true };
}

// ── Thread summary helpers ──────────────────────────────────────────────────

/**
 * Generate a short summary for a proactive action beat.
 * This is stored alongside the beat for trace/debug purposes.
 */
export function proactiveBeatSummary(params: {
  desireType: string;
  urgency: string;
  scene: 'private' | 'group';
}): string {
  const sceneLabel = params.scene === 'group' ? '群聊' : '私聊';
  const desireLabel = describeDesireInChinese(params.desireType);
  const urgencyLabel = params.urgency === 'high' ? '较强' : params.urgency === 'medium' ? '适中' : '轻微';
  return `Nova(${urgencyLabel}${desireLabel})主动在${sceneLabel}发言`;
}

/**
 * Map a desire type to Chinese for beat summaries.
 */
function describeDesireInChinese(desireType: string): string {
  switch (desireType) {
    case 'reconnect': return '重连';
    case 'explore': return '探索';
    case 'resolve_thread': return '续题';
    case 'fulfill_duty': return '履约';
    case 'reduce_backlog': return '清积';
    default: return desireType;
  }
}
