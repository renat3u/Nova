

export type PressureDims = [number, number, number, number, number, number];

export function logSigmoid(silenceS: number, betaR: number, thetaS: number, tau0: number): number {
  const sLog = Math.log(1 + Math.max(0, silenceS) / tau0);
  const muC = Math.log(1 + Math.max(1, thetaS) / tau0);
  const exponent = -betaR * (sLog - muC);
  const clipped = Math.max(-50, Math.min(50, exponent));
  return 1 / (1 + Math.exp(clipped));
}

export function tanhNormalize(value: number, kappa: number): number {
  if (kappa <= 0) return 0;
  return Math.tanh(Math.max(0, value / kappa));
}

export function standardSigmoid(x: number): number {
  const clamped = Math.max(-50, Math.min(50, x));
  return 1 / (1 + Math.exp(-clamped));
}

export function decayFactor(age: number, halfLife: number): number {
  if (halfLife < 0) throw new Error(`decayFactor: halfLife must be >= 0, got ${halfLife}`);
  if (halfLife === 0) return age <= 0 ? 1 : 0;
  return 1 / (1 + Math.max(0, age) / halfLife);
}
