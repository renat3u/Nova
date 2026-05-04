//
// Lightweight sentiment detection from message text.
// Uses keyword + pattern matching — NOT an LLM call.
// Designed to be called every message tick with zero latency.
//
// The detected signal is used to nudge Nova's MoodTracker via emotional
// contagion: other people's emotions infect Nova, but gently — the weight
// is small (0.03–0.08), so Nova won't be flipped by a single message.
//

export interface SentimentSignal {
  /** -1 (very negative) to 1 (very positive) */
  valence: number;
  /** How confident we are about this signal (0-1) */
  confidence: number;
  /** Keywords or patterns that triggered this */
  cues: string[];
}

// ── Positive patterns ──────────────────────────────────────────────────────

const POSITIVE_PATTERNS: Array<{ regex: RegExp; valence: number }> = [
  { regex: /哈{3,}/, valence: 0.3 },
  { regex: /笑死[我了]?/, valence: 0.3 },
  { regex: /好开心|太开心|超开心/, valence: 0.4 },
  { regex: /哈哈哈哈/, valence: 0.35 },
  { regex: /太棒了|太好了|真好|不错哦/, valence: 0.3 },
  { regex: /nice|好耶|牛[逼批]/, valence: 0.25 },
  { regex: /爱[了你]|喜欢|可爱/, valence: 0.25 },
  { regex: /谢谢|感谢|多谢/, valence: 0.2 },
  { regex: /抱抱|贴贴|mua|亲亲/, valence: 0.3 },
  { regex: /[嘿嘿]{2,}|[嘻嘻]{2,}/, valence: 0.2 },
  { regex: /hhhh+|aw+[some]*/i, valence: 0.15 },
  { regex: /[强赞棒帅酷美]{2,}/, valence: 0.2 },
  { regex: /恭喜|庆祝|祝贺/, valence: 0.25 },
  { regex: /舒服|满足|幸福/, valence: 0.3 },
  { regex: /冲[了啊啊]|起飞|天哪.*[好好太]/, valence: 0.2 },
];

// ── Negative patterns ──────────────────────────────────────────────────────

const NEGATIVE_PATTERNS: Array<{ regex: RegExp; valence: number }> = [
  { regex: /[哭惹]+[了死]/, valence: -0.4 },
  { regex: /好难过|好伤心|好难受/, valence: -0.5 },
  { regex: /撑不住了|受不了了|崩溃/, valence: -0.5 },
  { regex: /救命[啊呀]?[!！]?$/, valence: -0.2 },
  { regex: /好烦[啊哦]?|烦死了|真烦/, valence: -0.3 },
  { regex: /无语[了死]?|……{2,}/, valence: -0.2 },
  { regex: /算了[吧]?[。…]?$/, valence: -0.3 },
  { regex: /没事[。…]?$/m, valence: -0.15 },
  { regex: /[呜呜]{2,}|[哭哭]{2,}/, valence: -0.3 },
  { regex: /生气|愤怒|气死|火大/, valence: -0.4 },
  { regex: /失望|心寒|凉了/, valence: -0.4 },
  { regex: /累了|好累|疲惫/, valence: -0.25 },
  { regex: /[叹气]{2,}|唉{2,}/, valence: -0.2 },
  { regex: /不想[说讲话]了?/, valence: -0.35 },
  { regex: /孤独|寂寞|一个人/, valence: -0.3 },
  { regex: /[害怕恐][惧怕]|焦虑|担心/, valence: -0.35 },
  { regex: /被.*[骂说批评]/, valence: -0.3 },
  { regex: /[不没]开心|[不没]高兴/, valence: -0.25 },
];

/**
 * Lightweight sentiment detection from message text.
 * Returns null if no clear signal is detected (below confidence floor).
 */
export function detectSentiment(text: string): SentimentSignal | null {
  const cues: string[] = [];
  let totalValence = 0;
  let totalWeight = 0;

  for (const pattern of POSITIVE_PATTERNS) {
    if (pattern.regex.test(text)) {
      cues.push(`+${pattern.valence.toFixed(1)}:${pattern.regex.source.slice(0, 20)}`);
      totalValence += pattern.valence;
      totalWeight += 1;
    }
  }

  for (const pattern of NEGATIVE_PATTERNS) {
    if (pattern.regex.test(text)) {
      cues.push(`${pattern.valence.toFixed(1)}:${pattern.regex.source.slice(0, 20)}`);
      totalValence += pattern.valence;
      totalWeight += 1;
    }
  }

  if (totalWeight === 0) return null;

  const avgValence = totalValence / totalWeight;
  const confidence = Math.min(0.9, 0.3 + totalWeight * 0.15);

  return {
    valence: clamp(avgValence, -1, 1),
    confidence,
    cues: cues.slice(0, 6),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
