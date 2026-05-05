//
// ActionQueue — 优先级队列，对齐 Alice runtime/src/engine/act 的队列机制
//
// 核心能力：
//   1. 压力评分驱逐 — 满时淘汰最低 pressureScore 的条目
//   2. 阻塞 dequeue — async dequeue() 使用 Promise waiter 模式
//   3. 非阻塞 tryDequeue — 立即返回或 null
//   4. processing Set — target 独占锁，防止同一 target 并发处理
//   5. isTargetActive(target) — 检查 target 是否在队列或处理中
//   6. markComplete(target) — 释放 processing 锁
//   7. close() — 关闭队列，唤醒所有 waiter
//   8. metrics — 队列饱和度、溢出计数等

import type { ActionCandidate } from '../engine/tick-plan';
import type { PressureSnapshot } from '../pressure/aggregate';

// ── 扩展的 QueuedAction ─────────────────────────────────────────────────────

export interface QueuedAction {
  /** Unique queue entry id. */
  id: string;
  /** The tick that produced this candidate. */
  tick: number;
  /** The action candidate from evolve. */
  candidate: ActionCandidate;
  /** Human-readable summary of what prompted this action. */
  promptContextSummary: string;
  /** Queue status. */
  status: 'queued' | 'executing' | 'done' | 'failed';
  /** When this was enqueued. */
  enqueuedMs: number;
  /** When execution started. */
  startedMs?: number;
  /** When execution completed. */
  completedMs?: number;
  /** Error message if status is 'failed'. */
  error?: string;
  /** Decision agent metadata. */
  decision?: {
    action: string;
    reason: string;
    confidence: number;
    responderIntent?: string;
    candidateId?: string;
  };

  // ── 新增字段（对齐 Alice）────────────────────────────────────────────────

  /** Enqueue 时的 tick 编号。 */
  enqueueTick: number;
  /** 入队时的压力快照（用于 staleness check）。 */
  pressureSnapshot: PressureSnapshot;
  /** 压力贡献来源映射。 */
  contributions: Record<string, number[]>;
  /** 焦点实体 ID 列表。 */
  focalEntities?: string[];
  /** 入队原因（可读）。 */
  reason?: string;
  /** 压力评分（用于驱逐排序，越大越不容易被淘汰）。 */
  pressureScore: number;
  /** 动作类型：'reply' 回复消息 ｜ 'proactive' 主动发起。ACT loop 据此选择执行路径。 */
  kind?: 'reply' | 'proactive';
  /** 原始消息事件（仅 reply 类型需要，供 LLM 生成回复时使用）。 */
  originalEvent?: import('../core/types').NovaMessageEvent;
  /** Internal: EVOLVE 等待 ACT 完成此 action 的 resolve 回调。 */
  _completionResolve?: (() => void) | null;
}

// ── 队列配置 ────────────────────────────────────────────────────────────────

export interface ActionQueueConfig {
  /** 最大容量，默认 50。 */
  maxSize: number;
}

// ── 队列指标 ────────────────────────────────────────────────────────────────

export interface ActionQueueMetrics {
  currentSize: number;
  pendingCount: number;
  processingCount: number;
  maxSize: number;
  totalEnqueued: number;
  totalDequeued: number;
  totalDropped: number;
  totalEvicted: number;
  waiterCount: number;
}

// ── Dequeue waiter ──────────────────────────────────────────────────────────

interface DequeueWaiter {
  resolve: (item: QueuedAction | null) => void;
  reject: (error: Error) => void;
}

// ── ActionQueue ─────────────────────────────────────────────────────────────

export class ActionQueue {
  private readonly items: QueuedAction[] = [];
  private nextId = 1;
  private readonly maxSize: number;

  // 阻塞 dequeue 的 waiter 列表
  private _waiters: DequeueWaiter[] = [];

  // 正在处理的 target 集合（独占锁）
  private readonly _processing: Set<string> = new Set();

  // 队列是否已关闭
  private _closed = false;

  // 指标
  private _totalEnqueued = 0;
  private _totalDequeued = 0;
  private _totalDropped = 0;
  private _totalEvicted = 0;

  constructor(maxSize = 50) {
    this.maxSize = Math.max(1, Math.trunc(maxSize));
  }

  // ── 状态查询 ──────────────────────────────────────────────────────────────

  get closed(): boolean {
    return this._closed;
  }

  get size(): number {
    return this.items.length;
  }

  get pendingCount(): number {
    return this.items.filter((item) => item.status === 'queued').length;
  }

  get processingCount(): number {
    return this._processing.size;
  }

  get metrics(): ActionQueueMetrics {
    return {
      currentSize: this.items.length,
      pendingCount: this.pendingCount,
      processingCount: this._processing.size,
      maxSize: this.maxSize,
      totalEnqueued: this._totalEnqueued,
      totalDequeued: this._totalDequeued,
      totalDropped: this._totalDropped,
      totalEvicted: this._totalEvicted,
      waiterCount: this._waiters.length,
    };
  }

  // ── Enqueue（带压力驱逐）──────────────────────────────────────────────────

  /**
   * 将候选加入队列。满时驱逐最低 pressureScore 的 'queued' 条目。
   * 返回入队的条目，如果候选本身被驱逐则返回 null。
   */
  enqueue(
    candidate: ActionCandidate,
    tick: number,
    nowMs: number = Date.now(),
    promptContextSummary = '',
    options?: {
      pressureSnapshot?: PressureSnapshot;
      contributions?: Record<string, number[]>;
      focalEntities?: string[];
      reason?: string;
      kind?: 'reply' | 'proactive';
      originalEvent?: import('../core/types').NovaMessageEvent;
      decision?: QueuedAction['decision'];
    },
  ): QueuedAction | null {
    if (this._closed) return null;

    const pressureSnapshot = options?.pressureSnapshot ?? defaultPressureSnapshot(tick, nowMs);
    const pressureScore = computePressureScore(pressureSnapshot);

    const item: QueuedAction = {
      id: `q:${this.nextId++}`,
      tick,
      candidate,
      promptContextSummary,
      status: 'queued',
      enqueuedMs: nowMs,
      enqueueTick: tick,
      pressureSnapshot,
      contributions: options?.contributions ?? {},
      focalEntities: options?.focalEntities,
      reason: options?.reason,
      pressureScore,
      kind: options?.kind,
      originalEvent: options?.originalEvent,
      decision: options?.decision,
    };

    // 如果没满，直接入队
    if (this.items.length < this.maxSize) {
      this.items.push(item);
      this._totalEnqueued += 1;
      this.notifyWaiters();
      return item;
    }

    // 满了 — 压力驱逐：找最低 pressureScore 的 queued 条目
    let minIdx = -1;
    let minScore = pressureScore;
    for (let i = 0; i < this.items.length; i++) {
      const existing = this.items[i];
      if (existing && existing.status === 'queued' && existing.pressureScore < minScore) {
        minScore = existing.pressureScore;
        minIdx = i;
      }
    }

    // 如果新条目本身就是最低分，拒绝入队
    if (minIdx === -1) {
      this._totalDropped += 1;
      return null;
    }

    // 驱逐旧条目
    this.items.splice(minIdx, 1);
    this._totalEvicted += 1;
    this.items.push(item);
    this._totalEnqueued += 1;
    this.notifyWaiters();
    return item;
  }

  // ── Dequeue（阻塞）────────────────────────────────────────────────────────

  /**
   * 阻塞式出队。如果队列中没有 queued 条目，等待直到有可用条目或队列关闭。
   * 队列关闭时返回 null。
   */
  async dequeue(): Promise<QueuedAction | null> {
    if (this._closed) return null;

    const item = this.tryDequeue();
    if (item) return item;

    // 等待
    return new Promise<QueuedAction | null>((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }

  /**
   * 非阻塞式出队。立即返回第一个 queued 条目，或 null。
   */
  tryDequeue(): QueuedAction | null {
    if (this._closed) return null;

    const index = this.items.findIndex((item) => item.status === 'queued');
    if (index === -1) return null;

    const [item] = this.items.splice(index, 1);
    if (!item) return null;

    this._totalDequeued += 1;
    return item;
  }

  /**
   * 将已出队但暂时无法执行的条目放回队尾。
   * 用于 target lock 短暂占用时避免丢失 action。
   */
  requeue(item: QueuedAction): void {
    if (this._closed || item.status !== 'queued') return;
    this.items.push(item);
  }

  // ── Processing 锁 ─────────────────────────────────────────────────────────

  /**
   * 标记 target 进入处理状态（独占锁）。
   * 返回 true 表示成功获取锁，false 表示已经有其他条目在处理此 target。
   */
  acquireTarget(targetId: string): boolean {
    if (this._processing.has(targetId)) return false;
    this._processing.add(targetId);
    return true;
  }

  /**
   * 检查 target 是否正在队列中等待或在处理中。
   */
  isTargetActive(targetId: string): boolean {
    if (this._processing.has(targetId)) return true;
    return this.items.some(
      (item) => item.candidate.targetId === targetId && item.status === 'queued',
    );
  }

  /**
   * 释放 target 的处理锁。
   */
  markComplete(targetId: string): void {
    this._processing.delete(targetId);
  }

  // ── 状态标记 ──────────────────────────────────────────────────────────────

  /** Look at the next queued action without removing it. */
  peek(): QueuedAction | null {
    return this.items.find((item) => item.status === 'queued') ?? null;
  }

  /** Mark an action as executing. */
  markExecuting(id: string, nowMs: number = Date.now()): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== 'queued') return false;
    item.status = 'executing';
    item.startedMs = nowMs;
    return true;
  }

  /** Mark an action as done. */
  markDone(id: string, nowMs: number = Date.now()): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== 'executing') return false;
    item.status = 'done';
    item.completedMs = nowMs;
    return true;
  }

  /** Mark an action as failed. */
  markFailed(id: string, error: string, nowMs: number = Date.now()): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== 'executing') return false;
    item.status = 'failed';
    item.error = error;
    item.completedMs = nowMs;
    return true;
  }

  // ── 批量操作 ──────────────────────────────────────────────────────────────

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

  /** Clear all queued items. */
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

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /**
   * 关闭队列。唤醒所有等待中的 dequeue waiter（返回 null）。
   */
  close(): void {
    this._closed = true;
    for (const waiter of this._waiters) {
      waiter.resolve(null);
    }
    this._waiters = [];
    this._processing.clear();
  }

  // ── 内部方法 ──────────────────────────────────────────────────────────────

  private notifyWaiters(): void {
    while (this._waiters.length > 0) {
      const item = this.tryDequeue();
      if (item) {
        const waiter = this._waiters.shift()!;
        waiter.resolve(item);
      } else {
        break;
      }
    }
  }
}

// ── 辅助函数 ────────────────────────────────────────────────────────────────

function defaultPressureSnapshot(tick: number, nowMs: number): PressureSnapshot {
  return {
    tick,
    createdMs: nowMs,
    p1: 0,
    p2: 0,
    p3: 0,
    p4: 0,
    p5: 0,
    p6: 0,
    p7: 0,
    p8: 0,
    pProspect: 0,
    api: 0,
    apiPeak: 0,
    contributions: {},
  };
}

/**
 * 计算压力评分（越高越不易被淘汰）。
 * 使用 p1-p6 和 api 的加权和，模拟"综合压力"。
 */
function computePressureScore(snapshot: PressureSnapshot): number {
  const pSum =
    (snapshot.p1 ?? 0) +
    (snapshot.p2 ?? 0) +
    (snapshot.p3 ?? 0) +
    (snapshot.p4 ?? 0) +
    (snapshot.p5 ?? 0) +
    (snapshot.p6 ?? 0) +
    (snapshot.p7 ?? 0) +
    (snapshot.p8 ?? 0);
  // 优先保留高压力条目（高压力 = 更需要行动）
  // 同时考虑 api 水平
  return pSum + (snapshot.api ?? 0) * 2 + (snapshot.pProspect ?? 0);
}
