
//
// Desires are semantic tensions derived from the six pressure dimensions.
// Each desire type maps to a primary pressure driver; thresholds and urgency
// levels gate whether a desire is generated.

import type { PressureSnapshot } from '../pressure/aggregate';
import type { NovaRuntimeConfig } from '../core/types';
import type { ThreadAttrs } from '../world/entities';
import { computeThreadRelevance } from '../world/threads';
import { canExploreTarget } from '../pressure/novelty-tracker';

export type DesireType =
  | 'fulfill_duty'
  | 'reconnect'
  | 'resolve_thread'
  | 'reduce_backlog'
  | 'explore'
  | 'seek_presence'
  | 'reach_out';

export interface Desire {
  type: DesireType;
  urgency: string;
  pressureValue: number;
  targetId: string | null;
  source: string;
  reason: string;
}

export const DESIRE_THRESHOLDS: Record<DesireType, number> = {
  fulfill_duty: 0.2,
  reconnect: 0.3,
  resolve_thread: 0.4,
  reduce_backlog: 0.5,
  explore: 0.3,
  seek_presence: 0.2,
  reach_out: 0.15,
};

/** Maximum number of desires generated per tick. */
export const MAX_DESIRES = 10;

/**
 * Pressure-to-desire mapping.
 * Each desire type is driven primarily by one pressure dimension,
 * optionally modulated by P_prospect (future pressure).
 */
const DESIRE_PRESSURE_MAP: Array<{
  type: DesireType;
  pressureKey: 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7' | 'p8' | 'pProspect';
  contributionDim: string;
}> = [
  { type: 'reduce_backlog', pressureKey: 'p1', contributionDim: 'P1' },
  { type: 'reconnect', pressureKey: 'p3', contributionDim: 'P3' },
  { type: 'resolve_thread', pressureKey: 'p4', contributionDim: 'P4' },
  { type: 'fulfill_duty', pressureKey: 'p5', contributionDim: 'P5' },
  { type: 'explore', pressureKey: 'p6', contributionDim: 'P6' },
  { type: 'seek_presence', pressureKey: 'p7', contributionDim: 'P7' },
  { type: 'reach_out', pressureKey: 'p8', contributionDim: 'P8' },
];

/** Urgency band thresholds (multiples of the desire threshold). */
const URGENCY_HIGH_MULTIPLIER = 3.0;
const URGENCY_MEDIUM_MULTIPLIER = 1.5;

function computeUrgency(value: number, threshold: number): 'low' | 'medium' | 'high' {
  if (threshold <= 0) return 'low';
  const ratio = value / threshold;
  if (ratio >= URGENCY_HIGH_MULTIPLIER) return 'high';
  if (ratio >= URGENCY_MEDIUM_MULTIPLIER) return 'medium';
  return 'low';
}

/**
 * Extract the top-contributing entity id from a pressure dimension's
 * contribution map.
 */
function topContributor(
  contributions: Record<string, unknown> | undefined,
  dim: string,
): string | null {
  if (!contributions) return null;
  const dimContribs = contributions[dim];
  if (!dimContribs || typeof dimContribs !== 'object') return null;
  const map = dimContribs as Record<string, number>;
  let bestId: string | null = null;
  let bestValue = -Infinity;
  for (const [id, value] of Object.entries(map)) {
    if (typeof value === 'number' && value > bestValue) {
      bestValue = value;
      bestId = id;
    }
  }
  return bestId;
}

/** Context for information gap exploration (Step 15). */
export interface ExploreGapContext {
  /** Contact ids with low memory coverage, for memory-gap explore desires. */
  lowMemoryContactIds?: string[];
  /** Group profile summaries that have recent topic drift. */
  driftedGroupProfiles?: Array<{ groupId: string; channelId: string; topicDrift: string }>;
  /** Current timestamp for cooldown checks. */
  nowMs: number;
}

/**
 * Derive desires from the current pressure snapshot and world state.
 *
 * For scheduled ticks this produces the full desire set that feeds into
 * IAUS scoring, candidate generation, and gate evaluation.
 *
 * For message ticks the desire set is typically empty or reduced — the
 * message itself is the primary driver, not autonomous desire.
 */
export function deriveDesires(params: {
  pressure: PressureSnapshot;
  reason: 'message' | 'scheduled';
  config: NovaRuntimeConfig;
  nowMs?: number;
  /** 未决的活跃线程，用于生成 resolve_thread / explore desire */
  unresolvedThreads?: ThreadAttrs[];
  /** 信息缺口上下文 (Step 15)，用于生成额外的 explore desire */
  exploreGapCtx?: ExploreGapContext;
  /** Optional closeness getter for adjusting reconnect thresholds. */
  getCloseness?: (targetId: string) => number;
  /** Upcoming events for reminder desires. */
  upcomingEvents?: Array<{
    id: string;
    event: string;
    dateDescription: string;
    date?: string;
    targetId: string;
    mentionedAtMs: number;
    status: string;
  }>;
}): Desire[] {
  const { pressure, reason, nowMs } = params;

  // Message ticks do not produce autonomous desires; the incoming message
  // is the sole driver.  Desires are only relevant for scheduled ticks.
  if (reason === 'message') return [];

  // Scheduled tick: derive desires from pressure dimensions.
  const desires: Desire[] = [];

  for (const mapping of DESIRE_PRESSURE_MAP) {
    let threshold = DESIRE_THRESHOLDS[mapping.type];
    const rawValue = pressure[mapping.pressureKey] ?? 0;

    const targetId = topContributor(pressure.contributions, mapping.contributionDim);

    // ── Closeness-adjusted reconnect threshold ─────────────────────────
    // close 以上关系：reconnect desire 阈值降低 30%
    if (mapping.type === 'reconnect' && targetId && params.getCloseness) {
      const closeness = params.getCloseness(targetId);
      if (closeness >= 0.55) {
        threshold = threshold * 0.7;
      }
    }

    if (rawValue <= threshold) continue;

    const urgency = computeUrgency(rawValue, threshold);

    desires.push({
      type: mapping.type,
      urgency,
      pressureValue: rawValue,
      targetId,
      source: mapping.contributionDim,
      reason: buildDesireReason(mapping.type, urgency, rawValue, threshold, targetId),
    });
  }

  // ── Unresolved thread scanning ─────────────────────────────────────────
  // 从活跃但未决的叙事线程中派生 resolve_thread 和 explore desire。
  // 这让 Nova 能主动接上未聊完的话题，而不是仅依赖 P4 压力。
  if (params.unresolvedThreads && params.unresolvedThreads.length > 0 && nowMs !== undefined) {
    const threadDesires = deriveThreadDesires(params.unresolvedThreads, nowMs);
    desires.push(...threadDesires);
  }

  // ── Information gap exploration (Step 15) ──────────────────────────────
  // 从记忆缺口、群话题变化中生成额外的 explore desire。
  // 通过 novelty tracker 过滤以避免重复探索同一目标。
  if (params.exploreGapCtx && nowMs !== undefined) {
    const gapDesires = deriveExploreGapDesires(params.exploreGapCtx, nowMs);
    desires.push(...gapDesires);
  }

  // ── Future event reminder scanning ─────────────────────────────────────
  // 从 upcoming future_event facts 中生成提醒 desire。
  if (params.upcomingEvents && params.upcomingEvents.length > 0 && nowMs !== undefined) {
    const eventDesires = deriveEventReminderDesires(params.upcomingEvents, nowMs);
    desires.push(...eventDesires);
  }

  // Sort by pressure value descending so the strongest desires are first.
  desires.sort((a, b) => b.pressureValue - a.pressureValue);

  return desires.slice(0, MAX_DESIRES);
}

/**
 * 从未决线程中派生 desire。
 *
 * 每个活跃未决线程根据其 relevance 和已停留时间产生：
 *   - resolve_thread：relevance >= 0.3 且线程年龄 > 1 小时的未决线程
 *   - explore：relevance >= 0.15（活跃）且包含新颖话题的线程
 *
 * 解析后的线程不会进入此列表（status === 'closed' 的线程已在查询层被过滤）。
 */
function deriveThreadDesires(
  threads: ThreadAttrs[],
  nowMs: number,
): Desire[] {
  const desires: Desire[] = [];
  const ONE_HOUR_MS = 3600 * 1000;
  const THREAD_RESOLVE_THRESHOLD = 0.3; // 高于 RELEVANCE_THRESHOLD 的增强阈值

  for (const thread of threads) {
    if (thread.status !== 'open') continue;
    if (!thread.summary) continue;

    const relevance = computeThreadRelevance(thread.w, thread.created_ms, nowMs);
    const ageMs = nowMs - thread.created_ms;

    // resolve_thread: 线程存在超过 1 小时且 relevance 较高
    if (relevance >= THREAD_RESOLVE_THRESHOLD && ageMs > ONE_HOUR_MS) {
      const urgency = relevance >= 0.6 ? 'high' : relevance >= 0.4 ? 'medium' : 'low';
      desires.push({
        type: 'resolve_thread',
        urgency,
        pressureValue: relevance,
        targetId: thread.channel_id ?? null,
        source: 'thread',
        reason: `thread: resolve_thread (urgency=${urgency}), relevance=${relevance.toFixed(3)}, thread=${thread.id} summary="${thread.summary.slice(0, 50)}"`,
      });
    }

    // explore: 活跃线程可能包含值得进一步探索的话题
    // relevance 在 0.15~0.3 之间的线程更适合"轻轻探索"而非"推进解决"
    if (relevance >= 0.15 && relevance < THREAD_RESOLVE_THRESHOLD) {
      desires.push({
        type: 'explore',
        urgency: 'low',
        pressureValue: relevance,
        targetId: thread.channel_id ?? null,
        source: 'thread',
        reason: `thread: explore (urgency=low), relevance=${relevance.toFixed(3)}, thread=${thread.id} summary="${thread.summary.slice(0, 50)}"`,
      });
    }
  }

  return desires;
}

/**
 * 从信息缺口生成探索 desire (Step 15)。
 *
 * 来源：
 *   1. 记忆缺口 —— 白名单中 memory 覆盖较少的联系人
 *   2. 群话题漂移 —— group profile 记录了近期话题变化
 *
 * 每个候选都会经过 novelty tracker 的 cooldown / daily cap 检查，
 * 避免重复探索同一缺口。
 */
function deriveExploreGapDesires(
  ctx: ExploreGapContext,
  nowMs: number,
): Desire[] {
  const desires: Desire[] = [];

  // 1. Memory gap exploration: contacts with low memory coverage.
  if (ctx.lowMemoryContactIds && ctx.lowMemoryContactIds.length > 0) {
    for (const contactId of ctx.lowMemoryContactIds) {
      const check = canExploreTarget(contactId, nowMs);
      if (!check.allowed) continue;

      desires.push({
        type: 'explore',
        urgency: 'low',
        pressureValue: 0.15, // low baseline — memory gaps are gentle curiosity
        targetId: contactId,
        source: 'memory_gap',
        reason: `explore: memory_gap target=${contactId}`,
      });
    }
  }

  // 2. Group topic drift exploration.
  if (ctx.driftedGroupProfiles && ctx.driftedGroupProfiles.length > 0) {
    for (const group of ctx.driftedGroupProfiles) {
      const check = canExploreTarget(group.channelId, nowMs);
      if (!check.allowed) continue;

      desires.push({
        type: 'explore',
        urgency: 'low',
        pressureValue: 0.2,
        targetId: group.channelId,
        source: 'group_topic_drift',
        reason: `explore: group_topic_drift group=${group.groupId} drift="${group.topicDrift.slice(0, 60)}"`,
      });
    }
  }

  return desires;
}

/**
 * 从即将到来的 future_event facts 生成提醒 desire。
 *
 * 时间距离决定紧迫度：
 *   - 1 天内 → urgency=high → fulfill_duty desire
 *   - 3 天内 → urgency=medium → reconnect 或 fulfill_duty
 *   - 7 天内 → urgency=low → explore
 */
function deriveEventReminderDesires(
  events: Array<{
    id: string;
    event: string;
    dateDescription: string;
    date?: string;
    targetId: string;
    mentionedAtMs: number;
    status: string;
  }>,
  nowMs: number,
): Desire[] {
  const desires: Desire[] = [];
  const ONE_DAY_MS = 24 * 3600 * 1000;

  for (const evt of events) {
    const ageMs = nowMs - evt.mentionedAtMs;

    // Approximate: if dateDescription mentions "明天" or "后天", it's close
    const isImminent = /明天|后天|今天|马上|快要/.test(evt.dateDescription);
    const isNear = /后天|下周|几天后/.test(evt.dateDescription);
    const isFar = /下个月|之后|以后/.test(evt.dateDescription);

    let urgency: 'low' | 'medium' | 'high';
    let pressureValue: number;
    let desireType: DesireType;

    if (isImminent) {
      urgency = 'high';
      pressureValue = 0.5;
      desireType = 'fulfill_duty';
    } else if (isNear) {
      urgency = 'medium';
      pressureValue = 0.3;
      desireType = 'reconnect';
    } else if (isFar) {
      urgency = 'low';
      pressureValue = 0.15;
      desireType = 'explore';
    } else {
      // Default: if event was mentioned long ago or date unclear
      if (ageMs > ONE_DAY_MS * 30) continue; // skip events older than 30 days
      urgency = 'low';
      pressureValue = 0.1;
      desireType = 'explore';
    }

    desires.push({
      type: desireType,
      urgency,
      pressureValue,
      targetId: evt.targetId,
      source: 'future_event',
      reason: `future_event: ${evt.event} (${evt.dateDescription}), target=${evt.targetId}, event_id=${evt.id}`,
    });
  }

  return desires;
}

function buildDesireReason(
  type: DesireType,
  urgency: string,
  value: number,
  threshold: number,
  targetId: string | null,
): string {
  const target = targetId ? ` target=${targetId}` : '';
  return `desire: ${type} (urgency=${urgency}), value=${value.toFixed(3)}, threshold=${threshold.toFixed(3)}${target}`;
}
