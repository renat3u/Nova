
//

// Nova uses an in-memory tracker so we don't need to alter the DB schema.
// Mood decays exponentially toward 0 (neutral) and is nudged by interaction events.
//
// Step 4 (todo2-step04): extended to track arousal alongside valence, with
// getCurrent() / setCurrent() / nudge() operating on full SelfMoodSnapshot
// so that LLM-driven state writeback can persist and restore both dimensions.

  private readonly HALF_LIFE_S = 3600;
  private readonly DECAY_PER_SECOND: number;

  constructor(initial: number = 0.05) {
    this.value = clamp(initial, -1, 1);
    this.arousal = NEUTRAL_AROUSAL;
    this.lastUpdateMs = Date.now();
    this.DECAY_PER_SECOND = Math.LN2 / this.HALF_LIFE_S;
  }

  /** Current mood valence in [-1, 1]. Decay is applied before returning. */
  get current(): number {
    this.applyDecay();
    return this.value;
  }

  /** Record an interaction event — nudges mood up or down. */
  apply(event: MoodEvent, nowMs: number = Date.now()): void {
    this.applyDecay(nowMs);
    this.value = clamp(this.value + this.eventDelta(event), -1, 1);
  }

  /** Current mood valence in [-1, 1] after applying decay at the given time. */
  snapshot(nowMs: number = Date.now()): number {
    this.applyDecay(nowMs);
    return this.value;
  }

  /** Move mood a small step toward a target value and return the new value. */
  nudgeToward(target: number, weight: number = 0.2, nowMs: number = Date.now()): number {
    this.applyDecay(nowMs);
    const safeWeight = clamp(weight, 0, 1);
    const safeTarget = clamp(target, -1, 1);
    this.value = clamp(this.value * (1 - safeWeight) + safeTarget * safeWeight, -1, 1);
    this.lastUpdateMs = nowMs;
    return this.value;
  }

  /** Force-set the mood value (e.g. for testing or admin override). */
  set(value: number, nowMs: number = Date.now()): void {
    this.value = clamp(value, -1, 1);
    this.lastUpdateMs = nowMs;
  }

  // ── Step 4: Full-snapshot API (valence + arousal) ────────────────────────

  /**
   * Return the current full self-mood snapshot (valence + arousal).
   * Decay is applied to both dimensions before returning.
   */
  getCurrent(nowMs: number = Date.now()): SelfMoodSnapshot {
    this.applyDecay(nowMs);
    return {
      valence: this.value,
      arousal: this.arousal,
      updatedAt: this.lastUpdateMs,
    };
  }

  /**
   * Force-set the full mood snapshot (valence + arousal).
   * Used for restoring persisted mood on startup.
   */
  setCurrent(snapshot: SelfMoodSnapshot, nowMs?: number): void {
    this.value = clamp(snapshot.valence, -1, 1);
    this.arousal = clamp(snapshot.arousal, 0, 1);
    this.lastUpdateMs = nowMs ?? Date.now();
  }

  /**
   * Nudge both valence and arousal toward the given targets using a small
   * step blend.  This is the primary LLM state-writeback entry-point for
   * self_mood updates.
   *
   * Valence is blended: current * (1 - w) + target * w
   * Arousal (if provided) is blended with the same weight.
   * Returns the full snapshot after the nudge.
   */
  nudge(input: { valence: number; arousal?: number; nowMs: number; weight?: number }): SelfMoodSnapshot {
    const { nowMs } = input;
    this.applyDecay(nowMs);
    const w = clamp(input.weight ?? 0.2, 0, 1);
    const safeTarget = clamp(input.valence, -1, 1);
    this.value = clamp(this.value * (1 - w) + safeTarget * w, -1, 1);
    if (typeof input.arousal === 'number' && Number.isFinite(input.arousal)) {
      const safeArousalTarget = clamp(input.arousal, 0, 1);
      this.arousal = clamp(this.arousal * (1 - w) + safeArousalTarget * w, 0, 1);
    }
    this.lastUpdateMs = nowMs;
    return this.getCurrent(nowMs);
  }

  // ── private ──────────────────────────────────────────────────────────────

  private applyDecay(nowMs?: number): void {
    const now = nowMs ?? Date.now();
    const elapsedS = (now - this.lastUpdateMs) / 1000;
    if (elapsedS > 0) {
      // Exponential decay toward 0: mood(t+dt) = mood(t) * exp(-λ·dt)
      this.value = clamp(
        this.value * Math.exp(-this.DECAY_PER_SECOND * elapsedS),
        -1,
        1,
      );
      // Arousal decays toward neutral (0.5)
      this.arousal = clamp(
        NEUTRAL_AROUSAL + (this.arousal - NEUTRAL_AROUSAL) * Math.exp(-this.DECAY_PER_SECOND * elapsedS),
        0,
        1,
      );
    }
    this.lastUpdateMs = now;
  }

  private eventDelta(event: MoodEvent): number {
    switch (event) {
      case 'positive_interaction':
        return 0.08;
      case 'negative_interaction':
        return -0.12;
      case 'silence_timeout':
        return -0.05;
      case 'proactive_accepted':
        return 0.10;
      case 'proactive_ignored':
        return -0.08;
      default:
        return 0;
    }
  }
}

export function describeMood(value: number): string {
  if (value < -0.5) return 'Feeling a bit down';
  if (value < -0.15) return 'A little off';
  if (value <= 0.15) return 'Feeling neutral';
  if (value <= 0.5) return 'In a decent mood';
  return 'Feeling good';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
