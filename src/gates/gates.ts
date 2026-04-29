import type { NovaMessageEvent, NovaRuntimeConfig, SilenceLevel } from '../core/types';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { VoiceSelectionResult } from '../voices/selection';
import type { ChannelAttrs, ConversationAttrs } from '../world/entities';
import { evaluateGroupPolicy } from './group-policy';
import type { RateLimitState } from './rate-limit';

export interface GateContext {
  nowMs: number;
  reason: 'message' | 'scheduled';
  event?: NovaMessageEvent;
  pressure: PressureSnapshot;
  voice: VoiceSelectionResult;
  conversation?: ConversationAttrs;
  channel?: ChannelAttrs;
  config: NovaRuntimeConfig;
  rateLimit: RateLimitState;
}

export interface GateDecision {
  allow: boolean;
  level: SilenceLevel;
  reason: string;
  reasons: string[];
  values: Record<string, unknown>;
}

export function evaluateGates(context: GateContext): GateDecision {
  const reasons: string[] = [];
  const values: Record<string, unknown> = {};
  const directed = context.event?.isDirected === true;

  const hardDecision = evaluateHardGates(context, reasons, values);
  if (hardDecision) return hardDecision;

  const conservativeDecisions: GateDecision[] = [];
  const cooling = evaluateActiveCooling(context);
  if (cooling) conservativeDecisions.push(cooling);

  const groupPolicy = evaluateGroupPolicy({ event: context.event, channel: context.channel, config: context.config });
  if (groupPolicy) {
    conservativeDecisions.push({
      allow: false,
      level: groupPolicy.level,
      reason: groupPolicy.reason,
      reasons: [groupPolicy.reason],
      values: groupPolicy.values,
    });
  }

  const apiFloor = evaluateApiFloor(context);
  if (apiFloor) conservativeDecisions.push(apiFloor);

  const conversation = evaluateConversationAware(context);
  if (conversation) conservativeDecisions.push(conversation);

  const closing = evaluateClosingConversation(context);
  if (closing) conservativeDecisions.push(closing);

  if (directed && conservativeDecisions.length > 0) {
    return allowDecision('directed_bypass', {
      bypassedReasons: conservativeDecisions.map((decision) => decision.reason),
      directed,
      api: context.pressure.api,
    });
  }

  if (conservativeDecisions.length > 0) {
    return mergeSilenceDecisions(conservativeDecisions);
  }

  return allowDecision('allowed', {
    directed,
    api: context.pressure.api,
    selectedVoice: context.voice.selected,
  });
}

function evaluateHardGates(
  context: GateContext,
  reasons: string[],
  values: Record<string, unknown>,
): GateDecision | null {
  if (!context.config.enabled) return silence('hard', 'runtime_disabled', reasons, values);

  const event = context.event;
  if (event) {
    if (event.text.trim().length === 0) return silence('safety', 'empty_text', reasons, values);
    if (event.chatType === 'private' && !context.config.enablePrivateChat) return silence('hard', 'private_chat_disabled', reasons, values);
    if (event.chatType === 'group') {
      if (!context.config.enableGroupChat) return silence('hard', 'group_chat_disabled', reasons, values);
      if (!event.groupId) return silence('safety', 'missing_group_id', reasons, values);
      if (context.config.enabledGroups[event.groupId]?.enabled === false) {
        return silence('hard', 'group_disabled', reasons, values);
      }
    }
  }

  if (context.reason === 'scheduled' && !context.config.enableScheduledActions) {
    return silence('normal', 'scheduled_actions_disabled', reasons, values);
  }

  const flood = context.rateLimit.checkFlood(context.nowMs, event, context.config);
  Object.assign(values, flood.values);
  if (!flood.safe) return silence('safety', flood.reason ?? 'flood_safety', reasons, values);

  const rate = context.rateLimit.checkRateLimit(context.nowMs, event, context.config);
  Object.assign(values, rate.values);
  if (!rate.allowed) return silence('hard', rate.reason ?? 'rate_cap', reasons, values);

  return null;
}

function evaluateActiveCooling(context: GateContext): GateDecision | null {
  const lastActionMs = context.channel?.last_nova_action_ms;
  if (lastActionMs === undefined) return null;

  const chatType = context.event?.chatType ?? context.channel?.chat_type ?? 'private';
  const cooldownMs = chatType === 'group' ? context.config.groupCooldownMs : context.config.privateCooldownMs;
  const elapsedMs = context.nowMs - lastActionMs;
  if (elapsedMs >= cooldownMs) return null;

  return silence('hard', 'active_cooling', [], {
    elapsedMs,
    cooldownMs,
    lastNovaActionMs: lastActionMs,
  });
}

function evaluateApiFloor(context: GateContext): GateDecision | null {
  const directed = context.event?.isDirected === true;
  const floor = directed ? context.config.directedMinApiToSpeak : context.config.minApiToSpeak;
  if (context.pressure.api >= floor) return null;

  return silence('soft', 'api_floor', [], {
    api: context.pressure.api,
    floor,
    directed,
  });
}

function evaluateConversationAware(context: GateContext): GateDecision | null {
  const conversation = context.conversation;
  if (!conversation) return null;
  if (conversation.state !== 'cooldown') return null;

  return silence('normal', 'conversation_cooldown', [], {
    conversationId: conversation.id,
    state: conversation.state,
    turnState: conversation.turn_state,
  });
}

function evaluateClosingConversation(context: GateContext): GateDecision | null {
  const conversation = context.conversation;
  if (!conversation || conversation.state !== 'closing') return null;

  const lastDirectedMs = context.channel?.last_directed_ms ?? 0;
  const closingSinceMs = conversation.closing_since_ms ?? conversation.last_activity_ms;
  if (context.event?.isDirected === true && lastDirectedMs > closingSinceMs) return null;

  return silence('hard', 'closing_conversation', [], {
    conversationId: conversation.id,
    closingSinceMs,
    lastDirectedMs,
  });
}

function mergeSilenceDecisions(decisions: GateDecision[]): GateDecision {
  const level = strongestLevel(decisions.map((decision) => decision.level));
  return {
    allow: false,
    level,
    reason: decisions[0]?.reason ?? 'silence',
    reasons: decisions.flatMap((decision) => decision.reasons),
    values: Object.assign({}, ...decisions.map((decision) => decision.values)),
  };
}

function allowDecision(reason: string, values: Record<string, unknown>): GateDecision {
  return {
    allow: true,
    level: 'none',
    reason,
    reasons: [reason],
    values,
  };
}

function silence(
  level: Exclude<SilenceLevel, 'none'>,
  reason: string,
  existingReasons: string[],
  values: Record<string, unknown>,
): GateDecision {
  return {
    allow: false,
    level,
    reason,
    reasons: [...existingReasons, reason],
    values: { ...values },
  };
}

function strongestLevel(levels: SilenceLevel[]): SilenceLevel {
  const rank: Record<SilenceLevel, number> = { none: 0, soft: 1, normal: 2, hard: 3, safety: 4 };
  let best: SilenceLevel = 'none';
  for (const level of levels) if (rank[level] > rank[best]) best = level;
  return best;
}
