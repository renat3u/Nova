import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEmptyGroupProfile,
  MAX_MEMBER_HIGHLIGHTS,
} from './types.js';
import type { GroupProfile, MemberHighlight } from './types.js';
import {
  updateActiveHours,
  updateGroupProfileFromMessage,
  upsertMemberHighlight,
  generateGroupProfileSummary,
  buildGroupPolicyInput,
} from './group-profile.js';
import type { NovaMessageEvent } from '../core/types.js';
import type { ContactAttrs } from '../world/entities.js';
import { INITIAL_RV } from '../world/relationship-vector.js';

const nowMs = Date.now(); // current time, used for active hours tests

function makeEvent(overrides: Partial<NovaMessageEvent> = {}): NovaMessageEvent {
  return {
    id: 'event:1',
    platform: 'qq',
    rawEvent: {},
    messageId: 'msg:1',
    rawMessageId: '1001',
    chatType: 'group',
    chatId: 'qq:group:12345',
    groupId: '12345',
    groupName: 'Test Group',
    senderId: 'qq:user:10001',
    senderQQ: '10001',
    senderName: 'TestUser',
    text: 'Hello',
    rawText: 'Hello',
    timestamp: nowMs,
    isSelf: false,
    mentionedSelf: false,
    repliedToSelf: false,
    isDirected: false,
    ...overrides,
  };
}

function makeContact(overrides: Partial<ContactAttrs> = {}): ContactAttrs {
  return {
    id: 'qq:user:10001',
    entity_type: 'contact',
    platform: 'qq',
    qq: '10001',
    tier: 50,
    last_active_ms: nowMs,
    interaction_count: 1,
    relation_type: 'unknown',
    nova_initiated_count: 0,
    contact_initiated_count: 1,
    rv_familiarity: INITIAL_RV.familiarity,
    rv_trust: INITIAL_RV.trust,
    rv_affection: INITIAL_RV.affection,
    rv_attraction: INITIAL_RV.attraction,
    rv_respect: INITIAL_RV.respect,
    rv_familiarity_velocity: 0,
    rv_trust_velocity: 0,
    rv_affection_velocity: 0,
    rv_attraction_velocity: 0,
    rv_respect_velocity: 0,
    hawkes_carry: 0,
    ...overrides,
  };
}

// -- GroupProfile creation ---------------------------------------------------

test('createEmptyGroupProfile initialises with defaults', () => {
  const profile = createEmptyGroupProfile('12345', 'Test Group', 'member', nowMs);
  assert.equal(profile.groupId, '12345');
  assert.equal(profile.groupName, 'Test Group');
  assert.equal(profile.novaRole, 'member');
  assert.equal(profile.topic, null);
  assert.equal(profile.atmosphere, null);
  assert.deepStrictEqual(profile.memberHighlights, []);
  assert.deepStrictEqual(profile.crystallizedInterests, {});
  assert.equal(profile.activeHours.length, 24);
  assert.equal(profile.activeHours.every((v) => v === 0), true);
  assert.equal(profile.recentTopicDrift, null);
  assert.equal(profile.updatedMs, nowMs);
});

// -- activeHours EMA ---------------------------------------------------------

test('updateActiveHours increments the correct hour slot via EMA', () => {
  const hours = new Array(24).fill(0) as number[];
  const expectedHour = new Date(nowMs).getHours();
  const updated = updateActiveHours(hours, nowMs);
  const updatedValue = updated[expectedHour] ?? -1;
  assert.ok(updatedValue > 0, `hour ${expectedHour} should be > 0`);
  assert.equal(updatedValue, 0.1, 'EMA alpha=0.1, from 0, so first update = 0.1');
  for (let i = 0; i < 24; i++) {
    if (i === expectedHour) continue;
    assert.equal(updated[i] ?? 0, 0, `hour ${i} should remain 0`);
  }
});

test('updateActiveHours converges towards 1 with repeated hits', () => {
  let hours = new Array(24).fill(0) as number[];
  const expectedHour = new Date(nowMs).getHours();
  for (let t = 0; t < 50; t++) {
    hours = updateActiveHours(hours, nowMs);
  }
  const convergedValue = hours[expectedHour] ?? 0;
  assert.ok(convergedValue > 0.9, 'after 50 EMA updates, should be close to 1');
  assert.ok(convergedValue < 1.0, 'should never exceed 1');
});

test('updateActiveHours does not mutate the input array', () => {
  const hours = new Array(24).fill(0) as number[];
  const expectedHour = new Date(nowMs).getHours();
  const updated = updateActiveHours(hours, nowMs);
  assert.equal(hours[expectedHour], 0, 'original should be unchanged');
  assert.equal(updated[expectedHour], 0.1, 'new array should have the update');
});

// -- Member highlights -------------------------------------------------------

test('upsertMemberHighlight adds a new member', () => {
  const event = makeEvent({ isDirected: true });
  const contact = makeContact();
  const result = upsertMemberHighlight([], event, contact, INITIAL_RV);

  assert.equal(result.length, 1);
  const first = result[0]!;
  assert.equal(first.contactId, contact.id);
  assert.equal(first.qq, '10001');
  assert.equal(first.directedCount, 1);
  assert.equal(first.replyCount, 0);
  assert.deepStrictEqual(first.relationshipVector, INITIAL_RV);
  assert.ok(first.groupsSeenIn.includes('12345'));
});

test('upsertMemberHighlight increments directedCount on repeated directed messages', () => {
  const event1 = makeEvent({ isDirected: true, timestamp: nowMs });
  const event2 = makeEvent({ isDirected: true, timestamp: nowMs + 60_000 });
  const contact = makeContact();

  const after1 = upsertMemberHighlight([], event1, contact, INITIAL_RV);
  const after2 = upsertMemberHighlight(after1, event2, contact, INITIAL_RV);

  assert.equal(after2.length, 1);
  assert.equal(after2[0]!.directedCount, 2);
});

test('upsertMemberHighlight increments replyCount on repliedToSelf', () => {
  const event = makeEvent({ repliedToSelf: true });
  const contact = makeContact();

  const result = upsertMemberHighlight([], event, contact, INITIAL_RV);
  assert.equal(result[0]!.replyCount, 1);
});

test('upsertMemberHighlight respects MAX_MEMBER_HIGHLIGHTS cap', () => {
  const existing: MemberHighlight[] = [];
  for (let i = 0; i < MAX_MEMBER_HIGHLIGHTS + 10; i++) {
    const event = makeEvent({
      senderId: `qq:user:${20000 + i}`,
      senderQQ: `${20000 + i}`,
      senderName: `User${i}`,
      timestamp: nowMs + i * 1000,
      isDirected: true,
      messageId: `msg:${i}`,
      id: `event:${i}`,
    });
    const contact = makeContact({
      id: `qq:user:${20000 + i}`,
      qq: `${20000 + i}`,
    });
    const next = upsertMemberHighlight(existing, event, contact, INITIAL_RV);
    existing.length = 0;
    existing.push(...next);
  }

  assert.equal(existing.length, MAX_MEMBER_HIGHLIGHTS,
    `should cap at ${MAX_MEMBER_HIGHLIGHTS}, got ${existing.length}`);
});

test('upsertMemberHighlight keeps highest-value members when capped', () => {
  const existing: MemberHighlight[] = [];
  // low value member from far in the past
  const oldEvent = makeEvent({
    senderId: 'qq:user:30001',
    senderQQ: '30001',
    senderName: 'OldUser',
    timestamp: nowMs - 1_000_000_000,
    isDirected: false,
    messageId: 'msg:old',
    id: 'event:old',
  });
  const oldContact = makeContact({ id: 'qq:user:30001', qq: '30001' });
  const afterOld = upsertMemberHighlight(existing, oldEvent, oldContact, INITIAL_RV);

  // many high-value members
  let current = afterOld;
  for (let i = 0; i < MAX_MEMBER_HIGHLIGHTS; i++) {
    const event = makeEvent({
      senderId: `qq:user:${40000 + i}`,
      senderQQ: `${40000 + i}`,
      senderName: `HighUser${i}`,
      timestamp: nowMs + i * 1000,
      isDirected: true,
      messageId: `msg:high:${i}`,
      id: `event:high:${i}`,
    });
    const contact = makeContact({ id: `qq:user:${40000 + i}`, qq: `${40000 + i}` });
    current = upsertMemberHighlight(current, event, contact, INITIAL_RV);
  }

  assert.equal(current.length, MAX_MEMBER_HIGHLIGHTS);
  // the old low-value member should be evicted
  const oldMemberStillPresent = current.some((m) => m.contactId === 'qq:user:30001');
  assert.equal(oldMemberStillPresent, false, 'low-value old member should be evicted');
});

// -- updateGroupProfileFromMessage -------------------------------------------

test('updateGroupProfileFromMessage creates a new profile from null', () => {
  const event = makeEvent({ isDirected: true });
  const contact = makeContact();
  const profile = updateGroupProfileFromMessage(null, event, contact, nowMs);

  assert.equal(profile.groupId, '12345');
  assert.equal(profile.groupName, 'Test Group');
  assert.equal(profile.memberHighlights.length, 1);
  assert.equal(profile.memberHighlights[0]!.directedCount, 1);
  const expectedHour = new Date(nowMs).getHours();
  assert.ok((profile.activeHours[expectedHour] ?? 0) > 0, `activeHours[${expectedHour}] should be > 0`);
});

test('updateGroupProfileFromMessage preserves existing topic and atmosphere', () => {
  const event = makeEvent();
  const contact = makeContact();
  const previous: GroupProfile = {
    ...createEmptyGroupProfile('12345', 'Test Group', 'member', nowMs - 60_000),
    topic: 'Tech discussions',
    atmosphere: 'Friendly and collaborative',
  };

  const profile = updateGroupProfileFromMessage(previous, event, contact, nowMs);
  assert.equal(profile.topic, 'Tech discussions');
  assert.equal(profile.atmosphere, 'Friendly and collaborative');
  assert.equal(profile.updatedMs, nowMs);
  assert.ok(profile.memberHighlights.length > 0);
});

// -- generateGroupProfileSummary ---------------------------------------------

test('generateGroupProfileSummary returns null for null profile', () => {
  assert.equal(generateGroupProfileSummary(null), null);
});

test('generateGroupProfileSummary includes group name', () => {
  const profile = createEmptyGroupProfile('12345', '技术交流群', 'member', nowMs);
  const summary = generateGroupProfileSummary(profile);
  assert.ok(summary?.includes('技术交流群'), 'should include group name');
});

test('generateGroupProfileSummary includes topic and atmosphere when set', () => {
  const profile: GroupProfile = {
    ...createEmptyGroupProfile('12345', 'Test', 'member', nowMs),
    topic: 'AI and machine learning',
    atmosphere: 'friendly but focused',
  };
  const summary = generateGroupProfileSummary(profile);
  assert.ok(summary?.includes('AI and machine learning'), 'should include topic');
  assert.ok(summary?.includes('friendly but focused'), 'should include atmosphere');
});

test('generateGroupProfileSummary includes active hours', () => {
  const profile = createEmptyGroupProfile('12345', 'Test', 'member', nowMs);
  // simulate active at hours 9, 10, 11, 14, 15
  for (let h = 0; h < 24; h++) {
    profile.activeHours[h] = (h >= 9 && h <= 11) || (h >= 14 && h <= 15) ? 0.5 : 0;
  }
  const summary = generateGroupProfileSummary(profile);
  assert.ok(summary?.includes('活跃时段'), 'should mention active hours');
  assert.ok(summary?.includes('9-12点') || summary?.includes('9-12'), 'should include morning range');
});

test('generateGroupProfileSummary includes top directed members', () => {
  const profile = createEmptyGroupProfile('12345', 'Test', 'member', nowMs);
  profile.memberHighlights = [
    { contactId: 'c1', qq: '1', displayName: 'Nova', groupsSeenIn: ['12345'], lastSeenInGroupMs: nowMs, directedCount: 5, replyCount: 2, relationshipVector: INITIAL_RV },
    { contactId: 'c2', qq: '2', displayName: 'Bob', groupsSeenIn: ['12345'], lastSeenInGroupMs: nowMs, directedCount: 3, replyCount: 1, relationshipVector: INITIAL_RV },
  ];
  const summary = generateGroupProfileSummary(profile);
  assert.ok(summary?.includes('Nova'), 'should mention Nova');
  assert.ok(summary?.includes('Bob'), 'should mention Bob');
});

test('generateGroupProfileSummary skips directed-members section when none directed', () => {
  const profile = createEmptyGroupProfile('12345', 'Test', 'member', nowMs);
  profile.memberHighlights = [
    { contactId: 'c1', qq: '1', displayName: 'Nova', groupsSeenIn: ['12345'], lastSeenInGroupMs: nowMs, directedCount: 0, replyCount: 0, relationshipVector: INITIAL_RV },
  ];
  const summary = generateGroupProfileSummary(profile);
  assert.equal(summary?.includes('经常和你互动'), false, 'should not mention directed members');
});

// -- buildGroupPolicyInput ---------------------------------------------------

test('buildGroupPolicyInput identifies recently active group', () => {
  const profile = createEmptyGroupProfile('12345', 'Test', 'member', nowMs);
  const input = buildGroupPolicyInput({
    profile,
    isDirected: false,
    groupRiskLevel: 'normal',
    novaRole: 'member',
    groupDisabled: false,
    proactiveWhitelistQQ: [],
    nowMs,
  });
  assert.equal(input.recentlyActive, true);
  assert.equal(input.groupRiskLevel, 'normal');
  assert.equal(input.isDirected, false);
  assert.equal(input.hasWhitelistContext, false);
});

test('buildGroupPolicyInput flags inactive group', () => {
  const profile = createEmptyGroupProfile('12345', 'Test', 'member', nowMs - 48 * 60 * 60 * 1000);
  const input = buildGroupPolicyInput({
    profile,
    isDirected: false,
    groupRiskLevel: 'normal',
    novaRole: 'member',
    groupDisabled: false,
    proactiveWhitelistQQ: [],
    nowMs,
  });
  assert.equal(input.recentlyActive, false);
});

test('buildGroupPolicyInput detects whitelist context', () => {
  const profile = createEmptyGroupProfile('12345', 'Test', 'member', nowMs);
  profile.memberHighlights = [
    { contactId: 'c1', qq: '10001', displayName: 'WhitelistUser', groupsSeenIn: ['12345'], lastSeenInGroupMs: nowMs, directedCount: 3, replyCount: 1, relationshipVector: INITIAL_RV },
  ];
  const input = buildGroupPolicyInput({
    profile,
    isDirected: false,
    groupRiskLevel: 'normal',
    novaRole: 'member',
    groupDisabled: false,
    proactiveWhitelistQQ: ['10001', '10002'],
    nowMs,
  });
  assert.equal(input.hasWhitelistContext, true);
  assert.deepStrictEqual(input.whitelistContextQQs, ['10001']);
});

test('buildGroupPolicyInput handles null profile', () => {
  const input = buildGroupPolicyInput({
    profile: null,
    isDirected: true,
    groupRiskLevel: 'normal',
    novaRole: 'member',
    groupDisabled: false,
    proactiveWhitelistQQ: [],
    nowMs,
  });
  assert.equal(input.recentlyActive, false);
  assert.equal(input.hasWhitelistContext, false);
});

// -- Active hours description coverage ---------------------------------------

test('describeActiveHours handles sparse distribution', () => {
  const profile = createEmptyGroupProfile('12345', 'Test', 'member', nowMs);
  profile.activeHours = new Array(24).fill(0) as number[];
  profile.activeHours[8] = 0.3;
  profile.activeHours[20] = 0.3;
  const summary = generateGroupProfileSummary(profile);
  assert.ok(summary?.includes('8点') || summary?.includes('8'), 'should include hour 8');
  assert.ok(summary?.includes('20点') || summary?.includes('20'), 'should include hour 20');
});
