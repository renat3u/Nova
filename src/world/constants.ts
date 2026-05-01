import type { DunbarTier, EdgeCategory } from './entities';

export const NOVA_SELF_ID = 'qq:self:nova';
export const DEFAULT_PRIVATE_TIER: DunbarTier = 50;
export const DEFAULT_GROUP_TIER: DunbarTier = 150;
export const WORKING_MEMORY_SLOTS = 7;

export const DUNBAR_TIER_WEIGHT: Record<DunbarTier, number> = {
  5: 5.0,
  15: 3.0,
  50: 1.5,
  150: 0.8,
  500: 0.3,
};

export const DUNBAR_TIER_THETA: Record<DunbarTier, number> = {
  5: 7200,
  15: 14400,
  50: 43200,
  150: 172800,
  500: 604800,
};

export const GROUP_PRESENCE_THETA: Record<DunbarTier, number> = {
  5: 1800,
  15: 3600,
  50: 7200,
  150: 14400,
  500: 43200,
};

export const PERIPHERAL_TIER_WINDOW_S: Record<DunbarTier, number> = {
  5: 86400,
  15: 43200,
  50: 21600,
  150: 7200,
  500: 0,
};

export const P3_TAU_0 = 600;
export const P3_BETA_R = 2.5;
export const K_ABSENCE_ROUNDS = 10;
export const TRAJECTORY_THETA_MIN_S = 1800;
export const TRAJECTORY_THETA_MAX_S = 604800;

export const EDGE_CATEGORY_WEIGHT: Record<EdgeCategory, number> = {
  spatial: 0.5,
  social: 1.0,
  cognitive: 0.3,
  causal: 0.8,
  ownership: 0.6,
};

export const PROPAGATION_WEIGHT = EDGE_CATEGORY_WEIGHT;

export const CHAT_TYPE_WEIGHTS: Record<'private' | 'group', { attention: number; response: number }> = {
  private: { attention: 3.0, response: 2.0 },
  group: { attention: 1.0, response: 1.0 },
};

export interface PressureDimensionSpec {
  kappaMin: number;
  typicalScale: number;
}

export const PRESSURE_SPECS: Record<'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6', PressureDimensionSpec> = {
  P1: { kappaMin: 15.0, typicalScale: 200 },
  P2: { kappaMin: 20.0, typicalScale: 50 },
  P3: { kappaMin: 10.0, typicalScale: 8 },
  P4: { kappaMin: 5.0, typicalScale: 10 },
  P5: { kappaMin: 50.0, typicalScale: 50 },
  P6: { kappaMin: 0.5, typicalScale: 0.6 },
};

export const DEFAULT_KAPPA: [number, number, number, number, number, number] = [
  PRESSURE_SPECS.P1.kappaMin,
  PRESSURE_SPECS.P2.kappaMin,
  PRESSURE_SPECS.P3.kappaMin,
  PRESSURE_SPECS.P4.kappaMin,
  PRESSURE_SPECS.P5.kappaMin,
  PRESSURE_SPECS.P6.kappaMin,
];

export function tierBiasCorrection(tier: DunbarTier, sigma2: number | undefined): DunbarTier {
  if (sigma2 === undefined || sigma2 <= 0.3) return tier;
  const baseline = 150;
  const regression = Math.min(sigma2, 0.8);
  const effectiveTier = tier + (baseline - tier) * regression;
  return nearestTier(effectiveTier);
}

export function nearestTier(value: number): DunbarTier {
  const tiers: DunbarTier[] = [5, 15, 50, 150, 500];
  let best: DunbarTier = 150;
  let bestDist = Infinity;
  for (const tier of tiers) {
    const dist = Math.abs(value - tier);
    if (dist < bestDist) {
      best = tier;
      bestDist = dist;
    }
  }
  return best;
}

export function conversationIdForChannel(channelId: string): string {
  return `qq:conversation:${channelId}`;
}

export function defaultTierForChat(chatType: 'private' | 'group'): DunbarTier {
  return chatType === 'private' ? DEFAULT_PRIVATE_TIER : DEFAULT_GROUP_TIER;
}

export function qqIdFromNodeId(nodeId: string): string {
  const parts = nodeId.split(':');
  return parts[parts.length - 1] ?? nodeId;
}

export function contactIdForPrivateChannel(channelId: string): string | null {
  if (!channelId.startsWith('qq:private:')) return null;
  return `qq:user:${channelId.slice('qq:private:'.length)}`;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function edgeKey(src: string, dst: string, category: EdgeCategory): string {
  return `${src}\u0000${dst}\u0000${category}`;
}

export function makeId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}:${Date.now().toString(36)}:${random}`;
}
