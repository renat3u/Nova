// Alice baseline reference: personality/voices model adapted for Nova QQ runtime.

import { DEFAULT_PERSONALITY_VECTOR, projectPersonalityVector, type PersonalityVector, type VoiceId } from './vector';

export interface PersonalityDriftOptions {
  enabled: boolean;
  home: PersonalityVector;
  homeRegression: number;
}

export interface PersonalityFeedback {
  voice: VoiceId;
  delta: number;
}

export const DEFAULT_PERSONALITY_DRIFT_OPTIONS: PersonalityDriftOptions = {
  enabled: false,
  home: DEFAULT_PERSONALITY_VECTOR,
  homeRegression: 0.02,
};

export function evolvePersonality(
  current: PersonalityVector,
  feedbacks: readonly PersonalityFeedback[],
  options: PersonalityDriftOptions = DEFAULT_PERSONALITY_DRIFT_OPTIONS,
): PersonalityVector {
  const projectedCurrent = projectPersonalityVector(current);
  if (!options.enabled) return projectedCurrent;

  const next: PersonalityVector = { ...projectedCurrent };
  for (const feedback of feedbacks) {
    next[feedback.voice] += feedback.delta;
  }

  const home = projectPersonalityVector(options.home);
  const gamma = clamp01(options.homeRegression);
  for (const voice of ['diligence', 'curiosity', 'sociability', 'caution'] as const) {
    next[voice] -= gamma * (next[voice] - home[voice]);
  }

  return projectPersonalityVector(next);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
