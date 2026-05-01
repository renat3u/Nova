

import type { WorldModel } from '../world/model';
import { elapsedS, readNodeMs } from './clock';
import type { PressureResult } from './types';

const SECONDS_PER_DAY = 86400;
const VOLATILITY_UNIT_S = 60;

export function p2InformationPressure(world: WorldModel, _tick: number, nowMs: number, d = -0.5): PressureResult {
  const contributions: Record<string, number> = {};

  for (const factId of world.getEntitiesByType('fact')) {
    const attrs = world.getFact(factId);

    let stalenessTerm = 0;
    if (attrs.tracked) {
      const createdMs = readNodeMs(world, factId, 'created_ms');
      if (createdMs > 0) {
        stalenessTerm = attrs.volatility * (elapsedS(nowMs, createdMs) / VOLATILITY_UNIT_S);
      }
    }

    const stability = Math.max(attrs.stability, 0.1);
    const lastAccessMs = readNodeMs(world, factId, 'last_access_ms');
    const gapDays = lastAccessMs > 0 ? elapsedS(nowMs, lastAccessMs) / SECONDS_PER_DAY : 0;
    const retrievability = (1 + gapDays / (9 * stability)) ** d;
    const memoryTerm = attrs.importance * (1 - retrievability);
    const contribution = memoryTerm + stalenessTerm;
    if (contribution > 0) contributions[factId] = contribution;
  }

  return { total: Object.values(contributions).reduce((a, b) => a + b, 0), contributions };
}
