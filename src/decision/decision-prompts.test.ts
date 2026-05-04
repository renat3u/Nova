//
// Decision prompts tests — verify prompt content and constraints.
//

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDecisionMessages } from './decision-prompts.js';
import type { DecisionContext } from './decision-schema.js';

function makeContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    tick: 42,
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
      text: 'Hello Nova, how are you?',
      isDirected: true,
      mentionedSelf: false,
      repliedToSelf: false,
    },
    pressure: {
      p1: 0.15, p2: 0.25, p3: 0.35, p4: 0.45, p5: 0.55, p6: 0.65,
      pProspect: 0.75, api: 1.2, apiPeak: 2.3,
      explanations: {
        p1: 'P1 attention debt test',
        p2: 'P2 information pressure test',
      },
    },
    voice: {
      selected: 'diligence',
      iausAction: 'diligence',
      probabilities: { diligence: 0.6, curiosity: 0.2, sociability: 0.15, caution: 0.05 },
      temperature: 1.0,
    },
    desires: [
      {
        type: 'fulfill_duty',
        urgency: 'high',
        pressureValue: 0.55,
        targetId: 'chat-1',
        source: 'P5',
        reason: 'User expects a reply',
      },
    ],
    candidates: [
      {
        id: 'candidate_0_reply_chat-1',
        action: 'reply',
        targetId: 'chat-1',
        targetLabel: 'TestUser',
        scene: 'private',
        desireType: 'fulfill_duty',
        urgency: 'high',
        reason: 'message_reply: directed=true',
        iausScore: {
          rawScore: 0.8,
          deltaP: 0.55,
          socialCost: 0.1,
          netValue: 0.45,
        },
      },
    ],
    relationship: {
      facts: ['TestUser: familiar acquaintance'],
    },
    memory: {
      working: ['User said hello earlier'],
      longTerm: ['User prefers casual tone'],
    },
    conversation: {
      recentMessages: [
        { senderName: 'TestUser', text: 'Hello Nova, how are you?' },
      ],
    },
    configHints: {
      maxReplyLength: 1000,
      gatewayMode: 'agent',
      guardrails: 'off',
    },
    ...overrides,
  };
}

test('buildDecisionMessages returns system and user messages', () => {
  const messages = buildDecisionMessages(makeContext());
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, 'system');
  assert.equal(messages[1]!.role, 'user');
});

test('system prompt contains pressure semantics', () => {
  const messages = buildDecisionMessages(makeContext());
  const system = messages[0]!.content;
  assert.ok(system.includes('P1 attention debt'));
  assert.ok(system.includes('P2 information pressure'));
  assert.ok(system.includes('P3 relationship cooling'));
  assert.ok(system.includes('P4 thread divergence'));
  assert.ok(system.includes('P5 response obligation'));
  assert.ok(system.includes('P6 curiosity'));
  assert.ok(system.includes('P_prospect'));
  assert.ok(system.includes('API'));
});

test('system prompt contains action definitions', () => {
  const messages = buildDecisionMessages(makeContext());
  const system = messages[0]!.content;
  assert.ok(system.includes('silence'));
  assert.ok(system.includes('observe'));
  assert.ok(system.includes('wait_reply'));
  assert.ok(system.includes('reply'));
  assert.ok(system.includes('ask'));
  assert.ok(system.includes('proactive'));
  assert.ok(system.includes('cool_down'));
});

test('system prompt contains output format instructions', () => {
  const messages = buildDecisionMessages(makeContext());
  const system = messages[0]!.content;
  assert.ok(system.includes('Return exactly one JSON object'));
  assert.ok(system.includes('"action"'));
  assert.ok(system.includes('"reason"'));
  assert.ok(system.includes('"confidence"'));
});

test('system prompt warns against exposing internals', () => {
  const messages = buildDecisionMessages(makeContext());
  const system = messages[0]!.content;
  assert.ok(system.includes('Do not expose internal mechanisms'));
});

test('user prompt contains pressure values', () => {
  const messages = buildDecisionMessages(makeContext());
  const user = messages[1]!.content;
  assert.ok(user.includes('P1=0.150'));
  assert.ok(user.includes('API=1.200'));
});

test('user prompt contains event information', () => {
  const messages = buildDecisionMessages(makeContext());
  const user = messages[1]!.content;
  assert.ok(user.includes('TestUser'));
  assert.ok(user.includes('Hello Nova'));
  assert.ok(user.includes('Directed: true'));
});

test('user prompt contains candidate information', () => {
  const messages = buildDecisionMessages(makeContext());
  const user = messages[1]!.content;
  assert.ok(user.includes('candidate_0_reply_chat-1'));
  assert.ok(user.includes('netValue=0.4500'));
});

test('user prompt does not expose API key or config secrets', () => {
  const messages = buildDecisionMessages(makeContext());
  const combined = messages[0]!.content + messages[1]!.content;
  assert.ok(!combined.includes('apiKey'));
  assert.ok(!combined.includes('sk-'));
  assert.ok(!combined.includes('Bearer'));
});

test('user prompt contains config hints', () => {
  const messages = buildDecisionMessages(makeContext());
  const user = messages[1]!.content;
  assert.ok(user.includes('agent'), 'should contain agent gateway mode');
  assert.ok(user.includes('off'), 'should contain guardrails off');
  assert.ok(user.includes('Max reply length'), 'should contain max reply length');
});

test('decision style rules are present', () => {
  const messages = buildDecisionMessages(makeContext());
  const system = messages[0]!.content;
  assert.ok(system.includes('Private chat'));
  assert.ok(system.includes('Group chat'));
  assert.ok(system.includes('decision reason is written for developers'));
});
