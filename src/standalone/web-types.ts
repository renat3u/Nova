import type { WebSocket } from 'ws';
import type { PressureSnapshot } from '../pressure/aggregate';
import type { NovaTickTrace } from '../trace/types';
import type { NovaRuntimeStatus } from '../core/runtime';

/** Browser-sent chat message */
export interface WebChatMessage {
  type: 'chat_message';
  text: string;
  username: string;
}

/** Server-pushed messages to the browser */
export type WebServerMessage =
  | { type: 'session_init'; userId: string; username: string }
  | { type: 'nova_reply'; text: string; actionId: string; confidence?: number; reason?: string }
  | { type: 'nova_silence'; reason: string; level: string }
  | { type: 'nova_thinking'; active: boolean }
  | { type: 'pressure_snapshot'; data: PressureSnapshot }
  | { type: 'tick_trace'; data: NovaTickTrace }
  | { type: 'status_update'; data: NovaRuntimeStatus }
  | { type: 'error'; message: string };

/** User session tied to a WebSocket connection */
export interface WebUserSession {
  userId: string;
  channelId: string;
  username: string;
  connectedAt: number;
  ws: WebSocket;
}

/** Standalone config persisted to nova-standalone-config.json */
export interface NovaStandaloneConfig {
  enabled: boolean;
  debug: boolean;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  enablePrivateChat: boolean;
  maxReplyLength: number;
  dbPath: string;
  minApiToSpeak: number;
  directedMinApiToSpeak: number;
  proactiveEnabled: boolean;
  iausScoringMode: 'legacy_nsv' | 'consideration';
  gatewayMode: 'algorithmic' | 'agent';
  decisionAgent: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    timeoutMs?: number;
    responseFormat: 'json_object';
    failMode: 'fallback_algorithmic' | 'silence' | 'allow_reply_only';
  };
  decisionGuardrails: 'off' | 'soft' | 'hard';
  enablePreSendGuardrails: boolean;
  auditAlgorithmicGates: boolean;
  port: number;
}
