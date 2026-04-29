// Alice baseline reference: personality/voices model adapted for Nova QQ runtime.

import type { AllPressures } from '../pressure/aggregate';
import type { WorldModel } from '../world/model';
import { computeFocalSets, computeUncertainty, type FocalSet } from './focus';
import { getPersonalityWeight, VOICES, type PersonalityVector, type VoiceId } from './personality';

export interface VoiceFatigueState {
  recent: VoiceId[];
  maxRecent: number;
}

export interface LoudnessContext {
  world: WorldModel;
  pressure: AllPressures;
  personality: PersonalityVector;
  channelId?: string;
  senderId?: string;
  chatType?: 'private' | 'group';
  directed?: boolean;
  nowMs: number;
  fatigueState?: VoiceFatigueState;
  noise?: Partial<Record<VoiceId, number>>;
}

export interface LoudnessResult {
  loudness: Record<VoiceId, number>;
  focalSets: Record<VoiceId, FocalSet>;
  fatigue: Record<VoiceId, number>;
  uncertainty: number;
  mood: Record<VoiceId, number>;
  context: Record<VoiceId, number>;
}

const EPSILON: Record<VoiceId, number> = {
  diligence: 0.015,
  curiosity: 0.015,
  sociability: 0.015,
  caution: 0.015,
};

export function computeLoudness(context: LoudnessContext): LoudnessResult {
  const focusContext = {
    world: context.world,
    pressure: context.pressure,
    channelId: context.channelId,
    senderId: context.senderId,
    chatType: context.chatType,
    directed: context.directed,
    nowMs: context.nowMs,
  };
  const focalSets = computeFocalSets(focusContext);
  const uncertainty = computeUncertainty(focusContext);
  const fatigue = computeFatigue(context.fatigueState);
  const mood = computeMoodModulation(context.chatType, context.directed, uncertainty);
  const contextModulation = computeContextModulation(context.chatType, context.directed);
  const loudness = {} as Record<VoiceId, number>;

  for (const voice of VOICES.map((item) => item.id)) {
    const pi = getPersonalityWeight(context.personality, voice);
    const relevance = focalSets[voice].meanRelevance;
    const epsilon = context.noise?.[voice] ?? EPSILON[voice];
    loudness[voice] = Math.max(0, pi * relevance * contextModulation[voice] * mood[voice] * fatigue[voice] + epsilon);
  }

  return { loudness, focalSets, fatigue, uncertainty, mood, context: contextModulation };
}

export function computeFatigue(state: VoiceFatigueState | undefined): Record<VoiceId, number> {
  const result: Record<VoiceId, number> = {
    diligence: 1,
    curiosity: 1,
    sociability: 1,
    caution: 1,
  };
  if (!state || state.recent.length === 0) return result;

  const window = Math.max(1, state.maxRecent);
  for (const voice of state.recent.slice(-window)) {
    result[voice] *= 0.88;
  }
  return result;
}

export function rememberSelectedVoice(state: VoiceFatigueState, voice: VoiceId): void {
  state.recent.push(voice);
  const keep = Math.max(1, state.maxRecent);
  if (state.recent.length > keep) state.recent.splice(0, state.recent.length - keep);
}

function computeMoodModulation(chatType: 'private' | 'group' | undefined, directed: boolean | undefined, uncertainty: number): Record<VoiceId, number> {
  const sociabilityMood = chatType === 'private' ? 1.18 : directed ? 1.08 : 0.92;
  const cautionMood = 1 + uncertainty * 0.45 + (chatType === 'group' ? 0.18 : 0) - (directed ? 0.08 : 0);
  return {
    diligence: directed ? 1.12 : 1,
    curiosity: 1 + Math.max(0, uncertainty - 0.35) * 0.12,
    sociability: Math.max(0.75, sociabilityMood),
    caution: Math.max(0.85, cautionMood),
  };
}

function computeContextModulation(chatType: 'private' | 'group' | undefined, directed: boolean | undefined): Record<VoiceId, number> {
  const group = chatType === 'group';
  const privateChat = chatType === 'private';
  return {
    diligence: directed ? 1.22 : 0.95,
    curiosity: group && !directed ? 0.95 : 1,
    sociability: privateChat ? 1.22 : directed ? 1.08 : 0.86,
    caution: group ? (directed ? 1.2 : 1.45) : 0.95,
  };
}
