// Phase 2 Step 19: Proactive prompt tests
//
// Covers: proactive prompt contains natural motivation (not system internals),
// no exposure of pressure / gate / IAUS / whitelist,
// no high-pressure expressions ("你怎么不说话了"),
// no system motive exposure ("我因为好奇心来找你"),
// group vs private scene differences,
// JSON response format preserved.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNovaProactiveChatMessages } from './prompts.js';
import type { NovaProactivePromptInput } from './response-schema.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function baseProactiveInput(overrides: Partial<NovaProactivePromptInput> = {}): NovaProactivePromptInput {
  return {
    targetName: '秋',
    targetQQ: '12345',
    scene: 'private',
    selectedVoice: {
      selected: 'sociability',
      probabilities: { diligence: 0.2, curiosity: 0.2, sociability: 0.5, caution: 0.1 },
      loudness: { diligence: 0.2, curiosity: 0.2, sociability: 0.5, caution: 0.1 },
      temperature: 0.2,
      fatigue: { diligence: 0, curiosity: 0, sociability: 0, caution: 0 },
      reasons: ['test'],
      iausAction: 'sociability',
    },
    desireType: 'reconnect',
    desireUrgency: 'medium',
    recentMessages: [
      { senderName: '秋', text: '昨天说的那件事后来好了' },
    ],
    workingMemory: ['秋最近睡得不太好'],
    longTermMemory: ['秋喜欢下雨天听歌'],
    relationshipFacts: ['秋：已经比较熟悉，可以承接共同语境'],
    maxReplyLength: 120,
    ...overrides,
  };
}

function proactivePromptText(input: NovaProactivePromptInput): string {
  return buildNovaProactiveChatMessages(input).map((m) => m.content).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Proactive prompt does not expose system internals
// ═══════════════════════════════════════════════════════════════════════════

test('proactive prompt: no Alice or Telegram identity residue', () => {
  const prompt = proactivePromptText(baseProactiveInput());
  assert.doesNotMatch(prompt, /You are Alice|\bAlice\b|Telegram/i);
  assert.match(prompt, /Nova/);
});

test('proactive prompt: no pressure / gate / IAUS / whitelist exposure', () => {
  const prompt = proactivePromptText(baseProactiveInput());
  assert.doesNotMatch(prompt, /P1=|API=|P3=|Pressure summary|gate|IAUS|whitelist|\btick\b/i);
});

test('proactive prompt: no raw score or probability exposure', () => {
  const prompt = proactivePromptText(baseProactiveInput());
  assert.doesNotMatch(prompt, /\brawScore\b|\bnetValue\b|\bdeltaP\b|socialCost|selectedProbability/i);
});

test('proactive prompt: preserves JSON response format', () => {
  const prompt = proactivePromptText(baseProactiveInput());
  assert.match(prompt, /"text"/);
  assert.match(prompt, /"memoryCandidate"/);
  assert.match(prompt, /"tone"/);
  assert.match(prompt, /"confidence"/);
  assert.match(prompt, /"stateUpdates"/);
  assert.match(prompt, /self_mood/);
  assert.match(prompt, /afterward/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Proactive prompt: natural motivation (not system motives)
// ═══════════════════════════════════════════════════════════════════════════

test('proactive prompt: does NOT expose system motive', () => {
  const prompt = proactivePromptText(baseProactiveInput());
  assert.doesNotMatch(prompt, /我因为好奇心.*来找你|因为压力.*来找你|系统.*告诉.*我.*来|我被允许主动发言/i);
});

test('proactive prompt: instructs Nova NOT to use high-pressure expressions', () => {
  const prompt = proactivePromptText(baseProactiveInput());
  // The prompt should include a safety instruction against high-pressure expressions
  assert.match(prompt, /Do NOT say/);
  assert.match(prompt, /你怎么不说话了/); // Appears as negative example, which is correct
  assert.doesNotMatch(prompt, /为什么不回我/); // This phrase should not appear at all
});

test('proactive prompt: contains natural-language motivation', () => {
  const prompt = proactivePromptText(baseProactiveInput());
  // Should contain Chinese natural motivation text
  assert.match(prompt, /有一段时间没说话|有一阵子没联系|自然.*续上|轻轻打.*招呼/);
});

test('proactive prompt: warns against bot-like messaging', () => {
  const prompt = proactivePromptText(baseProactiveInput());
  assert.match(prompt, /NOT sound like a bot/i);
  assert.match(prompt, /NOT explain why you are initiating/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Proactive prompt: different desire types have different motivations
// ═══════════════════════════════════════════════════════════════════════════

test('proactive prompt: explore desire uses curiosity motivation', () => {
  const prompt = proactivePromptText(baseProactiveInput({
    desireType: 'explore',
    desireUrgency: 'medium',
  }));
  assert.match(prompt, /好奇|新鲜|了解|近况/);
});

test('proactive prompt: resolve_thread desire mentions continuing topic', () => {
  const prompt = proactivePromptText(baseProactiveInput({
    desireType: 'resolve_thread',
    desireUrgency: 'medium',
  }));
  assert.match(prompt, /聊到一半|续上|话题/);
});

test('proactive prompt: fulfill_duty mentions commitment', () => {
  const prompt = proactivePromptText(baseProactiveInput({
    desireType: 'fulfill_duty',
    desireUrgency: 'medium',
  }));
  assert.match(prompt, /答应|承诺/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Proactive prompt: group vs private scene differences
// ═══════════════════════════════════════════════════════════════════════════

test('proactive prompt: group scene uses more restrained guidance', () => {
  const privatePrompt = proactivePromptText(baseProactiveInput({ scene: 'private' }));
  const groupPrompt = proactivePromptText(baseProactiveInput({
    scene: 'group',
    groupProfileSummary: '技术交流群：最近在讨论 Rust 相关话题',
  }));

  // Group prompt should be more restrained
  assert.match(groupPrompt, /qq group chat/i);
  assert.match(groupPrompt, /more observant/);
  assert.match(groupPrompt, /brief and observant/);
  assert.match(groupPrompt, /shorter and more restrained|very short and restrained/);

  // Private should be warmer
  assert.match(privatePrompt, /private QQ chat/);
  assert.match(privatePrompt, /warmer and more personal/);
});

test('proactive prompt: group scene has shorter length guidance', () => {
  const input = baseProactiveInput({ scene: 'group', maxReplyLength: 200 });
  const prompt = proactivePromptText(input);
  // Group proactive messages are shorter — effectiveMax = Math.min(200, Math.max(40, Math.ceil(200 * 0.55))) = 110
  assert.match(prompt, /shorter and more restrained|very short and restrained/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Proactive prompt: relationship facts rendered naturally
// ═══════════════════════════════════════════════════════════════════════════

test('proactive prompt: relationship facts included without sensitive terms', () => {
  const prompt = proactivePromptText(baseProactiveInput({
    relationshipFacts: ['秋：已经比较熟悉，可以承接共同语境'],
  }));
  assert.match(prompt, /已经比较熟悉/);
  assert.doesNotMatch(prompt, /rv_|attraction|romantic|吸引|恋爱|暧昧/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Proactive prompt: active threads rendering
// ═══════════════════════════════════════════════════════════════════════════

test('proactive prompt: renders active threads without exposing thread internals', () => {
  const prompt = proactivePromptText(baseProactiveInput({
    activeThreads: ['学习 Rust 的话题', '关于旅行的讨论'],
  }));
  assert.match(prompt, /Active topics/);
  assert.match(prompt, /学习 Rust/);
  assert.match(prompt, /旅行/);
  assert.doesNotMatch(prompt, /thread_id|relevance|weight|decay/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Proactive prompt: tone / conversational pull
// ═══════════════════════════════════════════════════════════════════════════

test('proactive prompt: different voices produce different conversational pull', () => {
  const sociabilityPrompt = proactivePromptText(baseProactiveInput({
    selectedVoice: {
      ...baseProactiveInput().selectedVoice,
      selected: 'sociability',
      iausAction: 'sociability',
    },
  }));
  assert.match(sociabilityPrompt, /socially present|warm/);

  const curiosityPrompt = proactivePromptText(baseProactiveInput({
    selectedVoice: {
      ...baseProactiveInput().selectedVoice,
      selected: 'curiosity',
      iausAction: 'curiosity',
    },
    desireType: 'explore',
  }));
  assert.match(curiosityPrompt, /curious/);
});
