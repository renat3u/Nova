

import { CHAT_TYPE_WEIGHTS, DUNBAR_TIER_WEIGHT, contactIdForPrivateChannel } from '../world/constants';
import type { WorldModel } from '../world/model';
import { effectiveUnread } from './signal-decay';
import type { PressureResult } from './types';

export const CHANNEL_P1_CAP = 5.0;

export function p1AttentionDebt(world: WorldModel, nowMs: number): PressureResult {
  const contributions: Record<string, number> = {};

  for (const channelId of world.getEntitiesByType('channel')) {
    const attrs = world.getChannel(channelId);
    const unread = effectiveUnread(world, channelId, nowMs);
    if (unread <= 0) continue;

    const tierWeight = DUNBAR_TIER_WEIGHT[attrs.tier_contact] ?? 0.8;
    const chatWeight = CHAT_TYPE_WEIGHTS[attrs.chat_type].attention;
    const relevance = attrs.activity_relevance ?? 1;
    const contactId = contactIdForPrivateChannel(channelId);
    const isBot = contactId !== null && world.has(contactId) && world.getContact(contactId).is_bot === true;
    let contribution = unread * tierWeight * chatWeight * relevance * (isBot ? 0.1 : 1);
    if (attrs.chat_type === 'group') contribution = Math.min(contribution, CHANNEL_P1_CAP);
    contributions[channelId] = contribution;
  }

  return { total: sum(contributions), contributions };
}

function sum(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0);
}
