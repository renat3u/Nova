// Alice baseline reference: pressure model adapted for Nova QQ runtime.

import {
  DUNBAR_TIER_THETA,
  DUNBAR_TIER_WEIGHT,
  GROUP_PRESENCE_THETA,
  P3_BETA_R,
  P3_TAU_0,
  contactIdForPrivateChannel,
} from '../world/constants';
import { logSigmoid } from '../utils/math';
import type { WorldModel } from '../world/model';
import { elapsedS, readNodeMs } from './clock';
import type { PressureResult } from './types';

export function p3RelationshipCooling(world: WorldModel, _tick: number, nowMs: number): PressureResult {
  const contributions: Record<string, number> = {};

  for (const contactId of world.getEntitiesByType('contact')) {
    const attrs = world.getContact(contactId);
    if (attrs.is_bot === true) continue;

    const lastActiveMs = readNodeMs(world, contactId, 'last_active_ms');
    if (lastActiveMs <= 0) continue;

    const tierWeight = DUNBAR_TIER_WEIGHT[attrs.tier] ?? 0.8;
    const thetaS = DUNBAR_TIER_THETA[attrs.tier] ?? 172800;
    const silenceS = elapsedS(nowMs, lastActiveMs);
    const cooling = logSigmoid(silenceS, P3_BETA_R, thetaS, P3_TAU_0);

    let reciprocityDamping = 1;
    if (attrs.nova_initiated_count > 0) {
      const ratio = attrs.nova_initiated_count / Math.max(1, attrs.contact_initiated_count);
      if (ratio > 2) reciprocityDamping = 1 / (1 + ratio - 2);
    }

    const attraction = attrs.rv_attraction ?? 0;
    contributions[contactId] = tierWeight * cooling * reciprocityDamping * (1 + 0.5 * attraction);
  }

  const topContactContributions = Object.fromEntries(
    Object.entries(contributions).sort(([, a], [, b]) => b - a).slice(0, 8),
  );

  for (const channelId of world.getEntitiesByType('channel')) {
    const attrs = world.getChannel(channelId);
    if (attrs.chat_type !== 'group') continue;

    const lastNovaActionMs = readNodeMs(world, channelId, 'last_nova_action_ms');
    const lastActivityMs = readNodeMs(world, channelId, 'last_activity_ms');
    if (lastNovaActionMs <= 0 || lastActivityMs <= 0) continue;
    if (lastNovaActionMs >= lastActivityMs) continue;
    if (attrs.nova_thinking_since != null) continue;

    const tierWeight = DUNBAR_TIER_WEIGHT[attrs.tier_contact] ?? 0.8;
    const thetaS = GROUP_PRESENCE_THETA[attrs.tier_contact] ?? 28800;
    const cooling = logSigmoid(elapsedS(nowMs, lastNovaActionMs), P3_BETA_R, thetaS, P3_TAU_0);
    topContactContributions[channelId] = tierWeight * cooling * 0.5;
  }

  for (const channelId of world.getEntitiesByType('channel')) {
    const attrs = world.getChannel(channelId);
    if (attrs.chat_type !== 'private') continue;
    const contactId = contactIdForPrivateChannel(channelId);
    if (!contactId || !world.has(contactId)) continue;
    const lastNovaActionMs = readNodeMs(world, channelId, 'last_nova_action_ms');
    const contactLastMs = readNodeMs(world, contactId, 'last_active_ms');
    if (lastNovaActionMs > contactLastMs && lastNovaActionMs > 0) delete topContactContributions[contactId];
  }

  return {
    total: Object.values(topContactContributions).reduce((sum, value) => sum + value, 0),
    contributions: topContactContributions,
  };
}
