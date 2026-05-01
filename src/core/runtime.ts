import type { NovaLogger } from './logger';
import { noopLogger } from './logger';
import type { NovaAction, NovaMessageEvent, NovaRuntimeConfig } from './types';
import { NovaResponder } from '../act/responder';
import { ActionQueue, type QueuedAction } from '../act/action-queue';
import { ActLoop, type ActExecutor, type ActLoopTickResult } from '../act/act-loop';
import { openNovaDb, type NovaDbConnection } from '../db/sqlite';
import { runEvolveTick, type EvolveResult } from '../engine/evolve';
import { RateLimitState } from '../gates/rate-limit';
import { SILENCE_REASONS } from '../gates/gates';
import { buildSilenceLogEntry } from '../gates/silence-log';
import { LongTermMemory } from '../memory/long-term-memory';
import { MemoryService } from '../memory/memory-service';
import { WorkingMemory } from '../memory/working-memory';
import { DEFAULT_PERSONALITY_VECTOR, projectPersonalityVector, type PersonalityVector } from '../personality/vector';
import { DEFAULT_PERSONALITY_DRIFT_OPTIONS, evolvePersonality, type PersonalityDriftOptions, type PersonalityFeedback } from '../personality/drift';
import { computeLoudness, recordVoiceWin, type VoiceFatigueState } from '../voices/loudness';
import { selectVoice, type VoiceSelectionResult } from '../voices/selection';
import { MoodTracker } from '../engine/mood';
import { buildSituationBriefing, checkSpeakingAlone, detectRhythmPattern } from '../engine/situation-briefing';
import { AdaptiveKappa, computeAllPressures, createPressureHistory, toPressureSnapshot, type AllPressures, type PressureHistory, type PressureSnapshot } from '../pressure/aggregate';
import { DEFAULT_KAPPA, conversationIdForChannel, qqIdFromNodeId } from '../world/constants';
import type { ChannelAttrs } from '../world/entities';
import { NovaWorldRepository } from '../world/repository';
import type { WorldModel } from '../world/model';
import { buildTickTraceFromEvolve, buildActionTrace, buildDeliberationTrace, buildLlmStateWritebackSummary } from '../trace/writer';
import type { NovaTickTrace, NovaActionTrace, NovaDeliberationTrace } from '../trace/types';
import type { StateWritebackResult } from '../llm/state-writeback';

function inferIAUSActionFromActionLog(actionType: string): 'diligence' | 'curiosity' | 'sociability' {
  if (actionType.includes('curiosity') || actionType.includes('explore')) return 'curiosity';
  if (actionType.includes('sociability') || actionType.includes('reconnect')) return 'sociability';
  return 'diligence';
}

interface PressureTickContext {
  nowMs: number;
  reason: 'message' | 'scheduled';
  eventId?: string;
  channelId?: string;
  senderId?: string;
  directed?: boolean;
}

interface PressureTickResult {
  pressure: PressureSnapshot;
  voice: VoiceSelectionResult;
}

export interface NovaRuntimeOptions {
  config: NovaRuntimeConfig;
  logger?: NovaLogger;
  selfId?: string;
  startedAt?: number;
}

export interface NovaRuntimeStatus {
  online: boolean;
  initialized: boolean;
  selfId?: string;
  startedAt?: number;
  processedMessages: number;
  sentActions: number;
  silenceCount: number;
  lastTickAt?: number;
  lastError?: string;

function readChannelAfterwardForContext(
  channelId: string,
  nowMs: number,
  repository: NovaWorldRepository,
): string | undefined {
  const key = `last_afterward:${channelId}`;
  const raw = repository.getRuntimeState<{ value?: string; expiresAt?: number }>(key);
  if (!raw || typeof raw.value !== 'string' || raw.value === 'done') return undefined;
  // Check expiration: when TTL has passed, treat as expired (clean up)
  if (typeof raw.expiresAt === 'number' && nowMs >= raw.expiresAt) {
    repository.setRuntimeState(key, {
      value: 'done',
      clearedAt: nowMs,
      note: 'expired_afterward_ctx',
    }, nowMs);
    return undefined;
  }
  return raw.value;
}

/**
 * 从 LLM state writeback 结果中提取 deliberation trace 所需的
 * llmStateUpdatesAccepted / llmStateUpdatesRejected 信息。
 *
 * Step 10: deliberation trace 现在记录 LLM 状态写回的完整审计信息。
 */
function extractDeliberationWritebackContext(stateWriteback?: StateWritebackResult): {
  llmStateUpdatesAccepted?: unknown;
  llmStateUpdatesRejected?: unknown;
} {
  if (!stateWriteback) return {};
  const result: { llmStateUpdatesAccepted?: unknown; llmStateUpdatesRejected?: unknown } = {};
  if (stateWriteback.accepted.length > 0) result.llmStateUpdatesAccepted = stateWriteback.accepted;
  if (stateWriteback.rejected.length > 0) result.llmStateUpdatesRejected = stateWriteback.rejected;
  return result;
}

/**
 * 从 LLM state writeback 结果中提取 deliberation trace 所需的
 * afterward / selfMoodBefore / selfMoodAfter 信息。
 *
 * Step 4: selfMoodBefore / selfMoodAfter 现在是 SelfMoodSnapshot 对象，
 * 从中提取 .valence 用于 trace。
 */
function extractDeliberationMoodContext(stateWriteback?: StateWritebackResult): {
  afterward?: string;
  selfMoodBefore?: number;
  selfMoodAfter?: number;
} {
  if (!stateWriteback) return {};
  // Prefer top-level result fields (populated by applyNovaStateUpdates directly).
  const result: { afterward?: string; selfMoodBefore?: number; selfMoodAfter?: number } = {};
  if (stateWriteback.afterward) result.afterward = stateWriteback.afterward;

  // Step 4: selfMoodBefore/selfMoodAfter are now SelfMoodSnapshot objects.
  if (stateWriteback.selfMoodBefore && typeof stateWriteback.selfMoodBefore === 'object') {
    result.selfMoodBefore = stateWriteback.selfMoodBefore.valence;
  }
  if (stateWriteback.selfMoodAfter && typeof stateWriteback.selfMoodAfter === 'object') {
    result.selfMoodAfter = stateWriteback.selfMoodAfter.valence;
  }

  // Fallback: scan accepted entries for backward compatibility.
  if (!result.afterward || result.selfMoodBefore === undefined || result.selfMoodAfter === undefined) {
    for (const entry of stateWriteback.accepted) {
      if (entry.type === 'afterward' && !result.afterward) {
        const n = entry.normalized as Record<string, unknown> | undefined;
        if (n && typeof n.value === 'string') result.afterward = n.value;
      }
      if (entry.type === 'self_mood') {
        const n = entry.normalized as Record<string, unknown> | undefined;
        if (result.selfMoodBefore === undefined && n && typeof n.before === 'number') result.selfMoodBefore = n.before;
        if (result.selfMoodAfter === undefined && n && typeof n.after === 'number') result.selfMoodAfter = n.after;
      }
    }
  }
  return result;
}

function sanitizeRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(api[-_ ]?key|authorization|token|secret)(["'\s:=]+)[^\s,"'}]+/gi, '$1$2[redacted]')
    .slice(0, 500);
}

/**
 * 为被动回复构建 action reasoning 摘要（Step 18）。
 * 由结构化数据生成，不让 LLM 编造。
 */
function buildReplyActionReasoning(
  input: RuntimeActionRecordInput,
  evolve: EvolveResult | null,
): string {
  const plan = evolve?.tickPlan;
  if (!plan) return `reply: ${input.status}`;

  const parts: string[] = [];
  parts.push(`reply: gate=${plan.gateDecision.reason}`);
  parts.push(`voice=${plan.voice.selected}`);
  if (plan.voice.iausAction) {
    parts.push(`iaus=${plan.voice.iausAction}`);
  }
  parts.push(`api=${plan.pressure.api.toFixed(2)}`);
  parts.push(`directed=${plan.gateDecision.values.directed ?? 'unknown'}`);
  if (input.text) {
    parts.push(`textLen=${input.text.length}`);
  }
  return parts.join(', ');
}

/**
 * 为主动消息构建 action reasoning 摘要（Step 18）。
 * 由结构化数据生成，不让 LLM 编造。
 */
function buildProactiveActionReasoning(
  input: RuntimeActionRecordInput,
  voice: VoiceSelectionResult | null,
): string {
  const parts: string[] = [];
  parts.push('proactive');
  parts.push(`action=${input.actionType}`);
  if (input.desireType) {
    const urgencyLabel = input.urgency ? ` (urgency=${input.urgency})` : '';
    parts.push(`desire=${input.desireType}${urgencyLabel}`);
  }
  parts.push(`target=${input.targetId}`);
  if (voice) {
    parts.push(`voice=${voice.selected}`);
  }
  if (input.text) {
    parts.push(`textLen=${input.text.length}`);
  }
  parts.push(`status=${input.status}`);
  if (input.error) {
    parts.push(`error=${input.error.slice(0, 80)}`);
  }
  return parts.join(', ');
}
