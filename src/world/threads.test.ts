// Phase 2 Step 14: Narrative Threads tests
//
// Tests for thread lifecycle, relevance decay, beat creation,
// message-driven thread detection, and proactive desire derivation
// from unresolved threads.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { NOVA_SCHEMA_SQL } from '../db/schema';
import {
  computeThreadRelevance,
  isThreadActive,
  isThreadStale,
  isThreadDead,
  advanceThreadWeight,
  resolveThreadWeight,
  detectThreadFromMessage,
  createKernelBeat,
  createEngagementBeat,
  createAmbientBeat,
  createObservationBeat,
  createPrudenceBeat,
  proactiveBeatSummary,
  RELEVANCE_THRESHOLD,
  STALE_THRESHOLD,
  DECAY_HALF_LIFE_S,
  DEFAULT_THREAD_WEIGHT,
  KERNEL_BEAT_WEIGHT,
  ENGAGEMENT_BEAT_WEIGHT,
} from '../world/threads';
import { NovaWorldRepository } from '../world/repository';
import type { NovaSqliteDatabase } from '../db/sqlite';
import type { NovaMessageEvent } from '../core/types';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDb(): NovaSqliteDatabase {
  const db = new Database(':memory:');
  db.exec(NOVA_SCHEMA_SQL);
  return Object.assign(db, { path: ':memory:' }) as unknown as NovaSqliteDatabase;
}

function makeEvent(overrides: Partial<NovaMessageEvent> = {}): NovaMessageEvent {
  return {
    id: `test-event:${Date.now()}`,
    platform: 'qq',
    chatType: 'private',
    chatId: 'qq:private:12345',
    senderId: 'qq:user:12345',
    senderQQ: '12345',
    senderName: 'TestUser',
    text: '你好，最近怎么样？',
    rawText: '你好，最近怎么样？',
    messageId: `msg:${Date.now().toString(36)}`,
    rawMessageId: 1,
    isDirected: true,
    isSelf: false,
    mentionedSelf: true,
    repliedToSelf: false,
    timestamp: Date.now(),
    rawEvent: {},
    ...overrides,
  };
}

// ── Thread relevance and decay ─────────────────────────────────────────────

describe('thread relevance', () => {
  it('fresh thread has full weight', () => {
    const now = Date.now();
    const rel = computeThreadRelevance(1.0, now, now);
    assert.ok(rel > 0.99, `expected ~1.0, got ${rel}`);
  });

  it('decays after one half-life', () => {
    const now = Date.now();
    const created = now - DECAY_HALF_LIFE_S * 1000;
    const rel = computeThreadRelevance(1.0, created, now);
    assert.ok(Math.abs(rel - 0.5) < 0.01, `expected ~0.5, got ${rel}`);
  });

  it('decays to near zero after many half-lives', () => {
    const now = Date.now();
    const created = now - 10 * DECAY_HALF_LIFE_S * 1000;
    const rel = computeThreadRelevance(1.0, created, now);
    assert.ok(rel < 0.01, `expected < 0.01, got ${rel}`);
  });

  it('isThreadActive checks against RELEVANCE_THRESHOLD', () => {
    assert.equal(isThreadActive(0.5), true);
    assert.equal(isThreadActive(0.15), true);
    assert.equal(isThreadActive(0.14), false);
    assert.equal(isThreadActive(0), false);
  });

  it('isThreadStale checks middle band', () => {
    assert.equal(isThreadStale(0.30), true);
    assert.equal(isThreadStale(0.15), true);
    assert.equal(isThreadStale(0.075), false); // below half threshold
    assert.equal(isThreadStale(0.35), false);
  });

  it('isThreadDead checks below half threshold', () => {
    assert.equal(isThreadDead(0.07), true);
    assert.equal(isThreadDead(0.01), true);
    assert.equal(isThreadDead(0.08), false);
  });
});

// ── Thread weight operations ───────────────────────────────────────────────

describe('thread weight', () => {
  it('advanceThreadWeight bumps weight', () => {
    const w = advanceThreadWeight(1.0, 0.5);
    assert.ok(w > 1.0, `expected > 1.0, got ${w}`);
  });

  it('advanceThreadWeight respects cap', () => {
    const w = advanceThreadWeight(1.0, 10);
    assert.ok(w <= 3.0, `expected <= 3.0 (3x cap), got ${w}`);
  });

  it('resolveThreadWeight drops to residual', () => {
    const w = resolveThreadWeight(2.0);
    assert.ok(w < 0.2, `expected < 0.2, got ${w}`);
    assert.ok(w > 0, `expected > 0, got ${w}`);
  });

  it('DEFAULT_THREAD_WEIGHT is 1.0', () => {
    assert.equal(DEFAULT_THREAD_WEIGHT, 1.0);
  });

  it('KERNEL_BEAT_WEIGHT is 2.0', () => {
    assert.equal(KERNEL_BEAT_WEIGHT, 2.0);
  });

  it('ENGAGEMENT_BEAT_WEIGHT is 1.5', () => {
    assert.equal(ENGAGEMENT_BEAT_WEIGHT, 1.5);
  });
});

// ── Beat creation ──────────────────────────────────────────────────────────

describe('beat creation', () => {
  const now = Date.now();
  const threadId = 'thread:test:1';
  const channelId = 'qq:private:12345';

  it('kernel beat has correct type and operation', () => {
    const beat = createKernelBeat(threadId, channelId, '新话题开始', 'msg:1', now);
    assert.equal(beat.beat_type, 'kernel');
    assert.equal(beat.operation, 'begin_topic');
    assert.equal(beat.weight, 2.0);
    assert.equal(beat.thread_id, threadId);
    assert.equal(beat.channel_id, channelId);
  });

  it('engagement beat has correct type', () => {
    const beat = createEngagementBeat(threadId, channelId, 'Nova主动发言', 'msg:2', now);
    assert.equal(beat.beat_type, 'engagement');
    assert.equal(beat.operation, 'advance_topic');
    assert.equal(beat.weight, 1.5);
  });

  it('ambient beat has normal weight', () => {
    const beat = createAmbientBeat(threadId, channelId, '日常聊天', 'msg:3', now);
    assert.equal(beat.beat_type, 'ambient');
    assert.equal(beat.operation, 'advance_topic');
    assert.equal(beat.weight, 1.0);
  });

  it('observation beat has lower weight', () => {
    const beat = createObservationBeat(threadId, channelId, '观察记录', now);
    assert.equal(beat.beat_type, 'observation');
    assert.equal(beat.weight, 0.8);
  });

  it('prudence beat has low weight', () => {
    const beat = createPrudenceBeat(threadId, channelId, '谨慎收束', now);
    assert.equal(beat.beat_type, 'prudence');
    assert.equal(beat.operation, 'affect_thread');
    assert.equal(beat.weight, 0.5);
  });
});

// ── Thread detection from messages ─────────────────────────────────────────

describe('detectThreadFromMessage', () => {
  const now = Date.now();

  it('begins new thread for substantial directed message with no existing threads', () => {
    const result = detectThreadFromMessage({
      text: '最近我在学 Rust，感觉很有意思',
      isDirected: true,
      hasActiveConversation: true,
      existingUnresolvedThreadCount: 0,
      nowMs: now,
    });
    assert.equal(result.operation, 'begin_topic');
    assert.equal(result.isSubstantial, true);
  });

  it('advances existing thread when unresolved threads exist', () => {
    const result = detectThreadFromMessage({
      text: 'Rust 的所有权模型确实需要适应一下',
      isDirected: true,
      hasActiveConversation: true,
      existingUnresolvedThreadCount: 1,
      nowMs: now,
    });
    assert.equal(result.operation, 'advance_topic');
  });

  it('returns null for trivial messages', () => {
    const result = detectThreadFromMessage({
      text: '嗯嗯',
      isDirected: false,
      hasActiveConversation: false,
      existingUnresolvedThreadCount: 0,
      nowMs: now,
    });
    assert.equal(result.operation, null);
    assert.equal(result.isSubstantial, false);
  });

  it('returns null for pure greeting', () => {
    const result = detectThreadFromMessage({
      text: '在吗',
      isDirected: false,
      hasActiveConversation: false,
      existingUnresolvedThreadCount: 0,
      nowMs: now,
    });
    assert.equal(result.isSubstantial, false);
  });

  it('does not begin thread during cooldown', () => {
    const result = detectThreadFromMessage({
      text: '关于那个项目我有些想法想跟你讨论一下',
      isDirected: true,
      hasActiveConversation: true,
      existingUnresolvedThreadCount: 0,
      lastThreadCreatedMs: now - 60_000, // 1 min ago
      nowMs: now,
    });
    assert.equal(result.operation, null);
  });

  it('topic summary is truncated for long messages', () => {
    const longText = 'A'.repeat(200);
    const result = detectThreadFromMessage({
      text: longText,
      isDirected: true,
      hasActiveConversation: true,
      existingUnresolvedThreadCount: 0,
      nowMs: now,
    });
    assert.ok(result.topicSummary.length <= 123); // 120 + '…'
  });
});

// ── Proactive beat summary ─────────────────────────────────────────────────

describe('proactiveBeatSummary', () => {
  it('includes desire type and scene', () => {
    const summary = proactiveBeatSummary({
      desireType: 'reconnect',
      urgency: 'medium',
      scene: 'private',
    });
    assert.ok(summary.includes('私聊'), `expected 私聊 in "${summary}"`);
    assert.ok(summary.includes('重连'), `expected 重连 in "${summary}"`);
  });

  it('uses Chinese labels for group scene', () => {
    const summary = proactiveBeatSummary({
      desireType: 'explore',
      urgency: 'low',
      scene: 'group',
    });
    assert.ok(summary.includes('群聊'), `expected 群聊 in "${summary}"`);
    assert.ok(summary.includes('探索'), `expected 探索 in "${summary}"`);
  });
});

// ── Thread CRUD via repository ─────────────────────────────────────────────

describe('repository thread CRUD', () => {
  let db: NovaSqliteDatabase;
  let repo: NovaWorldRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new NovaWorldRepository(db);
    repo.loadWorld();
  });

  afterEach(() => {
    (db as unknown as Database.Database).close();
  });

  it('creates thread and writes kernel beat', () => {
    const now = Date.now();
    const thread = repo.createThread({
      channelId: 'qq:private:12345',
      summary: '学习 Rust 的话题',
      nowMs: now,
    });

    assert.equal(thread.status, 'open');
    assert.equal(thread.w, 1.0);
    assert.equal(thread.channel_id, 'qq:private:12345');

    // Beat should exist in DB.
    const beats = repo.getBeatsForThread(thread.id);
    assert.equal(beats.length, 1);
    assert.equal(beats[0]!.beat_type, 'kernel');
    assert.equal(beats[0]!.operation, 'begin_topic');
  });

  it('updates thread weight', () => {
    const now = Date.now();
    const thread = repo.createThread({
      channelId: 'qq:private:12345',
      summary: '测试话题',
      nowMs: now,
    });

    const updated = repo.updateThread(thread.id, { weightBump: 1.0 });
    assert.ok(updated);
    assert.ok(updated!.w > 1.0, `expected w > 1.0 after bump, got ${updated!.w}`);
  });

  it('resolves thread', () => {
    const now = Date.now();
    const thread = repo.createThread({
      channelId: 'qq:private:12345',
      summary: '已结束的话题',
      nowMs: now,
    });

    const resolved = repo.resolveThread(thread.id);
    assert.ok(resolved);
    assert.equal(resolved!.status, 'closed');
    assert.ok(resolved!.w < 0.2, `resolved weight should be < 0.2, got ${resolved!.w}`);
  });

  it('getActiveThreadsForChannel returns threads above relevance threshold', () => {
    const now = Date.now();
    const thread = repo.createThread({
      channelId: 'qq:private:12345',
      summary: '活跃线程',
      nowMs: now,
    });

    const active = repo.getActiveThreadsForChannel('qq:private:12345', now);
    assert.equal(active.length, 1);
    assert.equal(active[0]!.id, thread.id);
  });

  it('getActiveThreadsForChannel filters out resolved threads', () => {
    const now = Date.now();
    const thread = repo.createThread({
      channelId: 'qq:private:12345',
      summary: '已关闭线程',
      nowMs: now,
    });
    repo.resolveThread(thread.id);

    const active = repo.getActiveThreadsForChannel('qq:private:12345', now);
    assert.equal(active.length, 0);
  });

  it('getUnresolvedThreads returns all open threads', () => {
    const now = Date.now();
    repo.createThread({ channelId: 'qq:private:111', summary: '线程1', nowMs: now });
    repo.createThread({ channelId: 'qq:private:222', summary: '线程2', nowMs: now });

    const unresolved = repo.getUnresolvedThreads(now);
    assert.ok(unresolved.length >= 2);
    assert.ok(unresolved.every((t) => t.status === 'open'));
  });

  it('addBeat adds beat and updates thread weight', () => {
    const now = Date.now();
    const thread = repo.createThread({
      channelId: 'qq:private:12345',
      summary: '测试话题',
      nowMs: now,
    });

    const wBefore = thread.w;
    const beat = createEngagementBeat(thread.id, 'qq:private:12345', '后续发言', undefined, now + 1000);
    repo.addBeat(beat);

    const beats = repo.getBeatsForThread(thread.id);
    assert.equal(beats.length, 2); // kernel + engagement

    const updated = repo.world.getThread(thread.id);
    assert.ok(updated.w > wBefore);
  });
});

// ── Message event triggers thread detection ────────────────────────────────

describe('message event thread integration', () => {
  let db: NovaSqliteDatabase;
  let repo: NovaWorldRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new NovaWorldRepository(db);
    repo.loadWorld();
  });

  afterEach(() => {
    (db as unknown as Database.Database).close();
  });

  it('substantial message creates a thread', () => {
    const event = makeEvent({
      text: '最近我在思考要不要换一个技术方向，你有什么建议吗？',
      isDirected: true,
    });

    repo.applyMessageEvent(event);

    const threads = repo.world.getEntitiesByType('thread');
    assert.ok(threads.length >= 1, 'expected at least 1 thread to be created');

    const threadId = threads[0]!;
    const thread = repo.world.getThread(threadId);
    assert.equal(thread.status, 'open');
  });

  it('trivial message does not create a thread', () => {
    const event = makeEvent({
      text: '嗯',
      isDirected: false,
    });

    repo.applyMessageEvent(event);

    const threads = repo.world.getEntitiesByType('thread');
    assert.equal(threads.length, 0, 'expected no thread for trivial message');
  });

  it('second substantial message advances existing thread', () => {
    const event1 = makeEvent({
      text: '要不要一起去学 Rust？感觉挺有意思的',
      isDirected: true,
    });
    repo.applyMessageEvent(event1);

    const threadsBefore = repo.world.getEntitiesByType('thread').length;

    const event2 = makeEvent({
      text: 'Rust 确实不错，但我还在犹豫要不要投入时间',
      isDirected: true,
      messageId: 'msg:2',
      rawMessageId: 2,
      timestamp: Date.now() + 60_000,
    });
    repo.applyMessageEvent(event2);

    // Should not create a second thread (advances the first one)
    const threadsAfter = repo.world.getEntitiesByType('thread').length;
    assert.equal(threadsAfter, threadsBefore, 'should not create a new thread for follow-up message');
  });
});

// ── Thread constants alignment ─────────────────────────────────────────────

describe('thread constants alignment', () => {
  it('RELEVANCE_THRESHOLD matches Nova spec', () => {
    assert.equal(RELEVANCE_THRESHOLD, 0.15);
  });

  it('STALE_THRESHOLD equals 2 * RELEVANCE_THRESHOLD', () => {
    assert.equal(STALE_THRESHOLD, 2 * RELEVANCE_THRESHOLD);
  });

  it('DECAY_HALF_LIFE_S matches Nova spec', () => {
    assert.equal(DECAY_HALF_LIFE_S, 7 * 86400);
  });
});
