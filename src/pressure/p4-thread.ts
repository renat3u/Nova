// Alice baseline reference: pressure model adapted for Nova QQ runtime.

import type { WorldModel } from '../world/model';
import { elapsedS, readNodeMs } from './clock';
import type { PressureResult } from './types';

export function p4ThreadDivergence(
  world: WorldModel,
  _tick: number,
  nowMs: number,
  threadAgeScale = 86400,
): PressureResult {
  const contributions: Record<string, number> = {};

  for (const threadId of world.getEntitiesByType('thread')) {
    const attrs = world.getThread(threadId);
    if (attrs.status !== 'open') continue;

    const createdMs = readNodeMs(world, threadId, 'created_ms');
    if (createdMs <= 0) continue;

    const ageS = Math.max(elapsedS(nowMs, createdMs), 1);
    const maxAgeS = threadAgeScale * 7;
    const decayFactor = ageS > maxAgeS ? Math.exp(-(ageS - maxAgeS) / maxAgeS) : 1;
    contributions[threadId] = Math.log1p(ageS / threadAgeScale) * attrs.w * decayFactor;
  }

  return { total: Object.values(contributions).reduce((a, b) => a + b, 0), contributions };
}
