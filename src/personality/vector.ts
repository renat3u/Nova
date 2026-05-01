

export const VOICES = [
  { id: 'diligence', short: 'D', display: 'Diligence', index: 0 },
  { id: 'curiosity', short: 'C', display: 'Curiosity', index: 1 },
  { id: 'sociability', short: 'S', display: 'Sociability', index: 2 },
  { id: 'caution', short: 'X', display: 'Caution', index: 3 },
] as const;

export type VoiceId = (typeof VOICES)[number]['id'];
export type VoiceWeights = [number, number, number, number];

export const VOICE_COUNT = VOICES.length;
export const PERSONALITY_MIN = 0.05;
export const PERSONALITY_MAX = 0.5;
export const DEFAULT_PERSONALITY_VECTOR: PersonalityVector = Object.freeze({
  diligence: 0.25,
  curiosity: 0.25,
  sociability: 0.25,
  caution: 0.25,
});

export interface PersonalityVector {
  diligence: number;
  curiosity: number;
  sociability: number;
  caution: number;
}

export const VOICE_INDEX: Record<VoiceId, number> = {
  diligence: 0,
  curiosity: 1,
  sociability: 2,
  caution: 3,
};

export const VOICE_BY_INDEX: Record<number, VoiceId> = {
  0: 'diligence',
  1: 'curiosity',
  2: 'sociability',
  3: 'caution',
};

export const IAUS_ACTIONS: readonly VoiceId[] = ['diligence', 'curiosity', 'sociability'] as const;
export type IAUSAction = (typeof IAUS_ACTIONS)[number];

/** Map a selected voice to its IAUS action. Returns null for caution. */
export function voiceToIAUSAction(voice: VoiceId): IAUSAction | null {
  return (IAUS_ACTIONS as readonly string[]).includes(voice) ? voice as IAUSAction : null;
}

export function personalityToWeights(vector: PersonalityVector): VoiceWeights {
  return [vector.diligence, vector.curiosity, vector.sociability, vector.caution];
}

export function weightsToPersonality(weights: readonly number[]): PersonalityVector {
  return {
    diligence: weights[0] ?? 0.25,
    curiosity: weights[1] ?? 0.25,
    sociability: weights[2] ?? 0.25,
    caution: weights[3] ?? 0.25,
  };
}

export function getPersonalityWeight(vector: PersonalityVector, voice: VoiceId): number {
  return vector[voice];
}

export function projectPersonalityVector(input: Partial<PersonalityVector> | readonly number[] | null | undefined): PersonalityVector {
  let raw: Array<number | undefined>;
  if (Array.isArray(input)) {
    raw = [input[0], input[1], input[2], input[3]];
  } else {
    const vector = input as Partial<PersonalityVector> | null | undefined;
    raw = [vector?.diligence, vector?.curiosity, vector?.sociability, vector?.caution];
  }

  const cleaned = raw.map((value) => (Number.isFinite(value) && value !== undefined ? Math.max(0, Number(value)) : 0));
  const projected = projectBoundedSimplex(cleaned, PERSONALITY_MIN, PERSONALITY_MAX);
  return weightsToPersonality(projected);
}

export function serializePersonality(vector: PersonalityVector): VoiceWeights {
  const projected = projectPersonalityVector(vector);
  return personalityToWeights(projected);
}

function projectBoundedSimplex(values: number[], min: number, max: number): VoiceWeights {
  let current = values.length === VOICE_COUNT ? [...values] : values.slice(0, VOICE_COUNT);
  while (current.length < VOICE_COUNT) current.push(0);

  const rawSum = current.reduce((sum, value) => sum + value, 0);
  if (rawSum <= 0) current = Array.from({ length: VOICE_COUNT }, () => 1 / VOICE_COUNT);
  else current = current.map((value) => value / rawSum);

  const fixed = new Array<boolean>(VOICE_COUNT).fill(false);
  for (let iter = 0; iter < VOICE_COUNT * 2; iter++) {
    let fixedSum = 0;
    let freeSum = 0;
    let freeCount = 0;

    for (let i = 0; i < VOICE_COUNT; i++) {
      const value = current[i] ?? 0;
      if (value < min) {
        current[i] = min;
        fixed[i] = true;
      } else if (value > max) {
        current[i] = max;
        fixed[i] = true;
      }
    }

    for (let i = 0; i < VOICE_COUNT; i++) {
      const value = current[i] ?? 0;
      if (fixed[i]) fixedSum += value;
      else {
        freeSum += value;
        freeCount += 1;
      }
    }

    if (freeCount === 0) break;
    const remaining = Math.max(0, 1 - fixedSum);
    if (freeSum <= 0) {
      const fill = remaining / freeCount;
      for (let i = 0; i < VOICE_COUNT; i++) if (!fixed[i]) current[i] = fill;
    } else {
      for (let i = 0; i < VOICE_COUNT; i++) {
        if (!fixed[i]) current[i] = ((current[i] ?? 0) / freeSum) * remaining;
      }
    }

    const allWithinBounds = current.every((value) => value >= min - 1e-10 && value <= max + 1e-10);
    if (allWithinBounds) break;
  }

  current = current.map((value) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)));
  const sum = current.reduce((acc, value) => acc + value, 0);
  if (sum > 0) current = current.map((value) => value / sum);

  return [current[0] ?? 0.25, current[1] ?? 0.25, current[2] ?? 0.25, current[3] ?? 0.25];
}
