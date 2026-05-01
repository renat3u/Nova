// Phase 2 Step 19: Desire derivation tests
//
// Covers: desire type definitions, thresholds, MAX_DESIRES cap,
// urgency bands, message tick (empty), scheduled tick (full),
// thread-derived desires, desire sort order, P3 reconnect, P6 explore.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveDesires,
  DESIRE_THRESHOLDS,
  MAX_DESIRES,
  type Desire,
  type DesireType,
} from './desire.js';
import type { PressureSnapshot } from '../pressure/aggregate.js';
import type { NovaRuntimeConfig } from '../core/types.js';
import type { ThreadAttrs } from '../world/entities.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function baseConfig(): NovaRuntimeConfig {
  return {
    enabled: true, debug: false,
    llmBaseUrl: 'http://localhost', llmApiKey: '', llmModel: 'test',
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
    proactiveEnabled: false, proactiveWhitelistQQ: [],
    iausScoringMode: 'consideration', minProactiveUtility: 0.05, groupMinProactiveUtility: 0.08,
    iausCompensationFactor: 0.5, socialSafetyMidpoint: 0.45, socialSafetySlope: 0.15,
  };
}

function makePressure(overrides: Partial<PressureSnapshot> = {}): PressureSnapshot {
  return {
    tick: 1, createdMs: Date.now(),
    p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0,
    pProspect: 0, api: 5, apiPeak: 5,
    contributions: {},
    ...overrides,
  };
}

function makeThread(channelId: string, overrides: Partial<ThreadAttrs> = {}): ThreadAttrs {
  return {
    id: `thread:test:${channelId}`,
    entity_type: 'thread',
    channel_id: channelId,
    summary: '一个测试话题',
    status: 'open',
    w: 1.0,
    created_ms: Date.now(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════

test('desire types match Nova spec', () => {
  const expectedTypes: DesireType[] = [
    'fulfill_duty', 'reconnect', 'resolve_thread', 'reduce_backlog', 'explore',
  ];
  for (const t of expectedTypes) {
    assert.ok(Object.keys(DESIRE_THRESHOLDS).includes(t), `expected ${t} in thresholds`);
  }
});

test('desire thresholds match Nova Step 07 specs', () => {
  assert.equal(DESIRE_THRESHOLDS.fulfill_duty, 0.2);
  assert.equal(DESIRE_THRESHOLDS.reconnect, 0.3);
  assert.equal(DESIRE_THRESHOLDS.resolve_thread, 0.4);
  assert.equal(DESIRE_THRESHOLDS.reduce_backlog, 0.5);
  assert.equal(DESIRE_THRESHOLDS.explore, 0.3);
});

test('MAX_DESIRES matches Nova spec', () => {
  assert.equal(MAX_DESIRES, 10);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Message tick: no desires
// ═══════════════════════════════════════════════════════════════════════════

test('message tick produces no autonomous desires', () => {
  const pressure = makePressure({
    p3: 10, // P3 very high, but message tick should still be empty
    p6: 2,
    p5: 15,
  });
  const desires = deriveDesires({
    pressure,
    reason: 'message',
    config: baseConfig(),
  });
  assert.deepStrictEqual(desires, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. P3 reconnect desire
// ═══════════════════════════════════════════════════════════════════════════

test('P3 reconnect produces reconnect desire when above threshold', () => {
  const pressure = makePressure({
    p3: 4.5, // > 0.3 threshold
    contributions: {
      P3: { 'qq:private:12345': 4.5 },
    },
  });
  const desires = deriveDesires({
    pressure,
    reason: 'scheduled',
    config: baseConfig(),
  });
  const reconnect = desires.find((d: Desire) => d.type === 'reconnect');
  assert.ok(reconnect, 'expected reconnect desire');
  assert.equal(reconnect!.source, 'P3');
  assert.equal(reconnect!.pressureValue, 4.5);
  assert.ok(reconnect!.urgency === 'medium' || reconnect!.urgency === 'high');
});

test('P3 below threshold does not produce reconnect desire', () => {
  const pressure = makePressure({
    p3: 0.2,
    contributions: {
      P3: { 'qq:private:12345': 0.2 },
    },
  });
  const desires = deriveDesires({
    pressure,
    reason: 'scheduled',
    config: baseConfig(),
  });
  const reconnect = desires.find((d: Desire) => d.type === 'reconnect');
  assert.equal(reconnect, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. P6 curiosity → explore desire
// ═══════════════════════════════════════════════════════════════════════════

test('P6 curiosity produces explore desire when above threshold', () => {
  const pressure = makePressure({
    p6: 0.5, // > 0.3 threshold
    contributions: {
      P6: { 'qq:group:20001': 0.5 },
    },
  });
  const desires = deriveDesires({
    pressure,
    reason: 'scheduled',
    config: baseConfig(),
  });
  const explore = desires.find((d: Desire) => d.type === 'explore');
  assert.ok(explore, 'expected explore desire');
  assert.equal(explore!.source, 'P6');
});

test('P6 below threshold does not produce explore desire', () => {
  const pressure = makePressure({
    p6: 0.1,
    contributions: {},
  });
  const desires = deriveDesires({
    pressure,
    reason: 'scheduled',
    config: baseConfig(),
  });
  const explore = desires.find((d: Desire) => d.type === 'explore');
  assert.equal(explore, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. P5 fulfill_duty desire
// ═══════════════════════════════════════════════════════════════════════════

test('P5 fulfill_duty produces desire when above threshold', () => {
  const pressure = makePressure({
    p5: 12, // > 0.2 threshold
    contributions: {
      P5: { 'qq:private:12345': 12 },
    },
  });
  const desires = deriveDesires({
    pressure,
    reason: 'scheduled',
    config: baseConfig(),
  });
  const duty = desires.find((d: Desire) => d.type === 'fulfill_duty');
  assert.ok(duty, 'expected fulfill_duty desire');
  assert.equal(duty!.source, 'P5');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Urgency band calculation
// ═══════════════════════════════════════════════════════════════════════════

test('high urgency when pressure value is 3x+ the threshold', () => {
  const pressure = makePressure({
    p3: 1.0, // 1.0 / 0.3 = 3.33 >= 3.0
    contributions: { P3: { 'qq:private:12345': 1.0 } },
  });
  const desires = deriveDesires({
    pressure, reason: 'scheduled', config: baseConfig(),
  });
  const reconnect = desires.find((d: Desire) => d.type === 'reconnect');
  assert.ok(reconnect);
  assert.equal(reconnect!.urgency, 'high');
});

test('medium urgency when pressure value is 1.5x-3x the threshold', () => {
  const pressure = makePressure({
    p3: 0.5, // 0.5 / 0.3 = 1.67, between 1.5 and 3.0
    contributions: { P3: { 'qq:private:12345': 0.5 } },
  });
  const desires = deriveDesires({
    pressure, reason: 'scheduled', config: baseConfig(),
  });
  const reconnect = desires.find((d: Desire) => d.type === 'reconnect');
  assert.ok(reconnect);
  assert.equal(reconnect!.urgency, 'medium');
});

test('low urgency when pressure value just above threshold', () => {
  const pressure = makePressure({
    p3: 0.31, // just above 0.3, ratio < 1.5
    contributions: { P3: { 'qq:private:12345': 0.31 } },
  });
  const desires = deriveDesires({
    pressure, reason: 'scheduled', config: baseConfig(),
  });
  const reconnect = desires.find((d: Desire) => d.type === 'reconnect');
  assert.ok(reconnect);
  assert.equal(reconnect!.urgency, 'low');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Desires sorted by pressure value descending
// ═══════════════════════════════════════════════════════════════════════════

test('desires sorted by pressure value descending', () => {
  const pressure = makePressure({
    p1: 2, p3: 8, p5: 0.3, p6: 1.0,
    contributions: {
      P1: { 'qq:group:1': 2 },
      P3: { 'qq:private:a': 8 },
      P5: { 'qq:private:a': 0.3 },
      P6: { 'qq:group:2': 1.0 },
    },
  });
  const desires = deriveDesires({
    pressure, reason: 'scheduled', config: baseConfig(),
  });
  for (let i = 1; i < desires.length; i++) {
    assert.ok(
      desires[i - 1]!.pressureValue >= desires[i]!.pressureValue,
      `desire[${i - 1}].pressureValue ${desires[i - 1]!.pressureValue} >= desire[${i}].pressureValue ${desires[i]!.pressureValue}`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. MAX_DESIRES cap
// ═══════════════════════════════════════════════════════════════════════════

test('result limited to MAX_DESIRES', () => {
  // All five dimensions above threshold + thread desires
  const pressure = makePressure({
    p1: 5, p3: 5, p4: 5, p5: 5, p6: 5,
    contributions: {
      P1: { a: 5 }, P3: { b: 5 }, P4: { c: 5 }, P5: { d: 5 }, P6: { e: 5 },
    },
  });
  const threads = Array.from({ length: 20 }, (_, i) => makeThread(`qq:private:${i}`, {
    id: `thread:${i}`,
    summary: `话题 ${i}`,
    created_ms: Date.now() - 2 * 3600 * 1000, // 2h ago → triggers resolve_thread
  }));
  const desires = deriveDesires({
    pressure, reason: 'scheduled', config: baseConfig(),
    unresolvedThreads: threads,
    nowMs: Date.now(),
  });
  assert.ok(desires.length <= MAX_DESIRES,
    `expected <= ${MAX_DESIRES} desires, got ${desires.length}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Thread-derived desires (Step 14)
// ═══════════════════════════════════════════════════════════════════════════

test('active unresolved thread > 1h old produces resolve_thread desire', () => {
  const now = Date.now();
  const thread = makeThread('qq:private:12345', {
    id: 'thread:test:1',
    summary: '学习 Rust 的话题',
    status: 'open',
    w: 1.0,
    created_ms: now - 3 * 3600 * 1000, // 3h ago
  });
  const desires = deriveDesires({
    pressure: makePressure(),
    reason: 'scheduled',
    config: baseConfig(),
    unresolvedThreads: [thread],
    nowMs: now,
  });
  const resolveThread = desires.find((d: Desire) => d.type === 'resolve_thread');
  assert.ok(resolveThread, 'expected resolve_thread desire from old active thread');
  assert.equal(resolveThread!.source, 'thread');
});

test('thread with relevance 0.15~0.3 produces explore desire', () => {
  const now = Date.now();
  // w=0.5, created 2 days ago → relevance ≈ 0.5 * 0.5^(2/7) ≈ 0.5 * 0.82 ≈ 0.41 → too high
  // w=0.3, created 7 days ago → relevance ≈ 0.3 * 0.5^1 ≈ 0.15 → at threshold
  // w=0.35, created 6 days ago → relevance ≈ 0.35 * 0.5^(6/7) ≈ 0.35 * 0.55 ≈ 0.19
  const thread = makeThread('qq:private:12345', {
    id: 'thread:test:2',
    summary: '一个轻量话题',
    status: 'open',
    w: 0.35,
    created_ms: now - 6 * 24 * 3600 * 1000,
  });
  const desires = deriveDesires({
    pressure: makePressure(),
    reason: 'scheduled',
    config: baseConfig(),
    unresolvedThreads: [thread],
    nowMs: now,
  });
  const explore = desires.find((d: Desire) => d.type === 'explore' && d.source === 'thread');
  assert.ok(explore, 'expected explore desire from moderate-relevance thread');
});

test('closed thread does not produce desires', () => {
  const now = Date.now();
  const thread = makeThread('qq:private:12345', {
    status: 'closed',
  });
  const desires = deriveDesires({
    pressure: makePressure(),
    reason: 'scheduled',
    config: baseConfig(),
    unresolvedThreads: [thread],
    nowMs: now,
  });
  const threadDesires = desires.filter((d: Desire) => d.source === 'thread');
  assert.equal(threadDesires.length, 0);
});

test('thread without summary does not produce desires', () => {
  const now = Date.now();
  const thread = makeThread('qq:private:12345', {
    summary: '',
    created_ms: now - 3 * 3600 * 1000,
  });
  const desires = deriveDesires({
    pressure: makePressure(),
    reason: 'scheduled',
    config: baseConfig(),
    unresolvedThreads: [thread],
    nowMs: now,
  });
  const threadDesires = desires.filter((d: Desire) => d.source === 'thread');
  assert.equal(threadDesires.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Desire reason is human-readable
// ═══════════════════════════════════════════════════════════════════════════

test('desire reason includes type, urgency, value, and threshold', () => {
  const pressure = makePressure({
    p3: 0.45,
    contributions: { P3: { 'qq:private:12345': 0.45 } },
  });
  const desires = deriveDesires({
    pressure, reason: 'scheduled', config: baseConfig(),
  });
  const reconnect = desires.find((d: Desire) => d.type === 'reconnect');
  assert.ok(reconnect);
  assert.ok(reconnect!.reason.includes('reconnect'));
  assert.ok(reconnect!.reason.includes('0.450'));
  assert.ok(reconnect!.reason.includes('0.300')); // threshold
});
