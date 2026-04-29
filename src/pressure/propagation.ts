// Alice baseline reference: pressure model adapted for Nova QQ runtime.

import { PROPAGATION_WEIGHT } from '../world/constants';
import type { WorldModel } from '../world/model';
import { decayFactor } from '../utils/math';
import { elapsedS, readNodeMs } from './clock';

export interface PropagationConfig {
  susceptibility?: Record<string, number>;
  K?: number;
  alpha?: number;
}

export interface SparseMatrix {
  n: number;
  rowPtr: number[];
  colIdx: number[];
  values: number[];
}

const DEFAULT_SUSCEPTIBILITY: Record<string, number> = {
  agent: 0,
  contact: 1,
  channel: 0.6,
  group_channel: 0.3,
  message: 0.2,
  fact: 0.4,
  thread: 0.7,
  conversation: 0.5,
};

export function buildWeightedAdjacency(world: WorldModel, nowMs = 0): { matrix: SparseMatrix; entityIndex: Map<string, number> } {
  const allIds = world.allNodeIds();
  const entityIndex = new Map<string, number>();
  allIds.forEach((id, index) => entityIndex.set(id, index));

  const triplets: Array<{ row: number; col: number; value: number }> = [];
  for (const edge of world.allEdges()) {
    const idxU = entityIndex.get(edge.src);
    const idxV = entityIndex.get(edge.dst);
    if (idxU === undefined || idxV === undefined) continue;

    const omega = (PROPAGATION_WEIGHT[edge.category] ?? 0.5) * edge.weight;
    let addressedFactor = 1;
    if (nowMs > 0) {
      for (const nodeId of [edge.src, edge.dst]) {
        const lastActionMs = readNodeMs(world, nodeId, 'last_nova_action_ms');
        if (lastActionMs > 0) {
          const alpha = decayFactor(elapsedS(nowMs, lastActionMs), 600);
          addressedFactor = Math.min(addressedFactor, 1 - alpha);
        }
      }
    }

    const value = omega * addressedFactor;
    if (Math.abs(value) > 1e-15) triplets.push({ row: idxV, col: idxU, value });
  }

  triplets.sort((a, b) => a.row - b.row || a.col - b.col);
  const rowPtr = new Array<number>(allIds.length + 1).fill(0);
  const colIdx: number[] = [];
  const values: number[] = [];
  let prevRow = -1;
  let prevCol = -1;
  for (const item of triplets) {
    if (item.row === prevRow && item.col === prevCol && values.length > 0) {
      values[values.length - 1] = (values[values.length - 1] ?? 0) + item.value;
      continue;
    }
    colIdx.push(item.col);
    values.push(item.value);
    rowPtr[item.row + 1] = (rowPtr[item.row + 1] ?? 0) + 1;
    prevRow = item.row;
    prevCol = item.col;
  }
  for (let i = 1; i < rowPtr.length; i++) rowPtr[i] = (rowPtr[i] ?? 0) + (rowPtr[i - 1] ?? 0);
  return { matrix: { n: allIds.length, rowPtr, colIdx, values }, entityIndex };
}

export function normalizeRows(matrix: SparseMatrix): SparseMatrix {
  const values = new Array<number>(matrix.values.length);
  for (let row = 0; row < matrix.n; row++) {
    let rowSum = 0;
    const start = matrix.rowPtr[row] ?? 0;
    const end = matrix.rowPtr[row + 1] ?? start;
    for (let cursor = start; cursor < end; cursor++) rowSum += matrix.values[cursor] ?? 0;
    for (let cursor = start; cursor < end; cursor++) {
      values[cursor] = rowSum > 1e-15 ? (matrix.values[cursor] ?? 0) / rowSum : 0;
    }
  }
  return { ...matrix, values };
}

export function sparseMV(matrix: SparseMatrix, input: number[]): number[] {
  const output = new Array<number>(matrix.n).fill(0);
  for (let row = 0; row < matrix.n; row++) {
    let sum = 0;
    const start = matrix.rowPtr[row] ?? 0;
    const end = matrix.rowPtr[row + 1] ?? start;
    for (let cursor = start; cursor < end; cursor++) {
      const col = matrix.colIdx[cursor];
      if (col === undefined) continue;
      sum += (matrix.values[cursor] ?? 0) * (input[col] ?? 0);
    }
    output[row] = sum;
  }
  return output;
}

export function propagatePressuresMatrix(
  world: WorldModel,
  localPressures: Record<string, number>,
  mu = 0.3,
  nowMs = 0,
  config?: PropagationConfig,
): Record<string, number> {
  const susceptibility = { ...DEFAULT_SUSCEPTIBILITY, ...(config?.susceptibility ?? {}) };
  const { matrix, entityIndex } = buildWeightedAdjacency(world, nowMs);
  const pressureVector = new Array<number>(matrix.n).fill(0);
  for (const [id, value] of Object.entries(localPressures)) {
    const index = entityIndex.get(id);
    if (index !== undefined) pressureVector[index] = value;
  }

  const result: Record<string, number> = { ...localPressures };
  for (const edge of world.allEdges()) if (!(edge.dst in result)) result[edge.dst] = 0;

  if (config?.K !== undefined && config.K >= 1) {
    const alpha = config.alpha ?? 0.15;
    const normalized = normalizeRows(matrix);
    let current = [...pressureVector];
    for (let i = 0; i < config.K; i++) {
      const propagated = sparseMV(normalized, current);
      current = propagated.map((value, index) => (1 - alpha) * value + alpha * (pressureVector[index] ?? 0));
    }
    for (const [id, index] of entityIndex) {
      if (normalized.rowPtr[index + 1] === normalized.rowPtr[index]) continue;
      const delta = (current[index] ?? 0) - (pressureVector[index] ?? 0);
      if (Math.abs(delta) > 1e-15) result[id] = (result[id] ?? 0) + resolveSusceptibility(world, id, susceptibility) * mu * delta;
    }
  } else {
    const propagated = sparseMV(matrix, pressureVector);
    for (const [id, index] of entityIndex) {
      const value = propagated[index] ?? 0;
      if (Math.abs(value) > 1e-15) {
        result[id] = (result[id] ?? 0) + resolveSusceptibility(world, id, susceptibility) * mu * value;
      }
    }
  }

  return result;
}

function resolveSusceptibility(world: WorldModel, id: string, map: Record<string, number>): number {
  const type = world.getNodeType(id);
  if (!type) return 1;
  if (type === 'channel' && world.getChannel(id).chat_type === 'group') return map.group_channel ?? map.channel ?? 1;
  return map[type] ?? 1;
}

export { propagatePressuresMatrix as propagatePressures };
