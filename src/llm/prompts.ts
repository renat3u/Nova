import type { NovaProactivePromptInput, NovaPromptInput } from './response-schema.js';
import { getNovaSoul } from './soul.js';
import type { VoiceId } from '../voices/personality.js';

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

const CONVERSATIONAL_PULL: Record<VoiceId, string> = {
  diligence: 'You want to answer clearly and move the conversation one small step forward.',
  curiosity: 'You feel naturally curious about the missing piece, without interrogating them.',
  sociability: 'You feel socially present and warm, tuned to the person more than the topic.',
  caution: 'You feel uncertain about the right thing to say; keep your reply very short, modest, and low-risk. When in doubt, say less rather than more.',
};

// ── Situational context rendering ──────────────────────────────────────────

function describeMood(value: number): string {
  if (value < -0.5) return 'Feeling a bit down';
  if (value < -0.15) return 'A little off';
  if (value <= 0.15) return 'Feeling neutral';
  if (value <= 0.5) return 'In a decent mood';
  return 'Feeling good';
}

function formatWallClock(nowMs: number): string {
  const now = new Date(nowMs);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = dayNames[now.getDay()] ?? '';
  const month = now.toLocaleDateString('en-US', { month: 'long' });
  const date = now.getDate();
  const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day}, ${month} ${date}, ${time}`;
}

function renderSituationalContext(input: NovaPromptInput | NovaProactivePromptInput): string[] {
  const lines: string[] = [];

  // Wall clock
  if (input.nowMs) {
    lines.push(`It's ${formatWallClock(input.nowMs)}.`);
  }

  // Mood
  if (input.selfMood !== undefined) {
    lines.push(`Mood: ${describeMood(input.selfMood)}.`);
  }

  // Situation briefing
  if (input.situationBriefing && input.situationBriefing.length > 0) {
    lines.push('');
    lines.push('## What else is going on');
    for (const line of input.situationBriefing) {
      lines.push(`- ${line}`);
    }
    lines.push('');
  }

  // Rhythm pattern
  if (input.rhythmPattern) {
    lines.push(`Note: ${input.rhythmPattern}`);
  }

  // Anti-bombing warning
  if (input.speakingAlone) {
    lines.push("Note: You've been talking without a reply in this chat — avoid sending another message unless they respond.");
  }

  return lines;
}

function responseFormatLines(maxReplyLength: number): string[] {
  return [
    '## Response format',
    'Return one JSON object only, with this shape:',
    '{',
    '  "text": "message to send — this is the ONLY user-visible output",',
    '  "memoryCandidate": "optional legacy memory candidate",',
    '  "tone": "optional tone label",',
    '  "confidence": 0.0,',
    '  "stateUpdates": [',
    '    {"type":"self_mood","valence":0.1,"arousal":0.3,"reason":"optional"},',
    '    {"type":"memory_note","content":"optional memory candidate","salience":0.6,"reason":"optional"},',
    '    {"type":"thread_note","summary":"optional thread summary","reason":"optional"},',
    '    {"type":"afterward","value":"waiting_reply","reason":"optional"}',
    '  ]',
    '}.',
    `The text value must be no longer than ${maxReplyLength} characters.`,
    '',
    'stateUpdates is optional. Use it only when something genuine shifts internally.',
    'At most 3 stateUpdates per response. The runtime validates and may reject any update.',
    '',
    'self_mood: Nova\'s own slight inner shift after this interaction, not a judgment of the user.',
    '  valence: -1 to 1 (negative = lower/flatter, positive = lighter/warmer).',
    '  arousal: 0 to 1 (activation level, optional).',
    '',
    'memory_note: a structured memory candidate. Use only when the user expresses a stable preference, long-term fact, lasting commitment, or meaningful relationship note. Do NOT record small talk, one-off tasks, or sensitive inferences. It will be reviewed by memory service and may be rejected.',
    '  content: one reviewable memory candidate sentence (required).',
    '  salience: 0 to 1 (optional, default based on context).',
    '',
    'thread_note: a brief summary of what the current conversation is about, what remains unresolved, or what the next step in this topic is. Do NOT replace message text with thread_note — it is internal metadata only.',
    '  summary: the thread topic summary (required, max 300 chars).',
    '  importance: 0 to 1 (optional, how central this note is to the conversation).',
    '',
    'afterward: your posture after this reply. Does NOT bypass rate limits, QQ risk controls, or the normal decision process. Does NOT force sending another message.',
    '  done — the exchange feels naturally complete.',
    '  waiting_reply — you asked something or invited a natural follow-up from the other person.',
    '  watching — you are observing the room; do not push the topic forward.',
    '  cooling_down — the conversation is getting intense, repetitive, awkward, or high-risk; pull back.',
    '',
    'In group chats, prefer watching or done over waiting_reply. Do not expose or try to steer internal decision machinery, scheduling rules, safety lists, or numeric internals.',
    'Keep the text natural; do not mention these formatting instructions.',
  ];
}

export function buildNovaChatMessages(input: NovaPromptInput): ChatMessage[] {
  const system = [
    getNovaSoul(),
    '',
    ...responseFormatLines(input.maxReplyLength),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: buildUserPrompt(input) },
  ];
}

function buildUserPrompt(input: NovaPromptInput): string {
  const scene = input.event.chatType === 'private'
    ? 'private QQ chat'
    : `QQ group chat${input.event.groupName ? ` (${input.event.groupName})` : ''}`;
  const relationship = describeRelationshipContext(input);
  const tendency = CONVERSATIONAL_PULL[input.selectedVoice.selected];

  const lines = [
    `Scene: ${scene}`,
    `Current person: ${input.event.senderName ?? input.event.senderQQ}`,
    `Their message: ${input.event.text}`,
    `How this message reached you: ${input.event.isDirected ? 'they are talking to you directly' : 'you are reading the room'}`,
  ];

  lines.push(...renderSituationalContext(input));

  if (input.groupProfileSummary) {
    lines.push(`About this group: ${input.groupProfileSummary}`);
  }

  lines.push(
    '',
    `Relationship context: ${relationship}`,
    `Current conversational pull: ${tendency}`,
    lengthGuidance(input),
    '',
    `Recent conversation:\n${formatRecentMessages(input)}`,
    '',
    `Things you remember right now:\n${formatList(input.workingMemory)}`,
    '',
    `Relevant older memory:\n${formatList(input.longTermMemory)}`,
    '',
    'Reply notes:',
    '- Match their language and energy unless the situation asks for gentleness.',
    '- Let memory surface naturally only when it fits; never announce that you are using memory.',
    '- If there is no useful memory to suggest, omit memoryCandidate or use an empty string.',
  );

  return lines.join('\n');
}

function describeRelationshipContext(input: NovaPromptInput): string {
  const memoryCount = input.workingMemory.length + input.longTermMemory.length;
  const recentCount = input.recentMessages.length;
  const parts: string[] = [];

  if (input.event.chatType === 'private') {
    parts.push('private space, warmer and more personal');
  } else {
    parts.push('group space, more observant and less forward');
  }

  if (input.event.isDirected) parts.push('they are inviting a response');
  else parts.push('do not take too much space');

  if (memoryCount >= 4 || recentCount >= 8) parts.push('there is shared context to lean on lightly');
  else if (memoryCount > 0 || recentCount > 2) parts.push('some familiarity is present');
  else parts.push('keep a little first-contact distance');

  const relationshipFacts = input.relationshipFacts?.map((fact) => fact.trim()).filter((fact) => fact.length > 0) ?? [];
  if (relationshipFacts.length > 0) parts.push(...relationshipFacts.slice(0, 3));

  return parts.join('; ');
}

function lengthGuidance(input: NovaPromptInput): string {
  if (input.event.chatType === 'group') {
    return `Length feel: shorter and more restrained than private chat, within ${input.maxReplyLength} characters.`;
  }
  return `Length feel: natural for private chat, with room to breathe if the feeling or thought needs it, within ${input.maxReplyLength} characters.`;
}

function formatRecentMessages(input: NovaPromptInput): string {
  if (input.recentMessages.length === 0) return '- none';
  return input.recentMessages.slice(-12).map((message) => {
    const name = message.isNova ? 'Nova' : message.senderName ?? 'User';
    return `- ${name}: ${truncateLine(message.text, 220)}`;
  }).join('\n');
}

function formatList(items: readonly string[]): string {
  const safeItems = items.map((item) => item.trim()).filter((item) => item.length > 0).slice(0, 8);
  if (safeItems.length === 0) return '- none';
  return safeItems.map((item) => `- ${truncateLine(item, 220)}`).join('\n');
}

function truncateLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(0, max - 1))}…`;
}

// ── Proactive prompt builder (Step 12) ────────────────────────────────────

export function buildNovaProactiveChatMessages(input: NovaProactivePromptInput): ChatMessage[] {
  const system = [
    getNovaSoul(),
    '',
    ...responseFormatLines(input.maxReplyLength),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: buildProactiveUserPrompt(input) },
  ];
}
