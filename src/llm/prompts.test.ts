import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadNovaSoul } from './soul.js';
import { buildNovaChatMessages } from './prompts.js';
import type { NovaPromptInput } from './response-schema.js';

const baseInput: NovaPromptInput = {
  event: {
    id: 'event:1',
    platform: 'qq',
    rawEvent: {},
    messageId: 'message:1',
    rawMessageId: '1',
    chatType: 'private',
    chatId: 'qq:private:10001',
    senderId: 'qq:user:10001',
    senderQQ: '10001',
    senderName: '秋',
    text: '今天有点累',
    rawText: '今天有点累',
    timestamp: 1,
    isSelf: false,
    mentionedSelf: false,
    repliedToSelf: false,
    isDirected: true,
  },
  recentMessages: [
    { senderName: '秋', text: '昨天说的那件事后来好了', isNova: false },
  ],
  selectedVoice: {
    selected: 'sociability',
    probabilities: { diligence: 0.2, curiosity: 0.2, sociability: 0.5, caution: 0.1 },
    loudness: { diligence: 0.2, curiosity: 0.2, sociability: 0.5, caution: 0.1 },
    temperature: 0.2,
    fatigue: { diligence: 0, curiosity: 0, sociability: 0, caution: 0 },
    reasons: ['test'],
    iausAction: 'sociability',
  },
  pressure: {
    tick: 1,
    createdMs: 1,
    p1: 1,
    p2: 2,
    p3: 3,
    p4: 4,
    p5: 5,
    p6: 6,
    pProspect: 0.2,
    api: 1.2,
    apiPeak: 2.3,
    contributions: {},
  },
  personality: {
    diligence: 0.25,
    curiosity: 0.25,
    sociability: 0.25,
    caution: 0.25,
  },
  workingMemory: ['秋最近睡得不太好'],
  longTermMemory: ['秋喜欢下雨天听歌'],
  relationshipFacts: ['秋：已经比较熟悉，可以承接共同语境'],
  maxReplyLength: 120,
};

function promptText(input: NovaPromptInput): string {
  return buildNovaChatMessages(input).map((message) => message.content).join('\n');
}

test('Nova soul loads formal SOUL.md without Alice or Telegram residue', () => {
  const soul = loadNovaSoul({ soulPath: 'src/soul/SOUL.md' });
  assert.match(soul, /You are Nova/);
  assert.match(soul, /QQ/);
  assert.match(soul, /NapCat|QQ 私聊|QQ group|QQ chat|QQ 私聊与群聊/i);
  assert.doesNotMatch(soul, /You are Alice|Telegram/i);
  assert.doesNotMatch(soul, /\bpressure\b|\bgate\b|\bIAUS\b|schema|trace/i);
  assert.ok(soul.length > 4000, 'formal soul should preserve the full Nova core, not a short fallback');
});

test('Nova prompt has no Alice or Telegram identity residue', () => {
  const prompt = promptText(baseInput);
  assert.doesNotMatch(prompt, /You are Alice|\bAlice\b|Telegram/i);
  assert.match(prompt, /You are Nova/);
  assert.match(prompt, /QQ/);
});

test('Nova prompt does not expose internal pressure or decision machinery', () => {
  const prompt = promptText(baseInput);
  assert.doesNotMatch(prompt, /P1=|API=|Pressure summary|Selected voice|voice selection|\bgate\b|\bIAUS\b|whitelist|\btick\b/i);
});

test('Nova prompt preserves JSON response compatibility without schema wording', () => {
  const prompt = promptText(baseInput);
  assert.match(prompt, /"text"/);
  assert.match(prompt, /"memoryCandidate"/);
  assert.match(prompt, /"tone"/);
  assert.match(prompt, /"confidence"/);
  assert.match(prompt, /"stateUpdates"/);
  assert.match(prompt, /self_mood/);
  assert.match(prompt, /afterward/);
  assert.doesNotMatch(prompt, /JSON schema/i);
});

test('Relationship facts are rendered as natural context without sensitive vector terms', () => {
  const prompt = promptText(baseInput);
  assert.match(prompt, /已经比较熟悉/);
  assert.doesNotMatch(prompt, /rv_|attraction|romantic|吸引|恋爱|暧昧/i);
});

test('Private and group scenes carry different social guidance', () => {
  const privatePrompt = promptText(baseInput);
  const groupPrompt = promptText({
    ...baseInput,
    event: {
      ...baseInput.event,
      chatType: 'group',
      chatId: 'qq:group:20001',
      groupId: '20001',
      groupName: '测试群',
      isDirected: false,
    },
  });

  assert.match(privatePrompt, /private QQ chat/);
  assert.match(privatePrompt, /warmer and more personal/);
  assert.match(groupPrompt, /QQ group chat/);
  assert.match(groupPrompt, /shorter and more restrained/);
  assert.match(groupPrompt, /more observant and less forward/);
});
