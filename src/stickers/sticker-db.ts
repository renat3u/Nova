//
// Nova 表情包独立数据库
//
// 存储所有看过的 QQ 表情（mface / image_sticker），独立于 nova.sqlite，
// 避免用户定期清理 nova.sqlite 时丢失表情收藏。
//
// 去重键：(emoji_package_id, emoji_id) — QQ 表情全局唯一标识。
// 同一贴纸被不同人在不同群发，都映射到同一条记录，seen_count 累加。
//

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface StickerRecord {
  id: string;
  emoji_package_id: number;
  emoji_id: string;
  key: string;
  summary: string | null;
  url: string | null;
  sender_id: string | null;
  channel_id: string | null;
  message_id: string | null;
  seen_count: number;
  first_seen_ms: number;
  last_seen_ms: number;
  sent_count: number;
  last_sent_ms: number | null;
  seen_in_private: number;
  seen_in_group: number;
}

export interface StickerUpsertInput {
  emoji_package_id: number;
  emoji_id: string;
  key: string;
  summary?: string | null;
  url?: string | null;
  sender_id?: string | null;
  channel_id?: string | null;
  message_id?: string | null;
  chatType: 'private' | 'group';
}

const STICKER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stickers (
  id TEXT PRIMARY KEY,
  emoji_package_id INTEGER NOT NULL,
  emoji_id TEXT NOT NULL,
  key TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  sender_id TEXT,
  channel_id TEXT,
  message_id TEXT,
  seen_count INTEGER NOT NULL DEFAULT 1,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0,
  last_sent_ms INTEGER,
  seen_in_private INTEGER NOT NULL DEFAULT 0,
  seen_in_group INTEGER NOT NULL DEFAULT 0,
  UNIQUE(emoji_package_id, emoji_id)
);

CREATE INDEX IF NOT EXISTS idx_stickers_summary ON stickers(summary);
CREATE INDEX IF NOT EXISTS idx_stickers_sender ON stickers(sender_id);
CREATE INDEX IF NOT EXISTS idx_stickers_last_seen ON stickers(last_seen_ms DESC);
`;

export class StickerDatabase {
  readonly db: Database.Database;
  readonly path: string;

  private readonly stmtUpsert: Database.Statement;
  private readonly stmtMarkSent: Database.Statement;
  private readonly stmtGetByKey: Database.Statement;
  private readonly stmtListBySender: Database.Statement;
  private readonly stmtListBySummary: Database.Statement;
  private readonly stmtListRecent: Database.Statement;
  private readonly stmtListRecentByChannel: Database.Statement;
  private readonly stmtListFrequent: Database.Statement;
  private readonly stmtListNeverSent: Database.Statement;

  constructor(dbPath: string) {
    const resolvedPath = path.resolve(dbPath);
    const parent = path.dirname(resolvedPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }

    this.path = resolvedPath;
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(STICKER_SCHEMA_SQL);

    this.stmtUpsert = this.db.prepare(`
      INSERT INTO stickers (
        id, emoji_package_id, emoji_id, key, summary, url,
        sender_id, channel_id, message_id,
        seen_count, first_seen_ms, last_seen_ms,
        seen_in_private, seen_in_group
      ) VALUES (
        @id, @pid, @eid, @key, @summary, @url,
        @sender, @channel, @msgId,
        1, @now, @now,
        @inPrivate, @inGroup
      )
      ON CONFLICT(emoji_package_id, emoji_id) DO UPDATE SET
        key = excluded.key,
        summary = COALESCE(excluded.summary, summary),
        url = COALESCE(excluded.url, url),
        sender_id = COALESCE(excluded.sender_id, sender_id),
        channel_id = COALESCE(excluded.channel_id, channel_id),
        message_id = COALESCE(excluded.message_id, message_id),
        seen_count = seen_count + 1,
        last_seen_ms = excluded.last_seen_ms,
        seen_in_private = seen_in_private + excluded.seen_in_private,
        seen_in_group = seen_in_group + excluded.seen_in_group
    `);

    this.stmtMarkSent = this.db.prepare(`
      UPDATE stickers
      SET sent_count = sent_count + 1,
          last_sent_ms = @now
      WHERE emoji_package_id = @pid AND emoji_id = @eid
    `);

    this.stmtGetByKey = this.db.prepare(`
      SELECT * FROM stickers
      WHERE emoji_package_id = ? AND emoji_id = ?
    `);

    this.stmtListBySender = this.db.prepare(`
      SELECT * FROM stickers
      WHERE sender_id = ?
      ORDER BY last_seen_ms DESC
      LIMIT ?
    `);

    this.stmtListBySummary = this.db.prepare(`
      SELECT * FROM stickers
      WHERE summary LIKE '%' || ? || '%'
      ORDER BY seen_count DESC, last_seen_ms DESC
      LIMIT ?
    `);

    this.stmtListRecent = this.db.prepare(`
      SELECT * FROM stickers
      ORDER BY last_seen_ms DESC
      LIMIT ?
    `);

    this.stmtListRecentByChannel = this.db.prepare(`
      SELECT * FROM stickers
      WHERE channel_id = ?
      ORDER BY last_seen_ms DESC
      LIMIT ?
    `);

    this.stmtListFrequent = this.db.prepare(`
      SELECT * FROM stickers
      WHERE seen_count >= ?
      ORDER BY seen_count DESC, last_seen_ms DESC
      LIMIT ?
    `);

    this.stmtListNeverSent = this.db.prepare(`
      SELECT * FROM stickers
      WHERE sent_count = 0
      ORDER BY seen_count DESC, last_seen_ms DESC
      LIMIT ?
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Record a seen sticker (insert or update). */
  upsert(input: StickerUpsertInput): void {
    const now = Date.now();
    const id = `sticker:${input.emoji_package_id}:${input.emoji_id}`;
    this.stmtUpsert.run({
      id,
      pid: input.emoji_package_id,
      eid: input.emoji_id,
      key: input.key,
      summary: input.summary ?? null,
      url: input.url ?? null,
      sender: input.sender_id ?? null,
      channel: input.channel_id ?? null,
      msgId: input.message_id ?? null,
      now,
      inPrivate: input.chatType === 'private' ? 1 : 0,
      inGroup: input.chatType === 'group' ? 1 : 0,
    });
  }

  /** Mark a sticker as sent (increment sent_count, update last_sent_ms). */
  markSent(emojiPackageId: number, emojiId: string, nowMs: number = Date.now()): void {
    this.stmtMarkSent.run({ pid: emojiPackageId, eid: emojiId, now: nowMs });
  }

  /** Get a sticker by its QQ unique key. */
  getByKey(emojiPackageId: number, emojiId: string): StickerRecord | null {
    const row = this.stmtGetByKey.get(emojiPackageId, emojiId) as StickerRecord | undefined;
    return row ?? null;
  }

  /** List stickers sent by a specific sender. */
  listBySender(senderId: string, limit = 20): StickerRecord[] {
    return this.stmtListBySender.all(senderId, limit) as StickerRecord[];
  }

  /** Search stickers by summary keyword. */
  listBySummary(keyword: string, limit = 20): StickerRecord[] {
    return this.stmtListBySummary.all(keyword, limit) as StickerRecord[];
  }

  /** List recently seen stickers. */
  listRecent(limit = 20): StickerRecord[] {
    return this.stmtListRecent.all(limit) as StickerRecord[];
  }

  /** List recently seen stickers in a specific channel. */
  listRecentByChannel(channelId: string, limit = 20): StickerRecord[] {
    return this.stmtListRecentByChannel.all(channelId, limit) as StickerRecord[];
  }

  /** List frequently seen stickers (above minSeenCount threshold). */
  listFrequentlySeen(minSeenCount = 3, limit = 20): StickerRecord[] {
    return this.stmtListFrequent.all(minSeenCount, limit) as StickerRecord[];
  }

  /** List stickers that have never been sent by Nova. */
  listNeverSent(limit = 20): StickerRecord[] {
    return this.stmtListNeverSent.all(limit) as StickerRecord[];
  }

  /** Get total count of stickers in the database. */
  get count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM stickers').get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }
}
