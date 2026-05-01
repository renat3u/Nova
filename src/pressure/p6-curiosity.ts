

import { DUNBAR_TIER_WEIGHT } from '../world/constants';
import type { ContactAttrs, DunbarTier } from '../world/entities';
import type { WorldModel } from '../world/model';
import { elapsedS, readNodeMs } from './clock';
import type { PressureResult } from './types';

export const CHANNEL_HUNGER_TAU_S = 21600;
export const CHANNEL_CURIOSITY_WEIGHT = 0.3;
export const TAU_CURIOSITY = 3000;
export const SIGMA_HALF_LIFE = 10;
export const DUNBAR_150 = 150;
export const FAMILIARITY_DAYS = 7;

const MAX_TIER_WEIGHT = Math.max(...Object.values(DUNBAR_TIER_WEIGHT));

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
    if (attrs.chat_type !== 'group') continue;
    const unread = attrs.unread ?? 0;
    if (unread <= 0) continue;

    const lastReadMs = Number(attrs.last_read_ms ?? 0);
    const sinceReadS = lastReadMs > 0 ? elapsedS(nowMs, lastReadMs) : 0;
    const lastActivityMs = readNodeMs(world, channelId, 'last_activity_ms');
    const effectiveSinceS = sinceReadS > 0 ? sinceReadS : elapsedS(nowMs, lastActivityMs);
    if (effectiveSinceS <= 0) continue;

    const hunger = 1 - Math.exp(-effectiveSinceS / CHANNEL_HUNGER_TAU_S);
    const channelCuriosity = CHANNEL_CURIOSITY_WEIGHT * hunger * Math.log1p(unread);
    if (channelCuriosity > 0) {
      contributions[channelId] = channelCuriosity;
      surpriseSum += 1 - hunger;
      sourceCount++;
    }
  }

  const noveltyThisTick = sourceCount > 0 ? surpriseSum / sourceCount : 0;
  noveltyHistory.push(noveltyThisTick);
  if (noveltyHistory.length > k) noveltyHistory.shift();

  const meanNovelty = noveltyHistory.length > 0
    ? noveltyHistory.reduce((a, b) => a + b, 0) / noveltyHistory.length
    : 0;
  const subtractiveTotal = Math.max(0, eta - meanNovelty);
  const contactFamiliarity = Math.min(1, contactIds.length / DUNBAR_150);
  const timeFamiliarity = Math.min(1, graphAgeDays / FAMILIARITY_DAYS);
  const ambientCuriosity = eta * (1 - contactFamiliarity * timeFamiliarity);
  const total = Math.max(subtractiveTotal, ambientCuriosity);

  const rawSum = Object.values(contributions).reduce((a, b) => a + b, 0);
  if (rawSum > 0 && total > 0) {
    const scale = total / rawSum;
    for (const key of Object.keys(contributions)) contributions[key] = (contributions[key] ?? 0) * scale;
  } else if (rawSum > 0 && total === 0) {
    for (const key of Object.keys(contributions)) contributions[key] = 0;
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
