
//
// Phase 2 Step 09: Silence gate expansion.
//
// Nova's gate system evaluates whether the agent should speak or remain silent
// at each tick (message-driven or scheduled).  It combines:
//

//   - Nova platform gates: proactive enabled, QQ whitelist, group policy, QQ risk,
//     engagement state.
//
// Gate strength ordering:
//   message reply < proactive private < proactive group
//
// Directed messages (private, @Nova, reply-to-Nova) use a lower barrier;
// proactive actions face stricter checks and cannot use directed bypass.

import type { NovaMessageEvent, NovaRuntimeConfig, SilenceLevel } from '../core/types';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { VoiceSelectionResult } from '../voices/selection';
import type { ChannelAttrs, ConversationAttrs } from '../world/entities';
import { evaluateGroupPolicy } from './group-policy';
import type { RateLimitState } from './rate-limit';
import type { GroupProfile } from '../relationships/types';
import type { ActionQueue } from '../act/action-queue';

// ── Unified silence reasons ─────────────────────────────────────────────────
// Standardised across all gates so silence logs and traces carry consistent,
// machine-readable reason strings.

export const SILENCE_REASONS = {
  // Hard / safety gates
  RUNTIME_DISABLED: 'runtime_disabled',
  EMPTY_TEXT: 'empty_text',
  PRIVATE_CHAT_DISABLED: 'private_chat_disabled',
  GROUP_CHAT_DISABLED: 'group_chat_disabled',
  MISSING_GROUP_ID: 'missing_group_id',
  GROUP_DISABLED: 'group_disabled',
  SCHEDULED_ACTIONS_DISABLED: 'scheduled_actions_disabled',

  // QQ risk (flood / rate / failure)
  FLOOD_SAFETY: 'flood_safety',
  CHANNEL_FLOOD: 'channel_flood',
  USER_FLOOD: 'user_flood',
  SEND_FAILURE_RISK: 'send_failure_risk',
  RATE_CAP: 'rate_cap',
  GLOBAL_RATE_CAP: 'global_rate_cap',
  CHANNEL_RATE_CAP: 'channel_rate_cap',
  GROUP_RATE_CAP: 'group_rate_cap',

  // Conservative gates
  ACTIVE_COOLING: 'active_cooling',
  API_FLOOR: 'api_floor',
  CONVERSATION_COOLDOWN: 'conversation_cooldown',
  CLOSING_CONVERSATION: 'closing_conversation',

  // Caution voice
  CAUTION_SCHEDULED_SILENCE: 'caution_scheduled_silence',
  CAUTION_GROUP_OBSERVE: 'caution_group_observe',
  CAUTION_GROUP_PROACTIVE_SILENCE: 'caution_group_proactive_silence',

  // Group policy
  GROUP_OBSERVE_ONLY: 'group_observe_only',
  GROUP_HIGH_RISK: 'group_high_risk',
  GROUP_INACTIVE: 'group_inactive',
  GROUP_PROACTIVE_WHITELIST_CONTEXT_MISSING: 'group_proactive_whitelist_context_missing',

  // Proactive / whitelist
  PROACTIVE_DISABLED: 'proactive_disabled',
  PROACTIVE_WHITELIST_EMPTY: 'proactive_whitelist_empty',
  PROACTIVE_WHITELIST_DENIED: 'proactive_whitelist_denied',

  // Social value
  SOCIAL_VALUE_NEGATIVE: 'social_value_negative',

  // Engagement
  ENGAGEMENT_WAITING: 'engagement_waiting',

  // Proactive target cooldown (Step 16)
  PROACTIVE_TARGET_COOLDOWN: 'proactive_target_cooldown',
  PROACTIVE_TARGET_GROUP_COOLDOWN: 'proactive_target_group_cooldown',

  // Queue cleared (Step 16)
  QUEUE_CLEARED_FAILURE_LIMIT: 'queue_cleared_failure_limit',

  // Explore (Step 15)
  EXPLORE_COOLDOWN: 'explore_cooldown',
  EXPLORE_UNREPLIED_COOLDOWN: 'explore_unreplied_cooldown',
  EXPLORE_DAILY_CAP: 'explore_daily_cap_reached',
  EXPLORE_ENGAGEMENT_PENDING: 'explore_engagement_pending',
  EXPLORE_INTERROGATION_DETECTED: 'explore_interrogation_detected',

  // Afterward scheduling (todo2 Step 2)
  AFTERWARD_WAITING_REPLY: 'afterward_waiting_reply',
  AFTERWARD_WATCHING: 'afterward_watching',
  AFTERWARD_COOLING_DOWN: 'afterward_cooling_down',

  // Decision agent
  DECISION_SILENCE: 'decision_silence',
  DECISION_OBSERVE: 'decision_observe',
  DECISION_WAIT_REPLY: 'decision_wait_reply',
  DECISION_COOL_DOWN: 'decision_cool_down',
  DECISION_AGENT_FAILED: 'decision_agent_failed',
  DECISION_GUARDRAIL_DENIED: 'decision_guardrail_denied',
  DECISION_INVALID_RESPONSE: 'decision_invalid_response',

  // Meta
  DIRECTED_BYPASS: 'directed_bypass',
  ALLOWED: 'allowed',
  NO_DESIRES: 'no_desires',
  NO_QUALIFIED_DESIRES: 'no_qualified_desires',
  ALL_CANDIDATES_DENIED: 'all_candidates_denied',
} as const;

export type SilenceReason = (typeof SILENCE_REASONS)[keyof typeof SILENCE_REASONS];

// ── Gate context ────────────────────────────────────────────────────────────

export interface GateContext {
  nowMs: number;
  reason: 'message' | 'scheduled';
  event?: NovaMessageEvent;
  pressure: PressureSnapshot;
  voice: VoiceSelectionResult;
  conversation?: ConversationAttrs;
  channel?: ChannelAttrs;
  groupProfile?: GroupProfile | null;
  config: NovaRuntimeConfig;
  rateLimit: RateLimitState;
  actionQueue?: ActionQueue;

  lambdaMultiplier: number;
}

export type GateVerdict =
  | { type: 'act'; reason: string; values: Record<string, unknown> }
  | { type: 'silent'; level: SilenceLevel; reason: string; values: Record<string, unknown> }
  | { type: 'pass' };

export interface GateDecision {
  allow: boolean;
  level: SilenceLevel;
  reason: string;
  reasons: string[];
  values: Record<string, unknown>;
}

// ── Chain runner ────────────────────────────────────────────────────────────

export function evaluateHardGates(
  context: GateContext,
  reasons: string[],
  values: Record<string, unknown>,
): GateDecision | null {
  if (!context.config.enabled) {
    return silence('hard', SILENCE_REASONS.RUNTIME_DISABLED, reasons, values);
  }

  const event = context.event;
  if (event) {
    if (event.text.trim().length === 0) {
      return silence('safety', SILENCE_REASONS.EMPTY_TEXT, reasons, values);
    }
    if (event.chatType === 'private' && !context.config.enablePrivateChat) {
      return silence('hard', SILENCE_REASONS.PRIVATE_CHAT_DISABLED, reasons, values);
    }
    if (event.chatType === 'group') {
      if (!context.config.enableGroupChat) {
        return silence('hard', SILENCE_REASONS.GROUP_CHAT_DISABLED, reasons, values);
      }
      if (!event.groupId) {
        return silence('safety', SILENCE_REASONS.MISSING_GROUP_ID, reasons, values);
      }
      if (context.config.enabledGroups[event.groupId]?.enabled === false) {
        return silence('hard', SILENCE_REASONS.GROUP_DISABLED, reasons, values);
      }
    }
  }

  if (context.reason === 'scheduled' && !context.config.enableScheduledActions) {
    return silence('normal', SILENCE_REASONS.SCHEDULED_ACTIONS_DISABLED, reasons, values);
  }

  // Unified QQ risk gate: flood → rate → failure backoff.
  const qqRisk = evaluateQQRisk(context);
  if (!qqRisk.pass) {
    Object.assign(values, qqRisk.values);
    return silence(qqRisk.level, qqRisk.reason, reasons, values);
  }
  Object.assign(values, qqRisk.values);

  return null;
}

/**
 * Evaluate QQ risk: flood detection, rate limiting, and send failure backoff.
 * Returns a pass/fail result with level and reason.
 */
export function evaluateQQRisk(context: GateContext): {
  pass: boolean;
  level: SilenceLevel;
  reason: string;
  values: Record<string, unknown>;
} {
  const { rateLimit, config, nowMs, event } = context;

  // 1. Send failure backoff.
  if (rateLimit.hasFailureBackoff(config)) {
    return {
      pass: false,
      level: 'safety',
      reason: SILENCE_REASONS.SEND_FAILURE_RISK,
      values: {
        consecutiveFailures: rateLimit.failureCount,
        failureLimit: config.consecutiveSendFailureLimit,
      },
    };
  }

  // 2. Flood detection.
  const floodCheck = rateLimit.checkFlood(nowMs, event, config);
  if (!floodCheck.safe) {
    const reason = floodCheck.reason === 'send_failure_risk'
      ? SILENCE_REASONS.SEND_FAILURE_RISK
      : floodCheck.reason === 'channel_flood'
        ? SILENCE_REASONS.CHANNEL_FLOOD
        : floodCheck.reason === 'user_flood'
          ? SILENCE_REASONS.USER_FLOOD
          : SILENCE_REASONS.FLOOD_SAFETY;
    return {
      pass: false,
      level: reason === SILENCE_REASONS.SEND_FAILURE_RISK ? 'safety' : 'safety',
      reason,
      values: floodCheck.values as Record<string, unknown>,
    };
  }

  // 3. Rate limit check.
  const rateCheck = rateLimit.checkRateLimit(nowMs, event, config);
  if (!rateCheck.allowed) {
    const reason = rateCheck.reason === 'global_rate_cap'
      ? SILENCE_REASONS.GLOBAL_RATE_CAP
      : rateCheck.reason === 'channel_rate_cap'
        ? SILENCE_REASONS.CHANNEL_RATE_CAP
        : SILENCE_REASONS.GROUP_RATE_CAP;
    return {
      pass: false,
      level: 'hard',
      reason,
      values: rateCheck.values as Record<string, unknown>,
    };
  }

  return { pass: true, level: 'none', reason: '', values: {} };
}

/**
 * Run the full gate chain for a tick and return a single GateDecision.
 * This is the main entry point for gate evaluation used by message ticks.
 */
export function evaluateGates(context: GateContext): GateDecision {
  const reasons: string[] = [];
  const values: Record<string, unknown> = {};

  // Hard gates
  const hardResult = evaluateHardGates(context, reasons, values);
  if (hardResult) return hardResult;

  // Conversation-aware modulation
  const convAware = evaluateConversationAware(context);
  if (convAware.block) {
    return silence('hard', convAware.blockReason ?? SILENCE_REASONS.CONVERSATION_COOLDOWN, reasons, values);
  }

  // Closing conversation
  const closingResult = evaluateClosingConversation(context);
  if (closingResult) return closingResult;

  // Caution voice gate
  const cautionResult = evaluateCautionGate(context);
  if (cautionResult) return cautionResult;

  // Engagement state
  if (context.event?.chatId) {
    const engagementResult = evaluateEngagementState(context.event.chatId, context);
    if (engagementResult) return engagementResult;
  }

  // API floor
  const apiFloorResult = evaluateApiFloor(context);
  if (apiFloorResult) return apiFloorResult;

  // Active cooling (per-channel)
  if (context.channel) {
    const coolingResult = evaluateActiveCooling(context);
    if (coolingResult) return coolingResult;
  }

  // All passed
  return allowDecision(SILENCE_REASONS.ALLOWED, values);
}

/**
 * API floor gate: block if aggregate pressure is below minimum.
 */
export function evaluateApiFloor(context: GateContext): GateDecision | null {
  const isDirected = context.event?.isDirected === true;
  const floor = isDirected
    ? (context.config.directedMinApiToSpeak ?? context.config.minApiToSpeak)
    : context.config.minApiToSpeak;

  if (context.pressure.api < floor) {
    return silence('soft', SILENCE_REASONS.API_FLOOR, [], {
      api: context.pressure.api,
      floor,
      directed: isDirected,
    });
  }
  return null;
}

/**
 * Per-channel active cooling gate.
 */
export function evaluateActiveCooling(context: GateContext): GateDecision | null {
  const channel = context.channel;
  if (!channel) return null;

  const lastActionMs = channel.last_nova_action_ms;
  if (lastActionMs === undefined || lastActionMs === 0) return null;

  const chatType = channel.chat_type;
  const cooldownMs = chatType === 'group'
    ? context.config.groupCooldownMs
    : context.config.privateCooldownMs;
  const elapsedMs = context.nowMs - lastActionMs;

  if (elapsedMs >= cooldownMs) return null;

  return silence('hard', SILENCE_REASONS.ACTIVE_COOLING, [], {
    elapsedMs,
    cooldownMs,
    lastNovaActionMs: lastActionMs,
    chatType,
  });
}

/**
 * Run a chain of gate functions, returning the first non-pass verdict.
 */
export function runGateChain(
  gates: Array<(context: GateContext) => GateVerdict>,
  context: GateContext,
): GateVerdict {
  for (const gate of gates) {
    const verdict = gate(context);
    if (verdict.type !== 'pass') return verdict;
  }
  return { type: 'pass' };
}

export function evaluateConversationAware(context: GateContext): ConversationAwareModulation {
  const conversation = context.conversation;
  if (!conversation) {
    return { lambdaMultiplier: 1.0, silenceBoost: false, block: false };
  }

  const state = conversation.state;
  const turnState = conversation.turn_state;

  // Active conversation + Nova's turn: lower social-cost barrier.
  if (state === 'active' && turnState === 'nova_turn') {
    return { lambdaMultiplier: 0.5, silenceBoost: false, block: false };
  }

  // Active conversation, not Nova's turn: standard parameters.
  if (state === 'active') {
    return { lambdaMultiplier: 1.0, silenceBoost: false, block: false };
  }

  // Closing: neutral lambda, hint for natural silence, but don't force-block.
  // The actual blocking is done by evaluateClosingConversation.
  if (state === 'closing') {
    return { lambdaMultiplier: 1.0, silenceBoost: true, block: false };
  }

  // Cooldown: block outright (the conversation is resting).
  if (state === 'cooldown') {
    return {
      lambdaMultiplier: 2.0,
      silenceBoost: false,
      block: true,
      blockReason: SILENCE_REASONS.CONVERSATION_COOLDOWN,
    };
  }

  return { lambdaMultiplier: 1.0, silenceBoost: false, block: false };
}

export function evaluateClosingConversation(context: GateContext): GateDecision | null {
  const conversation = context.conversation;
  if (!conversation || conversation.state !== 'closing') return null;

  const lastDirectedMs = context.channel?.last_directed_ms ?? 0;
  const closingSinceMs = conversation.closing_since_ms ?? conversation.last_activity_ms;

  // allow re-entry.
  if (context.event?.isDirected === true && lastDirectedMs > closingSinceMs) return null;

  return silence('hard', SILENCE_REASONS.CLOSING_CONVERSATION, [], {
    conversationId: conversation.id,
    closingSinceMs,
    lastDirectedMs,
    state: conversation.state,
  });
}

export function evaluateCautionGate(context: GateContext): GateDecision | null {
  if (context.voice.selected !== 'caution') return null;

  const chatType = context.event?.chatType ?? context.channel?.chat_type;
  const directed = context.event?.isDirected === true;

  if (context.reason === 'scheduled') {
    return silence('hard', SILENCE_REASONS.CAUTION_SCHEDULED_SILENCE, [], {
      selectedVoice: 'caution',
      reason: context.reason,
      note: 'caution is not an IAUS action type; scheduled ticks with caution always observe',
    });
  }

  if (chatType === 'group' && !directed) {
    return silence('normal', SILENCE_REASONS.CAUTION_GROUP_OBSERVE, [], {
      selectedVoice: 'caution',
      chatType,
      directed,
      note: 'caution in undirected group context favours observation over participation',
    });
  }

  // Private chat or directed message + caution → pass.
  return null;
}

/**
 * Engagement state gate.
 *
 * Prevents Nova from interrupting an existing waiting engagement with the same
 * target.  If a proactive action was already sent and Nova is waiting for a
 * reply, do not enqueue another action targeting the same entity.
 *
 * This gate applies to scheduled (proactive) ticks; message replies always
 * take priority and are not blocked by engagement state.
 */
export function evaluateEngagementState(
  targetId: string | null,
  context: GateContext,
): GateDecision | null {
  if (!targetId) return null;
  if (!context.actionQueue) return null;

  // 检查是否有 pending 队列条目 或 正在处理的 target（acquireTarget 锁）
  const hasWaiting = context.actionQueue.isTargetActive(targetId);

  if (!hasWaiting) return null;

  const pending = context.actionQueue.listPending();
  return silence('normal', SILENCE_REASONS.ENGAGEMENT_WAITING, [], {
    targetId,
    pendingActionCount: pending.length,
    note: 'a waiting or in-progress engagement already exists for this target; skip to avoid duplicate outreach',
  });
}

/**
 * Proactive enabled gate.
 *
 * The master switch for all proactive (unsolicited) messaging.
 * When disabled, scheduled ticks may still observe and log, but must never
 * enqueue or send a proactive action.
 */
export function evaluateProactiveEnabledGate(config: NovaRuntimeConfig): GateDecision | null {
  if (config.proactiveEnabled) return null;

  return silence('hard', SILENCE_REASONS.PROACTIVE_DISABLED, [], {
    proactiveEnabled: false,
  });
}

/**
 * Whitelist gate: for private proactive messages, the target's QQ must be
 * present in the proactive whitelist.
 *
 * The caller is responsible for resolving the target entity to its QQ number
 * before calling this gate.  This keeps the gate stateless and reusable.
 *
 * Denial reasons:
 *   - PROACTIVE_WHITELIST_EMPTY  — whitelist is empty (no one is allowed).
 *   - PROACTIVE_WHITELIST_DENIED — target QQ is not in the whitelist.
 */
export function evaluateWhitelistGate(
  targetId: string,
  targetQQ: string | null,
  whitelist: string[],
): GateDecision | null {
  if (!whitelist || whitelist.length === 0) {
    return silence('hard', SILENCE_REASONS.PROACTIVE_WHITELIST_EMPTY, [], {
      proactiveWhitelistQQ: [],
    });
  }

  if (!targetQQ || !whitelist.includes(targetQQ)) {
    return silence('hard', SILENCE_REASONS.PROACTIVE_WHITELIST_DENIED, [], {
      targetId,
      targetQQ: targetQQ ?? 'unknown',
      proactiveWhitelistQQ: whitelist,
    });
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function mergeSilenceDecisions(decisions: GateDecision[]): GateDecision {
  const level = strongestLevel(decisions.map((d) => d.level));
  return {
    allow: false,
    level,
    reason: decisions[0]?.reason ?? 'silence',
    reasons: decisions.flatMap((d) => d.reasons),
    values: Object.assign({}, ...decisions.map((d) => d.values)),
  };
}

export function allowDecision(reason: string, values: Record<string, unknown>): GateDecision {
  return {
    allow: true,
    level: 'none',
    reason,
    reasons: [reason],
    values,
  };
}

export function silence(
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

export function strongestLevel(levels: SilenceLevel[]): SilenceLevel {
  const rank: Record<SilenceLevel, number> = {
    none: 0,
    soft: 1,
    normal: 2,
    hard: 3,
    safety: 4,
  };
  let best: SilenceLevel = 'none';
  for (const level of levels) {
    if (rank[level] > rank[best]) best = level;
  }
  return best;
}

/** Convert a GateVerdict to a GateDecision for compatibility. */
export function verdictToDecision(verdict: GateVerdict): GateDecision | null {
  if (verdict.type === 'pass') return null;
  if (verdict.type === 'act') {
    return allowDecision(verdict.reason, verdict.values);
  }
  return {
    allow: false,
    level: verdict.level,
    reason: verdict.reason,
    reasons: [verdict.reason],
    values: verdict.values,
  };
}
