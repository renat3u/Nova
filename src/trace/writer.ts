
//
// 从 TickPlan / EvolveResult / action execution 中构建结构化审议 trace，
// 并持久化到 nova_tick_traces 表。
//
// trace 给开发者 / 观测系统看，绝不进入 Nova 对用户的回复。

import type { TickPlan, ActionCandidate } from '../engine/tick-plan';
import type { EvolveResult } from '../engine/evolve';
import type { IAUSScore } from '../engine/iaus-scorer';
import type { NovaWorldRepository } from '../world/repository';
import type {
  NovaTickTrace,
  NovaCandidateTrace,
  NovaActionTrace,
  NovaDeliberationTrace,
  NovaDesireTrace,
  LlmStateWritebackSummary,
} from './types';

// ── Build tick trace from TickPlan ───────────────────────────────────────────

/**
 * 从 TickPlan 构建完整的 NovaTickTrace。
 *
 * 包含：
 *   - 六维压力 + pProspect + API/API_peak
 *   - 声部选择（selected voice + probabilities + IAUS action）
 *   - 派生的 desires
 *   - 考虑过的 candidates（含 IAUS 评分和原因）
 *   - gate 判决 + silence reason
 */
export function buildTickTrace(plan: TickPlan): NovaTickTrace {
  return {
    tick: plan.tick,
    reason: plan.reason,
    p1: plan.pressure.p1,
    p2: plan.pressure.p2,
    p3: plan.pressure.p3,
    p4: plan.pressure.p4,
    p5: plan.pressure.p5,
    p6: plan.pressure.p6,
    pProspect: plan.pressure.pProspect,
    api: plan.pressure.api,
    apiPeak: plan.pressure.apiPeak,
    selectedVoice: plan.voice.selected,
    iausAction: plan.voice.iausAction,
    voiceProbabilities: plan.voice.probabilities,
    desires: plan.desires.map(buildDesireTrace),
    candidates: plan.candidates.map(buildCandidateTrace),
    selectedCandidate: plan.selected ? buildCandidateTrace(plan.selected) : undefined,
    gateVerdict: plan.gateDecision.reason,
    gateLevel: plan.gateDecision.level,
    gateReasons: plan.gateDecision.reasons,
    silenceReason: plan.silenceReason,
    ...(plan.afterwardState ? {
      afterwardState: {
        value: plan.afterwardState.value,
        channelId: plan.afterwardState.channelId,
        updatedAt: plan.afterwardState.updatedAt,
        expiresAt: plan.afterwardState.expiresAt,
      },
    } : {}),
    createdMs: plan.createdMs,
  };
}

/**
 * 从 TickPlan + EvolveResult 构建 tick trace，并补充 queued actions 信息。
 */
export function buildTickTraceFromEvolve(
  plan: TickPlan,
  evolve: EvolveResult,
): NovaTickTrace {
  const trace = buildTickTrace(plan);

  // 补充 mode 信息
  if (plan.reason === 'message') {
    trace.mode = plan.gateDecision.allow ? 'reply' : 'silence';
  } else {
    if (evolve.queuedActions.length > 0) {
      trace.mode = 'proactive_enqueued';
    } else if (plan.silenceReason) {
      trace.mode = 'proactive_silence';
    } else {
      trace.mode = 'proactive_observed';
    }
  }

  return trace;
}

// ── Build action trace ───────────────────────────────────────────────────────

/**
 * 构建行动执行 trace。
 *
 * 记录从 queue → execute → engagement outcome 的完整生命周期。
 */
export function buildActionTrace(params: {
  tick: number;
  actionType: string;
  targetId: string;
  text?: string;
  voice?: string;
  reasoning?: string;
  status: 'queued' | 'success' | 'failed' | 'silence';
  error?: string;
  engagementOutcome?: string;
  memoryWriteback?: unknown;
  threadWriteback?: unknown;
  llmStateUpdatesAccepted?: unknown;
  llmStateUpdatesRejected?: unknown;
  llmStateWritebackSummary?: LlmStateWritebackSummary;
  createdMs?: number;
}): NovaActionTrace {
  return {
    tick: params.tick,
    actionType: params.actionType,
    targetId: params.targetId,
    text: params.text,
    voice: params.voice,
    reasoning: params.reasoning,
    status: params.status,
    error: params.error,
    engagementOutcome: params.engagementOutcome,
    memoryWriteback: params.memoryWriteback,
    threadWriteback: params.threadWriteback,
    llmStateUpdatesAccepted: params.llmStateUpdatesAccepted,
    llmStateUpdatesRejected: params.llmStateUpdatesRejected,
    llmStateWritebackSummary: params.llmStateWritebackSummary,
    createdMs: params.createdMs ?? Date.now(),
  };
}

// ── Build deliberation trace ─────────────────────────────────────────────────

export function buildDeliberationTrace(params: {
  tickTrace: NovaTickTrace;
  actionTraces?: NovaActionTrace[];
  memoryWritten?: boolean;
  threadWritten?: boolean;
  afterward?: string;
  selfMoodBefore?: number;
  selfMoodAfter?: number;
  llmStateUpdatesAccepted?: unknown;
  llmStateUpdatesRejected?: unknown;
}): NovaDeliberationTrace {
  const actionTraces = params.actionTraces ?? [];
  const latestAction = actionTraces[0];
  const selected = params.tickTrace.selectedCandidate;
  const actionSummary = latestAction
    ? `${latestAction.actionType}:${latestAction.status}:${latestAction.targetId}`
    : selected
      ? `${selected.action}:${selected.targetId ?? 'none'}`
      : undefined;
  const silenceSummary = params.tickTrace.silenceReason
    ?? (params.tickTrace.gateVerdict === 'allowed' ? undefined : params.tickTrace.gateVerdict);

  return {
    tick: params.tickTrace.tick,
    reason: params.tickTrace.reason,
    actionSummary,
    silenceSummary,
    memoryWritten: params.memoryWritten ?? actionTraces.some((trace) => trace.memoryWriteback !== undefined),
    threadWritten: params.threadWritten ?? actionTraces.some((trace) => trace.threadWriteback !== undefined),
    afterward: params.afterward,
    selfMoodBefore: params.selfMoodBefore,
    selfMoodAfter: params.selfMoodAfter,
    llmStateUpdatesAccepted: params.llmStateUpdatesAccepted,
    llmStateUpdatesRejected: params.llmStateUpdatesRejected,
    createdMs: params.tickTrace.createdMs,
  };
}

// ── Build silence trace summary ──────────────────────────────────────────────

/**
 * 为 silence log 构建可读的 silence reason 摘要。
 *
 * 用于 trace 中展示"为什么 Nova 沉默了"。
 */
export function buildSilenceTraceSummary(params: {
  reason: string;
  level: string;
  values?: Record<string, unknown>;
}): string {
  const parts: string[] = [`silence: ${params.reason}`];
  if (params.level && params.level !== 'none') {
    parts.push(`level=${params.level}`);
  }
  if (params.values) {
    const keyValues = Object.entries(params.values)
      .filter(([, v]) => v !== undefined && v !== null)
      .slice(0, 6)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
    if (keyValues.length > 0) {
      parts.push(`(${keyValues.join(', ')})`);
    }
  }
  return parts.join(' ');
}

// ── Build IAUS reason for proactive actions ──────────────────────────────────

/**
 * 为主动行为候选构建扩展的 IAUS reason 字符串。
 *
 * 这是 assembleIAUSReason (iaus-scorer.ts) 的补充 ——
 * 在 IAUS 分数之上叠加 proactive-specific 的上下文：
 *   - whitelist 通过/拒绝
 *   - group policy 通过/拒绝
 *   - social value 判定
 *   - gate verdict
 *
 * 与 iaus-scorer.ts 的 assembleIAUSReason 保持互补关系：
 *   - assembleIAUSReason 负责 core IAUS 数值含义
 *   - buildProactiveIAUSReason 负责 gate / policy 上下文
 */
export function buildProactiveIAUSReason(params: {
  action: string;
  targetId: string | null;
  desireType?: string;
  urgency?: string;
  scene?: string;
  iausScore?: IAUSScore | null;
  gateVerdict: string;
  gateReasons: string[];
  silenceReason?: string;
}): string {
  const parts: string[] = [];

  // Action and desire context
  const desireLabel = params.desireType ? ` ${params.desireType}` : '';
  const urgencyLabel = params.urgency ? ` (urgency=${params.urgency})` : '';
  const sceneLabel = params.scene ? ` [${params.scene}]` : '';
  parts.push(`action=${params.action}${desireLabel}${urgencyLabel}${sceneLabel}`);

  if (params.targetId) {
    parts.push(`target=${params.targetId}`);
  }

  // IAUS scores
  if (params.iausScore) {
    const pct = params.iausScore.selectedProbability !== undefined
      ? `, p=${(params.iausScore.selectedProbability * 100).toFixed(0)}%`
      : '';
    parts.push(
      `score=${params.iausScore.netValue.toFixed(3)}, ` +
      (params.iausScore.compensatedScore !== undefined ? `compensatedScore=${params.iausScore.compensatedScore.toFixed(3)}, ` : '') +
      (params.iausScore.legacyNetSocialValue !== undefined ? `legacyNSV=${params.iausScore.legacyNetSocialValue.toFixed(3)}, ` : '') +
      `deltaP=${params.iausScore.deltaP.toFixed(3)}, ` +
      `socialCost=${params.iausScore.socialCost.toFixed(3)}${pct}`,
    );
  }

  // Gate verdict
  if (params.gateVerdict === 'allowed') {
    parts.push('gate: passed');
    if (params.gateReasons.length > 0) {
      parts.push(`(${params.gateReasons.join('; ')})`);
    }
  } else {
    parts.push(`gate: denied`);
    if (params.silenceReason) {
      parts.push(`reason=${params.silenceReason}`);
    }
    if (params.gateReasons.length > 0) {
      parts.push(`(${params.gateReasons.join('; ')})`);
    }
  }

  return parts.join(', ');
}

// ── Build whitelist / gate denial reason ─────────────────────────────────────

/**
 * 为被白名单 / gate 拦截的主动候选构建 silence reason。
 *
 * 示例：
 *   silence: proactive_whitelist_denied (targetQQ=12345, whitelist=[67890])
 *   silence: active_cooling (elapsedMs=15000, cooldownMs=60000)
 *   silence: social_value_negative (netValue=-0.4, deltaP=0.1, socialCost=0.5)
 *   silence: group_policy_denied (groupRiskLevel=high, reason=group_high_risk)
 */
export function buildSilenceReasonForCandidate(params: {
  gateReason: string;
  values?: Record<string, unknown>;
}): string {
  const keyValues = params.values
    ? Object.entries(params.values)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => {
          const sv = Array.isArray(v) ? `[${v.join(',')}]` : typeof v === 'object' ? JSON.stringify(v) : String(v);
          return `${k}=${sv}`;
        })
    : [];

  if (keyValues.length === 0) {
    return `silence: ${params.gateReason}`;
  }

  return `silence: ${params.gateReason} (${keyValues.join(', ')})`;
}

// ── Persistence helpers ──────────────────────────────────────────────────────

/**
 * 将 NovaTickTrace 写入数据库。
 *
 * 委托给 repository.recordTickTrace，将完整 trace JSON 存储到
 * nova_tick_traces 表中，同时保留 tick / reason / gate_verdict /
 * silence_reason 作为索引列方便查询。
 */
export function persistTickTrace(
  repository: NovaWorldRepository,
  trace: NovaTickTrace,
): void {
  repository.recordTickTrace(trace);
}

export function persistActionTrace(
  repository: NovaWorldRepository,
  trace: NovaActionTrace,
): void {
  repository.recordActionTrace(trace);
}

export function persistDeliberationTrace(
  repository: NovaWorldRepository,
  trace: NovaDeliberationTrace,
): void {
  repository.recordDeliberationTrace(trace);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function buildDesireTrace(desire: { type: string; urgency: string; pressureValue: number; targetId: string | null; source: string }): NovaDesireTrace {
  return {
    type: desire.type,
    urgency: desire.urgency,
    pressureValue: desire.pressureValue,
    targetId: desire.targetId,
    source: desire.source,
  };
}

// ── Privacy / redaction helpers ────────────────────────────────────────────────

/**
 * Pattern matching forbidden internal terms that should never appear in
 * LLM-generated content.  When a state update is rejected because its raw
 * content matches these, the trace should record a redacted version.
 */
const FORBIDDEN_INTERNAL_RE = /prompt|system|pressure|gate|IAUS|whitelist|白名单|系统提示|bypass|rate limit|shell|bash|command/i;

/**
 * Redact the raw value of a rejected state update when it contains
 * forbidden internal terms (prompt leak, system internals, etc.).
 *
 * Returns a sanitized version safe for trace / log persistence.
 * Non-string values are returned as-is; only string content is
 * inspected and potentially redacted.
 */
export function redactSensitiveRejectedRaw(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  if (FORBIDDEN_INTERNAL_RE.test(raw)) {
    return '[redacted:forbidden_internal_term]';
  }
  return raw;
}

/**
 * Build a minimal llmStateWritebackSummary from accepted/rejected lists.
 * Safe for trace, API responses, and status summaries — avoids embedding
 * raw user content or full memory text.
 */
export function buildLlmStateWritebackSummary(
  accepted: Array<{ type: string }>,
  rejected: Array<{ type?: string; reason: string }>,
): LlmStateWritebackSummary {
  return {
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    typesAccepted: [...new Set(accepted.map((a) => a.type))],
    typesRejected: [...new Set(rejected.map((r) => r.type ?? r.reason))],
  };
}

function buildCandidateTrace(candidate: ActionCandidate): NovaCandidateTrace {
  return {
    action: candidate.action,
    targetId: candidate.targetId,
    desire: candidate.desireType,
    urgency: candidate.urgency,
    rawScore: candidate.iausScore?.rawScore,
    compensatedScore: candidate.iausScore?.compensatedScore,
    effectiveScore: candidate.iausScore?.effectiveScore,
    postFairnessScore: candidate.iausScore?.postFairnessScore,
    selectionScore: candidate.iausScore?.selectionScore,
    legacyNetSocialValue: candidate.iausScore?.legacyNetSocialValue,
    deltaP: candidate.iausScore?.deltaP,
    socialCost: candidate.iausScore?.socialCost,
    netValue: candidate.iausScore?.netValue,
    considerations: candidate.iausScore?.considerations,
    selectedProbability: candidate.iausScore?.selectedProbability,
    bottleneck: candidate.iausScore?.bottleneck,
    multipliers: candidate.iausScore?.multipliers,
    scoringMode: candidate.iausScore?.scoringMode,
    reason: candidate.reason,
    ...(candidate.afterwardSchedulingEffect ? { afterwardSchedulingEffect: candidate.afterwardSchedulingEffect } : {}),
  };
}

/**
 * 从 NovaActionTrace 构建可持久化的 action trace JSON 摘要。
 */
export function serializeActionTrace(trace: NovaActionTrace): Record<string, unknown> {
  return {
    tick: trace.tick,
    actionType: trace.actionType,
    targetId: trace.targetId,
    ...(trace.text !== undefined ? { text: trace.text.length > 200 ? `${trace.text.slice(0, 200)}…` : trace.text } : {}),
    ...(trace.voice !== undefined ? { voice: trace.voice } : {}),
    ...(trace.reasoning !== undefined ? { reasoning: trace.reasoning } : {}),
    status: trace.status,
    ...(trace.error !== undefined ? { error: trace.error } : {}),
    ...(trace.engagementOutcome !== undefined ? { engagementOutcome: trace.engagementOutcome } : {}),
    ...(trace.memoryWriteback !== undefined ? { memoryWriteback: trace.memoryWriteback } : {}),
    ...(trace.threadWriteback !== undefined ? { threadWriteback: trace.threadWriteback } : {}),
    ...(trace.llmStateUpdatesAccepted !== undefined ? { llmStateUpdatesAccepted: trace.llmStateUpdatesAccepted } : {}),
    ...(trace.llmStateUpdatesRejected !== undefined ? { llmStateUpdatesRejected: trace.llmStateUpdatesRejected } : {}),
    ...(trace.llmStateWritebackSummary !== undefined ? { llmStateWritebackSummary: trace.llmStateWritebackSummary } : {}),
    createdMs: trace.createdMs,
  };
}
