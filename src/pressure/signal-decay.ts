// Alice baseline reference: pressure model adapted for Nova QQ runtime.

import type { WorldModel } from '../world/model';
import { readNodeMs } from './clock';

export const OBLIGATION_HALFLIFE_PRIVATE = 3600;
export const OBLIGATION_HALFLIFE_GROUP = 3600;
export const UNREAD_FRESHNESS_HALFLIFE_S = 3600;
const KAPPA_TONIC = 1.0;

export function decaySignal(value: number, ageS: number, halfLifeS: number, neutral = 0): number {
  if (ageS <= 0) return value;
  return neutral + (value - neutral) * 2 ** (-ageS / halfLifeS);
}

export function effectiveUnread(world: WorldModel, channelId: string, nowMs: number): number {
  if (!world.has(channelId)) return 0;
  const attrs = world.getChannel(channelId);
  if (attrs.unread <= 0) return 0;

  const lastActivityMs = readNodeMs(world, channelId, 'last_activity_ms');
  const ageS = lastActivityMs > 0 ? Math.max(0, (nowMs - lastActivityMs) / 1000) : 0;
  const phasic = attrs.unread * decaySignal(1, ageS, UNREAD_FRESHNESS_HALFLIFE_S);
  const tonic = KAPPA_TONIC * Math.log1p(attrs.unread);
  return Math.max(phasic, tonic);
}
