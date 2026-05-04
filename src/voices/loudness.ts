//
//
//   L_v = π_v × meanRelevance × φ_v(fatigue) × ψ_v(mood) + ε_v
//
// Where:
//   π_v   = personality weight
//   φ_v   = wall-clock voice fatigue: min(1, elapsedS / K_v), K_v = 300s
//   ψ_v   = mood modulation: sociability = 1 + 0.3·mood, caution = 1 - 0.3·mood
//   ε_v   = Gaussian(0, 0.1) — Box-Muller noise for stochastic exploration

import type { AllPressures } from '../pressure/aggregate';
import type { WorldModel } from '../world/model';
import { computeFocalSets, computeUncertainty, type FocalSet } from './focus';
import { getPersonalityWeight, VOICES, type PersonalityVector, type VoiceId } from './personality';

// ── Types ──────────────────────────────────────────────────────────────────

export interface VoiceFatigueState {
  recent: Array<{ voice: VoiceId; ms: number }>;
  maxRecent: number;
  voiceLastWonMs: Record<VoiceId, number>;
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
  fatigueState: VoiceFatigueState;
  selfMood?: number;
  noiseOverride?: number[];
}

export interface LoudnessResult {
  loudness: Record<VoiceId, number>;
  focalSets: Record<VoiceId, FocalSet>;
  fatigue: Record<VoiceId, number>;
  uncertainty: number;
  moodPsi: Record<VoiceId, number>;
}

const VOICE_COOLDOWN_S = 300;

export function computeFatigue(
  state: VoiceFatigueState | undefined,
  nowMs: number,
  cooldownS: number = VOICE_COOLDOWN_S,
): Record<VoiceId, number> {
  const result: Record<VoiceId, number> = {
    diligence: 1,
    curiosity: 1,
    sociability: 1,
    caution: 1,
  };
  if (!state) return result;

  for (const voice of VOICES.map((v) => v.id)) {
    const lastWon = state.voiceLastWonMs[voice];
    if (lastWon === -Infinity || lastWon === undefined) {
      result[voice] = 1; // never won, no fatigue
    } else {
      const elapsedS = (nowMs - lastWon) / 1000;
      result[voice] = Math.min(1, Math.max(0, elapsedS / cooldownS));
    }
  }
  return result;
}

/** Record that a voice won at this moment (starts fatigue ramp). */
export function recordVoiceWin(state: VoiceFatigueState, voice: VoiceId, nowMs: number): void {
  state.voiceLastWonMs[voice] = nowMs;
}

/** Remember selected voice in fatigue state (for recent tracking). */
export function rememberSelectedVoice(state: VoiceFatigueState, voice: VoiceId): void {
  state.recent.push({ voice, ms: Date.now() });
  if (state.recent.length > state.maxRecent) {
    state.recent.shift();
  }
}

const MOOD_DELTA = 0.3;

function computeMoodPsi(selfMood: number): Record<VoiceId, number> {
  return {
    diligence: 1.0,
    curiosity: 1.0,
    sociability: 1 + MOOD_DELTA * selfMood,
    caution: 1 - MOOD_DELTA * selfMood,
  };
}

// ── Gaussian noise (Box-Muller) ────────────────────────────────────────────

function gaussianRandom(): number {
  const u1 = Math.max(1e-10, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── Main loudness computation ──────────────────────────────────────────────

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
  const fatigue = computeFatigue(context.fatigueState, context.nowMs);
  const selfMood = context.selfMood ?? 0;
  const psi = computeMoodPsi(selfMood);
  const loudness = {} as Record<VoiceId, number>;

  for (const voice of VOICES.map((v) => v.id)) {
    const pi = getPersonalityWeight(context.personality, voice);
    const relevance = focalSets[voice].meanRelevance;
    const phi = fatigue[voice] ?? 1;

    // ε_v ~ Gaussian(0, 0.1), with explicit override for test determinism
    const epsilon = context.noiseOverride
      ? (context.noiseOverride[VOICES.find((v) => v.id === voice)?.index ?? 0] ?? 0)
      : gaussianRandom() * 0.1;

    loudness[voice] = Math.max(0, pi * relevance * phi * psi[voice] + epsilon);
  }

  return { loudness, focalSets, fatigue, uncertainty, moodPsi: psi };
}
