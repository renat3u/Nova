//
// Decision validator tests — parse, validate, normalize, fallback.
//

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateDecisionResponse,
  createFallbackResponse,
  type ValidationResult,
} from './decision-validator.js';
import type { DecisionContext } from './decision-schema.js';

function makeContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  const base: DecisionContext = {
    tick: 1,
    reason: 'message',
    nowMs: Date.now(),
    scene: 'private',
    pressure: {
      p1: 0.1, p2: 0.2, p3: 0.3, p4: 0.4, p5: 0.5, p6: 0.6,
      pProspect: 0.7, api: 0.8, apiPeak: 0.9,
      explanations: {},
    },
    voice: {
      selected: 'diligence',
      iausAction: null,
      probabilities: {},
      temperature: 1.0,
    },
    desires: [],
    candidates: [],
    relationship: { facts: [] },
    memory: { working: [], longTerm: [] },
    conversation: { recentMessages: [] },
    configHints: { maxReplyLength: 1000, gatewayMode: 'agent', guardrails: 'off' },
  };
  // Only apply overrides for keys that are actually present
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (base as Record<string, unknown>)[key] = value;
    }
  }
  // If no event in overrides, ensure default event is set
  if (!('event' in overrides)) {
    base.event = {
      id: 'evt-1',
      messageId: 'msg-1',
      chatType: 'private',
      chatId: 'chat-1',
      senderId: 'sender-1',
      senderQQ: '123456',
      senderName: 'TestUser',
      text: 'Hello',
      isDirected: true,
      mentionedSelf: false,
      repliedToSelf: false,
    };
  }
  return base;
}

test('validateDecisionResponse rejects null input', () => {
  const result = validateDecisionResponse(null, makeContext());
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('decision_response_not_object'));
});

test('validateDecisionResponse rejects array input', () => {
  const result = validateDecisionResponse([], makeContext());
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('decision_response_not_object'));
});

test('validateDecisionResponse rejects invalid action', () => {
  const result = validateDecisionResponse({ action: 'invalid_action' }, makeContext());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('invalid_action')));
});

test('validateDecisionResponse accepts valid reply action', () => {
  const result = validateDecisionResponse({
    action: 'reply',
    generateText: true,
    reason: 'User asked a question',
    confidence: 0.9,
  }, makeContext());
  assert.equal(result.valid, true);
  assert.equal(result.normalized.action, 'reply');
  assert.ok(result.normalized.generateText);
  assert.equal(result.normalized.confidence, 0.9);
});

test('validateDecisionResponse defaults confidence to 0.5 when missing', () => {
  const result = validateDecisionResponse({
    action: 'observe',
    reason: 'Nothing to respond to',
  }, makeContext());
  assert.equal(result.normalized.confidence, 0.5);
});

test('validateDecisionResponse clamps confidence to 0-1', () => {
  const r1 = validateDecisionResponse({ action: 'observe', reason: 't', confidence: 5 }, makeContext());
  assert.equal(r1.normalized.confidence, 1);

  const r2 = validateDecisionResponse({ action: 'observe', reason: 't', confidence: -3 }, makeContext());
  assert.equal(r2.normalized.confidence, 0);
});

test('validateDecisionResponse defaults generateText for text actions', () => {
  // reply should default to true
  const r1 = validateDecisionResponse({ action: 'reply', reason: 't' }, makeContext());
  assert.ok(r1.normalized.generateText);

  // ask should default to true
  const r2 = validateDecisionResponse({ action: 'ask', reason: 't' }, makeContext());
  assert.ok(r2.normalized.generateText);

  // silence should default to false
  const r3 = validateDecisionResponse({ action: 'silence', reason: 't' }, makeContext());
  assert.equal(r3.normalized.generateText, false);
});

test('validateDecisionResponse enforces cool_down no text generation', () => {
  const result = validateDecisionResponse({
    action: 'cool_down',
    generateText: true,
    reason: 'Need to step back',
  }, makeContext());
  assert.equal(result.normalized.generateText, false);
  assert.equal(result.normalized.afterward, 'cooling_down');
});

test('validateDecisionResponse rejects reply on scheduled tick', () => {
  const result = validateDecisionResponse({
    action: 'reply',
    reason: 'Test',
  }, makeContext({ reason: 'scheduled' }));
  assert.ok(result.errors.includes('reply_action_only_allowed_for_message_tick'));
});

test('validateDecisionResponse downgrades proactive on message tick', () => {
  const result = validateDecisionResponse({
    action: 'proactive',
    reason: 'Test',
  }, makeContext({ reason: 'message' }));
  assert.equal(result.normalized.action, 'ask');
  assert.ok(result.warnings.some((w) => w.includes('downgraded')));
});

test('validateDecisionResponse rejects silence with generateText true', () => {
  const result = validateDecisionResponse({
    action: 'silence',
    generateText: true,
    reason: 'Test',
  }, makeContext());
  assert.equal(result.normalized.generateText, false);
});

test('validateDecisionResponse limits stateUpdates to 3', () => {
  const result = validateDecisionResponse({
    action: 'reply',
    reason: 'Test',
    stateUpdates: [
      { type: 'afterward', value: 'done' },
      { type: 'self_mood', valence: 0.1 },
      { type: 'memory_note', content: 'test1' },
      { type: 'thread_note', summary: 'test2' },
      { type: 'afterward', value: 'watching' },
    ],
  }, makeContext());
  assert.ok(result.normalized.stateUpdates);
  assert.ok(result.normalized.stateUpdates!.length <= 3);
});

test('validateDecisionResponse rejects invalid state update types', () => {
  const result = validateDecisionResponse({
    action: 'reply',
    reason: 'Test',
    stateUpdates: [
      { type: 'invalid_type' },
      { type: 'afterward', value: 'done' },
    ],
  }, makeContext());
  assert.ok(result.errors.some((e) => e.includes('invalid_state_update_type')));
});

test('createFallbackResponse returns safe defaults for message tick', () => {
  const fb = createFallbackResponse(makeContext({ reason: 'message' }), 'test_failure');
  assert.equal(fb.action, 'observe');
  assert.equal(fb.generateText, false);
  assert.ok(fb.tags?.includes('fallback'));
});

test('createFallbackResponse returns safe defaults for scheduled tick', () => {
  const fb = createFallbackResponse(makeContext({ reason: 'scheduled' }), 'test_failure');
  assert.equal(fb.action, 'silence');
  assert.equal(fb.generateText, false);
});

test('validateDecisionResponse handles missing reason gracefully', () => {
  const result = validateDecisionResponse({ action: 'observe' }, makeContext());
  assert.equal(result.normalized.reason, 'no_reason_provided');
});

test('validateDecisionResponse handles the full valid JSON shape', () => {
  const raw = {
    action: 'reply',
    candidateId: undefined,
    targetId: undefined,
    generateText: true,
    responderIntent: 'Keep it short',
    reason: 'Direct question from user',
    confidence: 0.92,
    afterward: 'done',
    stateUpdates: [],
    tags: ['direct', 'confident'],
  };
  const result = validateDecisionResponse(raw, makeContext());
  assert.equal(result.valid, true);
  assert.equal(result.normalized.action, 'reply');
  assert.equal(result.normalized.confidence, 0.92);
  assert.deepEqual(result.normalized.tags, ['direct', 'confident']);
});
