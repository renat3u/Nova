export const NOVA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  qq TEXT NOT NULL,
  name TEXT,
  tier INTEGER NOT NULL,
  attrs_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  qq_id TEXT NOT NULL,
  title TEXT,
  attrs_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  raw_message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  is_directed INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  UNIQUE(platform, raw_message_id)
);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  subject_id TEXT,
  content TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  importance REAL NOT NULL,
  volatility REAL NOT NULL,
  stability REAL NOT NULL,
  tracked INTEGER NOT NULL,
  created_ms INTEGER NOT NULL,
  last_access_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  channel_id TEXT,
  status TEXT NOT NULL,
  summary TEXT,
  w REAL NOT NULL,
  created_ms INTEGER NOT NULL,
  deadline_ms INTEGER
);

CREATE TABLE IF NOT EXISTS thread_beats (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  summary TEXT NOT NULL,
  beat_type TEXT NOT NULL DEFAULT 'ambient',
  operation TEXT NOT NULL DEFAULT 'advance_topic',
  weight REAL NOT NULL DEFAULT 1,
  created_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_profiles (
  group_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  group_name TEXT,
  member_count INTEGER NOT NULL DEFAULT 0,
  nova_role_in_group TEXT NOT NULL DEFAULT 'member',
  group_risk_level TEXT NOT NULL DEFAULT 'normal',
  last_activity_ms INTEGER NOT NULL DEFAULT 0,
  last_incoming_ms INTEGER NOT NULL DEFAULT 0,
  attrs_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS engagements (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  contact_id TEXT,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_event_ms INTEGER NOT NULL DEFAULT 0,
  attrs_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS desire_tick_plans (
  id TEXT PRIMARY KEY,
  plan_type TEXT NOT NULL,
  channel_id TEXT,
  contact_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  desire_score REAL NOT NULL DEFAULT 0,
  due_ms INTEGER,
  attrs_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  state TEXT NOT NULL,
  turn_state TEXT NOT NULL,
  last_activity_ms INTEGER NOT NULL,
  closing_since_ms INTEGER,
  attrs_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  category TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  attrs_json TEXT NOT NULL,
  PRIMARY KEY (src, dst, category)
);

CREATE TABLE IF NOT EXISTS pressure_snapshots (
  id TEXT PRIMARY KEY,
  tick INTEGER NOT NULL,
  p1 REAL NOT NULL,
  p2 REAL NOT NULL,
  p3 REAL NOT NULL,
  p4 REAL NOT NULL,
  p5 REAL NOT NULL,
  p6 REAL NOT NULL,
  p_prospect REAL NOT NULL,
  api REAL NOT NULL,
  api_peak REAL NOT NULL,
  created_ms INTEGER NOT NULL,
  contributions_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personality_snapshots (
  id TEXT PRIMARY KEY,
  tick INTEGER NOT NULL,
  pi_d REAL NOT NULL,
  pi_c REAL NOT NULL,
  pi_s REAL NOT NULL,
  pi_x REAL NOT NULL,
  created_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS action_logs (
  id TEXT PRIMARY KEY,
  tick INTEGER,
  action_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  text TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS silence_logs (
  id TEXT PRIMARY KEY,
  tick INTEGER,
  target_id TEXT NOT NULL,
  level TEXT NOT NULL,
  reason TEXT NOT NULL,
  values_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS working_memory (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  salience REAL NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  source_event_id TEXT
);

CREATE TABLE IF NOT EXISTS nova_tick_traces (
  id TEXT PRIMARY KEY,
  tick INTEGER NOT NULL,
  reason TEXT NOT NULL,
  gate_verdict TEXT NOT NULL,
  silence_reason TEXT,
  trace_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nova_action_traces (
  id TEXT PRIMARY KEY,
  tick INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  trace_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nova_deliberation_traces (
  id TEXT PRIMARY KEY,
  tick INTEGER NOT NULL,
  reason TEXT NOT NULL,
  action_summary TEXT,
  silence_summary TEXT,
  trace_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_timestamp ON messages(channel_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_sender_timestamp ON messages(sender_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_facts_subject_tracked ON facts(subject_id, tracked);
CREATE INDEX IF NOT EXISTS idx_threads_channel_status ON threads(channel_id, status);
CREATE INDEX IF NOT EXISTS idx_thread_beats_thread_created_ms ON thread_beats(thread_id, created_ms);
CREATE INDEX IF NOT EXISTS idx_group_profiles_channel ON group_profiles(channel_id);
CREATE INDEX IF NOT EXISTS idx_engagements_channel_kind ON engagements(channel_id, kind);
CREATE INDEX IF NOT EXISTS idx_desire_tick_plans_status_due ON desire_tick_plans(status, due_ms);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel_id);
CREATE INDEX IF NOT EXISTS idx_pressure_snapshots_created_ms ON pressure_snapshots(created_ms);
CREATE INDEX IF NOT EXISTS idx_silence_logs_created_ms ON silence_logs(created_ms);
CREATE INDEX IF NOT EXISTS idx_action_logs_created_ms ON action_logs(created_ms);
CREATE INDEX IF NOT EXISTS idx_working_memory_salience ON working_memory(salience, updated_ms);
CREATE INDEX IF NOT EXISTS idx_nova_tick_traces_created_ms ON nova_tick_traces(created_ms);
CREATE INDEX IF NOT EXISTS idx_nova_tick_traces_tick ON nova_tick_traces(tick, reason);
CREATE INDEX IF NOT EXISTS idx_nova_action_traces_created_ms ON nova_action_traces(created_ms);
CREATE INDEX IF NOT EXISTS idx_nova_action_traces_tick ON nova_action_traces(tick, action_type);
CREATE INDEX IF NOT EXISTS idx_nova_deliberation_traces_created_ms ON nova_deliberation_traces(created_ms);
CREATE INDEX IF NOT EXISTS idx_nova_deliberation_traces_tick ON nova_deliberation_traces(tick, reason);
`;
