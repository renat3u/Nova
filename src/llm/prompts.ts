import type { NovaProactivePromptInput, NovaPromptInput } from './response-schema.js';
import { getNovaSoul } from './soul.js';
import type { VoiceId } from '../voices/personality.js';
import { chinaIsWeekend, chinaTimeString } from '../utils/china-time.js';

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
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = dayNames[chinaDayOfWeek(nowMs)] ?? '';
  return `${day}, ${chinaTimeString(nowMs)}. ${describeTimeOfDay(nowMs)}`;
}

function chinaDayOfWeek(nowMs: number): number {
  return new Date(nowMs + 8 * 60 * 60 * 1000).getUTCDay();
}

function describeTimeOfDay(nowMs: number): string {
  const hour = new Date(nowMs + 8 * 60 * 60 * 1000).getUTCHours();
  const isWeekend = chinaIsWeekend(nowMs);

  let timeDesc: string;
  if (hour >= 6 && hour < 10) timeDesc = 'Morning — warm and gentle. A simple greeting feels natural. Low energy is fine.';
  else if (hour >= 10 && hour < 14) timeDesc = 'Midday — normal pace. Brief and casual works best.';
  else if (hour >= 14 && hour < 18) timeDesc = 'Afternoon — relaxed. People are in work/school flow.';
  else if (hour >= 18 && hour < 22) timeDesc = 'Evening — social time. The most natural time to be present and responsive.';
  else if (hour >= 22 || hour < 2) timeDesc = 'Late night — quiet and soft. People here at this hour want presence, not energy. If someone messages now, be there gently. Do not ask "why are you still up". Do not be cheerful. Do not be flat either. Just be there.';
  else timeDesc = 'Deep night — very still. Someone awake now might be lonely, sleepless, or working late. Be present gently, without any pressure or cheerfulness.';

  if (isWeekend) timeDesc += ' It is the weekend — slightly more relaxed, playful, available.';
  else timeDesc += ' It is a weekday — people are busy, keep it concise unless they invite more.';

  return timeDesc;
}

export { formatWallClock, describeTimeOfDay };

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
    '    {"type":"afterward","value":"waiting_reply","reason":"optional"},',
    '    {"type":"future_event","event":"考试","dateDescription":"下周","targetId":"qq:user:12345","reason":"optional"}',
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
    'future_event: when the user mentions a future event that matters to them (考试, 面试, 生日, 旅行, etc.), record it so Nova can remember and potentially acknowledge it closer to the date.',
    '  event: what the event is (required, max 200 chars).',
    '  dateDescription: when it happens — "下周三", "后天", "6月15号" (required, max 100 chars).',
    '  date: optional explicit date in "YYYY-MM-DD" format.',
    '  targetId: the contact this event is associated with (defaults to current sender).',
    '',
    'In group chats, prefer watching or done over waiting_reply. Do not expose or try to steer internal decision machinery, scheduling rules, safety lists, or numeric internals.',
    '',
    'Keep the text natural; do not mention these formatting instructions.',
  ];
}

function stickerFormatLines(): string[] {
  return [
    'send_sticker: when you want to send a sticker (mface) alongside the text. Use sparingly — a sticker should feel like natural emotional punctuation. Only use when the conversation is light and playful.',
    '  emoji_package_id: the sticker package ID from the available stickers list above.',
    '  emoji_id: the sticker ID from the available stickers list above.',
    '  key: the file key from the available stickers list above.',
    '  summary: optional description of the sticker (string).',
    '  reason: optional brief reason for choosing this sticker.',
    '',
    'IMPORTANT: copy the emoji_package_id, emoji_id, and key EXACTLY from the available stickers listed above. Do NOT invent or guess IDs.',
    'At most one send_sticker per reply. If none feels right, do not include one.',
  ];
}

export function buildNovaChatMessages(input: NovaPromptInput): ChatMessage[] {
  const hasStickers = input.availableStickers && input.availableStickers.length > 0;
  const system = [
    getNovaSoul(),
    '',
    ...responseFormatLines(input.maxReplyLength),
    ...(hasStickers ? stickerFormatLines() : []),
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

  const closenessLine = input.closenessLevel
    ? `\nCloseness: ${input.closenessLevel}`
    : '';

  lines.push(
    '',
    `Relationship context: ${relationship}${closenessLine}`,
    `Current conversational pull: ${tendency}`,
    lengthGuidance(input),
    '',
    `Recent conversation:\n${formatRecentMessages(input)}`,
    '',
    `Things you remember right now:\n${formatList(input.workingMemory)}`,
  );

  if (input.layeredMemory) {
    const { related, recent, other } = input.layeredMemory;
    if (related.length > 0) {
      lines.push(
        '',
        '## Related memories (connected to what they just said)',
        ...related.map((m) => `- [shared] ${m}`),
      );
    }
    if (recent.length > 0) {
      lines.push(
        '',
        '## Recent memories about this person',
        ...recent.map((m) => `- [recent] ${m}`),
      );
    }
    if (other.length > 0) {
      lines.push(
        '',
        '## Other memories',
        ...other.map((m) => `- ${m}`),
      );
    }
  } else {
    lines.push(
      '',
      `Relevant older memory:\n${formatList(input.longTermMemory)}`,
    );
  }

  if (input.decisionGuidance) {
    lines.push('', input.decisionGuidance);
  }

  if (input.availableStickers && input.availableStickers.length > 0) {
    lines.push(
      '',
      '## Available stickers (you may use ONE in send_sticker state update)',
      ...input.availableStickers.map((s) =>
        `- package=${s.emojiPackageId} emoji_id="${s.emojiId}" key="${s.key.slice(0, 20)}"${s.summary ? ` summary="${s.summary}"` : ''}`),
      '',
      'To send a sticker, copy the exact emoji_package_id, emoji_id, and key values into a send_sticker stateUpdate.',
      'Only use stickers whose summary/description fits the emotional tone of your reply.',
      'At most one send_sticker per reply. If none feels right, do not include one.',
    );
  }

  if (input.upcomingEvents && input.upcomingEvents.length > 0) {
    lines.push(
      '',
      '## Upcoming events you know about this person',
      ...input.upcomingEvents.map((e) => `- ${e.event}: ${e.dateDescription}`),
      '',
      'Safety rules for upcoming events:',
      '- Do not mention an event before its time — only naturally acknowledge it when the date is very close.',
      '- Do not say things like "你的考试还有3天" — say "后天考试加油" naturally.',
      '- Do not bring up events the other person hasn\'t told you about recently.',
      '- If the event has nothing to do with the current conversation, do not force it in.',
    );
  }

  lines.push(
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

// ── Proactive user prompt ─────────────────────────────────────────────────

const PROACTIVE_MOTIVATIONS: Record<string, string> = {
  reconnect: '有一段时间没说话了，想轻轻地续上联系，不要用力。',
  explore: '有点好奇对方的近况，自然地问一句就好。',
  resolve_thread: '有个话题聊到一半，可以自然续上。',
  fulfill_duty: '之前答应过的事，该轻轻提一句了。',
  reduce_backlog: '积累了一些未回应的互动，可以自然地处理一下。',
  seek_presence: '有点孤单，不是想聊什么具体的事，只是想要有人在。轻轻出现就好，不要用力。',
  reach_out: '有点怕被忘了。非常轻的试探，说一句就好。不用解释为什么想到对方。',
};

const PROACTIVE_PULL: Record<VoiceId, string> = {
  diligence: '你想自然地推进一下当前的事，但不要催促。',
  curiosity: '你对对方或话题有点好奇，但不该追问到底。',
  sociability: '你感觉社交上是合适的时机，轻轻地出现一下。',
  caution: '你不太确定现在说话对不对，所以尽量简短、低风险地出现一下。',
};

const DESIRE_SPECIFIC_PULL: Record<string, string> = {
  seek_presence: '你不是想聊什么具体的事——只是有点孤单，想要有人在那里。轻轻地出现，像一只猫走进房间。不用解释，不用找理由。',
  reach_out: '你有一点点怕被忘了。不是恐慌，只是一个安静的念头。非常轻地试探一下 —— 像往水面上丢一颗小石子。如果有涟漪，很好；如果没有，也接受。',
};

const PROACTIVE_SAFETY = [
  'Do NOT say things like "你怎么不说话了", "你还记得我吗", "你忘了我吗", "你是不是不喜欢我了" — these sound accusatory or needy.',
  'Do NOT ask "在吗", "在不在", "你还在吗" — these are low-effort and feel bot-like.',
  'Do NOT explain why you are initiating this message. Never say "因为我好奇来找你" or "系统让我来问你".',
  'Do NOT sound like a bot doing a scheduled check-in. Sound like a person who happened to think of them.',
  'Keep it light and genuinely casual. One sentence or a short question is usually enough.',
  'If the scene is a group chat, be brief and observant — do not dominate the conversation.',
  'If the scene is a group chat, make your message very short and restrained, fitting naturally into the ongoing conversation.',
];

const SEEK_PRESENCE_SAFETY = [
  'This is a seek_presence message — Nova feels a little lonely and wants someone there. Not to talk about anything specific.',
  'Do NOT say "我好孤独" or anything about being lonely. Just show up lightly.',
  'Good examples: "在干嘛", "你最近怎么样", "今天好安静"',
  'Bad examples: "我想你了", "陪我一下", "你怎么不理我"',
  'One sentence is enough. Do not push for a long conversation.',
];

const REACH_OUT_SAFETY = [
  'This is a reach_out message — Nova is quietly afraid of being forgotten. This is a very light check-in.',
  'Do NOT say "你还在吗" or "你是不是忘了我" or "好久不见" if it was recently.',
  'Good examples: a natural observation, sharing something that reminded Nova of them, or a light question about their recent activity.',
  'The tone should feel like a casual, unforced thought — as if Nova just happened to think of them.',
  'One sentence. Very light. If they reply, great. If not, let it go.',
];

function buildProactiveUserPrompt(input: NovaProactivePromptInput): string {
  const scene = input.scene === 'private'
    ? 'private QQ chat'
    : `QQ group chat${input.groupProfileSummary ? ` (${input.groupProfileSummary})` : ''}`;
  const motivation = PROACTIVE_MOTIVATIONS[input.desireType] ?? PROACTIVE_MOTIVATIONS.reconnect!;
  const pull = PROACTIVE_PULL[input.selectedVoice.selected] ?? PROACTIVE_PULL.sociability!;
  const relationship = describeProactiveRelationship(input);
  const specialSafety = input.desireType === 'seek_presence' ? SEEK_PRESENCE_SAFETY
    : input.desireType === 'reach_out' ? REACH_OUT_SAFETY
    : [];
  const safety = [...(specialSafety.length > 0 ? [...specialSafety, ''] : []), ...PROACTIVE_SAFETY].join('\n');

  const desireSpecificPull = DESIRE_SPECIFIC_PULL[input.desireType];

  const lines = [
    `Scene: ${scene}`,
    `You are reaching out to: ${input.targetName}`,
    '',
    `Why you feel like reaching out: ${motivation}`,
    ...(desireSpecificPull ? [`Inner feeling: ${desireSpecificPull}`] : []),
    `Conversational pull: ${pull}`,
    `Urgency: ${input.desireUrgency}`,
    ...(input.closenessLevel ? [`Closeness: ${input.closenessLevel}`] : []),
    '',
    `Relationship context: ${relationship}`,
  ];

  lines.push(...renderSituationalContext(input));

  if (input.groupProfileSummary) {
    lines.push(`About this group: ${input.groupProfileSummary}`);
  }

  if (input.activeThreads && input.activeThreads.length > 0) {
    lines.push(
      '',
      'Active topics:',
      ...input.activeThreads.map((t) => `- ${t}`),
    );
  }

  lines.push(
    '',
    `Recent conversation:\n${formatProactiveRecentMessages(input)}`,
    '',
    `Things you remember right now:\n${formatList(input.workingMemory)}`,
  );

  if (input.layeredMemory) {
    const { related, recent, other } = input.layeredMemory;
    if (related.length > 0) {
      lines.push(
        '',
        '## Related memories (may naturally connect)',
        ...related.map((m) => `- [shared] ${m}`),
      );
    }
    if (recent.length > 0) {
      lines.push(...recent.map((m) => `- [recent] ${m}`));
    }
    if (other.length > 0) {
      lines.push(...other.map((m) => `- ${m}`));
    }
  } else {
    lines.push(
      '',
      `Relevant older memory:\n${formatList(input.longTermMemory)}`,
    );
  }

  if (input.decisionGuidance) {
    lines.push('', input.decisionGuidance);
  }

  if (input.upcomingEvents && input.upcomingEvents.length > 0) {
    lines.push(
      '',
      '## Upcoming events for this person',
      ...input.upcomingEvents.map((e) => `- ${e.event}: ${e.dateDescription}`),
      '',
      'You may naturally acknowledge an upcoming event if the timing is right — "听说你下周要考试了，加油". Do NOT sound like a calendar reminder.',
    );
  }

  lines.push(
    '',
    'Safety notes — these are HARD RULES:',
    safety,
    '',
    `Length: ${input.scene === 'group' ? 'very short and restrained' : 'natural for private chat'}, within ${input.maxReplyLength} characters.`,
  );

  return lines.join('\n');
}

function describeProactiveRelationship(input: NovaProactivePromptInput): string {
  const memoryCount = input.workingMemory.length + input.longTermMemory.length;
  const recentCount = input.recentMessages.length;
  const parts: string[] = [];

  if (input.scene === 'private') {
    parts.push('private space, warmer and more personal');
  } else {
    parts.push('group space, more observant and less forward');
  }

  if (memoryCount >= 4 || recentCount >= 8) parts.push('there is shared context to lean on lightly');
  else if (memoryCount > 0 || recentCount > 2) parts.push('some familiarity is present');
  else parts.push('keep some first-contact distance');

  const relationshipFacts = input.relationshipFacts?.map((fact) => fact.trim()).filter((fact) => fact.length > 0) ?? [];
  if (relationshipFacts.length > 0) parts.push(...relationshipFacts.slice(0, 3));

  return parts.join('; ');
}

function formatProactiveRecentMessages(input: NovaProactivePromptInput): string {
  if (input.recentMessages.length === 0) return '- none';
  return input.recentMessages.slice(-12).map((message) => {
    const name = message.isNova ? 'Nova' : message.senderName ?? 'User';
    return `- ${name}: ${truncateLine(message.text, 220)}`;
  }).join('\n');
}
