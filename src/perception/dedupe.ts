import type { NovaMessageEvent } from '../core/types';

export interface DedupeOptions {
  ttlMs?: number;
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2048;

export class MessageDedupe {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly seenAtByKey = new Map<string, number>();

  constructor(options: DedupeOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  isDuplicate(event: NovaMessageEvent, now = Date.now()): boolean {
    this.prune(now);

    const keys = [primaryDedupeKey(event), fallbackDedupeKey(event)];
    if (keys.some((key) => this.seenAtByKey.has(key))) return true;

    for (const key of keys) {
      this.seenAtByKey.set(key, now);
    }

    this.enforceMaxEntries();
    return false;
  }

  clear(): void {
    this.seenAtByKey.clear();
  }

  private prune(now: number): void {
    for (const [key, seenAt] of this.seenAtByKey) {
      if (now - seenAt > this.ttlMs) this.seenAtByKey.delete(key);
    }
  }

  private enforceMaxEntries(): void {
    while (this.seenAtByKey.size > this.maxEntries) {
      const oldestKey = this.seenAtByKey.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.seenAtByKey.delete(oldestKey);
    }
  }
}

function primaryDedupeKey(event: NovaMessageEvent): string {
  return `${event.platform}:${event.messageId}`;
}

function fallbackDedupeKey(event: NovaMessageEvent): string {
  return `${event.chatId}:${event.senderId}:${event.timestamp}:${hashString(event.text)}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
