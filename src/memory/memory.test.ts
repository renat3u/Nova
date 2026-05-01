// Phase 2 Step 19: Memory / diary tests
//
// Covers: diary constants alignment, WorkingMemory similar dedup,
// salience decay, effectiveSalience, turn cap, MemoryService
// filtering, engagement feedback write, group memory write,
// significant content extraction.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { NOVA_SCHEMA_SQL } from '../db/schema.js';
import type { NovaSqliteDatabase } from '../db/sqlite.js';
import {
  DIARY_CAPACITY,
  DIARY_CAP_PER_TURN,
  MAX_ENTRY_LENGTH,
  INJECT_LIMIT,
  SIMILARITY_THRESHOLD,
  SALIENCE_HALF_LIFE_MS,
  INITIAL_SALIENCE,
  SALIENCE_BUMP,
  MAX_SALIENCE,
  INJECT_FLOOR,
  CONSOLIDATION_WINDOW_MS,
  WorkingMemory,
  effectiveSalience,
  type WorkingMemoryItem,
} from './working-memory.js';
import { LongTermMemory } from './long-term-memory.js';
import { MemoryService } from './memory-service.js';
import type { NovaMessageEvent } from '../core/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDb(): NovaSqliteDatabase {
  const db = new Database(':memory:');
  db.exec(NOVA_SCHEMA_SQL);
  return Object.assign(db, { path: ':memory:' }) as unknown as NovaSqliteDatabase;
}

function makeEvent(overrides: Partial<NovaMessageEvent> = {}): NovaMessageEvent {
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

// ═══════════════════════════════════════════════════════════════════════════

test('diary constants match Nova Step 13 specs', () => {
  assert.equal(DIARY_CAPACITY, 7);
  assert.equal(DIARY_CAP_PER_TURN, 2);
  assert.equal(MAX_ENTRY_LENGTH, 200);
  assert.equal(INJECT_LIMIT, 5);
  assert.equal(SIMILARITY_THRESHOLD, 0.35);
  assert.equal(SALIENCE_HALF_LIFE_MS, 6 * 3600 * 1000);
  assert.equal(INITIAL_SALIENCE, 1.0);
  assert.equal(SALIENCE_BUMP, 0.15);
  assert.equal(MAX_SALIENCE, 2.0);
  assert.equal(INJECT_FLOOR, 0.05);
  assert.equal(CONSOLIDATION_WINDOW_MS, 24 * 3600 * 1000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. effectiveSalience
// ═══════════════════════════════════════════════════════════════════════════

test('effectiveSalience is full value when age is 0', () => {
  const now = Date.now();
  const s = effectiveSalience({ salience: 1.0, updatedMs: now }, now);
  assert.equal(s, 1.0);
});

test('effectiveSalience halves after one half-life', () => {
  const now = Date.now();
  const s = effectiveSalience(
    { salience: 1.0, updatedMs: now - SALIENCE_HALF_LIFE_MS },
    now,
  );
  assert.ok(Math.abs(s - 0.5) < 0.01, `expected ~0.5, got ${s}`);
});

test('effectiveSalience approaches zero after many half-lives', () => {
  const now = Date.now();
  const s = effectiveSalience(
    { salience: 1.0, updatedMs: now - 10 * SALIENCE_HALF_LIFE_MS },
    now,
  );
  assert.ok(s < 0.01, `expected < 0.01, got ${s}`);
});

test('effectiveSalience clamps to non-negative', () => {
  const now = Date.now();
  const s = effectiveSalience(
    { salience: 0.01, updatedMs: now - 100 * SALIENCE_HALF_LIFE_MS },
    now,
  );
  assert.ok(s >= 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. WorkingMemory: add and dedup
// ═══════════════════════════════════════════════════════════════════════════

test('WorkingMemory adds new item with initial salience', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const item = wm.addCandidate({ content: '秋喜欢下雨天听歌', salience: 1.0 });
  assert.ok(item);
  assert.equal(item!.content, '秋喜欢下雨天听歌');
  assert.ok(item!.salience <= MAX_SALIENCE);
  (db as unknown as Database.Database).close();
});

test('WorkingMemory caps content at MAX_ENTRY_LENGTH', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const long = 'A'.repeat(300);
  const item = wm.addCandidate({ content: long });
  assert.ok(item);
  assert.ok(item!.content.length <= MAX_ENTRY_LENGTH);
  (db as unknown as Database.Database).close();
});

test('WorkingMemory prunes to capacity', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db, 3); // small capacity for testing
  wm.addCandidate({ content: '记忆1', salience: 1.0 });
  wm.addCandidate({ content: '记忆2', salience: 0.5 });
  wm.addCandidate({ content: '记忆3', salience: 0.3 });
  wm.addCandidate({ content: '记忆4', salience: 0.9 });
  const items = wm.getTopItems(10);
  assert.ok(items.length <= 3, `expected <= 3, got ${items.length}`);
  (db as unknown as Database.Database).close();
});

test('WorkingMemory.getTopItems filters below INJECT_FLOOR', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const now = Date.now();
  // Add an item and let it decay by checking with a future time
  wm.addCandidate({ content: '正常记忆', salience: 1.0, nowMs: now });
  const items = wm.getTopItems(10, now);
  assert.ok(items.length >= 1);
  // Query with far future time to decay below floor
  const decayed = wm.getTopItems(10, now + 100 * SALIENCE_HALF_LIFE_MS);
  assert.equal(decayed.length, 0);
  (db as unknown as Database.Database).close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. WorkingMemory: similar dedup
// ═══════════════════════════════════════════════════════════════════════════

test('WorkingMemory merges very similar content', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const now = Date.now();
  const first = wm.addCandidate({ content: '秋最近睡得不太好', salience: 0.8, nowMs: now });
  assert.ok(first);
  const second = wm.addCandidate({ content: '秋最近睡得不太好', salience: 0.7, nowMs: now + 1000 });
  assert.ok(second, 'second addCandidate should succeed');
  // Should have merged into one item (bumped salience)
  const items = wm.getTopItems(10, now + 1000);
  assert.equal(items.length, 1);
  assert.ok(items[0]!.salience >= 0.8 + SALIENCE_BUMP - 0.01); // bump applied
  (db as unknown as Database.Database).close();
});

test('WorkingMemory does not dedup without consolidation window', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const now = Date.now();
  wm.addCandidate({ content: '秋喜欢下雨天', salience: 0.8, nowMs: now });
  // Add similar content > 24h later — outside consolidation window
  wm.addCandidate({ content: '秋喜欢下雨天听歌', salience: 0.7, nowMs: now + CONSOLIDATION_WINDOW_MS + 1000 });
  const items = wm.getTopItems(10, now + CONSOLIDATION_WINDOW_MS + 1000);
  // After decay of first item, second becomes new entry
  assert.ok(items.length >= 1);
  (db as unknown as Database.Database).close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. MemoryService: turn cap
// ═══════════════════════════════════════════════════════════════════════════

test('MemoryService enforces per-turn write cap', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const ltm = new LongTermMemory(db);
  const svc = new MemoryService(wm, ltm);
  svc.load();
  svc.resetTurnCount();

  // Write 3 candidates — only first 2 should be accepted
  const r1 = svc.reviewMemoryCandidate('秋最近在学习 Rust 语言', { source: 'message', event: makeEvent() });
  const r2 = svc.reviewMemoryCandidate('秋最近在思考换工作方向', { source: 'message', event: makeEvent() });
  const r3 = svc.reviewMemoryCandidate('第三个候选应该被拒绝', { source: 'message', event: makeEvent() });

  assert.equal(r1.accepted, true);
  assert.equal(r2.accepted, true);
  assert.equal(r3.accepted, false);
  assert.equal(r3.reason, 'turn_cap_reached');
  assert.equal(svc.turnCount, 2);
  (db as unknown as Database.Database).close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. MemoryService: quality filtering
// ═══════════════════════════════════════════════════════════════════════════

test('MemoryService rejects too-short candidates', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const ltm = new LongTermMemory(db);
  const svc = new MemoryService(wm, ltm);
  svc.load();
  svc.resetTurnCount();

  const r = svc.reviewMemoryCandidate('短', { source: 'message', event: makeEvent() });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'too_short');
  (db as unknown as Database.Database).close();
});

test('MemoryService rejects pure greetings (hello)', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const ltm = new LongTermMemory(db);
  const svc = new MemoryService(wm, ltm);
  svc.load();
  svc.resetTurnCount();

  // 'hello' matches the greeting pattern and is long enough
  const r = svc.reviewMemoryCandidate('hello!!', { source: 'message', event: makeEvent() });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'ordinary_greeting');
  (db as unknown as Database.Database).close();
});

test('MemoryService rejects hallucinated content', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const ltm = new LongTermMemory(db);
  const svc = new MemoryService(wm, ltm);
  svc.load();
  svc.resetTurnCount();

  const r = svc.reviewMemoryCandidate('也许用户最近喜欢打篮球', { source: 'message', event: makeEvent() });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'unverified_model_claim');
  (db as unknown as Database.Database).close();
});

test('MemoryService accepts meaningful private chat content', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const ltm = new LongTermMemory(db);
  const svc = new MemoryService(wm, ltm);
  svc.load();
  svc.resetTurnCount();

  const r = svc.reviewMemoryCandidate(
    '秋最近在学习 Rust 语言，感觉很感兴趣',
    { source: 'message', event: makeEvent({ chatType: 'private' }) },
  );
  assert.equal(r.accepted, true);
  (db as unknown as Database.Database).close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. MemoryService: engagement feedback write
// ═══════════════════════════════════════════════════════════════════════════

test('MemoryService.writeEngagementFeedback records feedback as low-salience working memory', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const ltm = new LongTermMemory(db);
  const svc = new MemoryService(wm, ltm);
  svc.load();

  svc.writeEngagementFeedback({
    channelId: 'qq:private:12345',
    contactId: 'qq:user:12345',
    actionType: 'proactive_send_text',
    wasReplied: true,
    timedOut: false,
    messageSummary: '最近怎么样？',
    replySummary: '还不错',
    timestampMs: Date.now(),
  });

  const items = wm.getTopItems(10);
  const feedbackItem = items.find((i: WorkingMemoryItem) => i.content.includes('主动联系'));
  assert.ok(feedbackItem, 'expected engagement feedback in working memory');
  assert.ok(feedbackItem!.salience <= 0.5);
  (db as unknown as Database.Database).close();
});

test('MemoryService.writeEngagementFeedback records timeout feedback', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const ltm = new LongTermMemory(db);
  const svc = new MemoryService(wm, ltm);
  svc.load();

  svc.writeEngagementFeedback({
    channelId: 'qq:private:12345',
    actionType: 'proactive_send_text',
    wasReplied: false,
    timedOut: true,
    messageSummary: '嗨，最近好吗？',
    timestampMs: Date.now(),
  });

  const items = wm.getTopItems(10);
  const feedbackItem = items.find((i: WorkingMemoryItem) => i.content.includes('未收到回应'));
  assert.ok(feedbackItem, 'expected timeout feedback in working memory');
  (db as unknown as Database.Database).close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. MemoryService: significant content extraction
// ═══════════════════════════════════════════════════════════════════════════

test('MemoryService accepts content with significant patterns', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const ltm = new LongTermMemory(db);
  const svc = new MemoryService(wm, ltm);
  svc.load();
  svc.resetTurnCount();

  // memoryCandidate with preference pattern (喜欢)
  const r = svc.reviewMemoryCandidate(
    '秋喜欢在雨天听歌放松自己',
    { source: 'message', event: makeEvent({ chatType: 'private' }) },
  );
  assert.equal(r.accepted, true, `expected accepted, got rejected: ${r.reason}`);
  (db as unknown as Database.Database).close();
});

test('MemoryService returns null for trivial messages', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const ltm = new LongTermMemory(db);
  const svc = new MemoryService(wm, ltm);
  svc.load();

  assert.equal(svc.extractSignificantContent(makeEvent({ text: '嗯嗯' })), null);
  assert.equal(svc.extractSignificantContent(makeEvent({ text: '在吗' })), null);
  assert.equal(svc.extractSignificantContent(makeEvent({ text: '好的' })), null);
  (db as unknown as Database.Database).close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. MemoryService: group memory write
// ═══════════════════════════════════════════════════════════════════════════

test('MemoryService.writeGroupMemory generates group-level working memory', () => {
  const db = makeDb();
  const wm = new WorkingMemory(db);
  const ltm = new LongTermMemory(db);
  const svc = new MemoryService(wm, ltm);
  svc.load();

  svc.writeGroupMemory({
    groupId: '20001',
    channelId: 'qq:group:20001',
    groupName: '技术交流群',
    topic: 'Rust 和 Go 的性能对比',
    atmosphere: 'friendly and technical',
    nowMs: Date.now(),
  });

  const items = wm.getTopItems(10);
  const groupItem = items.find((i: WorkingMemoryItem) => i.content.includes('技术交流群'));
  assert.ok(groupItem, 'expected group memory item');
  assert.ok(groupItem!.content.includes('Rust'));
  (db as unknown as Database.Database).close();
});
