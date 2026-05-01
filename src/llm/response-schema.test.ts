// todo2-step12: 完整 response parser 测试矩阵
//
// 验证 parseNovaLLMResponse 对所有 stateUpdates 类型的解析行为，
// 以及安全边界（多余字段不会产生权限能力、非法类型不会被当作合法状态更新）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNovaLLMResponse } from './client.js';

// ── 1. 无 stateUpdates 的旧响应合法 ──────────────────────────────────────

test('parseNovaLLMResponse preserves old JSON response fields', () => {
  const response = parseNovaLLMResponse('{"text":"你好","memoryCandidate":"秋喜欢雨天","tone":"warm","confidence":0.8}');
  assert.equal(response.text, '你好');
  assert.equal(response.memoryCandidate, '秋喜欢雨天');
  assert.equal(response.tone, 'warm');
  assert.equal(response.confidence, 0.8);
  assert.equal(response.stateUpdates, undefined);
});

test('parseNovaLLMResponse preserves optional stateUpdates array for validation layer', () => {
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '嗯，我在',
    stateUpdates: [
      { type: 'self_mood', valence: 0.3, arousal: 0.2, reason: 'felt connected' },
      { type: 'afterward', value: 'waiting_reply' },
    ],
  }));

  assert.equal(response.text, '嗯，我在');
  assert.equal(response.stateUpdates?.length, 2);
  assert.deepEqual(response.stateUpdates?.[0], { type: 'self_mood', valence: 0.3, arousal: 0.2, reason: 'felt connected' });
});

test('parseNovaLLMResponse falls back to plain text for non JSON content', () => {
  const response = parseNovaLLMResponse('不是 JSON');
  assert.equal(response.text, '不是 JSON');
  assert.equal(response.stateUpdates, undefined);
});

// ── 2. stateUpdates: [] 合法 ─────────────────────────────────────────────

test('parseNovaLLMResponse accepts empty stateUpdates array', () => {
  const response = parseNovaLLMResponse('{"text":"好的","stateUpdates":[]}');
  assert.equal(response.text, '好的');
  assert.ok(Array.isArray(response.stateUpdates));
  assert.equal(response.stateUpdates!.length, 0);
});

test('parseNovaLLMResponse stateUpdates undefined is parsed as undefined', () => {
  const response = parseNovaLLMResponse(JSON.stringify({ text: '测试', stateUpdates: null }));
  assert.equal(response.text, '测试');
  assert.equal(response.stateUpdates, undefined);
});

// ── 3. 合法四类 update 可解析 ─────────────────────────────────────────────

test('parseNovaLLMResponse parses self_mood stateUpdate correctly', () => {
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '开心',
    stateUpdates: [{ type: 'self_mood', valence: 0.8, arousal: 0.9, reason: '愉快的互动' }],
  }));
  assert.equal(response.text, '开心');
  assert.equal(response.stateUpdates?.length, 1);
  assert.deepEqual(response.stateUpdates![0], {
    type: 'self_mood', valence: 0.8, arousal: 0.9, reason: '愉快的互动',
  });
});

test('parseNovaLLMResponse parses memory_note stateUpdate correctly', () => {
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '了解了',
    stateUpdates: [{ type: 'memory_note', content: '用户偏好中文沟通', salience: 0.6, reason: '明确表达' }],
  }));
  assert.equal(response.text, '了解了');
  assert.equal(response.stateUpdates?.length, 1);
  const update = response.stateUpdates![0] as Record<string, unknown>;
  assert.equal(update.type, 'memory_note');
  assert.equal(update.content, '用户偏好中文沟通');
  assert.equal(update.salience, 0.6);
  assert.equal(update.reason, '明确表达');
});

test('parseNovaLLMResponse parses thread_note stateUpdate correctly', () => {
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '继续讨论',
    stateUpdates: [{ type: 'thread_note', summary: '讨论Nova架构设计', weight: 0.7 }],
  }));
  assert.equal(response.text, '继续讨论');
  assert.equal(response.stateUpdates?.length, 1);
  const update = response.stateUpdates![0] as Record<string, unknown>;
  assert.equal(update.type, 'thread_note');
  assert.equal(update.summary, '讨论Nova架构设计');
  assert.equal(update.weight, 0.7);
});

test('parseNovaLLMResponse parses afterward stateUpdate correctly', () => {
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '再见',
    stateUpdates: [{ type: 'afterward', value: 'done', reason: '对话结束' }],
  }));
  assert.equal(response.text, '再见');
  assert.equal(response.stateUpdates?.length, 1);
  const update = response.stateUpdates![0] as Record<string, unknown>;
  assert.equal(update.type, 'afterward');
  assert.equal(update.value, 'done');
  assert.equal(update.reason, '对话结束');
});

test('parseNovaLLMResponse parses all four stateUpdate types together', () => {
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '综合回复',
    stateUpdates: [
      { type: 'self_mood', valence: 0.3 },
      { type: 'memory_note', content: '用户提到计划旅行', salience: 0.5 },
      { type: 'thread_note', summary: '旅行计划讨论' },
      { type: 'afterward', value: 'waiting_reply' },
    ],
  }));
  assert.equal(response.text, '综合回复');
  assert.equal(response.stateUpdates?.length, 4);
  const types = response.stateUpdates!.map((u) => (u as Record<string, unknown>).type);
  assert.deepStrictEqual(types, ['self_mood', 'memory_note', 'thread_note', 'afterward']);
});

// ── 4. stateUpdates 非数组被 parser 忽略 (writeback 层再拒绝) ────────────

test('parseNovaLLMResponse ignores non-array stateUpdates (passes to writeback for rejection)', () => {
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '测试',
    stateUpdates: { type: 'self_mood', valence: 0.5 },
  }));
  assert.equal(response.text, '测试');
  // Parser 只接受数组，非数组不放入 response
  assert.equal(response.stateUpdates, undefined);
});

// ── 5. text 仍为必填或按现有规则处理 ──────────────────────────────────────

test('parseNovaLLMResponse returns empty string when text field is missing', () => {
  const response = parseNovaLLMResponse(JSON.stringify({
    memoryCandidate: 'test',
    stateUpdates: [{ type: 'self_mood', valence: 0.1 }],
  }));
  // Parser 不会因为没有 text 而崩溃；writeback 层再处理
  assert.equal(typeof response.text, 'string');
});

test('parseNovaLLMResponse preserves text even when stateUpdates parsing would fail', () => {
  // text is always preserved, stateUpdates with bad structure are passed through
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '我在这里',
    stateUpdates: 'not an array',
  }));
  assert.equal(response.text, '我在这里');
  assert.equal(response.stateUpdates, undefined);
});

// ── 6. 多余字段不会产生权限能力 ───────────────────────────────────────────

test('parseNovaLLMResponse does not recognize bypass_gate as special field', () => {
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '测试',
    bypass_gate: true,
    send_now: true,
  }));
  // 这些字段不在 NovaLLMResponse 类型中，解析器直接忽略
  assert.equal(response.text, '测试');
  const record = response as unknown as Record<string, unknown>;
  assert.equal(record.bypass_gate, undefined);
  assert.equal(record.send_now, undefined);
});

test('parseNovaLLMResponse does not recognize set_pressure as special field', () => {
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '测试',
    set_pressure: { p5: 10 },
  }));
  assert.equal(response.text, '测试');
  const record = response as unknown as Record<string, unknown>;
  assert.equal(record.set_pressure, undefined);
});

test('parseNovaLLMResponse does not recognize shell/bash/command as special fields', () => {
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '测试',
    bash: 'echo hello',
    command: 'rm -rf /',
    shell: '/bin/bash',
  }));
  assert.equal(response.text, '测试');
  const record = response as unknown as Record<string, unknown>;
  assert.equal(record.bash, undefined);
  assert.equal(record.command, undefined);
  assert.equal(record.shell, undefined);
});

// ── 7. bypass_gate/send_now/set_pressure 在 stateUpdates 里也不会被当作合法状态更新 ─

test('parseNovaLLMResponse passes unsupported stateUpdate types through to validation layer', () => {
  // Parser 不知道哪些 type 合法——它只做结构解析。
  // 将实际 type 交给 writeback 层去验证和拒绝。
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '测试',
    stateUpdates: [
      { type: 'bypass_gate', value: true },
      { type: 'set_pressure', p5: 10 },
      { type: 'send_now', channel: 'test' },
    ],
  }));
  assert.equal(response.text, '测试');
  assert.equal(response.stateUpdates?.length, 3);
  // 这些 update 会被 writeback 的 validate 步骤拒绝（unsupported_state_update_type）
  const types = response.stateUpdates!.map((u) => (u as Record<string, unknown>).type);
  assert.deepStrictEqual(types, ['bypass_gate', 'set_pressure', 'send_now']);
});

// ── 8. Large stateUpdates arrays parse correctly ─────────────────────────

test('parseNovaLLMResponse preserves large stateUpdates arrays for writeback limiting', () => {
  const manyUpdates = Array.from({ length: 10 }, (_, i) => ({
    type: 'afterward' as const,
    value: i % 2 === 0 ? 'done' as const : 'watching' as const,
  }));
  const response = parseNovaLLMResponse(JSON.stringify({
    text: '测试',
    stateUpdates: manyUpdates,
  }));
  assert.equal(response.text, '测试');
  assert.equal(response.stateUpdates?.length, 10);
  // writeback 层会将超过 MAX_UPDATES(3) 的标记为 too_many_state_updates
});

// ── 9. Parser edge cases ──────────────────────────────────────────────────

test('parseNovaLLMResponse handles markdown code fences around JSON', () => {
  const raw = '```json\n{"text":"你好","stateUpdates":[]}\n```';
  const response = parseNovaLLMResponse(raw);
  assert.equal(response.text, '你好');
  assert.ok(Array.isArray(response.stateUpdates));
});

test('parseNovaLLMResponse handles leading/trailing whitespace', () => {
  const response = parseNovaLLMResponse('  \n{"text":"你好"}\n  ');
  assert.equal(response.text, '你好');
});

test('parseNovaLLMResponse rejects NaN/Infinity in JSON numerics', () => {
  // JSON standard doesn't support NaN/Infinity; these won't parse as valid JSON
  const response = parseNovaLLMResponse('{"text":"hi","confidence":NaN}');
  // Falls back to plain text since JSON.parse would throw
  assert.ok(typeof response.text === 'string');
});

test('parseNovaLLMResponse preserves 0 as valid confidence', () => {
  const response = parseNovaLLMResponse('{"text":"hi","confidence":0}');
  assert.equal(response.text, 'hi');
  assert.equal(response.confidence, 0);
});

test('parseNovaLLMResponse preserves negative confidence (passes through)', () => {
  const response = parseNovaLLMResponse('{"text":"hi","confidence":-0.5}');
  // Number.isFinite(-0.5) is true, so it's included
  assert.equal(response.confidence, -0.5);
});
