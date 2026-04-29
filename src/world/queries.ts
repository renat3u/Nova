import type { ChannelAttrs, ContactAttrs, ConversationAttrs, FactAttrs } from './entities';
import type { WorldModel } from './model';

export function getActiveConversation(world: WorldModel, channelId: string): ConversationAttrs | undefined {
  for (const id of world.getEntitiesByType('conversation')) {
    const conversation = world.getConversation(id);
    if (conversation.channel_id === channelId && conversation.state === 'active') return conversation;
  }
  return undefined;
}

export function getChannelContact(world: WorldModel, channelId: string): ContactAttrs | undefined {
  const edge = world.allEdges().find((candidate) => (
    candidate.category === 'social'
    && candidate.dst === channelId
    && world.getNodeType(candidate.src) === 'contact'
  ));
  return edge ? world.getContact(edge.src) : undefined;
}

export function getTrackedFacts(world: WorldModel): FactAttrs[] {
  return world.getEntitiesByType('fact')
    .map((id) => world.getFact(id))
    .filter((fact) => fact.tracked);
}

export function getChannelsByActivity(world: WorldModel, limit: number): ChannelAttrs[] {
  return world.getEntitiesByType('channel')
    .map((id) => world.getChannel(id))
    .sort((a, b) => b.last_activity_ms - a.last_activity_ms)
    .slice(0, Math.max(0, limit));
}
