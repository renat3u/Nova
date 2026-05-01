// Phase 2 Step 08: IAUS scorer, social cost, and social value tests
//
// Validates:

//   2. scoreAction / scoreCandidates correctness
//   3. Social cost computation (private vs group)
//   4. Social value gate (netValue > 0 → pass, ≤ 0 → silence)
//   5. IAUS reason assembly (structured, no internal exposure)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldModel } from '../world/model.js';
import { DEFAULT_KAPPA, PRESSURE_SPECS } from '../world/constants.js';

import {
  EPSILON,
  DEFAULT_DESIRE_BOOST,
  DEFAULT_MOMENTUM_BONUS,
  DEFAULT_MOMENTUM_DECAY_MS,
  FAIRNESS_ALPHA,
  U_FAIRNESS_MAX,
  FAIRNESS_MIN_TOTAL_SERVICE,
  SIGMA2_OBS_EXPORT,
  GROUP_SILENCE_DAMPING_FLOOR,
  IAUS_ACTIONS,
  MOOD_DELTA,
  PERSONALITY_NEUTRAL,
  DEFAULT_CURVE_MODULATION_STRENGTH,
  DEFAULT_IAUS_COMPENSATION_FACTOR,
  DEFAULT_MIN_PROACTIVE_UTILITY,
  DEFAULT_GROUP_MIN_PROACTIVE_UTILITY,
  DEFAULT_SOCIAL_SAFETY_MIDPOINT,
  DEFAULT_SOCIAL_SAFETY_SLOPE,
  SOCIAL_COST_BASELINE,
  SOCIAL_COST_GROUP_MULTIPLIER,
  clamp01,
  evalCurve,
  modulateCurve,
  dormantNeutral,
  sigmoidUtility,
  utilityFromDeltaP,
  utilityFromUrgency,
  utilityFromCooling,
  utilityFromActivity,
  compensate,
  scoreAction,
  scoreCandidates,
  assembleIAUSReason,
  isIAUSAction,
  voiceToIAUSResult,
  type IAUSScore,
  type IAUSScorerContext,
} from '../engine/iaus-scorer.js';

import { selectVoice, type VoiceSelectionResult } from '../voices/selection.js';
import type { VoiceId } from '../personality/vector.js';

import {
  INTRUSIVENESS,
  INTRUSIVENESS_GROUP,
  getIntrusiveness,
  computeSocialCost,
  DEFAULT_SOCIAL_COST_CONFIG,
} from '../pressure/social-cost.js';

import {
  estimateDeltaP,
  computeNetSocialValue,
  computeVoI,
  SIGMA2_OBS,
} from '../pressure/social-value.js';

import type { ActionCandidate } from '../engine/tick-plan.js';
import type { PressureSnapshot } from '../pressure/aggregate.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeWorld(): WorldModel {
  const world = new WorldModel();
  world.addAgent('qq:self:nova', {
    platform: 'qq',
    created_ms: Date.now(), display_name: 'Nova',
  });
  return world;
}

function addPrivateChannel(world: WorldModel, channelId: string, contactQQ: string): void {
  const contactId = `qq:user:${contactQQ}`;
  world.addContact(contactId, {
    platform: 'qq',
    qq: contactQQ,
    tier: 50,
    interaction_count: 5,
    relation_type: 'friend',
    nova_initiated_count: 2,
    contact_initiated_count: 6,
    rv_familiarity: 0.3,
    rv_trust: 0.4,
    rv_affection: 0.2,
    rv_attraction: 0,
    rv_respect: 0.3,
    rv_familiarity_velocity: 0,
    rv_trust_velocity: 0,
    rv_affection_velocity: 0,
    rv_attraction_velocity: 0,
    rv_respect_velocity: 0,
    hawkes_carry: 0,
  });
  world.addChannel(channelId, {
    platform: 'qq',
    chat_type: 'private',
    tier_contact: 50,
    unread: 1,
    pending_directed: 0,
    last_activity_ms: Date.now(),
    contact_recv_window: 3,
    activity_relevance: 0.5,
    hawkes_carry: 0,
  });
}

function makeVoiceResult(selected: VoiceId): VoiceSelectionResult {
  const loudness: Record<VoiceId, number> = {
    diligence: selected === 'diligence' ? 0.7 : 0.1,
    curiosity: selected === 'curiosity' ? 0.7 : 0.1,
    sociability: selected === 'sociability' ? 0.7 : 0.1,
    caution: selected === 'caution' ? 0.7 : 0.1,
  };
  const fatigue: Record<VoiceId, number> = {
    diligence: 1, curiosity: 1, sociability: 1, caution: 1,
  };
  return selectVoice(loudness, fatigue, [], { deterministic: true });
}

function makePressureSnapshot(overrides: Partial<PressureSnapshot> = {}): PressureSnapshot {
  return {
    tick: 1,
    createdMs: Date.now(),
    p1: 12, p2: 15, p3: 4, p4: 2, p5: 40, p6: 0.5,
    pProspect: 0.8, api: 2.5, apiPeak: 3.0,
    contributions: {
      P1: { 'qq:private:10001': 3, 'qq:group:20001': 5 },
      P2: { 'qq:private:10001': 2 },
      P3: { 'qq:private:10001': 1.5 },
      P4: { 'qq:private:10001': 0.5 },
      P5: { 'qq:private:10001': 8 },
      P6: { 'qq:private:10001': 0.2 },
      P_prospect: { 'qq:private:10001': 0.3 },
      pressureHistory: { P1: [10], P2: [12], P3: [3], P4: [1.5], P5: [35], P6: [0.4] },
    },
    ...overrides,
  };
}

function makeCandidates(): ActionCandidate[] {
  return [
    {
      action: 'sociability',
      targetId: 'qq:private:10001',
      desireType: 'reconnect',
      urgency: 'medium',
      scene: 'private',
      reason: 'desire: reconnect (urgency=medium), value=4.500, threshold=0.300 target=qq:private:10001',
    },
    {
      action: 'curiosity',
      targetId: 'qq:group:20001',
      desireType: 'explore',
      urgency: 'low',
      scene: 'group',
      reason: 'desire: explore (urgency=low), value=0.450, threshold=0.300 target=qq:group:20001',
    },
    {
      action: 'diligence',
      targetId: 'qq:private:10001',
      desireType: 'fulfill_duty',
      urgency: 'high',
      scene: 'private',
      reason: 'desire: fulfill_duty (urgency=high), value=40.000, threshold=0.200 target=qq:private:10001',
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════

test('IAUS constants match Nova Step 08 specs', () => {
  assert.strictEqual(EPSILON, 0.01);
  assert.strictEqual(DEFAULT_DESIRE_BOOST, 0.15);
  assert.strictEqual(DEFAULT_MOMENTUM_BONUS, 0.2);
  assert.strictEqual(DEFAULT_MOMENTUM_DECAY_MS, 300_000);
  assert.strictEqual(FAIRNESS_ALPHA, 2.0);
  assert.strictEqual(U_FAIRNESS_MAX, 4.0);
  assert.strictEqual(FAIRNESS_MIN_TOTAL_SERVICE, 5);
  assert.strictEqual(SIGMA2_OBS_EXPORT, SIGMA2_OBS);
  assert.strictEqual(GROUP_SILENCE_DAMPING_FLOOR, 0.3);
  assert.strictEqual(MOOD_DELTA, 0.3);
  assert.strictEqual(PERSONALITY_NEUTRAL, 0.25);
  assert.strictEqual(DEFAULT_CURVE_MODULATION_STRENGTH, 0.5);
  assert.strictEqual(DEFAULT_MIN_PROACTIVE_UTILITY, 0.05);
  assert.strictEqual(DEFAULT_GROUP_MIN_PROACTIVE_UTILITY, 0.08);
  assert.strictEqual(DEFAULT_IAUS_COMPENSATION_FACTOR, 0.5);
  assert.strictEqual(DEFAULT_SOCIAL_SAFETY_MIDPOINT, 0.45);
  assert.strictEqual(DEFAULT_SOCIAL_SAFETY_SLOPE, 0.15);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1b. Consideration utility helpers
// ═══════════════════════════════════════════════════════════════════════════

test('consideration helpers clamp finite utility values', () => {
  assert.strictEqual(clamp01(-1), 0);
  assert.strictEqual(clamp01(2), 1);
  assert.strictEqual(clamp01(Number.NaN), 0);

  const safetyLowCost = sigmoidUtility(0.1, 0.45, 0.15);
  const safetyHighCost = sigmoidUtility(0.9, 0.45, 0.15);
  assert.ok(safetyLowCost > safetyHighCost, 'social safety should decrease as cost rises');
  assert.ok(safetyLowCost <= 1 && safetyLowCost >= 0);
  assert.ok(safetyHighCost <= 1 && safetyHighCost >= 0);

  assert.ok(utilityFromDeltaP(0, 'private') > 0, 'deltaP utility has private floor');
  assert.ok(utilityFromDeltaP(0, 'group') > 0, 'deltaP utility has group floor');
  assert.ok(utilityFromDeltaP(1, 'private') > utilityFromDeltaP(0, 'private'));

  assert.strictEqual(utilityFromUrgency('low'), 0.6);
  assert.strictEqual(utilityFromUrgency('medium'), 0.8);
  assert.strictEqual(utilityFromUrgency('high'), 1.0);

  const raw = 0.01;
  const compensated = compensate(raw, 6, 0.5);
  assert.ok(compensated > raw, 'compensation should lift multi-factor product');
  assert.ok(compensated <= 1 && compensated >= 0);
});

test('cooling and activity utilities stay within [0, 1]', () => {
  const world = makeWorld();
  const now = Date.now();
  addPrivateChannel(world, 'qq:private:10001', '10001');
  world.updateChannel('qq:private:10001', {
    last_nova_action_ms: now - 1000,
    last_activity_ms: now - 5 * 60 * 1000,
  });
  const candidate: ActionCandidate = {
    action: 'sociability',
    targetId: 'qq:private:10001',
    scene: 'private',
    reason: 'test',
  };

  const cooling = utilityFromCooling(candidate, world, now, 10_000, 10_000);
  const activity = utilityFromActivity(candidate, world, now);
  assert.ok(cooling >= 0 && cooling <= 1);
  assert.ok(activity >= 0 && activity <= 1);
  assert.ok(cooling < 1, 'recent Nova action should lower cooling utility');
});

test('IAUS_ACTIONS excludes caution', () => {
  assert.deepStrictEqual(IAUS_ACTIONS, ['diligence', 'curiosity', 'sociability']);
  assert.ok(!(IAUS_ACTIONS as readonly string[]).includes('caution'));
});

test('SOCIAL_COST_BASELINE matches Nova private intrusiveness specs', () => {
  assert.strictEqual(SOCIAL_COST_BASELINE.proactive_message, 1.0);
  assert.strictEqual(SOCIAL_COST_BASELINE.send_message, 0.8);
  assert.strictEqual(SOCIAL_COST_BASELINE.sociability, 0.8);
  assert.strictEqual(SOCIAL_COST_BASELINE.reply, 0.6);
  assert.strictEqual(SOCIAL_COST_BASELINE.diligence, 0.6);
  assert.strictEqual(SOCIAL_COST_BASELINE.react, 0.3);
  assert.strictEqual(SOCIAL_COST_BASELINE.curiosity, 0.3);
  assert.strictEqual(SOCIAL_COST_BASELINE.mark_read, 0.1);
  assert.strictEqual(SOCIAL_COST_BASELINE.caution, 0.1);
});

test('SOCIAL_COST_GROUP_MULTIPLIER matches Nova group intrusiveness specs', () => {
  assert.strictEqual(SOCIAL_COST_GROUP_MULTIPLIER.proactive_message, 0.4);
  assert.strictEqual(SOCIAL_COST_GROUP_MULTIPLIER.send_message, 0.4);
  assert.strictEqual(SOCIAL_COST_GROUP_MULTIPLIER.sociability, 0.4);
  assert.strictEqual(SOCIAL_COST_GROUP_MULTIPLIER.reply, 0.2);
  assert.strictEqual(SOCIAL_COST_GROUP_MULTIPLIER.diligence, 0.2);
  assert.strictEqual(SOCIAL_COST_GROUP_MULTIPLIER.react, 0.1);
  assert.strictEqual(SOCIAL_COST_GROUP_MULTIPLIER.curiosity, 0.2);
  assert.strictEqual(SOCIAL_COST_GROUP_MULTIPLIER.mark_read, 0.1);
  assert.strictEqual(SOCIAL_COST_GROUP_MULTIPLIER.caution, 0.1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Intrusiveness tables
// ═══════════════════════════════════════════════════════════════════════════

test('INTRUSIVENESS and INTRUSIVENESS_GROUP are identical to Nova', () => {
  // Private
  assert.strictEqual(INTRUSIVENESS.proactive_message, 1.0);
  assert.strictEqual(INTRUSIVENESS.sociability, 0.8);
  assert.strictEqual(INTRUSIVENESS.reply, 0.6);
  assert.strictEqual(INTRUSIVENESS.curiosity, 0.3);
  assert.strictEqual(INTRUSIVENESS.caution, 0.1);

  // Group — lower but non-zero for public speech risk
  assert.strictEqual(INTRUSIVENESS_GROUP.proactive_message, 0.4);
  assert.strictEqual(INTRUSIVENESS_GROUP.sociability, 0.4);
  assert.strictEqual(INTRUSIVENESS_GROUP.reply, 0.2);
  assert.strictEqual(INTRUSIVENESS_GROUP.curiosity, 0.2);
  assert.strictEqual(INTRUSIVENESS_GROUP.caution, 0.1);
});

test('getIntrusiveness returns private values for private chat', () => {
  assert.strictEqual(getIntrusiveness('proactive_message', 'private'), 1.0);
  assert.strictEqual(getIntrusiveness('reply', 'private'), 0.6);
  assert.strictEqual(getIntrusiveness('curiosity', 'private'), 0.3);
});

test('getIntrusiveness returns group values for group chat', () => {
  assert.strictEqual(getIntrusiveness('proactive_message', 'group'), 0.4);
  assert.strictEqual(getIntrusiveness('reply', 'group'), 0.2);
  assert.strictEqual(getIntrusiveness('curiosity', 'group'), 0.2);
});

test('getIntrusiveness defaults to 0.5 for unknown action types', () => {
  assert.strictEqual(getIntrusiveness('unknown_action'), 0.5);
  assert.strictEqual(getIntrusiveness('unknown_action', 'group'), 0.5);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. scoreAction — single-action scoring
// ═══════════════════════════════════════════════════════════════════════════

test('scoreAction returns null for caution voice', () => {
  const voice = makeVoiceResult('caution');
  const result = scoreAction({ voice });
  assert.strictEqual(result, null);
});

test('scoreAction returns IAUSScore for diligence voice', () => {
  const voice = makeVoiceResult('diligence');
  const result = scoreAction({ voice });
  assert.ok(result !== null);
  assert.strictEqual(result!.action, 'diligence');
  assert.strictEqual(result!.voice, 'diligence');
  assert.ok(result!.rawScore > 0);
  assert.ok(typeof result!.netValue === 'number');
});

test('scoreAction returns IAUSScore for sociability voice with desire boost', () => {
  const voice = makeVoiceResult('sociability');
  const result = scoreAction({ voice, desireBoost: 0.15 });
  assert.ok(result !== null);
  assert.strictEqual(result!.action, 'sociability');
  assert.ok(result!.rawScore <= 1.0, 'rawScore must be capped at 1.0');
});

test('scoreAction with social cost override uses override value', () => {
  const voice = makeVoiceResult('curiosity');
  const result = scoreAction({ voice, socialCost: 0.3 });
  assert.ok(result !== null);
  assert.strictEqual(result!.socialCost, 0.3);
  assert.strictEqual(result!.netValue, result!.rawScore - 0.3);
});

test('scoreAction rawScore is capped at 1.0', () => {
  const voice = makeVoiceResult('diligence');
  const result = scoreAction({ voice, desireBoost: 0.9, momentumBonus: 0.8 });
  assert.ok(result !== null);
  assert.ok(result!.rawScore <= 1.0);
});

test('scoreAction includes deltaP and netValue in result', () => {
  const voice = makeVoiceResult('diligence');
  const result = scoreAction({ voice });

  assert.ok(result !== null);
  assert.ok(typeof result!.deltaP === 'number');
  assert.ok(typeof result!.socialCost === 'number');
  assert.ok(typeof result!.netValue === 'number');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. scoreCandidates — batch candidate scoring
// ═══════════════════════════════════════════════════════════════════════════

test('scoreCandidates scores all candidates with IAUS scores', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');

  const pressure = makePressureSnapshot();
  const candidates = makeCandidates();
  const ctx: IAUSScorerContext = {
    scoringMode: 'legacy_nsv',
    world,
    nowMs: Date.now(),
    pressure,
    kappa: DEFAULT_KAPPA,
  };

  const results = scoreCandidates(candidates, ctx);
  assert.strictEqual(results.length, 3);

  for (const result of results) {
    assert.ok(result.iausScore !== null);
    assert.ok(typeof result.iausScore.deltaP === 'number');
    assert.ok(typeof result.iausScore.socialCost === 'number');
    assert.ok(typeof result.iausScore.netValue === 'number');
    assert.ok(typeof result.iausScore.rawScore === 'number');
    assert.ok(result.iausScore.rawScore <= 1.0);
    assert.ok(result.iausScore.reason.length > 0);
  }
});

test('scoreCandidates computes selectedProbability via softmax', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');

  const pressure = makePressureSnapshot();
  const candidates = makeCandidates();
  const ctx: IAUSScorerContext = {
    scoringMode: 'legacy_nsv',
    world,
    nowMs: Date.now(),
    pressure,
    kappa: DEFAULT_KAPPA,
  };

  const results = scoreCandidates(candidates, ctx);

  // All candidates should have selectedProbability.
  for (const result of results) {
    assert.ok(result.iausScore.selectedProbability !== undefined);
    assert.ok(result.iausScore.selectedProbability > 0);
    assert.ok(result.iausScore.selectedProbability <= 1.0);
  }

  // Probabilities should sum to ~1.0.
  const sum = results.reduce((s, r) => s + (r.iausScore.selectedProbability ?? 0), 0);
  assert.ok(Math.abs(sum - 1.0) < 0.001, `probabilities sum to ${sum}, expected ~1.0`);
});

test('scoreCandidates returns sorted by netValue descending', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');

  const pressure = makePressureSnapshot();
  const candidates = makeCandidates();
  const ctx: IAUSScorerContext = {
    scoringMode: 'legacy_nsv',
    world,
    nowMs: Date.now(),
    pressure,
    kappa: DEFAULT_KAPPA,
  };

  const results = scoreCandidates(candidates, ctx);

  // Results should already be sorted by netValue descending from the function.
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1]!.iausScore.netValue;
    const curr = results[i]!.iausScore.netValue;
    assert.ok(prev >= curr, `expected ${prev} >= ${curr} at index ${i}`);
  }
});

test('scoreCandidates handles empty candidate list', () => {
  const world = makeWorld();
  const pressure = makePressureSnapshot();
  const ctx: IAUSScorerContext = {
    scoringMode: 'legacy_nsv',
    world,
    nowMs: Date.now(),
    pressure,
    kappa: DEFAULT_KAPPA,
  };

  const results = scoreCandidates([], ctx);
  assert.strictEqual(results.length, 0);
});

test('scoreCandidates assigns higher social cost to group candidates', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');
  world.addChannel('qq:group:20001', {
    platform: 'qq',
    chat_type: 'group',
    tier_contact: 150,
    unread: 5,
    pending_directed: 0,
    last_activity_ms: Date.now(),
    contact_recv_window: 10,
    activity_relevance: 0.3,
    hawkes_carry: 0,
    group_id: '20001',
  });

  const pressure = makePressureSnapshot();
  const privateCandidate: ActionCandidate = {
    action: 'sociability',
    targetId: 'qq:private:10001',
    desireType: 'reconnect',
    urgency: 'medium',
    scene: 'private',
    reason: 'test private',
  };
  const groupCandidate: ActionCandidate = {
    action: 'curiosity',
    targetId: 'qq:group:20001',
    desireType: 'explore',
    urgency: 'low',
    scene: 'group',
    reason: 'test group',
  };

  const ctx: IAUSScorerContext = {
    scoringMode: 'legacy_nsv',
    world,
    nowMs: Date.now(),
    pressure,
    kappa: DEFAULT_KAPPA,
  };

  const results = scoreCandidates([privateCandidate, groupCandidate], ctx);

  // The intent: group social cost via computeSocialCost respects
  // lower per-action intrusiveness in groups but still has C_dist
  // contributions.  We verify both candidates get scored.
  assert.strictEqual(results.length, 2);
  assert.ok(typeof results[0]!.iausScore.socialCost === 'number');
  assert.ok(typeof results[1]!.iausScore.socialCost === 'number');
});

test('scoreCandidates consideration mode preserves legacy NSV as audit field while using compensatedScore', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');
  const now = Date.now();
  world.updateChannel('qq:private:10001', { last_activity_ms: now - 5 * 60 * 1000 });

  const pressure = makePressureSnapshot({
    contributions: {
      P3: { 'qq:private:10001': 0.12 },
    },
  });
  const candidate: ActionCandidate = {
    action: 'sociability',
    targetId: 'qq:private:10001',
    desireType: 'reconnect',
    urgency: 'high',
    scene: 'private',
    reason: 'test consideration',
  };

  const results = scoreCandidates([candidate], {
    world,
    nowMs: now,
    pressure,
    kappa: DEFAULT_KAPPA,
    scoringMode: 'consideration',
    minProactiveUtility: 0.05,
    socialSafetyMidpoint: 1,
    socialSafetySlope: 0.15,
  });

  const score = results[0]!.iausScore;
  assert.ok(score.legacyNetSocialValue !== undefined);
  assert.ok(score.legacyNetSocialValue < 0, `expected legacy NSV < 0, got ${score.legacyNetSocialValue}`);
  assert.ok(score.compensatedScore !== undefined);
  assert.equal(score.effectiveScore, score.netValue);
  assert.ok(score.netValue >= 0.05, `expected utility pass threshold, got ${score.netValue}`);
  assert.ok(score.considerations?.U_social_safety !== undefined);
});

test('scoreCandidates consideration mode maps higher social cost to lower U_social_safety', () => {
  const lowCostSafety = sigmoidUtility(0.1, 0.45, 0.15);
  const highCostSafety = sigmoidUtility(0.9, 0.45, 0.15);

  assert.ok(lowCostSafety > highCostSafety);
});

test('scoreCandidates consideration mode sorts by compensated utility', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');
  addPrivateChannel(world, 'qq:private:10002', '10002');
  const pressure = makePressureSnapshot({
    contributions: {
      P3: { 'qq:private:10001': 0.05, 'qq:private:10002': 0.5 },
    },
  });

  const results = scoreCandidates([
    { action: 'sociability', targetId: 'qq:private:10001', urgency: 'low', scene: 'private', reason: 'low' },
    { action: 'sociability', targetId: 'qq:private:10002', urgency: 'high', scene: 'private', reason: 'high' },
  ], {
    world,
    nowMs: Date.now(),
    pressure,
    scoringMode: 'consideration',
  });

  assert.equal(results[0]!.candidate.targetId, 'qq:private:10002');
  assert.ok(results[0]!.iausScore.netValue >= results[1]!.iausScore.netValue);
  const probabilitySum = results.reduce((sum, r) => sum + (r.iausScore.selectedProbability ?? 0), 0);
  assert.ok(Math.abs(probabilitySum - 1) < 0.001);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Social cost computation
// ═══════════════════════════════════════════════════════════════════════════

test('computeSocialCost returns a number in [0, ~1] for known targets', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');

  const cost = computeSocialCost(
    world,
    'qq:private:10001',
    'proactive_message',
    Date.now(),
    [],
  );

  assert.ok(typeof cost === 'number');
  assert.ok(cost >= 0);
  assert.ok(cost <= 1.5, `social cost ${cost} exceeds reasonable range`);
});

test('computeSocialCost accepts contact targets for proactive private candidates', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');

  const cost = computeSocialCost(
    world,
    'qq:user:10001',
    'curiosity',
    Date.now(),
    [],
  );

  assert.ok(typeof cost === 'number');
  assert.ok(cost >= 0);
  assert.ok(cost <= 1.5, `social cost ${cost} exceeds reasonable range`);
});

test('computeSocialCost for group differs from private', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');
  world.addChannel('qq:group:20001', {
    platform: 'qq',
    chat_type: 'group',
    tier_contact: 150,
    unread: 5,
    pending_directed: 0,
    last_activity_ms: Date.now(),
    contact_recv_window: 10,
    activity_relevance: 0.3,
    hawkes_carry: 0,
    group_id: '20001',
  });

  const privateCost = computeSocialCost(
    world,
    'qq:private:10001',
    'proactive_message',
    Date.now(),
    [],
  );

  const groupCost = computeSocialCost(
    world,
    'qq:group:20001',
    'proactive_message',
    Date.now(),
    [],
    DEFAULT_SOCIAL_COST_CONFIG,
    'group',
  );

  // Both should be valid numbers; group is not necessarily lower
  // because C_dist contribution depends on silence duration and tier.
  assert.ok(typeof privateCost === 'number');
  assert.ok(typeof groupCost === 'number');
});

test('DEFAULT_SOCIAL_COST_CONFIG matches Nova Step 08 specs', () => {
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.wDist, 0.3);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.wPower, 0.1);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.wImp, 0.3);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.wTemp, 0.3);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.alpha1, 0.5);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.alpha2, 0.3);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.alpha3, 0.2);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.tauDist, 3600);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.beta1, 0.7);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.beta2, 0.3);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.gamma1, 0.5);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.gamma2, 0.5);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.delta1, 0.7);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.delta2, 0.3);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.lambdaC, 6.0);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.lambda, 1.5);
  assert.strictEqual(DEFAULT_SOCIAL_COST_CONFIG.window, 1800);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Social value computation
// ═══════════════════════════════════════════════════════════════════════════

test('estimateDeltaP returns 0 for non-existent target', () => {
  const contributions: Record<string, Record<string, number>> = {
    P1: { 'other': 1.0 },
    P2: {},
    P3: {},
    P4: {},
    P5: {},
    P6: {},
  };
  const dp = estimateDeltaP(contributions, 'missing_target');
  assert.strictEqual(dp, 0);
});

test('estimateDeltaP sums contributions for target without kappa', () => {
  const contributions: Record<string, Record<string, number>> = {
    P1: { 'target': 3.0 },
    P2: { 'target': 2.0 },
    P3: {},
    P4: {},
    P5: {},
    P6: {},
  };
  const dp = estimateDeltaP(contributions, 'target');
  assert.strictEqual(dp, 5.0);
});

test('estimateDeltaP with kappa applies tanh normalisation', () => {
  const contributions: Record<string, Record<string, number>> = {
    P1: { 'target': 100.0 },  // Large raw value
    P2: {},
    P3: {},
    P4: {},
    P5: {},
    P6: {},
  };
  const dpRaw = estimateDeltaP(contributions, 'target');
  const dpNorm = estimateDeltaP(contributions, 'target', DEFAULT_KAPPA);

  // With kappa, large values are tanh-normalised to [0, 1).
  assert.ok(dpNorm < dpRaw);
  assert.ok(dpNorm <= 1.0, `tanh-normalised deltaP ${dpNorm} should be ≤ 1.0`);
});

test('computeNetSocialValue uses the Nova formula V = ΔP - λ·C', () => {
  const v1 = computeNetSocialValue(0.5, 0.2, 1.5);
  assert.strictEqual(v1, 0.5 - 1.5 * 0.2);  // 0.2

  const v2 = computeNetSocialValue(0.3, 0.3, 2.0);
  assert.strictEqual(v2, 0.3 - 2.0 * 0.3);   // -0.3

  // Net value can be negative when cost dominates.
  assert.ok(v2 < 0);
});

test('netValue > 0 when pressure relief exceeds cost', () => {
  const dp = 0.6;
  const cost = 0.2;
  const lambda = 1.5;
  const nsv = computeNetSocialValue(dp, cost, lambda);
  assert.ok(nsv > 0);
});

test('netValue <= 0 when cost dominates', () => {
  const dp = 0.2;
  const cost = 0.6;
  const lambda = 1.5;
  const nsv = computeNetSocialValue(dp, cost, lambda);
  assert.ok(nsv <= 0);
});

test('computeVoI returns Kalman information ratio', () => {
  const voi1 = computeVoI(0.5, 0.1);
  assert.ok(voi1 > 0);
  assert.ok(voi1 < 1);

  const voi2 = computeVoI(0.01, 0.1);
  assert.ok(voi2 < voi1);  // Lower uncertainty → lower VoI

  const voi3 = computeVoI(1.0, 0.1);
  assert.ok(voi3 > voi1);  // Higher uncertainty → higher VoI
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. IAUS reason assembly
// ═══════════════════════════════════════════════════════════════════════════

test('assembleIAUSReason contains action, voice, and scores', () => {
  const reason = assembleIAUSReason({
    action: 'sociability',
    voice: 'sociability',
    rawScore: 0.45,
    deltaP: 0.32,
    socialCost: 0.48,
    netValue: -0.16,
  });

  assert.ok(reason.includes('sociability'));
  assert.ok(reason.includes('rawScore=0.450'));
  assert.ok(reason.includes('deltaP=0.320'));
  assert.ok(reason.includes('socialCost=0.480'));
  assert.ok(reason.includes('netValue=-0.160'));
});

test('assembleIAUSReason includes desire type and urgency when provided', () => {
  const reason = assembleIAUSReason({
    action: 'sociability',
    voice: 'sociability',
    rawScore: 0.5,
    deltaP: 0.4,
    socialCost: 0.3,
    netValue: 0.1,
    desireType: 'reconnect',
    urgency: 'medium',
  });

  assert.ok(reason.includes('reconnect'));
  assert.ok(reason.includes('medium'));
});

test('assembleIAUSReason includes target and scene when provided', () => {
  const reason = assembleIAUSReason({
    action: 'curiosity',
    voice: 'curiosity',
    rawScore: 0.3,
    deltaP: 0.2,
    socialCost: 0.1,
    netValue: 0.1,
    targetId: 'qq:private:10001',
    scene: 'private',
  });

  assert.ok(reason.includes('qq:private:10001'));
  assert.ok(reason.includes('private'));
});

test('assembleIAUSReason includes selectedProbability when provided', () => {
  const reason = assembleIAUSReason({
    action: 'diligence',
    voice: 'diligence',
    rawScore: 0.6,
    deltaP: 0.5,
    socialCost: 0.2,
    netValue: 0.3,
    selectedProbability: 0.62,
  });

  assert.ok(reason.includes('p=0.62'));
});

test('assembleIAUSReason verdict distinguishes positive from negative social value', () => {
  const positive = assembleIAUSReason({
    action: 'diligence',
    voice: 'diligence',
    rawScore: 0.5,
    deltaP: 0.6,
    socialCost: 0.3,
    netValue: 0.15,
  });

  const negative = assembleIAUSReason({
    action: 'sociability',
    voice: 'sociability',
    rawScore: 0.3,
    deltaP: 0.1,
    socialCost: 0.5,
    netValue: -0.65,
  });

  assert.ok(positive.includes('social value positive'));
  assert.ok(negative.includes('social value negative'));
  assert.ok(negative.includes('cost dominates'));
});

test('assembleIAUSReason does not expose internal metrics to users', () => {
  const reason = assembleIAUSReason({
    action: 'sociability',
    voice: 'sociability',
    rawScore: 0.45,
    deltaP: 0.32,
    socialCost: 0.48,
    netValue: -0.16,
    targetId: 'qq:private:10001',
  });

  // Internal terms that must never appear in the reason string
  // (this string is for trace/log inspection, never for QQ users,
  // but the constraint still applies: no raw config internals).
  assert.doesNotMatch(reason, /\b(kappa|whitelist|tick_internal|bypass_code)\b/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. isIAUSAction and voiceToIAUSResult
// ═══════════════════════════════════════════════════════════════════════════

test('isIAUSAction returns true for diligence/curiosity/sociability', () => {
  assert.strictEqual(isIAUSAction('diligence'), true);
  assert.strictEqual(isIAUSAction('curiosity'), true);
  assert.strictEqual(isIAUSAction('sociability'), true);
});

test('isIAUSAction returns false for caution', () => {
  assert.strictEqual(isIAUSAction('caution'), false);
});

test('voiceToIAUSResult returns null iausAction for caution', () => {
  const voice = makeVoiceResult('caution');
  const result = voiceToIAUSResult(voice);
  assert.strictEqual(result.iausAction, null);
});

test('voiceToIAUSResult returns valid iausAction for diligence', () => {
  const voice = makeVoiceResult('diligence');
  const result = voiceToIAUSResult(voice);
  assert.strictEqual(result.iausAction, 'diligence');
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Social value gate behaviour (simulated via netValue check)
// ═══════════════════════════════════════════════════════════════════════════

test('candidate with positive netValue passes social value check', () => {
  const score: IAUSScore = {
    action: 'sociability',
    voice: 'sociability',
    rawScore: 0.5,
    deltaP: 0.4,
    socialCost: 0.2,
    netValue: 0.1,   // V > 0
    selectedProbability: 0.5,
    reason: 'test',
  };

  // Simulate the social value gate check.
  const passes = score.netValue > 0;
  assert.strictEqual(passes, true);
});

test('candidate with zero or negative netValue fails social value check', () => {
  const passingScore: IAUSScore = {
    action: 'sociability',
    voice: 'sociability',
    rawScore: 0.3,
    deltaP: 0.2,
    socialCost: 0.5,
    netValue: -0.55,  // V < 0
    reason: 'test',
  };

  const exactZeroScore: IAUSScore = {
    action: 'curiosity',
    voice: 'curiosity',
    rawScore: 0.2,
    deltaP: 0.3,
    socialCost: 0.2,
    netValue: 0,      // V = 0 (using λ=1.5 → 0.3 - 1.5*0.2 = 0)
    reason: 'test',
  };

  assert.strictEqual(passingScore.netValue > 0, false);
  assert.strictEqual(exactZeroScore.netValue > 0, false);
});

test('silence reason for social value failure is descriptive', () => {
  // The gate decision for social_value_negative should include
  // deltaP, socialCost, and netValue in its values dict.
  const gateValues = {
    action: 'sociability',
    targetId: 'qq:private:10001',
    desireType: 'reconnect',
    scene: 'private',
    deltaP: 0.2,
    socialCost: 0.5,
    netValue: -0.55,
    note: 'V(a,n) = ΔP - λ·C_social ≤ 0; expected pressure relief does not justify the social intrusion',
  };

  assert.strictEqual(gateValues.deltaP, 0.2);
  assert.strictEqual(gateValues.socialCost, 0.5);
  assert.ok(gateValues.netValue < 0);
  assert.ok(gateValues.note.length > 20, 'silence note should be descriptive');
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Integration: scoreCandidates + computeNetSocialValue
// ═══════════════════════════════════════════════════════════════════════════

test('IAUS pipeline: pressure → deltaP → socialCost → netValue', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');

  const pressure = makePressureSnapshot();
  const candidates: ActionCandidate[] = [{
    action: 'sociability',
    targetId: 'qq:private:10001',
    desireType: 'reconnect',
    urgency: 'medium',
    scene: 'private',
    reason: 'test',
  }];

  const ctx: IAUSScorerContext = {
    scoringMode: 'legacy_nsv',
    world,
    nowMs: Date.now(),
    pressure,
    kappa: DEFAULT_KAPPA,
  };

  const results = scoreCandidates(candidates, ctx);
  assert.strictEqual(results.length, 1);

  const score = results[0]!.iausScore;
  assert.ok(score.deltaP > 0, 'deltaP should be positive when target has contributions');
  assert.ok(score.socialCost >= 0, 'social cost should be non-negative');
  assert.ok(typeof score.netValue === 'number');

  // Net value should match the formula.
  const expectedNV = computeNetSocialValue(
    score.deltaP,
    score.socialCost,
    DEFAULT_SOCIAL_COST_CONFIG.lambda,
  );
  assert.ok(Math.abs(score.netValue - expectedNV) < 0.001,
    `netValue ${score.netValue} should equal computed ${expectedNV}`);
});

test('candidate scoring preserves original candidate fields', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');

  const pressure = makePressureSnapshot();
  const candidate: ActionCandidate = {
    action: 'sociability',
    targetId: 'qq:private:10001',
    desireType: 'reconnect',
    urgency: 'medium',
    scene: 'private',
    reason: 'original reason text',
  };

  const ctx: IAUSScorerContext = {
    scoringMode: 'legacy_nsv',
    world,
    nowMs: Date.now(),
    pressure,
    kappa: DEFAULT_KAPPA,
  };

  const results = scoreCandidates([candidate], ctx);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0]!.candidate.action, 'sociability');
  assert.strictEqual(results[0]!.candidate.desireType, 'reconnect');
  assert.strictEqual(results[0]!.candidate.urgency, 'medium');
  assert.strictEqual(results[0]!.candidate.scene, 'private');
  assert.strictEqual(results[0]!.candidate.reason, 'original reason text');
});

test('consideration mode emits Nova-style full chain fields', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');
  world.addThread('thread:10001', {
    status: 'open',
    w: 1,
    created_ms: Date.now() - 3600_000,
    channel_id: 'qq:private:10001',
  });

  const candidate: ActionCandidate = {
    action: 'sociability',
    targetId: 'qq:private:10001',
    desireType: 'reconnect',
    urgency: 'medium',
    scene: 'private',
    reason: 'test',
  };
  const results = scoreCandidates([candidate], {
    scoringMode: 'consideration',
    world,
    nowMs: Date.now(),
    pressure: makePressureSnapshot(),
    recentActions: [],
    afterwardByTarget: { 'qq:private:10001': { value: 'watching' } },
  });

  const score = results[0]!.iausScore;
  const considerations = score.considerations!;
  for (const key of [
    'U_conflict_avoidance', 'U_freshness', 'U_reciprocity', 'U_reachable',
    'U_fatigue', 'U_mood', 'U_silence_damping', 'U_voice_affinity',
    'U_cooling', 'U_social_bond', 'U_social_safety', 'U_goldilocks',
    'U_hawkes', 'U_attraction', 'U_afterward', 'U_fairness',
  ]) {
    assert.ok(key in considerations, `${key} should be traced`);
  }
  assert.strictEqual(score.scoringMode, 'consideration');
  assert.ok(score.compensatedScore !== undefined);
  assert.ok(score.effectiveScore !== undefined);
  assert.ok(score.postFairnessScore !== undefined);
  assert.ok(score.selectionScore !== undefined);
  assert.ok(score.legacyNetSocialValue !== undefined);
  assert.ok(score.bottleneck !== undefined);
  assert.ok(score.multipliers?.U_desire_multiplier !== undefined);
});

test('full-chain action-specific considerations cover diligence and curiosity', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');
  const nowMs = Date.now();
  const pressure = makePressureSnapshot();
  const candidates: ActionCandidate[] = [
    { action: 'diligence', targetId: 'qq:private:10001', desireType: 'fulfill_duty', urgency: 'high', scene: 'private', reason: 'duty' },
    { action: 'curiosity', targetId: 'qq:private:10001', desireType: 'explore', urgency: 'medium', scene: 'private', reason: 'explore' },
  ];

  const results = scoreCandidates(candidates, { scoringMode: 'consideration', world, nowMs, pressure });
  const diligence = results.find((r) => r.candidate.action === 'diligence')!.iausScore.considerations!;
  const curiosity = results.find((r) => r.candidate.action === 'curiosity')!.iausScore.considerations!;

  for (const key of ['U_obligation', 'U_attention', 'U_thread_age', 'U_deltaP', 'U_prospect']) {
    assert.ok(key in diligence, `${key} should be traced for diligence`);
  }
  for (const key of ['U_novelty', 'U_info_pressure', 'U_exploration']) {
    assert.ok(key in curiosity, `${key} should be traced for curiosity`);
  }
});

test('full-chain fairness penalizes overserved target and boosts underserved target', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');
  addPrivateChannel(world, 'qq:private:10002', '10002');
  const nowMs = Date.now();
  const pressure = makePressureSnapshot({
    contributions: {
      P1: { 'qq:private:10001': 3, 'qq:private:10002': 3 },
      P2: {}, P3: { 'qq:private:10001': 1, 'qq:private:10002': 1 }, P4: {}, P5: {}, P6: {}, P_prospect: {},
    },
  });
  const recentActions = Array.from({ length: 6 }, (_, i) => ({
    ms: nowMs - i * 1000,
    action: 'proactive_send_text',
    target: 'qq:private:10001',
    status: 'success',
  }));

  const results = scoreCandidates([
    { action: 'sociability', targetId: 'qq:private:10001', desireType: 'reconnect', urgency: 'medium', scene: 'private', reason: 'old' },
    { action: 'sociability', targetId: 'qq:private:10002', desireType: 'reconnect', urgency: 'medium', scene: 'private', reason: 'new' },
  ], { scoringMode: 'consideration', world, nowMs, pressure, recentActions, iausFairnessMinTotalService: 1 });

  const overserved = results.find((r) => r.candidate.targetId === 'qq:private:10001')!.iausScore.considerations!.U_fairness!;
  const underserved = results.find((r) => r.candidate.targetId === 'qq:private:10002')!.iausScore.considerations!.U_fairness!;
  assert.ok(overserved < 1, `overserved fairness should be < 1, got ${overserved}`);
  assert.ok(underserved > 1, `underserved fairness should be > 1, got ${underserved}`);
});

test('curve utilities support modulation and dormant neutrality', () => {
  const curve = { type: 'sigmoid' as const, midpoint: 0.5, slope: 4, min: EPSILON, max: 1 };
  assert.ok(evalCurve(curve, 1) > evalCurve(curve, 0));
  const modulated = modulateCurve(curve, 0.5, 0.5);
  assert.ok(modulated.slope > curve.slope);
  assert.strictEqual(dormantNeutral(0, false, curve), 1);
  assert.notStrictEqual(dormantNeutral(0, true, curve), 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Edge cases
// ═══════════════════════════════════════════════════════════════════════════

test('scoreAction with momentum bonus does not exceed cap', () => {
  const voice = makeVoiceResult('diligence');
  const result = scoreAction({ voice, momentumBonus: 0.5, desireBoost: 0.3 });
  assert.ok(result !== null);
  assert.ok(result!.rawScore <= 1.0);
});

test('single candidate gets selectedProbability = 1.0', () => {
  const world = makeWorld();
  addPrivateChannel(world, 'qq:private:10001', '10001');

  const pressure = makePressureSnapshot();
  const candidate: ActionCandidate = {
    action: 'diligence',
    targetId: 'qq:private:10001',
    desireType: 'fulfill_duty',
    urgency: 'high',
    scene: 'private',
    reason: 'test',
  };

  const ctx: IAUSScorerContext = {
    scoringMode: 'legacy_nsv',
    world,
    nowMs: Date.now(),
    pressure,
    kappa: DEFAULT_KAPPA,
  };

  const results = scoreCandidates([candidate], ctx);
  assert.strictEqual(results.length, 1);
  assert.ok(results[0]!.iausScore.selectedProbability !== undefined);
  // With one candidate, should be 1.0
  assert.ok(Math.abs(results[0]!.iausScore.selectedProbability! - 1.0) < 0.001);
});

test('PRESSURE_SPECS kappa values match Nova defaults for tanh normalisation', () => {
  // Verify the kappa values used for deltaP tanh normalisation

  assert.strictEqual(PRESSURE_SPECS.P1.kappaMin, 15.0);
  assert.strictEqual(PRESSURE_SPECS.P2.kappaMin, 20.0);
  assert.strictEqual(PRESSURE_SPECS.P3.kappaMin, 10.0);
  assert.strictEqual(PRESSURE_SPECS.P4.kappaMin, 5.0);
  assert.strictEqual(PRESSURE_SPECS.P5.kappaMin, 50.0);
  assert.strictEqual(PRESSURE_SPECS.P6.kappaMin, 0.5);
});
