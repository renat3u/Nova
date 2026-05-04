import type Database from 'better-sqlite3';
import { parseJsonObject, stringifyJson, type NovaSqliteDatabase } from '../db/sqlite';
import type { NovaAction, NovaMessageEvent } from '../core/types';
import type { SendResult } from '../act/types';
import { conversationIdForChannel, defaultTierForChat, makeId, qqIdFromNodeId } from './constants';
import {
  INITIAL_RV,
  applyInteractionRelationshipUpdate,
  applyNovaActionRelationshipUpdate,
} from './relationship-vector';
import type {
  ActionTraceRecord,
  BeatAttrs,
  BeatType,
  ChannelAttrs,
  ChatType,
  ContactAttrs,
  ConversationAttrs,
  DeliberationTraceRecord,
  EdgeCategory,
  FactAttrs,
  FactType,
  MessageAttrs,
  PersistentActionLogRecord,
  PersonalitySnapshotRecord,
  PressureSnapshotRecord,
  SilenceLogRecord,
  ThreadAttrs,
  ThreadOperation,
  TickTraceRecord,
} from './entities';
import type { NovaActionTrace, NovaDeliberationTrace, NovaTickTrace } from '../trace/types';
import { WorldModel } from './model';
import { updateGroupProfileFromMessage } from '../relationships/group-profile';
import type { GroupProfile, MemberHighlight } from '../relationships/types';
import {
  computeThreadRelevance,
  detectThreadFromMessage,
  isThreadActive,
  advanceThreadWeight,
  resolveThreadWeight,
  createKernelBeat,
  createEngagementBeat,
  createAmbientBeat,
  proactiveBeatSummary,
} from './threads';
import { recordExploreResult } from '../pressure/novelty-tracker';

/** runtime_state key 最大长度 */
const MAX_RUNTIME_STATE_KEY_LENGTH = 200;

function validateRuntimeStateKey(key: string): void {
  if (!key || key.length === 0) {
    throw new Error('runtime_state key must not be empty');
  }
  if (key.length > MAX_RUNTIME_STATE_KEY_LENGTH) {
    throw new Error(
      `runtime_state key exceeds max length ${MAX_RUNTIME_STATE_KEY_LENGTH} (got ${key.length})`,
    );
  }
}

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

interface BeatRow {
  id: string;
  thread_id: string;
  channel_id: string | null;
  message_id: string | null;
  summary: string;
  beat_type: string;
  operation: string;
  weight: number;
  created_ms: number;
}

interface ConversationRow {
  id: string;
  channel_id: string;
  state: 'active' | 'cooldown' | 'closing' | 'closed';
  turn_state: 'nova_turn' | 'user_turn' | 'none';
  last_activity_ms: number;
  closing_since_ms: number | null;
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
    this.loadBeats();
    this.loadConversations();
    this.loadMessages();
    this.loadEdges();
  }

  applyMessageEvent(event: NovaMessageEvent): void {
    const now = Date.now();
    const run = this.db.transaction(() => {
      const contact = this.upsertContact(event, now);
      const channel = this.upsertChannel(event, now);
      if (event.chatType === 'group') this.upsertGroupProfile(event, channel, contact, now);
      const conversation = this.upsertConversation(event, now);
      const message = this.insertMessage(event);
      this.recordEngagement(event, contact.id, channel.id, 'incoming_message', now);
      if (event.isDirected) this.recordEngagement(event, contact.id, channel.id, 'directed_message', now);
      this.resolvePendingProactiveEngagement(event, contact.id, channel.id, now);
      this.upsertEdge(contact.id, channel.id, 'social', { relation: 'contact-channel' }, 1);
      this.upsertEdge(message.id, channel.id, 'spatial', { relation: 'message-channel' }, 1);
      this.upsertEdge(message.id, contact.id, 'ownership', { relation: 'message-sender' }, 1);

      // ── Thread detection ───────────────────────────────────────────────
      this.detectAndUpdateThread(event, channel, conversation, now);

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

  // ── Tick trace persistence (Step 18) ─────────────────────────────────────

  /**
   * 将一个 NovaTickTrace 持久化到 nova_tick_traces 表。
   *
   * 完整的 trace JSON 存储在 trace_json 中，同时 tick / reason /
   * gate_verdict / silence_reason 作为独立列方便索引查询。
   */
  recordTickTrace(trace: NovaTickTrace): void {
    const record: TickTraceRecord = {
      id: trace.tick.toString().padStart(10, '0') + '_' + trace.reason + '_' + Date.now(),
      tick: trace.tick,
      reason: trace.reason,
      gate_verdict: trace.gateVerdict,
      silence_reason: trace.silenceReason ?? null,
      trace_json: stringifyJson(trace as unknown as Record<string, unknown>),
      created_ms: trace.createdMs,
    };
    this.db.prepare(`
      INSERT INTO nova_tick_traces (id, tick, reason, gate_verdict, silence_reason, trace_json, created_ms)
      VALUES (@id, @tick, @reason, @gate_verdict, @silence_reason, @trace_json, @created_ms)
    `).run({
      id: record.id!,
      tick: record.tick,
      reason: record.reason,
      gate_verdict: record.gate_verdict,
      silence_reason: record.silence_reason,
      trace_json: record.trace_json,
      created_ms: record.created_ms,
    });
  }

  /**
   * 列出最近的 tick traces。
   *
   * @param limit 最大返回条数
   * @param reason 可选过滤：只返回 message 或 scheduled tick
   */
  listTickTraces(limit = 50, reason?: 'message' | 'scheduled'): NovaTickTrace[] {
    let rows: Array<{
      tick: number;
      reason: string;
      gate_verdict: string;
      silence_reason: string | null;
      trace_json: string;
      created_ms: number;
    }>;

    if (reason) {
      rows = this.db.prepare(`
        SELECT tick, reason, gate_verdict, silence_reason, trace_json, created_ms
        FROM nova_tick_traces
        WHERE reason = ?
        ORDER BY created_ms DESC
        LIMIT ?
      `).all(reason, safeLimit(limit)) as Array<{
        tick: number;
        reason: string;
        gate_verdict: string;
        silence_reason: string | null;
        trace_json: string;
        created_ms: number;
      }>;
    } else {
      rows = this.db.prepare(`
        SELECT tick, reason, gate_verdict, silence_reason, trace_json, created_ms
        FROM nova_tick_traces
        ORDER BY created_ms DESC
        LIMIT ?
      `).all(safeLimit(limit)) as Array<{
        tick: number;
        reason: string;
        gate_verdict: string;
        silence_reason: string | null;
        trace_json: string;
        created_ms: number;
      }>;
    }

    return rows.map((row) => parseJsonObject(row.trace_json) as unknown as NovaTickTrace);
  }

  recordActionTrace(trace: NovaActionTrace): void {
    const record: ActionTraceRecord = {
      id: makeId('action-trace'),
      tick: trace.tick,
      action_type: trace.actionType,
      target_id: trace.targetId,
      status: trace.status,
      error: trace.error ?? null,
      trace_json: stringifyJson(trace as unknown as Record<string, unknown>),
      created_ms: trace.createdMs,
    };
    this.db.prepare(`
      INSERT INTO nova_action_traces (id, tick, action_type, target_id, status, error, trace_json, created_ms)
      VALUES (@id, @tick, @action_type, @target_id, @status, @error, @trace_json, @created_ms)
    `).run(record);
  }

  listActionTraces(limit = 50): NovaActionTrace[] {
    const rows = this.db.prepare(`
      SELECT trace_json
      FROM nova_action_traces
      ORDER BY created_ms DESC
      LIMIT ?
    `).all(safeLimit(limit)) as Array<{ trace_json: string }>;

    return rows.map((row) => parseJsonObject(row.trace_json) as unknown as NovaActionTrace);
  }

  recordDeliberationTrace(trace: NovaDeliberationTrace): void {
    const record: DeliberationTraceRecord = {
      id: makeId('deliberation-trace'),
      tick: trace.tick,
      reason: trace.reason,
      action_summary: trace.actionSummary ?? null,
      silence_summary: trace.silenceSummary ?? null,
      trace_json: stringifyJson(trace as unknown as Record<string, unknown>),
      created_ms: trace.createdMs,
    };
    this.db.prepare(`
      INSERT INTO nova_deliberation_traces (id, tick, reason, action_summary, silence_summary, trace_json, created_ms)
      VALUES (@id, @tick, @reason, @action_summary, @silence_summary, @trace_json, @created_ms)
    `).run(record);
  }

  listDeliberationTraces(limit = 50, reason?: 'message' | 'scheduled'): NovaDeliberationTrace[] {
    let rows: Array<{ trace_json: string }>;

    if (reason) {
      rows = this.db.prepare(`
        SELECT trace_json
        FROM nova_deliberation_traces
        WHERE reason = ?
        ORDER BY created_ms DESC
        LIMIT ?
      `).all(reason, safeLimit(limit)) as Array<{ trace_json: string }>;
    } else {
      rows = this.db.prepare(`
        SELECT trace_json
        FROM nova_deliberation_traces
        ORDER BY created_ms DESC
        LIMIT ?
      `).all(safeLimit(limit)) as Array<{ trace_json: string }>;
    }

    return rows.map((row) => parseJsonObject(row.trace_json) as unknown as NovaDeliberationTrace);
  }

  /**
   * 列出最近的 proactive（scheduled）tick traces 的轻量摘要。
   * 用于 /traces/proactive API 端点。
   */
  listProactiveTraceSummaries(limit = 50): Array<Record<string, unknown>> {
    const rows = this.db.prepare(`
      SELECT tick, reason, gate_verdict, silence_reason, trace_json, created_ms
      FROM nova_tick_traces
      WHERE reason = 'scheduled'
      ORDER BY created_ms DESC
      LIMIT ?
    `).all(safeLimit(limit)) as Array<{
      tick: number;
      reason: string;
      gate_verdict: string;
      silence_reason: string | null;
      trace_json: string;
      created_ms: number;
    }>;

    return rows.map((row) => {
      const trace = parseJsonObject(row.trace_json) as Record<string, unknown>;
      return {
        tick: row.tick,
        reason: row.reason,
        gateVerdict: row.gate_verdict,
        silenceReason: row.silence_reason,
        mode: trace.mode,
        selectedVoice: trace.selectedVoice,
        iausAction: trace.iausAction,
        desireCount: Array.isArray(trace.desires) ? trace.desires.length : 0,
        candidateCount: Array.isArray(trace.candidates) ? trace.candidates.length : 0,
        selectedAction: trace.selectedCandidate
          ? (trace.selectedCandidate as Record<string, unknown>).action
          : null,
        createdMs: row.created_ms,
      };
    });
  }

  getRuntimeState<T>(key: string): T | undefined {
    validateRuntimeStateKey(key);
    const row = this.db.prepare(`
      SELECT value_json
      FROM runtime_state
      WHERE key = ?
    `).get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return undefined;
    }
  }

  setRuntimeState<T>(key: string, value: T, nowMs = Date.now()): void {
    validateRuntimeStateKey(key);
    this.db.prepare(`
      INSERT OR REPLACE INTO runtime_state (key, value_json, updated_at)
      VALUES (?, ?, ?)
    `).run(key, stringifyJson(value), nowMs);
  }

  /**
   * 删除一条 runtime_state 记录。
   * 用于 afterward 过期清理等场景。key 不存在时静默成功。
   */
  deleteRuntimeState(key: string, _nowMs?: number): void {
    validateRuntimeStateKey(key);
    this.db.prepare('DELETE FROM runtime_state WHERE key = ?').run(key);
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
      p7: snapshot.p7 ?? 0,
      p8: snapshot.p8 ?? 0,
      p_prospect: snapshot.p_prospect,
      api: snapshot.api,
      api_peak: snapshot.api_peak,
      created_ms: snapshot.created_ms ?? Date.now(),
      contributions_json: stringifyJson(snapshot.contributions ?? {}),
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO pressure_snapshots
      (id, tick, p1, p2, p3, p4, p5, p6, p7, p8, p_prospect, api, api_peak, created_ms, contributions_json)
      VALUES (@id, @tick, @p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8, @p_prospect, @api, @api_peak, @created_ms, @contributions_json)
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

  markNovaAction(targetId: string, nowMs = Date.now(), options: { proactive?: boolean; text?: string; desireType?: string; urgency?: string } = {}): void {
    const channel = this.resolveActionChannel(targetId);
    if (!channel) return;

    const nextChannel: ChannelAttrs = {
      ...channel,
      last_nova_action_ms: nowMs,
      ...(options.proactive ? { last_proactive_outreach_ms: nowMs } : {}),
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

    this.recordActionEngagement(channel, options.proactive ? 'proactive_action' : 'nova_action', nowMs, options.desireType);
    if (options.proactive) this.markProactiveContact(channel, nowMs);

    // ── Write engagement beat to active thread ────────────────────────────
    this.writeNovaActionBeat(channel, nowMs, options);
  }

  /**
   * 为 Nova 的发言（回复或主动消息）在当前 channel 的活跃线程中写入
   * engagement beat。如果不存在活跃线程，则为回复消息自动创建线程。
   */
  private writeNovaActionBeat(
    channel: ChannelAttrs,
    nowMs: number,
    options: { proactive?: boolean; text?: string; desireType?: string; urgency?: string },
  ): void {
    const activeThreads = this.getActiveThreadsForChannel(channel.id, nowMs, 1);
    const scene: 'private' | 'group' = channel.chat_type === 'group' ? 'group' : 'private';

    if (activeThreads.length > 0) {
      // Advance the existing thread with an engagement beat.
      const thread = activeThreads[0]!;
      const summary = options.proactive
        ? proactiveBeatSummary({
            desireType: options.desireType ?? 'reconnect',
            urgency: options.urgency ?? 'medium',
            scene,
          })
        : `Nova回复了${channel.chat_type === 'group' ? '群聊' : '私聊'}消息`;
      const beat = createEngagementBeat(thread.id, channel.id, summary, undefined, nowMs);
      this.addBeat(beat);
    } else if (!options.proactive) {
      // For replies without an existing thread, auto-create a lightweight
      // thread so narrative tracking begins.  Proactive messages shouldn't
      // auto-create threads — they should only advance existing ones.
      const summary = options.text
        ? (options.text.length > 80 ? `${options.text.slice(0, 80)}…` : options.text)
        : `Nova在${scene}发言`;
      this.createThread({
        channelId: channel.id,
        summary,
        nowMs,
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
      SELECT id, tick, p1, p2, p3, p4, p5, p6, p7, p8, p_prospect, api, api_peak, created_ms, contributions_json
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
      p7: number;
      p8: number;
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
      p7: row.p7,
      p8: row.p8,
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

  /** Count how many engagements are currently in a non-terminal state. */
  countActiveEngagements(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM engagements
      WHERE json_extract(attrs_json, '$.state') != 'done'
    `).get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /**
   * 检查指定 contact+channel 是否有待解决（waiting_reply）的主动 engagement。
   *
   * 用于 Step 18 engagement trace：在 applyMessageEvent 之前调用，
   * 如果存在 waiting_reply 的 engagement，则用户正在回复主动消息，
   * resolvePendingProactiveEngagement 会将其转为 replied。
   *
   * @returns engagement 的 attrs（含 desire_type 等信息），若无则返回 null
   */
  checkPendingProactiveEngagement(contactId: string, channelId: string): Record<string, unknown> | null {
    const id = `engagement:${channelId}:${contactId}:proactive_action`;
    const existing = this.db.prepare('SELECT attrs_json FROM engagements WHERE id = ?').get(id) as { attrs_json: string } | undefined;
    if (!existing) return null;
    const attrs = parseJsonObject(existing.attrs_json);
    if (attrs.state !== 'waiting_reply') return null;
    return attrs;
  }

  expirePendingProactiveEngagements(nowMs = Date.now(), timeoutMs = 24 * 60 * 60 * 1000): Array<{ contactId: string; channelId: string; desireType: string; elapsedMs: number }> {
    const rows = this.db.prepare(`
      SELECT id, contact_id, channel_id, attrs_json, last_event_ms
      FROM engagements
      WHERE kind = 'proactive_action'
    `).all() as Array<{ id: string; contact_id: string | null; channel_id: string; attrs_json: string; last_event_ms: number }>;

    const expired: Array<{ contactId: string; channelId: string; desireType: string; elapsedMs: number }> = [];

    for (const row of rows) {
      const attrs = parseJsonObject(row.attrs_json);
      if (attrs.state !== 'waiting_reply') continue;
      if (nowMs - row.last_event_ms < timeoutMs) continue;

      this.db.prepare(`
        UPDATE engagements
        SET attrs_json = @attrs_json, updated_at = @updated_at
        WHERE id = @id
      `).run({
        id: row.id,
        attrs_json: stringifyJson({
          ...attrs,
          state: 'timeout',
          outcome: 'timeout',
          timeout_ms: nowMs,
        }),
        updated_at: nowMs,
      });

      expired.push({
        contactId: row.contact_id ?? 'unknown',
        channelId: row.channel_id,
        desireType: typeof attrs.desire_type === 'string' ? attrs.desire_type : 'unknown',
        elapsedMs: nowMs - row.last_event_ms,
      });

      // ── Step 15: record explore timeout in novelty tracker ──────────────
      if (attrs.desire_type === 'explore' && row.contact_id) {
        recordExploreResult(row.contact_id, false, nowMs);
      }
    }

    return expired;
  }

  private recordActionEngagement(channel: ChannelAttrs, kind: string, nowMs: number, desireType?: string): void {
    const contactId = channel.chat_type === 'private' ? `qq:user:${qqIdFromNodeId(channel.id)}` : null;
    const id = `engagement:${channel.id}:${contactId ?? 'none'}:${kind}`;
    const existing = this.db.prepare('SELECT count, attrs_json FROM engagements WHERE id = ?').get(id) as { count: number; attrs_json: string } | undefined;
    const attrs = {
      ...parseJsonObject(existing?.attrs_json),
      platform: channel.platform,
      chat_type: channel.chat_type,
      state: kind === 'proactive_action' ? 'waiting_reply' : 'active',
      last_action_ms: nowMs,
      ...(desireType ? { desire_type: desireType } : {}),
    };

    this.db.prepare(`
      INSERT INTO engagements
      (id, channel_id, contact_id, kind, count, last_event_ms, attrs_json, created_at, updated_at)
      VALUES (@id, @channel_id, @contact_id, @kind, @count, @last_event_ms, @attrs_json, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        count = excluded.count,
        last_event_ms = excluded.last_event_ms,
        attrs_json = excluded.attrs_json,
        updated_at = excluded.updated_at
    `).run({
      id,
      channel_id: channel.id,
      contact_id: contactId,
      kind,
      count: (existing?.count ?? 0) + 1,
      last_event_ms: nowMs,
      attrs_json: stringifyJson(attrs),
      created_at: nowMs,
      updated_at: nowMs,
    });
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

  private markProactiveContact(channel: ChannelAttrs, nowMs: number): void {
    const contactId = channel.chat_type === 'private' ? `qq:user:${qqIdFromNodeId(channel.id)}` : undefined;
    if (!contactId) return;

    const contact = this.world.has(contactId) && this.world.getNodeType(contactId) === 'contact'
      ? this.world.getContact(contactId)
      : this.loadContactById(contactId);
    if (!contact) return;

    const nextContact = applyNovaActionRelationshipUpdate(contact, nowMs, { proactive: true });
    this.persistContact(nextContact, nowMs);
  }

  private persistContact(attrs: ContactAttrs, now: number): void {
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
      name: attrs.name ?? attrs.nickname ?? null,
      tier: attrs.tier,
      attrs_json: stringifyJson(attrs),
      created_at: now,
      updated_at: now,
    });

    if (this.world.has(attrs.id)) this.world.updateContact(attrs.id, attrs);
    else this.world.addContact(attrs.id, attrs);
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
      INSERT INTO conversations (id, channel_id, state, turn_state, last_activity_ms, closing_since_ms, attrs_json)
      VALUES (@id, @channel_id, @state, @turn_state, @last_activity_ms, @closing_since_ms, @attrs_json)
      ON CONFLICT(id) DO UPDATE SET
        channel_id = excluded.channel_id,
        state = excluded.state,
        turn_state = excluded.turn_state,
        last_activity_ms = excluded.last_activity_ms,
        closing_since_ms = excluded.closing_since_ms,
        attrs_json = excluded.attrs_json
    `).run({
      id: attrs.id,
      channel_id: attrs.channel_id,
      state: attrs.state,
      turn_state: attrs.turn_state,
      last_activity_ms: attrs.last_activity_ms,
      closing_since_ms: attrs.closing_since_ms ?? null,
      attrs_json: stringifyJson(attrs),
    });

    if (this.world.has(attrs.id)) this.world.updateConversation(attrs.id, attrs);
    else this.world.addConversation(attrs.id, attrs);
  }

  private persistBeat(beat: BeatAttrs): void {
    this.db.prepare(`
      INSERT INTO thread_beats (id, thread_id, channel_id, message_id, summary, beat_type, operation, weight, created_ms)
      VALUES (@id, @thread_id, @channel_id, @message_id, @summary, @beat_type, @operation, @weight, @created_ms)
    `).run({
      id: beat.id,
      thread_id: beat.thread_id,
      channel_id: beat.channel_id ?? null,
      message_id: beat.message_id ?? null,
      summary: beat.summary,
      beat_type: beat.beat_type,
      operation: beat.operation,
      weight: beat.weight,
      created_ms: beat.created_ms,
    });
  }

  /**
   * 根据收到的消息检测是否需要 begin / advance 叙事线程。
   *
   * 使用规则驱动的 detectThreadFromMessage，不调用 LLM。
   * - 有实质内容且无活跃线程 → begin_topic（创建新线程 + kernel beat）
   * - 有实质内容且有活跃线程 → advance_topic（更新线程摘要 + ambient beat）
   * - 无实质内容 → 不操作
   */
  private detectAndUpdateThread(
    event: NovaMessageEvent,
    _channel: ChannelAttrs,
    conversation: ConversationAttrs,
    now: number,
  ): void {
    const hasActiveConversation = conversation.state === 'active';
    const unresolvedCount = this.countUnresolvedThreadsForChannel(event.chatId, now);
    const lastCreatedMs = this.getLastThreadCreatedMsForChannel(event.chatId);

    const detection = detectThreadFromMessage({
      text: event.text,
      isDirected: event.isDirected,
      hasActiveConversation,
      existingUnresolvedThreadCount: unresolvedCount,
      lastThreadCreatedMs: lastCreatedMs,
      nowMs: now,
    });

    if (detection.operation === 'begin_topic') {
      this.createThread({
        channelId: event.chatId,
        summary: detection.topicSummary,
        messageId: event.messageId,
        nowMs: now,
      });
    } else if (detection.operation === 'advance_topic' && unresolvedCount > 0) {
      // Advance the most recently created unresolved thread for this channel.
      const activeThreads = this.getActiveThreadsForChannel(event.chatId, now, 1);
      if (activeThreads.length > 0) {
        const thread = activeThreads[0]!;
        const beat = createAmbientBeat(thread.id, event.chatId, detection.topicSummary, event.messageId, now);
        this.addBeat(beat);
      }
    }
  }

  private upsertContact(event: NovaMessageEvent, now: number): ContactAttrs {
    const existing = this.world.has(event.senderId) ? this.world.getContact(event.senderId) : this.loadContactById(event.senderId);
    const tier = existing?.tier ?? defaultTierForChat(event.chatType);
    const relationship = applyInteractionRelationshipUpdate(existing ?? {
      last_active_ms: event.timestamp,
      rv_familiarity: INITIAL_RV.familiarity,
      rv_trust: INITIAL_RV.trust,
      rv_affection: INITIAL_RV.affection,
      rv_attraction: INITIAL_RV.attraction,
      rv_respect: INITIAL_RV.respect,
    }, event.timestamp);
    const attrs: ContactAttrs = {
      id: event.senderId,
      entity_type: 'contact',
      platform: 'qq',
      qq: event.senderQQ,
      ...(event.senderName === undefined ? {} : { name: event.senderName, nickname: event.senderName }),
      tier,
      last_active_ms: event.timestamp,
      interaction_count: (existing?.interaction_count ?? 0) + 1,
      ...relationship,
      language_preference: existing?.language_preference,
      nova_initiated_count: existing?.nova_initiated_count ?? 0,
      contact_initiated_count: (existing?.contact_initiated_count ?? 0) + 1,
      last_proactive_outreach_ms: existing?.last_proactive_outreach_ms,
      hawkes_carry: (existing?.hawkes_carry ?? 0) + 1,
      hawkes_last_event_ms: event.timestamp,
      is_bot: existing?.is_bot,
    };

    this.persistContact(attrs, now);
    return attrs;
  }

  private upsertChannel(event: NovaMessageEvent, now: number): ChannelAttrs {
    const existing = this.world.has(event.chatId) ? this.world.getChannel(event.chatId) : this.loadChannelById(event.chatId);
    const attrs: ChannelAttrs = {
      id: event.chatId,
      entity_type: 'channel',
      platform: 'qq',
      chat_type: event.chatType,
      ...(event.groupName === undefined ? {} : { title: event.groupName, group_name: event.groupName }),
      tier_contact: existing?.tier_contact ?? defaultTierForChat(event.chatType),
      unread: (existing?.unread ?? 0) + 1,
      pending_directed: (existing?.pending_directed ?? 0) + (event.isDirected ? 1 : 0),
      last_activity_ms: event.timestamp,
      last_incoming_ms: event.timestamp,
      ...(event.isDirected ? { last_directed_ms: event.timestamp } : existing?.last_directed_ms === undefined ? {} : { last_directed_ms: existing.last_directed_ms }),
      last_nova_action_ms: existing?.last_nova_action_ms,
      last_proactive_outreach_ms: existing?.last_proactive_outreach_ms,
      last_read_ms: existing?.last_read_ms,
      nova_thinking_since: existing?.nova_thinking_since ?? null,
      contact_recv_window: (existing?.contact_recv_window ?? 0) + 1,
      activity_relevance: existing?.activity_relevance ?? 1,
      ...(event.groupId === undefined ? {} : { group_id: event.groupId }),
      member_count: existing?.member_count ?? 0,
      nova_role_in_group: existing?.nova_role_in_group ?? (event.chatType === 'group' ? 'member' : undefined),
      group_risk_level: existing?.group_risk_level ?? (event.chatType === 'group' ? 'normal' : undefined),
      hawkes_carry: (existing?.hawkes_carry ?? 0) + (event.isDirected ? 1 : 0.2),
      hawkes_last_event_ms: event.timestamp,
    };

    this.persistChannel(attrs, now);
    return attrs;
  }

  private recordEngagement(
    event: NovaMessageEvent,
    contactId: string | undefined,
    channelId: string,
    kind: string,
    now: number,
  ): void {
    const id = `engagement:${channelId}:${contactId ?? 'none'}:${kind}`;
    const existing = this.db.prepare('SELECT count, attrs_json FROM engagements WHERE id = ?').get(id) as { count: number; attrs_json: string } | undefined;
    const attrs = {
      ...parseJsonObject(existing?.attrs_json),
      platform: event.platform,
      chat_type: event.chatType,
      directed: event.isDirected,
      last_message_id: event.messageId,
    };

    this.db.prepare(`
      INSERT INTO engagements
      (id, channel_id, contact_id, kind, count, last_event_ms, attrs_json, created_at, updated_at)
      VALUES (@id, @channel_id, @contact_id, @kind, @count, @last_event_ms, @attrs_json, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        count = excluded.count,
        last_event_ms = excluded.last_event_ms,
        attrs_json = excluded.attrs_json,
        updated_at = excluded.updated_at
    `).run({
      id,
      channel_id: channelId,
      contact_id: contactId ?? null,
      kind,
      count: (existing?.count ?? 0) + 1,
      last_event_ms: event.timestamp,
      attrs_json: stringifyJson(attrs),
      created_at: now,
      updated_at: now,
    });
  }

  private resolvePendingProactiveEngagement(event: NovaMessageEvent, contactId: string, channelId: string, now: number): void {
    const id = `engagement:${channelId}:${contactId}:proactive_action`;
    const existing = this.db.prepare('SELECT attrs_json FROM engagements WHERE id = ?').get(id) as { attrs_json: string } | undefined;
    if (!existing) return;

    const attrs = parseJsonObject(existing.attrs_json);
    if (attrs.state !== 'waiting_reply') return;

    this.db.prepare(`
      UPDATE engagements
      SET attrs_json = @attrs_json, last_event_ms = @last_event_ms, updated_at = @updated_at
      WHERE id = @id
    `).run({
      id,
      last_event_ms: event.timestamp,
      updated_at: now,
      attrs_json: stringifyJson({
        ...attrs,
        state: 'replied',
        outcome: 'replied',
        reply_message_id: event.messageId,
        replied_ms: event.timestamp,
      }),
    });

    // ── Step 15: update novelty tracker for explore engagements ───────────
    if (attrs.desire_type === 'explore') {
      recordExploreResult(contactId, true, now);
    }

    // ── Thread advancement on proactive reply ─────────────────────────────
    // When a user replies to Nova's proactive message, advance the
    // associated thread with an engagement beat to record the response.
    const activeThreads = this.getActiveThreadsForChannel(channelId, now, 1);
    if (activeThreads.length > 0) {
      const summary = `用户回复了Nova的主动消息：${event.text.length > 60 ? event.text.slice(0, 60) + '…' : event.text}`;
      const beat = createEngagementBeat(activeThreads[0]!.id, channelId, summary, event.messageId, now);
      this.addBeat(beat);
    }
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

  private upsertGroupProfile(event: NovaMessageEvent, channel: ChannelAttrs, contact: ContactAttrs, now: number): void {
    if (!event.groupId) return;
    const existingRow = this.db.prepare(`
      SELECT member_count, nova_role_in_group, group_risk_level, attrs_json
      FROM group_profiles
      WHERE group_id = ?
    `).get(event.groupId) as { member_count: number; nova_role_in_group: string; group_risk_level: string; attrs_json: string } | undefined;

    const previousProfile = parseGroupProfile(existingRow?.attrs_json);
    const profile = updateGroupProfileFromMessage(previousProfile, event, contact, now);

    this.db.prepare(`
      INSERT INTO group_profiles
      (group_id, channel_id, group_name, member_count, nova_role_in_group, group_risk_level, last_activity_ms, last_incoming_ms, attrs_json, created_at, updated_at)
      VALUES (@group_id, @channel_id, @group_name, @member_count, @nova_role_in_group, @group_risk_level, @last_activity_ms, @last_incoming_ms, @attrs_json, @created_at, @updated_at)
      ON CONFLICT(group_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        group_name = excluded.group_name,
        member_count = excluded.member_count,
        nova_role_in_group = excluded.nova_role_in_group,
        group_risk_level = excluded.group_risk_level,
        last_activity_ms = excluded.last_activity_ms,
        last_incoming_ms = excluded.last_incoming_ms,
        attrs_json = excluded.attrs_json,
        updated_at = excluded.updated_at
    `).run({
      group_id: event.groupId,
      channel_id: channel.id,
      group_name: event.groupName ?? channel.group_name ?? channel.title ?? null,
      member_count: channel.member_count ?? existingRow?.member_count ?? 0,
      nova_role_in_group: channel.nova_role_in_group ?? existingRow?.nova_role_in_group ?? 'member',
      group_risk_level: channel.group_risk_level ?? existingRow?.group_risk_level ?? 'normal',
      last_activity_ms: event.timestamp,
      last_incoming_ms: event.timestamp,
      attrs_json: stringifyJson(profile as unknown as Record<string, unknown>),
      created_at: now,
      updated_at: now,
    });
  }

  /** 按 QQ 群号获取群画像 */
  getGroupProfile(groupId: string): GroupProfile | null {
    const row = this.db.prepare('SELECT attrs_json FROM group_profiles WHERE group_id = ?').get(groupId) as { attrs_json: string } | undefined;
    return row ? parseGroupProfile(row.attrs_json) : null;
  }

  /** 按频道 ID 获取群画像 (用于遍历和 prompt 注入) */
  getGroupProfileByChannelId(channelId: string): GroupProfile | null {
    const row = this.db.prepare('SELECT attrs_json FROM group_profiles WHERE channel_id = ?').get(channelId) as { attrs_json: string } | undefined;
    return row ? parseGroupProfile(row.attrs_json) : null;
  }

  /** 获取所有群画像列表 */
  listGroupProfiles(): GroupProfile[] {
    const rows = this.db.prepare('SELECT attrs_json FROM group_profiles').all() as Array<{ attrs_json: string }>;
    return rows.map((row) => parseGroupProfile(row.attrs_json)).filter((p): p is GroupProfile => p !== null);
  }

  // ── Thread CRUD ──────────────────────────────────────────────────────────

  /** 创建新叙事线程并写入首个 beat（kernel）。 */
  createThread(params: {
    channelId?: string;
    summary: string;
    messageId?: string;
    nowMs: number;
  }): ThreadAttrs {
    const id = makeId('thread');
    const now = params.nowMs;
    const thread: ThreadAttrs = {
      id,
      entity_type: 'thread',
      status: 'open',
      w: 1.0,
      created_ms: now,
      channel_id: params.channelId,
      summary: params.summary,
    };

    this.db.prepare(`
      INSERT INTO threads (id, channel_id, status, summary, w, created_ms)
      VALUES (@id, @channel_id, @status, @summary, @w, @created_ms)
    `).run({
      id: thread.id,
      channel_id: thread.channel_id ?? null,
      status: thread.status,
      summary: thread.summary ?? null,
      w: thread.w,
      created_ms: thread.created_ms,
    });

    this.world.addThread(thread.id, thread);

    // 写入 kernel beat
    const beat = createKernelBeat(thread.id, params.channelId, params.summary, params.messageId, now);
    this.persistBeat(beat);

    return thread;
  }

  /** 更新线程权重和摘要（advance）。 */
  updateThread(id: string, patch: { summary?: string; weightBump?: number }, _nowMs?: number): ThreadAttrs | null {
    if (!this.world.has(id) || this.world.getNodeType(id) !== 'thread') return null;
    const current = this.world.getThread(id);

    const nextSummary = patch.summary ?? current.summary;
    const nextW = patch.weightBump !== undefined
      ? advanceThreadWeight(current.w, patch.weightBump)
      : current.w;

    const updated: ThreadAttrs = {
      ...current,
      summary: nextSummary,
      w: nextW,
    };

    this.db.prepare(`
      UPDATE threads SET summary = @summary, w = @w WHERE id = @id
    `).run({ id, summary: updated.summary ?? null, w: updated.w });

    this.world.updateThread(id, updated);
    return updated;
  }

  /** 结束线程（resolve）。权重降至残留值，状态变为 closed。 */
  resolveThread(id: string, _nowMs?: number): ThreadAttrs | null {
    if (!this.world.has(id) || this.world.getNodeType(id) !== 'thread') return null;
    const current = this.world.getThread(id);

    const updated: ThreadAttrs = {
      ...current,
      status: 'closed',
      w: resolveThreadWeight(current.w),
    };

    this.db.prepare(`
      UPDATE threads SET status = @status, w = @w WHERE id = @id
    `).run({ id, status: updated.status, w: updated.w });

    this.world.updateThread(id, updated);
    return updated;
  }

  /** 为线程添加一个 beat 并更新线程权重。 */
  addBeat(beat: BeatAttrs): void {
    this.persistBeat(beat);
    this.updateThread(beat.thread_id, { weightBump: beat.weight }, beat.created_ms);
  }

  /** 获取指定线程的所有 beat（按时间升序）。 */
  getBeatsForThread(threadId: string): BeatAttrs[] {
    const rows = this.db.prepare(`
      SELECT id, thread_id, channel_id, message_id, summary, beat_type, operation, weight, created_ms
      FROM thread_beats
      WHERE thread_id = ?
      ORDER BY created_ms ASC
    `).all(threadId) as BeatRow[];
    return rows.map(beatFromRow);
  }

  /**
   * 获取指定 channel 在指定时间窗口内的最近 beats。
   * 用于 thread_note 去重：检查短时间内是否有相似 summary 的 observation beat。
   */
  getRecentBeatsForChannel(channelId: string, sinceMs: number, limit = 20): BeatAttrs[] {
    const rows = this.db.prepare(`
      SELECT id, thread_id, channel_id, message_id, summary, beat_type, operation, weight, created_ms
      FROM thread_beats
      WHERE channel_id = ? AND created_ms >= ?
      ORDER BY created_ms DESC
      LIMIT ?
    `).all(channelId, sinceMs, safeLimit(limit)) as BeatRow[];
    return rows.map(beatFromRow);
  }

  /** 获取指定 channel 的活跃（open + relevance >= threshold）线程，按权重降序。 */
  getActiveThreadsForChannel(channelId: string, nowMs: number, limit = 5): ThreadAttrs[] {
    const allThreads = this.world.getEntitiesByType('thread')
      .map((id) => {
        if (this.world.getNodeType(id) !== 'thread') return null;
        return this.world.getThread(id);
      })
      .filter((t): t is ThreadAttrs =>
        t !== null &&
        t.status === 'open' &&
        t.channel_id === channelId &&
        (t.summary ?? '').length > 0
      );

    // Compute current relevance and filter.
    const withRelevance = allThreads.map((t) => ({
      thread: t,
      relevance: computeThreadRelevance(t.w, t.created_ms, nowMs),
    }));

    return withRelevance
      .filter((item) => isThreadActive(item.relevance))
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit)
      .map((item) => item.thread);
  }

  /** 获取所有未决（open + relevance >= threshold）线程，用于 proactive desire 扫描。 */
  getUnresolvedThreads(nowMs: number, limit = 10): ThreadAttrs[] {
    const allThreads = this.world.getEntitiesByType('thread')
      .map((id) => {
        if (this.world.getNodeType(id) !== 'thread') return null;
        return this.world.getThread(id);
      })
      .filter((t): t is ThreadAttrs =>
        t !== null &&
        t.status === 'open' &&
        (t.summary ?? '').length > 0
      );

    const withRelevance = allThreads.map((t) => ({
      thread: t,
      relevance: computeThreadRelevance(t.w, t.created_ms, nowMs),
    }));

    return withRelevance
      .filter((item) => isThreadActive(item.relevance))
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit)
      .map((item) => item.thread);
  }

  /** 获取指定 channel 中未决线程的数量。 */
  countUnresolvedThreadsForChannel(channelId: string, _nowMs?: number): number {
    return this.world.getEntitiesByType('thread')
      .filter((id) => {
        if (this.world.getNodeType(id) !== 'thread') return false;
        const t = this.world.getThread(id);
        return t.status === 'open' && t.channel_id === channelId;
      })
      .length;
  }

  /**
   * List upcoming future_event facts within the given window.
   * Returns events whose status is 'upcoming' and mentioned within range.
   */
  listUpcomingEvents(nowMs: number, windowMs: number = 7 * 24 * 3600 * 1000): Array<{
    id: string;
    event: string;
    dateDescription: string;
    date?: string;
    targetId: string;
    mentionedAtMs: number;
    status: string;
  }> {
    const rows = this.db.prepare(`
      SELECT id, content, created_ms
      FROM facts
      WHERE fact_type = 'memory'
      ORDER BY created_ms DESC
      LIMIT 200
    `).all() as Array<{ id: string; content: string; created_ms: number }>;

    const events: Array<{
      id: string;
      event: string;
      dateDescription: string;
      date?: string;
      targetId: string;
      mentionedAtMs: number;
      status: string;
    }> = [];

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.content) as Record<string, unknown>;
        if (parsed.type !== 'future_event') continue;
        if (parsed.status !== 'upcoming') continue;
        events.push({
          id: row.id,
          event: typeof parsed.event === 'string' ? parsed.event : '',
          dateDescription: typeof parsed.dateDescription === 'string' ? parsed.dateDescription : '',
          date: typeof parsed.date === 'string' ? parsed.date : undefined,
          targetId: typeof parsed.targetId === 'string' ? parsed.targetId : '',
          mentionedAtMs: typeof parsed.mentionedAtMs === 'number' ? parsed.mentionedAtMs : row.created_ms,
          status: 'upcoming',
        });
      } catch {
        // Skip non-JSON facts
      }
    }

    return events;
  }

  /** Mark a future_event as acknowledged or passed. */
  markEventAcknowledged(factId: string, status: 'acknowledged' | 'passed'): void {
    const row = this.db.prepare('SELECT content FROM facts WHERE id = ?').get(factId) as { content: string } | undefined;
    if (!row) return;
    try {
      const parsed = JSON.parse(row.content) as Record<string, unknown>;
      parsed.status = status;
      this.db.prepare('UPDATE facts SET content = ? WHERE id = ?').run(JSON.stringify(parsed), factId);
    } catch {
      // Skip non-JSON facts
    }
  }

  /** 获取指定 channel 最近创建的线程时间戳。 */
  getLastThreadCreatedMsForChannel(channelId: string): number | undefined {
    let latest: number | undefined;
    for (const id of this.world.getEntitiesByType('thread')) {
      if (this.world.getNodeType(id) !== 'thread') continue;
      const t = this.world.getThread(id);
      if (t.channel_id === channelId) {
        if (latest === undefined || t.created_ms > latest) latest = t.created_ms;
      }
    }
    return latest;
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

  private loadBeats(): void {
    // Beats are loaded for query access — they're stored in the DB and
    // retrieved on demand via getBeatsForThread().  We don't store them
    // in the in-memory WorldModel to keep the graph lean.
  }

  private loadConversations(): void {
    const rows = this.db.prepare('SELECT id, channel_id, state, turn_state, last_activity_ms, closing_since_ms, attrs_json FROM conversations').all() as ConversationRow[];
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
    const row = this.db.prepare('SELECT id, channel_id, state, turn_state, last_activity_ms, closing_since_ms, attrs_json FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    return row ? conversationFromRow(row) : undefined;
  }
}

function parseGroupProfile(raw: unknown): GroupProfile | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.groupId !== 'string' || obj.groupId.length === 0) return null;

  const memberHighlights: MemberHighlight[] = Array.isArray(obj.memberHighlights)
    ? obj.memberHighlights.filter(isMemberHighlight)
    : [];

  const activeHours: number[] = Array.isArray(obj.activeHours) && obj.activeHours.length === 24
    ? obj.activeHours.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
    : new Array(24).fill(0) as number[];

  const crystallizedInterests: Record<string, unknown> = {};
  if (obj.crystallizedInterests !== null && typeof obj.crystallizedInterests === 'object' && !Array.isArray(obj.crystallizedInterests)) {
    for (const [key, value] of Object.entries(obj.crystallizedInterests as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        crystallizedInterests[key] = value;
      }
    }
  }

  return {
    groupId: obj.groupId as string,
    groupName: typeof obj.groupName === 'string' ? obj.groupName : '',
    topic: typeof obj.topic === 'string' ? obj.topic : null,
    atmosphere: typeof obj.atmosphere === 'string' ? obj.atmosphere : null,
    novaRole: typeof obj.novaRole === 'string' ? obj.novaRole : null,
    memberHighlights,
    crystallizedInterests: crystallizedInterests as GroupProfile['crystallizedInterests'],
    activeHours,
    recentTopicDrift: typeof obj.recentTopicDrift === 'string' ? obj.recentTopicDrift : null,
    updatedMs: typeof obj.updatedMs === 'number' ? obj.updatedMs : 0,
  };
}

function isMemberHighlight(value: unknown): value is MemberHighlight {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.contactId === 'string'
    && typeof obj.qq === 'string'
    && typeof obj.displayName === 'string'
    && typeof obj.lastSeenInGroupMs === 'number'
    && typeof obj.directedCount === 'number'
    && typeof obj.replyCount === 'number';
}

function normalizeRelationType(value: unknown): ContactAttrs['relation_type'] {
  switch (value) {
    case 'romantic':
    case 'close_friend':
    case 'friend':
    case 'family':
    case 'colleague':
    case 'acquaintance':
    case 'unknown':
      return value;
    default:
      return 'unknown';
  }
}

function contactFromRow(row: ContactRow): ContactAttrs {
  const attrs = parseJsonObject(row.attrs_json) as Partial<ContactAttrs>;
  const qq = row.qq || attrs.qq || qqIdFromNodeId(row.id);
  return {
    id: row.id,
    entity_type: 'contact',
    platform: 'qq',
    qq,
    ...(row.name === null ? {} : { name: row.name }),
    tier: row.tier as ContactAttrs['tier'],
    interaction_count: 0,
    relation_type: normalizeRelationType(attrs.relation_type),
    nova_initiated_count: 0,
    contact_initiated_count: 0,
    rv_familiarity: INITIAL_RV.familiarity,
    rv_trust: INITIAL_RV.trust,
    rv_affection: INITIAL_RV.affection,
    rv_attraction: INITIAL_RV.attraction,
    rv_respect: INITIAL_RV.respect,
    rv_familiarity_velocity: 0,
    rv_trust_velocity: 0,
    rv_affection_velocity: 0,
    rv_attraction_velocity: 0,
    rv_respect_velocity: 0,
    hawkes_carry: 0,
    ...attrs,
  };
}

function channelFromRow(row: ChannelRow): ChannelAttrs {
  const attrs = parseJsonObject(row.attrs_json) as Partial<ChannelAttrs>;
  const chatType = row.chat_type || attrs.chat_type || (row.id.startsWith('qq:group:') ? 'group' : 'private');
  return {
    id: row.id,
    entity_type: 'channel',
    platform: row.platform || attrs.platform || 'qq',
    chat_type: chatType,
    ...(row.title === null ? {} : { title: row.title }),
    tier_contact: defaultTierForChat(chatType),
    unread: 0,
    pending_directed: 0,
    last_activity_ms: 0,
    nova_thinking_since: null,
    contact_recv_window: 0,
    activity_relevance: 1,
    member_count: 0,
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
    ...(row.closing_since_ms === null ? {} : { closing_since_ms: row.closing_since_ms }),
    ...attrs,
  };
}

function beatFromRow(row: BeatRow): BeatAttrs {
  return {
    id: row.id,
    thread_id: row.thread_id,
    channel_id: row.channel_id ?? undefined,
    message_id: row.message_id ?? undefined,
    summary: row.summary,
    beat_type: (row.beat_type ?? 'ambient') as BeatType,
    operation: (row.operation ?? 'advance_topic') as ThreadOperation,
    weight: row.weight,
    created_ms: row.created_ms,
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
