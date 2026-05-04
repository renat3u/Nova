import { FACE_MAP } from './face-map';

export interface TextExtractionResult {
  text: string;
  rawText: string;
  mentionedSelf: boolean;
  replyToMessageId?: string;
  /** QQ numbers of third-party contacts @-mentioned in the message (excludes self). */
  mentionedContactQQs?: string[];
}

export interface StickerExtractionResult {
  emojiPackageId: number;
  emojiId: string;
  key: string;
  summary?: string;
  url?: string;
  type: 'mface' | 'image_sticker';
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
  const mentionedContactQQs: string[] = [];

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
        if (qq) {
          if (selfId && qq === selfId) {
            mentionedSelf = true;
          } else if (selfId && qq !== selfId) {
            mentionedContactQQs.push(qq);
          }
        }
        break;
      }
      case 'reply': {
        const id = asString(segment.data.id) ?? asString(segment.data.seq);
        if (id && replyToMessageId === undefined) replyToMessageId = id;
        break;
      }
      case 'mface': {
        const summary = asString(segment.data.summary);
        if (summary && summary.length > 0) {
          chunks.push(`[贴纸:${summary}]`);
        } else {
          chunks.push('[动画表情]');
        }
        break;
      }
      case 'image': {
        const subType = asString(segment.data.sub_type);
        const summary = asString(segment.data.summary);
        if (subType === '1') {
          // 贴纸类型的 image
          if (summary && summary.length > 0 && summary !== '[表情]') {
            chunks.push(`[贴纸:${summary}]`);
          } else {
            chunks.push('[动画表情]');
          }
        } else {
          // 普通图片
          if (summary && summary.length > 0) {
            chunks.push(`[图片:${summary}]`);
          } else {
            chunks.push('[图片]');
          }
        }
        break;
      }
      case 'face': {
        const faceId = asString(segment.data.id);
        if (faceId && FACE_MAP[faceId]) {
          chunks.push(`[表情:${FACE_MAP[faceId]}]`);
        } else {
          chunks.push('[表情]');
        }
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
    ...(mentionedContactQQs.length > 0 ? { mentionedContactQQs } : {}),
  };
}

/**
 * 从消息段中提取所有 mface 和 image(sub_type=1) 的贴纸元数据。
 * 用于后续存储到 sticker 数据库和传递到决策上下文。
 */
export function extractStickers(message: unknown): StickerExtractionResult[] {
  if (!Array.isArray(message)) return [];

  const results: StickerExtractionResult[] = [];

  for (const segment of message as MessageSegment[]) {
    if (!isRecord(segment) || typeof segment.type !== 'string' || !isRecord(segment.data)) continue;

    if (segment.type === 'mface') {
      const emojiPackageId = asString(segment.data.emoji_package_id);
      const emojiId = asString(segment.data.emoji_id);
      const key = asString(segment.data.key);
      if (emojiPackageId && emojiId && key) {
        results.push({
          emojiPackageId: Number(emojiPackageId),
          emojiId,
          key,
          summary: asString(segment.data.summary),
          type: 'mface',
        });
      }
    } else if (segment.type === 'image') {
      const subType = asString(segment.data.sub_type);
      if (subType === '1') {
        const url = asString(segment.data.url);
        const summary = asString(segment.data.summary);
        const fileId = asString(segment.data.file_id);
        // image_sticker 没有完整的 mface 三要素，但记录 summary 和 url
        if (url || summary) {
          results.push({
            emojiPackageId: 0,
            emojiId: fileId ?? '',
            key: '',
            summary,
            url,
            type: 'image_sticker',
          });
        }
      }
    }
  }

  return results;
}
