//
// Unified Evolve Tick — 统一的消息/定时 tick 处理，对齐 Alice runtime/src/engine/evolve.ts
//
// evolveTick(state) 统一处理：
//   Phase 1: 图准备 — perceiveTick, decay, sliding windows, generators
//   Phase 2: 纯管线  — computeTickPlan (纯函数，无副作用)
//   Phase 3: 副作用  — applyPlan (enqueue / silence)
//
// 替代原有的 runMessageEvolve / runScheduledEvolve 两套路径。

import type { EvolveState } from '../core/scheduler';
import type { TickPlan, ActionCandidate, DecisionAgentTrace } from './tick-plan';
import type { QueuedAction } from '../act/action-queue';
import { perceiveTick } from './perceive';
import { transitionMode, markAnyEvent } from './mode-fsm';
import type { NovaPerturbation } from '../perception/perturbation';
import type { NovaMessageEvent } from '../core/types';
import type { Desire } from './desire';
import { deriveDesires } from './desire';
import { scoreCandidates } from './iaus-scorer';
import type { IAUSScorerContext } from './iaus-scorer';
import {
  evaluateQQRisk,
  evaluateEngagementState,
  evaluateProactiveEnabledGate,
  evaluateWhitelistGate,
  evaluateActiveCooling,
  evaluateCautionGate,
  evaluateApiFloor,
  SILENCE_REASONS,
} from '../gates/gates';
import type { GateDecision } from '../gates/gates';
import { evaluateGroupPolicy } from '../gates/group-policy';
import { buildSilenceLogEntry } from '../gates/silence-log';
import { createTickPlan } from './tick-plan';
import { computeLoudness, rememberSelectedVoice } from '../voices/loudness';
import { selectVoice } from '../voices/selection';
import { AdaptiveKappa, computeAllPressures, toPressureSnapshot } from '../pressure/aggregate';
import type { PressureSnapshot } from '../pressure/aggregate';
import { chinaHour } from '../utils/china-time';
import type { WorldModel } from '../world/model';
import type { NovaWorldRepository } from '../world/repository';
import { buildDecisionContext } from '../decision/decision-context';
import type { DecisionAgentResponse, DecisionContext } from '../decision/decision-schema';
import type { DecisionLLMClient } from '../decision/decision-client';
import { createFallbackResponse } from '../decision/decision-validator';
import { readRV, readVelocity, renderRelationshipFacts } from '../world/relationship-vector';
import { generateGroupProfileSummary } from '../relationships/group-profile';

export interface EvolveTickResult {
  acted: boolean;
  plan: TickPlan;
  queuedActions: QueuedAction[];
  eventCount: number;
}

/**
 * 统一的 evolve tick 入口。
 */
export async function evolveTick(state: EvolveState): Promise<boolean> {
  const nowMs = Date.now();
  const G = state.G;
  const buffer = state.buffer;
  const clock = state.clock;
  const repository = state.repository;
  const logger = state.logger;

  // 推进 tick clock
  const { tick } = clock.advance(nowMs);

  // ── Phase 1: 图准备 ──────────────────────────────────────────────────────

  // 1a. 感知：批量消费 buffer 中的事件
  const perceiveResult = perceiveTick(G, repository, buffer, tick, { logger });

  // 1b. 记录事件
  if (perceiveResult.eventCount > 0) {
    markAnyEvent(state.modeState, nowMs);
  }

  // 1c. Tick conversations（超时检测等）
  tickConversations(G, nowMs);

  // ── Phase 1.5: 压力计算 ──────────────────────────────────────────────────

  const dtS = clock.lastAdvanceMs === 0 ? 60 : Math.max(1, (nowMs - clock.lastAdvanceMs) / 1000);
  const kappa = (state.adaptiveKappa as AdaptiveKappa).current();
  const computeOpts: Parameters<typeof computeAllPressures>[2] = {
    nowMs,
    kappa,
    tickDt: dtS,
    moodValence: (state.moodTracker as { current: number } | undefined)?.current ?? 0,
  } as Parameters<typeof computeAllPressures>[2];
  const allPressures = computeAllPressures(G, tick, computeOpts);

  (state.adaptiveKappa as AdaptiveKappa).update(
    [allPressures.P1, allPressures.P2, allPressures.P3, allPressures.P4, allPressures.P5, allPressures.P6],
    dtS,
  );

  const pressureSnapshot = toPressureSnapshot(allPressures, tick, nowMs);
  state.pressureRef.current = pressureSnapshot;

  // 1f. Voice selection
  const loudness = computeLoudness({
    world: G,
    pressure: allPressures,
    personality: state.personality,
    nowMs,
    fatigueState: state.voiceFatigue as Parameters<typeof computeLoudness>[0]['fatigueState'],
  });
  const voiceReasons = loudness.focalSets.diligence.reasons
    .concat(loudness.focalSets.curiosity.reasons)
    .concat(loudness.focalSets.sociability.reasons)
    .concat(loudness.focalSets.caution.reasons)
    .slice(0, 8);
  const voice = selectVoice(loudness.loudness, loudness.fatigue, voiceReasons, {
    deterministic: state.config.debug,
  });
  rememberSelectedVoice(
    state.voiceFatigue as Parameters<typeof rememberSelectedVoice>[0],
    voice.selected,
  );
  state.lastVoiceSelection = voice;

  // 1g. 模式推进
  const api = pressureSnapshot.api;
  transitionMode(state.modeState, api, nowMs);

  // ── Phase 2: 纯管线 ──────────────────────────────────────────────────────

  const plan = await computeTickPlan(state, tick, nowMs, perceiveResult.eventCount, perceiveResult.events, pressureSnapshot, voice);

  // ── Phase 3: 副作用边界 ──────────────────────────────────────────────────

  const acted = applyPlan(state, plan, tick, nowMs, perceiveResult.events);

  // ── Phase 4: 记录 ────────────────────────────────────────────────────────

  try {
    repository.recordPressureSnapshot({
      tick,
      created_ms: nowMs,
      p1: pressureSnapshot.p1,
      p2: pressureSnapshot.p2,
      p3: pressureSnapshot.p3,
      p4: pressureSnapshot.p4,
      p5: pressureSnapshot.p5,
      p6: pressureSnapshot.p6,
      p7: pressureSnapshot.p7 ?? 0,
      p8: pressureSnapshot.p8 ?? 0,
      p_prospect: pressureSnapshot.pProspect,
      api: pressureSnapshot.api,
      api_peak: pressureSnapshot.apiPeak,
      contributions: pressureSnapshot.contributions,
    });
  } catch { /* ignore */ }

  try {
    repository.recordPersonalitySnapshot({
      tick,
      created_ms: nowMs,
      pi_d: state.personality.diligence,
      pi_c: state.personality.curiosity,
      pi_s: state.personality.sociability,
      pi_x: state.personality.caution,
    });
  } catch { /* ignore */ }

  logger.debug('Nova evolve tick completed', {
    tick,
    eventCount: perceiveResult.eventCount,
    mode: state.modeState.current,
    api: pressureSnapshot.api,
    acted,
    selectedVoice: voice.selected,
  });

  return acted;
}

// ── Phase 2: computeTickPlan ─────────────────────────────────────────────────

export async function computeTickPlan(
  state: EvolveState,
  tick: number,
  nowMs: number,
  eventCount: number,
  events: NovaPerturbation[],
  pressure: PressureSnapshot,
  voice: import('../voices/selection').VoiceSelectionResult,
): Promise<TickPlan> {
  const G = state.G;
  const config = state.config;

  const hour = chinaHour(nowMs);
  const isLateNight = hour >= 2 && hour < 7;

  // 1. 派生 desires（内源性，始终运行）
  let desires: Desire[] = [];
  try {
    desires = deriveDesires({
      pressure,
      reason: eventCount > 0 ? 'message' : 'scheduled',
      config,
      nowMs,
    });
  } catch (err) {
    state.logger.warn('Nova deriveDesires failed', err instanceof Error ? err.message : String(err));
  }

  // 构建候选列表
  const candidates: ActionCandidate[] = [];

  // 2a. 消息回复候选 — 仅当有消息事件且非深夜时
  if (events.length > 0 && !isLateNight) {
    const replyCandidates = buildReplyCandidates(state, events, pressure, voice, nowMs);
    candidates.push(...replyCandidates);
  }

  // 2b. Desire → proactive 候选
  for (const desire of desires) {
    if (desire.targetId) {
      candidates.push({
        action: desireToAction(desire.type),
        targetId: desire.targetId,
        desireType: desire.type,
        urgency: desire.urgency ?? 'medium',
        scene: resolveScene(G, desire.targetId),
        reason: desire.reason ?? `desire_${desire.type}`,
      });
    }
  }

  // IAUS 评分
  if (candidates.length > 0) {
    const scorerCtx: IAUSScorerContext = {
      world: G,
      personality: state.personality,
      pressure,
      nowMs,
      recentActions: state.recentActions.map((a) => ({
        ms: a.createdMs,
        action: a.actionType,
        target: a.targetId,
        status: a.status,
      })),
    };
    try {
      scoreCandidates(candidates, scorerCtx);
    } catch (err) {
      state.logger.warn('Nova scoreCandidates failed', err instanceof Error ? err.message : String(err));
    }
  }

  // 按评分排序
  candidates.sort((a, b) => (b.iausScore?.netValue ?? 0) - (a.iausScore?.netValue ?? 0));

  // 3. IAUS 评分（已在上方完成，此处省略）

  // 4. 按 netValue 排序（已在上方完成）

  // 5. Gate chain — 选最佳候选
  let selected: ActionCandidate | undefined;
  let gateDecision: GateDecision = defaultGateDenied();

  if (candidates.length > 0 && !isLateNight) {
    for (const candidate of candidates) {
      const channelId = candidate.targetId ?? '';
      const scene = candidate.scene ?? 'private';

      const gateResult = evaluateCandidateGateChain(state, candidate, pressure, voice, nowMs, scene, channelId);
      if (gateResult.allow) {
        selected = candidate;
        gateDecision = gateResult;
        break;
      }
      gateDecision = gateResult;
    }
  } else if (isLateNight && candidates.length > 0) {
    gateDecision = lateNightGate(hour);
  }

  // 6. 深夜抑制：即使有选中也丢弃
  if (isLateNight && selected) {
    selected = undefined;
  }

  const plan = createTickPlan({
    tick,
    reason: eventCount > 0 ? 'message' : 'scheduled',
    pressure,
    voice,
    gateDecision,
    nowMs,
  });

  // 填充额外字段
  plan.desires = desires;
  plan.candidates = candidates;
  if (selected) {
    plan.selected = selected;
  }

  // Agent gateway: 让决策 agent 在新 EVOLVE 管线中恢复作为最终决策者。
  // 带超时保护：防止 LLM 延迟导致系统长期阻塞。超时后回退到 algorithmic 决策。
  if (config.gatewayMode === 'agent' && config.decisionAgent.enabled && candidates.length > 0 && state.memoryService) {
    const agentDeadlineMs = 30_000; // 30 秒硬 deadline，超时则用 algorithmic 结果
    try {
      await Promise.race([
        applyDecisionAgentPlan(state, plan, events, nowMs),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('agent_decision_timeout')), agentDeadlineMs),
        ),
      ]);
    } catch (err) {
      if (err instanceof Error && err.message === 'agent_decision_timeout') {
        state.logger.warn('Nova decision agent timeout, using algorithmic fallback', {
          tick: plan.tick,
          reason: plan.reason,
          deadlineMs: agentDeadlineMs,
        });
        // plan.selected 保留了 algorithmic pipeline 的结果，直接使用
      } else {
        state.logger.warn('Nova decision agent error, using algorithmic fallback',
          err instanceof Error ? err.message : String(err));
      }
    }
  }

  return plan;
}

async function applyDecisionAgentPlan(
  state: EvolveState,
  plan: TickPlan,
  events: NovaPerturbation[],
  nowMs: number,
): Promise<void> {
  const decisionClient = state.getDecisionClient?.() as DecisionLLMClient | undefined;
  if (!decisionClient || !state.memoryService) return;

  const originalEvent = events.find((event) => event.event)?.event;
  const algorithmicGateAudit = state.config.auditAlgorithmicGates
    ? plan.candidates.map((candidate) => evaluateCandidateGateChain(
      state,
      candidate,
      plan.pressure,
      plan.voice,
      nowMs,
      candidate.scene ?? 'private',
      candidate.targetId ?? '',
    ))
    : undefined;

  // ── Build relationship context for candidate targets ──────────────────────
  const relationshipFacts = buildRelationshipFactsForCandidates(state.G, plan.candidates);
  const groupProfileSummary = buildGroupProfileSummaryForCandidates(state, plan.candidates);

  // ── Build mentioned-relationship facts (cross-target mentions) ─────────────
  const mentionedRelationshipFacts = buildMentionedRelationshipFacts(state.G, originalEvent);

  // ── Read afterward posture ────────────────────────────────────────────────
  const afterwardChannelId = originalEvent?.chatId ?? plan.candidates[0]?.targetId ?? undefined;
  const afterward = readAfterwardForChannel(afterwardChannelId, nowMs, state.repository);

  // ── Build situation briefing from sentiment ───────────────────────────────
  const situationBriefing = buildSituationBriefing(afterwardChannelId, nowMs, state);

  // ── Rhythm pattern ────────────────────────────────────────────────────────
  const rhythmPattern = afterwardChannelId
    ? summarizeRhythm(afterwardChannelId, state)
    : undefined;

  const decisionCtx = buildDecisionContext({
    tick: plan.tick,
    reason: plan.reason,
    nowMs,
    ...(originalEvent ? { event: originalEvent } : {}),
    pressure: plan.pressure,
    voice: plan.voice,
    desires: plan.desires,
    candidates: plan.candidates,
    world: state.G,
    repository: state.repository,
    memoryService: state.memoryService,
    ...(state.moodTracker ? { moodTracker: state.moodTracker } : {}),
    config: state.config,
    ...(algorithmicGateAudit ? { algorithmicGateAudit } : {}),
    ...(relationshipFacts.length > 0 ? { relationshipFacts } : {}),
    ...(groupProfileSummary ? { groupProfileSummary } : {}),
    ...(mentionedRelationshipFacts.size > 0 ? { mentionedRelationshipFacts } : {}),
    ...(afterward ? { afterward } : {}),
    ...(situationBriefing ? { situationBriefing } : {}),
    ...(rhythmPattern ? { rhythmPattern } : {}),
  });

  let decision = await decideWithFallback(decisionClient, decisionCtx);
  if (plan.reason !== 'message' && (decision.action === 'reply' || decision.action === 'ask')) {
    decision = {
      ...decision,
      action: 'wait_reply',
      generateText: false,
      reason: 'scheduled tick cannot reply to old messages; waiting/observing instead.',
      afterward: 'watching',
      tags: [...(decision.tags ?? []), 'scheduled_reply_blocked'],
    };
  }
  plan.decisionAgent = buildDecisionTrace(decision, state.config.decisionAgent.model, false);
  if (algorithmicGateAudit) {
    plan.algorithmicGateAudit = algorithmicGateAudit;
  }

  switch (decision.action) {
    case 'reply':
    case 'ask': {
      if (plan.reason !== 'message' || !originalEvent) {
        plan.selected = undefined;
        plan.silenceReason = 'decision_reply_without_message_event';
        plan.gateDecision = {
          allow: false,
          level: 'normal',
          reason: 'DECISION_REPLY_WITHOUT_MESSAGE_EVENT',
          reasons: ['DECISION_REPLY_WITHOUT_MESSAGE_EVENT'],
          values: { decisionReason: decision.reason },
        };
        break;
      }

      const selected = resolveDecisionCandidate(plan.candidates, decision, decisionCtx) ?? {
        action: decision.action,
        targetId: decision.targetId ?? originalEvent.chatId,
        desireType: originalEvent.isDirected ? 'directed_reply' : 'reply',
        urgency: originalEvent.isDirected ? 'high' : 'medium',
        scene: originalEvent.chatType,
        reason: `agent_decision: ${decision.reason}`,
      };
      plan.selected = {
        ...selected,
        action: selected.action === 'sociability' || selected.action === 'diligence' ? selected.action : decision.action,
        reason: `agent_decision: ${decision.reason}`,
      };
      plan.gateDecision = {
        allow: true,
        level: 'none',
        reason: 'agent_reply',
        reasons: ['agent_reply'],
        values: { decisionReason: decision.reason },
      };
      plan.silenceReason = undefined;
      break;
    }
    case 'proactive': {
      const selected = resolveDecisionCandidate(plan.candidates, decision, decisionCtx);
      if (selected) {
        plan.selected = selected;
        plan.gateDecision = {
          allow: true,
          level: 'none',
          reason: 'agent_proactive',
          reasons: ['agent_proactive'],
          values: { decisionReason: decision.reason },
        };
        plan.silenceReason = undefined;
      }
      break;
    }
    case 'silence':
    case 'observe':
    case 'wait_reply':
    case 'cool_down':
    default:
      plan.selected = undefined;
      plan.silenceReason = `decision_${decision.action}`;
      plan.gateDecision = {
        allow: false,
        level: decision.action === 'cool_down' ? 'normal' : 'soft',
        reason: `DECISION_${decision.action.toUpperCase()}`,
        reasons: [`DECISION_${decision.action.toUpperCase()}`],
        values: { decisionReason: decision.reason },
      };
      break;
  }

  state.logger.debug('Nova evolve decision agent', {
    tick: plan.tick,
    reason: plan.reason,
    decisionAction: decision.action,
    decisionReason: decision.reason,
    confidence: decision.confidence,
    selected: plan.selected?.action ?? 'none',
    targetId: plan.selected?.targetId ?? decision.targetId,
    silenceReason: plan.silenceReason,
  });
}

async function decideWithFallback(
  client: DecisionLLMClient,
  context: DecisionContext,
): Promise<DecisionAgentResponse> {
  try {
    return await client.decide(context);
  } catch {
    return createFallbackResponse(context, 'decide_throw');
  }
}

function buildDecisionTrace(
  decision: DecisionAgentResponse,
  model: string | undefined,
  fallbackUsed: boolean,
): DecisionAgentTrace {
  return {
    enabled: true,
    ...(model ? { model } : {}),
    action: decision.action,
    candidateId: decision.candidateId,
    targetId: decision.targetId,
    generateText: decision.generateText,
    responderIntent: decision.responderIntent,
    reason: decision.reason,
    confidence: decision.confidence,
    afterward: decision.afterward,
    tags: decision.tags,
    stateUpdates: decision.stateUpdates,
    fallbackUsed,
  };
}

function resolveDecisionCandidate(
  candidates: ActionCandidate[],
  decision: DecisionAgentResponse,
  decisionCtx: DecisionContext,
): ActionCandidate | undefined {
  if (decision.candidateId) {
    const index = decisionCtx.candidates.findIndex((candidate) => candidate.id === decision.candidateId);
    if (index >= 0) return candidates[index];
  }
  if (decision.targetId) {
    return candidates.find((candidate) => candidate.targetId === decision.targetId);
  }
  return undefined;
}


// ── Phase 3: applyPlan ──────────────────────────────────────────────────────

export function applyPlan(
  state: EvolveState,
  plan: TickPlan,
  tick: number,
  nowMs: number,
  events?: NovaPerturbation[],
): boolean {
  if (plan.selected) {
    const pressureSnapshot = plan.pressure;

    // 判断动作类型：reply（有原始消息事件且 desireType 包含 reply）vs proactive
    const isReply = plan.reason === 'message'
      && (plan.selected.desireType === 'directed_reply' || plan.selected.desireType === 'reply');
    const kind: 'reply' | 'proactive' = isReply ? 'reply' : 'proactive';

    // 对于 reply 类型，找到匹配的原始事件
    let originalEvent: import('../core/types').NovaMessageEvent | undefined;
    if (isReply && events && plan.selected.targetId) {
      const matchingEvent = events.find(
        (e) => e.channelId === plan.selected!.targetId,
      );
      originalEvent = matchingEvent?.event;
    }

    const enqueued = state.queue.enqueue(
      plan.selected,
      tick,
      nowMs,
      plan.selected.reason,
      {
        pressureSnapshot,
        contributions: (pressureSnapshot.contributions ?? {}) as Record<string, number[]>,
        focalEntities: plan.selected.targetId ? [plan.selected.targetId] : undefined,
        reason: plan.selected.reason,
        kind,
        originalEvent,
        ...(plan.decisionAgent ? {
          decision: {
            action: plan.decisionAgent.action ?? plan.selected.action,
            reason: plan.decisionAgent.reason ?? '',
            confidence: plan.decisionAgent.confidence ?? 0,
            ...(plan.decisionAgent.responderIntent ? { responderIntent: plan.decisionAgent.responderIntent } : {}),
            ...(plan.decisionAgent.candidateId ? { candidateId: plan.decisionAgent.candidateId } : {}),
          },
        } : {}),
      },
    );

    if (enqueued) {
      state.lastEnqueuedAction = enqueued;

      state.logger.info('Nova action enqueued', {
        queueId: enqueued.id,
        tick,
        action: plan.selected.action,
        targetId: plan.selected.targetId,
        desireType: plan.selected.desireType,
      });
      return true;
    }

    state.logger.warn('Nova action rejected by queue', {
      tick,
      action: plan.selected.action,
      targetId: plan.selected.targetId,
      reason: 'queue_full_or_evicted',
    });
  }

  // 记录 silence
  if (!plan.gateDecision.allow) {
    try {
      state.repository.recordSilence(buildSilenceLogEntry({
        tick,
        targetId: plan.selected?.targetId ?? 'evolve',
        decision: plan.gateDecision,
        context: {
          nowMs,
          reason: plan.reason,
          pressure: plan.pressure,
          voice: plan.voice,
          config: state.config,
          rateLimit: state.rateLimit,
          lambdaMultiplier: 1.0,
        },
      }));
      state.silenceCount += 1;
    } catch { /* ignore */ }
  }

  return false;
}

// ── Gate chain evaluation ────────────────────────────────────────────────────

function evaluateCandidateGateChain(
  state: EvolveState,
  candidate: ActionCandidate,
  pressure: PressureSnapshot,
  voice: import('../voices/selection').VoiceSelectionResult,
  nowMs: number,
  scene: 'private' | 'group',
  channelId: string,
): GateDecision {
  const config = state.config;
  const isReply = candidate.desireType === 'directed_reply' || candidate.desireType === 'reply';

  // 1. Proactive enabled（仅对非回复候选检查）
  if (!isReply) {
    const proactiveGate = evaluateProactiveEnabledGate(config);
    if (proactiveGate) return proactiveGate;
  }

  // 2. Scheduled actions enabled（仅对非回复候选检查）
  if (!isReply && !config.enableScheduledActions) {
    const reason = SILENCE_REASONS.SCHEDULED_ACTIONS_DISABLED;
    return { allow: false, level: 'hard', reason, reasons: [reason], values: {} };
  }

  // 3. Whitelist check for private proactive targets
  if (!isReply && scene === 'private' && channelId) {
    const whitelistGate = evaluateWhitelistGate(channelId, null, config.proactiveWhitelistQQ);
    if (whitelistGate) return whitelistGate;
  }

  // 4. Group policy check for group targets
  if (scene === 'group' && channelId) {
    const channel = state.G.has(channelId) && state.G.getNodeType(channelId) === 'channel'
      ? state.G.getChannel(channelId)
      : undefined;
    const groupPolicyResult = evaluateGroupPolicy({
      channel,
      config,
      nowMs,
    });
    if (groupPolicyResult) {
      return {
        allow: false, level: groupPolicyResult.level,
        reason: groupPolicyResult.reason,
        reasons: [groupPolicyResult.reason],
        values: groupPolicyResult.values,
      };
    }
  }

  // 5. Cautious voice check
  const cautionGate = evaluateCautionGate({
    nowMs,
    reason: isReply ? 'message' : 'scheduled',
    pressure,
    voice,
    config,
    rateLimit: state.rateLimit,
    lambdaMultiplier: 1.0,
  });
  if (cautionGate) return cautionGate;

  // 6. Engagement state check
  const engagementGate = evaluateEngagementState(channelId, {
    nowMs,
    reason: isReply ? 'message' : 'scheduled',
    pressure,
    voice,
    config: state.config,
    rateLimit: state.rateLimit,
    lambdaMultiplier: 1.0,
    actionQueue: state.queue,
  });
  if (engagementGate) return engagementGate;

  // 7. QQ risk / rate limit
  const qqRisk = evaluateQQRisk({
    nowMs,
    reason: isReply ? 'message' : 'scheduled',
    pressure,
    voice,
    config,
    rateLimit: state.rateLimit,
    lambdaMultiplier: 1.0,
  });
  if (!qqRisk.pass) {
    return { allow: false, level: qqRisk.level, reason: qqRisk.reason, reasons: [qqRisk.reason], values: qqRisk.values };
  }

  // 8. Active cooling (per-channel cooldown)
  if (channelId && state.G.has(channelId) && state.G.getNodeType(channelId) === 'channel') {
    const channel = state.G.getChannel(channelId);
    const coolingGate = evaluateActiveCooling({
      nowMs,
      reason: isReply ? 'message' : 'scheduled',
      pressure,
      voice,
      config,
      rateLimit: state.rateLimit,
      lambdaMultiplier: 1.0,
      channel,
    });
    if (coolingGate) return coolingGate;
  }

  // 9. API floor
  const apiFloorGate = evaluateApiFloor({
    nowMs,
    reason: isReply ? 'message' : 'scheduled',
    pressure,
    voice,
    config,
    rateLimit: state.rateLimit,
    lambdaMultiplier: 1.0,
    event: isReply ? { isDirected: candidate.desireType === 'directed_reply' } as Parameters<typeof evaluateApiFloor>[0]['event'] : undefined,
  });
  if (apiFloorGate) return apiFloorGate;

  // 10. Social value check
  if (candidate.iausScore && (candidate.iausScore.netValue ?? 0) < config.minProactiveUtility) {
    const reason = SILENCE_REASONS.SOCIAL_VALUE_NEGATIVE;
    return { allow: false, level: 'hard', reason, reasons: [reason], values: { netValue: candidate.iausScore.netValue, minUtility: config.minProactiveUtility } };
  }

  return { allow: true, level: 'none', reason: SILENCE_REASONS.ALLOWED, reasons: [SILENCE_REASONS.ALLOWED], values: {} };
}

// ── buildReplyCandidates ──────────────────────────────────────────────────────

function buildReplyCandidates(
  state: EvolveState,
  events: NovaPerturbation[],
  pressure: PressureSnapshot,
  _voice: import('../voices/selection').VoiceSelectionResult,
  _nowMs: number,
): ActionCandidate[] {
  const candidates: ActionCandidate[] = [];
  const seen = new Set<string>();

  // 按 directed 优先排序
  const sorted = [...events].sort((a, b) => {
    if (a.isDirected !== b.isDirected) return a.isDirected ? -1 : 1;
    return b.timestamp - a.timestamp;
  });

  for (const p of sorted) {
    if (seen.has(p.channelId)) continue;
    seen.add(p.channelId);

    if (!p.isDirected && pressure.api < state.config.minApiToSpeak) continue;

    const channel = state.G.has(p.channelId) && state.G.getNodeType(p.channelId) === 'channel'
      ? state.G.getChannel(p.channelId)
      : undefined;
    const scene: 'private' | 'group' = channel?.chat_type === 'group' ? 'group' : 'private';

    candidates.push({
      action: scene === 'private' ? 'sociability' : 'diligence',
      targetId: p.channelId,
      desireType: p.isDirected ? 'directed_reply' : 'reply',
      urgency: p.isDirected ? 'high' : 'medium',
      scene,
      reason: p.isDirected
        ? `directed_message_from_${p.senderId ?? 'unknown'}`
        : `ambient_message_from_${p.senderId ?? 'unknown'}`,
    });
  }

  return candidates;
}

// ── Gate helpers ──────────────────────────────────────────────────────────────

function defaultGateDenied(): GateDecision {
  return {
    allow: false,
    level: 'normal',
    reason: SILENCE_REASONS.ALL_CANDIDATES_DENIED,
    reasons: [SILENCE_REASONS.ALL_CANDIDATES_DENIED],
    values: {},
  };
}

function lateNightGate(hour: number): GateDecision {
  const reason = 'late_night_suppression';
  return {
    allow: false,
    level: 'hard',
    reason,
    reasons: [reason],
    values: { hour },
  };
}

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

function resolveScene(G: WorldModel, targetId: string): 'private' | 'group' | undefined {
  if (!G.has(targetId)) return undefined;
  if (G.getNodeType(targetId) === 'channel') {
    return G.getChannel(targetId).chat_type as 'private' | 'group';
  }
  return 'private';
}

function desireToAction(desireType: string): string {
  const map: Record<string, string> = {
    reconnect: 'sociability',
    check_in: 'diligence',
    share_news: 'curiosity',
    explore_gap: 'curiosity',
    comfort: 'sociability',
    celebrate: 'sociability',
    remind: 'diligence',
  };
  return map[desireType] ?? 'diligence';
}

function tickConversations(G: WorldModel, nowMs: number): void {
  try {
    const convIds = G.getEntitiesByType('conversation');
    for (const convId of convIds) {
      const conv = G.getConversation(convId);
      if (conv.state === 'active') {
        const lastEventMs = conv.last_activity_ms ?? 0;
        const idleMs = nowMs - lastEventMs;
        if (idleMs > 30 * 60 * 1000) {
          (conv as unknown as Record<string, unknown>).state = 'idle';
        }
      }
    }
  } catch { /* ignore */ }
}

// ── Decision agent context helpers ───────────────────────────────────────────

/** Build relationship facts for the top candidate targets. */
function buildRelationshipFactsForCandidates(
  G: WorldModel,
  candidates: ActionCandidate[],
): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.targetId) continue;
    // Resolve the contact node from the target (which may be a channel)
    const contactId = resolveContactFromTarget(G, candidate.targetId);
    if (!contactId || seen.has(contactId)) continue;
    seen.add(contactId);
    const contact = G.getContact(contactId);
    const displayName = contact.name ?? contact.nickname ?? contact.qq ?? contactId;
    const rv = readRV(contact);
    const velocity = readVelocity(contact);
    const rendered = renderRelationshipFacts(rv, velocity, displayName);
    if (rendered) facts.push(rendered);
  }
  return facts.slice(0, 5);
}

/** Build group profile summary for group candidates. */
function buildGroupProfileSummaryForCandidates(
  state: EvolveState,
  candidates: ActionCandidate[],
): string | null {
  for (const candidate of candidates) {
    if (candidate.scene !== 'group' || !candidate.targetId) continue;
    if (!state.G.has(candidate.targetId) || state.G.getNodeType(candidate.targetId) !== 'channel') continue;
    const channel = state.G.getChannel(candidate.targetId);
    const groupId = channel.group_id;
    if (!groupId) continue;
    const profile = state.repository.getGroupProfile(groupId);
    if (profile) {
      const summary = generateGroupProfileSummary(profile);
      if (summary) return summary;
    }
    return null;
  }
  return null;
}

/** Build mentioned-relationship facts for cross-target @mentions. */
function buildMentionedRelationshipFacts(
  G: WorldModel,
  event?: NovaMessageEvent,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!event?.mentionedContactIds) return result;
  for (const contactId of event.mentionedContactIds) {
    if (!G.has(contactId) || G.getNodeType(contactId) !== 'contact') continue;
    const contact = G.getContact(contactId);
    const displayName = contact.name ?? contact.nickname ?? contact.qq ?? contactId;
    const rv = readRV(contact);
    const velocity = readVelocity(contact);
    const rendered = renderRelationshipFacts(rv, velocity, displayName);
    if (rendered) result.set(contactId, [rendered]);
  }
  return result;
}

/** Resolve a contact ID from a target (which may be a channel node). */
function resolveContactFromTarget(G: WorldModel, targetId: string): string | undefined {
  if (!G.has(targetId)) return undefined;
  const nodeType = G.getNodeType(targetId);
  if (nodeType === 'contact') return targetId;
  if (nodeType === 'channel') {
    const channel = G.getChannel(targetId);
    if (channel.chat_type === 'private') {
      const qqId = targetId.split(':').pop();
      if (qqId) {
        const contactId = `qq:user:${qqId}`;
        if (G.has(contactId) && G.getNodeType(contactId) === 'contact') return contactId;
      }
    }
  }
  return undefined;
}

/** Read afterward state for a channel. */
function readAfterwardForChannel(
  channelId: string | undefined,
  nowMs: number,
  repository: NovaWorldRepository,
): string | undefined {
  if (!channelId) return undefined;
  const key = `last_afterward:${channelId}`;
  const raw = repository.getRuntimeState<{ value?: string; expiresAt?: number }>(key);
  if (!raw || typeof raw.value !== 'string' || raw.value === 'done') return undefined;
  if (typeof raw.expiresAt === 'number' && nowMs >= raw.expiresAt) {
    repository.setRuntimeState(key, { value: 'done', clearedAt: nowMs, note: 'expired_afterward_ctx' }, nowMs);
    return undefined;
  }
  return raw.value;
}

/** Build situation briefing from recent sentiment data. */
function buildSituationBriefing(
  channelId: string | undefined,
  nowMs: number,
  state: EvolveState,
): string[] | undefined {
  if (!channelId) return undefined;
  try {
    const sentiment = state.repository.getRuntimeState<{
      valence: number;
      confidence: number;
      updatedAt: number;
    }>(`last_sentiment:${channelId}`);
    if (!sentiment || (nowMs - sentiment.updatedAt) > 5 * 60 * 1000) return undefined;
    const briefing: string[] = [];
    if (sentiment.valence < -0.3 && sentiment.confidence > 0.5) {
      briefing.push('对方似乎心情不太好——Nova 的情绪被轻轻往下拉了一点。');
    } else if (sentiment.valence > 0.3 && sentiment.confidence > 0.5) {
      briefing.push('对方似乎心情很好——Nova 也感到了一点轻快的暖意。');
    }
    return briefing.length > 0 ? briefing : undefined;
  } catch {
    return undefined;
  }
}

/** Summarize recent message rhythm for a channel. */
function summarizeRhythm(
  channelId: string,
  state: EvolveState,
): string | undefined {
  try {
    const nowMs = Date.now();
    const recentMessages = state.repository.getRecentMessages(channelId, 8);
    if (recentMessages.length < 3) return undefined;
    const recentCount = recentMessages.filter(
      (m) => (nowMs - m.timestamp) < 10 * 60 * 1000,
    ).length;
    if (recentCount >= 5) return 'active_exchange';
    if (recentCount >= 2) return 'steady';
    return 'slow';
  } catch {
    return undefined;
  }
}
