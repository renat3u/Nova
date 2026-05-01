import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdaptiveKappa, PRESSURE_HISTORY_SIZE } from './aggregate.js';
import { CHANNEL_P1_CAP, p1AttentionDebt } from './p1-attention.js';
import { KAPPA_ATTRACTION_P3, MU_ATTRACTION_THETA, P3_TOP_K, p3RelationshipCooling } from './p3-relationship.js';
import {
  CHANNEL_CURIOSITY_WEIGHT,
  CHANNEL_HUNGER_TAU_S,
  DUNBAR_150,
  FAMILIARITY_DAYS,
  SIGMA_HALF_LIFE,
  TAU_CURIOSITY,
  p6Curiosity,
  resetNoveltyHistory,
} from './p6-curiosity.js';
import {
  CHAT_TYPE_WEIGHTS,
  DEFAULT_KAPPA,
  DUNBAR_TIER_THETA,
  DUNBAR_TIER_WEIGHT,
  GROUP_PRESENCE_THETA,
  PERIPHERAL_TIER_WINDOW_S,
  PRESSURE_SPECS,
} from '../world/constants.js';
import { WorldModel } from '../world/model.js';
import type { ChannelAttrs, ContactAttrs } from '../world/entities.js';

const baseContact = (id: string, nowMs: number, patch: Partial<ContactAttrs> = {}): ContactAttrs => ({
  id,
  entity_type: 'contact',
  platform: 'qq',
  qq: id.slice('qq:user:'.length),
  tier: 50,
  last_active_ms: nowMs,
  interaction_count: 1,
  relation_type: 'unknown',
  nova_initiated_count: 0,
  contact_initiated_count: 1,
  rv_familiarity: 0,
  rv_trust: 0.3,
  rv_affection: 0,
  rv_attraction: 0,
  rv_respect: 0.3,
  rv_familiarity_velocity: 0,
  rv_trust_velocity: 0,
  rv_affection_velocity: 0,
  rv_attraction_velocity: 0,
  rv_respect_velocity: 0,
  hawkes_carry: 0,
  ...patch,
});

const baseChannel = (id: string, chatType: 'private' | 'group', nowMs: number, patch: Partial<ChannelAttrs> = {}): ChannelAttrs => ({
  id,
  entity_type: 'channel',
  platform: 'qq',
  chat_type: chatType,
  tier_contact: chatType === 'private' ? 50 : 150,
  unread: 0,
  pending_directed: 0,
  last_activity_ms: nowMs,
  nova_thinking_since: null,
  contact_recv_window: 0,
  activity_relevance: 1,
  member_count: 0,
  hawkes_carry: 0,
  ...patch,
});

test('Nova pressure constants match Nova Step 03 specs', () => {
  assert.deepEqual(PRESSURE_SPECS, {
    P1: { kappaMin: 15.0, typicalScale: 200 },
    P2: { kappaMin: 20.0, typicalScale: 50 },
    P3: { kappaMin: 10.0, typicalScale: 8 },
    P4: { kappaMin: 5.0, typicalScale: 10 },
    P5: { kappaMin: 50.0, typicalScale: 50 },
    P6: { kappaMin: 0.5, typicalScale: 0.6 },
  });
  assert.deepEqual(DEFAULT_KAPPA, [15, 20, 10, 5, 50, 0.5]);
  assert.deepEqual(DUNBAR_TIER_WEIGHT, { 5: 5.0, 15: 3.0, 50: 1.5, 150: 0.8, 500: 0.3 });
  assert.deepEqual(DUNBAR_TIER_THETA, { 5: 7200, 15: 14400, 50: 43200, 150: 172800, 500: 604800 });
  assert.deepEqual(PERIPHERAL_TIER_WINDOW_S, { 5: 86400, 15: 43200, 50: 21600, 150: 7200, 500: 0 });
  assert.deepEqual(GROUP_PRESENCE_THETA, { 5: 1800, 15: 3600, 50: 7200, 150: 14400, 500: 43200 });
  assert.deepEqual(CHAT_TYPE_WEIGHTS, { private: { attention: 3, response: 2 }, group: { attention: 1, response: 1 } });
  assert.equal(PRESSURE_HISTORY_SIZE, 10);
});

test('AdaptiveKappa starts from kappaMin and uses time half-life update', () => {
  const kappa = new AdaptiveKappa([15, 20, 10, 5, 50, 0.5]);
  assert.deepEqual(kappa.current(), [15, 20, 10, 5, 50, 0.5]);

  const updated = kappa.update([115, 20, 10, 5, 50, 0.5]);
  const alpha = 1 - Math.exp((-60 * Math.LN2) / 1500);
  assert.equal(updated[0], Math.max(15, alpha * 115 + (1 - alpha) * 15));
});

test('P1 uses Nova channel cap for groups and bot damping for private chats', () => {
  assert.equal(CHANNEL_P1_CAP, 5);
  const nowMs = 1_000_000;
  const world = new WorldModel();
  world.addChannel('qq:group:1', baseChannel('qq:group:1', 'group', nowMs, { unread: 100, tier_contact: 5 }));
  world.addContact('qq:user:2', baseContact('qq:user:2', nowMs, { is_bot: true }));
  world.addChannel('qq:private:2', baseChannel('qq:private:2', 'private', nowMs, { unread: 100, tier_contact: 50 }));

  const result = p1AttentionDebt(world, nowMs);
  assert.equal(result.contributions['qq:group:1'], CHANNEL_P1_CAP);
  assert.ok((result.contributions['qq:private:2'] ?? 0) > CHANNEL_P1_CAP);
  assert.ok((result.contributions['qq:private:2'] ?? 0) < 100 * 1.5 * 3);
});

test('P3 rises for silent contacts and skips when Nova already acted after last contact activity', () => {
  assert.equal(MU_ATTRACTION_THETA, 0.3);
  assert.equal(KAPPA_ATTRACTION_P3, 0.5);
  assert.equal(P3_TOP_K, 8);
  const nowMs = 10 * 86_400_000;
  const lastActiveMs = nowMs - 4 * 86_400_000;
  const world = new WorldModel();
  world.addContact('qq:user:100', baseContact('qq:user:100', nowMs, { qq: '100', tier: 50, last_active_ms: lastActiveMs }));
  world.addChannel('qq:private:100', baseChannel('qq:private:100', 'private', nowMs, { last_activity_ms: lastActiveMs }));

  const active = p3RelationshipCooling(world, 1, nowMs);
  assert.ok((active.contributions['qq:user:100'] ?? 0) > 0);

  world.updateChannel('qq:private:100', { last_nova_action_ms: nowMs - 1000 });
  const skipped = p3RelationshipCooling(world, 2, nowMs);
  assert.equal(skipped.contributions['qq:user:100'], undefined);
});

test('P3 applies reciprocity damping and group presence pressure without extra Nova multiplier', () => {
  const nowMs = 10 * 86_400_000;
  const lastActiveMs = nowMs - 4 * 86_400_000;
  const world = new WorldModel();
  world.addContact('qq:user:100', baseContact('qq:user:100', nowMs, { qq: '100', tier: 50, last_active_ms: lastActiveMs }));
  world.addChannel('qq:private:100', baseChannel('qq:private:100', 'private', nowMs, { last_activity_ms: lastActiveMs }));
  const normal = p3RelationshipCooling(world, 1, nowMs).contributions['qq:user:100'] ?? 0;

  world.updateContact('qq:user:100', { nova_initiated_count: 6, contact_initiated_count: 1 });
  const damped = p3RelationshipCooling(world, 2, nowMs).contributions['qq:user:100'] ?? 0;
  assert.ok(damped < normal);

  world.addChannel('qq:group:1', baseChannel('qq:group:1', 'group', nowMs, {
    tier_contact: 150,
    last_nova_action_ms: nowMs - 20_000_000,
    last_activity_ms: nowMs - 1_000,
  }));
  const group = p3RelationshipCooling(world, 3, nowMs);
  assert.ok((group.contributions['qq:group:1'] ?? 0) > 0);
});

test('P6 uses Nova curiosity constants and group channel hunger as bounded explore input', () => {
  assert.equal(CHANNEL_HUNGER_TAU_S, 21600);
  assert.equal(CHANNEL_CURIOSITY_WEIGHT, 0.3);
  assert.equal(TAU_CURIOSITY, 3000);
  assert.equal(SIGMA_HALF_LIFE, 10);
  assert.equal(DUNBAR_150, 150);
  assert.equal(FAMILIARITY_DAYS, 7);

  resetNoveltyHistory();
  const nowMs = 10 * 86_400_000;
  const world = new WorldModel();
  world.addContact('qq:user:100', baseContact('qq:user:100', nowMs, {
    qq: '100',
    tier: 50,
    last_active_ms: nowMs - 3_600_000,
    interaction_count: 4,
  }));
  world.addChannel('qq:group:1', baseChannel('qq:group:1', 'group', nowMs, {
    unread: 5,
    last_activity_ms: nowMs - 43_200_000,
    last_read_ms: nowMs - 43_200_000,
  }));

  const result = p6Curiosity(world, nowMs, 0.6, 20);
  assert.ok(result.total >= 0);
  assert.ok(result.total <= 0.6);
  assert.ok((result.contributions['qq:group:1'] ?? 0) > 0);
});
