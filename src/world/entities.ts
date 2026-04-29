export type NodeType = 'agent' | 'contact' | 'channel' | 'fact' | 'thread' | 'conversation' | 'message';
export type DunbarTier = 5 | 15 | 50 | 150 | 500;
export type EdgeCategory = 'spatial' | 'social' | 'cognitive' | 'causal' | 'ownership';
export type ChatType = 'private' | 'group';
export type FactType = 'observation' | 'preference' | 'summary' | 'commitment';
export type ThreadStatus = 'open' | 'closed';
export type ConversationState = 'active' | 'cooldown' | 'closing';
export type TurnState = 'nova_turn' | 'user_turn' | 'none';

export interface AgentAttrs {
  id: string;
  entity_type: 'agent';
  platform: 'qq';
  created_ms: number;
  display_name: string;
}

export interface ContactAttrs {
  id: string;
  entity_type: 'contact';
  platform: 'qq';
  qq: string;
  name?: string;
  tier: DunbarTier;
  is_bot?: boolean;
  last_active_ms?: number;
  interaction_count: number;
  nova_initiated_count: number;
  contact_initiated_count: number;
  rv_attraction?: number;
  hawkes_carry: number;
  hawkes_last_event_ms?: number;
}

export interface ChannelAttrs {
  id: string;
  entity_type: 'channel';
  platform: 'qq';
  chat_type: ChatType;
  title?: string;
  tier_contact: DunbarTier;
  unread: number;
  pending_directed: number;
  last_activity_ms: number;
  last_directed_ms?: number;
  last_nova_action_ms?: number;
  last_read_ms?: number;
  nova_thinking_since?: number | null;
  contact_recv_window: number;
  activity_relevance: number;
  hawkes_carry: number;
  hawkes_last_event_ms?: number;
}

export interface FactAttrs {
  id: string;
  entity_type: 'fact';
  content: string;
  fact_type: FactType;
  importance: number;
  volatility: number;
  stability: number;
  tracked: boolean;
  created_ms: number;
  last_access_ms: number;
  subject_id?: string;
}

export interface ThreadAttrs {
  id: string;
  entity_type: 'thread';
  status: ThreadStatus;
  w: number;
  created_ms: number;
  deadline_ms?: number;
  channel_id?: string;
  summary?: string;
}

export interface ConversationAttrs {
  id: string;
  entity_type: 'conversation';
  channel_id: string;
  state: ConversationState;
  turn_state: TurnState;
  last_activity_ms: number;
  closing_since_ms?: number;
}

export interface MessageAttrs {
  id: string;
  entity_type: 'message';
  platform: 'qq';
  raw_message_id: string;
  channel_id: string;
  sender_id: string;
  text: string;
  is_directed: boolean;
  timestamp: number;
}

export interface NodeAttrsMap {
  agent: AgentAttrs;
  contact: ContactAttrs;
  channel: ChannelAttrs;
  fact: FactAttrs;
  thread: ThreadAttrs;
  conversation: ConversationAttrs;
  message: MessageAttrs;
}

export type NodeAttrs = NodeAttrsMap[NodeType];

export type NodeEntry = {
  [K in NodeType]: { type: K; attrs: NodeAttrsMap[K] };
}[NodeType];

export interface EdgeData {
  category: EdgeCategory;
  weight: number;
  attrs: Record<string, unknown>;
}

export interface WorldEdge extends EdgeData {
  src: string;
  dst: string;
}

export interface PressureSnapshotRecord {
  id?: string;
  tick: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  p5: number;
  p6: number;
  p_prospect: number;
  api: number;
  api_peak: number;
  created_ms?: number;
  contributions?: Record<string, unknown>;
}

export interface PersonalitySnapshotRecord {
  id?: string;
  tick: number;
  pi_d: number;
  pi_c: number;
  pi_s: number;
  pi_x: number;
  created_ms?: number;
}

export interface PersistentActionLogRecord {
  id?: string;
  tick?: number | null;
  action_type: string;
  target_id: string;
  text?: string;
  status: 'success' | 'failed' | 'silence' | string;
  error?: string;
  created_ms?: number;
}

export interface SilenceLogRecord {
  id?: string;
  tick?: number | null;
  target_id: string;
  level: string;
  reason: string;
  values?: Record<string, unknown>;
  created_ms?: number;
}
