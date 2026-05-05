//
// NovaEventBuffer — 事件缓冲区，完全模仿 Alice runtime/src/telegram/events.ts
//
// 功能：
//   - directed 消息进入 protectedBuffer（有容量上限保护）
//   - 普通消息进入 regularBuffer
//   - 超出容量时淘汰最旧条目
//   - drain() 合并两个缓冲区后清空
//   - watch() 一次性事件监听器（供 engagement session 使用）
//   - onDirected / onAnyEvent 回调供 EVOLVE loop 唤醒

import type { NovaPerturbation } from '../perception/perturbation';

export interface EventBufferDrainResult {
  events: NovaPerturbation[];
  droppedCount: number;
  droppedDirectedCount: number;
}

export type EventWatchFilter = (e: NovaPerturbation) => boolean;

interface EventWatcher {
  filter: EventWatchFilter;
  resolve: (e: NovaPerturbation) => void;
}

export class NovaEventBuffer {
  static readonly MAX_PROTECTED = 100;
  static readonly DEFAULT_MAX_SIZE = 1000;

  private readonly maxProtectedSize: number;
  private readonly maxRegularSize: number;
  private readonly protectedBuffer: NovaPerturbation[] = [];
  private readonly regularBuffer: NovaPerturbation[] = [];
  private _droppedCount = 0;
  private _droppedDirectedCount = 0;
  private totalDroppedSinceBoot = 0;
  private totalDroppedDirectedSinceBoot = 0;
  private _onDirected: ((event: NovaPerturbation) => void) | null = null;
  private _onAnyEvent: (() => void) | null = null;
  private _watchers: EventWatcher[] = [];

  constructor(maxSize?: number, maxProtected?: number) {
    this.maxProtectedSize = maxProtected ?? NovaEventBuffer.MAX_PROTECTED;
    const totalMax = maxSize ?? NovaEventBuffer.DEFAULT_MAX_SIZE;
    this.maxRegularSize = Math.max(1, totalMax - this.maxProtectedSize);
  }

  // ── 回调 setters ──────────────────────────────────────────────────────────

  set onDirected(cb: ((event: NovaPerturbation) => void) | null) {
    this._onDirected = cb;
  }

  set onAnyEvent(cb: (() => void) | null) {
    this._onAnyEvent = cb;
  }

  // ── 容量信息 ──────────────────────────────────────────────────────────────

  get length(): number {
    return this.protectedBuffer.length + this.regularBuffer.length;
  }

  get protectedLength(): number {
    return this.protectedBuffer.length;
  }

  get regularLength(): number {
    return this.regularBuffer.length;
  }

  get droppedCount(): number {
    return this._droppedCount;
  }

  get droppedDirectedCount(): number {
    return this._droppedDirectedCount;
  }

  get totalDropped(): number {
    return this.totalDroppedSinceBoot;
  }

  get totalDroppedDirected(): number {
    return this.totalDroppedDirectedSinceBoot;
  }

  // ── 核心操作 ──────────────────────────────────────────────────────────────

  /**
   * 将扰动事件推入缓冲区。
   * directed 消息推入 protectedBuffer，否则推入 regularBuffer。
   * 超出容量时 shift 最旧条目，记录丢弃计数。
   */
  push(event: NovaPerturbation): void {
    const tick = Date.now(); // 用当前时间作为排序 tick
    event.tick = tick;

    if (event.isDirected) {
      this.protectedBuffer.push(event);
      if (this.protectedBuffer.length > this.maxProtectedSize) {
        this.protectedBuffer.shift();
        this._droppedDirectedCount += 1;
        this.totalDroppedDirectedSinceBoot += 1;
      }
      // 触发 directed 回调
      this._onDirected?.(event);
    } else {
      this.regularBuffer.push(event);
      if (this.regularBuffer.length > this.maxRegularSize) {
        this.regularBuffer.shift();
        this._droppedCount += 1;
        this.totalDroppedSinceBoot += 1;
      }
    }

    // 触发任意事件回调
    this._onAnyEvent?.();

    // 检查 watchers
    this.notifyWatchers(event);
  }

  /**
   * 合并两个缓冲区，按 tick 排序，返回 { events, droppedCount, droppedDirectedCount }。
   * 清空内部缓冲区并重置丢弃计数器。
   */
  drain(): EventBufferDrainResult {
    const allEvents = [...this.protectedBuffer, ...this.regularBuffer];
    allEvents.sort((a, b) => a.tick - b.tick);

    const droppedCount = this._droppedCount;
    const droppedDirectedCount = this._droppedDirectedCount;

    this.protectedBuffer.length = 0;
    this.regularBuffer.length = 0;
    this._droppedCount = 0;
    this._droppedDirectedCount = 0;

    return { events: allEvents, droppedCount, droppedDirectedCount };
  }

  /**
   * 注册一次性事件监听器。
   * 当缓冲区收到匹配 filter 的事件时，resolve 该事件并移除监听器。
   * 用于 engagement session 的 watcher 机制。
   */
  watch(filter: EventWatchFilter): Promise<NovaPerturbation> {
    return new Promise<NovaPerturbation>((resolve) => {
      this._watchers.push({ filter, resolve });
    });
  }

  /** 清空所有 watchers。 */
  clearWatchers(reason?: string): void {
    // watchers 不会 reject — 它们由 ACT loop 的超时机制清理
    if (reason) {
      for (const w of this._watchers) {
        // 用空事件 resolve，让调用方判断
        const emptyEvent: NovaPerturbation = {
          type: 'other',
          channelId: '',
          isDirected: false,
          isContinuation: false,
          tick: 0,
          timestamp: Date.now(),
          event: {} as never,
        };
        w.resolve(emptyEvent);
      }
    }
    this._watchers = [];
  }

  /** 清空缓冲区（保留丢弃计数）。 */
  clear(): void {
    this.protectedBuffer.length = 0;
    this.regularBuffer.length = 0;
    this._droppedCount = 0;
    this._droppedDirectedCount = 0;
  }

  /** 获取当前缓冲区快照（不消费）。 */
  snapshot(): NovaPerturbation[] {
    return [...this.protectedBuffer, ...this.regularBuffer].sort((a, b) => a.tick - b.tick);
  }

  // ── 内部方法 ──────────────────────────────────────────────────────────────

  private notifyWatchers(event: NovaPerturbation): void {
    const remaining: EventWatcher[] = [];
    for (const watcher of this._watchers) {
      try {
        if (watcher.filter(event)) {
          watcher.resolve(event);
        } else {
          remaining.push(watcher);
        }
      } catch {
        // filter 抛出异常时保留 watcher
        remaining.push(watcher);
      }
    }
    this._watchers = remaining;
  }
}
