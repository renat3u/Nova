
//

// and runtime/src/config.ts drift parameters.

import { DEFAULT_PERSONALITY_VECTOR, projectPersonalityVector, type PersonalityVector, type VoiceId } from './vector';

export interface PersonalityDriftOptions {

  enabled: boolean;

  homeRegression: number;

  learningRate: number;
}

export interface PersonalityFeedback {
  voice: VoiceId;
  delta: number;
}

export const DEFAULT_PERSONALITY_DRIFT_OPTIONS: PersonalityDriftOptions = {
  enabled: true,
  home: DEFAULT_PERSONALITY_VECTOR,
  homeRegression: 0.002,
  learningRate: 0.0001,
};

export function l2Distance(a: PersonalityVector, b: PersonalityVector): number {
  let sumSq = 0;
  for (const voice of ['diligence', 'curiosity', 'sociability', 'caution'] as const) {
    const diff = a[voice] - b[voice];
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
