// Phase 2 Step 19: Gate tests
//
// Covers: proactive disabled, scheduled actions disabled, whitelist,
// cooldown, flood, rate cap, closing conversation, group policy,
// engagement state, API floor, caution, QQ risk, conversation-aware.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimitState } from './rate-limit.js';
import {
  SILENCE_REASONS,
  evaluateGates,
  evaluateHardGates,
  evaluateCautionGate,
  evaluateActiveCooling,
  evaluateApiFloor,
  evaluateConversationAware,
  evaluateClosingConversation,
  evaluateEngagementState,
  evaluateProactiveEnabledGate,
  evaluateWhitelistGate,
  evaluateQQRisk,
  runGateChain,
  allowDecision,
  mergeSilenceDecisions,
  strongestLevel,
  verdictToDecision,
  type GateContext,
  type GateDecision,
} from './gates.js';
import { ActionQueue } from '../act/action-queue.js';
import type { NovaMessageEvent, NovaRuntimeConfig } from '../core/types.js';
import type { PressureSnapshot } from '../pressure/aggregate.js';
import type { VoiceSelectionResult } from '../voices/selection.js';
import type { VoiceId } from '../personality/vector.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<NovaRuntimeConfig> = {}): NovaRuntimeConfig {
  return {
    enabled: true,
    debug: false,
    llmBaseUrl: 'http://localhost',
    llmApiKey: '',
    llmModel: 'test',
    replyInGroupOnlyWhenMentioned: false,
    enablePrivateChat: true,
    enableGroupChat: true,
    enabledGroups: {},
    quoteReply: false,
    maxReplyLength: 200,
    dbPath: ':memory:',
    minApiToSpeak: 0,
    directedMinApiToSpeak: 0,
    privateCooldownMs: 0,
    groupCooldownMs: 0,
    globalRateLimitPerMinute: 60,
    channelRateLimitPerMinute: 30,
    groupRateLimitPerMinute: 20,
    enableScheduledActions: false,
    floodWindowMs: 5000,
    floodMessageLimit: 10,
    userFloodMessageLimit: 5,
    consecutiveSendFailureLimit: 3,
    proactiveEnabled: false,
    proactiveWhitelistQQ: [],
    iausScoringMode: 'consideration',
    minProactiveUtility: 0.05,
    groupMinProactiveUtility: 0.08,
    iausCompensationFactor: 0.5,
    socialSafetyMidpoint: 0.45,
    socialSafetySlope: 0.15,
    ...overrides,
  };
}

function basePressure(overrides: Partial<PressureSnapshot> = {}): PressureSnapshot {
  return {
    tick: 1, createdMs: Date.now(),
    p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0,
    pProspect: 0, api: 5, apiPeak: 5,
    contributions: {},
    ...overrides,
  };
}

function baseVoice(selected: VoiceId = 'sociability'): VoiceSelectionResult {
  return {
    selected,
    loudness: { diligence: 0.2, curiosity: 0.3, sociability: 0.5, caution: 0.1 },
    probabilities: { diligence: 0.2, curiosity: 0.3, sociability: 0.5, caution: 0.1 },
    temperature: 0.2,
    fatigue: { diligence: 1, curiosity: 1, sociability: 1, caution: 1 },
    reasons: [],
    iausAction: selected === 'caution' ? null : selected,
  };
}

function baseGateContext(overrides: Partial<GateContext> = {}): GateContext {
  return {
    nowMs: Date.now(),
    reason: 'message',
    pressure: basePressure(),
    voice: baseVoice(),
    config: baseConfig(),
    rateLimit: new RateLimitState(),
    ...overrides,
  };
}

function privateEvent(overrides: Partial<NovaMessageEvent> = {}): NovaMessageEvent {
  return {
    id: 'evt:1', platform: 'qq', rawEvent: {},
    messageId: 'msg:1', rawMessageId: '1',
    chatType: 'private', chatId: 'qq:private:12345',
    senderId: 'qq:user:12345', senderQQ: '12345', senderName: '秋',
    text: '你好', rawText: '你好',
    timestamp: Date.now(),
    isSelf: false, mentionedSelf: false, repliedToSelf: false,
    isDirected: true,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Hard gates
// ═══════════════════════════════════════════════════════════════════════════

test('hard gate: runtime disabled blocks all', () => {
  const ctx = baseGateContext({ config: baseConfig({ enabled: false }) });
  const reasons: string[] = [];
  const values: Record<string, unknown> = {};
  const decision = evaluateHardGates(ctx, reasons, values);
  assert.ok(decision);
  assert.equal(decision!.allow, false);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.RUNTIME_DISABLED));
});

test('hard gate: empty text blocked at safety level', () => {
  const ctx = baseGateContext({
    event: privateEvent({ text: '   ' }),
  });
  const reasons: string[] = [];
  const values: Record<string, unknown> = {};
  const decision = evaluateHardGates(ctx, reasons, values);
  assert.ok(decision);
  assert.equal(decision!.level, 'safety');
});

test('hard gate: private chat disabled blocks private events', () => {
  const ctx = baseGateContext({
    event: privateEvent(),
    config: baseConfig({ enablePrivateChat: false }),
  });
  const reasons: string[] = [];
  const values: Record<string, unknown> = {};
  const decision = evaluateHardGates(ctx, reasons, values);
  assert.ok(decision);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.PRIVATE_CHAT_DISABLED));
});

test('hard gate: group chat disabled blocks group events', () => {
  const ctx = baseGateContext({
    event: {
      ...privateEvent(),
      chatType: 'group',
      chatId: 'qq:group:20001',
      groupId: '20001',
    },
    config: baseConfig({ enableGroupChat: false }),
  });
  const reasons: string[] = [];
  const values: Record<string, unknown> = {};
  const decision = evaluateHardGates(ctx, reasons, values);
  assert.ok(decision);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.GROUP_CHAT_DISABLED));
});

test('hard gate: missing groupId blocked at safety level', () => {
  const ctx = baseGateContext({
    event: {
      ...privateEvent(),
      chatType: 'group',
      chatId: 'qq:group:20001',
      groupId: undefined,
    },
  });
  const reasons: string[] = [];
  const values: Record<string, unknown> = {};
  const decision = evaluateHardGates(ctx, reasons, values);
  assert.ok(decision);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.MISSING_GROUP_ID));
});

test('hard gate: disabled group blocked', () => {
  const ctx = baseGateContext({
    event: {
      ...privateEvent(),
      chatType: 'group',
      chatId: 'qq:group:20001',
      groupId: '20001',
    },
    config: baseConfig({
      enabledGroups: { '20001': { enabled: false } },
    }),
  });
  const reasons: string[] = [];
  const values: Record<string, unknown> = {};
  const decision = evaluateHardGates(ctx, reasons, values);
  assert.ok(decision);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.GROUP_DISABLED));
});

test('hard gate: scheduled actions disabled blocks scheduled ticks', () => {
  const ctx = baseGateContext({
    reason: 'scheduled',
    config: baseConfig({ enableScheduledActions: false }),
  });
  const reasons: string[] = [];
  const values: Record<string, unknown> = {};
  const decision = evaluateHardGates(ctx, reasons, values);
  assert.ok(decision);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.SCHEDULED_ACTIONS_DISABLED));
});

test('hard gate: passes for normal message event', () => {
  const ctx = baseGateContext({ event: privateEvent() });
  const reasons: string[] = [];
  const values: Record<string, unknown> = {};
  const decision = evaluateHardGates(ctx, reasons, values);
  assert.equal(decision, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. QQ risk gate
// ═══════════════════════════════════════════════════════════════════════════

test('QQ risk: sends failure risk when consecutive failures exceed limit', () => {
  const rateLimit = new RateLimitState();
  rateLimit.recordSendFailure();
  rateLimit.recordSendFailure();
  rateLimit.recordSendFailure();
  const ctx = baseGateContext({
    config: baseConfig({ consecutiveSendFailureLimit: 3 }),
    rateLimit,
  });
  const result = evaluateQQRisk(ctx);
  assert.equal(result.pass, false);
  assert.equal(result.reason, SILENCE_REASONS.SEND_FAILURE_RISK);
});

test('QQ risk: flood detection triggers on channel message burst', () => {
  const rateLimit = new RateLimitState();
  const nowMs = Date.now();
  const event = privateEvent({ timestamp: nowMs });
  for (let i = 0; i < 10; i++) {
    rateLimit.rememberMessage(event);
  }
  const ctx = baseGateContext({
    event,
    config: baseConfig({ floodWindowMs: 60000, floodMessageLimit: 5 }),
    rateLimit,
    nowMs,
  });
  const result = evaluateQQRisk(ctx);
  assert.equal(result.pass, false);
});

test('QQ risk: passes when under all limits', () => {
  const ctx = baseGateContext();
  const result = evaluateQQRisk(ctx);
  assert.equal(result.pass, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Active cooling gate
// ═══════════════════════════════════════════════════════════════════════════

test('active cooling: blocks when within cooldown period', () => {
  const nowMs = Date.now();
  const ctx = baseGateContext({
    nowMs,
    config: baseConfig({ privateCooldownMs: 30000 }),
    channel: {
      id: 'qq:private:12345',
      entity_type: 'channel',
      platform: 'qq',
      chat_type: 'private',
      tier_contact: 50,
      unread: 0,
      pending_directed: 0,
      last_activity_ms: nowMs,
      last_nova_action_ms: nowMs - 5000, // 5s ago, within 30s cooldown
      contact_recv_window: 0,
      activity_relevance: 1,
      member_count: 0,
      hawkes_carry: 0,
    },
  });
  const decision = evaluateActiveCooling(ctx);
  assert.ok(decision);
  assert.equal(decision!.allow, false);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.ACTIVE_COOLING));
});

test('active cooling: passes when cooldown expired', () => {
  const nowMs = Date.now();
  const ctx = baseGateContext({
    nowMs,
    config: baseConfig({ privateCooldownMs: 1000 }),
    channel: {
      id: 'qq:private:12345',
      entity_type: 'channel',
      platform: 'qq',
      chat_type: 'private',
      tier_contact: 50,
      unread: 0,
      pending_directed: 0,
      last_activity_ms: nowMs,
      last_nova_action_ms: nowMs - 60000,
      contact_recv_window: 0,
      activity_relevance: 1,
      member_count: 0,
      hawkes_carry: 0,
    },
  });
  const decision = evaluateActiveCooling(ctx);
  assert.equal(decision, null);
});

test('active cooling: passes when no last action recorded', () => {
  const ctx = baseGateContext({
    channel: {
      id: 'qq:private:12345',
      entity_type: 'channel',
      platform: 'qq',
      chat_type: 'private',
      tier_contact: 50,
      unread: 0,
      pending_directed: 0,
      last_activity_ms: Date.now(),
      contact_recv_window: 0,
      activity_relevance: 1,
      member_count: 0,
      hawkes_carry: 0,
    },
  });
  const decision = evaluateActiveCooling(ctx);
  assert.equal(decision, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. API floor gate
// ═══════════════════════════════════════════════════════════════════════════

test('API floor: blocks when pressure API is below floor', () => {
  const ctx = baseGateContext({
    pressure: basePressure({ api: 0.5 }),
    config: baseConfig({ minApiToSpeak: 2.0 }),
  });
  const decision = evaluateApiFloor(ctx);
  assert.ok(decision);
  assert.equal(decision!.allow, false);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.API_FLOOR));
});

test('API floor: uses lower threshold for directed messages', () => {
  const ctx = baseGateContext({
    pressure: basePressure({ api: 1.5 }),
    config: baseConfig({ minApiToSpeak: 2.0, directedMinApiToSpeak: 1.0 }),
    event: privateEvent({ isDirected: true }),
  });
  const decision = evaluateApiFloor(ctx);
  assert.equal(decision, null);
});

test('API floor: passes when API pressure is above floor', () => {
  const ctx = baseGateContext({
    pressure: basePressure({ api: 5.0 }),
    config: baseConfig({ minApiToSpeak: 2.0 }),
  });
  const decision = evaluateApiFloor(ctx);
  assert.equal(decision, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Conversation-aware modulation
// ═══════════════════════════════════════════════════════════════════════════

test('conversation aware: active + nova_turn lowers lambda', () => {
  const ctx = baseGateContext({
    conversation: {
      id: 'conv:1',
      entity_type: 'conversation',
      channel_id: 'qq:private:12345',
      state: 'active',
      turn_state: 'nova_turn',
      last_activity_ms: Date.now(),
    },
  });
  const mod = evaluateConversationAware(ctx);
  assert.equal(mod.lambdaMultiplier, 0.5);
  assert.equal(mod.block, false);
});

test('conversation aware: cooldown state blocks', () => {
  const ctx = baseGateContext({
    conversation: {
      id: 'conv:1',
      entity_type: 'conversation',
      channel_id: 'qq:private:12345',
      state: 'cooldown',
      turn_state: 'none',
      last_activity_ms: Date.now(),
    },
  });
  const mod = evaluateConversationAware(ctx);
  assert.equal(mod.block, true);
  assert.equal(mod.blockReason, SILENCE_REASONS.CONVERSATION_COOLDOWN);
});

test('conversation aware: closing state has silence boost', () => {
  const ctx = baseGateContext({
    conversation: {
      id: 'conv:1',
      entity_type: 'conversation',
      channel_id: 'qq:private:12345',
      state: 'closing',
      turn_state: 'none',
      last_activity_ms: Date.now(),
    },
  });
  const mod = evaluateConversationAware(ctx);
  assert.equal(mod.silenceBoost, true);
  assert.equal(mod.block, false);
});

test('conversation aware: returns neutral without conversation', () => {
  const ctx = baseGateContext();
  const mod = evaluateConversationAware(ctx);
  assert.equal(mod.lambdaMultiplier, 1.0);
  assert.equal(mod.block, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Closing conversation gate
// ═══════════════════════════════════════════════════════════════════════════

test('closing conversation: blocks when conversation is closing', () => {
  const ctx = baseGateContext({
    conversation: {
      id: 'conv:1',
      entity_type: 'conversation',
      channel_id: 'qq:private:12345',
      state: 'closing',
      turn_state: 'none',
      last_activity_ms: Date.now(),
      closing_since_ms: Date.now() - 5000,
    },
    channel: {
      id: 'qq:private:12345',
      entity_type: 'channel',
      platform: 'qq',
      chat_type: 'private',
      tier_contact: 50,
      unread: 0,
      pending_directed: 0,
      last_activity_ms: Date.now(),
      last_directed_ms: 0,
      contact_recv_window: 0,
      activity_relevance: 1,
      member_count: 0,
      hawkes_carry: 0,
    },
  });
  const decision = evaluateClosingConversation(ctx);
  assert.ok(decision);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.CLOSING_CONVERSATION));
});

test('closing conversation: allows re-entry when directed after closing began', () => {
  const nowMs = Date.now();
  const closingSinceMs = nowMs - 10000;
  const ctx = baseGateContext({
    nowMs,
    event: privateEvent({ isDirected: true }),
    conversation: {
      id: 'conv:1',
      entity_type: 'conversation',
      channel_id: 'qq:private:12345',
      state: 'closing',
      turn_state: 'none',
      last_activity_ms: nowMs,
      closing_since_ms: closingSinceMs,
    },
    channel: {
      id: 'qq:private:12345',
      entity_type: 'channel',
      platform: 'qq',
      chat_type: 'private',
      tier_contact: 50,
      unread: 0,
      pending_directed: 0,
      last_activity_ms: nowMs,
      last_directed_ms: nowMs - 1000, // later than closing
      contact_recv_window: 0,
      activity_relevance: 1,
      member_count: 0,
      hawkes_carry: 0,
    },
  });
  const decision = evaluateClosingConversation(ctx);
  assert.equal(decision, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Caution gate
// ═══════════════════════════════════════════════════════════════════════════

test('caution gate: scheduled tick always silenced', () => {
  const ctx = baseGateContext({
    reason: 'scheduled',
    voice: baseVoice('caution'),
  });
  const decision = evaluateCautionGate(ctx);
  assert.ok(decision);
  assert.equal(decision!.allow, false);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.CAUTION_SCHEDULED_SILENCE));
});

test('caution gate: undirected group message silenced', () => {
  const ctx = baseGateContext({
    reason: 'message',
    voice: baseVoice('caution'),
    event: {
      ...privateEvent(),
      chatType: 'group',
      chatId: 'qq:group:20001',
      groupId: '20001',
      isDirected: false,
    },
  });
  const decision = evaluateCautionGate(ctx);
  assert.ok(decision);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.CAUTION_GROUP_OBSERVE));
});

test('caution gate: directed group message passes', () => {
  const ctx = baseGateContext({
    reason: 'message',
    voice: baseVoice('caution'),
    event: {
      ...privateEvent(),
      chatType: 'group',
      chatId: 'qq:group:20001',
      groupId: '20001',
      isDirected: true,
      mentionedSelf: true,
    },
  });
  const decision = evaluateCautionGate(ctx);
  assert.equal(decision, null);
});

test('caution gate: private message passes', () => {
  const ctx = baseGateContext({
    reason: 'message',
    voice: baseVoice('caution'),
    event: privateEvent(),
  });
  const decision = evaluateCautionGate(ctx);
  assert.equal(decision, null);
});

test('caution gate: non-caution voice not affected', () => {
  const ctx = baseGateContext({
    reason: 'scheduled',
    voice: baseVoice('sociability'),
  });
  const decision = evaluateCautionGate(ctx);
  assert.equal(decision, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Proactive enabled gate
// ═══════════════════════════════════════════════════════════════════════════

test('proactive enabled: disabled blocks proactive', () => {
  const decision = evaluateProactiveEnabledGate(baseConfig({ proactiveEnabled: false }));
  assert.ok(decision);
  assert.equal(decision!.allow, false);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.PROACTIVE_DISABLED));
});

test('proactive enabled: enabled passes', () => {
  const decision = evaluateProactiveEnabledGate(baseConfig({ proactiveEnabled: true }));
  assert.equal(decision, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Whitelist gate
// ═══════════════════════════════════════════════════════════════════════════

test('whitelist: empty whitelist blocks', () => {
  const decision = evaluateWhitelistGate('qq:private:12345', '12345', []);
  assert.ok(decision);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.PROACTIVE_WHITELIST_EMPTY));
});

test('whitelist: non-whitelisted QQ blocked', () => {
  const decision = evaluateWhitelistGate('qq:private:12345', '12345', ['99999']);
  assert.ok(decision);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.PROACTIVE_WHITELIST_DENIED));
});

test('whitelist: missing QQ blocked', () => {
  const decision = evaluateWhitelistGate('qq:private:12345', null, ['99999']);
  assert.ok(decision);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.PROACTIVE_WHITELIST_DENIED));
});

test('whitelist: whitelisted QQ passes', () => {
  const decision = evaluateWhitelistGate('qq:private:12345', '12345', ['12345', '99999']);
  assert.equal(decision, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Engagement state gate
// ═══════════════════════════════════════════════════════════════════════════

test('engagement: blocks when waiting engagement exists for same target', () => {
  const queue = new ActionQueue();
  queue.enqueue(
    { action: 'sociability', targetId: 'qq:private:12345', desireType: 'reconnect', urgency: 'medium', scene: 'private', reason: 'test' },
    1, Date.now(), 'test context',
  );
  const ctx = baseGateContext({ actionQueue: queue });
  const decision = evaluateEngagementState('qq:private:12345', ctx);
  assert.ok(decision);
  assert.ok(decision!.reasons.includes(SILENCE_REASONS.ENGAGEMENT_WAITING));
});

test('engagement: passes when no waiting engagement for target', () => {
  const queue = new ActionQueue();
  queue.enqueue(
    { action: 'sociability', targetId: 'qq:private:99999', desireType: 'reconnect', urgency: 'medium', scene: 'private', reason: 'test' },
    1, Date.now(), 'test context',
  );
  const ctx = baseGateContext({ actionQueue: queue });
  const decision = evaluateEngagementState('qq:private:12345', ctx);
  assert.equal(decision, null);
});

test('engagement: passes when no targetId', () => {
  const ctx = baseGateContext();
  const decision = evaluateEngagementState(null, ctx);
  assert.equal(decision, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Gate chain runner
// ═══════════════════════════════════════════════════════════════════════════

test('runGateChain: returns first non-pass verdict', () => {
  let called = 0;
  const verdict = runGateChain([
    () => { called++; return { type: 'pass' as const }; },
    () => { called++; return { type: 'silent' as const, level: 'hard' as const, reason: 'denied', values: {} }; },
    () => { called++; return { type: 'pass' as const }; },
  ]);
  assert.equal(verdict.type, 'silent');
  assert.equal(called, 2); // third gate never called
});

test('runGateChain: returns pass when all gates pass', () => {
  const verdict = runGateChain([
    () => ({ type: 'pass' as const }),
    () => ({ type: 'pass' as const }),
  ]);
  assert.equal(verdict.type, 'pass');
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Silence reasons completeness
// ═══════════════════════════════════════════════════════════════════════════

test('silence reasons: all expected deny reasons exist', () => {
  // Proactive deny reasons
  assert.equal(SILENCE_REASONS.PROACTIVE_DISABLED, 'proactive_disabled');
  assert.equal(SILENCE_REASONS.PROACTIVE_WHITELIST_EMPTY, 'proactive_whitelist_empty');
  assert.equal(SILENCE_REASONS.PROACTIVE_WHITELIST_DENIED, 'proactive_whitelist_denied');

  // Safety deny reasons
  assert.equal(SILENCE_REASONS.FLOOD_SAFETY, 'flood_safety');
  assert.equal(SILENCE_REASONS.RATE_CAP, 'rate_cap');
  assert.equal(SILENCE_REASONS.SEND_FAILURE_RISK, 'send_failure_risk');
  assert.equal(SILENCE_REASONS.ACTIVE_COOLING, 'active_cooling');
  assert.equal(SILENCE_REASONS.CLOSING_CONVERSATION, 'closing_conversation');

  // Group deny reasons
  assert.equal(SILENCE_REASONS.GROUP_OBSERVE_ONLY, 'group_observe_only');
  assert.equal(SILENCE_REASONS.GROUP_PROACTIVE_WHITELIST_CONTEXT_MISSING, 'group_proactive_whitelist_context_missing');

  // Social value
  assert.equal(SILENCE_REASONS.SOCIAL_VALUE_NEGATIVE, 'social_value_negative');

  // Engagement
  assert.equal(SILENCE_REASONS.ENGAGEMENT_WAITING, 'engagement_waiting');

  // Step 16 additions
  assert.equal(SILENCE_REASONS.PROACTIVE_TARGET_COOLDOWN, 'proactive_target_cooldown');
  assert.equal(SILENCE_REASONS.QUEUE_CLEARED_FAILURE_LIMIT, 'queue_cleared_failure_limit');

  // Step 15 explore
  assert.equal(SILENCE_REASONS.EXPLORE_COOLDOWN, 'explore_cooldown');
  assert.equal(SILENCE_REASONS.EXPLORE_DAILY_CAP, 'explore_daily_cap_reached');
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. Helper functions
// ═══════════════════════════════════════════════════════════════════════════

test('strongestLevel: returns highest priority level', () => {
  assert.equal(strongestLevel(['soft', 'normal', 'hard']), 'hard');
  assert.equal(strongestLevel(['safety', 'normal']), 'safety');
  assert.equal(strongestLevel(['none', 'soft']), 'soft');
  assert.equal(strongestLevel(['none']), 'none');
});

test('allowDecision: constructs correct decision', () => {
  const d = allowDecision('test_reason', { key: 'val' });
  assert.equal(d.allow, true);
  assert.equal(d.level, 'none');
  assert.equal(d.reason, 'test_reason');
  assert.deepStrictEqual(d.values, { key: 'val' });
});

test('mergeSilenceDecisions: merges multiple decisions', () => {
  const d1: GateDecision = { allow: false, level: 'normal', reason: 'r1', reasons: ['r1'], values: { a: 1 } };
  const d2: GateDecision = { allow: false, level: 'hard', reason: 'r2', reasons: ['r2'], values: { b: 2 } };
  const merged = mergeSilenceDecisions([d1, d2]);
  assert.equal(merged.allow, false);
  assert.equal(merged.level, 'hard');
  assert.ok(merged.reasons.includes('r1'));
  assert.ok(merged.reasons.includes('r2'));
});

test('verdictToDecision: converts act verdict', () => {
  const d = verdictToDecision({ type: 'act', reason: 'directed', values: { x: 1 } });
  assert.ok(d);
  assert.equal(d!.allow, true);
});

test('verdictToDecision: converts silent verdict', () => {
  const d = verdictToDecision({ type: 'silent', level: 'hard', reason: 'blocked', values: {} });
  assert.ok(d);
  assert.equal(d!.allow, false);
  assert.equal(d!.level, 'hard');
});

test('verdictToDecision: converts pass verdict to null', () => {
  const d = verdictToDecision({ type: 'pass' });
  assert.equal(d, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. Integrated evaluateGates scenarios
// ═══════════════════════════════════════════════════════════════════════════

test('evaluateGates: directed private message passes all gates', () => {
  const ctx = baseGateContext({
    reason: 'message',
    event: privateEvent({ isDirected: true }),
    pressure: basePressure({ api: 10 }),
  });
  const decision = evaluateGates(ctx);
  assert.equal(decision.allow, true);
});

test('evaluateGates: caution in undirected group is silenced by gates', () => {
  const ctx = baseGateContext({
    reason: 'message',
    voice: baseVoice('caution'),
    event: {
      ...privateEvent(),
      chatType: 'group',
      chatId: 'qq:group:20001',
      groupId: '20001',
      isDirected: false,
    },
  });
  const decision = evaluateGates(ctx);
  assert.equal(decision.allow, false);
});

test('evaluateGates: scheduled tick with proactive disabled is blocked', () => {
  // Scheduled tick with hard gate: scheduled_actions_disabled = true → blocked
  const ctx = baseGateContext({
    reason: 'scheduled',
    config: baseConfig({ enableScheduledActions: false }),
  });
  const decision = evaluateGates(ctx);
  assert.equal(decision.allow, false);
  assert.ok(decision.reasons.some((r) => r.includes('scheduled')));
});
