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
  maxReplyLength: number;
}

export interface NovaLLMResponse {
  text: string;
  memoryCandidate?: string;
  tone?: string;
  confidence?: number;
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
