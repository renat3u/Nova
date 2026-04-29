// Alice baseline reference: pressure model adapted for Nova QQ runtime.

import type { DunbarTier } from '../world/entities';

export interface HawkesParams {
  readonly mu: number;
  readonly alpha: number;
  readonly beta: number;
}

export interface HawkesState {
  lambdaCarry: number;
  lastEventMs: number;
}

export interface HawkesIntensity {
  lambda: number;
  mu: number;
  excitation: number;
  normalizedHeat: number;
}

const HAWKES_TIER_DEFAULTS: Record<DunbarTier, HawkesParams> = {
  5: { mu: 5.6e-4, alpha: 0.003, beta: 3.3e-3 },
  15: { mu: 2.8e-4, alpha: 0.002, beta: 2.8e-3 },
  50: { mu: 9.3e-5, alpha: 0.001, beta: 1.1e-3 },
  150: { mu: 2.3e-5, alpha: 0.0005, beta: 8.3e-4 },
  500: { mu: 5.8e-6, alpha: 0.0002, beta: 5.6e-4 },
};

export function getDefaultParams(tier: DunbarTier, isGroup = false): HawkesParams {
  const base = HAWKES_TIER_DEFAULTS[tier] ?? HAWKES_TIER_DEFAULTS[50];
  if (!isGroup) return base;
  return { mu: base.mu, alpha: base.alpha * 0.3, beta: base.beta * 1.5 };
}

export function queryIntensity(params: HawkesParams, state: HawkesState, nowMs: number): HawkesIntensity {
  if (state.lastEventMs <= 0 || state.lambdaCarry <= 0) {
    return { lambda: params.mu, mu: params.mu, excitation: 0, normalizedHeat: 0 };
  }

  const dtS = Math.max(0, (nowMs - state.lastEventMs) / 1000);
  const excitation = state.lambdaCarry * Math.exp(-params.beta * dtS);
  const lambda = params.mu + excitation;
  const branchRatio = params.beta > 0 ? params.alpha / params.beta : 0;
  const theoreticalMax = branchRatio < 1 && params.beta > params.alpha
    ? (params.alpha * params.beta) / (params.beta - params.alpha)
    : params.alpha;
  const normalizedHeat = Math.min(1, theoreticalMax > 0 ? excitation / theoreticalMax : 0);
  return { lambda, mu: params.mu, excitation, normalizedHeat };
}
