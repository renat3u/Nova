import type Database from 'better-sqlite3';
import { parseJsonObject, stringifyJson, type NovaSqliteDatabase } from '../db/sqlite';
import type { NovaAction, NovaMessageEvent } from '../core/types';
import type { SendResult } from '../act/types';
import { conversationIdForChannel, defaultTierForChat, makeId, qqIdFromNodeId } from './constants';
import type {
  ChannelAttrs,
  ChatType,
  ContactAttrs,
  ConversationAttrs,
  EdgeCategory,
  FactAttrs,
  FactType,
  MessageAttrs,
  PersistentActionLogRecord,
  PersonalitySnapshotRecord,
  PressureSnapshotRecord,
  SilenceLogRecord,
  ThreadAttrs,
} from './entities';
import { WorldModel } from './model';

interface ContactRow {
  id: string;
  qq: string;
  name: string | null;
  tier: number;
  attrs_json: string;
}

interface ChannelRow {
  id: string;
  platform: 'qq';
  chat_type: ChatType;
  qq_id: string;
  title: string | null;
  attrs_json: string;
}

interface MessageRow {
  id: string;
  platform: 'qq';
  raw_message_id: string;
  channel_id: string;
  sender_id: string;
  text: string;
  is_directed: number;
  timestamp: number;
}

interface FactRow {
  id: string;
  subject_id: string | null;
  content: string;
  fact_type: FactType;
  importance: number;
  volatility: number;
  stability: number;
  tracked: number;
  created_ms: number;
  last_access_ms: number;
}

interface ThreadRow {
  id: string;
  channel_id: string | null;
  status: 'open' | 'closed';
  summary: string | null;
  w: number;
  created_ms: number;
  deadline_ms: number | null;
}

interface ConversationRow {
  id: string;
  channel_id: string;
  state: 'active' | 'cooldown' | 'closing';
  turn_state: 'nova_turn' | 'user_turn' | 'none';
  last_activity_ms: number;
  attrs_json: string;
}

interface EdgeRow {
  src: string;
  dst: string;
  category: EdgeCategory;
  weight: number;
  attrs_json: string;
}

export class NovaWorldRepository {
  readonly world = new WorldModel();

  constructor(private readonly db: NovaSqliteDatabase) {}

  loadWorld(): void {
    this.world.clear();
    this.loadContacts();
    this.loadChannels();
    this.loadFacts();
    this.loadThreads();
    this.loadConversations();
    this.loadMessages();
    this.loadEdges();
  }

  applyMessageEvent(event: NovaMessageEvent): void {
    const now = Date.now();
    const run = this.db.transaction(() => {
      const contact = this.upsertContact(event, now);
      const channel = this.upsertChannel(event, now);
      const conversation = this.upsertConversation(event, now);
      const message = this.insertMessage(event);
      this.upsertEdge(contact.id, channel.id, 'social', { relation: 'contact-channel' }, 1);
      this.upsertEdge(message.id, channel.id, 'spatial', { relation: 'message-channel' }, 1);
      this.upsertEdge(message.id, contact.id, 'ownership', { relation: 'message-sender' }, 1);
      return { contact, channel, conversation, message };
    });
    run();
  }

  recordAction(action: NovaAction | PersistentActionLogRecord, result?: SendResult): void {
    const now = Date.now();
    const record = normalizeActionRecord(action, result, now);
    this.db.prepare(`
      INSERT OR REPLACE INTO action_logs (id, tick, action_type, target_id, text, status, error, created_ms)
      VALUES (@id, @tick, @action_type, @target_id, @text, @status, @error, @created_ms)
    `).run(record);
  }

  recordSilence(entry: SilenceLogRecord): void {
    const record = {
      id: entry.id ?? makeId('silence'),
      tick: entry.tick ?? null,
      target_id: entry.target_id,
      level: entry.level,
      reason: entry.reason,
      values_json: stringifyJson(entry.values ?? {}),
      created_ms: entry.created_ms ?? Date.now(),
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO silence_logs (id, tick, target_id, level, reason, values_json, created_ms)
      VALUES (@id, @tick, @target_id, @level, @reason, @values_json, @created_ms)
    `).run(record);
  }

  recordPressureSnapshot(snapshot: PressureSnapshotRecord): void {
    const record = {
      id: snapshot.id ?? makeId('pressure'),
      tick: snapshot.tick,
      p1: snapshot.p1,
      p2: snapshot.p2,
      p3: snapshot.p3,
      p4: snapshot.p4,
      p5: snapshot.p5,
      p6: snapshot.p6,
      p_prospect: snapshot.p_prospect,
      api: snapshot.api,
      api_peak: snapshot.api_peak,
      created_ms: snapshot.created_ms ?? Date.now(),
      contributions_json: stringifyJson(snapshot.contributions ?? {}),
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO pressure_snapshots
      (id, tick, p1, p2, p3, p4, p5, p6, p_prospect, api, api_peak, created_ms, contributions_json)
      VALUES (@id, @tick, @p1, @p2, @p3, @p4, @p5, @p6, @p_prospect, @api, @api_peak, @created_ms, @contributions_json)
    `).run(record);
  }

  recordPersonalitySnapshot(snapshot: PersonalitySnapshotRecord): void {
    const record = {
      id: snapshot.id ?? makeId('personality'),
      tick: snapshot.tick,
      pi_d: snapshot.pi_d,
      pi_c: snapshot.pi_c,
      pi_s: snapshot.pi_s,
      pi_x: snapshot.pi_x,
      created_ms: snapshot.created_ms ?? Date.now(),
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO personality_snapshots (id, tick, pi_d, pi_c, pi_s, pi_x, created_ms)
      VALUES (@id, @tick, @pi_d, @pi_c, @pi_s, @pi_x, @created_ms)
    `).run(record);
  }

  markNovaAction(targetId: string, nowMs = Date.now()): void {
    const channel = this.resolveActionChannel(targetId);
    if (!channel) return;

    const nextChannel: ChannelAttrs = {
      ...channel,
      last_nova_action_ms: nowMs,
      unread: Math.max(0, channel.unread - 1),
      pending_directed: Math.max(0, channel.pending_directed - 1),
    };
    this.persistChannel(nextChannel, nowMs);

    const conversationId = conversationIdForChannel(channel.id);
    if (this.world.has(conversationId) && this.world.getNodeType(conversationId) === 'conversation') {
      const conversation = this.world.getConversation(conversationId);
      this.persistConversation({
        ...conversation,
        turn_state: 'nova_turn',
        last_activity_ms: nowMs,
      });
    }
  }

  listRecentActions(limit = 50): PersistentActionLogRecord[] {
    const rows = this.db.prepare(`
      SELECT id, tick, action_type, target_id, text, status, error, created_ms
      FROM action_logs
      ORDER BY created_ms DESC
      LIMIT ?
    `).all(safeLimit(limit)) as Array<{
      id: string;
      tick: number | null;
      action_type: string;
      target_id: string;
      text: string | null;
      status: string;
      error: string | null;
      created_ms: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      tick: row.tick,
      action_type: row.action_type,
      target_id: row.target_id,
      text: row.text ?? '',
      status: row.status,
      error: row.error ?? undefined,
      created_ms: row.created_ms,
    }));
  }

  listRecentSilences(limit = 50): SilenceLogRecord[] {
    const rows = this.db.prepare(`
      SELECT id, tick, target_id, level, reason, values_json, created_ms
      FROM silence_logs
      ORDER BY created_ms DESC
      LIMIT ?
    `).all(safeLimit(limit)) as Array<{
      id: string;
      tick: number | null;
      target_id: string;
      level: string;
      reason: string;
      values_json: string;
      created_ms: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      tick: row.tick,
      target_id: row.target_id,
      level: row.level,
      reason: row.reason,
      values: parseJsonObject(row.values_json),
      created_ms: row.created_ms,
    }));
  }

  listPressureSnapshots(limit = 50): PressureSnapshotRecord[] {
    const rows = this.db.prepare(`
      SELECT id, tick, p1, p2, p3, p4, p5, p6, p_prospect, api, api_peak, created_ms, contributions_json
      FROM pressure_snapshots
      ORDER BY created_ms DESC
      LIMIT ?
    `).all(safeLimit(limit)) as Array<{
      id: string;
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
      created_ms: number;
      contributions_json: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      tick: row.tick,
      p1: row.p1,
      p2: row.p2,
      p3: row.p3,
      p4: row.p4,
      p5: row.p5,
      p6: row.p6,
      p_prospect: row.p_prospect,
      api: row.api,
      api_peak: row.api_peak,
      created_ms: row.created_ms,
      contributions: parseJsonObject(row.contributions_json),
    }));
  }

  getRecentMessages(channelId: string, limit = 20): MessageAttrs[] {
    const rows = this.db.prepare(`
      SELECT id, platform, raw_message_id, channel_id, sender_id, text, is_directed, timestamp
      FROM messages
      WHERE channel_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(channelId, Math.max(0, Math.trunc(limit))) as MessageRow[];
    return rows.reverse().map(messageFromRow);
  }

  private resolveActionChannel(targetId: string): ChannelAttrs | undefined {
    const candidates = [targetId];
    if (targetId.startsWith('qq:group:')) candidates.push(targetId);
    else if (targetId.startsWith('qq:private:')) candidates.push(targetId);

    for (const id of candidates) {
      if (this.world.has(id) && this.world.getNodeType(id) === 'channel') return this.world.getChannel(id);
    }
    return undefined;
  }

  private persistChannel(attrs: ChannelAttrs, now: number): void {
    const qqId = qqIdFromNodeId(attrs.id);
    this.db.prepare(`
      INSERT INTO channels (id, platform, chat_type, qq_id, title, attrs_json, created_at, updated_at)
      VALUES (@id, @platform, @chat_type, @qq_id, @title, @attrs_json, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        attrs_json = excluded.attrs_json,
        updated_at = excluded.updated_at
    `).run({
      id: attrs.id,
      platform: attrs.platform,
      chat_type: attrs.chat_type,
      qq_id: qqId,
      title: attrs.title ?? null,
      attrs_json: stringifyJson(attrs),
      created_at: now,
      updated_at: now,
    });

    if (this.world.has(attrs.id)) this.world.updateChannel(attrs.id, attrs);
    else this.world.addChannel(attrs.id, attrs);
  }

  private persistConversation(attrs: ConversationAttrs): void {
    this.db.prepare(`
      INSERT INTO conversations (id, channel_id, state, turn_state, last_activity_ms, attrs_json)
      VALUES (@id, @channel_id, @state, @turn_state, @last_activity_ms, @attrs_json)
      ON CONFLICT(id) DO UPDATE SET
        channel_id = excluded.channel_id,
        state = excluded.state,
        turn_state = excluded.turn_state,
        last_activity_ms = excluded.last_activity_ms,
        attrs_json = excluded.attrs_json
    `).run({
      id: attrs.id,
      channel_id: attrs.channel_id,
      state: attrs.state,
      turn_state: attrs.turn_state,
      last_activity_ms: attrs.last_activity_ms,
      attrs_json: stringifyJson(attrs),
    });

    if (this.world.has(attrs.id)) this.world.updateConversation(attrs.id, attrs);
    else this.world.addConversation(attrs.id, attrs);
  }

  private upsertContact(event: NovaMessageEvent, now: number): ContactAttrs {
    const existing = this.world.has(event.senderId) ? this.world.getContact(event.senderId) : this.loadContactById(event.senderId);
    const tier = existing?.tier ?? defaultTierForChat(event.chatType);
    const attrs: ContactAttrs = {
      id: event.senderId,
      entity_type: 'contact',
      platform: 'qq',
      qq: event.senderQQ,
      ...(event.senderName === undefined ? {} : { name: event.senderName }),
      tier,
      last_active_ms: event.timestamp,
      interaction_count: (existing?.interaction_count ?? 0) + 1,
      nova_initiated_count: existing?.nova_initiated_count ?? 0,
      contact_initiated_count: (existing?.contact_initiated_count ?? 0) + 1,
      rv_attraction: existing?.rv_attraction,
      hawkes_carry: (existing?.hawkes_carry ?? 0) + 1,
      hawkes_last_event_ms: event.timestamp,
      is_bot: existing?.is_bot,
    };

    this.db.prepare(`
      INSERT INTO contacts (id, qq, name, tier, attrs_json, created_at, updated_at)
      VALUES (@id, @qq, @name, @tier, @attrs_json, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        qq = excluded.qq,
        name = excluded.name,
        tier = excluded.tier,
        attrs_json = excluded.attrs_json,
        updated_at = excluded.updated_at
    `).run({
      id: attrs.id,
      qq: attrs.qq,
      name: attrs.name ?? null,
      tier: attrs.tier,
      attrs_json: stringifyJson(attrs),
      created_at: now,
      updated_at: now,
    });

    if (this.world.has(attrs.id)) this.world.updateContact(attrs.id, attrs);
    else this.world.addContact(attrs.id, attrs);
    return attrs;
  }

  private upsertChannel(event: NovaMessageEvent, now: number): ChannelAttrs {
    const existing = this.world.has(event.chatId) ? this.world.getChannel(event.chatId) : this.loadChannelById(event.chatId);
    const attrs: ChannelAttrs = {
      id: event.chatId,
      entity_type: 'channel',
      platform: 'qq',
      chat_type: event.chatType,
      ...(event.groupName === undefined ? {} : { title: event.groupName }),
      tier_contact: existing?.tier_contact ?? defaultTierForChat(event.chatType),
      unread: (existing?.unread ?? 0) + 1,
      pending_directed: (existing?.pending_directed ?? 0) + (event.isDirected ? 1 : 0),
      last_activity_ms: event.timestamp,
      ...(event.isDirected ? { last_directed_ms: event.timestamp } : existing?.last_directed_ms === undefined ? {} : { last_directed_ms: existing.last_directed_ms }),
      last_nova_action_ms: existing?.last_nova_action_ms,
      last_read_ms: existing?.last_read_ms,
      nova_thinking_since: existing?.nova_thinking_since ?? null,
      contact_recv_window: (existing?.contact_recv_window ?? 0) + 1,
      activity_relevance: existing?.activity_relevance ?? 1,
      hawkes_carry: (existing?.hawkes_carry ?? 0) + (event.isDirected ? 1 : 0.2),
      hawkes_last_event_ms: event.timestamp,
    };

    this.persistChannel(attrs, now);
    return attrs;
  }

  private upsertConversation(event: NovaMessageEvent, _now: number): ConversationAttrs {
    const id = conversationIdForChannel(event.chatId);
    const existing = this.world.has(id) ? this.world.getConversation(id) : this.loadConversationById(id);
    const attrs: ConversationAttrs = {
      id,
      entity_type: 'conversation',
      channel_id: event.chatId,
      state: existing?.state ?? 'active',
      turn_state: 'user_turn',
      last_activity_ms: event.timestamp,
      closing_since_ms: existing?.closing_since_ms,
    };

    this.persistConversation(attrs);
    return attrs;
  }

  private insertMessage(event: NovaMessageEvent): MessageAttrs {
    const attrs: MessageAttrs = {
      id: event.messageId,
      entity_type: 'message',
      platform: event.platform,
      raw_message_id: String(event.rawMessageId),
      channel_id: event.chatId,
      sender_id: event.senderId,
      text: event.text,
      is_directed: event.isDirected,
      timestamp: event.timestamp,
    };

    this.db.prepare(`
      INSERT OR IGNORE INTO messages
      (id, platform, raw_message_id, channel_id, sender_id, text, is_directed, timestamp, raw_json)
      VALUES (@id, @platform, @raw_message_id, @channel_id, @sender_id, @text, @is_directed, @timestamp, @raw_json)
    `).run({
      id: attrs.id,
      platform: attrs.platform,
      raw_message_id: attrs.raw_message_id,
      channel_id: attrs.channel_id,
      sender_id: attrs.sender_id,
      text: attrs.text,
      is_directed: attrs.is_directed ? 1 : 0,
      timestamp: attrs.timestamp,
      raw_json: stringifyJson(event.rawEvent),
    });

    if (!this.world.has(attrs.id)) this.world.addMessage(attrs.id, attrs);
    return attrs;
  }

  private upsertEdge(src: string, dst: string, category: EdgeCategory, attrs: Record<string, unknown>, weight: number): void {
    this.db.prepare(`
      INSERT INTO graph_edges (src, dst, category, weight, attrs_json)
      VALUES (@src, @dst, @category, @weight, @attrs_json)
      ON CONFLICT(src, dst, category) DO UPDATE SET
        weight = excluded.weight,
        attrs_json = excluded.attrs_json
    `).run({ src, dst, category, weight, attrs_json: stringifyJson(attrs) });
    this.world.addRelation(src, category, dst, attrs, weight);
  }

  private loadContacts(): void {
    const rows = this.db.prepare('SELECT id, qq, name, tier, attrs_json FROM contacts').all() as ContactRow[];
    for (const row of rows) this.world.addContact(row.id, contactFromRow(row));
  }

  private loadChannels(): void {
    const rows = this.db.prepare('SELECT id, platform, chat_type, qq_id, title, attrs_json FROM channels').all() as ChannelRow[];
    for (const row of rows) this.world.addChannel(row.id, channelFromRow(row));
  }

  private loadMessages(): void {
    const rows = this.db.prepare(`
      SELECT id, platform, raw_message_id, channel_id, sender_id, text, is_directed, timestamp FROM messages
      ORDER BY timestamp DESC LIMIT 500
    `).all() as MessageRow[];
    for (const row of rows) this.world.addMessage(row.id, messageFromRow(row));
  }

  private loadFacts(): void {
    const rows = this.db.prepare(`
      SELECT id, subject_id, content, fact_type, importance, volatility, stability, tracked, created_ms, last_access_ms FROM facts
    `).all() as FactRow[];
    for (const row of rows) this.world.addFact(row.id, factFromRow(row));
  }

  private loadThreads(): void {
    const rows = this.db.prepare('SELECT id, channel_id, status, summary, w, created_ms, deadline_ms FROM threads').all() as ThreadRow[];
    for (const row of rows) this.world.addThread(row.id, threadFromRow(row));
  }

  private loadConversations(): void {
    const rows = this.db.prepare('SELECT id, channel_id, state, turn_state, last_activity_ms, attrs_json FROM conversations').all() as ConversationRow[];
    for (const row of rows) this.world.addConversation(row.id, conversationFromRow(row));
  }

  private loadEdges(): void {
    const rows = this.db.prepare('SELECT src, dst, category, weight, attrs_json FROM graph_edges').all() as EdgeRow[];
    for (const row of rows) this.world.addRelation(row.src, row.category, row.dst, parseJsonObject(row.attrs_json), row.weight);
  }

  private loadContactById(id: string): ContactAttrs | undefined {
    const row = this.db.prepare('SELECT id, qq, name, tier, attrs_json FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
    return row ? contactFromRow(row) : undefined;
  }

  private loadChannelById(id: string): ChannelAttrs | undefined {
    const row = this.db.prepare('SELECT id, platform, chat_type, qq_id, title, attrs_json FROM channels WHERE id = ?').get(id) as ChannelRow | undefined;
    return row ? channelFromRow(row) : undefined;
  }

  private loadConversationById(id: string): ConversationAttrs | undefined {
    const row = this.db.prepare('SELECT id, channel_id, state, turn_state, last_activity_ms, attrs_json FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    return row ? conversationFromRow(row) : undefined;
  }
}

function contactFromRow(row: ContactRow): ContactAttrs {
  const attrs = parseJsonObject(row.attrs_json) as Partial<ContactAttrs>;
  return {
    id: row.id,
    entity_type: 'contact',
    platform: 'qq',
    qq: row.qq,
    ...(row.name === null ? {} : { name: row.name }),
    tier: row.tier as ContactAttrs['tier'],
    interaction_count: 0,
    nova_initiated_count: 0,
    contact_initiated_count: 0,
    hawkes_carry: 0,
    ...attrs,
  };
}

function channelFromRow(row: ChannelRow): ChannelAttrs {
  const attrs = parseJsonObject(row.attrs_json) as Partial<ChannelAttrs>;
  return {
    id: row.id,
    entity_type: 'channel',
    platform: 'qq',
    chat_type: row.chat_type,
    ...(row.title === null ? {} : { title: row.title }),
    tier_contact: defaultTierForChat(row.chat_type),
    unread: 0,
    pending_directed: 0,
    last_activity_ms: 0,
    nova_thinking_since: null,
    contact_recv_window: 0,
    activity_relevance: 1,
    hawkes_carry: 0,
    ...attrs,
  };
}

function messageFromRow(row: MessageRow): MessageAttrs {
  return {
    id: row.id,
    entity_type: 'message',
    platform: row.platform,
    raw_message_id: row.raw_message_id,
    channel_id: row.channel_id,
    sender_id: row.sender_id,
    text: row.text,
    is_directed: Boolean(row.is_directed),
    timestamp: row.timestamp,
  };
}

function factFromRow(row: FactRow): FactAttrs {
  return {
    id: row.id,
    entity_type: 'fact',
    content: row.content,
    fact_type: row.fact_type,
    importance: row.importance,
    volatility: row.volatility,
    stability: row.stability,
    tracked: Boolean(row.tracked),
    created_ms: row.created_ms,
    last_access_ms: row.last_access_ms,
    ...(row.subject_id === null ? {} : { subject_id: row.subject_id }),
  };
}

function threadFromRow(row: ThreadRow): ThreadAttrs {
  return {
    id: row.id,
    entity_type: 'thread',
    status: row.status,
    w: row.w,
    created_ms: row.created_ms,
    ...(row.deadline_ms === null ? {} : { deadline_ms: row.deadline_ms }),
    ...(row.channel_id === null ? {} : { channel_id: row.channel_id }),
    ...(row.summary === null ? {} : { summary: row.summary }),
  };
}

function conversationFromRow(row: ConversationRow): ConversationAttrs {
  const attrs = parseJsonObject(row.attrs_json) as Partial<ConversationAttrs>;
  return {
    id: row.id,
    entity_type: 'conversation',
    channel_id: row.channel_id,
    state: row.state,
    turn_state: row.turn_state,
    last_activity_ms: row.last_activity_ms,
    ...attrs,
  };
}

function normalizeActionRecord(action: NovaAction | PersistentActionLogRecord, result: SendResult | undefined, now: number): Required<PersistentActionLogRecord> {
  if ('action_type' in action) {
    return {
      id: action.id ?? makeId('action'),
      tick: action.tick ?? null,
      action_type: action.action_type,
      target_id: action.target_id,
      text: action.text ?? '',
      status: action.status,
      error: action.error ?? '',
      created_ms: action.created_ms ?? now,
    };
  }

  if (action.type === 'send_text') {
    const targetId = action.target.channelId || action.target.groupId || action.target.userId || 'unknown';
    return {
      id: makeId('action'),
      tick: null,
      action_type: 'send_text',
      target_id: result?.targetId ?? targetId,
      text: result?.text ?? action.text,
      status: result?.ok === false ? 'failed' : 'success',
      error: result?.error ?? '',
      created_ms: result?.createdMs ?? now,
    };
  }

  return {
    id: makeId('action'),
    tick: null,
    action_type: 'silence',
    target_id: 'unknown',
    text: '',
    status: 'silence',
    error: action.reason,
    created_ms: now,
  };
}

function safeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(0, Math.min(500, Math.trunc(limit)));
}

export type { Database };
