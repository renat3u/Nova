

import { DEFAULT_KAPPA } from '../world/constants';
import type { WorldModel } from '../world/model';
import type { PressureDims } from '../utils/math';
import { tanhNormalize } from '../utils/math';
import { pProspect } from './p-prospect';
import { p1AttentionDebt } from './p1-attention';
import { p2InformationPressure } from './p2-information';
import { p3RelationshipCooling } from './p3-relationship';
import { p4ThreadDivergence } from './p4-thread';
import { p5ResponseObligation } from './p5-response';
import { p6Curiosity } from './p6-curiosity';
import { propagatePressuresMatrix, type PropagationConfig } from './propagation';

export interface PressureSnapshot {
  tick: number;
  createdMs: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  p5: number;
  p6: number;
  pProspect: number;
  api: number;
  apiPeak: number;
  contributions: Record<string, unknown>;
}

export interface AllPressures {
  P1: number;
  P2: number;
  P3: number;
  P4: number;
  P5: number;
  P6: number;
  P_prospect: number;
  API: number;
  API_peak: number;
  A: number;
  contributions: Record<string, Record<string, number>>;
  prospectContributions: Record<string, number>;
  pressureHistory: Record<'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6', number[]>;
}

export class AdaptiveKappa {
  private ema: PressureDims;
  private readonly kappaMin: PressureDims;
  private readonly halfLifeS: number;

  constructor(kappaMin: PressureDims, halfLifeS = 1500) {
    this.kappaMin = [...kappaMin] as PressureDims;
    this.ema = [...kappaMin] as PressureDims;
    this.halfLifeS = halfLifeS;
  }

  update(pressures: PressureDims, dtS = 60): PressureDims {
    const alpha = 1 - Math.exp((-Math.max(1, dtS) * Math.LN2) / this.halfLifeS);
    this.ema = this.ema.map((value, index) => (
      alpha * Math.abs(pressures[index] ?? 0) + (1 - alpha) * value
    )) as PressureDims;
    return this.current();
  }

  current(): PressureDims {
    return this.ema.map((value, index) => Math.max(this.kappaMin[index] ?? 0, value)) as PressureDims;
  }
}

export const PRESSURE_HISTORY_SIZE = 10;

export type PressureHistory = PressureDims[];

export function createPressureHistory(): PressureHistory {
  return [];
}

export function apiAggregate(p1: number, p2: number, p3: number, p4: number, p5: number, p6: number, kappa: PressureDims = DEFAULT_KAPPA): number {
  const values: PressureDims = [p1, p2, p3, p4, p5, p6];
  return values.reduce((sum, value, index) => sum + tanhNormalize(value, kappa[index] ?? 1), 0);
}

export function apiPeak(contributionSources: Record<string, number>[], kappa: PressureDims = DEFAULT_KAPPA): number {
  let total = 0;
  for (let i = 0; i < contributionSources.length && i < 6; i++) {
    const maxValue = Math.max(0, ...Object.values(contributionSources[i] ?? {}));
    total += tanhNormalize(maxValue, kappa[i] ?? 1);
  }
  return total;
}

export function observableMapping(api: number, aMax = 10, kappa = 20): number {
  return aMax * Math.tanh(api / kappa);
}

export function computeAllPressures(
  world: WorldModel,
  tick: number,
  options: {
    kappa?: PressureDims;
    threadAgeScale?: number;
    mu?: number;
    d?: number;
    kSteepness?: number;
    kappaProspect?: number;
    history?: PressureHistory;
    nowMs?: number;
    eta?: number;
    rho?: number;
    propagationConfig?: PropagationConfig;
    tickDt?: number;
  } = {},
): AllPressures {
  const {
    kappa = DEFAULT_KAPPA,
    threadAgeScale = 86400,
    mu = 0.3,
    d = -0.5,
    kSteepness = 5,
    kappaProspect = 3,
    history,
    nowMs = Date.now(),
    eta = 0.6,
    rho = 0.2,
    propagationConfig,
    tickDt,
  } = options;

  const r1 = p1AttentionDebt(world, nowMs);
  const r2 = p2InformationPressure(world, tick, nowMs, d);
  const r3 = p3RelationshipCooling(world, tick, nowMs, undefined, tickDt);
  const r4 = p4ThreadDivergence(world, tick, nowMs, threadAgeScale);
  const r5 = p5ResponseObligation(world, tick, nowMs);
  const r6 = p6Curiosity(world, nowMs, eta);
  const rProspect = pProspect(world, tick, nowMs, kSteepness);

  const rawTotals: PressureDims = [r1.total, r2.total, r3.total, r4.total, r5.total, r6.total];
  const smoothingRatios = [1, 1, 1, 1, 1, 1];
  if (rho > 0 && history && history.length > 0) {
    const last = history.slice(-2);
    const means = [0, 0, 0, 0, 0, 0];
    for (const entry of last) for (let i = 0; i < 6; i++) means[i] = (means[i] ?? 0) + (entry[i] ?? 0);
    for (let i = 0; i < 6; i++) {
      const mean = (means[i] ?? 0) / last.length;
      const rawTotal = rawTotals[i] ?? 0;
      const smoothed = (1 - rho) * rawTotal + rho * mean;
      smoothingRatios[i] = rawTotal > 1e-15 ? Math.max(0.1, Math.min(10, smoothed / rawTotal)) : 1;
    }
  }

  const contributionSources: Array<Record<string, number>> = [r1.contributions, r2.contributions, r3.contributions, r4.contributions, r5.contributions, r6.contributions];
  const localAll: Record<string, number> = {};
  for (let dim = 0; dim < contributionSources.length; dim++) {
    const source = contributionSources[dim] ?? {};
    for (const [id, value] of Object.entries(source)) {
      localAll[id] = (localAll[id] ?? 0) + value * (smoothingRatios[dim] ?? 1);
    }
  }
  const propagated = propagatePressuresMatrix(world, localAll, mu, nowMs, propagationConfig);

  const effContributions: Record<string, Record<string, number>> = { P1: {}, P2: {}, P3: {}, P4: {}, P5: {}, P6: {} };
  const labels = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const;
  for (let dim = 0; dim < labels.length; dim++) {
    const label = labels[dim];
    if (label === undefined) continue;
    for (const [id, localValue] of Object.entries(contributionSources[dim] ?? {})) {
      const localTotal = localAll[id] ?? 0;
      const effectiveTotal = propagated[id] ?? localTotal;
      const target = effContributions[label];
      if (target === undefined) continue;
      target[id] = localTotal > 1e-10 ? localValue * (effectiveTotal / localTotal) : localValue;
    }
  }

  const apiBase = apiAggregate(r1.total, r2.total, r3.total, r4.total, r5.total, r6.total, kappa);
  const prospectTerm = tanhNormalize(rProspect.total, kappaProspect);
  const api = apiBase + prospectTerm;
  const peak = apiPeak(contributionSources, kappa) + prospectTerm;

  const buffer = history ?? [];
  const historyByDim = {
    P1: buffer.map((entry) => entry[0]),
    P2: buffer.map((entry) => entry[1]),
    P3: buffer.map((entry) => entry[2]),
    P4: buffer.map((entry) => entry[3]),
    P5: buffer.map((entry) => entry[4]),
    P6: buffer.map((entry) => entry[5]),
  };
  if (history) {
    history.push(rawTotals);
    if (history.length > PRESSURE_HISTORY_SIZE) history.shift();
  }

  return {
    P1: r1.total,
    P2: r2.total,
    P3: r3.total,
    P4: r4.total,
    P5: r5.total,
    P6: r6.total,
    P_prospect: rProspect.total,
    API: api,
    API_peak: peak,
    A: observableMapping(api),
    contributions: effContributions,
    prospectContributions: rProspect.contributions,
    pressureHistory: historyByDim,
  };
}

export function toPressureSnapshot(result: AllPressures, tick: number, createdMs: number): PressureSnapshot {
  return {
    tick,
    createdMs,
    p1: result.P1,
    p2: result.P2,
    p3: result.P3,
    p4: result.P4,
    p5: result.P5,
    p6: result.P6,
    pProspect: result.P_prospect,
    api: result.API,
    apiPeak: result.API_peak,
    contributions: {
      ...result.contributions,
      P_prospect: result.prospectContributions,
      pressureHistory: result.pressureHistory,
    },
  };
}
