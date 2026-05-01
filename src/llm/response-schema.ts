import type { NovaMessageEvent } from '../core/types';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { PersonalityVector } from '../personality/vector';
import type { VoiceSelectionResult } from '../voices/selection';

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs?: number;
}

export interface NovaPromptRecentMessage {
  senderName?: string;
  text: string;
  isNova?: boolean;
}

export interface NovaPromptInput {
  event: NovaMessageEvent;
  recentMessages: NovaPromptRecentMessage[];
  selectedVoice: VoiceSelectionResult;
  pressure: PressureSnapshot;
  personality: PersonalityVector;
  workingMemory: string[];
  longTermMemory: string[];
  relationshipFacts?: string[];
  groupProfileSummary?: string | null;
  maxReplyLength: number;
  /** Wall-clock timestamp (ms) for time-of-day awareness. */
  nowMs?: number;
  /** Self mood in [-1, 1] for mood-aware replies. */
  selfMood?: number;
  /** Natural-language situation briefing lines (from pressure field). */
  situationBriefing?: string[];
  /** Rhythm pattern label (e.g. "busy", "quiet", "calming_down"). */
  rhythmPattern?: string;
  /** True when Nova has been talking without receiving a reply in this channel. */
  speakingAlone?: boolean;
}

// ── Proactive prompt input (Step 12) ─────────────────────────────────────

/**
 * 主动消息 prompt 输入。与 NovaPromptInput 的关键区别是不依赖
 * NovaMessageEvent —— 所有上下文来自 world / memory / thread / desire。
 *
 * 不给 LLM 的内容：pressure raw number、gate reason、whitelist、IAUS score、
 * "你被允许主动发言"。
 */
export interface NovaProactivePromptInput {
  /** 目标对象的展示名（昵称或备注） */
  targetName: string;
  /** 目标对象的 QQ 号 */
  targetQQ: string;
  /** 私聊还是群聊 */
  scene: 'private' | 'group';
  /** 当前声部选择结果 */
  selectedVoice: VoiceSelectionResult;
  /** desire 类型 */
  desireType: string;
  /** desire 紧迫度 */
  desireUrgency: string;
  /** 近期消息历史 */
  recentMessages: NovaPromptRecentMessage[];
  /** 工作记忆内容 */
  workingMemory: string[];
  /** 长期记忆内容 */
  longTermMemory: string[];
  /** 关系向量自然语言事实 */
  relationshipFacts?: string[];
  /** 群画像摘要（群聊场景） */
  groupProfileSummary?: string | null;
  /** 活跃叙事线程摘要 */
  activeThreads?: string[];
  /** 回复最大长度 */
  maxReplyLength: number;
  /** Wall-clock timestamp (ms) for time-of-day awareness. */
  nowMs?: number;
  /** Self mood in [-1, 1] for mood-aware replies. */
  selfMood?: number;
  /** Natural-language situation briefing lines (from pressure field). */
  situationBriefing?: string[];
  /** Rhythm pattern label. */
  rhythmPattern?: string;
  /** True when Nova has been talking without receiving a reply. */
  speakingAlone?: boolean;
}

export type NovaAfterward = 'done' | 'waiting_reply' | 'watching' | 'cooling_down';

export type NovaStateUpdate =
  | {
      type: 'self_mood';
      valence: number;
      arousal?: number;
      reason?: string;
    }
  | {
      type: 'memory_note';
      content: string;
      salience?: number;
      reason?: string;
    }
  | {
      type: 'thread_note';
      summary: string;
      channelId?: string;
      weight?: number;
      reason?: string;
    }
  | {
      type: 'afterward';
      value: NovaAfterward;
      reason?: string;
    };

export interface NovaLLMResponse {
  text: string;
  memoryCandidate?: string;
  tone?: string;
  confidence?: number;
  stateUpdates?: NovaStateUpdate[];
}

export type LLMFailureCode =
  | 'missing_config'
  | 'network_error'
  | 'auth_error'
  | 'timeout'
  | 'bad_status'
  | 'bad_response'
  | 'empty_response';

export class LLMGenerationError extends Error {
  constructor(
    readonly code: LLMFailureCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LLMGenerationError';
  }
}
