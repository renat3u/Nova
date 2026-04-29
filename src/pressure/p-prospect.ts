// Alice baseline reference: pressure model adapted for Nova QQ runtime.

import { standardSigmoid } from '../utils/math';
import type { WorldModel } from '../world/model';
import { readNodeMs } from './clock';
import type { PressureResult } from './types';

export function pProspect(world: WorldModel, _tick: number, nowMs: number, kSteepness = 5): PressureResult {
  const contributions: Record<string, number> = {};

  for (const threadId of world.getEntitiesByType('thread')) {
    const attrs = world.getThread(threadId);
    if (attrs.status !== 'open' || attrs.deadline_ms == null) continue;

    const createdMs = readNodeMs(world, threadId, 'created_ms');
    const deadlineMs = readNodeMs(world, threadId, 'deadline_ms');
    if (createdMs <= 0 || deadlineMs <= 0) continue;

    const horizonS = (deadlineMs - createdMs) / 1000;
    if (horizonS <= 0) continue;

    const remainingS = Math.max(0, (deadlineMs - nowMs) / 1000);
    const progress = 1 - remainingS / horizonS;
    contributions[threadId] = attrs.w * standardSigmoid(kSteepness * progress);
  }

  return { total: Object.values(contributions).reduce((a, b) => a + b, 0), contributions };
}
