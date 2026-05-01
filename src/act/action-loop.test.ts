// Phase 2 Step 19: Action queue and engagement tests
//
// Covers: ActionQueue lifecycle (enqueue/dequeue/mark states),
// EngagementSM state machine, MAX_CONCURRENT_ENGAGEMENTS,
// SWITCH_COST_MS, canCreateEngagement, hasWaitingEngagement.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionQueue } from './action-queue.js';
import {
  EngagementSM,
  MAX_CONCURRENT_ENGAGEMENTS,
  SWITCH_COST_MS,
  DEFAULT_ENGAGEMENT_TIMEOUT_MS,
  countActiveEngagements,
  canCreateEngagement,
  hasWaitingEngagement,
  type EngagementRecord,
} from './engagement.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    action: 'sociability',
    targetId: 'qq:private:12345',
    desireType: 'reconnect',
    urgency: 'medium',
    scene: 'private' as const,
    reason: 'test candidate',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. ActionQueue: enqueue
// ═══════════════════════════════════════════════════════════════════════════

test('enqueue adds item with queued status', () => {
  const queue = new ActionQueue();
  const item = queue.enqueue(makeCandidate(), 1, 1000, 'test');
  assert.ok(item);
  assert.equal(item!.status, 'queued');
  assert.equal(item!.tick, 1);
  assert.equal(item!.enqueuedMs, 1000);
  assert.equal(queue.pendingCount, 1);
});

test('enqueue returns null when queue is full', () => {
  const queue = new ActionQueue(3);
  queue.enqueue(makeCandidate({ targetId: 'a' }), 1);
  queue.enqueue(makeCandidate({ targetId: 'b' }), 2);
  queue.enqueue(makeCandidate({ targetId: 'c' }), 3);
  const overflow = queue.enqueue(makeCandidate({ targetId: 'd' }), 4);
  assert.equal(overflow, null);
  assert.equal(queue.size, 3);
});

test('enqueue increments id', () => {
  const queue = new ActionQueue();
  const a = queue.enqueue(makeCandidate(), 1);
  const b = queue.enqueue(makeCandidate(), 2);
  assert.ok(a!.id !== b!.id);
  assert.ok(b, 'second enqueue should succeed');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. ActionQueue: dequeue
// ═══════════════════════════════════════════════════════════════════════════

test('dequeue returns first queued item', () => {
  const queue = new ActionQueue();
  const a = queue.enqueue(makeCandidate({ targetId: 'a' }), 1);
  const b = queue.enqueue(makeCandidate({ targetId: 'b' }), 2);
  assert.ok(b);
  const dequeued = queue.dequeue();
  assert.ok(dequeued);
  assert.equal(dequeued!.id, a!.id);
  assert.equal(queue.pendingCount, 1);
});

test('dequeue returns null when queue empty', () => {
  const queue = new ActionQueue();
  assert.equal(queue.dequeue(), null);
});

test('dequeue skips executing items', () => {
  const queue = new ActionQueue();
  const a = queue.enqueue(makeCandidate({ targetId: 'a' }), 1);
  const b = queue.enqueue(makeCandidate({ targetId: 'b' }), 2);
  queue.markExecuting(a!.id);
  const dequeued = queue.dequeue();
  assert.equal(dequeued!.id, b!.id);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ActionQueue: mark states
// ═══════════════════════════════════════════════════════════════════════════

test('markExecuting transitions from queued only', () => {
  const queue = new ActionQueue();
  const item = queue.enqueue(makeCandidate(), 1);
  assert.equal(queue.markExecuting(item!.id), true);
  assert.equal(queue.markExecuting(item!.id), false); // already executing
});

test('markDone transitions from executing only', () => {
  const queue = new ActionQueue();
  const item = queue.enqueue(makeCandidate(), 1);
  queue.markExecuting(item!.id);
  assert.equal(queue.markDone(item!.id), true);
  const listed = queue.list();
  assert.equal(listed[0]!.status, 'done');
  assert.ok(listed[0]!.completedMs);
});

test('markFailed sets error message', () => {
  const queue = new ActionQueue();
  const item = queue.enqueue(makeCandidate(), 1);
  queue.markExecuting(item!.id);
  queue.markFailed(item!.id, 'send error');
  const listed = queue.list();
  assert.equal(listed[0]!.status, 'failed');
  assert.equal(listed[0]!.error, 'send error');
});

test('markFailed on non-executing returns false', () => {
  const queue = new ActionQueue();
  const item = queue.enqueue(makeCandidate(), 1);
  assert.equal(queue.markFailed(item!.id, 'err'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. ActionQueue: clear / remove
// ═══════════════════════════════════════════════════════════════════════════

test('clearQueued removes only queued items', () => {
  const queue = new ActionQueue();
  const a = queue.enqueue(makeCandidate({ targetId: 'a' }), 1);
  queue.enqueue(makeCandidate({ targetId: 'b' }), 2);
  queue.markExecuting(a!.id);
  queue.clearQueued();
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.size, 1); // executing item preserved
});

test('clearQueuedCount returns number removed', () => {
  const queue = new ActionQueue();
  queue.enqueue(makeCandidate(), 1);
  queue.enqueue(makeCandidate(), 2);
  queue.enqueue(makeCandidate(), 3);
  const removed = queue.clearQueuedCount();
  assert.equal(removed, 3);
  assert.equal(queue.pendingCount, 0);
});

test('clear removes everything', () => {
  const queue = new ActionQueue();
  queue.enqueue(makeCandidate(), 1);
  queue.enqueue(makeCandidate(), 2);
  queue.clear();
  assert.equal(queue.size, 0);
});

test('removeByTarget removes queued items for specific target', () => {
  const queue = new ActionQueue();
  queue.enqueue(makeCandidate({ targetId: 'x' }), 1);
  queue.enqueue(makeCandidate({ targetId: 'x' }), 2);
  queue.enqueue(makeCandidate({ targetId: 'y' }), 3);
  const removed = queue.removeByTarget('x');
  assert.equal(removed, 2);
  assert.equal(queue.pendingCount, 1); // only 'y' remains
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. ActionQueue: list / peek / properties
// ═══════════════════════════════════════════════════════════════════════════

test('peek returns next queued without removing', () => {
  const queue = new ActionQueue();
  const item = queue.enqueue(makeCandidate(), 1);
  const peeked = queue.peek();
  assert.equal(peeked!.id, item!.id);
  assert.equal(queue.pendingCount, 1); // still there
});

test('listPending returns only queued items', () => {
  const queue = new ActionQueue();
  const a = queue.enqueue(makeCandidate({ targetId: 'a' }), 1);
  queue.enqueue(makeCandidate({ targetId: 'b' }), 2);
  queue.markExecuting(a!.id);
  const pending = queue.listPending();
  assert.equal(pending.length, 1);
});

test('pendingCount and size reflect state correctly', () => {
  const queue = new ActionQueue();
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.size, 0);
  queue.enqueue(makeCandidate(), 1);
  queue.enqueue(makeCandidate(), 2);
  assert.equal(queue.pendingCount, 2);
  assert.equal(queue.size, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. EngagementSM: constants
// ═══════════════════════════════════════════════════════════════════════════

test('MAX_CONCURRENT_ENGAGEMENTS matches Nova spec', () => {
  assert.equal(MAX_CONCURRENT_ENGAGEMENTS, 3);
});

test('SWITCH_COST_MS matches Nova spec', () => {
  assert.equal(SWITCH_COST_MS, 1500);
});

test('DEFAULT_ENGAGEMENT_TIMEOUT_MS is 24 hours', () => {
  assert.equal(DEFAULT_ENGAGEMENT_TIMEOUT_MS, 24 * 60 * 60 * 1000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. EngagementSM: create
// ═══════════════════════════════════════════════════════════════════════════

test('EngagementSM.create produces record in waiting state for proactive', () => {
  const now = Date.now();
  const record = EngagementSM.create({
    channelId: 'qq:private:12345',
    contactId: 'qq:user:12345',
    kind: 'proactive_action',
    proactiveActionId: 'q:1',
    nowMs: now,
  });
  assert.equal(record.state, 'waiting');
  assert.equal(record.watcherKind, 'waiting_reply');
  assert.equal(record.count, 1);
  assert.ok(record.startedMs === now);
  assert.ok(record.timeoutMs !== undefined);
  assert.ok(record.timeoutMs! > now);
});

test('EngagementSM.create for non-proactive starts in ready', () => {
  const now = Date.now();
  const record = EngagementSM.create({
    channelId: 'qq:private:12345',
    contactId: 'qq:user:12345',
    kind: 'incoming_message',
    nowMs: now,
  });
  assert.equal(record.state, 'ready');
  assert.equal(record.timeoutMs, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. EngagementSM: resolve / transition
// ═══════════════════════════════════════════════════════════════════════════

test('EngagementSM.resolveReplied transitions to done with replied outcome', () => {
  const now = Date.now();
  const record = EngagementSM.create({
    channelId: 'qq:private:12345', contactId: 'qq:user:12345',
    kind: 'proactive_action', nowMs: now,
  });
  const resolved = EngagementSM.resolveReplied(record, 'msg:reply', now + 60000);
  assert.equal(resolved.state, 'done');
  assert.equal(resolved.outcome, 'replied');
  assert.equal(resolved.replyMessageId, 'msg:reply');
});

test('EngagementSM.resolveTimeout transitions to done with timeout outcome', () => {
  const now = Date.now();
  const record = EngagementSM.create({
    channelId: 'qq:private:12345', contactId: 'qq:user:12345',
    kind: 'proactive_action', nowMs: now,
  });
  const resolved = EngagementSM.resolveTimeout(record, now + DEFAULT_ENGAGEMENT_TIMEOUT_MS);
  assert.equal(resolved.state, 'done');
  assert.equal(resolved.outcome, 'timeout');
});

test('EngagementSM.resolveDone transitions to done', () => {
  const now = Date.now();
  const record = EngagementSM.create({
    channelId: 'qq:private:12345', contactId: null,
    kind: 'nova_action', nowMs: now,
  });
  const resolved = EngagementSM.resolveDone(record, now + 1000);
  assert.equal(resolved.outcome, 'done');
});

test('EngagementSM.resolveFailed sets error', () => {
  const now = Date.now();
  const record = EngagementSM.create({
    channelId: 'qq:private:12345', contactId: null,
    kind: 'proactive_action', nowMs: now,
  });
  const resolved = EngagementSM.resolveFailed(record, 'send failed', now + 1000);
  assert.equal(resolved.outcome, 'failed');
  assert.equal(resolved.error, 'send failed');
});

test('EngagementSM.abort sets aborted outcome', () => {
  const now = Date.now();
  const record = EngagementSM.create({
    channelId: 'qq:private:12345', contactId: null,
    kind: 'proactive_action', nowMs: now,
  });
  const resolved = EngagementSM.abort(record, 'proactive disabled', now + 1000);
  assert.equal(resolved.outcome, 'aborted');
  assert.equal(resolved.error, 'proactive disabled');
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. EngagementSM: status queries
// ═══════════════════════════════════════════════════════════════════════════

test('EngagementSM.isActive returns false for done', () => {
  const now = Date.now();
  const record = EngagementSM.create({
    channelId: 'qq:private:12345', contactId: null,
    kind: 'proactive_action', nowMs: now,
  });
  assert.equal(EngagementSM.isActive(record), true);
  const resolved = EngagementSM.resolveDone(record, now + 1000);
  assert.equal(EngagementSM.isActive(resolved), false);
});

test('EngagementSM.isWaitingReply checks state and timeout', () => {
  const now = Date.now();
  const record = EngagementSM.create({
    channelId: 'qq:private:12345', contactId: null,
    kind: 'proactive_action', nowMs: now, timeoutMs: 3600000,
  });
  assert.equal(EngagementSM.isWaitingReply(record, now), true);
  assert.equal(EngagementSM.isWaitingReply(record, now + 7200000), false); // past timeout
});

test('EngagementSM.hasTimedOut detects timeout', () => {
  const now = Date.now();
  const record = EngagementSM.create({
    channelId: 'qq:private:12345', contactId: null,
    kind: 'proactive_action', nowMs: now, timeoutMs: 1000,
  });
  assert.equal(EngagementSM.hasTimedOut(record, now + 2000), true);
  assert.equal(EngagementSM.hasTimedOut(record, now), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. EngagementSM: validateTransition
// ═══════════════════════════════════════════════════════════════════════════

test('validateTransition rejects done → anything', () => {
  const err = EngagementSM.validateTransition('done', 'waiting');
  assert.ok(err);
  assert.ok(err.includes('terminal'));
});

test('validateTransition allows valid transitions', () => {
  assert.equal(EngagementSM.validateTransition('ready', 'waiting'), null);
  assert.equal(EngagementSM.validateTransition('ready', 'done'), null);
  assert.equal(EngagementSM.validateTransition('waiting', 'done'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Engagement query helpers
// ═══════════════════════════════════════════════════════════════════════════

test('countActiveEngagements counts non-done records', () => {
  const now = Date.now();
  const r1 = EngagementSM.create({ channelId: 'ch1', contactId: null, kind: 'proactive_action', nowMs: now });
  const r2 = EngagementSM.create({ channelId: 'ch2', contactId: null, kind: 'proactive_action', nowMs: now });
  const r3 = EngagementSM.resolveDone(r2, now + 1000);
  assert.equal(countActiveEngagements([r1, r3]), 1);
});

test('canCreateEngagement respects MAX_CONCURRENT_ENGAGEMENTS', () => {
  const now = Date.now();
  const records: EngagementRecord[] = [
    EngagementSM.create({ channelId: 'ch1', contactId: null, kind: 'proactive_action', nowMs: now }),
    EngagementSM.create({ channelId: 'ch2', contactId: null, kind: 'proactive_action', nowMs: now }),
    EngagementSM.create({ channelId: 'ch3', contactId: null, kind: 'proactive_action', nowMs: now }),
  ];
  assert.equal(canCreateEngagement(records), false);
  assert.equal(canCreateEngagement(records.slice(0, 2)), true);
});

test('hasWaitingEngagement detects existing waiting for same channel', () => {
  const now = Date.now();
  const records = [
    EngagementSM.create({ channelId: 'qq:private:12345', contactId: null, kind: 'proactive_action', nowMs: now }),
  ];
  assert.equal(hasWaitingEngagement(records, 'qq:private:12345', now), true);
  assert.equal(hasWaitingEngagement(records, 'qq:private:99999', now), false);
});
