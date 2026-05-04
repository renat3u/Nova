//
// Decision schema tests — verify type definitions and constants.
//

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DECISION_ACTIONS,
  TEXT_GENERATING_ACTIONS,
  NON_TEXT_ACTIONS,
  type DecisionActionType,
  type DecisionContext,
  type DecisionAgentResponse,
} from './decision-schema.js';

test('DECISION_ACTIONS contains all 7 action types', () => {
  const expected = ['silence', 'observe', 'wait_reply', 'reply', 'ask', 'proactive', 'cool_down'];
  for (const action of expected) {
    assert.ok(DECISION_ACTIONS.has(action), `missing action: ${action}`);
  }
  assert.equal(DECISION_ACTIONS.size, 7);
});

test('TEXT_GENERATING_ACTIONS are reply, ask, proactive', () => {
  assert.ok(TEXT_GENERATING_ACTIONS.has('reply'));
  assert.ok(TEXT_GENERATING_ACTIONS.has('ask'));
  assert.ok(TEXT_GENERATING_ACTIONS.has('proactive'));
  assert.equal(TEXT_GENERATING_ACTIONS.size, 3);
});

test('NON_TEXT_ACTIONS are silence, observe, wait_reply, cool_down', () => {
  assert.ok(NON_TEXT_ACTIONS.has('silence'));
  assert.ok(NON_TEXT_ACTIONS.has('observe'));
  assert.ok(NON_TEXT_ACTIONS.has('wait_reply'));
  assert.ok(NON_TEXT_ACTIONS.has('cool_down'));
  assert.equal(NON_TEXT_ACTIONS.size, 4);
});

test('TEXT_GENERATING_ACTIONS and NON_TEXT_ACTIONS are disjoint', () => {
  for (const action of TEXT_GENERATING_ACTIONS) {
    assert.ok(!NON_TEXT_ACTIONS.has(action), `${action} should not be in NON_TEXT_ACTIONS`);
  }
});

test('DecisionContext shape can be constructed', () => {
  const ctx: DecisionContext = {
    tick: 1,
    reason: 'message',
    nowMs: Date.now(),
    scene: 'private',
    event: {
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
    },
    pressure: {
      p1: 0.1, p2: 0.2, p3: 0.3, p4: 0.4, p5: 0.5, p6: 0.6,
      pProspect: 0.7, api: 0.8, apiPeak: 0.9,
      explanations: { p1: 'test' },
    },
    voice: {
      selected: 'diligence',
      iausAction: 'diligence',
      probabilities: { diligence: 1, curiosity: 0, sociability: 0, caution: 0 },
      temperature: 1.0,
    },
    desires: [],
    candidates: [],
    relationship: { facts: [] },
    memory: { working: [], longTerm: [] },
    conversation: { recentMessages: [] },
    configHints: { maxReplyLength: 1000, gatewayMode: 'agent', guardrails: 'off' },
  };

  assert.equal(ctx.tick, 1);
  assert.equal(ctx.reason, 'message');
  assert.equal(ctx.scene, 'private');
  assert.ok(ctx.event);
  assert.equal(ctx.pressure.p1, 0.1);
});

test('DecisionAgentResponse shape can be constructed', () => {
  const resp: DecisionAgentResponse = {
    action: 'reply',
    targetId: 'chat-1',
    generateText: true,
    responderIntent: 'Be warm and brief',
    reason: 'User asked a direct question',
    confidence: 0.85,
    afterward: 'waiting_reply',
    tags: ['directed', 'high_confidence'],
  };

  assert.equal(resp.action, 'reply');
  assert.ok(resp.generateText);
  assert.equal(resp.confidence, 0.85);
  assert.equal(resp.afterward, 'waiting_reply');
  assert.deepEqual(resp.tags, ['directed', 'high_confidence']);
});
