
// Ported from runtime/src/pressure/social-value.ts
//
// V(a, n) = ΔP(a, n) - λ · C_social(a, n)
//
// An action must have V > 0 to execute, otherwise silence (Axiom 4).
// λ ≥ 1 ensures the cost of a social misstep exceeds the equivalent pressure relief.
//
// Adapted for Nova QQ runtime.

import { PRESSURE_SPECS } from '../world/constants';
import type { PressureDims } from '../utils/math';

/** P1-P6 dimension names derived from PRESSURE_SPECS, aligned with kappa indices. */
const STD_DIMS = Object.keys(PRESSURE_SPECS) as (keyof typeof PRESSURE_SPECS)[];

/** Observation noise variance for Kalman information ratio (VoI). */
export const SIGMA2_OBS = 0.1;

/**
 * Estimate expected pressure relief ΔP(a, n) from executing an action
 * against target entity n.
 *
 * When kappa is provided, each dimension's contribution is tanh-normalised
 * to [0, 1) before summation, preventing a single dimension from dominating ΔP.
 * Example: P4 thread pressure can reach 400+ while P6 is ~0.1 — without
 * normalisation P4 would completely dominate.
 *
 * @param contributions — per-dimension entity contributions { P1: { entityId: value }, ... }
 * @param targetId       — target entity id
 * @param kappa          — API normalisation κ (optional; when provided, applies tanh normalisation)
 * @returns expected pressure relief (≥ 0)
 */
export function estimateDeltaP(
  contributions: Record<string, Record<string, number>>,
  targetId: string,
  kappa?: PressureDims,
): number {
  let total = 0;

  // Standard dimensions P1-P6: optional tanh normalisation.
  for (let i = 0; i < STD_DIMS.length; i++) {
    const dimKey = STD_DIMS[i];
    if (!dimKey) continue;
    const dimContribs = contributions[dimKey];
    if (!dimContribs) continue;
    const raw = dimContribs[targetId] ?? 0;
    total += kappa ? Math.tanh(raw / (kappa[i] ?? 1)) : raw;
  }

  // Non-standard dimensions (P_prospect, etc.): add directly.
  for (const [dim, dimContribs] of Object.entries(contributions)) {
    if ((STD_DIMS as readonly string[]).includes(dim)) continue;
    total += dimContribs[targetId] ?? 0;
  }

  // ΔP should never be negative (an action won't increase pressure).
  return Math.max(0, total);
}

/**
 * Compute Net Social Value.
 *
 * V(a, n) = ΔP - λ · C_social
 *
 * @param deltaP     — expected pressure relief
 * @param socialCost — social cost of the action
 * @param lambda     — loss-aversion coefficient (≥ 1)
 * @returns Net Social Value (can be positive or negative)
 */
export function computeNetSocialValue(
  deltaP: number,
  socialCost: number,
  lambda: number,
): number {
  return deltaP - lambda * socialCost;
}

/**
 * Compute Value of Information (VoI) — Kalman information ratio.
 *
 * VoI = σ² / (σ² + σ²_obs)
 *
 * σ² large → VoI ≈ 1 (high uncertainty → action yields large information gain)
 * σ² small → VoI ≈ 0 (already certain → action yields negligible information gain)
 *
 * @param sigma2    — current belief variance
 * @param sigma2Obs — observation noise variance (constant, controls convergence rate)
 * @returns VoI value ∈ [0, 1)
 */
export function computeVoI(sigma2: number, sigma2Obs: number = SIGMA2_OBS): number {
  return sigma2 / (sigma2 + sigma2Obs);
}

/**
 * Compute Net Social Value with uncertainty penalty + VoI information gain.
 *
 * NSV(a, n) = ΔP - λ·C_social - β·H(bel) + γ·VoI(a, n)
 *
 * The β·H term treats uncertainty as a penalty (conservative);
 * the γ·VoI term treats uncertainty as an exploration reward.
 * Together they form an Active Inference-style Expected Free Energy approximation.
 *
 * @param deltaP         — expected pressure relief
 * @param socialCost     — social cost of the action
 * @param lambda         — loss-aversion coefficient (≥ 1)
 * @param beliefEntropy  — Shannon entropy of target belief H(bel)
 * @param beta           — uncertainty penalty coefficient (≥ 0)
 * @param gamma          — VoI information gain coefficient (≥ 0)
 * @param voiValue       — VoI information gain value (Kalman information ratio, [0, 1))
 * @returns NSV value (can be positive or negative)
 */
export function computeNSVBeta(
  deltaP: number,
  socialCost: number,
  lambda: number,
  beliefEntropy: number,
  beta: number,
  gamma: number,
  voiValue: number,
): number {
  return deltaP - lambda * socialCost - beta * beliefEntropy + gamma * voiValue;
}
