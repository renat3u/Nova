//
// Decision agent tests — Agent instantiation, config validation,
// fallback behavior, and lifecycle.
//
// Covers:
//   1. Agent creation with valid config
//   2. Agent returns fallback when disabled
//   3. Agent returns fallback when config is missing (no baseUrl/model)
//   4. createDecisionAgent factory works
//   5. decide() handles context correctly
//

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDecisionAgent } from './decision-agent.js';
import type { DecisionContext } from './decision-schema.js';
import type { DecisionAgentConfig } from '../core/types.js';

function validConfig(overrides: Partial<DecisionAgentConfig> = {}): DecisionAgentConfig {
  return {
    enabled: true,
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'test-key',
    model: 'test-model',
    temperature: 0.2,
    maxTokens: 1200,
    timeoutMs: 5000,
    responseFormat: 'json_object',
    failMode: 'fallback_algorithmic',
    ...overrides,
  };
}

function makeContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
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
    ...overrides,
  };
}

test('createDecisionAgent returns agent with decide method', () => {
  const agent = createDecisionAgent(validConfig());
  assert.ok(agent);
  assert.equal(typeof agent.decide, 'function');
});

test('agent returns fallback when disabled', async () => {
  const agent = createDecisionAgent(validConfig({ enabled: false }));
  const result = await agent.decide(makeContext());
  assert.ok(result.tags?.includes('fallback'));
  assert.ok(result.tags?.includes('decision_agent_disabled'));
  assert.equal(result.generateText, false);
});

test('agent returns fallback when baseUrl is empty', async () => {
  const agent = createDecisionAgent(validConfig({ baseUrl: '' }));
  const result = await agent.decide(makeContext());
  assert.ok(result.tags?.includes('fallback'));
  assert.equal(result.generateText, false);
});

test('agent returns fallback when apiKey is empty', async () => {
  const agent = createDecisionAgent(validConfig({ apiKey: '' }));
  const result = await agent.decide(makeContext());
  assert.ok(result.tags?.includes('fallback'));
});

test('agent returns fallback when model is empty', async () => {
  const agent = createDecisionAgent(validConfig({ model: '' }));
  const result = await agent.decide(makeContext());
  assert.ok(result.tags?.includes('fallback'));
});

test('agent returns safe observe for message tick on fallback', async () => {
  const agent = createDecisionAgent(validConfig({ enabled: false }));
  const result = await agent.decide(makeContext({ reason: 'message' }));
  assert.equal(result.action, 'observe');
});

test('agent returns safe silence for scheduled tick on fallback', async () => {
  const agent = createDecisionAgent(validConfig({ enabled: false }));
  const result = await agent.decide(makeContext({ reason: 'scheduled' }));
  assert.equal(result.action, 'silence');
});

test('agent with failMode=silence returns silence on error', async () => {
  // With a URL that will cause a network error, silence mode should produce silence.
  const agent = createDecisionAgent(validConfig({
    baseUrl: 'http://127.0.0.1:1',  // No server here
    timeoutMs: 100,
    failMode: 'silence',
  }));
  const result = await agent.decide(makeContext());
  assert.equal(result.action, 'silence');
  assert.ok(result.tags?.includes('decision_agent_error'));
});

test('agent with failMode=allow_reply_only returns reply for directed message', async () => {
  const agent = createDecisionAgent(validConfig({
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 100,
    failMode: 'allow_reply_only',
  }));
  const result = await agent.decide(makeContext({
    reason: 'message',
    event: {
      id: 'evt-1', messageId: 'msg-1', chatType: 'private', chatId: 'chat-1',
      senderId: 'sender-1', senderQQ: '123456', senderName: 'TestUser',
      text: 'Hello?', isDirected: true, mentionedSelf: true, repliedToSelf: false,
    },
  }));
  assert.equal(result.action, 'reply');
  assert.ok(result.generateText);
});

test('agent with failMode=allow_reply_only returns silence for non-directed', async () => {
  const agent = createDecisionAgent(validConfig({
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 100,
    failMode: 'allow_reply_only',
  }));
  const result = await agent.decide(makeContext({
    reason: 'scheduled',
    event: undefined,
  }));
  assert.equal(result.action, 'silence');
});

test('agent with failMode=fallback_algorithmic returns observe for message tick', async () => {
  const agent = createDecisionAgent(validConfig({
    baseUrl: 'http://127.0.0.1:1',
    timeoutMs: 100,
    failMode: 'fallback_algorithmic',
  }));
  const result = await agent.decide(makeContext());
  assert.equal(result.action, 'observe');
});
