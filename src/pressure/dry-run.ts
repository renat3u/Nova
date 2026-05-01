

import { computeAllPressures, createPressureHistory } from './aggregate';
import { conversationIdForChannel } from '../world/constants';
import { WorldModel } from '../world/model';

interface ScenarioResult {
  name: string;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  p5: number;
  p6: number;
  pProspect: number;
  api: number;
  apiPeak: number;
}

export function runPressureDryRun(nowMs = Date.now()): ScenarioResult[] {
  return [
    privateDirected(nowMs),
    groupOrdinary(nowMs),
    groupDirected(nowMs),
    staleRelationship(nowMs),
    staleFact(nowMs),
    openThread(nowMs),
    nearDeadline(nowMs),
  ];
}

function privateDirected(nowMs: number): ScenarioResult {
  const world = new WorldModel();
  world.addContact('qq:user:1001', contact('qq:user:1001', nowMs));
  world.addChannel('qq:private:1001', channel('private', nowMs, { unread: 1, pending_directed: 1, last_directed_ms: nowMs }));
  world.addConversation(conversationIdForChannel('qq:private:1001'), {
    channel_id: 'qq:private:1001',
    state: 'active',
    turn_state: 'nova_turn',
    last_activity_ms: nowMs,
  });
  return result('private directed', world, nowMs);
}

function groupOrdinary(nowMs: number): ScenarioResult {
  const world = new WorldModel();
  world.addContact('qq:user:1002', contact('qq:user:1002', nowMs));
  world.addChannel('qq:group:2001', channel('group', nowMs, { unread: 8, pending_directed: 0 }));
  return result('group ordinary', world, nowMs);
}

function groupDirected(nowMs: number): ScenarioResult {
  const world = new WorldModel();
  world.addContact('qq:user:1003', contact('qq:user:1003', nowMs));
  world.addChannel('qq:group:2002', channel('group', nowMs, { unread: 2, pending_directed: 1, last_directed_ms: nowMs }));
  return result('group directed', world, nowMs);
}

function staleRelationship(nowMs: number): ScenarioResult {
  const world = new WorldModel();
  world.addContact('qq:user:1004', contact('qq:user:1004', nowMs - 10 * 86400000, { tier: 50 }));
  world.addChannel('qq:private:1004', channel('private', nowMs - 10 * 86400000, { unread: 0, pending_directed: 0 }));
  return result('stale private relationship', world, nowMs);
}

function staleFact(nowMs: number): ScenarioResult {
  const world = new WorldModel();
  world.addFact('qq:fact:1', {
    content: 'User prefers concise technical answers',
    fact_type: 'preference',
    importance: 0.8,
    volatility: 0.00001,
    stability: 1,
    tracked: true,
    created_ms: nowMs - 30 * 86400000,
    last_access_ms: nowMs - 30 * 86400000,
  });
  return result('stale tracked fact', world, nowMs);
}

function openThread(nowMs: number): ScenarioResult {
  const world = new WorldModel();
  world.addThread('qq:thread:old', {
    status: 'open',
    w: 2,
    created_ms: nowMs - 3 * 86400000,
    channel_id: 'qq:private:1005',
  });
  return result('open thread age', world, nowMs);
}

function nearDeadline(nowMs: number): ScenarioResult {
  const world = new WorldModel();
  world.addThread('qq:thread:deadline', {
    status: 'open',
    w: 2,
    created_ms: nowMs - 23 * 3600000,
    deadline_ms: nowMs + 3600000,
    channel_id: 'qq:private:1006',
  });
  return result('near deadline', world, nowMs);
}

function result(name: string, world: WorldModel, nowMs: number): ScenarioResult {
  const pressure = computeAllPressures(world, 1, { nowMs, history: createPressureHistory() });
  return {
    name,
    p1: round(pressure.P1),
    p2: round(pressure.P2),
    p3: round(pressure.P3),
    p4: round(pressure.P4),
    p5: round(pressure.P5),
    p6: round(pressure.P6),
    pProspect: round(pressure.P_prospect),
    api: round(pressure.API),
    apiPeak: round(pressure.API_peak),
  };
}

function contact(id: string, lastActiveMs: number, patch: Partial<Parameters<WorldModel['addContact']>[1]> = {}): Parameters<WorldModel['addContact']>[1] {
  return {
    platform: 'qq',
    qq: id.split(':').at(-1) ?? id,
    tier: 50,
    last_active_ms: lastActiveMs,
    interaction_count: 3,
    nova_initiated_count: 0,
    contact_initiated_count: 3,
    hawkes_carry: 1,
    hawkes_last_event_ms: lastActiveMs,
    ...patch,
  };
}

function channel(
  chatType: 'private' | 'group',
  lastActivityMs: number,
  patch: Partial<Parameters<WorldModel['addChannel']>[1]> = {},
): Parameters<WorldModel['addChannel']>[1] {
  return {
    platform: 'qq',
    chat_type: chatType,
    tier_contact: chatType === 'private' ? 50 : 150,
    unread: 0,
    pending_directed: 0,
    last_activity_ms: lastActivityMs,
    contact_recv_window: 0,
    activity_relevance: 1,
    hawkes_carry: 0,
    nova_thinking_since: null,
    ...patch,
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
