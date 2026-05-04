
//
// IAUS (Intrinsic Action Utility Scorer) evaluates action candidates across
// the diligence / curiosity / sociability axes.  Caution is not an independent
// IAUS action type — it operates through gates, social cost, and prompt restraint.
//
// Step 08 integrates full social-cost / social-value computation:
//   - deltaP from pressure contributions
//   - socialCost from Brown-Levinson politeness model
//   - netValue = deltaP - λ · socialCost
//   - selectedProbability via softmax over candidate netValues

import type { IAUSScoringMode } from '../core/types';
import type { NovaAfterward } from '../llm/response-schema';
import type { PersonalityVector } from '../personality/vector';
import { DEFAULT_PERSONALITY_VECTOR, VOICE_INDEX } from '../personality/vector';
import type { VoiceId, IAUSAction } from '../personality/vector';
import type { VoiceSelectionResult } from '../voices/selection';
import type { WorldModel } from '../world/model';
import type { PressureSnapshot, AllPressures } from '../pressure/aggregate';
import type { PressureDims } from '../utils/math';
import { computeSocialCost, DEFAULT_SOCIAL_COST_CONFIG, getIntrusiveness, type SocialCostConfig } from '../pressure/social-cost';
import { estimateDeltaP, computeNetSocialValue, SIGMA2_OBS } from '../pressure/social-value';
import type { ActionCandidate } from './tick-plan';
import { DEFAULT_KAPPA } from '../world/constants';

export const EPSILON = 0.01;
export const DEFAULT_DESIRE_BOOST = 0.15;
export const DEFAULT_MOMENTUM_BONUS = 0.2;
export const DEFAULT_MOMENTUM_DECAY_MS = 300_000;
export const FAIRNESS_ALPHA = 2.0;
export const U_FAIRNESS_MAX = 4.0;
export const FAIRNESS_MIN_TOTAL_SERVICE = 5;
export const SIGMA2_OBS_EXPORT = SIGMA2_OBS;
export const GROUP_SILENCE_DAMPING_FLOOR = 0.3;

export const IAUS_ACTIONS: readonly IAUSAction[] = ['diligence', 'curiosity', 'sociability'];

export const MOOD_DELTA = 0.3;
export const PERSONALITY_NEUTRAL = 0.25;
export const DEFAULT_CURVE_MODULATION_STRENGTH = 0.5;
export const DEFAULT_MIN_PROACTIVE_UTILITY = 0.05;
export const DEFAULT_GROUP_MIN_PROACTIVE_UTILITY = 0.08;
export const DEFAULT_IAUS_COMPENSATION_FACTOR = 0.5;
export const DEFAULT_SOCIAL_SAFETY_MIDPOINT = 0.45;
export const DEFAULT_SOCIAL_SAFETY_SLOPE = 0.15;
export const DEFAULT_DELTA_SCALE = 0.35;

export type CurveType = 'sigmoid' | 'inv_sigmoid' | 'linear' | 'linear_dec' | 'log' | 'exp_recovery';

export interface ResponseCurve {
  type: CurveType;
  midpoint: number;
  slope: number;
  min: number;
  max: number;
}

const CURVES = {
  conflict_avoidance: { type: 'inv_sigmoid', midpoint: 0.6, slope: 5, min: EPSILON, max: 1 } as ResponseCurve,
  freshness: { type: 'linear_dec', midpoint: 0, slope: 1, min: EPSILON, max: 1 } as ResponseCurve,
  reciprocity: { type: 'linear_dec', midpoint: 0, slope: 3, min: 0.05, max: 1 } as ResponseCurve,
  obligation: { type: 'sigmoid', midpoint: 0.3, slope: 8, min: EPSILON, max: 1 } as ResponseCurve,
  attention: { type: 'sigmoid', midpoint: 0.2, slope: 6, min: EPSILON, max: 1 } as ResponseCurve,
  thread_age: { type: 'log', midpoint: 1, slope: 0.5, min: EPSILON, max: 1 } as ResponseCurve,
  deltaP: { type: 'sigmoid', midpoint: 0.3, slope: 4, min: EPSILON, max: 1 } as ResponseCurve,
  prospect: { type: 'sigmoid', midpoint: 0.1, slope: 6, min: EPSILON, max: 1 } as ResponseCurve,
  cooling: { type: 'sigmoid', midpoint: 0.3, slope: 5, min: EPSILON, max: 1 } as ResponseCurve,
  social_bond: { type: 'sigmoid', midpoint: 0.2, slope: 4, min: EPSILON, max: 1 } as ResponseCurve,
  social_safety: { type: 'inv_sigmoid', midpoint: 0.5, slope: 4, min: EPSILON, max: 1 } as ResponseCurve,
  novelty: { type: 'sigmoid', midpoint: 0.1, slope: 6, min: EPSILON, max: 1 } as ResponseCurve,
  info_pressure: { type: 'sigmoid', midpoint: 0.2, slope: 5, min: EPSILON, max: 1 } as ResponseCurve,
  exploration: { type: 'log', midpoint: 0.1, slope: 0.8, min: EPSILON, max: 1 } as ResponseCurve,
  attraction: { type: 'sigmoid', midpoint: 0.15, slope: 6, min: EPSILON, max: 1 } as ResponseCurve,
  voice_affinity: { type: 'sigmoid', midpoint: 0.33, slope: 6, min: EPSILON, max: 1 } as ResponseCurve,
};

export const SOCIAL_COST_BASELINE: Record<string, number> = {
  proactive_message: 1.0,
  send_message: 0.8,
  sociability: 0.8,
  reply: 0.6,
  diligence: 0.6,
  react: 0.3,
  curiosity: 0.3,
  mark_read: 0.1,
  caution: 0.1,
};

export const SOCIAL_COST_GROUP_MULTIPLIER: Record<string, number> = {
  proactive_message: 0.4,
  send_message: 0.4,
  sociability: 0.4,
  reply: 0.2,
  diligence: 0.2,
  react: 0.1,
  curiosity: 0.2,
  mark_read: 0.1,
  caution: 0.1,
};

// ── Scoring result ─────────────────────────────────────────────────────────

export interface IAUSScore {
  action: IAUSAction;
  voice: VoiceId;
  /** Product of considerations before compensation, or legacy base score in legacy mode. */
  rawScore: number;
  /** Final score after compensation. In consideration mode this equals netValue. */
  compensatedScore?: number;
  /** Score after aversion/momentum/desire multipliers, before fairness. */
  effectiveScore?: number;
  /** Score after fairness, before optional selection noise. */
  postFairnessScore?: number;
  /** Score used only for probability/sampling after optional Thompson noise. */
  selectionScore?: number;
  /** Lowest consideration key for quick debugging. */
  bottleneck?: string;
  /** Scoring mode used for this score. */
  scoringMode?: IAUSScoringMode;
  /** Post-compensation multipliers applied to the candidate. */
  multipliers?: Record<string, number>;
  /** Legacy audit-only social value: V = ΔP - λ · C_social. */
  legacyNetSocialValue?: number;
  /** Expected pressure relief ΔP for this action-target pair. */
  deltaP: number;
  /** Social cost computed via Brown-Levinson model. */
  socialCost: number;
  /** Final utility used for sorting and proactive gate checks. */
  netValue: number;
  /** Per-factor utilities used to compute rawScore. */
  considerations?: Record<string, number>;
  /** Selection probability after softmax over candidates. */
  selectedProbability?: number;
  /** Reason string for trace / log inspection. */
  reason: string;
}

// ── Scorer input ───────────────────────────────────────────────────────────

export interface IAUSScorerInput {
  voice: VoiceSelectionResult;
  desireBoost?: number;
  momentumBonus?: number;
  /** Social cost override (when world model is not available). */
  socialCost?: number;
}

export interface IAUSScorerContext {
  world: WorldModel;
  nowMs: number;
  pressure: PressureSnapshot | AllPressures;
  /** Recent action records for temporal penalty computation. */
  recentActions?: Array<{ ms?: number; action: string; target?: string | null; status?: string }>;
  personality?: PersonalityVector;
  selfMood?: number;
  voiceLastWon?: Partial<Record<IAUSAction, number>>;
  lastWinner?: { action: IAUSAction; targetId: string } | null;
  lastActionMs?: number;
  momentumBonus?: number;
  momentumDecayMs?: number;
  desireBoost?: number;
  curveModulationStrength?: number;
  thompsonEta?: number;
  deterministic?: boolean;
  windowStartMs?: number;
  afterwardByTarget?: Record<string, { value: NovaAfterward }>;
  iausFairnessAlpha?: number;
  iausFairnessMax?: number;
  iausFairnessMinTotalService?: number;
  /** Social cost configuration. */
  socialCostConfig?: SocialCostConfig;
  /** Kappa for tanh normalisation in deltaP. */
  kappa?: PressureDims;
  /** Lambda for net social value (loss-aversion coefficient, ≥ 1). */
  lambda?: number;
  scoringMode?: IAUSScoringMode;
  minProactiveUtility?: number;
  groupMinProactiveUtility?: number;
  iausCompensationFactor?: number;
  socialSafetyMidpoint?: number;
  socialSafetySlope?: number;
  privateCooldownMs?: number;
  groupCooldownMs?: number;
}

// ── Single-action scoring (message ticks) ──────────────────────────────────

/**
 * Score the selected voice as an IAUS action candidate.
 *
 * For message ticks (reply scenarios), uses a simplified social cost model.
 * For full proactive candidate scoring, use {@link scoreCandidates}.
 *
 * Returns null when the selected voice is caution (not an IAUS action).
 */
export function scoreAction(
  input: IAUSScorerInput,
  ctx?: IAUSScorerContext,
): IAUSScore | null {
  const { voice, desireBoost = 0, momentumBonus = 0, socialCost: socialCostOverride } = input;

  if (voice.iausAction === null) return null;

  const probability = voice.probabilities[voice.selected] ?? 0;
  const rawScore = Math.min(1, probability + desireBoost + momentumBonus);

  // Compute social cost: use override if provided, otherwise compute from world.
  let socialCost: number;
  let deltaP = 0;
  let netValue: number;

  if (socialCostOverride !== undefined) {
    socialCost = socialCostOverride;
    netValue = rawScore - socialCost;
  } else if (ctx) {
    // Compute proper social cost from world model.
    const { pressure, socialCostConfig = DEFAULT_SOCIAL_COST_CONFIG } = ctx;

    // Determine target and chat type from pressure contributions.
    // For message ticks, the target is typically the channel the message arrived on.
    const actionType = voice.iausAction;
    const intrusiveness = getIntrusiveness(actionType);

    // Use a default target for message-tick scoring (the reply target).
    // In practice this is determined by the evolve loop based on the incoming message.
    socialCost = intrusiveness * 0.5; // Simplified: use intrusiveness × context baseline.

    // Compute deltaP from contributions if available.
    const contributions = 'contributions' in pressure
      ? (pressure as AllPressures).contributions
      : ((pressure as PressureSnapshot).contributions as Record<string, Record<string, number>> | undefined);

    if (contributions && 'P1' in contributions) {
      // Find the most relevant target for this pressure dimension.
      // For message ticks we use a rough estimate.
      for (const dimContribs of Object.values(contributions)) {
        if (typeof dimContribs === 'object') {
          for (const value of Object.values(dimContribs)) {
            if (typeof value === 'number') {
              deltaP += Math.abs(value) * 0.5; // Rough estimate.
              break; // Only count each dimension once.
            }
          }
        }
      }
    }

    const effectiveLambda = ctx.lambda ?? socialCostConfig.lambda;
    netValue = computeNetSocialValue(deltaP, socialCost, effectiveLambda);
  } else {
    // Fallback: flat social cost of 0.5 (legacy behaviour).
    socialCost = 0.5;
    netValue = rawScore - socialCost;
  }

  // Reason string for trace.
  const reason = assembleIAUSReason({
    action: voice.iausAction,
    voice: voice.selected,
    rawScore,
    deltaP,
    socialCost,
    netValue,
    desireType: desireBoost > 0 ? 'present' : undefined,
  });

  return {
    action: voice.iausAction,
    voice: voice.selected,
    rawScore,
    deltaP,
    socialCost,
    netValue,
    reason,
  };
}

// ── Batch candidate scoring (scheduled ticks) ──────────────────────────────

export interface CandidateScoreResult {
  candidate: ActionCandidate;
  iausScore: IAUSScore;
}

/**
 * Score a set of proactive action candidates for a scheduled tick.
 *
 * For each candidate:
 *   1. Compute deltaP from pressure contributions targeting that entity.
 *   2. Compute socialCost using the Brown-Levinson model.
 *   3. Compute netValue = ΔP - λ · C_social.
 *   4. Softmax over netValues to get selectedProbability.
 *   5. Assemble IAUS reason string for trace.
 *
 * Candidates with netValue ≤ 0 are still returned (not filtered here) —
 * the social value gate in the evolve loop decides whether to silence them.
 */
export function scoreCandidates(
  candidates: ActionCandidate[],
  ctx: IAUSScorerContext,
): CandidateScoreResult[] {
  const {
    world,
    nowMs,
    pressure,
    recentActions = [],
    socialCostConfig = DEFAULT_SOCIAL_COST_CONFIG,
    kappa = DEFAULT_KAPPA,
    lambda = socialCostConfig.lambda,
    scoringMode = 'legacy_nsv',
    iausCompensationFactor = DEFAULT_IAUS_COMPENSATION_FACTOR,
    privateCooldownMs,
    groupCooldownMs,
  } = ctx;

  const pressureSnapshot = toPressureSnapshot(pressure, nowMs);
  const results: CandidateScoreResult[] = [];

  for (const candidate of candidates) {
    const actionType = candidate.action as IAUSAction;
    const targetId = candidate.targetId;
    const contribRecord = (pressureSnapshot.contributions ?? {}) as unknown as Record<string, Record<string, number>>;
    const deltaP = targetId ? estimateDeltaP(contribRecord, targetId, kappa) : 0;
    const chatType = candidate.scene === 'group' ? 'group' : 'private';
    const socialCost = computeSocialCost(
      world,
      targetId ?? '',
      actionType,
      nowMs,
      recentActions,
      socialCostConfig,
      chatType,
    );
    const legacyNetSocialValue = computeNetSocialValue(deltaP, socialCost, lambda);

    let rawScore: number;
    let compensatedScore: number | undefined;
    let effectiveScore: number | undefined;
    let postFairnessScore: number | undefined;
    let selectionScore: number | undefined;
    let netValue: number;
    let considerations: Record<string, number> | undefined;
    let multipliers: Record<string, number> | undefined;
    let bottleneck: string | undefined;

    if (scoringMode === 'consideration') {
      considerations = computeNovaConsiderations({
        candidate,
        world,
        nowMs,
        deltaP,
        socialCost,
        pressure: pressureSnapshot,
        recentActions,
        personality: ctx.personality ?? DEFAULT_PERSONALITY_VECTOR,
        selfMood: ctx.selfMood ?? 0,
        voiceLastWon: ctx.voiceLastWon,
        curveModulationStrength: ctx.curveModulationStrength,
        privateCooldownMs,
        groupCooldownMs,
        afterward: targetId ? ctx.afterwardByTarget?.[targetId]?.value : undefined,
      });
      const values = Object.values(considerations).filter(Number.isFinite).map(clampConsideration);
      rawScore = values.reduce((acc, value) => acc * value, 1);
      compensatedScore = compensate(rawScore, values.length, iausCompensationFactor);
      multipliers = computePostMultipliers({
        candidate,
        world,
        nowMs,
        socialCost,
        deltaP,
        lastWinner: ctx.lastWinner,
        lastActionMs: ctx.lastActionMs,
        momentumBonus: ctx.momentumBonus ?? DEFAULT_MOMENTUM_BONUS,
        momentumDecayMs: ctx.momentumDecayMs ?? DEFAULT_MOMENTUM_DECAY_MS,
        desireBoost: ctx.desireBoost ?? DEFAULT_DESIRE_BOOST,
      });
      effectiveScore = clampScore(compensatedScore * Object.values(multipliers).reduce((acc, value) => acc * value, 1));
      postFairnessScore = effectiveScore;
      selectionScore = effectiveScore;
      netValue = effectiveScore;
      bottleneck = findBottleneck(considerations);
    } else {
      const urgencyWeight = candidate.urgency === 'high' ? 0.3 :
        candidate.urgency === 'medium' ? 0.15 : 0.05;
      const baseActionWeight = 0.3;
      rawScore = Math.min(1, baseActionWeight + urgencyWeight);
      netValue = legacyNetSocialValue;
      selectionScore = netValue;
    }

    const reason = assembleIAUSReason({
      action: actionType,
      voice: actionType as VoiceId,
      rawScore,
      compensatedScore,
      legacyNetSocialValue,
      deltaP,
      socialCost,
      netValue,
      considerations,
      desireType: candidate.desireType,
      urgency: candidate.urgency,
      targetId,
      scene: candidate.scene,
    });

    const iausScore: IAUSScore = {
      action: actionType,
      voice: actionType as VoiceId,
      rawScore,
      ...(compensatedScore !== undefined ? { compensatedScore } : {}),
      ...(effectiveScore !== undefined ? { effectiveScore } : {}),
      ...(postFairnessScore !== undefined ? { postFairnessScore } : {}),
      ...(selectionScore !== undefined ? { selectionScore } : {}),
      ...(bottleneck !== undefined ? { bottleneck } : {}),
      scoringMode,
      ...(multipliers ? { multipliers } : {}),
      legacyNetSocialValue,
      deltaP,
      socialCost,
      netValue,
      ...(considerations ? { considerations } : {}),
      reason,
    };

    results.push({ candidate, iausScore });
  }

  if (scoringMode === 'consideration') {
    applyFairness(results, recentActions, ctx);
    applyThompsonNoise(results, ctx.thompsonEta ?? 0, ctx.deterministic ?? true);
  }
  applySelectedProbabilities(results);
  for (const result of results) {
    result.iausScore.reason = assembleIAUSReason({
      action: result.iausScore.action,
      voice: result.iausScore.voice,
      rawScore: result.iausScore.rawScore,
      compensatedScore: result.iausScore.compensatedScore,
      legacyNetSocialValue: result.iausScore.legacyNetSocialValue,
      deltaP: result.iausScore.deltaP,
      socialCost: result.iausScore.socialCost,
      netValue: result.iausScore.netValue,
      considerations: result.iausScore.considerations,
      desireType: result.candidate.desireType,
      urgency: result.candidate.urgency,
      targetId: result.candidate.targetId,
      scene: result.candidate.scene,
      selectedProbability: result.iausScore.selectedProbability,
    });
  }
  results.sort((a, b) => b.iausScore.netValue - a.iausScore.netValue);

  return results;
}

// ── IAUS reason assembly ───────────────────────────────────────────────────

export interface IAUSReasonInput {
  action: string;
  voice: VoiceId;
  rawScore: number;
  compensatedScore?: number;
  legacyNetSocialValue?: number;
  deltaP: number;
  socialCost: number;
  netValue: number;
  considerations?: Record<string, number>;
  desireType?: string;
  urgency?: string;
  targetId?: string | null;
  scene?: string;
  selectedProbability?: number;
}

/**
 * Assemble a structured, machine-readable IAUS reason string.
 *
 * The reason is assembled from structured data — NOT LLM-generated.
 * It is intended for trace / log inspection by developers, never exposed to QQ users.
 *
 * Example output:
 *   "iaus: action=reconnect (urgency=medium), voice=sociability, rawScore=0.450,
 *    deltaP=0.320, socialCost=0.480, netValue=-0.400, p=0.12,
 *    cost dominates, social value negative"
 */
export function assembleIAUSReason(input: IAUSReasonInput): string {
  const parts: string[] = ['iaus:'];

  // Action and desire context.
  const desireLabel = input.desireType ? ` ${input.desireType}` : '';
  const urgencyLabel = input.urgency ? ` (urgency=${input.urgency})` : '';
  parts.push(`action=${input.action}${desireLabel}${urgencyLabel}`);

  // Voice.
  parts.push(`voice=${input.voice}`);

  // Core scores.
  parts.push(`rawScore=${input.rawScore.toFixed(3)}`);
  if (input.compensatedScore !== undefined) {
    parts.push(`compensatedScore=${input.compensatedScore.toFixed(3)}`);
  }
  if (input.legacyNetSocialValue !== undefined) {
    parts.push(`legacyNSV=${input.legacyNetSocialValue.toFixed(3)}`);
  }
  parts.push(`deltaP=${input.deltaP.toFixed(3)}`);
  parts.push(`socialCost=${input.socialCost.toFixed(3)}`);
  parts.push(`netValue=${input.netValue.toFixed(3)}`);
  if (input.considerations) {
    const bottleneck = Object.entries(input.considerations).reduce(
      (min, entry) => entry[1] < min[1] ? entry : min,
      ['', Number.POSITIVE_INFINITY] as [string, number],
    );
    if (bottleneck[0]) parts.push(`bottleneck=${bottleneck[0]}:${bottleneck[1].toFixed(3)}`);
  }

  // Selection probability (if available).
  if (input.selectedProbability !== undefined) {
    parts.push(`p=${input.selectedProbability.toFixed(2)}`);
  }

  // Target and scene.
  if (input.targetId) {
    parts.push(`target=${input.targetId}`);
  }
  if (input.scene) {
    parts.push(`scene=${input.scene}`);
  }

  // Human-readable verdict.
  const verdict = input.netValue > 0
    ? 'social value positive'
    : input.socialCost > input.deltaP
      ? 'cost dominates, social value negative'
      : 'social value negative';
  parts.push(verdict);

  return parts.join(', ');
}

// ── Helper functions ───────────────────────────────────────────────────────

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function evalCurve(curve: ResponseCurve, x: number): number {
  const input = Number.isFinite(x) ? x : 0;
  let t: number;
  switch (curve.type) {
    case 'sigmoid':
      t = 1 / (1 + Math.exp(-curve.slope * (input - curve.midpoint)));
      break;
    case 'inv_sigmoid':
      t = 1 - 1 / (1 + Math.exp(-curve.slope * (input - curve.midpoint)));
      break;
    case 'linear':
      t = curve.slope > 0 ? clamp01((input - curve.midpoint) / curve.slope) : 0;
      break;
    case 'linear_dec':
      t = 1 - (curve.slope > 0 ? clamp01((input - curve.midpoint) / curve.slope) : 0);
      break;
    case 'log':
      t = curve.slope > 0 && curve.midpoint > 0
        ? clamp01(Math.log(1 + Math.max(0, input) * curve.slope) / Math.log(1 + curve.midpoint * curve.slope))
        : 0;
      break;
    case 'exp_recovery':
      t = 1 - Math.exp(-curve.slope * Math.max(0, input - curve.midpoint));
      break;
  }
  return Math.max(curve.min, Math.min(curve.max, curve.min + (curve.max - curve.min) * t));
}

export function modulateCurve(base: ResponseCurve, piV: number, strength = DEFAULT_CURVE_MODULATION_STRENGTH): ResponseCurve {
  if (!Number.isFinite(strength) || strength <= 0) return base;
  const delta = (clamp01(piV) - PERSONALITY_NEUTRAL) * clamp01(strength);
  return {
    ...base,
    midpoint: Math.max(0, base.midpoint * (1 - delta * 2)),
    slope: Math.max(0.0001, base.slope * (1 + delta * 2)),
  };
}

export function dormantNeutral(rawInput: number, hasEntity: boolean, curve: ResponseCurve): number {
  if (!hasEntity && rawInput === 0) return 1.0;
  return evalCurve(curve, rawInput);
}

export function sigmoidUtility(cost: number, midpoint = DEFAULT_SOCIAL_SAFETY_MIDPOINT, slope = DEFAULT_SOCIAL_SAFETY_SLOPE): number {
  if (!Number.isFinite(cost)) return 0;
  const safeSlope = Number.isFinite(slope) && slope > 0 ? slope : DEFAULT_SOCIAL_SAFETY_SLOPE;
  const safeMidpoint = Number.isFinite(midpoint) ? midpoint : DEFAULT_SOCIAL_SAFETY_MIDPOINT;
  return clamp01(1 / (1 + Math.exp((cost - safeMidpoint) / safeSlope)));
}

export function utilityFromDeltaP(deltaP: number, scene: 'private' | 'group' = 'private', deltaScale = DEFAULT_DELTA_SCALE): number {
  const floor = scene === 'group' ? 0.10 : 0.15;
  if (!Number.isFinite(deltaP) || deltaP <= 0) return floor;
  const scale = Number.isFinite(deltaScale) && deltaScale > 0 ? deltaScale : DEFAULT_DELTA_SCALE;
  const mapped = clamp01(1 - Math.exp(-deltaP / scale));
  return clamp01(floor + (1 - floor) * mapped);
}

export function utilityFromUrgency(urgency?: string): number {
  if (urgency === 'high') return 1.0;
  if (urgency === 'medium') return 0.8;
  return 0.6;
}

export function utilityFromCooling(
  candidate: ActionCandidate,
  world: WorldModel,
  nowMs: number,
  privateCooldownMs = 30 * 60 * 1000,
  groupCooldownMs = 2 * 60 * 60 * 1000,
): number {
  if (!candidate.targetId || !world.has(candidate.targetId)) return 1;
  const nodeType = world.getNodeType(candidate.targetId);
  if (nodeType !== 'channel' && nodeType !== 'contact') return 1;

  let lastMs: number | undefined;
  if (nodeType === 'channel') {
    const channel = world.getChannel(candidate.targetId);
    lastMs = Math.max(channel.last_nova_action_ms ?? 0, channel.last_proactive_outreach_ms ?? 0) || undefined;
  } else {
    lastMs = world.getContact(candidate.targetId).last_proactive_outreach_ms;
  }
  if (!lastMs || lastMs <= 0) return 1;

  const cooldownMs = candidate.scene === 'group' ? groupCooldownMs : privateCooldownMs;
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return 1;
  const elapsed = Math.max(0, nowMs - lastMs);
  return clamp01(Math.max(0.05, elapsed / cooldownMs));
}

export function utilityFromActivity(candidate: ActionCandidate, world: WorldModel, nowMs: number): number {
  if (!candidate.targetId || !world.has(candidate.targetId)) return candidate.scene === 'group' ? 0.25 : 0.4;
  if (world.getNodeType(candidate.targetId) !== 'channel') return 0.5;
  const channel = world.getChannel(candidate.targetId);
  const lastActivityMs = channel.last_activity_ms ?? 0;
  if (!lastActivityMs) return candidate.scene === 'group' ? 0.25 : 0.4;
  const elapsed = Math.max(0, nowMs - lastActivityMs);
  if (elapsed <= 10 * 60 * 1000) return candidate.scene === 'group' ? 0.9 : 1.0;
  if (elapsed <= 24 * 60 * 60 * 1000) return candidate.scene === 'group' ? 0.6 : 0.7;
  return candidate.scene === 'group' ? 0.2 : 0.3;
}

export function utilityFromSocialBond(candidate: ActionCandidate, world: WorldModel, nowMs: number): number {
  if (!candidate.targetId || !world.has(candidate.targetId)) return candidate.scene === 'group' ? 0.25 : 0.2;
  const nodeType = world.getNodeType(candidate.targetId);
  if (nodeType === 'contact') {
    const contact = world.getContact(candidate.targetId);
    const closeness = clamp01(((contact.rv_familiarity ?? 0) + (contact.rv_trust ?? 0) + (contact.rv_affection ?? 0) + (contact.rv_respect ?? 0)) / 4);
    return clamp01(0.4 + closeness * 0.6);
  }
  if (nodeType === 'channel') {
    const channel = world.getChannel(candidate.targetId);
    if (channel.chat_type === 'group') {
      const recent = (channel.last_activity_ms ?? 0) > 0 && nowMs - (channel.last_activity_ms ?? 0) <= 60 * 60 * 1000;
      return recent ? 0.6 : 0.25;
    }
    const tier = typeof channel.tier_contact === 'number' ? channel.tier_contact : 0;
    return clamp01(0.35 + Math.max(0, Math.min(100, tier)) / 100 * 0.45);
  }
  return 0.3;
}

export function compensate(rawScore: number, n: number, cf = DEFAULT_IAUS_COMPENSATION_FACTOR): number {
  if (!Number.isFinite(rawScore)) return 0;
  const raw = clamp01(rawScore);
  if (n <= 0) return raw;
  const factor = clamp01(cf);
  const geometric = Math.pow(raw, 1 / n);
  return clamp01(raw * (1 - factor) + geometric * factor);
}

interface NovaConsiderationInput {
  candidate: ActionCandidate;
  world: WorldModel;
  nowMs: number;
  deltaP: number;
  socialCost: number;
  pressure: PressureSnapshot;
  recentActions: Array<{ ms?: number; action: string; target?: string | null; status?: string }>;
  personality: PersonalityVector;
  selfMood: number;
  voiceLastWon?: Partial<Record<IAUSAction, number>>;
  curveModulationStrength?: number;
  privateCooldownMs?: number;
  groupCooldownMs?: number;
  afterward?: NovaAfterward;
}

function computeNovaConsiderations(input: NovaConsiderationInput): Record<string, number> {
  const action = input.candidate.action as IAUSAction;
  const targetId = input.candidate.targetId ?? '';
  const scene = input.candidate.scene === 'group' ? 'group' : 'private';
  const personalityWeight = input.personality[action] ?? DEFAULT_PERSONALITY_VECTOR[action];
  const curveStrength = input.curveModulationStrength ?? DEFAULT_CURVE_MODULATION_STRENGTH;
  const pressureByDim = getPressureContributions(input.pressure, targetId);
  const target = getTargetState(input.world, targetId);
  const activeThread = getActiveThreadAgeHours(input.world, targetId, input.nowMs);
  const shared: Record<string, number> = {
    U_conflict_avoidance: evalCurve(CURVES.conflict_avoidance, clamp01(input.socialCost + pressureByDim.P4 * 0.5 + (scene === 'group' ? 0.1 : 0))),
    U_freshness: evalCurve(CURVES.freshness, recentServiceCount(input.recentActions, targetId, input.nowMs, input.nowMs - 24 * 3600 * 1000) / 3),
    U_reciprocity: evalCurve(CURVES.reciprocity, outboundImbalance(target)),
    U_reachable: reachableUtility(target),
    U_fatigue: voiceFatigueUtility(input.voiceLastWon?.[action], input.nowMs),
    U_mood: action === 'sociability' ? clampConsideration(1 + MOOD_DELTA * input.selfMood) : 1,
    U_silence_damping: silenceDampingUtility(input.candidate, target),
    U_voice_affinity: evalCurve(CURVES.voice_affinity, voiceAffinity(action, pressureByDim)),
  };

  const actionSpecific = computeActionSpecificConsiderations({
    ...input,
    action,
    targetId,
    scene,
    pressureByDim,
    target,
    activeThread,
    personalityWeight,
    curveStrength,
  });

  return {
    ...shared,
    ...actionSpecific,
    U_afterward: afterwardUtility(input.afterward, scene, input.candidate.urgency),
  };
}

interface ActionSpecificInput extends NovaConsiderationInput {
  action: IAUSAction;
  targetId: string;
  scene: 'private' | 'group';
  pressureByDim: Record<'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P_prospect', number>;
  target: TargetState;
  activeThread: number | null;
  personalityWeight: number;
  curveStrength: number;
}

function computeActionSpecificConsiderations(input: ActionSpecificInput): Record<string, number> {
  if (input.action === 'diligence') {
    return {
      U_obligation: evalCurve(modulateCurve(CURVES.obligation, input.personalityWeight, input.curveStrength), Math.max(input.pressureByDim.P5, input.target.pendingDirected > 0 ? 0.8 : 0)),
      U_attention: evalCurve(modulateCurve(CURVES.attention, input.personalityWeight, input.curveStrength), Math.max(input.pressureByDim.P1, Math.min(1, input.target.unread / 5))),
      U_thread_age: dormantNeutral(input.activeThread ?? 0, input.activeThread !== null, modulateCurve(CURVES.thread_age, input.personalityWeight, input.curveStrength)),
      U_deltaP: evalCurve(modulateCurve(CURVES.deltaP, input.personalityWeight, input.curveStrength), input.deltaP),
      U_prospect: evalCurve(modulateCurve(CURVES.prospect, input.personalityWeight, input.curveStrength), Math.max(input.pressure.pProspect ?? 0, input.pressureByDim.P_prospect)),
    };
  }

  if (input.action === 'sociability') {
    return {
      U_cooling: evalCurve(modulateCurve(CURVES.cooling, input.personalityWeight, input.curveStrength), utilityFromCooling(input.candidate, input.world, input.nowMs, input.privateCooldownMs, input.groupCooldownMs)),
      U_social_bond: evalCurve(modulateCurve(CURVES.social_bond, input.personalityWeight, input.curveStrength), socialBondRaw(input.target, input.scene)),
      U_social_safety: evalCurve({ ...CURVES.social_safety, midpoint: DEFAULT_SOCIAL_SAFETY_MIDPOINT, slope: 1 / DEFAULT_SOCIAL_SAFETY_SLOPE }, input.socialCost),
      U_goldilocks: goldilocksUtility(input.candidate, input.target, input.nowMs, input.privateCooldownMs, input.groupCooldownMs),
      U_hawkes: hawkesUtility(input.target, input.nowMs),
      U_attraction: evalCurve(modulateCurve(CURVES.attraction, input.personalityWeight, input.curveStrength), input.target.attraction),
    };
  }

  return {
    U_novelty: evalCurve(modulateCurve(CURVES.novelty, input.personalityWeight, input.curveStrength), Math.max(input.pressureByDim.P6, input.target.activityRelevance * 0.5)),
    U_info_pressure: evalCurve(modulateCurve(CURVES.info_pressure, input.personalityWeight, input.curveStrength), Math.max(input.pressureByDim.P2, Math.min(1, input.target.unread / 8))),
    U_exploration: evalCurve(modulateCurve(CURVES.exploration, input.personalityWeight, input.curveStrength), explorationRaw(input.world, input.targetId, input.target)),
  };
}

interface TargetState {
  exists: boolean;
  nodeType?: string;
  isBot: boolean;
  unread: number;
  pendingDirected: number;
  lastActivityMs?: number;
  lastIncomingMs?: number;
  lastNovaActionMs?: number;
  lastProactiveMs?: number;
  activityRelevance: number;
  contactRecvWindow: number;
  outboundImbalance: number;
  bond: number;
  attraction: number;
  hawkesCarry: number;
  hawkesLastEventMs?: number;
  chatType?: 'private' | 'group';
}

function toPressureSnapshot(pressure: PressureSnapshot | AllPressures, nowMs: number): PressureSnapshot {
  return 'p1' in pressure
    ? pressure as PressureSnapshot
    : {
        tick: 0,
        createdMs: nowMs,
        p1: (pressure as AllPressures).P1,
        p2: (pressure as AllPressures).P2,
        p3: (pressure as AllPressures).P3,
        p4: (pressure as AllPressures).P4,
        p5: (pressure as AllPressures).P5,
        p6: (pressure as AllPressures).P6,
        p7: (pressure as AllPressures).P7,
        p8: (pressure as AllPressures).P8,
        pProspect: (pressure as AllPressures).P_prospect,
        api: (pressure as AllPressures).API,
        apiPeak: (pressure as AllPressures).API_peak,
        contributions: (pressure as AllPressures).contributions as unknown as Record<string, unknown>,
      };
}

function clampConsideration(value: number): number {
  if (!Number.isFinite(value)) return EPSILON;
  return Math.max(EPSILON, Math.min(U_FAIRNESS_MAX, value));
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function getPressureContributions(pressure: PressureSnapshot, targetId: string): Record<'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P_prospect', number> {
  const contributions = (pressure.contributions ?? {}) as unknown as Record<string, Record<string, number>>;
  return {
    P1: contributions.P1?.[targetId] ?? 0,
    P2: contributions.P2?.[targetId] ?? 0,
    P3: contributions.P3?.[targetId] ?? 0,
    P4: contributions.P4?.[targetId] ?? 0,
    P5: contributions.P5?.[targetId] ?? 0,
    P6: contributions.P6?.[targetId] ?? 0,
    P_prospect: contributions.P_prospect?.[targetId] ?? 0,
  };
}

function getTargetState(world: WorldModel, targetId: string): TargetState {
  if (!targetId || !world.has(targetId)) {
    return {
      exists: false,
      isBot: false,
      unread: 0,
      pendingDirected: 0,
      activityRelevance: 0,
      contactRecvWindow: 0,
      outboundImbalance: 0,
      bond: 0,
      attraction: 0,
      hawkesCarry: 0,
    };
  }

  const nodeType = world.getNodeType(targetId);
  if (nodeType === 'contact') {
    const contact = world.getContact(targetId);
    return {
      exists: true,
      nodeType,
      isBot: contact.is_bot === true,
      unread: 0,
      pendingDirected: 0,
      lastActivityMs: contact.last_active_ms,
      lastProactiveMs: contact.last_proactive_outreach_ms,
      activityRelevance: 0.5,
      contactRecvWindow: 0,
      outboundImbalance: Math.max(0, (contact.nova_initiated_count ?? 0) - (contact.contact_initiated_count ?? 0)),
      bond: clamp01(((contact.rv_familiarity ?? 0) + (contact.rv_trust ?? 0) + (contact.rv_affection ?? 0) + (contact.rv_respect ?? 0)) / 4),
      attraction: clamp01(contact.rv_attraction ?? 0),
      hawkesCarry: clamp01(contact.hawkes_carry ?? 0),
      hawkesLastEventMs: contact.hawkes_last_event_ms,
      chatType: 'private',
    };
  }

  if (nodeType === 'channel') {
    const channel = world.getChannel(targetId);
    return {
      exists: true,
      nodeType,
      isBot: false,
      unread: channel.unread ?? 0,
      pendingDirected: channel.pending_directed ?? 0,
      lastActivityMs: channel.last_activity_ms,
      lastIncomingMs: channel.last_incoming_ms,
      lastNovaActionMs: channel.last_nova_action_ms,
      lastProactiveMs: channel.last_proactive_outreach_ms,
      activityRelevance: clamp01(channel.activity_relevance ?? 0),
      contactRecvWindow: channel.contact_recv_window ?? 0,
      outboundImbalance: Math.max(0, -(channel.contact_recv_window ?? 0)),
      bond: channel.chat_type === 'group' ? clamp01(0.2 + (channel.activity_relevance ?? 0) * 0.5) : clamp01((channel.tier_contact ?? 0) / 100),
      attraction: 0,
      hawkesCarry: clamp01(channel.hawkes_carry ?? 0),
      hawkesLastEventMs: channel.hawkes_last_event_ms,
      chatType: channel.chat_type,
    };
  }

  return {
    exists: true,
    nodeType,
    isBot: false,
    unread: 0,
    pendingDirected: 0,
    activityRelevance: 0,
    contactRecvWindow: 0,
    outboundImbalance: 0,
    bond: 0.2,
    attraction: 0,
    hawkesCarry: 0,
  };
}

function getActiveThreadAgeHours(world: WorldModel, targetId: string, nowMs: number): number | null {
  let newest: number | null = null;
  for (const threadId of world.getEntitiesByType('thread')) {
    const thread = world.getThread(threadId);
    if (thread.status !== 'open' || thread.channel_id !== targetId) continue;
    newest = Math.max(newest ?? 0, thread.created_ms ?? 0);
  }
  return newest ? Math.max(0, nowMs - newest) / 3600000 : null;
}

function recentServiceCount(
  recentActions: Array<{ ms?: number; action: string; target?: string | null; status?: string }>,
  targetId: string,
  nowMs: number,
  windowStartMs: number,
): number {
  return recentActions.filter((action) =>
    (action.target ?? null) === targetId &&
    action.status !== 'failed' &&
    (action.ms ?? nowMs) >= windowStartMs,
  ).length;
}

function outboundImbalance(target: TargetState): number {
  if (!target.exists) return 0;
  return Math.max(0, Math.min(1, target.outboundImbalance / 3));
}

function reachableUtility(target: TargetState): number {
  if (!target.exists) return 0.7;
  if (target.isBot) return EPSILON;
  return 1;
}

function voiceFatigueUtility(lastWonMs: number | undefined, nowMs: number): number {
  if (!lastWonMs || lastWonMs <= 0) return 1;
  const elapsed = Math.max(0, nowMs - lastWonMs);
  return clampConsideration(0.5 + Math.min(0.5, elapsed / DEFAULT_MOMENTUM_DECAY_MS));
}

function silenceDampingUtility(candidate: ActionCandidate, target: TargetState): number {
  if (!target.exists) return candidate.scene === 'group' ? GROUP_SILENCE_DAMPING_FLOOR : 0.8;
  if (candidate.scene === 'group' && target.pendingDirected <= 0 && target.unread <= 0) return GROUP_SILENCE_DAMPING_FLOOR;
  return target.pendingDirected > 0 ? 1 : clampConsideration(0.7 + Math.min(0.3, target.unread / 10));
}

function voiceAffinity(action: IAUSAction, pressureByDim: Record<'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P_prospect', number>): number {
  const actionPressure = action === 'diligence'
    ? pressureByDim.P5 + pressureByDim.P1
    : action === 'sociability'
      ? pressureByDim.P3
      : pressureByDim.P6 + pressureByDim.P2;
  const total = pressureByDim.P1 + pressureByDim.P2 + pressureByDim.P3 + pressureByDim.P5 + pressureByDim.P6 + pressureByDim.P_prospect;
  return total > 0 ? actionPressure / total : DEFAULT_PERSONALITY_VECTOR[action] + VOICE_INDEX[action] * 0;
}

function socialBondRaw(target: TargetState, scene: 'private' | 'group'): number {
  if (!target.exists) return scene === 'group' ? 0.2 : 0.1;
  return clamp01(target.bond);
}

function goldilocksUtility(
  candidate: ActionCandidate,
  target: TargetState,
  nowMs: number,
  privateCooldownMs = 30 * 60 * 1000,
  groupCooldownMs = 2 * 60 * 60 * 1000,
): number {
  const lastMs = Math.max(target.lastNovaActionMs ?? 0, target.lastProactiveMs ?? 0, target.lastIncomingMs ?? 0);
  if (!lastMs) return candidate.scene === 'group' ? 0.45 : 0.6;
  const elapsed = Math.max(0, nowMs - lastMs);
  const cooldownMs = candidate.scene === 'group' ? groupCooldownMs : privateCooldownMs;
  if (elapsed < cooldownMs) return 0.08;
  if (elapsed <= 30 * 60 * 1000) return 1;
  if (elapsed <= 6 * 3600 * 1000) return target.bond > 0.4 || target.activityRelevance > 0.4 ? 0.85 : 0.6;
  return target.bond > 0.5 ? 0.7 : 0.35;
}

function hawkesUtility(target: TargetState, nowMs: number): number {
  if (!target.hawkesCarry) return 0.5;
  const elapsed = target.hawkesLastEventMs ? Math.max(0, nowMs - target.hawkesLastEventMs) : 0;
  const decay = Math.exp(-elapsed / (30 * 60 * 1000));
  return clampConsideration(0.45 + clamp01(target.hawkesCarry * decay) * 0.55);
}

function explorationRaw(world: WorldModel, targetId: string, target: TargetState): number {
  if (!target.exists) return 0.3;
  let factCount = 0;
  for (const factId of world.getEntitiesByType('fact')) {
    const fact = world.getFact(factId);
    if (fact.subject_id === targetId) factCount += 1;
  }
  return clamp01((3 - Math.min(3, factCount)) / 3 + target.activityRelevance * 0.3);
}

function afterwardUtility(afterward: NovaAfterward | undefined, scene: 'private' | 'group', urgency?: string): number {
  if (!afterward || afterward === 'done') return 1;
  if (afterward === 'watching') return scene === 'group' ? 0.3 : 0.5;
  if (afterward === 'waiting_reply') return urgency === 'high' ? 0.35 : 0.05;
  if (afterward === 'cooling_down') return EPSILON;
  return 1;
}

function computePostMultipliers(input: {
  candidate: ActionCandidate;
  world: WorldModel;
  nowMs: number;
  socialCost: number;
  deltaP: number;
  lastWinner?: { action: IAUSAction; targetId: string } | null;
  lastActionMs?: number;
  momentumBonus: number;
  momentumDecayMs: number;
  desireBoost: number;
}): Record<string, number> {
  const target = getTargetState(input.world, input.candidate.targetId ?? '');
  const aversion = clamp01(input.socialCost * 0.35 + (target.outboundImbalance > 1 ? 0.15 : 0) + (target.isBot ? 1 : 0));
  const matchesMomentum = input.lastWinner?.action === input.candidate.action && input.lastWinner.targetId === input.candidate.targetId;
  const elapsed = input.lastActionMs ? Math.max(0, input.nowMs - input.lastActionMs) : Number.POSITIVE_INFINITY;
  const momentum = matchesMomentum && elapsed <= input.momentumDecayMs
    ? 1 + input.momentumBonus * (1 - elapsed / Math.max(1, input.momentumDecayMs))
    : 1;
  const urgency = input.candidate.urgency === 'high' ? 1 : input.candidate.urgency === 'medium' ? 0.6 : 0.3;
  const desire = 1 + input.desireBoost * clamp01(urgency + input.deltaP);
  return {
    U_aversion_multiplier: clampConsideration(1 - aversion),
    U_momentum_multiplier: clampConsideration(momentum),
    U_desire_multiplier: clampConsideration(desire),
  };
}

function applyFairness(results: CandidateScoreResult[], recentActions: Array<{ ms?: number; action: string; target?: string | null; status?: string }>, ctx: IAUSScorerContext): void {
  const totalService = recentActions.filter((action) => action.status !== 'failed').length;
  const minService = ctx.iausFairnessMinTotalService ?? FAIRNESS_MIN_TOTAL_SERVICE;
  const alpha = ctx.iausFairnessAlpha ?? FAIRNESS_ALPHA;
  const maxFairness = ctx.iausFairnessMax ?? U_FAIRNESS_MAX;
  const totalScore = results.reduce((sum, result) => sum + Math.max(0, result.iausScore.effectiveScore ?? result.iausScore.netValue), 0);

  for (const result of results) {
    let fairness = 1;
    if (totalService >= minService && totalScore > 0 && result.candidate.targetId) {
      const service = recentActions.filter((action) => action.status !== 'failed' && (action.target ?? null) === result.candidate.targetId).length;
      const expectedShare = Math.max(EPSILON, Math.max(0, result.iausScore.effectiveScore ?? result.iausScore.netValue) / totalScore);
      const actualShare = Math.max(EPSILON, service / totalService);
      fairness = Math.max(EPSILON, Math.min(maxFairness, Math.pow(actualShare / expectedShare, -alpha)));
    }
    result.iausScore.considerations = {
      ...(result.iausScore.considerations ?? {}),
      U_fairness: fairness,
    };
    const postFairnessScore = clampScore((result.iausScore.effectiveScore ?? result.iausScore.netValue) * fairness);
    result.iausScore.postFairnessScore = postFairnessScore;
    result.iausScore.selectionScore = postFairnessScore;
    result.iausScore.netValue = postFairnessScore;
    result.iausScore.bottleneck = findBottleneck(result.iausScore.considerations);
  }
}

function applyThompsonNoise(results: CandidateScoreResult[], eta: number, deterministic: boolean): void {
  if (deterministic || eta <= 0) return;
  for (const result of results) {
    const score = result.iausScore.postFairnessScore ?? result.iausScore.netValue;
    const noise = (Math.random() - 0.5) * eta * Math.max(EPSILON, score);
    result.iausScore.selectionScore = Math.max(0, score + noise);
  }
}

function findBottleneck(considerations: Record<string, number>): string | undefined {
  let key: string | undefined;
  let value = Number.POSITIVE_INFINITY;
  for (const [name, score] of Object.entries(considerations)) {
    if (score < value) {
      key = name;
      value = score;
    }
  }
  return key;
}

function applySelectedProbabilities(results: CandidateScoreResult[]): void {
  if (results.length === 0) return;

  const values = results.map((r) => r.iausScore.selectionScore ?? r.iausScore.netValue);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const spread = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  const tau = 0.05 + 0.2 / (1 + spread * 5);
  const maxValue = Math.max(...values);
  const weights = values.map((value) => Math.exp(Math.max(-50, Math.min(50, (value - maxValue) / tau))));
  const total = weights.reduce((sum, value) => sum + value, 0);

  for (let i = 0; i < results.length; i++) {
    results[i]!.iausScore.selectedProbability = total > 0 ? (weights[i] ?? 0) / total : 1 / results.length;
  }
}

/**
 * Check whether the given voice can produce an IAUS action.
 * Only diligence, curiosity, and sociability are valid IAUS actions.
 */
export function isIAUSAction(voice: VoiceId): voice is IAUSAction {
  return (IAUS_ACTIONS as readonly string[]).includes(voice);
}

/**
 * Map a VoiceSelectionResult to the IAUS action it represents.
 * Returns null for caution (which never drives standalone action).
 */
export function voiceToIAUSResult(voice: VoiceSelectionResult): {
  iausAction: IAUSAction | null;
  probability: number;
} {
  return {
    iausAction: voice.iausAction,
    probability: voice.probabilities[voice.selected] ?? 0,
  };
}
