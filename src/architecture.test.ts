// Phase 7: 架构迁移测试 — EventBuffer / ActionQueue / TickClock / ModeFSM / 集成
//
// 验证 Nova tick 机制完全对齐 Alice 后的核心组件行为。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NovaEventBuffer } from './core/event-buffer.js';
import { ActionQueue } from './act/action-queue.js';
import { TickClock } from './core/tick-clock.js';
import {
  createModeState,
  transitionMode,
  markDirected,
  markAnyEvent,
  DEFAULT_MODE_FSM_CONFIG,
  type ModeState,
} from './engine/mode-fsm.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 7.1 EventBuffer 单元测试
// ═══════════════════════════════════════════════════════════════════════════════

function makePerturbation(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message' as const,
    channelId: 'qq:private:12345',
    isDirected: false,
    isContinuation: false,
    tick: 0,
    timestamp: Date.now(),
    senderId: 'user_001',
    ...overrides,
  };
}

// ── push 超出容量时的驱逐行为 ─────────────────────────────────────────────

test('EventBuffer push evicts oldest regular entry when full', () => {
  const buffer = new NovaEventBuffer(3, 1); // maxProtected=1, maxRegular=2
  buffer.push(makePerturbation({ isDirected: false, channelId: 'ch:1' }));
  buffer.push(makePerturbation({ isDirected: false, channelId: 'ch:2' }));
  buffer.push(makePerturbation({ isDirected: false, channelId: 'ch:3' })); // evicts ch:1

  assert.equal(buffer.regularLength, 2);
  assert.equal(buffer.droppedCount, 1);
  const snapshot = buffer.snapshot();
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0]!.channelId, 'ch:2');
  assert.equal(snapshot[1]!.channelId, 'ch:3');
});

test('EventBuffer push evicts oldest directed entry when protected buffer full', () => {
  const buffer = new NovaEventBuffer(10, 2); // maxProtected=2
  buffer.push(makePerturbation({ isDirected: true, channelId: 'dir:1' }));
  buffer.push(makePerturbation({ isDirected: true, channelId: 'dir:2' }));
  buffer.push(makePerturbation({ isDirected: true, channelId: 'dir:3' })); // evicts dir:1

  assert.equal(buffer.protectedLength, 2);
  assert.equal(buffer.droppedDirectedCount, 1);
  const snapshot = buffer.snapshot();
  const directed = snapshot.filter((e) => e.isDirected);
  assert.equal(directed.length, 2);
  assert.equal(directed[0]!.channelId, 'dir:2');
  assert.equal(directed[1]!.channelId, 'dir:3');
});

// ── drain 正确合并两个缓冲区 ──────────────────────────────────────────────

test('EventBuffer drain merges both buffers and clears', () => {
  const buffer = new NovaEventBuffer(100, 100);
  buffer.push(makePerturbation({ isDirected: true, channelId: 'dir:1' }));
  buffer.push(makePerturbation({ isDirected: false, channelId: 'reg:1' }));
  buffer.push(makePerturbation({ isDirected: true, channelId: 'dir:2' }));

  const result = buffer.drain();
  assert.equal(result.events.length, 3);
  // 所有事件都被 drain 出来（protected + regular 合并）
  const channelIds = result.events.map((e) => e.channelId).sort();
  assert.deepEqual(channelIds, ['dir:1', 'dir:2', 'reg:1']);
  assert.equal(result.droppedCount, 0);
  assert.equal(result.droppedDirectedCount, 0);

  // drain 后缓冲区为空
  assert.equal(buffer.length, 0);
  assert.equal(buffer.protectedLength, 0);
  assert.equal(buffer.regularLength, 0);
});

test('EventBuffer drain reports dropped counts correctly', () => {
  const buffer = new NovaEventBuffer(1, 1);
  // 填满
  buffer.push(makePerturbation({ isDirected: false, channelId: 'reg:1' }));
  buffer.push(makePerturbation({ isDirected: false, channelId: 'reg:2' })); // evicted
  buffer.push(makePerturbation({ isDirected: false, channelId: 'reg:3' })); // evicted

  const result = buffer.drain();
  assert.equal(result.droppedCount, 2);
  // drain 后计数器重置
  assert.equal(buffer.droppedCount, 0);
});

// ── watch 一次性监听器 ────────────────────────────────────────────────────

test('EventBuffer watch resolves on matching event', async () => {
  const buffer = new NovaEventBuffer();
  const watchPromise = buffer.watch((e) => e.channelId === 'qq:private:target');

  buffer.push(makePerturbation({ channelId: 'qq:private:other' }));
  // 此时 watcher 不应被触发（不匹配）

  buffer.push(makePerturbation({ channelId: 'qq:private:target', senderId: 'match' }));
  const resolved = await watchPromise;
  assert.equal(resolved.channelId, 'qq:private:target');
  assert.equal(resolved.senderId, 'match');
});

// ── onDirected / onAnyEvent 回调触发 ──────────────────────────────────────

test('EventBuffer onDirected callback fires for directed events', () => {
  const buffer = new NovaEventBuffer();
  let directedChannelId = '';
  buffer.onDirected = (event) => {
    directedChannelId = event.channelId;
  };

  buffer.push(makePerturbation({ isDirected: true, channelId: 'qq:private:directed' }));
  assert.equal(directedChannelId, 'qq:private:directed');

  // 非 directed 不触发
  directedChannelId = '';
  buffer.push(makePerturbation({ isDirected: false, channelId: 'qq:private:regular' }));
  assert.equal(directedChannelId, '');
});

test('EventBuffer onAnyEvent callback fires for all events', () => {
  const buffer = new NovaEventBuffer();
  let callCount = 0;
  buffer.onAnyEvent = () => {
    callCount += 1;
  };

  buffer.push(makePerturbation({ isDirected: true }));
  buffer.push(makePerturbation({ isDirected: false }));
  assert.equal(callCount, 2);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7.2 ActionQueue 单元测试
// ═══════════════════════════════════════════════════════════════════════════════

function makeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    action: 'sociability',
    targetId: 'qq:private:12345',
    desireType: 'reconnect',
    urgency: 'medium' as const,
    scene: 'private' as const,
    reason: 'test candidate',
    ...overrides,
  };
}

// ── 压力驱逐：满时淘汰最低 score 条目 ─────────────────────────────────────

test('ActionQueue enqueue evicts lowest pressureScore item when full', () => {
  const queue = new ActionQueue(3);

  // 先填满队列（高压力条目）
  queue.enqueue(makeCandidate({ targetId: 'a' }), 1, 1000, '', {
    pressureSnapshot: { tick: 1, createdMs: 1000, p1: 1, p2: 1, p3: 1, p4: 1, p5: 1, p6: 1, p7: 0, p8: 0, pProspect: 0, api: 0.9, apiPeak: 0.9, contributions: {} },
  });
  queue.enqueue(makeCandidate({ targetId: 'b' }), 2, 2000, '', {
    pressureSnapshot: { tick: 2, createdMs: 2000, p1: 0.1, p2: 0.1, p3: 0.1, p4: 0.1, p5: 0.1, p6: 0.1, p7: 0, p8: 0, pProspect: 0, api: 0.1, apiPeak: 0.1, contributions: {} },
  });
  queue.enqueue(makeCandidate({ targetId: 'c' }), 3, 3000, '', {
    pressureSnapshot: { tick: 3, createdMs: 3000, p1: 1, p2: 1, p3: 1, p4: 1, p5: 1, p6: 1, p7: 0, p8: 0, pProspect: 0, api: 0.5, apiPeak: 0.5, contributions: {} },
  });

  // 第 4 个入队触发驱逐：b 的 pressureScore 最低（p 值小 = score 低），应被驱逐
  queue.enqueue(makeCandidate({ targetId: 'd' }), 4, 4000, '', {
    pressureSnapshot: { tick: 4, createdMs: 4000, p1: 1, p2: 1, p3: 1, p4: 1, p5: 1, p6: 1, p7: 0, p8: 0, pProspect: 0, api: 0.8, apiPeak: 0.8, contributions: {} },
  });

  const items = queue.list();
  const targetIds = items.map((i) => i.candidate.targetId);
  assert.ok(!targetIds.includes('b'), 'lowest score item should be evicted');
  assert.ok(targetIds.includes('a'));
  assert.ok(targetIds.includes('c'));
  assert.ok(targetIds.includes('d'));
});

// ── 阻塞 dequeue：waiter 在 enqueue 后被唤醒 ──────────────────────────────

test('ActionQueue dequeue blocks and resolves on enqueue', async () => {
  const queue = new ActionQueue();

  const dequeuePromise = queue.dequeue();
  // 延迟入队
  setTimeout(() => {
    queue.enqueue(makeCandidate({ targetId: 'test' }), 1, Date.now(), 'test');
  }, 10);

  const item = await dequeuePromise;
  assert.ok(item);
  assert.equal(item!.candidate.targetId, 'test');
});

// ── 非阻塞 tryDequeue：空队列返回 null ────────────────────────────────────

test('ActionQueue tryDequeue returns null when empty', () => {
  const queue = new ActionQueue();
  const item = queue.tryDequeue();
  assert.equal(item, null);
});

test('ActionQueue tryDequeue returns first queued item', () => {
  const queue = new ActionQueue();
  queue.enqueue(makeCandidate({ targetId: 'a' }), 1, 1000, '');
  queue.enqueue(makeCandidate({ targetId: 'b' }), 2, 2000, '');

  const a = queue.tryDequeue();
  assert.ok(a);
  assert.equal(a!.candidate.targetId, 'a');
  assert.equal(queue.pendingCount, 1);
});

// ── acquireTarget / markComplete / isTargetActive：锁机制 ──────────────────

test('ActionQueue acquireTarget prevents duplicate target processing', () => {
  const queue = new ActionQueue();
  assert.equal(queue.acquireTarget('qq:private:12345'), true);
  assert.equal(queue.isTargetActive('qq:private:12345'), true);
  // 同 target 再次 acquire 失败
  assert.equal(queue.acquireTarget('qq:private:12345'), false);
  // 不同 target 可以
  assert.equal(queue.acquireTarget('qq:private:67890'), true);
});

test('ActionQueue markComplete releases target lock', () => {
  const queue = new ActionQueue();
  queue.acquireTarget('qq:private:12345');
  assert.equal(queue.isTargetActive('qq:private:12345'), true);

  queue.markComplete('qq:private:12345');
  assert.equal(queue.isTargetActive('qq:private:12345'), false);
});

// ── close：所有 waiter 被唤醒返回 null ────────────────────────────────────

test('ActionQueue close wakes all waiters with null', async () => {
  const queue = new ActionQueue();
  const p1 = queue.dequeue();
  const p2 = queue.dequeue();

  queue.close();

  const r1 = await p1;
  const r2 = await p2;
  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(queue.closed, true);
});

// ── 状态标记 ──────────────────────────────────────────────────────────────

test('ActionQueue markExecuting / markDone / markFailed lifecycle', () => {
  const queue = new ActionQueue();
  const enqueued = queue.enqueue(makeCandidate(), 1, 1000, '')!;
  // 直接对还在队列中的条目标记（不经过 tryDequeue 移除）
  assert.equal(queue.markExecuting(enqueued.id, 2000), true);
  assert.equal(queue.markDone(enqueued.id, 3000), true);

  // 测试 markFailed
  const enqueued2 = queue.enqueue(makeCandidate({ targetId: 'fail_test' }), 2, 4000, '')!;
  assert.equal(queue.markExecuting(enqueued2.id, 5000), true);
  assert.equal(queue.markFailed(enqueued2.id, 'test error', 6000), true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7.3 TickClock 单元测试
// ═══════════════════════════════════════════════════════════════════════════════

// ── computeInterval：api=0 → dtMax, api→∞ → dtMin ──────────────────────────

test('TickClock computeInterval returns dtMax when api=0', () => {
  const clock = new TickClock({ dtMin: 1000, dtMax: 300000, kappaT: 1.0 });
  const interval = clock.computeInterval(0, 'patrol');
  // api=0: dt = dtMin + (dtMax - dtMin) * exp(0) = dtMax
  assert.ok(interval > 250_000, `expected interval near dtMax, got ${interval}`);
});

test('TickClock computeInterval returns near dtMin when api is very high', () => {
  const clock = new TickClock({ dtMin: 1000, dtMax: 300000, kappaT: 1.0 });
  const interval = clock.computeInterval(10, 'patrol');
  // api=10: exp(-10) ≈ 0.0000454, dt ≈ dtMin
  assert.ok(interval < 5000, `expected interval near dtMin, got ${interval}`);
});

test('TickClock computeInterval respects mode timing', () => {
  const clock = new TickClock();
  const patrolInterval = clock.computeInterval(0.5, 'patrol');
  const dormantInterval = clock.computeInterval(0.5, 'dormant');
  // dormant 的间隔应大于 patrol
  assert.ok(dormantInterval > patrolInterval,
    `dormant=${dormantInterval} should be > patrol=${patrolInterval}`);
});

// ── advance：tick 递增，dt 正确 ────────────────────────────────────────────

test('TickClock advance increments tick and computes dt', () => {
  const clock = new TickClock();

  const r1 = clock.advance(10000);
  assert.equal(r1.tick, 1);
  // 第一次 advance，dt 应默认为 60 秒
  assert.equal(r1.dt, 60);

  const r2 = clock.advance(15000);
  assert.equal(r2.tick, 2);
  // 第二次 advance：elapsed = 5000ms → dt = 5
  assert.equal(r2.dt, 5);
});

test('TickClock reset clears state', () => {
  const clock = new TickClock();
  clock.advance(10000);
  clock.advance(20000);

  clock.reset();
  assert.equal(clock.tick, 0);
  assert.equal(clock.lastAdvanceMs, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7.4 ModeFSM 单元测试
// ═══════════════════════════════════════════════════════════════════════════════

// ── wakeup → patrol（6 ticks）──────────────────────────────────────────────

test('ModeFSM transitions wakeup → patrol after wakeupTicks', () => {
  const state = createModeState(0);
  assert.equal(state.current, 'wakeup');

  for (let i = 0; i < 5; i++) {
    transitionMode(state, 0.1, i * 1000);
    assert.equal(state.current, 'wakeup', `tick ${i + 1}: still wakeup`);
  }
  // 第 6 次 tick 触发转换
  transitionMode(state, 0.1, 6000);
  assert.equal(state.current, 'patrol');
});

// ── patrol → dormant（持续低 API + 无事件）────────────────────────────────

test('ModeFSM transitions patrol → dormant on sustained low API and idle', () => {
  const state = createModeState(0);
  // 先进入 patrol
  for (let i = 0; i < 6; i++) transitionMode(state, 0.2, i * 1000);
  assert.equal(state.current, 'patrol');

  // 模拟长时间无事件 + 持续低 API
  const nowMs = 10 * 60_000; // 10 minutes later
  // 先更新 lastAnyEventMs 到一个旧时间
  state.lastAnyEventMs = 0;

  for (let i = 0; i < DEFAULT_MODE_FSM_CONFIG.dormantLowApiTicks; i++) {
    transitionMode(state, 0.01, nowMs + i * 1000);
  }
  assert.equal(state.current, 'dormant');
});

// ── patrol → conversation（持续高 API）─────────────────────────────────────

test('ModeFSM transitions patrol → conversation on sustained high API', () => {
  const state = createModeState(0);
  for (let i = 0; i < 6; i++) transitionMode(state, 0.2, i * 1000);
  assert.equal(state.current, 'patrol');

  for (let i = 0; i < DEFAULT_MODE_FSM_CONFIG.conversationHighApiTicks; i++) {
    transitionMode(state, 0.5, 10000 + i * 1000);
  }
  assert.equal(state.current, 'conversation');
});

// ── dormant → wakeup（directed 消息）───────────────────────────────────────

test('ModeFSM transitions dormant → wakeup on directed message', () => {
  const state = createModeState(0);
  // 先进 patrol 再进 dormant
  for (let i = 0; i < 6; i++) transitionMode(state, 0.2, i * 1000);
  state.lastAnyEventMs = 0;
  for (let i = 0; i < DEFAULT_MODE_FSM_CONFIG.dormantLowApiTicks; i++) {
    transitionMode(state, 0.01, 10 * 60_000 + i * 1000);
  }
  assert.equal(state.current, 'dormant');

  // directed 消息唤起
  markDirected(state, 20 * 60_000);
  transitionMode(state, 0.3, 20 * 60_000);
  assert.equal(state.current, 'wakeup');
});

// ── conversation → patrol（空闲超时）───────────────────────────────────────

test('ModeFSM transitions conversation → patrol after idle timeout', () => {
  const state = createModeState(0);
  for (let i = 0; i < 6; i++) transitionMode(state, 0.2, i * 1000);
  for (let i = 0; i < 3; i++) transitionMode(state, 0.5, 10000 + i * 1000);
  assert.equal(state.current, 'conversation');

  // 等待超时
  state.lastAnyEventMs = 0;
  transitionMode(state, 0.2, 10 * 60_000);
  assert.equal(state.current, 'patrol');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7.5 集成测试：消息 → buffer → EVOLVE → enqueue → ACT → 发送
// ═══════════════════════════════════════════════════════════════════════════════

test('Integration: message event flows through buffer to action queue', async () => {
  // 模拟完整流程
  const buffer = new NovaEventBuffer(100, 50);
  const queue = new ActionQueue(50);

  // 1. 消息到达 → buffer.push
  const event = makePerturbation({
    channelId: 'qq:private:user_123',
    isDirected: true,
    senderId: 'user_123',
  });
  buffer.push(event);

  // 验证 buffer 中有消息
  assert.equal(buffer.length, 1);
  assert.equal(buffer.protectedLength, 1);

  // 2. EVOLVE Phase 1: drain
  const drained = buffer.drain();
  assert.equal(drained.events.length, 1);
  assert.equal(drained.events[0]!.channelId, 'qq:private:user_123');

  // 3. EVOLVE Phase 2-3: 构建候选并入队
  const candidate = makeCandidate({
    action: 'sociability',
    targetId: 'qq:private:user_123',
    desireType: 'directed_reply',
    urgency: 'high',
    reason: 'directed_message_from_user_123',
  });
  const enqueued = queue.enqueue(candidate, 1, Date.now(), 'directed reply', {
    kind: 'reply',
    pressureSnapshot: { tick: 1, createdMs: Date.now(), p1: 0.8, p2: 0.5, p3: 0.3, p4: 0.1, p5: 0, p6: 0, p7: 0, p8: 0, pProspect: 0.5, api: 0.7, apiPeak: 0.8, contributions: {} },
  });
  assert.ok(enqueued);
  assert.equal(enqueued!.kind, 'reply');
  assert.equal(queue.pendingCount, 1);

  // 4. ACT: dequeue and execute
  const dequeued = await queue.dequeue();
  assert.ok(dequeued);
  assert.equal(dequeued!.candidate.targetId, 'qq:private:user_123');
  assert.equal(dequeued!.candidate.desireType, 'directed_reply');

  // 5. 标记执行完成
  queue.markExecuting(dequeued!.id, Date.now());
  queue.markDone(dequeued!.id, Date.now());
});

test('Integration: same target not re-enqueued when locked', () => {
  const queue = new ActionQueue(50);

  // 入队 target A
  queue.enqueue(makeCandidate({ targetId: 'qq:private:target_a' }), 1, 1000, '');

  // acquireTarget A → 再次入队 A 应被 isTargetActive 阻止
  queue.acquireTarget('qq:private:target_a');
  assert.equal(queue.isTargetActive('qq:private:target_a'), true);

  // 此时不应再有新的 target_a 入队（由 EVOLVE gate chain 保证）
  const pending = queue.listPending();
  const targetAItems = pending.filter((i) => i.candidate.targetId === 'qq:private:target_a');
  assert.ok(targetAItems.length <= 1, 'should not have multiple pending items for same target');
});

test('Integration: directed message triggers directed callback for instant wakeup', () => {
  const buffer = new NovaEventBuffer(100, 50);
  const wakeupSignals: string[] = [];

  buffer.onDirected = (event) => {
    wakeupSignals.push(event.channelId);
  };

  // 模拟 directed 消息到达
  buffer.push(makePerturbation({ channelId: 'qq:private:urgent', isDirected: true }));
  buffer.push(makePerturbation({ channelId: 'qq:group:general', isDirected: false }));
  buffer.push(makePerturbation({ channelId: 'qq:private:urgent2', isDirected: true }));

  // 只触发 directed 回调
  assert.deepEqual(wakeupSignals, ['qq:private:urgent', 'qq:private:urgent2']);
  assert.equal(buffer.protectedLength, 2);
  assert.equal(buffer.regularLength, 1);
});

test('Integration: staleness check abandons outdated actions', async () => {
  const { stalenessCheck } = await import('./act/scheduler.js');

  const enqueueSnapshot = {
    tick: 1, createdMs: 1000,
    p1: 0.9, p2: 0.8, p3: 0.7, p4: 0.6, p5: 0.5, p6: 0.4, p7: 0.3, p8: 0.2,
    pProspect: 0.8, api: 0.9, apiPeak: 1.0, contributions: {},
  };
  const currentSnapshot = {
    tick: 10, createdMs: 60000,
    p1: 0.1, p2: 0.1, p3: 0.1, p4: 0.1, p5: 0.1, p6: 0.1, p7: 0.1, p8: 0.1,
    pProspect: 0.1, api: 0.1, apiPeak: 0.2, contributions: {},
  };

  const result = stalenessCheck(enqueueSnapshot, currentSnapshot, 0.5);
  assert.equal(result.stale, true, 'large pressure change should be stale');
  assert.ok(result.distance > 0.5);
});
