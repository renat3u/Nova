import type { NovaActionType, SendResult } from './types';

export type ActionLogStatus = 'success' | 'failed' | 'silence';

export interface ActionLogEntry {
  id: string;
  tick: number | null;
  actionType: NovaActionType;
  targetId: string;
  text?: string;
  status: ActionLogStatus;
  error?: string;
  reason?: string;
  level?: string;
  createdMs: number;
}

const DEFAULT_MAX_ENTRIES = 200;

export class InMemoryActionLog {
  private readonly entries: ActionLogEntry[] = [];
  private nextId = 1;

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  recordSend(result: SendResult, tick: number | null = null): ActionLogEntry {
    return this.push({
      tick,
      actionType: result.actionType,
      targetId: result.targetId,
      text: result.text,
      status: result.ok ? 'success' : 'failed',
      error: result.error,
      createdMs: result.createdMs,
    });
  }

  recordSilence(input: {
    targetId: string;
    reason: string;
    level: string;
    tick?: number | null;
    createdMs?: number;
  }): ActionLogEntry {
    return this.push({
      tick: input.tick ?? null,
      actionType: 'silence',
      targetId: input.targetId,
      status: 'silence',
      reason: input.reason,
      level: input.level,
      createdMs: input.createdMs ?? Date.now(),
    });
  }

  list(limit = 50): ActionLogEntry[] {
    const safeLimit = Math.max(0, Math.trunc(limit));
    return this.entries.slice(-safeLimit).reverse();
  }

  countSentSuccess(): number {
    return this.entries.filter((entry) => entry.actionType === 'send_text' && entry.status === 'success').length;
  }

  countSilence(): number {
    return this.entries.filter((entry) => entry.status === 'silence').length;
  }

  clear(): void {
    this.entries.length = 0;
    this.nextId = 1;
  }

  private push(entry: Omit<ActionLogEntry, 'id'>): ActionLogEntry {
    const saved: ActionLogEntry = {
      ...entry,
      id: String(this.nextId++),
    };

    this.entries.push(saved);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    return saved;
  }
}
