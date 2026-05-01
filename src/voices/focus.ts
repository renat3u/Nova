
//
// Adds per-entity scoring from AllPressures.contributions (P1-P6 per-entity breakdowns)
// on top of the existing pressure-signal computation.
//

// by scoring entities directly from pressure contributions — same behavioral effect
// (entity-aware voice competition) without the full tension graph infrastructure.

import type { AllPressures } from '../pressure/aggregate';
import type { WorldModel } from '../world/model';
import type { VoiceId } from './personality';

// ── Types ──────────────────────────────────────────────────────────────────

export interface FocalSignal {
  name: string;
  value: number;
  reason: string;
}

export interface FocalEntity {
  entityId: string;
  relevance: number;
  source: string;
  displayName?: string;
}

export interface FocalSet {
  signals: FocalSignal[];
  entities: FocalEntity[];
  meanRelevance: number;
  primarySignal: string | null;
  primaryEntity: string | null;
  reasons: string[];
}

export interface VoiceFocusContext {
  world: WorldModel;
  pressure: AllPressures;
  channelId?: string;
  senderId?: string;
  chatType?: 'private' | 'group';
  directed?: boolean;
  nowMs: number;
}

// ── Per-entity contribution scoring ────────────────────────────────────────

interface ScoredEntity {
  entityId: string;
  relevance: number;
  source: string;
  displayName?: string;
}

function collectEntityScores(pressure: AllPressures, world: WorldModel): {
  p5Channels: ScoredEntity[];
  p3Contacts: ScoredEntity[];
  p1Channels: ScoredEntity[];
  p4Entities: ScoredEntity[];
  p2Entities: ScoredEntity[];
} {
  const p5Channels: ScoredEntity[] = [];
  const p3Contacts: ScoredEntity[] = [];
  const p1Channels: ScoredEntity[] = [];
  const p4Entities: ScoredEntity[] = [];
  const p2Entities: ScoredEntity[] = [];

  // P5: response obligation contributions (channel-level)
  for (const [entityId, value] of Object.entries(pressure.contributions.P5 ?? {})) {
    if (value <= 0) continue;
    p5Channels.push({
      entityId,
      relevance: squash(value, 50),
      source: 'P5',
      displayName: resolveDisplayName(world, entityId),
    });
  }

  // P3: relationship cooling contributions (contact-level)
  for (const [entityId, value] of Object.entries(pressure.contributions.P3 ?? {})) {
    if (value <= 0) continue;
    p3Contacts.push({
      entityId,
      relevance: squash(value, 10),
      source: 'P3',
      displayName: resolveDisplayName(world, entityId),
    });
  }

  // P1: attention debt contributions (channel-level)
  for (const [entityId, value] of Object.entries(pressure.contributions.P1 ?? {})) {
    if (value <= 0) continue;
    p1Channels.push({
      entityId,
      relevance: squash(value, 15),
      source: 'P1',
      displayName: resolveDisplayName(world, entityId),
    });
  }

  // P4: thread divergence contributions
  for (const [entityId, value] of Object.entries(pressure.contributions.P4 ?? {})) {
    if (value <= 0) continue;
    p4Entities.push({
      entityId,
      relevance: squash(value, 5),
      source: 'P4',
      displayName: resolveDisplayName(world, entityId),
    });
  }

  // P2: information pressure contributions
  for (const [entityId, value] of Object.entries(pressure.contributions.P2 ?? {})) {
    if (value <= 0) continue;
    p2Entities.push({
      entityId,
      relevance: squash(value, 20),
      source: 'P2',
      displayName: resolveDisplayName(world, entityId),
    });
  }

  // Sort descending by relevance
  const byRelevance = (a: ScoredEntity, b: ScoredEntity) => b.relevance - a.relevance;
  p5Channels.sort(byRelevance);
  p3Contacts.sort(byRelevance);
  p1Channels.sort(byRelevance);
  p4Entities.sort(byRelevance);
  p2Entities.sort(byRelevance);

  return { p5Channels, p3Contacts, p1Channels, p4Entities, p2Entities };
}

/** Combine focused entities for a voice: top-N from priority sources. */
function buildVoiceEntities(
  scored: ReturnType<typeof collectEntityScores>,
  voice: VoiceId,
): ScoredEntity[] {
  const seen = new Set<string>();
  const result: ScoredEntity[] = [];

  const add = (entities: ScoredEntity[], count: number) => {
    for (const e of entities) {
      if (result.length >= 8) break;
      if (seen.has(e.entityId)) continue;
      seen.add(e.entityId);
      result.push(e);
      if (result.filter((x) => x.source === e.source).length >= count) break;
    }
  };

  switch (voice) {
    case 'diligence':
      add(scored.p5Channels, 3);   // response obligation
      add(scored.p4Entities, 2);   // thread divergence
      add(scored.p1Channels, 2);   // attention debt (secondary)
      break;
    case 'curiosity':
      add(scored.p2Entities, 3);   // information staleness
      add(scored.p4Entities, 1);   // threads (secondary)
      break;
    case 'sociability':
      add(scored.p3Contacts, 3);   // relationship cooling
      add(scored.p5Channels, 1);   // obligation (social)
      break;
    case 'caution':
      // Caution doesn't use entity scores for proactive action;
      // it operates through gates. Keep entity list empty.
      break;
  }

  return result;
}

// ── Main focal set computation ─────────────────────────────────────────────

export function computeFocalSets(context: VoiceFocusContext): Record<VoiceId, FocalSet> {
  const normalized = normalizePressureSignals(context.pressure);
  const novelty = computeNovelty(context.world, context.channelId, context.senderId);
  const group = context.chatType === 'group';
  const privateChat = context.chatType === 'private';
  const directed = context.directed === true;
  const uncertainty = computeUncertainty(context);

  // Per-entity scores from pressure contributions
  const entityScores = collectEntityScores(context.pressure, context.world);

  // Signal-level computation (fallback when no entity contributions exist)
  const signalSets: Record<VoiceId, FocalSet> = {
    diligence: buildFocalSet([
      signal('p4', normalized.p4, 'open thread pressure'),
      signal('p5', normalized.p5, 'response obligation'),
      signal('pProspect', normalized.pProspect, 'deadline prospect'),
      signal('directed', directed ? 0.45 : 0, 'message is directed at Nova'),
    ]),
    curiosity: buildFocalSet([
      signal('p2', normalized.p2, 'tracked information staleness'),
      signal('p6', normalized.p6, 'curiosity pressure'),
      signal('novelty', novelty, 'new contact or channel novelty'),
    ]),
    sociability: buildFocalSet([
      signal('p3', normalized.p3, 'relationship cooling'),
      signal('p5', normalized.p5 * 0.75, 'ongoing response obligation'),
      signal('private', privateChat ? 0.35 : 0, 'private chat intimacy'),
      signal('directed', directed ? 0.25 : 0, 'directed conversational opening'),
    ]),
    caution: buildFocalSet([
      signal('uncertainty', uncertainty, 'environment uncertainty'),
      signal('group', group ? 0.55 : 0, 'group chat caution'),
      signal('undirectedGroup', group && !directed ? 0.35 : 0, 'undirected group message'),
      signal('lowApi', Math.max(0, 0.35 - normalized.api), 'low aggregate pressure'),
    ]),
  };

  // Combine entity-level and signal-level relevance per voice
  const result = {} as Record<VoiceId, FocalSet>;
  for (const voice of ['diligence', 'curiosity', 'sociability', 'caution'] as VoiceId[]) {
    const voiceEntities = buildVoiceEntities(entityScores, voice);
    const signalSet = signalSets[voice];

    // Convert ScoredEntity to FocalEntity
    const focalEntities: FocalEntity[] = voiceEntities.map((e) => ({
      entityId: e.entityId,
      relevance: e.relevance,
      source: e.source,
      displayName: e.displayName,
    }));

    // meanRelevance: max of entity-weighted mean and signal mean
    const entityMean = focalEntities.length > 0
      ? focalEntities.reduce((s, e) => s + e.relevance, 0) / focalEntities.length
      : 0;
    const meanRelevance = Math.max(entityMean, signalSet.meanRelevance);

    // Build combined reasons
    const entityReasons = focalEntities.slice(0, 3).map(
      (e) => `${e.source}: ${e.displayName ?? e.entityId} (${e.relevance.toFixed(2)})`,
    );
    const reasons = [...entityReasons, ...signalSet.reasons].slice(0, 8);

    result[voice] = {
      signals: signalSet.signals,
      entities: focalEntities,
      meanRelevance,
      primarySignal: signalSet.primarySignal,
      primaryEntity: focalEntities[0]?.entityId ?? null,
      reasons,
    };
  }

  return result;
}

// ── Pressure signal normalization ──────────────────────────────────────────

export function normalizePressureSignals(pressure: AllPressures): Record<'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'pProspect' | 'api', number> {
  return {
    p1: squash(pressure.P1, 15),
    p2: squash(pressure.P2, 20),
    p3: squash(pressure.P3, 10),
    p4: squash(pressure.P4, 5),
    p5: squash(pressure.P5, 50),
    p6: squash(pressure.P6, 5),
    pProspect: squash(pressure.P_prospect, 3),
    api: squash(pressure.API, 5),
  };
}

export function computeUncertainty(context: VoiceFocusContext): number {
  const pressure = normalizePressureSignals(context.pressure);
  const values = [pressure.p1, pressure.p2, pressure.p3, pressure.p4, pressure.p5, pressure.p6, pressure.pProspect];
  const entropy = normalizedEntropy(values);
  const novelty = computeNovelty(context.world, context.channelId, context.senderId);
  const groupUncertainty = context.chatType === 'group' ? 0.25 : 0;
  const undirectedUncertainty = context.chatType === 'group' && !context.directed ? 0.25 : 0;
  return clamp01(entropy * 0.45 + novelty * 0.35 + groupUncertainty + undirectedUncertainty);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveDisplayName(world: WorldModel, entityId: string): string | undefined {
  if (!world.has(entityId)) return undefined;
  const nodeType = world.getNodeType(entityId);
  if (nodeType === 'contact') {
    const c = world.getContact(entityId);
    return c.remark ?? c.nickname ?? c.name ?? c.qq;
  }
  if (nodeType === 'channel') {
    const ch = world.getChannel(entityId);
    return ch.title ?? ch.group_name;
  }
  if (nodeType === 'thread') {
    const t = world.getThread(entityId);
    return t.summary?.slice(0, 60);
  }
  return undefined;
}

function buildFocalSet(signals: FocalSignal[]): FocalSet {
  const active = signals.filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  const selected = active.length > 0 ? active : signals;
  const meanRelevance = selected.length > 0 ? selected.reduce((sum, item) => sum + item.value, 0) / selected.length : 0;
  return {
    signals: selected,
    entities: [],
    meanRelevance,
    primarySignal: selected[0]?.name ?? null,
    primaryEntity: null,
    reasons: selected.filter((item) => item.value > 0).map((item) => `${item.name}: ${item.reason}`),
  };
}

function computeNovelty(world: WorldModel, channelId: string | undefined, senderId: string | undefined): number {
  const channelNovelty = channelId && world.has(channelId) && world.getNodeType(channelId) === 'channel'
    ? Math.exp(-(world.getChannel(channelId).contact_recv_window ?? 0) / 10)
    : 0.5;
  const contactNovelty = senderId && world.has(senderId) && world.getNodeType(senderId) === 'contact'
    ? Math.exp(-(world.getContact(senderId).interaction_count ?? 0) / 8)
    : 0.5;
  return clamp01(Math.max(channelNovelty, contactNovelty));
}

function signal(name: string, value: number, reason: string): FocalSignal {
  return { name, value: clamp01(value), reason };
}

function squash(value: number, kappa: number): number {
  return Math.tanh(Math.max(0, Number.isFinite(value) ? value : 0) / kappa);
}

function normalizedEntropy(values: readonly number[]): number {
  const sum = values.reduce((acc, value) => acc + Math.max(0, value), 0);
  if (sum <= 0) return 0;
  let entropy = 0;
  for (const value of values) {
    const p = Math.max(0, value) / sum;
    if (p > 0) entropy -= p * Math.log(p);
  }
  return entropy / Math.log(values.length);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
