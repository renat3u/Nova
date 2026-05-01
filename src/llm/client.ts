import { buildNovaChatMessages, buildNovaProactiveChatMessages } from './prompts';
import { LLMGenerationError, type LLMConfig, type NovaLLMResponse, type NovaProactivePromptInput, type NovaPromptInput } from './response-schema';

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

export interface LLMClient {
  generateReply(input: NovaPromptInput): Promise<NovaLLMResponse>;
  generateProactive(input: NovaProactivePromptInput): Promise<NovaLLMResponse>;
}

export class OpenAICompatibleLLMClient implements LLMClient {
  constructor(private readonly config: LLMConfig) {}

  async generateReply(input: NovaPromptInput): Promise<NovaLLMResponse> {
    return this.generate(buildNovaChatMessages(input));
  }

  async generateProactive(input: NovaProactivePromptInput): Promise<NovaLLMResponse> {
    return this.generate(buildNovaProactiveChatMessages(input));
  }

  private async generate(messages: ReturnType<typeof buildNovaChatMessages>): Promise<NovaLLMResponse> {
    this.assertConfigured();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);

    try {
      const response = await fetch(completionsUrl(this.config.baseUrl), {
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
        throw new LLMGenerationError('auth_error', 'LLM authentication failed', response.status);
      }
      if (!response.ok) {
        throw new LLMGenerationError('bad_status', `LLM request failed with HTTP ${response.status}`, response.status);
      }

      const body = await response.json() as OpenAIChatCompletionResponse;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new LLMGenerationError('empty_response', 'LLM returned empty content');
      }

      return parseNovaLLMResponse(content);
    } catch (error) {
      if (error instanceof LLMGenerationError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LLMGenerationError('timeout', 'LLM request timed out');
      }
      throw new LLMGenerationError('network_error', error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertConfigured(): void {
    if (this.config.baseUrl.trim().length === 0 || this.config.apiKey.trim().length === 0 || this.config.model.trim().length === 0) {
      throw new LLMGenerationError('missing_config', 'LLM baseUrl, apiKey, and model are required');
    }
  }
}

export function parseNovaLLMResponse(content: string): NovaLLMResponse {
  const trimmed = stripMarkdownFence(content.trim());
  const parsed = tryParseJsonObject(trimmed);
  if (!parsed) return { text: trimmed };

  const text = typeof parsed.text === 'string' ? parsed.text : trimmed;
  return {
    text,
    ...(typeof parsed.memoryCandidate === 'string' ? { memoryCandidate: parsed.memoryCandidate } : {}),
    ...(typeof parsed.tone === 'string' ? { tone: parsed.tone } : {}),
    ...(typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? { confidence: parsed.confidence } : {}),
    ...(Array.isArray(parsed.stateUpdates) ? { stateUpdates: parsed.stateUpdates as NovaLLMResponse['stateUpdates'] } : {}),
  };
}

function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function stripMarkdownFence(content: string): string {
  const match = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? content;
}

function tryParseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(content) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
