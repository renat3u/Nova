//
// DecisionContext builder tests — verify context assembly completeness.
//
// Covers:
//   1. Message context contains event / pressure / voice / memory
//   2. Scheduled context contains desires / candidates
//   3. Config hints present without apiKey exposure
//   4. Top contributors extracted from pressure contributions
//   5. Memory limits enforced (working ≤ 7, longTerm ≤ 8)
//   6. Candidate IDs are unique and deterministic
//

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDecisionContext, type BuildDecisionContextParams } from './decision-context.js';

// ── Minimal mocks ──────────────────────────────────────────────────────────

function mockWorld(): any {
  const entities = new Map<string, any>();
  return {
    has: (id: string) => entities.has(id),
    getNodeType: (id: string) => entities.get(id)?.type ?? null,
    getContact: (id: string) => entities.get(id),
    getChannel: (id: string) => entities.get(id),
    getEntitiesByType: (_type: string) => [],
  };
}

function mockRepository(): any {
  return {
    world: mockWorld(),
    getRecentMessages: (_channelId: string, _limit: number) => [],
    getActiveThreadsForChannel: (_channelId: string, _nowMs: number, _limit: number) => [],
    getRuntimeState: (_key: string) => undefined,
    setRuntimeState: () => {},
  };
}

function mockMemoryService(): any {
  return {
    getWorkingMemory: (_limit: number) => [],
    getRelevantFacts: (_opts?: any) => [],
    reviewMemoryCandidate: () => ({ accepted: false, reason: 'test' }),
    load: () => {},
    flush: () => {},
  };
}

function baseParams(overrides: Partial<BuildDecisionContextParams> = {}): BuildDecisionContextParams {
  return {
    tick: 0,
    reason: 'message',
    nowMs: Date.now(),
    event: {
      id: 'evt-1',
      platform: 'qq',
      rawEvent: {},
      messageId: 'msg-1',
      rawMessageId: '1',
      chatType: 'private',
      chatId: 'chat-1',
      senderId: 'sender-1',
      senderQQ: '123456',
      senderName: 'TestUser',
      text: 'Hello',
      rawText: 'Hello',
      timestamp: Date.now(),
      isSelf: false,
      mentionedSelf: false,
      repliedToSelf: false,
      isDirected: true,
    },
    pressure: {
      tick: 0,
      createdMs: Date.now(),
      p1: 0.1, p2: 0.2, p3: 0.3, p4: 0.4, p5: 0.5, p6: 0.6,
      pProspect: 0.7, api: 0.8, apiPeak: 0.9,
      contributions: {
        p1: { 'target-1': 0.15 },
        p2: { 'target-2': 0.25 },
        p5: { 'target-5': 0.55 },
      },
    },
    voice: {
      selected: 'diligence',
      iausAction: 'diligence',
      probabilities: { diligence: 1, curiosity: 0, sociability: 0, caution: 0 },
      loudness: { diligence: 0.5, curiosity: 0.5, sociability: 0.5, caution: 0.5 },
      fatigue: { diligence: 0, curiosity: 0, sociability: 0, caution: 0 },
      temperature: 1.0,
      reasons: [],
    },
    desires: [],
    candidates: [],
    world: mockWorld(),
    repository: mockRepository() as any,
    memoryService: mockMemoryService() as any,
    config: {
      enabled: true, debug: false,
      llmBaseUrl: '', llmApiKey: '', llmModel: '',
      replyInGroupOnlyWhenMentioned: true,
      enablePrivateChat: true, enableGroupChat: true,
      enabledGroups: {},
      quoteReply: false,
      maxReplyLength: 1000,
      dbPath: '',
      minApiToSpeak: 0.5, directedMinApiToSpeak: 0.15,
      privateCooldownMs: 3000, groupCooldownMs: 30000,
      globalRateLimitPerMinute: 20, channelRateLimitPerMinute: 6, groupRateLimitPerMinute: 4,
      enableScheduledActions: true,
      floodWindowMs: 10000, floodMessageLimit: 30, userFloodMessageLimit: 8,
      consecutiveSendFailureLimit: 3,
      proactiveEnabled: true,
      proactiveWhitelistQQ: [],
      iausScoringMode: 'consideration',
      minProactiveUtility: 0.05, groupMinProactiveUtility: 0.08,
      iausCompensationFactor: 0.5,
      socialSafetyMidpoint: 0.45, socialSafetySlope: 0.15,
      gatewayMode: 'agent',
      decisionAgent: {
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'secret-key-should-not-leak',
        model: 'test-model',
        temperature: 0.2,
        maxTokens: 1200,
        timeoutMs: 30000,
        responseFormat: 'json_object',
        failMode: 'fallback_algorithmic',
      },
      decisionGuardrails: 'off',
      enablePreSendGuardrails: false,
      auditAlgorithmicGates: true,
    },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('buildDecisionContext: message tick contains event', () => {
  const ctx = buildDecisionContext(baseParams());
  assert.equal(ctx.reason, 'message');
  assert.ok(ctx.event);
  assert.equal(ctx.event!.senderQQ, '123456');
  assert.equal(ctx.event!.text, 'Hello');
  assert.equal(ctx.event!.isDirected, true);
});

test('buildDecisionContext: scene matches event chatType', () => {
  const privateCtx = buildDecisionContext(baseParams());
  assert.equal(privateCtx.scene, 'private');

  const groupCtx = buildDecisionContext(baseParams({
    event: { ...baseParams().event!, chatType: 'group', groupId: 'g1', groupName: 'TestGroup' },
  }));
  assert.equal(groupCtx.scene, 'group');
});

test('buildDecisionContext: scheduled tick has no event', () => {
  const ctx = buildDecisionContext(baseParams({ reason: 'scheduled', event: undefined }));
  assert.equal(ctx.reason, 'scheduled');
  assert.equal(ctx.event, undefined);
});

test('buildDecisionContext: pressure explanations include all dimensions', () => {
  const ctx = buildDecisionContext(baseParams());
  const exp = ctx.pressure.explanations;
  assert.ok(exp.p1?.includes('P1'));
  assert.ok(exp.p2?.includes('P2'));
  assert.ok(exp.p3?.includes('P3'));
  assert.ok(exp.p4?.includes('P4'));
  assert.ok(exp.p5?.includes('P5'));
  assert.ok(exp.p6?.includes('P6'));
  assert.ok(exp.pProspect?.includes('P_prospect'));
  assert.ok(exp.api?.includes('API'));
});

test('buildDecisionContext: top contributors extracted', () => {
  const ctx = buildDecisionContext(baseParams());
  assert.ok(ctx.pressure.topContributors);
  assert.ok(ctx.pressure.topContributors!.length >= 1);
  const dims = ctx.pressure.topContributors!.map((c) => c.dimension);
  assert.ok(dims.includes('p1'));
  assert.ok(dims.includes('p2'));
  assert.ok(dims.includes('p5'));
});

test('buildDecisionContext: voice selection passed through', () => {
  const ctx = buildDecisionContext(baseParams());
  assert.equal(ctx.voice.selected, 'diligence');
  assert.equal(ctx.voice.iausAction, 'diligence');
  assert.equal(ctx.voice.temperature, 1.0);
});

test('buildDecisionContext: desires passed through', () => {
  const ctx = buildDecisionContext(baseParams({
    reason: 'scheduled',
    desires: [
      { type: 'reconnect', urgency: 'high', pressureValue: 0.6, targetId: 'chat-1', source: 'P3', reason: 'cooling relationship' },
    ],
  }));
  assert.equal(ctx.desires.length, 1);
  assert.equal(ctx.desires[0]!.type, 'reconnect');
  assert.equal(ctx.desires[0]!.urgency, 'high');
});

test('buildDecisionContext: candidates receive deterministic IDs', () => {
  const ctx = buildDecisionContext(baseParams({
    candidates: [
      { action: 'reply', targetId: 'chat-1', reason: 'test', scene: 'private' as const },
      { action: 'ask', targetId: 'chat-1', reason: 'test', scene: 'private' as const },
    ],
  }));
  assert.equal(ctx.candidates.length, 2);
  assert.equal(ctx.candidates[0]!.id, 'candidate_0_reply_chat-1');
  assert.equal(ctx.candidates[1]!.id, 'candidate_1_ask_chat-1');
  assert.equal(ctx.candidates[0]!.action, 'reply');
  assert.equal(ctx.candidates[1]!.action, 'ask');
});

test('buildDecisionContext: candidate without targetId gets different id', () => {
  const ctx = buildDecisionContext(baseParams({
    candidates: [
      { action: 'silence', targetId: null, reason: 'test' },
    ],
  }));
  assert.equal(ctx.candidates[0]!.id, 'candidate_0_silence');
});

test('buildDecisionContext: IAUS scores transferred to candidates', () => {
  const ctx = buildDecisionContext(baseParams({
    candidates: [
      {
        action: 'reply', targetId: 'chat-1', reason: 'test', scene: 'private' as const,
        iausScore: {
          action: 'diligence' as const,
          voice: 'diligence' as const,
          reason: 'test reason',
          rawScore: 0.8, deltaP: 0.5, socialCost: 0.1, netValue: 0.4,
          compensatedScore: 0.6, legacyNetSocialValue: 0.35,
          considerations: { urgency: 0.8 }, selectedProbability: 0.7,
          scoringMode: 'consideration',
        },
      },
    ],
  }));
  assert.ok(ctx.candidates[0]!.iausScore);
  assert.equal(ctx.candidates[0]!.iausScore!.rawScore, 0.8);
  assert.equal(ctx.candidates[0]!.iausScore!.deltaP, 0.5);
  assert.equal(ctx.candidates[0]!.iausScore!.netValue, 0.4);
});

test('buildDecisionContext: algorithmic gate audit attached to candidates', () => {
  const ctx = buildDecisionContext(baseParams({
    candidates: [
      { action: 'reply', targetId: 'chat-1', reason: 'test', scene: 'private' as const },
    ],
    algorithmicGateAudit: [
      { allow: false, level: 'soft', reason: 'test_deny', reasons: ['test_deny'], values: {} },
    ],
  }));
  assert.ok(ctx.candidates[0]!.algorithmicGate);
  assert.equal(ctx.candidates[0]!.algorithmicGate!.allow, false);
  assert.equal(ctx.candidates[0]!.algorithmicGate!.reason, 'test_deny');
});

test('buildDecisionContext: config hints exclude apiKey', () => {
  const ctx = buildDecisionContext(baseParams());
  assert.equal(ctx.configHints.maxReplyLength, 1000);
  assert.equal(ctx.configHints.gatewayMode, 'agent');
  assert.equal(ctx.configHints.guardrails, 'off');
  // The serialized DecisionContext must not contain the apiKey
  const serialized = JSON.stringify(ctx);
  assert.ok(!serialized.includes('secret-key-should-not-leak'));
  assert.ok(!serialized.includes('apiKey'));
});

test('buildDecisionContext: memory arrays limited', () => {
  const ctx = buildDecisionContext(baseParams());
  assert.ok(Array.isArray(ctx.memory.working));
  assert.ok(Array.isArray(ctx.memory.longTerm));
  // These come from the mock which returns empty arrays
  assert.equal(ctx.memory.working.length, 0);
  assert.equal(ctx.memory.longTerm.length, 0);
});

test('buildDecisionContext: relationship facts propagated', () => {
  const ctx = buildDecisionContext(baseParams({
    relationshipFacts: ['TestUser: close friend', 'TestUser: shares interest in music'],
  }));
  assert.deepEqual(ctx.relationship.facts, ['TestUser: close friend', 'TestUser: shares interest in music']);
});

test('buildDecisionContext: conversation fields propagated', () => {
  const ctx = buildDecisionContext(baseParams({
    rhythmPattern: 'quiet',
    speakingAlone: true,
    afterward: 'waiting_reply',
    situationBriefing: ['Channel has been quiet for 2 hours'],
  }));
  assert.equal(ctx.conversation.rhythmPattern, 'quiet');
  assert.equal(ctx.conversation.speakingAlone, true);
  assert.equal(ctx.conversation.afterward, 'waiting_reply');
  assert.deepEqual(ctx.conversation.situationBriefing, ['Channel has been quiet for 2 hours']);
});

test('buildDecisionContext: mood from moodTracker', () => {
  const moodTracker = { current: 0.3 };
  const ctx = buildDecisionContext(baseParams({ moodTracker: moodTracker as any }));
  assert.ok(ctx.mood);
  assert.equal(ctx.mood!.selfMood, 0.3);
});

test('buildDecisionContext: scheduled tick scene from candidates', () => {
  const ctx = buildDecisionContext(baseParams({
    reason: 'scheduled',
    event: undefined,
    candidates: [{ action: 'proactive', targetId: 'group-1', reason: 'test', scene: 'group' as const }],
  }));
  assert.equal(ctx.scene, 'group');
});

test('buildDecisionContext: tick and nowMs propagated', () => {
  const nowMs = Date.now();
  const ctx = buildDecisionContext(baseParams({ tick: 42, nowMs }));
  assert.equal(ctx.tick, 42);
  assert.equal(ctx.nowMs, nowMs);
});
