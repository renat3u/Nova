export interface TextExtractionResult {
  text: string;
  rawText: string;
  mentionedSelf: boolean;
  replyToMessageId?: string;
}

interface MessageSegment {
  type?: unknown;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

export function extractMessageText(message: unknown, rawMessage: unknown, selfId?: string): TextExtractionResult {
  if (!Array.isArray(message)) {
    const text = typeof message === 'string'
      ? message
      : typeof rawMessage === 'string'
        ? rawMessage
        : '';

    return {
      text: text.trim(),
      rawText: text,
      mentionedSelf: false,
    };
  }

  const chunks: string[] = [];
  let mentionedSelf = false;
  let replyToMessageId: string | undefined;

  for (const segment of message as MessageSegment[]) {
    if (!isRecord(segment) || typeof segment.type !== 'string' || !isRecord(segment.data)) continue;

    switch (segment.type) {
      case 'text': {
        const text = asString(segment.data.text);
        if (text) chunks.push(text);
        break;
      }
      case 'at': {
        const qq = asString(segment.data.qq);
        if (selfId && qq === selfId) mentionedSelf = true;
        break;
      }
      case 'reply': {
        const id = asString(segment.data.id) ?? asString(segment.data.seq);
        if (id && replyToMessageId === undefined) replyToMessageId = id;
        break;
      }
      default:
        break;
    }
  }

  const rawText = typeof rawMessage === 'string' ? rawMessage : chunks.join('');

  return {
    text: chunks.join('').trim(),
    rawText,
    mentionedSelf,
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
  };
}
