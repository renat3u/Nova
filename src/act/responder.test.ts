// todo2-step09: NovaResponder state writeback 集成测试
//
// 验证被动回复与主动消息路径中都正确调用 applyNovaStateUpdates，
// 并将结果带回 ReplyBuildResult / ProactiveBuildResult。
//
// 关键保证：
//   - stateUpdates 存在时被正确处理
//   - 无 stateUpdates 时不产生副作用
//   - 状态写回 rejected 不影响 text 返回
//   - 状态写回 throw 不影响 text 返回并记录错误
//   - result 中包含 accepted/rejected
//   - proactive 群聊 context 正确传入

import assert from 'node:assert/strict';
import { test, mock, afterEach } from 'node:test';
import Database from 'better-sqlite3';
import { NOVA_SCHEMA_SQL } from '../db/schema.js';
import type { NovaSqliteDatabase } from '../db/sqlite.js';
import { NovaWorldRepository } from '../world/repository.js';
import { MemoryService } from '../memory/memory-service.js';
import { WorkingMemory } from '../memory/working-memory.js';
import { LongTermMemory } from '../memory/long-term-memory.js';
import { MoodTracker } from '../engine/mood.js';
import { NovaResponder } from './responder.js';
import type { NovaResponderOptions } from './responder.js';
import { OpenAICompatibleLLMClient } from '../llm/client.js';
import type { NovaLLMResponse } from '../llm/response-schema.js';
import { DEFAULT_PERSONALITY_VECTOR, projectPersonalityVector } from '../personality/vector.js';
import type { NovaRuntimeConfig, NovaMessageEvent, NovaAction } from '../core/types.js';
import type { PressureSnapshot } from '../pressure/aggregate.js';
import type { VoiceSelectionResult } from '../voices/selection.js';

afterEach(() => {
  mock.reset();
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDb(): NovaSqliteDatabase {
  const db = new Database(':memory:');
  db.exec(NOVA_SCHEMA_SQL);
  return Object.assign(db, { path: ':memory:' }) as unknown as NovaSqliteDatabase;
}

function baseConfig(overrides: Partial<NovaRuntimeConfig> = {}): NovaRuntimeConfig {
  return {
    enabled: true, debug: false,
    llmBaseUrl: 'http://localhost', llmApiKey: 'test-key', llmModel: 'test',
    replyInGroupOnlyWhenMentioned: false,
    enablePrivateChat: true, enableGroupChat: true,
    enabledGroups: {}, quoteReply: false,
    maxReplyLength: 200, dbPath: ':memory:',
    minApiToSpeak: 0, directedMinApiToSpeak: 0,
    privateCooldownMs: 0, groupCooldownMs: 0,
    globalRateLimitPerMinute: 60, channelRateLimitPerMinute: 30, groupRateLimitPerMinute: 20,
    enableScheduledActions: true,
    floodWindowMs: 5000, floodMessageLimit: 10, userFloodMessageLimit: 5,
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

function makeServices() {
  const db = makeDb();
  const repository = new NovaWorldRepository(db);
  repository.loadWorld();
  const memoryService = new MemoryService(new WorkingMemory(db), new LongTermMemory(db));
  memoryService.load();
  const moodTracker = new MoodTracker(0);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  return { db, repository, memoryService, moodTracker, logger };
}

function makeResponderOptions(
  overrides: Partial<NovaResponderOptions> = {},
): NovaResponderOptions {
  const services = makeServices();
  return {
    config: baseConfig(),
    repository: services.repository,
    memoryService: services.memoryService,
    moodTracker: services.moodTracker,
    logger: services.logger,
    personality: projectPersonalityVector(DEFAULT_PERSONALITY_VECTOR),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<NovaMessageEvent> = {}): NovaMessageEvent {
  return {
    id: 'evt:1', platform: 'qq', rawEvent: {},
    messageId: 'msg:1', rawMessageId: 1,
    chatType: 'private', chatId: 'qq:private:test1',
    senderId: 'qq:user:test1', senderQQ: 'test1', senderName: '秋',
    text: '你好', rawText: '你好',
    timestamp: Date.now(),
    isSelf: false, mentionedSelf: false, repliedToSelf: false,
    isDirected: true,
    ...overrides,
  };
}

function baseVoice(selected: string = 'sociability'): VoiceSelectionResult {
  return {
    selected,
    loudness: { diligence: 0.2, curiosity: 0.2, sociability: 0.5, caution: 0.1 },
    probabilities: { diligence: 0.2, curiosity: 0.2, sociability: 0.5, caution: 0.1 },
    temperature: 0.2,
    fatigue: { diligence: 1, curiosity: 1, sociability: 1, caution: 1 },
    reasons: [],
    iausAction: selected === 'caution' ? null : selected,
  } as VoiceSelectionResult;
}

function replyText(action: NovaAction | null | undefined): string | undefined {
  return action?.type === 'send_text' ? action.text : undefined;
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

// ── Test 1: 被动回复有 stateUpdates 时调用 applyNovaStateUpdates ──────────

test('passive reply with stateUpdates correctly integrates state writeback', async () => {
  void mock.method(
    OpenAICompatibleLLMClient.prototype,
    'generateReply',
    async (): Promise<NovaLLMResponse> => ({
      text: '你好，秋！今天过得怎么样？',
      stateUpdates: [
        { type: 'self_mood', valence: 0.5, reason: 'warm greeting exchange' },
        { type: 'afterward', value: 'waiting_reply', reason: 'expecting response' },
      ],
    }),
  );

  const opts = makeResponderOptions();
  const responder = new NovaResponder(opts);

  const result = await responder.buildReplyAction({
    event: makeEvent({ text: '嗨Nova！' }),
    pressure: basePressure(),
    voice: baseVoice(),
  });

  assert.ok(result.action, 'should return an action');
  assert.equal(replyText(result.action), '你好，秋！今天过得怎么样？');
  assert.ok(result.stateWriteback, 'should include stateWriteback');
  assert.ok(result.stateWriteback!.accepted.length > 0, 'should have accepted updates');
  assert.ok(result.stateWriteback!.accepted.some(a => a.type === 'self_mood'), 'should accept self_mood');
  assert.ok(result.stateWriteback!.accepted.some(a => a.type === 'afterward'), 'should accept afterward');

  // Verify self_mood was actually persisted
  const persisted = opts.repository.getRuntimeState<{ valence: number }>('self_mood');
  assert.ok(persisted, 'self_mood should be persisted to runtime_state');
  assert.ok(typeof persisted!.valence === 'number');

  opts.repository.world.clear();
  (opts.repository as unknown as { db: { close: () => void } }).db?.close?.();
});

// ── Test 2: 主动回复有 stateUpdates 时调用 applyNovaStateUpdates ──────────

test('proactive reply with stateUpdates correctly integrates state writeback', async () => {
  void mock.method(
    OpenAICompatibleLLMClient.prototype,
    'generateProactive',
    async (): Promise<NovaLLMResponse> => ({
      text: '秋，最近怎么样？好久没聊了。',
      memoryCandidate: '秋是老朋友，最近联系较少',
      stateUpdates: [
        { type: 'self_mood', valence: 0.3, reason: 'reaching out proactively' },
        { type: 'afterward', value: 'waiting_reply' },
      ],
    }),
  );

  const opts = makeResponderOptions();
  const responder = new NovaResponder(opts);

  const result = await responder.buildProactiveAction({
    channelId: 'qq:private:test2',
    contactId: 'qq:user:test2',
    targetName: '秋',
    targetQQ: 'test2',
    scene: 'private',
    voice: baseVoice(),
    desireType: 'reconnect',
    desireUrgency: 'medium',
  });

  assert.ok(result.text, 'should return text');
  assert.equal(result.text, '秋，最近怎么样？好久没聊了。');
  assert.ok(result.memoryReviewed, 'should review memory candidate');
  assert.ok(result.stateWriteback, 'should include stateWriteback');
  assert.ok(result.stateWriteback!.accepted.length > 0, 'should have accepted updates');

  // verify self_mood uses proactive weight (0.1 vs 0.2)
  const moodEntry = result.stateWriteback!.accepted.find(a => a.type === 'self_mood');
  assert.ok(moodEntry, 'should have self_mood entry');
  const n = moodEntry!.normalized as Record<string, unknown>;
  // proactive weight = 0.1, target = 0.3 → 0 * 0.9 + 0.3 * 0.1 = 0.03
  assert.ok(Math.abs((n.after as number) - 0.03) < 0.01, 'proactive weight should be 0.1');

  opts.repository.world.clear();
  (opts.repository as unknown as { db: { close: () => void } }).db?.close?.();
});

// ── Test 3: 无 stateUpdates 时不产生副作用 ───────────────────────────────

test('passive reply without stateUpdates produces no side effects', async () => {
  void mock.method(
    OpenAICompatibleLLMClient.prototype,
    'generateReply',
    async (): Promise<NovaLLMResponse> => ({
      text: '好的，我了解了。',
      // no stateUpdates
    }),
  );

  const opts = makeResponderOptions();
  const responder = new NovaResponder(opts);

  const result = await responder.buildReplyAction({
    event: makeEvent(),
    pressure: basePressure(),
    voice: baseVoice(),
  });

  assert.ok(result.action, 'should return an action');
  assert.equal(replyText(result.action), '好的，我了解了。');
  assert.ok(result.stateWriteback, 'stateWriteback should exist');
  assert.equal(result.stateWriteback!.accepted.length, 0, 'no accepted without stateUpdates');
  assert.equal(result.stateWriteback!.rejected.length, 0, 'no rejected without stateUpdates');

  opts.repository.world.clear();
  (opts.repository as unknown as { db: { close: () => void } }).db?.close?.();
});

test('proactive reply without stateUpdates produces no side effects', async () => {
  void mock.method(
    OpenAICompatibleLLMClient.prototype,
    'generateProactive',
    async (): Promise<NovaLLMResponse> => ({
      text: '今天天气不错。',
      // no stateUpdates
    }),
  );

  const opts = makeResponderOptions();
  const responder = new NovaResponder(opts);

  const result = await responder.buildProactiveAction({
    channelId: 'qq:private:test3',
    contactId: 'qq:user:test3',
    targetName: '秋',
    targetQQ: 'test3',
    scene: 'private',
    voice: baseVoice(),
    desireType: 'curiosity',
    desireUrgency: 'low',
  });

  assert.ok(result.text, 'should return text');
  assert.ok(result.stateWriteback, 'stateWriteback should exist');
  assert.equal(result.stateWriteback!.accepted.length, 0);
  assert.equal(result.stateWriteback!.rejected.length, 0);

  opts.repository.world.clear();
  (opts.repository as unknown as { db: { close: () => void } }).db?.close?.();
});

// ── Test 4: state writeback rejected 不影响 text 返回 ────────────────────

test('passive reply still returns text when state updates are rejected', async () => {
  void mock.method(
    OpenAICompatibleLLMClient.prototype,
    'generateReply',
    async (): Promise<NovaLLMResponse> => ({
      text: '好的，没问题。',
      stateUpdates: [
        // invalid: missing required fields
        { type: 'self_mood' } as unknown as NonNullable<NovaLLMResponse['stateUpdates']>[number],
        // invalid: unknown type
        { type: 'set_pressure', p5: 10 } as unknown as NonNullable<NovaLLMResponse['stateUpdates']>[number],
        // invalid: afterward without channel (but channel IS present in context, so this is OK...)
        // Let's use an invalid afterward value instead
        { type: 'afterward', value: 'send_now' } as unknown as NonNullable<NovaLLMResponse['stateUpdates']>[number],
      ],
    }),
  );

  const opts = makeResponderOptions();
  const responder = new NovaResponder(opts);

  const result = await responder.buildReplyAction({
    event: makeEvent(),
    pressure: basePressure(),
    voice: baseVoice(),
  });

  // Critical: text MUST still be returned even though all stateUpdates are rejected
  assert.ok(result.action, 'should still return an action despite rejected stateUpdates');
  assert.equal(replyText(result.action), '好的，没问题。');
  assert.ok(result.stateWriteback, 'should still include stateWriteback');
  assert.equal(result.stateWriteback!.accepted.length, 0, 'all updates should be rejected');
  assert.ok(result.stateWriteback!.rejected.length > 0, 'should have rejected entries');

  opts.repository.world.clear();
  (opts.repository as unknown as { db: { close: () => void } }).db?.close?.();
});

test('proactive reply still returns text when state updates are rejected', async () => {
  void mock.method(
    OpenAICompatibleLLMClient.prototype,
    'generateProactive',
    async (): Promise<NovaLLMResponse> => ({
      text: '今天天气真好！',
      stateUpdates: [
        { type: 'unknown_type', data: 'test' } as unknown as NonNullable<NovaLLMResponse['stateUpdates']>[number],
      ],
    }),
  );

  const opts = makeResponderOptions();
  const responder = new NovaResponder(opts);

  const result = await responder.buildProactiveAction({
    channelId: 'qq:private:test4',
    contactId: 'qq:user:test4',
    targetName: '秋',
    targetQQ: 'test4',
    scene: 'private',
    voice: baseVoice(),
    desireType: 'smalltalk',
    desireUrgency: 'low',
  });

  assert.ok(result.text, 'should return text even with rejected stateUpdates');
  assert.equal(result.text, '今天天气真好！');
  assert.ok(result.stateWriteback);
  assert.equal(result.stateWriteback!.accepted.length, 0);
  assert.ok(result.stateWriteback!.rejected.length > 0);

  opts.repository.world.clear();
  (opts.repository as unknown as { db: { close: () => void } }).db?.close?.();
});

// ── Test 5: state writeback throw 时不影响 text 返回，并记录错误 ──────────

test('passive reply still returns text when state writeback throws', async () => {
  void mock.method(
    OpenAICompatibleLLMClient.prototype,
    'generateReply',
    async (): Promise<NovaLLMResponse> => ({
      text: '嗨，有什么事吗？',
      stateUpdates: [
        // self_mood triggers moodTracker.getCurrent() which will throw
        { type: 'self_mood', valence: 0.3 },
      ],
    }),
  );

  // Create a moodTracker whose getCurrent() throws
  const crashTracker = new MoodTracker(0);
  void mock.method(crashTracker, 'getCurrent', () => {
    throw new Error('simulated mood tracker crash');
  });

  const opts = makeResponderOptions({ moodTracker: crashTracker as unknown as MoodTracker });
  const responder = new NovaResponder(opts);

  const result = await responder.buildReplyAction({
    event: makeEvent(),
    pressure: basePressure(),
    voice: baseVoice(),
  });

  // Critical: text MUST be returned despite the writeback crash
  assert.ok(result.action, 'should return action even when writeback throws');
  assert.equal(replyText(result.action), '嗨，有什么事吗？');

  // The safeApplyStateUpdates should catch the exception and return rejected
  assert.ok(result.stateWriteback, 'should include stateWriteback even on crash');
  assert.equal(result.stateWriteback!.accepted.length, 0, 'no updates should be accepted');
  assert.ok(
    result.stateWriteback!.rejected.some(r => r.reason === 'writeback_exception'),
    'should record writeback_exception in rejected',
  );

  opts.repository.world.clear();
  (opts.repository as unknown as { db: { close: () => void } }).db?.close?.();
});

// ── Test 6: result 中包含 accepted/rejected ─────────────────────────────━

test('passive reply result contains full accepted/rejected structure', async () => {
  void mock.method(
    OpenAICompatibleLLMClient.prototype,
    'generateReply',
    async (): Promise<NovaLLMResponse> => ({
      text: '你好！很高兴见到你。',
      stateUpdates: [
        { type: 'self_mood', valence: 0.6, arousal: 0.7, reason: 'positive encounter' },
        { type: 'memory_note', content: '秋今天第一次打招呼', salience: 0.5 },
      ],
    }),
  );

  const opts = makeResponderOptions();
  const responder = new NovaResponder(opts);

  const result = await responder.buildReplyAction({
    event: makeEvent({ text: '你好，Nova！' }),
    pressure: basePressure(),
    voice: baseVoice(),
  });

  assert.ok(result.action);
  assert.ok(result.stateWriteback);

  // Verify accepted structure
  const accepted = result.stateWriteback!.accepted;
  assert.ok(accepted.length > 0);
  for (const a of accepted) {
    assert.ok(typeof a.type === 'string', 'accepted entry must have type');
    assert.ok(typeof a.effect === 'string', 'accepted entry must have effect');
    assert.ok(a.effect.length > 0, 'effect must be non-empty');
    assert.ok(a.normalized !== undefined, 'accepted entry must have normalized');
  }

  // Verify rejected structure
  const rejected = result.stateWriteback!.rejected;
  assert.ok(Array.isArray(rejected));
  for (const r of rejected) {
    assert.ok(typeof r.reason === 'string', 'rejected entry must have reason');
    assert.ok(r.reason.length > 0, 'rejected reason must be non-empty');
    assert.ok(r.raw !== undefined, 'rejected entry must have raw for audit');
  }

  // Verify top-level fields
  assert.ok(
    result.stateWriteback!.selfMoodBefore !== undefined || result.stateWriteback!.selfMoodAfter !== undefined,
    'should have mood deltas',
  );

  opts.repository.world.clear();
  (opts.repository as unknown as { db: { close: () => void } }).db?.close?.();
});

test('proactive reply result contains full accepted/rejected structure', async () => {
  void mock.method(
    OpenAICompatibleLLMClient.prototype,
    'generateProactive',
    async (): Promise<NovaLLMResponse> => ({
      text: '秋，最近项目进展如何？',
      stateUpdates: [
        { type: 'afterward', value: 'waiting_reply' },
      ],
    }),
  );

  const opts = makeResponderOptions();
  const responder = new NovaResponder(opts);

  const result = await responder.buildProactiveAction({
    channelId: 'qq:private:test6',
    contactId: 'qq:user:test6',
    targetName: '秋',
    targetQQ: 'test6',
    scene: 'private',
    voice: baseVoice(),
    desireType: 'reconnect',
    desireUrgency: 'medium',
  });

  assert.ok(result.text);
  assert.ok(result.stateWriteback);

  // result.afterward should be set from the top-level field
  assert.equal(result.stateWriteback!.afterward, 'waiting_reply');

  const accepted = result.stateWriteback!.accepted;
  assert.ok(accepted.length > 0);
  assert.ok(accepted.some(a => a.type === 'afterward'));

  opts.repository.world.clear();
  (opts.repository as unknown as { db: { close: () => void } }).db?.close?.();
});

// ── Test 7: proactive 群聊 context 正确传入 source: 'proactive' 和 isGroup

test('proactive group context passes source=proactive and isGroup=true', async () => {
  // We verify the context is correct by checking the actual behavior:
  // - proactive + isGroup → self_mood uses weight 0.1 (vs 0.2 for reply)
  // - proactive + isGroup → waiting_reply afterward is rejected

  void mock.method(
    OpenAICompatibleLLMClient.prototype,
    'generateProactive',
    async (): Promise<NovaLLMResponse> => ({
      text: '大家下午好！',
      stateUpdates: [
        { type: 'self_mood', valence: 0.5, reason: 'group greeting' },
        { type: 'afterward', value: 'waiting_reply' },
        { type: 'afterward', value: 'watching' },
      ],
    }),
  );

  const opts = makeResponderOptions();
  const responder = new NovaResponder(opts);

  const result = await responder.buildProactiveAction({
    channelId: 'qq:group:test7',
    contactId: 'qq:user:test7',
    targetName: '秋',
    targetQQ: 'test7',
    scene: 'group',
    voice: baseVoice(),
    desireType: 'smalltalk',
    desireUrgency: 'low',
  });

  assert.ok(result.text, 'should return text');
  assert.equal(result.text, '大家下午好！');
  assert.ok(result.stateWriteback);

  // waiting_reply should be rejected in proactive group context
  const wrRejected = result.stateWriteback!.rejected.some(
    r => r.type === 'afterward' && r.reason === 'proactive_group_waiting_reply_not_allowed',
  );
  assert.ok(wrRejected, 'waiting_reply must be rejected in proactive group');

  // watching should be accepted in proactive group
  const watchingAccepted = result.stateWriteback!.accepted.some(
    a => a.type === 'afterward',
  );
  assert.ok(watchingAccepted, 'watching should be accepted in proactive group');

  // self_mood should use proactive weight (0.1)
  const moodEntry = result.stateWriteback!.accepted.find(a => a.type === 'self_mood');
  assert.ok(moodEntry, 'self_mood should be accepted');
  const n = moodEntry!.normalized as Record<string, unknown>;
  // proactive weight = 0.1, target = 0.5 → 0 * 0.9 + 0.5 * 0.1 = 0.05
  assert.ok(Math.abs((n.after as number) - 0.05) < 0.01, 'proactive weight should be 0.1');

  opts.repository.world.clear();
  (opts.repository as unknown as { db: { close: () => void } }).db?.close?.();
});

test('proactive private context passes source=proactive and isGroup=false', async () => {
  void mock.method(
    OpenAICompatibleLLMClient.prototype,
    'generateProactive',
    async (): Promise<NovaLLMResponse> => ({
      text: '想你了，最近还好吗？',
      stateUpdates: [
        { type: 'afterward', value: 'waiting_reply' },
      ],
    }),
  );

  const opts = makeResponderOptions();
  const responder = new NovaResponder(opts);

  const result = await responder.buildProactiveAction({
    channelId: 'qq:private:test7b',
    contactId: 'qq:user:test7b',
    targetName: '秋',
    targetQQ: 'test7b',
    scene: 'private',
    voice: baseVoice(),
    desireType: 'reconnect',
    desireUrgency: 'high',
  });

  assert.ok(result.text);
  // waiting_reply should be ACCEPTED in proactive private (not group)
  const wrAccepted = result.stateWriteback!.accepted.some(
    a => a.type === 'afterward' && (a.normalized as Record<string, unknown>).value === 'waiting_reply',
  );
  assert.ok(wrAccepted, 'waiting_reply should be accepted in proactive private chat');

  opts.repository.world.clear();
  (opts.repository as unknown as { db: { close: () => void } }).db?.close?.();
});

// ── Supplementary: without moodTracker, safeApplyStateUpdates returns empty ─

test('responder without moodTracker still returns text (no crash)', async () => {
  void mock.method(
    OpenAICompatibleLLMClient.prototype,
    'generateReply',
    async (): Promise<NovaLLMResponse> => ({
      text: 'Hello!',
      stateUpdates: [
        { type: 'self_mood', valence: 0.5 },
      ],
    }),
  );

  // No moodTracker
  const opts = makeResponderOptions({ moodTracker: undefined });
  const responder = new NovaResponder(opts);

  const result = await responder.buildReplyAction({
    event: makeEvent(),
    pressure: basePressure(),
    voice: baseVoice(),
  });

  assert.ok(result.action, 'should return action without moodTracker');
  assert.equal(replyText(result.action), 'Hello!');
  assert.ok(result.stateWriteback, 'should include stateWriteback');
  assert.equal(result.stateWriteback!.accepted.length, 0, 'no accepted without moodTracker');
  assert.equal(result.stateWriteback!.rejected.length, 0, 'no rejected without moodTracker');

  opts.repository.world.clear();
  (opts.repository as unknown as { db: { close: () => void } }).db?.close?.();
});
