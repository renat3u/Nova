

import {
  DUNBAR_TIER_THETA,
  DUNBAR_TIER_WEIGHT,
  GROUP_PRESENCE_THETA,
  K_ABSENCE_ROUNDS,
  P3_BETA_R,
  P3_TAU_0,
  TRAJECTORY_THETA_MAX_S,
  TRAJECTORY_THETA_MIN_S,
  tierBiasCorrection,
} from '../world/constants';
import { logSigmoid } from '../utils/math';
import type { WorldModel } from '../world/model';
import { elapsedS, readNodeMs } from './clock';
import type { PressureResult } from './types';

export const MU_ATTRACTION_THETA = 0.3;
export const KAPPA_ATTRACTION_P3 = 0.5;
export const P3_TOP_K = 8;

export function p3RelationshipCooling(
  world: WorldModel,
  _tick: number,
  nowMs: number,
  channelRateEma?: Map<string, { ema: number; variance: number }>,
  tickDt?: number,
): PressureResult {
  const contributions: Record<string, number> = {};

  for (const contactId of world.getEntitiesByType('contact')) {
    const attrs = world.getContact(contactId);
    if (attrs.is_bot === true) continue;

    const lastActiveMs = readNodeMs(world, contactId, 'last_active_ms');
    if (lastActiveMs <= 0) continue;

    const privateChannelId = `qq:private:${attrs.qq}`;
    if (world.has(privateChannelId) && world.getNodeType(privateChannelId) === 'channel') {
      const channel = world.getChannel(privateChannelId);
      if (channel.chat_type !== 'private') continue;
      const lastNovaActionMs = readNodeMs(world, privateChannelId, 'last_nova_action_ms');
      if (lastNovaActionMs > lastActiveMs && lastNovaActionMs > 0) continue;
      if (channel.nova_thinking_since != null) continue;
    }

    const effectiveTier = tierBiasCorrection(attrs.tier, undefined);
    const tierWeight = DUNBAR_TIER_WEIGHT[effectiveTier] ?? 0.8;
    const thetaS = DUNBAR_TIER_THETA[effectiveTier] ?? 172800;
    const attraction = attrs.rv_attraction ?? 0;
    const thetaEffective = thetaS * (1 - MU_ATTRACTION_THETA * attraction);
    const silenceS = elapsedS(nowMs, lastActiveMs);
    const cooling = logSigmoid(silenceS, P3_BETA_R, thetaEffective, P3_TAU_0);

    let reciprocityDamping = 1;
    if (attrs.nova_initiated_count > 0) {
      const ratio = attrs.nova_initiated_count / Math.max(1, attrs.contact_initiated_count);
      if (ratio > 2) reciprocityDamping = 1 / (1 + ratio - 2);
    }

    contributions[contactId] = tierWeight * cooling * reciprocityDamping * (1 + KAPPA_ATTRACTION_P3 * attraction);
  }

  const pressureContributions = Object.fromEntries(
    Object.entries(contributions).sort(([, a], [, b]) => b - a).slice(0, P3_TOP_K),
  );

  for (const channelId of world.getEntitiesByType('channel')) {
    const attrs = world.getChannel(channelId);
    if (attrs.chat_type !== 'group') continue;

    const lastNovaActionMs = readNodeMs(world, channelId, 'last_nova_action_ms');
    const lastActivityMs = readNodeMs(world, channelId, 'last_activity_ms');
    if (lastNovaActionMs <= 0 || lastActivityMs <= 0) continue;
    if (lastNovaActionMs > lastActivityMs && lastNovaActionMs > 0) continue;
    if (attrs.nova_thinking_since != null) continue;

    const tierWeight = DUNBAR_TIER_WEIGHT[attrs.tier_contact] ?? 0.8;
    const thetaS = groupPresenceTheta(channelId, attrs.tier_contact, channelRateEma, tickDt);
    const cooling = logSigmoid(elapsedS(nowMs, lastNovaActionMs), P3_BETA_R, thetaS, P3_TAU_0);
    pressureContributions[channelId] = tierWeight * cooling;
  }

  return {
    total: Object.values(pressureContributions).reduce((sum, value) => sum + value, 0),
    contributions: pressureContributions,
  };
}

function groupPresenceTheta(
  channelId: string,
  tier: keyof typeof GROUP_PRESENCE_THETA,
  channelRateEma: Map<string, { ema: number; variance: number }> | undefined,
  tickDt: number | undefined,
): number {
  const stats = channelRateEma?.get(channelId);
  const effectiveDt = tickDt && tickDt > 0 ? tickDt : 60;
  if (stats && stats.ema >= 0.001) {
    const msgsPerS = stats.ema / effectiveDt;
    const avgIntervalS = 1 / msgsPerS;
    return Math.max(TRAJECTORY_THETA_MIN_S, Math.min(K_ABSENCE_ROUNDS * avgIntervalS, TRAJECTORY_THETA_MAX_S));
  }
  return GROUP_PRESENCE_THETA[tier] ?? 14400;
}
