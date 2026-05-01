

import type { WorldModel } from '../world/model';

export function readNodeMs(world: WorldModel, nodeId: string, msKey: string): number {
  const value = world.getDynamic(nodeId, msKey);
  return typeof value === 'number' && value > 0 ? value : 0;
}

export function elapsedS(nowMs: number, eventMs: number): number {
  return Math.max(0, (nowMs - eventMs) / 1000);
}
