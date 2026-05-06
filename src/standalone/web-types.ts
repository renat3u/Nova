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

  /** 压力值手动覆盖。null 表示使用计算值。覆盖的是原始压力值（非归一化后）。 */
  pressureValueOverrides?: {
    p1?: number | null;
    p2?: number | null;
    p3?: number | null;
    p4?: number | null;
    p5?: number | null;
    p6?: number | null;
    p7?: number | null;
    p8?: number | null;
  };

  /** 自动停止 tick 数（0 表示不自动停止），默认 200。 */
  autoStopAfterTick?: number;

  /** 启用计划动作（standalone 从配置读取，不再硬编码）。 */
  enableScheduledActions?: boolean;

  /** 主动消息白名单 QQ 列表。 */
  proactiveWhitelistQQ?: string[];
}
