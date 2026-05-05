//
// Decision LLM client — independent OpenAI-compatible client for the decision agent.
//
// Uses a separate LLM config from the main reply-generation LLM.
// Never reads llmModel/llmApiKey/llmBaseUrl — only uses DecisionAgentConfig.
//
// Retry:
//   - Exponential backoff with full jitter (2s → 8s → 32s base, ±50% jitter).
//   - Timeout / network_error are retryable; auth / parse errors are not.
//

import type { DecisionAgentConfig } from '../core/types';
import type { DecisionContext, DecisionAgentResponse } from './decision-schema';
import { buildDecisionMessages } from './decision-prompts';
import { validateDecisionResponse, createFallbackResponse } from './decision-validator';

export interface DecisionLLMClient {
  decide(input: DecisionContext): Promise<DecisionAgentResponse>;
}

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

export class DecisionLLMError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DecisionLLMError';
  }
}

/** Maximum retry attempts (not counting the initial call). */
const MAX_RETRIES = 2;

/** Base delays for exponential backoff: attempt 0 → 2s, attempt 1 → 8s. */
const RETRY_BASE_DELAYS_MS = [2_000, 8_000];

/** Error codes that are safe to retry. */
const RETRYABLE_CODES = new Set(['timeout', 'network_error', 'empty_response']);

export class OpenAICompatibleDecisionClient implements DecisionLLMClient {
  constructor(private readonly config: DecisionAgentConfig) {}

  async decide(input: DecisionContext): Promise<DecisionAgentResponse> {
    if (!this.config.enabled) {
      return createFallbackResponse(input, 'decision_agent_disabled');
    }
    if (!this.config.baseUrl || !this.config.apiKey || !this.config.model) {
      return createFallbackResponse(input, 'decision_agent_missing_config');
    }

    const messages = buildDecisionMessages(input);
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.callLLM(messages);
        const parsed = this.parseResponse(response);
        const result = validateDecisionResponse(parsed, input);
        return result.normalized;
      } catch (error) {
        lastError = error;
        if (error instanceof DecisionLLMError && RETRYABLE_CODES.has(error.code) && attempt < MAX_RETRIES) {
          const delay = jitter(RETRY_BASE_DELAYS_MS[attempt] ?? RETRY_BASE_DELAYS_MS[RETRY_BASE_DELAYS_MS.length - 1]!);
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    return this.handleError(lastError, input);
  }

  private async callLLM(messages: Array<{ role: string; content: string }>): Promise<string> {
    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? 60_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = completionsUrl(this.config.baseUrl);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new DecisionLLMError('auth_error', 'Decision LLM authentication failed', response.status);
      }
      if (!response.ok) {
        throw new DecisionLLMError('bad_status', `Decision LLM request failed with HTTP ${response.status}`, response.status);
      }

      const body = await response.json() as OpenAIChatCompletionResponse;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new DecisionLLMError('empty_response', 'Decision LLM returned empty content');
      }

      return content;
    } catch (error) {
      if (error instanceof DecisionLLMError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new DecisionLLMError('timeout', 'Decision LLM request timed out');
      }
      throw new DecisionLLMError('network_error', error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseResponse(content: string): unknown {
    const trimmed = stripMarkdownFence(content.trim());
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]) as unknown;
        } catch {
          // fall through
        }
      }
      throw new DecisionLLMError('parse_error', 'Failed to parse decision LLM JSON response');
    }
  }

  private handleError(error: unknown, input: DecisionContext): DecisionAgentResponse {
    if (error instanceof DecisionLLMError) {
      switch (this.config.failMode) {
        case 'silence':
          return {
            ...createFallbackResponse(input, `decision_llm_${error.code}`),
            action: 'silence',
            tags: ['decision_agent_error', error.code],
          };
        case 'allow_reply_only':
          if (input.reason === 'message' && input.event?.isDirected) {
            return {
              action: 'reply',
              targetId: input.event.chatId,
              generateText: true,
              reason: `fallback: decision agent ${error.code}`,
              confidence: 0.3,
              afterward: 'done',
              tags: ['fallback', 'allow_reply_only', error.code],
            };
          }
          return {
            ...createFallbackResponse(input, `decision_llm_${error.code}`),
            action: 'silence',
            tags: ['decision_agent_error', error.code],
          };
        case 'fallback_algorithmic':
        default:
          return createFallbackResponse(input, `decision_llm_${error.code}`);
      }
    }

    return createFallbackResponse(input, 'decision_llm_unknown_error');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function stripMarkdownFence(content: string): string {
  const match = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? content;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter: random value in [base/2, base*1.5]. */
function jitter(baseMs: number): number {
  return Math.round(baseMs * (0.5 + Math.random()));
}
