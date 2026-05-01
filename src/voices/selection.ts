

import { VOICE_BY_INDEX, VOICES, voiceToIAUSAction, type IAUSAction, type VoiceId } from './personality';

export interface VoiceSelectionOptions {
  deterministic?: boolean;
  random?: number;
}

export interface VoiceSelectionResult {
  /** The winning voice id (diligence / curiosity / sociability / caution). */
  selected: VoiceId;
  /** Raw loudness values per voice before softmax. */
  loudness: Record<VoiceId, number>;
  /** Softmax probability per voice. */
  probabilities: Record<VoiceId, number>;
  /** Adaptive temperature used for softmax. */
  temperature: number;
  /** Fatigue multiplier per voice. */
  fatigue: Record<VoiceId, number>;
  /** Human-readable reasons for the focal signals. */
  reasons: string[];
  /**
   * The IAUS action derived from the selected voice.
   * Null when the selected voice is caution — caution never produces
   * a standalone proactive action; it only influences gates / silence / prompt restraint.
   */
  iausAction: IAUSAction | null;
}

export type { IAUSAction };

export function selectVoice(
  loudness: Record<VoiceId, number>,
  fatigue: Record<VoiceId, number>,
  reasons: readonly string[],
  options: VoiceSelectionOptions = {},
): VoiceSelectionResult {
  const values = VOICES.map((voice) => loudness[voice.id] ?? 0);
  const temperature = adaptiveTemperature(values);
  const probabilityValues = softmax(values, temperature);
  const probabilities = {} as Record<VoiceId, number>;
  for (const voice of VOICES) probabilities[voice.id] = probabilityValues[voice.index] ?? 0;

  const selected = options.deterministic === true
    ? selectMaxProbability(probabilityValues)
    : sampleProbability(probabilityValues, options.random ?? Math.random());

  return {
    selected,
    loudness,
    probabilities,
    temperature,
    fatigue,
    reasons: [...reasons],
    iausAction: voiceToIAUSAction(selected),
  };
}

export function adaptiveTemperature(loudness: readonly number[]): number {
  return 0.1 + 0.3 / (1 + standardDeviation(loudness) * 10);
}

function softmax(values: readonly number[], temperature: number): number[] {
  if (values.length === 0) return [];
  const tau = Math.max(1e-6, temperature);
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(Math.max(-50, Math.min(0, (value - max) / tau))));
  const sum = exps.reduce((acc, value) => acc + value, 0);
  return sum > 0 ? exps.map((value) => value / sum) : values.map(() => 1 / values.length);
}

function selectMaxProbability(probabilities: readonly number[]): VoiceId {
  let bestIndex = 0;
  let bestValue = -Infinity;
  for (let i = 0; i < probabilities.length; i++) {
    const value = probabilities[i] ?? 0;
    if (value > bestValue) {
      bestValue = value;
      bestIndex = i;
    }
  }
  return VOICE_BY_INDEX[bestIndex] ?? 'diligence';
}

function sampleProbability(probabilities: readonly number[], random: number): VoiceId {
  const r = Math.max(0, Math.min(0.999999, random));
  let cumulative = 0;
  for (let i = 0; i < probabilities.length; i++) {
    cumulative += probabilities[i] ?? 0;
    if (r < cumulative) return VOICE_BY_INDEX[i] ?? 'diligence';
  }
  return VOICE_BY_INDEX[probabilities.length - 1] ?? 'caution';
}

function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
