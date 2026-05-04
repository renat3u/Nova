import type { ContactAttrs, DunbarTier, RelationType } from './entities.js';

export interface RelationshipVector {
  familiarity: number;
  trust: number;
  affection: number;
  attraction: number;
  respect: number;
}

export type RVDimension = keyof RelationshipVector;

export const RV_DIMENSIONS: readonly RVDimension[] = [
  'familiarity',
  'trust',
  'affection',
  'attraction',
  'respect',
] as const;

export const INITIAL_RV: Readonly<RelationshipVector> = Object.freeze({
  familiarity: 0,
  trust: 0.3,
  affection: 0,
  attraction: 0,
  respect: 0.3,
});

export const DIMENSION_DECAY: Readonly<Record<RVDimension, number>> = Object.freeze({
  familiarity: 30 * 86400,
  trust: 60 * 86400,
  affection: 14 * 86400,
  attraction: 7 * 86400,
  respect: 45 * 86400,
});

export const RELATIONSHIP_PROTOTYPES: Readonly<Record<RelationType, RelationshipVector>> = Object.freeze({
  romantic: { familiarity: 0.9, trust: 0.8, affection: 0.9, attraction: 0.8, respect: 0.7 },
  close_friend: { familiarity: 0.9, trust: 0.9, affection: 0.7, attraction: 0.1, respect: 0.8 },
  friend: { familiarity: 0.6, trust: 0.6, affection: 0.4, attraction: 0.1, respect: 0.6 },
  family: { familiarity: 0.8, trust: 0.7, affection: 0.6, attraction: 0, respect: 0.6 },
  colleague: { familiarity: 0.4, trust: 0.4, affection: 0.1, attraction: 0, respect: 0.5 },
  acquaintance: { familiarity: 0.2, trust: 0.3, affection: 0, attraction: 0, respect: 0.3 },
  unknown: { familiarity: 0, trust: 0.3, affection: 0, attraction: 0, respect: 0.3 },
});

export const RV_VELOCITY_ALPHA = 0.05;
export const FAMILIARITY_INTERACTION_DELTA = 0.02;

export function decayDimension(value: number, halfLifeS: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || halfLifeS <= 0) return value;
  const lambda = Math.LN2 / (halfLifeS * 1000);
  return value * Math.exp(-lambda * elapsedMs);
}

export function growDimension(value: number, alpha: number, stimulus: number): number {
  if (stimulus >= 0) return Math.min(1, value + alpha * stimulus * (1 - value));
  return Math.max(0, value + alpha * stimulus * value);
}

export function updateVelocity(prevVel: number, delta: number, alpha: number): number {
  return alpha * delta + (1 - alpha) * prevVel;
}

export function deriveTier(familiarity: number): DunbarTier {
  if (familiarity >= 0.8) return 5;
  if (familiarity >= 0.6) return 15;
  if (familiarity >= 0.4) return 50;
  if (familiarity >= 0.2) return 150;
  return 500;
}

export function deriveRelationType(v: RelationshipVector): RelationType {
  let bestType: RelationType = 'unknown';
  let bestDist = Infinity;
  for (const [type, proto] of Object.entries(RELATIONSHIP_PROTOTYPES)) {
    let sumSq = 0;
    for (const dim of RV_DIMENSIONS) {
      const diff = v[dim] - proto[dim];
      sumSq += diff * diff;
    }
    if (sumSq < bestDist) {
      bestDist = sumSq;
      bestType = type as RelationType;
    }
  }
  return bestType;
}

export function readRV(attrs: Partial<ContactAttrs>): RelationshipVector {
  return {
    familiarity: attrs.rv_familiarity ?? INITIAL_RV.familiarity,
    trust: attrs.rv_trust ?? INITIAL_RV.trust,
    affection: attrs.rv_affection ?? INITIAL_RV.affection,
    attraction: attrs.rv_attraction ?? INITIAL_RV.attraction,
    respect: attrs.rv_respect ?? INITIAL_RV.respect,
  };
}

export function readVelocity(attrs: Partial<ContactAttrs>): Record<RVDimension, number> {
  return {
    familiarity: attrs.rv_familiarity_velocity ?? 0,
    trust: attrs.rv_trust_velocity ?? 0,
    affection: attrs.rv_affection_velocity ?? 0,
    attraction: attrs.rv_attraction_velocity ?? 0,
    respect: attrs.rv_respect_velocity ?? 0,
  };
}

export function vectorToContactPatch(
  v: RelationshipVector,
  velocity: Record<RVDimension, number>,
): Pick<ContactAttrs,
  | 'rv_familiarity'
  | 'rv_trust'
  | 'rv_affection'
  | 'rv_attraction'
  | 'rv_respect'
  | 'rv_familiarity_velocity'
  | 'rv_trust_velocity'
  | 'rv_affection_velocity'
  | 'rv_attraction_velocity'
  | 'rv_respect_velocity'
> {
  return {
    rv_familiarity: v.familiarity,
    rv_trust: v.trust,
    rv_affection: v.affection,
    rv_attraction: v.attraction,
    rv_respect: v.respect,
    rv_familiarity_velocity: velocity.familiarity,
    rv_trust_velocity: velocity.trust,
    rv_affection_velocity: velocity.affection,
    rv_attraction_velocity: velocity.attraction,
    rv_respect_velocity: velocity.respect,
  };
}

export function decayRelationshipVector(
  v: RelationshipVector,
  elapsedMs: number,
): RelationshipVector {
  return {
    familiarity: decayDimension(v.familiarity, DIMENSION_DECAY.familiarity, elapsedMs),
    trust: decayDimension(v.trust, DIMENSION_DECAY.trust, elapsedMs),
    affection: decayDimension(v.affection, DIMENSION_DECAY.affection, elapsedMs),
    attraction: decayDimension(v.attraction, DIMENSION_DECAY.attraction, elapsedMs),
    respect: decayDimension(v.respect, DIMENSION_DECAY.respect, elapsedMs),
  };
}

export function applyInteractionRelationshipUpdate(
  contact: Partial<ContactAttrs>,
  nowMs: number,
): ReturnType<typeof vectorToContactPatch> & { relation_type: RelationType } {
  const before = readRV(contact);
  const elapsedMs = contact.last_active_ms === undefined ? 0 : Math.max(0, nowMs - contact.last_active_ms);
  const decayed = decayRelationshipVector(before, elapsedMs);
  const next: RelationshipVector = {
    ...decayed,
    familiarity: growDimension(decayed.familiarity, FAMILIARITY_INTERACTION_DELTA, 1),
    trust: growDimension(decayed.trust, FAMILIARITY_INTERACTION_DELTA, 1),
    affection: growDimension(decayed.affection, FAMILIARITY_INTERACTION_DELTA, 1),
    respect: growDimension(decayed.respect, FAMILIARITY_INTERACTION_DELTA, 1),
  };
  const velocity = { ...readVelocity(contact) };
  for (const dim of RV_DIMENSIONS) {
    velocity[dim] = updateVelocity(velocity[dim], next[dim] - before[dim], RV_VELOCITY_ALPHA);
  }
  return {
    ...vectorToContactPatch(next, velocity),
    relation_type: deriveRelationType(next),
  };
}

export function applyNovaActionRelationshipUpdate(
  contact: ContactAttrs,
  nowMs: number,
  options: { proactive?: boolean } = {},
): ContactAttrs {
  return {
    ...contact,
    nova_initiated_count: contact.nova_initiated_count + (options.proactive ? 1 : 0),
    ...(options.proactive ? { last_proactive_outreach_ms: nowMs } : {}),
  };
}

// ── Closeness computation ────────────────────────────────────────────────────

export type ClosenessLevel = 'stranger' | 'acquaintance' | 'familiar' | 'close' | 'intimate';

/**
 * Compute a single closeness score from the relationship vector.
 * familiarity has highest weight (frequent interaction → closeness),
 * affection + trust reinforce it.
 */
export function computeCloseness(v: RelationshipVector): number {
  const raw =
    v.familiarity * 0.4 +
    v.affection * 0.25 +
    v.trust * 0.2 +
    v.respect * 0.15;
  return clamp01(raw);
}

/**
 * Classify the closeness score into a discrete level for prompt injection
 * and gate adjustments.
 */
export function classifyCloseness(closeness: number): ClosenessLevel {
  if (closeness < 0.1) return 'stranger';
  if (closeness < 0.3) return 'acquaintance';
  if (closeness < 0.55) return 'familiar';
  if (closeness < 0.8) return 'close';
  return 'intimate';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function describeRelationshipCloseness(v: RelationshipVector): string {
  const familiarity = v.familiarity;
  const warmth = Math.max(v.affection, Math.min(v.trust, v.respect));
  if (familiarity >= 0.75 && warmth >= 0.55) return '关系很熟，表达可以自然亲近一些';
  if (familiarity >= 0.5) return '已经比较熟悉，可以承接共同语境';
  if (familiarity >= 0.25) return '有些熟悉，但仍保持一点分寸';
  if (familiarity >= 0.08) return '刚有一点接触，语气轻一点';
  return '刚认识，保持自然的初识距离';
}

export function renderRelationshipFacts(
  v: RelationshipVector,
  velocity: Record<RVDimension, number>,
  displayName: string,
): string | null {
  const facts = [describeRelationshipCloseness(v)];
  const trend = velocity.familiarity;
  if (trend > 0.02) facts.push('最近互动正在变多');
  else if (trend > 0.005) facts.push('熟悉感在轻微增加');
  else if (trend < -0.02) facts.push('已经有一阵子没好好互动');

  return `${displayName}：${facts.join('；')}`;
}
