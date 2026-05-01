
//
// Translates pressure field contributions into natural language the LLM can

// tension graph, or mod system — it works directly from AllPressures and
// WorldModel, which Nova already has.

import type { AllPressures } from '../pressure/aggregate';
import type { WorldModel } from '../world/model';

export interface SituationBriefingOptions {
  /** Current channel id (for anti-bombing check). */
  channelId?: string;
  /** Max number of entity-specific lines to emit. */
  maxEntityLines?: number;
  /** LLM-set channel afterward state (Step 8) for anti-bombing window adjustment. */
  afterward?: string;
}

/**
 * Build a natural-language situation briefing from the current pressure field.
 * Returns lines that can be injected directly into the LLM user prompt.
 */
export function buildSituationBriefing(
  pressure: AllPressures,
  world: WorldModel,
  nowMs: number,
  options: SituationBriefingOptions = {},
): string[] {
  const lines: string[] = [];
  const maxLines = options.maxEntityLines ?? 4;

  // Collect top entities across pressure dimensions
  const entries = collectTopEntities(pressure, world, maxLines);

  for (const entry of entries) {
    const line = generateEntityLine(entry, pressure, world, nowMs);
    if (line) lines.push(line);
  }

  // Anti-bombing: detect when Nova has been talking without reply
  if (options.channelId && world.has(options.channelId) && world.getNodeType(options.channelId) === 'channel') {
    const ch = world.getChannel(options.channelId);
    const lastAction = ch.last_nova_action_ms ?? 0;
    const lastIncoming = ch.last_incoming_ms ?? 0;
    const elapsedSinceAction = (nowMs - lastAction) / 1000;
    // Afterward-aware window (Step 8): shorter threshold when LLM set a post-conversation state.
    const maxAntiBombWindowS = options.afterward === 'waiting_reply' ? 120
      : options.afterward === 'watching' ? 300
      : options.afterward === 'cooling_down' ? 60
      : 600;
    if (lastAction > lastIncoming && elapsedSinceAction < maxAntiBombWindowS && elapsedSinceAction > 10) {
      const baseMsg = "You've been talking without hearing back — ease up, no need to send another message until they respond.";
      if (options.afterward === 'waiting_reply') {
        lines.push(baseMsg + " You already indicated you're waiting for their reply.");
      } else if (options.afterward === 'cooling_down') {
        lines.push(baseMsg + " You're in cooldown — stay quiet.");
      } else if (options.afterward === 'watching') {
        lines.push(baseMsg + " You're observing this channel.");
      } else {
        lines.push(baseMsg);
      }
    }
  }

  // Qualitative overall line from API
  lines.push(qualitativeOverall(pressure.API));

  return lines;
}

// ── Entity collection ──────────────────────────────────────────────────────

interface PressureEntry {
  entityId: string;
  displayName: string;
  dimension: string;
  value: number;
}

function collectTopEntities(
  pressure: AllPressures,
  world: WorldModel,
  maxLines: number,
): PressureEntry[] {
  const entries: PressureEntry[] = [];

  // P5: response obligation (most actionable)
  for (const [entityId, value] of Object.entries(pressure.contributions.P5 ?? {})) {
    if (value <= 0.01) continue;
    entries.push({
      entityId,
      displayName: resolveName(world, entityId),
      dimension: 'P5',
      value,
    });
  }

  // P3: relationship cooling
  for (const [entityId, value] of Object.entries(pressure.contributions.P3 ?? {})) {
    if (value <= 0.01) continue;
    entries.push({
      entityId,
      displayName: resolveName(world, entityId),
      dimension: 'P3',
      value,
    });
  }

  // P1: attention debt (unread messages)
  for (const [entityId, value] of Object.entries(pressure.contributions.P1 ?? {})) {
    if (value <= 1) continue; // P1 has higher baseline, filter noise
    entries.push({
      entityId,
      displayName: resolveName(world, entityId),
      dimension: 'P1',
      value,
    });
  }

  // P4: thread divergence
  for (const [entityId, value] of Object.entries(pressure.contributions.P4 ?? {})) {
    if (value <= 0.01) continue;
    entries.push({
      entityId,
      displayName: resolveName(world, entityId),
      dimension: 'P4',
      value,
    });
  }

  // Sort: P5 first (most urgent), then by value descending
  const dimOrder: Record<string, number> = { P5: 0, P3: 1, P1: 2, P4: 3 };
  entries.sort((a, b) => {
    const orderDiff = (dimOrder[a.dimension] ?? 9) - (dimOrder[b.dimension] ?? 9);
    if (orderDiff !== 0) return orderDiff;
    return b.value - a.value;
  });

  // Deduplicate by entity
  const seen = new Set<string>();
  const result: PressureEntry[] = [];
  for (const entry of entries) {
    if (result.length >= maxLines) break;
    if (seen.has(entry.entityId)) continue;
    seen.add(entry.entityId);
    result.push(entry);
  }

  return result;
}

// ── Line generators ────────────────────────────────────────────────────────

function generateEntityLine(
  entry: PressureEntry,
  _pressure: AllPressures,
  _world: WorldModel,
  _nowMs: number,
): string | null {
  const name = entry.displayName || entry.entityId;

  switch (entry.dimension) {
    case 'P5':
      return `${name} has been waiting for a reply.`;
    case 'P3':
      return `Haven't talked to ${name} in a while.`;
    case 'P1':
      return `Unread messages piling up in ${name}.`;
    case 'P4':
      return `A conversation thread with ${name} has gone quiet.`;
    default:
      return null;
  }
}

// ── Qualitative overall ────────────────────────────────────────────────────

function qualitativeOverall(api: number): string {
  if (api < 0.5) return 'Everything is calm right now.';
  if (api < 1.5) return 'A few things on your mind.';
  if (api < 3.0) return 'A few things going on in other chats.';
  if (api < 4.5) return "Other chats have been active.";
  return "The world's been busy while you're here.";
}

// ── Rhythm pattern detection ───────────────────────────────────────────────

export function detectRhythmPattern(
  pressure: AllPressures,
): string | undefined {
  const history = pressure.pressureHistory;
  if (!history) return undefined;

  const apiHistory = [
    ...(history.P1 ?? []).map((_, i) =>
      (history.P1?.[i] ?? 0) + (history.P2?.[i] ?? 0) + (history.P3?.[i] ?? 0) +
      (history.P4?.[i] ?? 0) + (history.P5?.[i] ?? 0) + (history.P6?.[i] ?? 0)
    ),
  ];

  if (apiHistory.length < 5) return undefined;

  // Sustained high: last 5 all > 3.0
  const last5 = apiHistory.slice(-5);
  if (last5.every((v) => v > 3.0)) return "It's been non-stop busy for a while now.";

  // Extended calm: last 10 all < 0.5
  if (apiHistory.length >= 10 && apiHistory.slice(-10).every((v) => v < 0.5)) {
    return "It's been quiet for a while — nothing much happening.";
  }

  // Sudden drop: latest < 50% of 5-tick mean
  const avg5 = last5.reduce((a, b) => a + b, 0) / 5;
  const latest = last5[last5.length - 1] ?? 0;
  if (avg5 > 1.0 && latest < avg5 * 0.5) {
    return "Things calmed down suddenly.";
  }

  return undefined;
}

// ── Anti-bombing check ─────────────────────────────────────────────────────

/**
 * 检测 Nova 是否在 channel 中自说自话（最后一轮是 Nova 发出的，且对方未回复）。
 *
 * Afterward 感知（Step 8）：
 *   - waiting_reply：更保守，检测窗口缩短到 2 分钟
 *   - watching：中等保守，检测窗口缩短到 5 分钟
 *   - cooling_down：最保守，检测窗口缩短到 1 分钟
 *   - done / 未设置：默认 10 分钟窗口
 *
 * 更短的窗口意味着 Nova 更容易被判定为 "speaking alone"，
 * 从而在 prompt 中触发 "ease up" 信号。
 */
export function checkSpeakingAlone(
  world: WorldModel,
  channelId: string,
  nowMs: number,
  afterward?: string,
): boolean {
  if (!world.has(channelId) || world.getNodeType(channelId) !== 'channel') return false;
  const ch = world.getChannel(channelId);
  const lastAction = ch.last_nova_action_ms ?? 0;
  const lastIncoming = ch.last_incoming_ms ?? 0;
  if (lastAction <= lastIncoming) return false;

  // 根据 afterward 选择检测窗口
  const maxWindowS = afterward === 'waiting_reply' ? 120      // 2 min: 等待回复时应更早停止
    : afterward === 'watching' ? 300                            // 5 min: 观察模式保守
    : afterward === 'cooling_down' ? 60                         // 1 min: 冷却中几乎不追发
    : 600;                                                       // 10 min: 默认

  const elapsedS = (nowMs - lastAction) / 1000;
  return elapsedS < maxWindowS && elapsedS > 5;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveName(world: WorldModel, entityId: string): string {
  if (!world.has(entityId)) return entityId;
  const nodeType = world.getNodeType(entityId);
  if (nodeType === 'contact') {
    const c = world.getContact(entityId);
    return c.remark ?? c.nickname ?? c.name ?? c.qq ?? entityId;
  }
  if (nodeType === 'channel') {
    const ch = world.getChannel(entityId);
    return ch.title ?? ch.group_name ?? entityId;
  }
  return entityId;
}
