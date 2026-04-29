// Alice baseline reference: pressure model adapted for Nova QQ runtime.

import { CHAT_TYPE_WEIGHTS, DUNBAR_TIER_WEIGHT, contactIdForPrivateChannel } from '../world/constants';
import { getActiveConversation } from '../world/queries';
import type { WorldModel } from '../world/model';
import { elapsedS, readNodeMs } from './clock';
import { getDefaultParams, queryIntensity } from './hawkes';
import { decaySignal, OBLIGATION_HALFLIFE_GROUP, OBLIGATION_HALFLIFE_PRIVATE } from './signal-decay';
import type { PressureResult } from './types';

const TURN_OBLIGATION_BOOST = 1.3;
const DIRECTED_CAP_PER_CHANNEL = 5;

export function p5ResponseObligation(world: WorldModel, _tick: number, nowMs: number): PressureResult {
  const contributions: Record<string, number> = {};

  for (const channelId of world.getEntitiesByType('channel')) {
    const attrs = world.getChannel(channelId);
    if (attrs.pending_directed <= 0) continue;

    const directed = Math.log1p(Math.min(Math.max(0, attrs.pending_directed), DIRECTED_CAP_PER_CHANNEL));
    const contactId = attrs.chat_type === 'private' ? contactIdForPrivateChannel(channelId) : null;
    const isBot = contactId !== null && world.has(contactId) && world.getContact(contactId).is_bot === true;
    const tierWeight = DUNBAR_TIER_WEIGHT[attrs.tier_contact] ?? 0.8;
    const chatWeight = CHAT_TYPE_WEIGHTS[attrs.chat_type].response;
    const lastDirectedMs = readNodeMs(world, channelId, 'last_directed_ms');
    const ageS = Math.max(elapsedS(nowMs, lastDirectedMs), 1);
    const halfLife = attrs.chat_type === 'private' ? OBLIGATION_HALFLIFE_PRIVATE : OBLIGATION_HALFLIFE_GROUP;

    let decay = decaySignal(1, ageS, halfLife);
    if (contactId && world.has(contactId)) {
      const contact = world.getContact(contactId);
      if (contact.hawkes_last_event_ms && contact.hawkes_last_event_ms > 0) {
        const params = getDefaultParams(contact.tier, attrs.chat_type === 'group');
        const intensity = queryIntensity(
          params,
          { lambdaCarry: contact.hawkes_carry, lastEventMs: contact.hawkes_last_event_ms },
          nowMs,
        );
        const modulation = Math.min(
          2,
          1 + 0.5 * Math.max(0, (intensity.lambda - params.mu) / Math.max(params.mu, 1e-10)),
        );
        decay *= modulation;
      }
    }

    let turnBoost = 1;
    const conversation = getActiveConversation(world, channelId);
    if (conversation?.turn_state === 'nova_turn') turnBoost = TURN_OBLIGATION_BOOST;

    const thinkingFactor = attrs.nova_thinking_since == null ? 1 : 0.1;
    contributions[channelId] = directed * tierWeight * chatWeight * decay * turnBoost * thinkingFactor * (isBot ? 0.1 : 1);
  }

  return { total: Object.values(contributions).reduce((a, b) => a + b, 0), contributions };
}
