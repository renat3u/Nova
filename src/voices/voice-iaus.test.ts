import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IAUS_ACTIONS,
  voiceToIAUSAction,
  type IAUSAction,
  type VoiceId,
} from './personality.js';
import { selectVoice } from './selection.js';
import { VOICE_PALETTE } from './palette.js';
import { evaluateGates } from '../gates/gates.js';
import { RateLimitState } from '../gates/rate-limit.js';

// ═══════════════════════════════════════════════════════════════════════════
// IAUS action set
// ═══════════════════════════════════════════════════════════════════════════

test('IAUS_ACTIONS excludes caution', () => {
  assert.deepStrictEqual(IAUS_ACTIONS, ['diligence', 'curiosity', 'sociability']);
  assert.ok(!(IAUS_ACTIONS as readonly string[]).includes('caution'));
});

test('voiceToIAUSAction maps diligence/curiosity/sociability to themselves', () => {
  assert.strictEqual(voiceToIAUSAction('diligence'), 'diligence');
  assert.strictEqual(voiceToIAUSAction('curiosity'), 'curiosity');
  assert.strictEqual(voiceToIAUSAction('sociability'), 'sociability');
});

test('voiceToIAUSAction returns null for caution', () => {
  assert.strictEqual(voiceToIAUSAction('caution'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// VoiceSelectionResult.iausAction
// ═══════════════════════════════════════════════════════════════════════════

test('selectVoice sets iausAction to the IAUS action for active voices', () => {
  const loudness: Record<VoiceId, number> = {
    diligence: 0.8,
    curiosity: 0.2,
    sociability: 0.1,
    caution: 0.05,
  };
  const fatigue: Record<VoiceId, number> = {
    diligence: 1, curiosity: 1, sociability: 1, caution: 1,
  };
  // Deterministic mode selects the max-loudness voice (diligence)
  const result = selectVoice(loudness, fatigue, [], { deterministic: true });
  assert.strictEqual(result.selected, 'diligence');
  assert.strictEqual(result.iausAction, 'diligence');
  assert.ok(result.iausAction !== null);
});

test('selectVoice sets iausAction to null when caution wins', () => {
  const loudness: Record<VoiceId, number> = {
    diligence: 0.05,
    curiosity: 0.05,
    sociability: 0.05,
    caution: 0.9,
  };
  const fatigue: Record<VoiceId, number> = {
    diligence: 1, curiosity: 1, sociability: 1, caution: 1,
  };
  const result = selectVoice(loudness, fatigue, [], { deterministic: true });
  assert.strictEqual(result.selected, 'caution');
  assert.strictEqual(result.iausAction, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// Caution gate: scheduled tick silence
// ═══════════════════════════════════════════════════════════════════════════

function baseGateContext(overrides: Record<string, unknown> = {}): import('../gates/gates.js').GateContext {
  return {
    nowMs: Date.now(),
    reason: 'message' as const,
    pressure: {
      tick: 1, createdMs: Date.now(),
      p1: 2, p2: 2, p3: 2, p4: 2, p5: 2, p6: 2,
      pProspect: 0.5, api: 3, apiPeak: 3.5,
      contributions: {},
    },
    voice: {
      selected: 'diligence' as VoiceId,
      loudness: { diligence: 0.5, curiosity: 0.2, sociability: 0.2, caution: 0.1 },
      probabilities: { diligence: 0.5, curiosity: 0.2, sociability: 0.2, caution: 0.1 },
      temperature: 0.15,
      fatigue: { diligence: 1, curiosity: 1, sociability: 1, caution: 1 },
      reasons: [],
      iausAction: 'diligence' as IAUSAction | null,
    },
    config: {
      enabled: true,
      dbPath: ':memory:',
      llmBaseUrl: 'http://localhost',
      llmApiKey: '',
      llmModel: '',
      maxReplyLength: 200,
      enablePrivateChat: true,
      enableGroupChat: true,
      replyInGroupOnlyWhenMentioned: false,
      enableScheduledActions: true,
      proactiveEnabled: false,
      proactiveWhitelistQQ: [],
      iausScoringMode: 'consideration',
      minProactiveUtility: 0.05,
      groupMinProactiveUtility: 0.08,
      iausCompensationFactor: 0.5,
      socialSafetyMidpoint: 0.45,
      socialSafetySlope: 0.15,
      enabledGroups: {},
      privateCooldownMs: 0,
      groupCooldownMs: 0,
      globalRateLimitPerMinute: 60,
      channelRateLimitPerMinute: 30,
      groupRateLimitPerMinute: 20,
      floodWindowMs: 5000,
      floodMessageLimit: 10,
      userFloodMessageLimit: 5,
      minApiToSpeak: 0,
      directedMinApiToSpeak: 0,
      quoteReply: false,
      debug: false,
      consecutiveSendFailureLimit: 3,
    },
    rateLimit: new RateLimitState(),
    ...overrides,
  };
}

test('caution gate silences scheduled tick regardless', () => {
  const context = baseGateContext({
    reason: 'scheduled',
    voice: {
      selected: 'caution' as VoiceId,
      loudness: { diligence: 0.1, curiosity: 0.1, sociability: 0.1, caution: 0.7 },
      probabilities: { diligence: 0.1, curiosity: 0.1, sociability: 0.1, caution: 0.7 },
      temperature: 0.2,
      fatigue: { diligence: 1, curiosity: 1, sociability: 1, caution: 1 },
      reasons: [],
      iausAction: null,
    },
  });
  const decision = evaluateGates(context);
  assert.strictEqual(decision.allow, false);
  assert.ok(decision.reasons.includes('caution_scheduled_silence'));
});

test('caution gate silences undirected group message', () => {
  const context = baseGateContext({
    reason: 'message',
    voice: {
      selected: 'caution' as VoiceId,
      loudness: { diligence: 0.1, curiosity: 0.1, sociability: 0.1, caution: 0.7 },
      probabilities: { diligence: 0.1, curiosity: 0.1, sociability: 0.1, caution: 0.7 },
      temperature: 0.2,
      fatigue: { diligence: 1, curiosity: 1, sociability: 1, caution: 1 },
      reasons: [],
      iausAction: null,
    },
    event: {
      id: 'event:1', platform: 'qq', rawEvent: {},
      messageId: 'm1', rawMessageId: '1',
      chatType: 'group', chatId: 'qq:group:20001',
      senderId: 'qq:user:10001', senderQQ: '10001', senderName: '用户',
      text: 'hello', rawText: 'hello',
      timestamp: Date.now(),
      isSelf: false, mentionedSelf: false, repliedToSelf: false,
      isDirected: false,
      groupId: '20001',
    },
  });
  const decision = evaluateGates(context);
  assert.strictEqual(decision.allow, false);
  assert.ok(decision.reasons.includes('caution_group_observe'));
});

test('caution gate passes directed group message', () => {
  const context = baseGateContext({
    reason: 'message',
    voice: {
      selected: 'caution' as VoiceId,
      loudness: { diligence: 0.1, curiosity: 0.1, sociability: 0.1, caution: 0.7 },
      probabilities: { diligence: 0.1, curiosity: 0.1, sociability: 0.1, caution: 0.7 },
      temperature: 0.2,
      fatigue: { diligence: 1, curiosity: 1, sociability: 1, caution: 1 },
      reasons: [],
      iausAction: null,
    },
    event: {
      id: 'event:2', platform: 'qq', rawEvent: {},
      messageId: 'm2', rawMessageId: '2',
      chatType: 'group', chatId: 'qq:group:20001',
      senderId: 'qq:user:10001', senderQQ: '10001', senderName: '用户',
      text: '@Nova hi', rawText: '@Nova hi',
      timestamp: Date.now(),
      isSelf: false, mentionedSelf: true, repliedToSelf: false,
      isDirected: true,
      groupId: '20001',
    },
  });
  const decision = evaluateGates(context);
  // Directed caution group message: the caution gate returns null (pass),
  // and with no other conservative gates blocking, the decision is "allowed".
  assert.strictEqual(decision.allow, true);
  assert.ok(!decision.reasons.includes('caution_group_observe'));
  assert.ok(!decision.reasons.includes('caution_scheduled_silence'));
});

test('caution gate passes private message', () => {
  const context = baseGateContext({
    reason: 'message',
    voice: {
      selected: 'caution' as VoiceId,
      loudness: { diligence: 0.1, curiosity: 0.1, sociability: 0.1, caution: 0.7 },
      probabilities: { diligence: 0.1, curiosity: 0.1, sociability: 0.1, caution: 0.7 },
      temperature: 0.2,
      fatigue: { diligence: 1, curiosity: 1, sociability: 1, caution: 1 },
      reasons: [],
      iausAction: null,
    },
    event: {
      id: 'event:3', platform: 'qq', rawEvent: {},
      messageId: 'm3', rawMessageId: '3',
      chatType: 'private', chatId: 'qq:private:10001',
      senderId: 'qq:user:10001', senderQQ: '10001', senderName: '用户',
      text: 'hi', rawText: 'hi',
      timestamp: Date.now(),
      isSelf: false, mentionedSelf: false, repliedToSelf: false,
      isDirected: true,
    },
  });
  const decision = evaluateGates(context);
  // Private chat with caution should pass (prompt handles restraint)
  assert.strictEqual(decision.allow, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// Non-caution voices do not trigger caution gate
// ═══════════════════════════════════════════════════════════════════════════

test('non-caution voice does not trigger caution gate in scheduled tick', () => {
  const context = baseGateContext({
    reason: 'scheduled',
    voice: {
      selected: 'sociability' as VoiceId,
      loudness: { diligence: 0.1, curiosity: 0.2, sociability: 0.6, caution: 0.1 },
      probabilities: { diligence: 0.1, curiosity: 0.2, sociability: 0.6, caution: 0.1 },
      temperature: 0.2,
      fatigue: { diligence: 1, curiosity: 1, sociability: 1, caution: 1 },
      reasons: [],
      iausAction: 'sociability',
    },
  });
  const decision = evaluateGates(context);
  // Should NOT contain caution_scheduled_silence
  assert.ok(!decision.reasons.includes('caution_scheduled_silence'));
  // With sociability as voice and scheduled actions enabled, it may pass or be silenced
  // by other gates, but not by the caution gate.
});

test('prompt CONVERSATIONAL_PULL exists for all four voices without exposing internals', () => {
  for (const voice of ['diligence', 'curiosity', 'sociability', 'caution'] as const) {
    const entry = VOICE_PALETTE[voice];
    assert.ok(entry, `Voice palette has entry for ${voice}`);
    assert.ok(entry.promptSummary.length > 0, `${voice} has non-empty promptSummary`);
    // Must not expose internal terms
    assert.doesNotMatch(entry.promptSummary, /\b(IAUS|gate|pressure|kappa|whitelist|tick)\b/i);
  }
});
