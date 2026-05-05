
// runtime/src/engine/act

// ── Engagement 类型别名 ─────────────────────────────────────────────────────

export type EngagementState = 'ready' | 'waiting' | 'watching' | 'done';
export type WatcherKind = 'watching' | 'waiting_reply';
export type EngagementOutcome = 'replied' | 'timeout' | 'done' | 'failed' | 'aborted';

export const MAX_CONCURRENT_ENGAGEMENTS = 3;

/**
 * Minimum time between switching engagement focus, in milliseconds.
 * Prevents rapid context-switching when multiple engagements are active.
 */
export const SWITCH_COST_MS = 1500;

/**
 * Default timeout for waiting_reply engagements before they are marked done.
 * 24 hours without a reply → engagement expires.
 */
export const DEFAULT_ENGAGEMENT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// ── Engagement record ──────────────────────────────────────────────────────

export interface EngagementRecord {
  /** Composite id: engagement:{channelId}:{contactId}:{kind} */
  id: string;
  channelId: string;
  contactId: string | null;
  /** Kind of engagement: 'proactive_action', 'nova_action', 'incoming_message', etc. */
  kind: string;
  /** Number of events in this engagement. */
  count: number;
  /** Current lifecycle state. */
  state: EngagementState;
  /** What the engagement is waiting/watching for. */
  watcherKind: WatcherKind;
  /** The queued action id that created this engagement, if proactive. */
  proactiveActionId?: string;
  /** Result of the engagement. */
  outcome?: EngagementOutcome;
  /** Timestamp when the engagement was created. */
  startedMs: number;
  /** Timestamp of the last event in this engagement. */
  lastEventMs: number;
  /** When this engagement expires if no reply (for waiting_reply). */
  timeoutMs?: number;
  /** The message id of the reply that resolved this engagement. */
  replyMessageId?: string;
  /** Error message if outcome is 'failed'. */
  error?: string;
}

// ── Engagement creation params ─────────────────────────────────────────────

export interface CreateEngagementParams {
  channelId: string;
  contactId: string | null;
  kind: string;
  proactiveActionId?: string;
  nowMs: number;
  timeoutMs?: number;
}

// ── Engagement update params ───────────────────────────────────────────────

export interface UpdateEngagementParams {
  state?: EngagementState;
  watcherKind?: WatcherKind;
  outcome?: EngagementOutcome;
  replyMessageId?: string;
  error?: string;
  nowMs: number;
}

// ── Engagement state machine ───────────────────────────────────────────────

/**
 * Pure-function engagement state machine.
 *
 * Validates transitions and produces updated engagement records.
 * Does NOT perform DB writes — the caller is responsible for persistence.
 */
export const EngagementSM = {
  /**
   * Create a new engagement record in 'ready' state, transitioning
   * immediately to 'waiting' with watcherKind 'waiting_reply' for
   * proactive actions.
   */
  create(params: CreateEngagementParams): EngagementRecord {
    const isProactive = params.kind === 'proactive_action';
    return {
      id: `engagement:${params.channelId}:${params.contactId ?? 'none'}:${params.kind}`,
      channelId: params.channelId,
      contactId: params.contactId,
      kind: params.kind,
      count: 1,
      state: isProactive ? 'waiting' : 'ready',
      watcherKind: isProactive ? 'waiting_reply' : 'watching',
      proactiveActionId: params.proactiveActionId,
      startedMs: params.nowMs,
      lastEventMs: params.nowMs,
      timeoutMs: isProactive ? params.nowMs + (params.timeoutMs ?? DEFAULT_ENGAGEMENT_TIMEOUT_MS) : undefined,
    };
  },

  /**
   * Transition a waiting_reply engagement to 'replied' when the target user
   * sends a message after Nova's proactive action.
   */
  resolveReplied(record: EngagementRecord, replyMessageId: string, nowMs: number): EngagementRecord {
    return {
      ...record,
      state: 'done',
      outcome: 'replied',
      replyMessageId,
      lastEventMs: nowMs,
    };
  },

  /**
   * Transition a waiting engagement to 'timeout' when no reply is received
   * within the timeout window.
   */
  resolveTimeout(record: EngagementRecord, nowMs: number): EngagementRecord {
    return {
      ...record,
      state: 'done',
      outcome: 'timeout',
      lastEventMs: nowMs,
    };
  },

  /**
   * Mark an engagement as done (natural completion, not timeout/reply).
   */
  resolveDone(record: EngagementRecord, nowMs: number): EngagementRecord {
    return {
      ...record,
      state: 'done',
      outcome: 'done',
      lastEventMs: nowMs,
    };
  },

  /**
   * Mark an engagement as failed (send error, gate denial after enqueue, etc.).
   */
  resolveFailed(record: EngagementRecord, error: string, nowMs: number): EngagementRecord {
    return {
      ...record,
      state: 'done',
      outcome: 'failed',
      error,
      lastEventMs: nowMs,
    };
  },

  /**
   * Abort an engagement that should never have been started (e.g. proactive
   * was disabled between enqueue and dequeue).
   */
  abort(record: EngagementRecord, reason: string, nowMs: number): EngagementRecord {
    return {
      ...record,
      state: 'done',
      outcome: 'aborted',
      error: reason,
      lastEventMs: nowMs,
    };
  },

  /**
   * Check whether an engagement is still active (not in terminal state).
   */
  isActive(record: EngagementRecord): boolean {
    return record.state !== 'done';
  },

  /**
   * Check whether an engagement is in waiting_reply state and still
   * within its timeout window at the given time.
   */
  isWaitingReply(record: EngagementRecord, nowMs: number): boolean {
    return record.state === 'waiting'
      && record.watcherKind === 'waiting_reply'
      && (record.timeoutMs === undefined || nowMs < record.timeoutMs);
  },

  /**
   * Check whether a waiting engagement has timed out.
   */
  hasTimedOut(record: EngagementRecord, nowMs: number): boolean {
    return record.state === 'waiting'
      && record.watcherKind === 'waiting_reply'
      && record.timeoutMs !== undefined
      && nowMs >= record.timeoutMs;
  },

  /**
   * Validate a state transition.
   * Returns an error string if the transition is invalid, null otherwise.
   */
  validateTransition(
    current: EngagementState,
    next: EngagementState,
    _outcome?: EngagementOutcome,
  ): string | null {
    // Terminal state — no further transitions.
    if (current === 'done') {
      return 'engagement is already in terminal state (done)';
    }

    // Valid transitions:
    //   ready → waiting | watching | done
    //   waiting → watching | done
    //   watching → waiting | done
    const validNext: Record<EngagementState, EngagementState[]> = {
      ready: ['waiting', 'watching', 'done'],
      waiting: ['watching', 'done'],
      watching: ['waiting', 'done'],
      done: [],
    };

    if (!validNext[current].includes(next)) {
      return `invalid engagement transition: ${current} → ${next}`;
    }

    return null;
  },
};

// ── Staleness check ─────────────────────────────────────────────────────────

/**
 * L2 距离比较入队时的压力快照与当前压力快照。
 * 用于判断入队时的场景是否已经过时。
 */
export function stalenessCheck(
  enqueueSnapshot: { p1: number; p2: number; p3: number; p4: number; p5: number; p6: number; p7?: number; p8?: number; pProspect: number; api: number },
  currentSnapshot: { p1: number; p2: number; p3: number; p4: number; p5: number; p6: number; p7?: number; p8?: number; pProspect: number; api: number },
  threshold: number,
): { stale: boolean; distance: number } {
  const dims = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'pProspect', 'api'] as const;

  let sumSquares = 0;
  for (const dim of dims) {
    const old = (enqueueSnapshot[dim] as number) ?? 0;
    const now = (currentSnapshot[dim] as number) ?? 0;
    const diff = old - now;
    sumSquares += diff * diff;
  }

  const distance = Math.sqrt(sumSquares);
  return { stale: distance > threshold, distance };
}

// ── Engagement finalization ──────────────────────────────────────────────────

/**
 * 将一个 engagement 合并到最终状态，返回合并后的记录。
 * 用于 finalizeSlot 操作。
 */
export function finalizeEngagement(
  record: EngagementRecord,
  outcome: EngagementOutcome,
  nowMs: number,
  error?: string,
): EngagementRecord {
  switch (outcome) {
    case 'replied':
      return EngagementSM.resolveReplied(record, record.replyMessageId ?? '', nowMs);
    case 'timeout':
      return EngagementSM.resolveTimeout(record, nowMs);
    case 'done':
      return EngagementSM.resolveDone(record, nowMs);
    case 'failed':
      return EngagementSM.resolveFailed(record, error ?? 'unknown', nowMs);
    case 'aborted':
      return EngagementSM.abort(record, error ?? 'aborted', nowMs);
    default:
      return EngagementSM.resolveDone(record, nowMs);
  }
}

// ── Engagement query helpers ───────────────────────────────────────────────

/**
 * Count how many engagements are currently active (not in 'done' state)
 * among a list of records.
 */
export function countActiveEngagements(records: EngagementRecord[]): number {
  return records.filter((r) => EngagementSM.isActive(r)).length;
}

/**
 * Count how many engagements are in waiting_reply state.
 */
export function countWaitingReplies(records: EngagementRecord[], nowMs: number): number {
  return records.filter((r) => EngagementSM.isWaitingReply(r, nowMs)).length;
}

/**
 * Check whether a new proactive engagement can be created without exceeding
 * MAX_CONCURRENT_ENGAGEMENTS.
 */
export function canCreateEngagement(activeRecords: EngagementRecord[]): boolean {
  return countActiveEngagements(activeRecords) < MAX_CONCURRENT_ENGAGEMENTS;
}

/**
 * Check whether a target already has a waiting engagement.
 * Prevents duplicate proactive outreach to the same target.
 */
export function hasWaitingEngagement(
  records: EngagementRecord[],
  channelId: string,
  nowMs: number,
): boolean {
  return records.some(
    (r) => r.channelId === channelId && EngagementSM.isWaitingReply(r, nowMs),
  );
}
