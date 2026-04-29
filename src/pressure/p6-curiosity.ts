// Alice baseline reference: pressure model adapted for Nova QQ runtime.

import { DUNBAR_TIER_WEIGHT } from '../world/constants';
import type { ContactAttrs, DunbarTier } from '../world/entities';
import type { WorldModel } from '../world/model';
import { elapsedS, readNodeMs } from './clock';
import type { PressureResult } from './types';

const TAU_CURIOSITY = 3000;
const MAX_TIER_WEIGHT = Math.max(...Object.values(DUNBAR_TIER_WEIGHT));
const SIGMA_HALF_LIFE = 10;
const DUNBAR_150 = 150;
const FAMILIARITY_DAYS = 7;
const GROUP_AMBIENT_WEIGHT = 0.08;

const TIER_EXPECTED_SILENCE_S: Record<DunbarTier, number> = {
  5: 14400,
  15: 86400,
  50: 259200,
  150: 1209600,
  500: 5184000,
};

const TIER_EXPECTED_DAILY_RATE: Record<DunbarTier, number> = {
  5: 6,
  15: 1,
  50: 0.33,
  150: 0.07,
  500: 0.016,
};

const noveltyHistory: number[] = [];

export function resetNoveltyHistory(): void {
  noveltyHistory.length = 0;
}

export function p6Curiosity(world: WorldModel, nowMs: number, eta = 0.6, k = 20): PressureResult {
  const contactIds = world.getEntitiesByType('contact');
  const graphAgeDays = world.getGraphAgeMs(nowMs) / 86400000;
  const contributions: Record<string, number> = {};
  let surpriseSum = 0;
  let sourceCount = 0;

  for (const contactId of contactIds) {
    const attrs = world.getContact(contactId);
    if (attrs.is_bot === true) continue;
    const lastActiveMs = readNodeMs(world, contactId, 'last_active_ms');
    if (lastActiveMs <= 0) continue;

    const tierWeight = (DUNBAR_TIER_WEIGHT[attrs.tier] ?? 0.8) / MAX_TIER_WEIGHT;
    const surprise = computeSurprise(attrs, nowMs, graphAgeDays);
    const gamma = 1 - Math.exp(-elapsedS(nowMs, lastActiveMs) / TAU_CURIOSITY);
    const curiosity = tierWeight * surprise * gamma;
    if (curiosity > 0) {
      contributions[contactId] = curiosity;
      surpriseSum += surprise;
      sourceCount++;
    }
  }

  for (const channelId of world.getEntitiesByType('channel')) {
    const attrs = world.getChannel(channelId);
    if (attrs.chat_type !== 'group' || attrs.unread <= 0) continue;
    const lastActivityMs = readNodeMs(world, channelId, 'last_activity_ms');
    if (lastActivityMs <= 0) continue;
    const ambient = GROUP_AMBIENT_WEIGHT * Math.log1p(attrs.unread) * Math.min(1, elapsedS(nowMs, lastActivityMs) / 21600);
    if (ambient > 0) contributions[channelId] = ambient;
  }

  const noveltyThisTick = sourceCount > 0 ? surpriseSum / sourceCount : 0;
  noveltyHistory.push(noveltyThisTick);
  if (noveltyHistory.length > k) noveltyHistory.shift();
  const meanNovelty = noveltyHistory.reduce((a, b) => a + b, 0) / Math.max(1, noveltyHistory.length);  const subtractiveTotal = Math.max(0, eta - meanNovelty);
  const contactFamiliarity = Math.min(1, contactIds.length / DUNBAR_150);
  const timeFamiliarity = Math.min(1, graphAgeDays / FAMILIARITY_DAYS);
  const ambientCuriosity = eta * (1 - contactFamiliarity * timeFamiliarity);
  const total = Math.max(subtractiveTotal, ambientCuriosity);

  const rawSum = Object.values(contributions).reduce((a, b) => a + b, 0);
  if (rawSum > 0 && total > 0) {
    const scale = total / rawSum;
    for (const key of Object.keys(contributions)) contributions[key] = (contributions[key] ?? 0) * scale;
  }

  return { total, contributions };
}

function computeSurprise(attrs: ContactAttrs, nowMs: number, graphAgeDays: number): number {
  const sigma = 1 / (1 + attrs.interaction_count / SIGMA_HALF_LIFE);
  const s1 = silenceDeviation(attrs, nowMs);
  const s2 = activityRateDeviation(attrs, graphAgeDays);
  return sigma + (1 - sigma) * Math.tanh((s1 + s2) / 2);
}

function silenceDeviation(attrs: ContactAttrs, nowMs: number): number {
  if (!attrs.last_active_ms) return 0;
  const expected = TIER_EXPECTED_SILENCE_S[attrs.tier] ?? 604800;
  return Math.abs(elapsedS(nowMs, attrs.last_active_ms) - expected) / expected;
}

function activityRateDeviation(attrs: ContactAttrs, graphAgeDays: number): number {
  if (attrs.interaction_count < 2 || graphAgeDays < 1) return 0;
  const actualDailyRate = attrs.interaction_count / graphAgeDays;
  const expectedDailyRate = TIER_EXPECTED_DAILY_RATE[attrs.tier] ?? 0.14;
  return Math.abs(Math.log(Math.max(actualDailyRate / expectedDailyRate, 0.01)));
}
