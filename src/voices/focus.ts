// Alice baseline reference: personality/voices model adapted for Nova QQ runtime.

import type { AllPressures } from '../pressure/aggregate';
import type { WorldModel } from '../world/model';
import type { VoiceId } from './personality';

export interface FocalSignal {
  name: string;
  value: number;
  reason: string;
}

export interface FocalSet {
  signals: FocalSignal[];
  meanRelevance: number;
  primarySignal: string | null;
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

export function computeFocalSets(context: VoiceFocusContext): Record<VoiceId, FocalSet> {
  const normalized = normalizePressureSignals(context.pressure);
  const novelty = computeNovelty(context.world, context.channelId, context.senderId);
  const group = context.chatType === 'group';
  const privateChat = context.chatType === 'private';
  const directed = context.directed === true;
  const uncertainty = computeUncertainty(context);

  return {
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
}

export function normalizePressureSignals(pressure: AllPressures): Record<'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'pProspect' | 'api', number> {
  return {
    p1: squash(pressure.P1, 5),
    p2: squash(pressure.P2, 8),
    p3: squash(pressure.P3, 8),
    p4: squash(pressure.P4, 5),
    p5: squash(pressure.P5, 3),
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

function buildFocalSet(signals: FocalSignal[]): FocalSet {
  const active = signals.filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  const selected = active.length > 0 ? active : signals;
  const meanRelevance = selected.length > 0 ? selected.reduce((sum, item) => sum + item.value, 0) / selected.length : 0;
  return {
    signals: selected,
    meanRelevance,
    primarySignal: selected[0]?.name ?? null,
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
