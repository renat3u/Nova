//
// P7 — Loneliness (孤独感)
//
// When Nova hasn't heard from people she cares about for a while,
// an inner loneliness builds.  Only applies to contacts with closeness
// above a floor — strangers don't make Nova feel lonely.
//
// Characteristics:
//   - Closeness-squared weighting: very close friends matter far more
//   - logSigmoid silence decay: 3-day half-life, saturates (Nova adapts)
//   - Modulated by current mood: low mood amplifies loneliness
//   - Capped contribution per contact to avoid unbounded growth
//

import type { WorldModel } from '../world/model';
import { elapsedS, readNodeMs } from './clock';
import { logSigmoid } from '../utils/math';
import type { PressureResult } from './types';
import { readRV, computeCloseness } from '../world/relationship-vector';

/** Minimum closeness to feel loneliness toward someone. */
const CLOSENESS_FLOOR = 0.15;
/** Sigmoid tau: years-scale saturation. */
const SIGMOID_TAU = 1.5;
/** Silence half-life in seconds (~3 days). */
const SILENCE_THETA_S = 86400 * 3;
/** Sigmoid beta. */
const SIGMOID_BETA = 0.2;

export function p7Loneliness(
  world: WorldModel,
  nowMs: number,
  moodValence: number,
): PressureResult {
  const contributions: Record<string, number> = {};
  let totalFromContacts = 0;

  for (const contactId of world.getEntitiesByType('contact')) {
    const attrs = world.getContact(contactId);
    if (attrs.is_bot) continue;

    const rv = readRV(attrs);
    const closeness = computeCloseness(rv);
    if (closeness < CLOSENESS_FLOOR) continue;

    const lastActiveMs = readNodeMs(world, contactId, 'last_active_ms');
    if (lastActiveMs <= 0) continue;

    const silenceS = elapsedS(nowMs, lastActiveMs);

    // Closeness squared — very close people dominate
    const closenessWeight = closeness * closeness;
    // Silence sigmoid — rises then saturates
    const silenceWeight = logSigmoid(silenceS, SIGMOID_BETA, SILENCE_THETA_S, SIGMOID_TAU);

    const contribution = closenessWeight * silenceWeight;
    contributions[contactId] = contribution;
    totalFromContacts += contribution;
  }

  // Mood modulation: low mood amplifies loneliness (up to 1.5x), high dampens (down to 0.6x)
  const moodMultiplier = 1.0 - moodValence * 0.4;
  const total = totalFromContacts * Math.max(0.5, Math.min(2.0, moodMultiplier));

  return { total, contributions };
}
