import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NOVA_SCHEMA_SQL } from './schema';

export type NovaSqliteDatabase = Database.Database;

export interface NovaDbConnection {
  readonly path: string;
  readonly db: NovaSqliteDatabase;
  close(): void;
}

export function openNovaDb(dbPath: string): NovaDbConnection {
  const resolvedPath = path.resolve(dbPath);
  const parent = path.dirname(resolvedPath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(NOVA_SCHEMA_SQL);
  migrateNovaDb(db);

  return {
    path: resolvedPath,
    db,
    close: () => db.close(),
  };
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function migrateNovaDb(db: NovaSqliteDatabase): void {
  if (!tableExists(db, 'contacts') || !tableExists(db, 'channels') || !tableExists(db, 'conversations')) return;

  addColumnIfMissing(db, 'contacts', 'qq', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'contacts', 'name', 'TEXT');
  addColumnIfMissing(db, 'contacts', 'tier', 'INTEGER NOT NULL DEFAULT 150');
  addColumnIfMissing(db, 'contacts', 'attrs_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, 'contacts', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'contacts', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');

  addColumnIfMissing(db, 'channels', 'platform', "TEXT NOT NULL DEFAULT 'qq'");
  addColumnIfMissing(db, 'channels', 'chat_type', "TEXT NOT NULL DEFAULT 'private'");
  addColumnIfMissing(db, 'channels', 'qq_id', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'channels', 'title', 'TEXT');
  addColumnIfMissing(db, 'channels', 'attrs_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, 'channels', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'channels', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');

  addColumnIfMissing(db, 'conversations', 'channel_id', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'conversations', 'state', "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(db, 'conversations', 'turn_state', "TEXT NOT NULL DEFAULT 'none'");
  addColumnIfMissing(db, 'conversations', 'last_activity_ms', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'conversations', 'closing_since_ms', 'INTEGER');
  addColumnIfMissing(db, 'conversations', 'attrs_json', "TEXT NOT NULL DEFAULT '{}'");
}

function tableExists(db: NovaSqliteDatabase, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { name: string } | undefined;
  return row !== undefined;
}

function addColumnIfMissing(db: NovaSqliteDatabase, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}
