
//
// Scheduled ticks enqueue action candidates here; the Act loop (Step 11)
// dequeues and executes them.  The queue ensures that proactive actions are
// never sent directly from the scheduled tick — they must pass through the
// queue and the full engagement lifecycle.
//
// Alignment with Step 07 / Step 11:
//   engine/evolve.ts → enqueue candidate
//   act/act-loop.ts  → dequeue & execute (Step 11)

import type { ActionCandidate } from '../engine/tick-plan';

export interface QueuedAction {
  /** Unique queue entry id. */
  id: string;
  /** The tick that produced this candidate. */
  tick: number;
  /** The action candidate from evolve. */
  candidate: ActionCandidate;
  /** Human-readable summary of what prompted this action (for logging / trace). */
  promptContextSummary: string;
  /** Queue status. */
  status: 'queued' | 'executing' | 'done' | 'failed';
  /** When this was enqueued. */
  enqueuedMs: number;
  /** When execution started (set by Act loop). */
  startedMs?: number;
  /** When execution completed (set by Act loop). */
  completedMs?: number;
  /** Error message if status is 'failed'. */
  error?: string;
  /** Decision agent metadata, set when enqueued by agent gateway. */
  decision?: {
    action: string;
    reason: string;
    confidence: number;
    responderIntent?: string;
    candidateId?: string;
  };
}

export class ActionQueue {
  private readonly items: QueuedAction[] = [];
  private nextId = 1;
  private readonly maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = Math.max(1, Math.trunc(maxSize));
  }

  /** Add an action candidate to the queue. */
  enqueue(candidate: ActionCandidate, tick: number, nowMs = Date.now(), promptContextSummary = ''): QueuedAction | null {
    if (this.items.length >= this.maxSize) return null;

    const item: QueuedAction = {
      id: `q:${this.nextId++}`,
      tick,
      candidate,
      promptContextSummary,
      status: 'queued',
      enqueuedMs: nowMs,
    };

    this.items.push(item);
    return item;
  }

  /** Remove and return the next queued (non-executing) action. */
  dequeue(): QueuedAction | null {
    const index = this.items.findIndex((item) => item.status === 'queued');
    if (index === -1) return null;
    const [item] = this.items.splice(index, 1);
    return item ?? null;
  }

  /** Look at the next queued action without removing it. */
  peek(): QueuedAction | null {
    return this.items.find((item) => item.status === 'queued') ?? null;
  }

  /** Mark an action as executing. */
  markExecuting(id: string, nowMs = Date.now()): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== 'queued') return false;
    item.status = 'executing';
    item.startedMs = nowMs;
    return true;
  }

  /** Mark an action as done. */
  markDone(id: string, nowMs = Date.now()): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== 'executing') return false;
    item.status = 'done';
    item.completedMs = nowMs;
    return true;
  }

  /** Mark an action as failed. */
  markFailed(id: string, error: string, nowMs = Date.now()): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== 'executing') return false;
    item.status = 'failed';
    item.error = error;
    item.completedMs = nowMs;
    return true;
  }

  /** Remove all actions targeting a specific entity. */
  removeByTarget(targetId: string): number {
    let removed = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item?.candidate?.targetId === targetId && item.status === 'queued') {
        this.items.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /** List all actions in the queue. */
  list(): ReadonlyArray<QueuedAction> {
    return [...this.items];
  }

  /** List only queued (not executing/done/failed) actions. */
  listPending(): ReadonlyArray<QueuedAction> {
    return this.items.filter((item) => item.status === 'queued');
  }

  /** Number of pending (queued) actions. */
  get pendingCount(): number {
    return this.items.filter((item) => item.status === 'queued').length;
  }

  /** Total number of items in the queue. */
  get size(): number {
    return this.items.length;
  }

  /** Clear all queued items (executing items are preserved). */
  clearQueued(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item?.status === 'queued') this.items.splice(i, 1);
    }
  }

  /** Clear all queued items and return the number removed. */
  clearQueuedCount(): number {
    let removed = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item?.status === 'queued') {
        this.items.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /** Clear the entire queue. */
  clear(): void {
    this.items.length = 0;
  }
}
