
//
// Step 15: 主动探索内容 — per-target novelty / explore history tracking.
//
// Tracks per-target explore actions and outcomes to prevent Nova from
// repeatedly exploring the same information gap.  This is NOT the global
// noveltyHistory in p6-curiosity.ts (which drives P6 aggregate pressure);
// this tracker gates individual explore candidates at the target level.
//
// When Nova sends an explore action to a target, we record the send time.
// After the engagement resolves (reply or timeout), we record the outcome.
// A target in cooldown cannot be explored again until the cooldown expires.

// ── Per-target record ──────────────────────────────────────────────────────

interface ExploreTargetRecord {
  targetId: string;
  lastExploreSentMs: number;
  exploreCount: number;
  lastExploreReplied: boolean;
  lastExploreResolvedMs: number;
}

export const EXPLORE_TARGET_COOLDOWN_MS = 4 * 3600 * 1000;

/**
 * Extended cooldown after an explore was not replied to.
 * 24 hours — gives the user space when they show disinterest.
 */
export const EXPLORE_UNREPLIED_COOLDOWN_MS = 24 * 3600 * 1000;

/**
 * Maximum number of explore actions per target per day.
 * Prevents Nova from becoming intrusive even within cooldown windows.
 */
export const MAX_EXPLORE_PER_TARGET_PER_DAY = 3;

/** Rolling window for per-day counting. */
const DAY_MS = 24 * 3600 * 1000;

// ── In-memory store ───────────────────────────────────────────────────────

const exploreRecords = new Map<string, ExploreTargetRecord>();

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Record that Nova sent an explore action to a target.
 * Call this when an explore candidate is enqueued.
 */
export function recordExploreSent(targetId: string, nowMs: number): void {
  const existing = exploreRecords.get(targetId);
  if (existing) {
    existing.lastExploreSentMs = nowMs;
    existing.exploreCount += 1;
  } else {
    exploreRecords.set(targetId, {
      targetId,
      lastExploreSentMs: nowMs,
      exploreCount: 1,
      lastExploreReplied: false,
      lastExploreResolvedMs: 0,
    });
  }
}

/**
 * Record the result of an explore action after engagement resolution.
 * Call this when the waiting_reply engagement is resolved (reply or timeout).
 */
export function recordExploreResult(
  targetId: string,
  replied: boolean,
  nowMs: number,
): void {
  const record = exploreRecords.get(targetId);
  if (!record) return;

  record.lastExploreReplied = replied;
  record.lastExploreResolvedMs = nowMs;

  // If the user replied, this target's information gap has been partially
  // filled.  We don't fully reset exploreCount (so cumulative patterns
  // are still visible), but the replied flag will relax future cooldowns.
}

/**
 * Check whether Nova can send a new explore action to the given target.
 *
 * Returns { allowed: true } if exploration is permitted, or
 * { allowed: false, reason } if blocked by cooldown or rate limits.
 */
export function canExploreTarget(
  targetId: string,
  nowMs: number,
): { allowed: boolean; reason?: string } {
  const record = exploreRecords.get(targetId);
  if (!record) return { allowed: true };

  // Check per-day cap.
  const recentExplores = countRecentExplores(record, nowMs);
  if (recentExplores >= MAX_EXPLORE_PER_TARGET_PER_DAY) {
    return {
      allowed: false,
      reason: 'explore_daily_cap_reached',
    };
  }

  // If the last explore has not been resolved yet (engagement still waiting),
  // don't send another one.
  if (record.lastExploreSentMs > (record.lastExploreResolvedMs || 0)) {
    return {
      allowed: false,
      reason: 'explore_engagement_pending',
    };
  }

  // Determine cooldown based on whether the last explore was replied to.
  const cooldownMs = record.lastExploreReplied
    ? EXPLORE_TARGET_COOLDOWN_MS
    : EXPLORE_UNREPLIED_COOLDOWN_MS;

  const elapsed = nowMs - record.lastExploreResolvedMs;
  if (record.lastExploreResolvedMs > 0 && elapsed < cooldownMs) {
    return {
      allowed: false,
      reason: record.lastExploreReplied
        ? 'explore_cooldown'
        : 'explore_unreplied_cooldown',
    };
  }

  return { allowed: true };
}

/**
 * Get the list of target IDs that are currently eligible for exploration.
 * Filters a candidate list through the cooldown and rate checks.
 */
export function getExplorableTargets(
  candidateIds: string[],
  nowMs: number,
): string[] {
  return candidateIds.filter((id) => canExploreTarget(id, nowMs).allowed);
}

/**
 * Get the explore record for a target (for trace/log inspection).
 */
export function getExploreRecord(targetId: string): ExploreTargetRecord | undefined {
  return exploreRecords.get(targetId);
}

/**
 * Reset all explore records.  Used for testing.
 */
export function resetExploreRecords(): void {
  exploreRecords.clear();
}

// ── Internal helpers ───────────────────────────────────────────────────────

function countRecentExplores(record: ExploreTargetRecord, nowMs: number): number {
  // Count explores in the last 24 hours.
  // Since we only track the last explore, we use exploreCount as a proxy.
  // Full per-explore history would require a list, but for now the daily cap
  // is a soft limit based on total count — the cooldown already prevents
  // rapid repetition.
  //
  // A more precise implementation would store timestamps of each explore,
  // but the current approach is sufficient for Phase 2 Step 15.
  if (nowMs - record.lastExploreSentMs > DAY_MS) {
    // Last explore was more than a day ago; reset count.
    return 0;
  }
  return Math.min(record.exploreCount, MAX_EXPLORE_PER_TARGET_PER_DAY);
}
