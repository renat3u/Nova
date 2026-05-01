
//
// The evolve loop orchestrates each tick (message or scheduled):
//   pressure → desires → voice competition → IAUS scoring → gates → TickPlan → action queue
//
// Message ticks are reactive: the incoming message is the sole driver.
// Scheduled ticks are proactive: they scan the world for desire-driven candidates.
//
// Alignment:
//   engine/evolve.ts   — TickPlan / candidate / enqueue orchestration
//   act/action-queue.ts — actual queue storage and lifecycle (Step 11 Act loop)

import type { NovaLogger } from '../core/logger';
import type { NovaMessageEvent, NovaRuntimeConfig } from '../core/types';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { VoiceSelectionResult } from '../voices/selection';
import type { GateDecision } from '../gates/gates';
import {
  evaluateGates,
  evaluateQQRisk,
  evaluateEngagementState,
  evaluateProactiveEnabledGate,
  evaluateWhitelistGate,
  SILENCE_REASONS,
} from '../gates/gates';
import { evaluateGroupProactivePolicy } from '../gates/group-policy';
import { buildSilenceLogEntry } from '../gates/silence-log';
import type { RateLimitState } from '../gates/rate-limit';
import type { ChannelAttrs, ConversationAttrs, PersistentActionLogRecord } from '../world/entities';
import type { NovaWorldRepository } from '../world/repository';
import type { WorldModel } from '../world/model';
import type { GroupProfile } from '../relationships/types';
import type { PersonalityVector } from '../personality/vector';
import type { NovaAfterward } from '../llm/response-schema';
import { qqIdFromNodeId } from '../world/constants';

import { deriveDesires, type Desire, type ExploreGapContext } from './desire';
import { canExploreTarget, recordExploreSent } from '../pressure/novelty-tracker';
import {
  createTickPlan,
  type ActionCandidate,
  type TickPlan,
} from './tick-plan';

// ── Proactive same-target cooldown (Step 16) ─────────────────────────────────
// Minimum interval between two proactive messages to the same target.
// Private targets get 30 min; group targets get 2 hours.
// This prevents Nova from repeatedly disturbing the same person or group,
// regardless of engagement state or pressure level.

const PROACTIVE_TARGET_COOLDOWN_PRIVATE_MS = 30 * 60 * 1000;   // 30 min
const PROACTIVE_TARGET_COOLDOWN_GROUP_MS = 2 * 60 * 60 * 1000;  // 2 hours

// ── Afterward scheduling (todo2 Step 2) ──────────────────────────────────────
// Reads per-channel afterward state from runtime_state and adjusts
// proactive candidate priority / gate behavior accordingly.
//
// Key principles:
//   - afterward NEVER bypasses rate limit, QQ risk, IAUS, or the ActionQueue/ActLoop.
//   - afterward NEVER allows enqueueing or sending directly.
//   - Directed passive responses are completely unaffected — afterward only
//     influences scheduled proactive candidates.
//   - Expired afterward states are automatically ignored and cleaned up.

export interface ChannelAfterwardState {
  value: NovaAfterward;
  channelId: string;
  contactId?: string;
  updatedAt: number;
  expiresAt?: number;
  source: 'reply' | 'proactive';
  reason?: string;
}

/**
 * Read the current afterward state for a channel from runtime_state.
 * Returns undefined if no valid afterward exists or if it has expired.
 */
export function readChannelAfterward(
  channelId: string,
  nowMs: number,
  repository: NovaWorldRepository,
): ChannelAfterwardState | undefined {
  const raw = repository.getRuntimeState<ChannelAfterwardState>(`last_afterward:${channelId}`);
  if (!raw || typeof raw.value !== 'string') return undefined;

  // Check expiration
  if (raw.expiresAt !== undefined && nowMs >= raw.expiresAt) {
    // Expired — clean up the stale state
    repository.setRuntimeState(`last_afterward:${channelId}`, {
      value: 'done',
      clearedAt: nowMs,
      note: 'expired_afterward',
    }, nowMs);
    return undefined;
  }

  return raw;
}

/**
 * Evaluate the afterward gate for a proactive candidate.
 *
 * Returns a GateDecision to deny the candidate, or null to allow it to
 * proceed to the next gate.
 *
 * Scheduling effects by afterward value:
 *   - waiting_reply: strongly suppress (deny) same-channel candidates unless urgency=high
 *   - watching: deny group proactive candidates unless urgency=high; allow private with priority penalty
 *   - cooling_down: deny all same-channel proactive candidates
 *   - done: no effect (pass through)
 */
export function evaluateAfterwardGate(
  candidate: ActionCandidate,
  afterward: ChannelAfterwardState,
): GateDecision | null {
  const urgency = candidate.urgency ?? 'medium';
  const isGroup = candidate.scene === 'group';

  switch (afterward.value) {
    case 'waiting_reply': {
      // Strong suppression: deny unless high urgency (user explicitly re-engages)
      if (urgency === 'high') {
        candidate.afterwardSchedulingEffect = {
          priorityMultiplier: 1.0,
          reason: 'afterward_waiting_reply: urgency=high bypass',
        };
        return null;
      }
      candidate.afterwardSchedulingEffect = {
        priorityMultiplier: 0,
        gateDenied: true,
        reason: 'afterward_waiting_reply',
      };
      candidate.reason = `${candidate.reason}, afterward_waiting_reply`;
      return {
        allow: false,
        level: 'soft',
        reason: SILENCE_REASONS.AFTERWARD_WAITING_REPLY,
        reasons: [SILENCE_REASONS.AFTERWARD_WAITING_REPLY],
        values: {
          action: candidate.action,
          targetId: candidate.targetId,
          desireType: candidate.desireType,
          urgency,
          scene: candidate.scene,
          afterwardValue: 'waiting_reply',
          afterwardUpdatedAt: afterward.updatedAt,
          note: 'Nova is waiting for the other person to reply; suppressing proactive outreach to this channel unless urgent',
        },
      };
    }

    case 'watching': {
      if (isGroup && urgency !== 'high') {
        // Group non-urgent: deny with priority penalty
        candidate.afterwardSchedulingEffect = {
          priorityMultiplier: 0.3,
          gateDenied: true,
          reason: 'afterward_watching: group proactive suppressed',
        };
        candidate.reason = `${candidate.reason}, afterward_watching(group)`;
        return {
          allow: false,
          level: 'soft',
          reason: SILENCE_REASONS.AFTERWARD_WATCHING,
          reasons: [SILENCE_REASONS.AFTERWARD_WATCHING],
          values: {
            action: candidate.action,
            targetId: candidate.targetId,
            desireType: candidate.desireType,
            urgency,
            scene: candidate.scene,
            afterwardValue: 'watching',
            afterwardUpdatedAt: afterward.updatedAt,
            note: 'Nova is observing this channel; suppressing group proactive outreach',
          },
        };
      }
      // Group urgent or private: adjust priority via netValue
      const watchMultiplier = isGroup ? 0.3 : 0.5;
      if (candidate.iausScore) {
        const originalNetValue = candidate.iausScore.netValue;
        candidate.iausScore.netValue *= watchMultiplier;
        candidate.reason = `${candidate.reason}, afterward_watching(priority*=${watchMultiplier}, netValue ${originalNetValue.toFixed(3)}→${candidate.iausScore.netValue.toFixed(3)})`;
      } else {
        candidate.reason = `${candidate.reason}, afterward_watching(priority*=${watchMultiplier})`;
      }
      candidate.afterwardSchedulingEffect = {
        priorityMultiplier: watchMultiplier,
        reason: `afterward_watching: ${isGroup ? 'group' : 'private'} priority reduced`,
      };
      return null;
    }

    case 'cooling_down': {
      // Strong denial: suppress all proactive candidates to this channel
      candidate.afterwardSchedulingEffect = {
        priorityMultiplier: 0.1,
        gatePenalty: 0.5,
        gateDenied: true,
        reason: 'afterward_cooling_down',
      };
      candidate.reason = `${candidate.reason}, afterward_cooling_down`;
      return {
        allow: false,
        level: 'hard',
        reason: SILENCE_REASONS.AFTERWARD_COOLING_DOWN,
        reasons: [SILENCE_REASONS.AFTERWARD_COOLING_DOWN],
        values: {
          action: candidate.action,
          targetId: candidate.targetId,
          desireType: candidate.desireType,
          urgency,
          scene: candidate.scene,
          afterwardValue: 'cooling_down',
          afterwardUpdatedAt: afterward.updatedAt,
          note: 'Nova is cooling down this channel; suppressing all proactive outreach until TTL expires or done is set',
        },
      };
    }

    case 'done':
    default:
      // done: pass through, no scheduling effect
      return null;
  }
}

import { ActionQueue, type QueuedAction } from '../act/action-queue';
import { scoreCandidates, type IAUSScorerContext } from './iaus-scorer';
import { DEFAULT_SOCIAL_COST_CONFIG } from '../pressure/social-cost';

// ── Evolve context ─────────────────────────────────────────────────────────

export interface EvolveContext {
  world: WorldModel;
  tick: number;
  reason: 'message' | 'scheduled';
  pressure: PressureSnapshot;
  voice: VoiceSelectionResult;
  config: NovaRuntimeConfig;
  rateLimit: RateLimitState;
  nowMs: number;
  repository: NovaWorldRepository;
  actionQueue: ActionQueue;
  logger: NovaLogger;
  personality?: PersonalityVector;
  selfMood?: number;
  lastWinner?: { action: 'diligence' | 'curiosity' | 'sociability'; targetId: string } | null;
  lastActionMs?: number;
  recentActions?: PersistentActionLogRecord[];

  /** Only set for message ticks. */
  event?: NovaMessageEvent;
  channel?: ChannelAttrs;
  conversation?: ConversationAttrs;
  groupProfile?: GroupProfile | null;
}

export interface EvolveResult {
  tickPlan: TickPlan;
  /** Queued actions produced by this tick (scheduled ticks only). */
  queuedActions: QueuedAction[];
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Run one evolve tick.  Dispatches to the message or scheduled path based on
 * the `reason` field.
 */
export function runEvolveTick(ctx: EvolveContext): EvolveResult {
  if (ctx.reason === 'message') {
    return runMessageEvolve(ctx);
  }
  return runScheduledEvolve(ctx);
}

// ── Message tick ───────────────────────────────────────────────────────────

/**
 * Message tick: the incoming message drives everything.
 *
 * Flow:
 *   gate evaluation → TickPlan (reply or silence)
 *
 * The actual LLM reply construction is handled by NovaResponder in runtime.ts;
 * evolve only produces the planning trace and gate decision.
 */
function runMessageEvolve(ctx: EvolveContext): EvolveResult {
  const gate = evaluateGates({
    nowMs: ctx.nowMs,
    reason: 'message',
    event: ctx.event,
    pressure: ctx.pressure,
    voice: ctx.voice,
    conversation: ctx.conversation,
    channel: ctx.channel,
    groupProfile: ctx.groupProfile,
    config: ctx.config,
    rateLimit: ctx.rateLimit,
    actionQueue: ctx.actionQueue,
  });

  const plan = createTickPlan({
    tick: ctx.tick,
    reason: 'message',
    pressure: ctx.pressure,
    voice: ctx.voice,
    gateDecision: gate,
    nowMs: ctx.nowMs,
  });

  if (!gate.allow) {
    plan.silenceReason = gate.reason;
  } else {
    // Message tick: the selected action is always a reply.
    // The actual reply text is generated by NovaResponder after evolve returns.
    const candidate: ActionCandidate = {
      action: ctx.voice.iausAction ?? 'diligence',
      targetId: ctx.event?.chatId ?? null,
      scene: ctx.event?.chatType ?? ctx.channel?.chat_type ?? 'private',
      reason: `message_reply: directed=${ctx.event?.isDirected ?? false}`,
    };
    plan.candidates = [candidate];
    plan.selected = candidate;
  }

  ctx.logger.debug('Nova message evolve', {
    tick: plan.tick,
    gateAllow: gate.allow,
    gateReason: gate.reason,
    selectedVoice: ctx.voice.selected,
    iausAction: ctx.voice.iausAction,
  });

  return { tickPlan: plan, queuedActions: [] };
}

// ── Scheduled tick ─────────────────────────────────────────────────────────

/**
 * Scheduled tick: scan the world for proactive action candidates.
 *
 * Flow:
 *   pressure → desires → voice competition → IAUS scoring → candidates →
 *   candidate gates → enqueue or silence → TickPlan
 *
 * Key constraints:
 *   - When proactive is disabled: generate TickPlan + trace, NO action.
 *   - When proactive is enabled but no qualified desire: silence.
 *   - Desire exists but gate denies: record silence.
 *   - Gate passes: enqueue action (NEVER send directly from scheduled tick).
 */
function runScheduledEvolve(ctx: EvolveContext): EvolveResult {
  const queuedActions: QueuedAction[] = [];

  // 1. Derive desires from pressure, unresolved threads, and information gaps.
  const unresolvedThreads = ctx.repository.getUnresolvedThreads(ctx.nowMs, 10);
  const exploreGapCtx = buildExploreGapContext(ctx);
  const desires = deriveDesires({
    pressure: ctx.pressure,
    reason: 'scheduled',
    config: ctx.config,
    nowMs: ctx.nowMs,
    unresolvedThreads,
    exploreGapCtx,
  });

  // 2. Generate action candidates from desires.
  const candidates = buildProactiveCandidates(ctx, desires);

  // 3. Select the best candidate (first one that passes all gates).
  let selected: ActionCandidate | undefined;
  let gateDecision: GateDecision = {
    allow: false,
    level: 'soft',
    reason: SILENCE_REASONS.NO_DESIRES,
    reasons: [SILENCE_REASONS.NO_DESIRES],
    values: {},
  };

  if (candidates.length === 0) {
    // No desires → no candidates.  Record silence if proactive is enabled
    // but nothing qualified.
    if (ctx.config.proactiveEnabled && ctx.config.enableScheduledActions) {
      gateDecision = {
        allow: false,
        level: 'normal',
        reason: SILENCE_REASONS.NO_QUALIFIED_DESIRES,
        reasons: [SILENCE_REASONS.NO_QUALIFIED_DESIRES],
        values: {
          proactiveEnabled: ctx.config.proactiveEnabled,
          enableScheduledActions: ctx.config.enableScheduledActions,
          pressureApi: ctx.pressure.api,
          desireCount: desires.length,
        },
      };
    } else {
      gateDecision = {
        allow: false,
        level: 'normal',
        reason: SILENCE_REASONS.PROACTIVE_DISABLED,
        reasons: [SILENCE_REASONS.PROACTIVE_DISABLED],
        values: {
          proactiveEnabled: ctx.config.proactiveEnabled,
          enableScheduledActions: ctx.config.enableScheduledActions,
        },
      };
    }
  } else {
    // 4. Evaluate each candidate through gates.
    for (const candidate of candidates) {
      const candidateGate = evaluateCandidateGate(ctx, candidate);

      if (candidateGate.allow) {
        selected = candidate;
        gateDecision = candidateGate;

        // 5. Enqueue the action — NEVER send directly.
        const summary = buildPromptContextSummary(candidate, ctx);
        const enqueued = ctx.actionQueue.enqueue(candidate, ctx.tick, ctx.nowMs, summary);
        if (enqueued) {
          queuedActions.push(enqueued);

          // Step 15: record explore action in novelty tracker.
          if (candidate.desireType === 'explore' && candidate.targetId) {
            recordExploreSent(candidate.targetId, ctx.nowMs);
          }

          ctx.logger.info('Nova proactive action enqueued', {
            tick: ctx.tick,
            action: candidate.action,
            targetId: candidate.targetId,
            desireType: candidate.desireType,
            scene: candidate.scene,
            queueSize: ctx.actionQueue.size,
          });
        }
        break; // Only enqueue one action per scheduled tick.
      }

      // Record silence for this denied candidate.
      ctx.repository.recordSilence(buildSilenceLogEntry({
        tick: ctx.tick,
        targetId: candidate.targetId ?? 'scheduled',
        decision: candidateGate,
        context: {
          nowMs: ctx.nowMs,
          reason: 'scheduled',
          pressure: ctx.pressure,
          voice: ctx.voice,
          config: ctx.config,
          rateLimit: ctx.rateLimit,
        },
      }));

      ctx.logger.debug('Nova proactive candidate denied', {
        tick: ctx.tick,
        candidate: candidate.action,
        targetId: candidate.targetId,
        gateReason: candidateGate.reason,
        score: candidate.iausScore?.netValue,
        minUtility: candidate.scene === 'group'
          ? ctx.config.groupMinProactiveUtility
          : ctx.config.minProactiveUtility,
        legacyNetSocialValue: candidate.iausScore?.legacyNetSocialValue,
        deltaP: candidate.iausScore?.deltaP,
        socialCost: candidate.iausScore?.socialCost,
        considerations: candidate.iausScore?.considerations,
      });

      // Elevate whitelist / proactive-config denials to info level so
      // operators can observe the security boundary in normal logs.
      if (
        candidateGate.reason === SILENCE_REASONS.PROACTIVE_DISABLED ||
        candidateGate.reason === SILENCE_REASONS.PROACTIVE_WHITELIST_EMPTY ||
        candidateGate.reason === SILENCE_REASONS.PROACTIVE_WHITELIST_DENIED
      ) {
        ctx.logger.info('Nova proactive blocked by config/whitelist', {
          tick: ctx.tick,
          reason: candidateGate.reason,
          targetId: candidate.targetId,
          targetQQ: candidateGate.values.targetQQ,
          whitelist: candidateGate.values.proactiveWhitelistQQ,
        });
      }
    }

    // If no candidate passed, use the last gate decision for the plan.
    if (!selected && candidates.length > 0) {
      gateDecision = {
        allow: false,
        level: 'normal',
        reason: SILENCE_REASONS.ALL_CANDIDATES_DENIED,
        reasons: candidates.flatMap((_, i) => [`candidate_${i}_denied`]),
        values: {
          candidateCount: candidates.length,
          proactiveEnabled: ctx.config.proactiveEnabled,
        },
      };
    }
  }

  // 6. Assemble the TickPlan.
  const plan = createTickPlan({
    tick: ctx.tick,
    reason: 'scheduled',
    pressure: ctx.pressure,
    voice: ctx.voice,
    gateDecision,
    nowMs: ctx.nowMs,
  });
  plan.desires = desires;
  plan.candidates = candidates;
  plan.selected = selected;
  if (!gateDecision.allow) {
    plan.silenceReason = gateDecision.reason;
  }

  // 6a. Capture afterward state for tick trace (todo2 Step 11).
  // Scan evaluated candidates — if any were affected by an LLM-set afterward,
  // re-read the state for the trace record.
  for (const c of candidates) {
    if (c.afterwardSchedulingEffect && c.targetId) {
      const afterState = readChannelAfterward(c.targetId, ctx.nowMs, ctx.repository);
      if (afterState) {
        plan.afterwardState = {
          value: afterState.value,
          channelId: afterState.channelId,
          updatedAt: afterState.updatedAt,
          expiresAt: afterState.expiresAt,
          source: afterState.source,
        };
        break;
      }
    }
  }

  // Record silence at the plan level if nothing was enqueued.
  if (queuedActions.length === 0) {
    ctx.repository.recordSilence(buildSilenceLogEntry({
      tick: ctx.tick,
      targetId: 'scheduled',
      decision: gateDecision,
      context: {
        nowMs: ctx.nowMs,
        reason: 'scheduled',
        pressure: ctx.pressure,
        voice: ctx.voice,
        config: ctx.config,
        rateLimit: ctx.rateLimit,
      },
    }));
  }

  ctx.logger.debug('Nova scheduled evolve', {
    tick: plan.tick,
    desireCount: desires.length,
    candidateCount: candidates.length,
    selected: selected?.action ?? null,
    gateAllow: gateDecision.allow,
    gateReason: gateDecision.reason,
    enqueuedCount: queuedActions.length,
    silenceReason: plan.silenceReason,
  });

  return { tickPlan: plan, queuedActions };
}

// ── Candidate generation ───────────────────────────────────────────────────

/**
 * Build proactive action candidates from the derived desires.
 *
 * Each desire maps to an IAUS action.  Candidates carry the desire's
 * target and urgency, plus scene (private / group) information.
 *
 * After generation, candidates are scored through IAUS:
 *   - deltaP from pressure contributions
 *   - socialCost from Brown-Levinson politeness model
 *   - netValue = ΔP - λ · C_social
 *   - selectedProbability via softmax over candidate netValues
 *
 * Candidates are returned sorted by netValue descending so the strongest
 * candidate is evaluated first by the gate chain.
 */
function buildProactiveCandidates(
  ctx: EvolveContext,
  desires: Desire[],
): ActionCandidate[] {
  const candidates: ActionCandidate[] = [];

  for (const desire of desires) {
    const action = desireToIAUSAction(desire.type);
    const scene = resolveCandidateScene(ctx.world, desire.targetId);

    candidates.push({
      action,
      targetId: desire.targetId,
      desireType: desire.type,
      urgency: desire.urgency,
      scene,
      reason: desire.reason,
    });
  }

  // Score all candidates through the IAUS pipeline.
  if (candidates.length > 0) {
    const afterwardByTarget: IAUSScorerContext['afterwardByTarget'] = {};
    for (const candidate of candidates) {
      if (!candidate.targetId) continue;
      const afterward = readChannelAfterward(candidate.targetId, ctx.nowMs, ctx.repository);
      if (afterward) afterwardByTarget[candidate.targetId] = { value: afterward.value };
    }
    const recentActionRecords = ctx.recentActions ?? ctx.repository.listRecentActions(100);
    const recentActions = recentActionRecords.map((action) => ({
      ms: action.created_ms,
      action: action.action_type,
      target: action.target_id,
      status: action.status,
    }));
    const iausCtx: IAUSScorerContext = {
      world: ctx.world,
      nowMs: ctx.nowMs,
      pressure: ctx.pressure,
      socialCostConfig: DEFAULT_SOCIAL_COST_CONFIG,
      recentActions,
      personality: ctx.personality,
      selfMood: ctx.selfMood,
      lastWinner: ctx.lastWinner,
      lastActionMs: ctx.lastActionMs,
      afterwardByTarget,
      scoringMode: ctx.config.iausScoringMode,
      minProactiveUtility: ctx.config.minProactiveUtility,
      groupMinProactiveUtility: ctx.config.groupMinProactiveUtility,
      iausCompensationFactor: ctx.config.iausCompensationFactor,
      socialSafetyMidpoint: ctx.config.socialSafetyMidpoint,
      socialSafetySlope: ctx.config.socialSafetySlope,
      privateCooldownMs: ctx.config.privateCooldownMs,
      groupCooldownMs: ctx.config.groupCooldownMs,
      momentumBonus: ctx.config.iausMomentumBonus,
      momentumDecayMs: ctx.config.iausMomentumDecayMs,
      desireBoost: ctx.config.iausDesireBoost,
      curveModulationStrength: ctx.config.iausCurveModulationStrength,
      thompsonEta: ctx.config.iausThompsonEta,
      iausFairnessAlpha: ctx.config.iausFairnessAlpha,
      iausFairnessMax: ctx.config.iausFairnessMax,
      iausFairnessMinTotalService: ctx.config.iausFairnessMinTotalService,
    };

    const scored = scoreCandidates(candidates, iausCtx);

    // Attach IAUS scores to each candidate.
    // Results are already sorted by netValue descending from scoreCandidates.
    for (const { candidate, iausScore } of scored) {
      candidate.iausScore = iausScore;
    }
  }

  return candidates;
}

/**
 * Build explore gap context from the world state for Step 15 information
 * gap desire generation.
 *
 * Scans:
 *   1. Whitelisted contacts with low memory coverage
 *   2. Group profiles with recent topic drift
 */
function buildExploreGapContext(ctx: EvolveContext): ExploreGapContext | undefined {
  const { world, config, repository, nowMs } = ctx;
  if (!config.proactiveEnabled || config.proactiveWhitelistQQ.length === 0) {
    return undefined;
  }

  const whitelistSet = new Set(config.proactiveWhitelistQQ);

  // 1. Contacts with low memory coverage that are in the whitelist.
  const lowMemoryContactIds: string[] = [];
  for (const contactId of world.getEntitiesByType('contact')) {
    const contact = world.getContact(contactId);
    if (contact.is_bot) continue;
    if (!whitelistSet.has(contact.qq)) continue;

    // Count facts associated with this contact from the world model.
    // Contacts with < 3 facts have memory gaps worth exploring.
    const factCount = countFactsForSubject(world, contactId);
    if (factCount < 3) {
      lowMemoryContactIds.push(contactId);
    }
  }

  // 2. Group profiles with recent topic drift.
  const driftedGroups: Array<{ groupId: string; channelId: string; topicDrift: string }> = [];
  for (const channelId of world.getEntitiesByType('channel')) {
    const channel = world.getChannel(channelId);
    if (channel.chat_type !== 'group') continue;
    const groupId = channel.group_id ?? channelId;
    const profile = repository.getGroupProfile(groupId);
    if (!profile?.recentTopicDrift) continue;

    // Only include if drift is recent (within 24 hours).
    const updatedMs = profile.updatedMs ?? 0;
    if (nowMs - updatedMs > 24 * 3600 * 1000) continue;

    driftedGroups.push({
      groupId,
      channelId,
      topicDrift: profile.recentTopicDrift,
    });
  }

  if (lowMemoryContactIds.length === 0 && driftedGroups.length === 0) {
    return undefined;
  }

  return { lowMemoryContactIds, driftedGroupProfiles: driftedGroups, nowMs };
}

/**
 * Map a desire type to the IAUS action that would fulfill it.
 */
function desireToIAUSAction(desireType: string): string {
  switch (desireType) {
    case 'fulfill_duty':
    case 'reduce_backlog':
      return 'diligence';
    case 'reconnect':
      return 'sociability';
    case 'explore':
      return 'curiosity';
    case 'resolve_thread':
      // Thread resolution can be diligence (closing tasks) or curiosity
      // (following up on open topics).  Default to diligence.
      return 'diligence';
    default:
      return 'diligence';
  }
}

/**
 * Determine whether a target is a private or group channel.
 */
function resolveCandidateScene(
  world: WorldModel,
  targetId: string | null,
): 'private' | 'group' {
  if (!targetId) return 'private';
  if (!world.has(targetId)) return 'private';
  const nodeType = world.getNodeType(targetId);
  if (nodeType === 'channel') {
    const channel = world.getChannel(targetId);
    return channel.chat_type === 'group' ? 'group' : 'private';
  }
  // If target is a contact, assume private.
  return 'private';
}

// ── Candidate gate evaluation ──────────────────────────────────────────────

/**
 * Evaluate all gates for a proactive action candidate.
 *
 * Gate strength ordering: message reply < proactive private < proactive group.
 * Proactive candidates face stricter checks — they cannot use directed bypass.
 *
 * Gate chain (in order):
 *   1. Proactive enabled (master switch)
 *   2. Scheduled actions enabled
 *   3. Whitelist (private chats)
 *   4. Group proactive policy (group chats)
 *   5. Caution voice guard
 *   6. Engagement state (don't duplicate waiting engagements)
 *  6a. Proactive same-target cooldown (Step 16)
 *  6b. Explore novelty gate (Step 15)
 *  6c. Afterward scheduling gate (todo2 Step 2) — LLM-set channel posture
 *   7. QQ risk (flood / rate / failure backoff)
 *   8. Active cooling (per-channel cooldown)
 *   9. Social value (V(a,n) > 0)
 *  10. API floor
 */
function evaluateCandidateGate(
  ctx: EvolveContext,
  candidate: ActionCandidate,
): GateDecision {
  // 1. Proactive enabled check (uses shared gate from gates.ts).
  const proactiveGate = evaluateProactiveEnabledGate(ctx.config);
  if (proactiveGate) return proactiveGate;

  // 2. Scheduled actions enabled check.
  if (!ctx.config.enableScheduledActions) {
    return {
      allow: false,
      level: 'hard',
      reason: SILENCE_REASONS.SCHEDULED_ACTIONS_DISABLED,
      reasons: [SILENCE_REASONS.SCHEDULED_ACTIONS_DISABLED],
      values: { enableScheduledActions: false },
    };
  }

  // 3. Whitelist check for private chats.
  if (candidate.scene === 'private' && candidate.targetId) {
    const contactQQ = resolveTargetQQ(ctx.world, candidate.targetId);
    const whitelistGate = evaluateWhitelistGate(
      candidate.targetId,
      contactQQ,
      ctx.config.proactiveWhitelistQQ,
    );
    if (whitelistGate) return whitelistGate;
  }

  // 4. Group proactive policy for group chats.
  if (candidate.scene === 'group' && candidate.targetId) {
    const groupGate = evaluateGroupCandidateGate(ctx, candidate);
    if (groupGate) return groupGate;
  }

  // 5. Caution voice: never produces proactive actions.
  if (ctx.voice.selected === 'caution') {
    return {
      allow: false,
      level: 'hard',
      reason: SILENCE_REASONS.CAUTION_SCHEDULED_SILENCE,
      reasons: [SILENCE_REASONS.CAUTION_SCHEDULED_SILENCE],
      values: {
        selectedVoice: 'caution',
        note: 'caution is not an IAUS action type; scheduled ticks with caution always observe',
      },
    };
  }

  // 6. Engagement state gate: don't interrupt an existing waiting engagement
  //    for the same target.  Prevents duplicate proactive messages.
  const engagementGate = evaluateEngagementState(candidate.targetId, {
    nowMs: ctx.nowMs,
    reason: 'scheduled',
    pressure: ctx.pressure,
    voice: ctx.voice,
    config: ctx.config,
    rateLimit: ctx.rateLimit,
    actionQueue: ctx.actionQueue,
  });
  if (engagementGate) return engagementGate;

  // 6a. Proactive same-target cooldown (Step 16): ensure a minimum gap
  //     between two proactive messages to the same target, regardless of
  //     engagement lifecycle.  Prevents repeated disturbance of the same
  //     person or group when desire re-forms too quickly.
  if (candidate.targetId) {
    const proactiveCooldownGate = evaluateProactiveTargetCooldown(
      candidate.targetId,
      candidate.scene,
      ctx,
    );
    if (proactiveCooldownGate) return proactiveCooldownGate;
  }

  // 6b. Explore novelty gate (Step 15): prevent repeated exploration of the
  //     same target.  Only applies to 'explore' desire candidates.
  if (candidate.desireType === 'explore' && candidate.targetId) {
    const exploreCheck = canExploreTarget(candidate.targetId, ctx.nowMs);
    if (!exploreCheck.allowed) {
      const reason = exploreCheck.reason === 'explore_daily_cap_reached'
        ? SILENCE_REASONS.EXPLORE_DAILY_CAP
        : exploreCheck.reason === 'explore_engagement_pending'
          ? SILENCE_REASONS.EXPLORE_ENGAGEMENT_PENDING
          : exploreCheck.reason === 'explore_unreplied_cooldown'
            ? SILENCE_REASONS.EXPLORE_UNREPLIED_COOLDOWN
            : SILENCE_REASONS.EXPLORE_COOLDOWN;
      return {
        allow: false,
        level: 'soft',
        reason,
        reasons: [reason],
        values: {
          action: candidate.action,
          targetId: candidate.targetId,
          desireType: candidate.desireType,
          exploreReason: exploreCheck.reason,
        },
      };
    }
  }

  // 6c. Afterward gate (todo2 Step 2): read LLM-set channel afterward state
  //     and adjust proactive candidate scheduling accordingly.
  //     Directed passive responses are NOT affected — this gate only applies
  //     to scheduled proactive candidates.
  if (candidate.targetId) {
    const afterward = readChannelAfterward(candidate.targetId, ctx.nowMs, ctx.repository);
    if (afterward) {
      const afterwardGate = evaluateAfterwardGate(candidate, afterward);
      if (afterwardGate) return afterwardGate;
    }
  }

  // 7. QQ risk gate: unified flood / rate limit / failure backoff check.
  //    Reuses the same gate from gates.ts that message ticks use.
  const qqRisk = evaluateQQRisk({
    nowMs: ctx.nowMs,
    reason: 'scheduled',
    pressure: ctx.pressure,
    voice: ctx.voice,
    config: ctx.config,
    rateLimit: ctx.rateLimit,
  });
  if (!qqRisk.pass) {
    return {
      allow: false,
      level: qqRisk.level,
      reason: qqRisk.reason,
      reasons: [qqRisk.reason],
      values: qqRisk.values,
    };
  }

  // 8. Active cooling check (per-channel cooldown).
  const coolingGate = evaluateCandidateCooling(ctx, candidate);
  if (coolingGate) return coolingGate;

  // 9. Social value / proactive utility gate.
  if (candidate.iausScore) {
    const svGate = evaluateSocialValueGate(candidate, ctx.config);
    if (svGate) return svGate;
  }

  // 10. API floor check.
  const apiFloor = ctx.config.minApiToSpeak;
  if (ctx.pressure.api < apiFloor) {
    return {
      allow: false,
      level: 'soft',
      reason: SILENCE_REASONS.API_FLOOR,
      reasons: [SILENCE_REASONS.API_FLOOR],
      values: {
        api: ctx.pressure.api,
        floor: apiFloor,
      },
    };
  }

  // All gates passed.
  return {
    allow: true,
    level: 'none',
    reason: SILENCE_REASONS.ALLOWED,
    reasons: [SILENCE_REASONS.ALLOWED],
    values: {
      action: candidate.action,
      targetId: candidate.targetId,
      desireType: candidate.desireType,
      scene: candidate.scene,
      selectedVoice: ctx.voice.selected,
      api: ctx.pressure.api,
      iausScore: candidate.iausScore ? {
        deltaP: candidate.iausScore.deltaP,
        socialCost: candidate.iausScore.socialCost,
        netValue: candidate.iausScore.netValue,
        rawScore: candidate.iausScore.rawScore,
        compensatedScore: candidate.iausScore.compensatedScore,
        legacyNetSocialValue: candidate.iausScore.legacyNetSocialValue,
        considerations: candidate.iausScore.considerations,
      } : null,
    },
  };
}

/**
 * Group candidate gate: evaluate group proactive policy for a specific
 * group-channel candidate.
 */
function evaluateGroupCandidateGate(
  ctx: EvolveContext,
  candidate: ActionCandidate,
): GateDecision | null {
  if (!candidate.targetId) return null;

  const world = ctx.world;
  let channel: ChannelAttrs | undefined;
  if (world.has(candidate.targetId) && world.getNodeType(candidate.targetId) === 'channel') {
    channel = world.getChannel(candidate.targetId);
  }
  if (!channel || channel.chat_type !== 'group') return null;

  const groupId = channel.group_id ?? qqIdFromNodeId(candidate.targetId);
  const profile = ctx.repository.getGroupProfile(groupId);

  const decision = evaluateGroupProactivePolicy({
    groupId,
    profile,
    channel,
    config: ctx.config,
    nowMs: ctx.nowMs,
    selectedVoice: ctx.voice.selected,
  });

  return decision
    ? { allow: false, level: decision.level, reason: decision.reason, reasons: [decision.reason], values: decision.values }
    : null;
}

/**
 * Cooling gate: check per-channel cooldown for the candidate's target channel.
 */
function evaluateCandidateCooling(
  ctx: EvolveContext,
  candidate: ActionCandidate,
): GateDecision | null {
  if (!candidate.targetId) return null;

  const world = ctx.world;
  if (!world.has(candidate.targetId) || world.getNodeType(candidate.targetId) !== 'channel') {
    return null;
  }

  const channel = world.getChannel(candidate.targetId);
  const lastActionMs = channel.last_nova_action_ms;
  if (lastActionMs === undefined || lastActionMs === 0) return null;

  const chatType = channel.chat_type;
  const cooldownMs = chatType === 'group'
    ? ctx.config.groupCooldownMs
    : ctx.config.privateCooldownMs;
  const elapsedMs = ctx.nowMs - lastActionMs;

  if (elapsedMs >= cooldownMs) return null;

  return {
    allow: false,
    level: 'hard',
    reason: SILENCE_REASONS.ACTIVE_COOLING,
    reasons: [SILENCE_REASONS.ACTIVE_COOLING],
    values: {
      elapsedMs,
      cooldownMs,
      lastNovaActionMs: lastActionMs,
      targetId: candidate.targetId,
    },
  };
}

/**
 * Proactive same-target cooldown gate (Step 16).
 *
 * Checks whether enough time has elapsed since the last proactive outreach
 * to the same target.  This gate closes the gap between engagement lifecycle
 * (which covers active waiting periods) and desire regeneration: after an
 * engagement concludes (timeout/done), P3 or other pressures could
 * immediately re-form a desire for the same target.  This cooldown ensures
 * a minimum "quiet period" regardless of pressure.
 *
 * Private targets: 30 min minimum gap.
 * Group targets:    2 hour minimum gap.
 */
function evaluateProactiveTargetCooldown(
  targetId: string,
  scene: 'private' | 'group' | undefined,
  ctx: EvolveContext,
): GateDecision | null {
  const world = ctx.world;
  let lastOutreachMs: number | undefined;

  // Check the contact entity first (for private targets).
  if (world.has(targetId) && world.getNodeType(targetId) === 'contact') {
    const contact = world.getContact(targetId);
    lastOutreachMs = contact.last_proactive_outreach_ms;
  }

  // Also check the channel entity (target could be a channel).
  if (world.has(targetId) && world.getNodeType(targetId) === 'channel') {
    const channel = world.getChannel(targetId);
    if (channel.last_proactive_outreach_ms !== undefined &&
        (lastOutreachMs === undefined || channel.last_proactive_outreach_ms > lastOutreachMs)) {
      lastOutreachMs = channel.last_proactive_outreach_ms;
    }
  }

  if (lastOutreachMs === undefined || lastOutreachMs === 0) return null;

  const cooldownMs = scene === 'group'
    ? PROACTIVE_TARGET_COOLDOWN_GROUP_MS
    : PROACTIVE_TARGET_COOLDOWN_PRIVATE_MS;
  const elapsedMs = ctx.nowMs - lastOutreachMs;

  if (elapsedMs >= cooldownMs) return null;

  return {
    allow: false,
    level: 'normal',
    reason: scene === 'group'
      ? SILENCE_REASONS.PROACTIVE_TARGET_GROUP_COOLDOWN
      : SILENCE_REASONS.PROACTIVE_TARGET_COOLDOWN,
    reasons: [scene === 'group'
      ? SILENCE_REASONS.PROACTIVE_TARGET_GROUP_COOLDOWN
      : SILENCE_REASONS.PROACTIVE_TARGET_COOLDOWN],
    values: {
      targetId,
      scene: scene ?? 'private',
      lastProactiveOutreachMs: lastOutreachMs,
      elapsedMs,
      cooldownMs,
      remainingMs: cooldownMs - elapsedMs,
      note: scene === 'group'
        ? 'minimum 2-hour gap between proactive group messages to the same target'
        : 'minimum 30-minute gap between proactive private messages to the same target',
    },
  };
}

/**
 * Social value gate: check whether the candidate's net social value is positive.
 *
 * V(a, n) = ΔP - λ · C_social > 0 means the expected pressure relief
 * outweighs the social cost of intrusion.  When V ≤ 0 the action is not
 * worth the disturbance — silence is the correct response.
 *
 * This gate applies to both private and group proactive candidates.
 * Group candidates face higher effective social cost through the
 * Brown-Levinson model's group-aware C_dist and C_imp terms,
 * naturally making them harder to pass.
 */
function evaluateSocialValueGate(candidate: ActionCandidate, config: NovaRuntimeConfig): GateDecision | null {
  const score = candidate.iausScore;
  if (!score) return null;

  const scoringMode = config.iausScoringMode;
  const minUtility = candidate.scene === 'group'
    ? config.groupMinProactiveUtility
    : config.minProactiveUtility;

  if (scoringMode === 'consideration') {
    if (score.netValue >= minUtility) return null;

    return {
      allow: false,
      level: 'soft',
      reason: SILENCE_REASONS.SOCIAL_VALUE_NEGATIVE,
      reasons: [SILENCE_REASONS.SOCIAL_VALUE_NEGATIVE],
      values: {
        action: candidate.action,
        targetId: candidate.targetId,
        desireType: candidate.desireType,
        scene: candidate.scene,
        scoringMode,
        minUtility,
        rawScore: score.rawScore,
        compensatedScore: score.compensatedScore,
        legacyNetSocialValue: score.legacyNetSocialValue,
        deltaP: score.deltaP,
        socialCost: score.socialCost,
        netValue: score.netValue,
        considerations: score.considerations,
        note: 'IAUS utility below proactive threshold; social cost is applied as U_social_safety soft consideration',
      },
    };
  }

  if (score.netValue > 0) return null;

  return {
    allow: false,
    level: 'soft',
    reason: SILENCE_REASONS.SOCIAL_VALUE_NEGATIVE,
    reasons: [SILENCE_REASONS.SOCIAL_VALUE_NEGATIVE],
    values: {
      action: candidate.action,
      targetId: candidate.targetId,
      desireType: candidate.desireType,
      scene: candidate.scene,
      scoringMode,
      deltaP: score.deltaP,
      socialCost: score.socialCost,
      netValue: score.netValue,
      legacyNetSocialValue: score.legacyNetSocialValue,
      note: 'V(a,n) = ΔP - λ·C_social ≤ 0; expected pressure relief does not justify the social intrusion',
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a human-readable prompt context summary for a proactive action
 * candidate.  This is stored with the queued action for trace / log
 * inspection and can be used by the proactive responder (Step 12) to
 * generate the actual message text.
 */
function buildPromptContextSummary(candidate: ActionCandidate, ctx: EvolveContext): string {
  const parts: string[] = [];
  parts.push(`tick=${ctx.tick}`);
  parts.push(`action=${candidate.action}`);
  parts.push(`scene=${candidate.scene ?? 'private'}`);
  if (candidate.desireType) parts.push(`desire=${candidate.desireType}`);
  if (candidate.urgency) parts.push(`urgency=${candidate.urgency}`);
  if (candidate.targetId) {
    const targetLabel = resolveTargetLabel(ctx.world, candidate.targetId);
    parts.push(`target=${targetLabel}`);
  }
  if (candidate.iausScore) {
    parts.push(`netValue=${candidate.iausScore.netValue.toFixed(3)}`);
    if (candidate.iausScore.compensatedScore !== undefined) {
      parts.push(`compensatedScore=${candidate.iausScore.compensatedScore.toFixed(3)}`);
    }
    if (candidate.iausScore.legacyNetSocialValue !== undefined) {
      parts.push(`legacyNSV=${candidate.iausScore.legacyNetSocialValue.toFixed(3)}`);
    }
    parts.push(`deltaP=${candidate.iausScore.deltaP.toFixed(3)}`);
    parts.push(`socialCost=${candidate.iausScore.socialCost.toFixed(3)}`);
  }
  parts.push(`voice=${ctx.voice.selected}`);
  parts.push(`api=${ctx.pressure.api.toFixed(2)}`);
  return parts.join(' | ');
}

/**
 * Resolve a target entity id to a human-readable label for trace summaries.
 */
function resolveTargetLabel(world: WorldModel, targetId: string): string {
  if (!world.has(targetId)) return targetId;

  const nodeType = world.getNodeType(targetId);
  if (nodeType === 'contact') {
    const contact = world.getContact(targetId);
    return contact.name ?? contact.nickname ?? contact.qq;
  }
  if (nodeType === 'channel') {
    const channel = world.getChannel(targetId);
    return channel.title ?? channel.group_name ?? targetId;
  }
  return targetId;
}

/**
 * Count facts in the world model associated with a given subject (contact) id.
 */
function countFactsForSubject(world: WorldModel, subjectId: string): number {
  let count = 0;
  for (const factId of world.getEntitiesByType('fact')) {
    if (world.getNodeType(factId) !== 'fact') continue;
    const fact = world.getFact(factId);
    if (fact.subject_id === subjectId) count++;
  }
  return count;
}

/**
 * Resolve a target entity id to its QQ number.
 */
function resolveTargetQQ(world: WorldModel, targetId: string): string | null {
  if (!world.has(targetId)) return null;
  const nodeType = world.getNodeType(targetId);

  if (nodeType === 'contact') {
    return world.getContact(targetId).qq;
  }

  if (nodeType === 'channel') {
    const channel = world.getChannel(targetId);
    if (channel.chat_type === 'private') {
      const qqId = qqIdFromNodeId(targetId);
      return qqId;
    }
    // Group channels don't have a single QQ target for whitelist;
    // group proactive policy handles this separately.
    return null;
  }

  return null;
}
