
//
// Every tick (message or scheduled) produces a TickPlan that captures
// the full deliberation trace: pressure → desires → voice → candidates →
// gate decision → final action or silence.

import type { PressureSnapshot } from '../pressure/aggregate';
import type { VoiceSelectionResult } from '../voices/selection';
import type { GateDecision } from '../gates/gates';
import type { Desire } from './desire';
import type { IAUSScore } from './iaus-scorer';
import type { NovaAfterward } from '../llm/response-schema';

export type { Desire };

/** LLM afterward 对调度的影响元数据，嵌入候选和 trace 用于审计。 */
export interface AfterwardSchedulingEffect {
  /** 优先级倍率（0 表示被直接拒绝）。 */
  priorityMultiplier?: number;
  /** 门控附加惩罚值。 */
  gatePenalty?: number;
  /** 是否被 gate 直接拒绝。 */
  gateDenied?: boolean;
  /** 人类可读的调度影响原因。 */
  reason: string;
}

/**
 * Per-channel afterward 状态快照，嵌入 TickPlan 用于 tick trace。
 */
export interface TickAfterwardState {
  value: NovaAfterward;
  channelId: string;
  updatedAt: number;
  expiresAt?: number;
  source?: 'reply' | 'proactive';
}

// ── Action candidate ───────────────────────────────────────────────────────

/**
 * A candidate action considered during tick planning.
 * For message ticks there is typically one candidate (reply or silence).
 * For scheduled ticks there may be multiple candidates derived from desires.
 */
export interface ActionCandidate {
  /** The IAUS action type: diligence / curiosity / sociability. */
  action: string;
  /** Target entity id (contact or channel). */
  targetId: string | null;
  /** The desire that motivated this candidate, if any. */
  desireType?: string;
  /** Urgency derived from the motivating desire. */
  urgency?: string;
  /** IAUS score details, if scoring was run. */
  iausScore?: IAUSScore | null;
  /** Whether this candidate targets a group channel. */
  scene?: 'private' | 'group';
  /** Human-readable reason for trace / log inspection. */
  reason: string;
  /** LLM afterward 对此候选的调度影响（如果有）。 */
  afterwardSchedulingEffect?: AfterwardSchedulingEffect;
}

// ── Decision agent trace ───────────────────────────────────────────────────

export interface DecisionAgentTrace {
  enabled: boolean;
  model?: string;
  action?: string;
  candidateId?: string;
  targetId?: string | null;
  generateText?: boolean;
  responderIntent?: string;
  reason?: string;
  confidence?: number;
  afterward?: string;
  tags?: string[];
  /** State updates proposed by the decision agent (e.g. send_sticker). */
  stateUpdates?: Array<{ type: string; [key: string]: unknown }>;
  raw?: unknown;
  error?: string;
  fallbackUsed?: boolean;
}

// ── Tick plan ──────────────────────────────────────────────────────────────

export interface TickPlan {
  /** Monotonically increasing tick counter. */
  tick: number;
  /** Whether this tick was triggered by a message or the scheduler. */
  reason: 'message' | 'scheduled';
  /** Pressure snapshot at the time of planning. */
  pressure: PressureSnapshot;
  /** Voice competition result. */
  voice: VoiceSelectionResult;
  /** Desires derived from pressure (empty for message ticks). */
  desires: Desire[];
  /** Action candidates considered (including the selected one). */
  candidates: ActionCandidate[];
  /** The selected candidate, if one was chosen. */
  selected?: ActionCandidate;
  /** Gate evaluation result. */
  gateDecision: GateDecision;
  /** Reason for silence, if the gate denied all candidates. */
  silenceReason?: string;
  /** LLM afterward 状态快照（scheduled tick 中有 afterward 影响的 channel）。 */
  afterwardState?: TickAfterwardState;
  /** Decision agent trace — populated when gatewayMode is 'agent'. */
  decisionAgent?: DecisionAgentTrace;
  /** Algorithmic gate audit results — recorded when auditAlgorithmicGates is true. */
  algorithmicGateAudit?: GateDecision[];
  /** Timestamp when this plan was created. */
  createdMs: number;
}

// ── Serialization helpers ──────────────────────────────────────────────────

/**
 * Serialize a TickPlan to a JSON-safe object for logging / persistence.
 * Internal trace data must not be exposed to QQ users.
 */
export function serializeTickPlan(plan: TickPlan): Record<string, unknown> {
  return {
    tick: plan.tick,
    reason: plan.reason,
    pressure: {
      p1: plan.pressure.p1,
      p2: plan.pressure.p2,
      p3: plan.pressure.p3,
      p4: plan.pressure.p4,
      p5: plan.pressure.p5,
      p6: plan.pressure.p6,
      pProspect: plan.pressure.pProspect,
      api: plan.pressure.api,
      apiPeak: plan.pressure.apiPeak,
    },
    voice: {
      selected: plan.voice.selected,
      iausAction: plan.voice.iausAction,
      probabilities: plan.voice.probabilities,
      temperature: plan.voice.temperature,
    },
    desires: plan.desires.map((d) => ({
      type: d.type,
      urgency: d.urgency,
      pressureValue: d.pressureValue,
      targetId: d.targetId,
      source: d.source,
      reason: d.reason,
    })),
    candidates: plan.candidates.map((c) => ({
      action: c.action,
      targetId: c.targetId,
      desireType: c.desireType,
      urgency: c.urgency,
      scene: c.scene,
      reason: c.reason,
      ...(c.iausScore ? {
        iausScore: {
          rawScore: c.iausScore.rawScore,
          compensatedScore: c.iausScore.compensatedScore,
          effectiveScore: c.iausScore.effectiveScore,
          postFairnessScore: c.iausScore.postFairnessScore,
          selectionScore: c.iausScore.selectionScore,
          legacyNetSocialValue: c.iausScore.legacyNetSocialValue,
          deltaP: c.iausScore.deltaP,
          socialCost: c.iausScore.socialCost,
          netValue: c.iausScore.netValue,
          considerations: c.iausScore.considerations,
          selectedProbability: c.iausScore.selectedProbability,
          bottleneck: c.iausScore.bottleneck,
          scoringMode: c.iausScore.scoringMode,
          multipliers: c.iausScore.multipliers,
        },
      } : {}),
      ...(c.afterwardSchedulingEffect ? { afterwardSchedulingEffect: c.afterwardSchedulingEffect } : {}),
    })),
    selected: plan.selected ? {
      action: plan.selected.action,
      targetId: plan.selected.targetId,
      desireType: plan.selected.desireType,
      urgency: plan.selected.urgency,
      scene: plan.selected.scene,
      reason: plan.selected.reason,
      ...(plan.selected.iausScore ? {
        iausScore: {
          rawScore: plan.selected.iausScore.rawScore,
          compensatedScore: plan.selected.iausScore.compensatedScore,
          legacyNetSocialValue: plan.selected.iausScore.legacyNetSocialValue,
          deltaP: plan.selected.iausScore.deltaP,
          socialCost: plan.selected.iausScore.socialCost,
          netValue: plan.selected.iausScore.netValue,
          considerations: plan.selected.iausScore.considerations,
          selectedProbability: plan.selected.iausScore.selectedProbability,
        },
      } : {}),
      ...(plan.selected.afterwardSchedulingEffect ? { afterwardSchedulingEffect: plan.selected.afterwardSchedulingEffect } : {}),
    } : null,
    gateDecision: {
      allow: plan.gateDecision.allow,
      level: plan.gateDecision.level,
      reason: plan.gateDecision.reason,
      reasons: plan.gateDecision.reasons,
    },
    silenceReason: plan.silenceReason ?? null,
    ...(plan.afterwardState ? { afterwardState: plan.afterwardState } : {}),
    ...(plan.decisionAgent ? {
      decisionAgent: {
        enabled: plan.decisionAgent.enabled,
        ...(plan.decisionAgent.model ? { model: plan.decisionAgent.model } : {}),
        ...(plan.decisionAgent.action ? { action: plan.decisionAgent.action } : {}),
        ...(plan.decisionAgent.candidateId ? { candidateId: plan.decisionAgent.candidateId } : {}),
        ...(plan.decisionAgent.targetId !== undefined ? { targetId: plan.decisionAgent.targetId } : {}),
        ...(plan.decisionAgent.generateText !== undefined ? { generateText: plan.decisionAgent.generateText } : {}),
        ...(plan.decisionAgent.responderIntent ? { responderIntent: plan.decisionAgent.responderIntent } : {}),
        ...(plan.decisionAgent.reason ? { reason: plan.decisionAgent.reason } : {}),
        ...(plan.decisionAgent.confidence !== undefined ? { confidence: plan.decisionAgent.confidence } : {}),
        ...(plan.decisionAgent.afterward ? { afterward: plan.decisionAgent.afterward } : {}),
        ...(plan.decisionAgent.tags ? { tags: plan.decisionAgent.tags } : {}),
        ...(plan.decisionAgent.error ? { error: plan.decisionAgent.error } : {}),
        ...(plan.decisionAgent.fallbackUsed ? { fallbackUsed: plan.decisionAgent.fallbackUsed } : {}),
      },
    } : {}),
    ...(plan.algorithmicGateAudit && plan.algorithmicGateAudit.length > 0 ? {
      algorithmicGateAudit: plan.algorithmicGateAudit.map((g) => ({
        allow: g.allow,
        level: g.level,
        reason: g.reason,
        reasons: g.reasons,
      })),
    } : {}),
    createdMs: plan.createdMs,
  };
}

/**
 * Create an empty tick plan skeleton.
 */
export function createTickPlan(params: {
  tick: number;
  reason: 'message' | 'scheduled';
  pressure: PressureSnapshot;
  voice: VoiceSelectionResult;
  gateDecision: GateDecision;
  nowMs?: number;
}): TickPlan {
  return {
    tick: params.tick,
    reason: params.reason,
    pressure: params.pressure,
    voice: params.voice,
    desires: [],
    candidates: [],
    gateDecision: params.gateDecision,
    createdMs: params.nowMs ?? Date.now(),
  };
}
