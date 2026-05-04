
// aligned with Phase 2 Step 18.
//
// Nova 的思考可观察性来自三个层次：
//   1. NovaTickTrace     — 每个 tick 的压力/欲望/声部/候选/gate 全貌
//   2. NovaCandidateTrace — 单个候选行动的 IAUS 评分与原因
//   3. NovaActionTrace   — 行动执行结果、engagement 回写、memory/thread 摘要
//
// 这些结构给开发者 / 观测系统使用，绝不进入 Nova 对用户的回复。

// ── Tick-level trace ─────────────────────────────────────────────────────────

export interface NovaDesireTrace {
  type: string;
  urgency: string;
  pressureValue: number;
  targetId: string | null;
  source: string;
}

/** LLM afterward 对此候选的调度影响元数据（Step 11）。 */
export interface AfterwardSchedulingEffectTrace {
  priorityMultiplier?: number;
  gatePenalty?: number;
  gateDenied?: boolean;
  reason: string;
}

export interface NovaCandidateTrace {
  action: string;
  targetId: string | null;
  desire?: string;
  urgency?: string;
  rawScore?: number;
  compensatedScore?: number;
  effectiveScore?: number;
  postFairnessScore?: number;
  selectionScore?: number;
  legacyNetSocialValue?: number;
  deltaP?: number;
  socialCost?: number;
  netValue?: number;
  considerations?: Record<string, number>;
  selectedProbability?: number;
  bottleneck?: string;
  multipliers?: Record<string, number>;
  minUtility?: number;
  scoringMode?: string;
  reason: string;
  /** LLM afterward 对此候选的调度影响（todo2 Step 11）。 */
  afterwardSchedulingEffect?: AfterwardSchedulingEffectTrace;
}

/**
 * 每个 tick（message 或 scheduled）产生的完整审议 trace。
 *
 * 包含从 pressure → desire → voice → IAUS → gate → TickPlan 的
 * 全链路结构化数据，支持回答：
 *   - Nova 为什么想说话
 *   - 为什么选择这个人 / 群
 *   - 为什么选择这个声部
 *   - 为什么决定沉默
 *   - 为什么主动行为被拦截
 */
export interface NovaTickTrace {
  tick: number;
  reason: 'message' | 'scheduled';
  mode?: string;
  /** 六维压力 + pProspect + API/API_peak */
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  p5: number;
  p6: number;
  pProspect: number;
  api: number;
  apiPeak: number;
  /** 声部选择结果 */
  selectedVoice: string;
  iausAction: string | null;
  voiceProbabilities: Record<string, number>;
  /** 派生的 desire */
  desires: NovaDesireTrace[];
  /** 考虑过的候选行动 */
  candidates: NovaCandidateTrace[];
  /** 被选中的候选（如果有） */
  selectedCandidate?: NovaCandidateTrace;
  /** 门控判决 */
  gateVerdict: string;
  gateLevel: string;
  gateReasons: string[];
  /** 沉默原因（gate 拒绝时） */
  silenceReason?: string;
  /** LLM afterward 状态快照（scheduled tick 中有 afterward 时，todo2 Step 11）。 */
  afterwardState?: {
    value: string;
    channelId: string;
    updatedAt: number;
    expiresAt?: number;
  };
  /** Decision agent trace (when gatewayMode is 'agent'). */
  decisionAgent?: {
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
    raw?: unknown;
    error?: string;
    fallbackUsed?: boolean;
  };
  /** Algorithmic gate audit results. */
  algorithmicGateAudit?: Array<{
    allow: boolean;
    level: string;
    reason: string;
    reasons: string[];
  }>;
  /** 创建时间戳 */
  createdMs: number;
}

// ── Action-level trace ───────────────────────────────────────────────────────

/**
 * LLM 状态写回摘要，嵌入 action trace 用于审计。
 */
export interface LlmStateWritebackSummary {
  acceptedCount: number;
  rejectedCount: number;
  typesAccepted: string[];
  typesRejected: string[];
}

/**
 * 行动执行 trace，记录从 queue → execute → engagement outcome → writeback
 * 的完整生命周期。
 */
export interface NovaActionTrace {
  tick: number;
  actionType: string;
  targetId: string;
  text?: string;
  voice?: string;
  reasoning?: string;
  status: 'queued' | 'executing' | 'success' | 'failed' | 'silence';
  error?: string;
  engagementOutcome?: string;
  memoryWriteback?: unknown;
  threadWriteback?: unknown;
  llmStateUpdatesAccepted?: unknown;
  llmStateUpdatesRejected?: unknown;
  /** 轻量摘要，便于 API / status 快速展示 writeback 审计概况。 */
  llmStateWritebackSummary?: LlmStateWritebackSummary;
  createdMs: number;
}

// ── Deliberation trace (聚合) ────────────────────────────────────────────────

/**
 * 聚合审议摘要 — tick trace + action traces 的轻量结合。
 * 用于 API 返回时给出一段时间窗口内的完整决策链。
 */
export interface NovaDeliberationTrace {
  tick: number;
  reason: 'message' | 'scheduled';
  /** 如果最终发出了 action，这里是它的简要描述 */
  actionSummary?: string;
  /** 如果沉默了，这里是沉默原因 */
  silenceSummary?: string;
  /** 内存是否有写回 */
  memoryWritten: boolean;
  /** 线程是否有写回 */
  threadWritten: boolean;
  /** LLM afterward posture, if a state writeback recorded one. */
  afterward?: string;
  /** Self mood before accepted LLM mood writeback. */
  selfMoodBefore?: number;
  /** Self mood after accepted LLM mood writeback. */
  selfMoodAfter?: number;
  /** LLM state writeback entries that were accepted (Step 10 trace audit). */
  llmStateUpdatesAccepted?: unknown;
  /** LLM state writeback entries that were rejected (Step 10 trace audit). */
  llmStateUpdatesRejected?: unknown;
  createdMs: number;
}

// ── Persistence records ──────────────────────────────────────────────────────

/**
 * nova_tick_traces 表的持久化记录。
 * 完整的 NovaTickTrace 序列化为 JSON 存储在 trace_json 字段中。
 */
export interface TickTraceRecord {
  id?: string;
  tick: number;
  reason: string;
  gate_verdict: string;
  silence_reason: string | null;
  trace_json: string;
  created_ms: number;
}
