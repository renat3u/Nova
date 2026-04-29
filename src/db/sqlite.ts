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

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}
