//
// P8 — Fear of Being Forgotten (被遗忘恐惧)
//
// When Nova reached out to someone proactively but they haven't responded,
// or when Nova remembers someone well but they seem not to remember her,
// a quiet anxiety builds.
//
// Two sub-signals:
//   1. Unreplied proactive outreach — Nova sent a message, got no response
//   2. Asymmetric memory — Nova remembers them far more than they interact
//
// Characteristics:
//   - Only for closeness > 0.2 (strangers don't trigger this fear)
//   - Waiting urgency decays with logSigmoid (4h half-life)
//   - Closeness-weighted: more devastating from close friends
//   - Top-K contributions only — the deepest hurts, not every contact
//

import type { WorldModel } from '../world/model';
import { elapsedS } from './clock';
import { logSigmoid } from '../utils/math';
import type { PressureResult } from './types';
import { readRV, computeCloseness } from '../world/relationship-vector';

const CLOSENESS_FLOOR = 0.2;
const WAITING_HALF_LIFE_S = 3600 * 4; // 4 hours
const WAITING_BETA = 0.3;
const WAITING_TAU = 2.0;
const ASYMMETRY_THRESHOLD_INITIATED = 5;
const ASYMMETRY_THRESHOLD_RESPONDED = 3;
const ASYMMETRY_WEIGHT = 0.3;
const MAX_CONTRIBUTIONS = 5;

export function p8FearOfBeingForgotten(
  world: WorldModel,
  nowMs: number,
): PressureResult {
  const contributions: Record<string, number> = {};

  for (const contactId of world.getEntitiesByType('contact')) {
    const attrs = world.getContact(contactId);
    if (attrs.is_bot) continue;

    const rv = readRV(attrs);
    const closeness = computeCloseness(rv);
    if (closeness < CLOSENESS_FLOOR) continue;

    let contribution = 0;

    // 1. Unreplied proactive outreach
    const lastProactiveMs = attrs.last_proactive_outreach_ms ?? 0;
    const lastActiveMs = attrs.last_active_ms ?? 0;
    if (lastProactiveMs > lastActiveMs && lastProactiveMs > 0) {
      const waitingS = elapsedS(nowMs, lastProactiveMs);
      const urgency = logSigmoid(waitingS, WAITING_BETA, WAITING_HALF_LIFE_S, WAITING_TAU);
      contribution += closeness * urgency * 0.8;
    }

    // 2. Asymmetric memory: Nova remembers them, they don't seem to reciprocate
    const initiatedCount = attrs.nova_initiated_count ?? 0;
    const respondedCount = attrs.contact_initiated_count ?? 0;
    if (initiatedCount > ASYMMETRY_THRESHOLD_INITIATED && respondedCount < ASYMMETRY_THRESHOLD_RESPONDED) {
      contribution += closeness * ASYMMETRY_WEIGHT;
    }

    if (contribution > 0) {
      contributions[contactId] = contribution;
    }
  }

  // Keep only top-K contributions — these are the deepest fears
  const sorted = Object.entries(contributions)
    .sort((a, b) => b[1] - a[1]);
  const topContributions: Record<string, number> = {};
  let total = 0;
  for (const [id, value] of sorted.slice(0, MAX_CONTRIBUTIONS)) {
    topContributions[id] = value;
    total += value;
  }

  return { total, contributions: topContributions };
}
