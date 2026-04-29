import { DUNBAR_TIER_WEIGHT } from './constants';
import type { DunbarTier } from './entities';

export interface TensionValue {
  value: number;
  reason: string;
}

export function tierWeight(tier: DunbarTier): number {
  return DUNBAR_TIER_WEIGHT[tier] ?? DUNBAR_TIER_WEIGHT[150];
}

export function combineTension(values: TensionValue[]): number {
  return values.reduce((sum, item) => sum + Math.max(0, item.value), 0);
}
