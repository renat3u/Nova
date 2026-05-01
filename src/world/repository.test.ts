import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { NOVA_SCHEMA_SQL } from '../db/schema.js';
import type { NovaSqliteDatabase } from '../db/sqlite.js';
import { NovaWorldRepository } from './repository.js';

function makeDb(): NovaSqliteDatabase {
  const db = new Database(':memory:');
  db.exec(NOVA_SCHEMA_SQL);
  return Object.assign(db, { path: ':memory:' }) as unknown as NovaSqliteDatabase;
}

function makeRepo(): { db: NovaSqliteDatabase; repo: NovaWorldRepository } {
  const db = makeDb();
  const repo = new NovaWorldRepository(db);
  repo.loadWorld();
  return { db, repo };
}

// ═══════════════════════════════════════════════════════════════════
// getRuntimeState / setRuntimeState
// ═══════════════════════════════════════════════════════════════════

test('setRuntimeState then getRuntimeState returns the same object value', () => {
  const { repo, db } = makeRepo();
  const value = { valence: 0.5, arousal: 0.3, source: 'llm_state_writeback' };
  repo.setRuntimeState('self_mood', value, 1000);
  const result = repo.getRuntimeState<{ valence: number; arousal: number; source: string }>('self_mood');
  assert.deepStrictEqual(result, value);
  db.close();
});

test('setRuntimeState then getRuntimeState returns the same number value', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('test_number', 42, 1000);
  const result = repo.getRuntimeState<number>('test_number');
  assert.equal(result, 42);
  db.close();
});

test('setRuntimeState then getRuntimeState returns the same string value', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('test_string', 'hello world', 1000);
  const result = repo.getRuntimeState<string>('test_string');
  assert.equal(result, 'hello world');
  db.close();
});

test('setRuntimeState then getRuntimeState returns the same boolean value', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('test_bool', true, 1000);
  const result = repo.getRuntimeState<boolean>('test_bool');
  assert.equal(result, true);
  db.close();
});

test('setRuntimeState then getRuntimeState returns the same array value', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('test_array', [1, 2, 3], 1000);
  const result = repo.getRuntimeState<number[]>('test_array');
  assert.deepStrictEqual(result, [1, 2, 3]);
  db.close();
});

test('same key second write overwrites old value', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('self_mood', { valence: 0.1 }, 1000);
  repo.setRuntimeState('self_mood', { valence: 0.9 }, 2000);
  const result = repo.getRuntimeState<{ valence: number }>('self_mood');
  assert.deepStrictEqual(result, { valence: 0.9 });
  db.close();
});

test('non-existent key returns undefined', () => {
  const { repo, db } = makeRepo();
  const result = repo.getRuntimeState('nonexistent_key');
  assert.equal(result, undefined);
  db.close();
});

test('getRuntimeState returns undefined for key that was never set', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('existing_key', 'value', 1000);
  const result = repo.getRuntimeState('different_key');
  assert.equal(result, undefined);
  db.close();
});

test('updated_at is written on setRuntimeState', () => {
  const { repo, db } = makeRepo();
  const nowMs = 1700000000000;
  repo.setRuntimeState('timed_key', { data: true }, nowMs);

  const row = db.prepare('SELECT updated_at FROM runtime_state WHERE key = ?').get('timed_key') as { updated_at: number } | undefined;
  assert.ok(row);
  assert.equal(row.updated_at, nowMs);
  db.close();
});

test('updated_at defaults to current time when nowMs is omitted', () => {
  const { repo, db } = makeRepo();
  const before = Date.now();
  repo.setRuntimeState('default_time_key', { data: true });
  const after = Date.now();

  const row = db.prepare('SELECT updated_at FROM runtime_state WHERE key = ?').get('default_time_key') as { updated_at: number } | undefined;
  assert.ok(row);
  assert.ok(row.updated_at >= before && row.updated_at <= after,
    `expected updated_at ${row.updated_at} to be between ${before} and ${after}`);
  db.close();
});

test('updated_at is updated on overwrite', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('overwrite_key', 'first', 1000);
  repo.setRuntimeState('overwrite_key', 'second', 2000);

  const row = db.prepare('SELECT updated_at FROM runtime_state WHERE key = ?').get('overwrite_key') as { updated_at: number } | undefined;
  assert.ok(row);
  assert.equal(row.updated_at, 2000);
  db.close();
});

test('bad JSON in database does not crash getRuntimeState', () => {
  const { repo, db } = makeRepo();

  // Write bad JSON directly to the database, bypassing setRuntimeState
  db.prepare('INSERT INTO runtime_state (key, value_json, updated_at) VALUES (?, ?, ?)').run(
    'bad_json_key', '{this is not valid json', 1000,
  );

  // Should not throw, should return undefined
  const result = repo.getRuntimeState('bad_json_key');
  assert.equal(result, undefined);
  db.close();
});

test('setRuntimeState with null value stores empty object (stringifyJson behavior)', () => {
  const { repo, db } = makeRepo();
  // stringifyJson uses `value ?? {}`, so null becomes {}
  repo.setRuntimeState('null_key', null, 1000);
  const row = db.prepare('SELECT value_json FROM runtime_state WHERE key = ?').get('null_key') as { value_json: string } | undefined;
  assert.ok(row);
  assert.equal(row.value_json, '{}');
  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// Key validation
// ═══════════════════════════════════════════════════════════════════

test('empty key throws on setRuntimeState', () => {
  const { repo, db } = makeRepo();
  assert.throws(
    () => repo.setRuntimeState('', 'value', 1000),
    /runtime_state key must not be empty/,
  );
  db.close();
});

test('empty key throws on getRuntimeState', () => {
  const { repo, db } = makeRepo();
  assert.throws(
    () => repo.getRuntimeState(''),
    /runtime_state key must not be empty/,
  );
  db.close();
});

test('empty key throws on deleteRuntimeState', () => {
  const { repo, db } = makeRepo();
  assert.throws(
    () => repo.deleteRuntimeState(''),
    /runtime_state key must not be empty/,
  );
  db.close();
});

test('key exceeding 200 chars throws on setRuntimeState', () => {
  const { repo, db } = makeRepo();
  const longKey = 'x'.repeat(201);
  assert.throws(
    () => repo.setRuntimeState(longKey, 'value', 1000),
    /runtime_state key exceeds max length 200/,
  );
  db.close();
});

test('key exceeding 200 chars throws on getRuntimeState', () => {
  const { repo, db } = makeRepo();
  const longKey = 'x'.repeat(201);
  assert.throws(
    () => repo.getRuntimeState(longKey),
    /runtime_state key exceeds max length 200/,
  );
  db.close();
});

test('key exceeding 200 chars throws on deleteRuntimeState', () => {
  const { repo, db } = makeRepo();
  const longKey = 'x'.repeat(201);
  assert.throws(
    () => repo.deleteRuntimeState(longKey),
    /runtime_state key exceeds max length 200/,
  );
  db.close();
});

test('key exactly 200 chars is accepted', () => {
  const { repo, db } = makeRepo();
  const maxKey = 'x'.repeat(200);
  assert.doesNotThrow(() => repo.setRuntimeState(maxKey, 'value', 1000));
  const result = repo.getRuntimeState<string>(maxKey);
  assert.equal(result, 'value');
  db.close();
});

test('whitespace-only key is accepted (not empty)', () => {
  const { repo, db } = makeRepo();
  assert.doesNotThrow(() => repo.setRuntimeState('   ', 'value', 1000));
  const result = repo.getRuntimeState<string>('   ');
  assert.equal(result, 'value');
  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// deleteRuntimeState
// ═══════════════════════════════════════════════════════════════════

test('deleteRuntimeState removes the key', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('to_delete', { data: 123 }, 1000);
  assert.ok(repo.getRuntimeState('to_delete') !== undefined);

  repo.deleteRuntimeState('to_delete');
  assert.equal(repo.getRuntimeState('to_delete'), undefined);
  db.close();
});

test('deleteRuntimeState on non-existent key does not throw', () => {
  const { repo, db } = makeRepo();
  assert.doesNotThrow(() => repo.deleteRuntimeState('never_existed'));
  db.close();
});

test('deleteRuntimeState on already deleted key does not throw', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('double_delete', 'value', 1000);
  repo.deleteRuntimeState('double_delete');
  assert.doesNotThrow(() => repo.deleteRuntimeState('double_delete'));
  db.close();
});

test('deleteRuntimeState only removes the specified key', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('keep_me', 'kept', 1000);
  repo.setRuntimeState('remove_me', 'removed', 1000);

  repo.deleteRuntimeState('remove_me');

  assert.equal(repo.getRuntimeState<string>('keep_me'), 'kept');
  assert.equal(repo.getRuntimeState('remove_me'), undefined);
  db.close();
});

test('setRuntimeState after delete works as new insert', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('recreated', 'first', 1000);
  repo.deleteRuntimeState('recreated');
  repo.setRuntimeState('recreated', 'second', 2000);

  const result = repo.getRuntimeState<string>('recreated');
  assert.equal(result, 'second');

  const row = db.prepare('SELECT updated_at FROM runtime_state WHERE key = ?').get('recreated') as { updated_at: number } | undefined;
  assert.ok(row);
  assert.equal(row.updated_at, 2000);
  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// Key naming convention — standard keys
// ═══════════════════════════════════════════════════════════════════

test('self_mood key round-trips correctly', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('self_mood', { valence: 0.3, arousal: 0.6, updatedAt: 1000, source: 'llm_state_writeback' }, 1000);
  const result = repo.getRuntimeState<{ valence: number; arousal: number }>('self_mood');
  assert.equal(result?.valence, 0.3);
  assert.equal(result?.arousal, 0.6);
  db.close();
});

test('last_afterward:<channelId> key round-trips correctly', () => {
  const { repo, db } = makeRepo();
  const key = 'last_afterward:qq:private:12345';
  const value = { value: 'waiting_reply', setAt: 1000, expiresAt: 1600000 };
  repo.setRuntimeState(key, value, 1000);
  const result = repo.getRuntimeState<{ value: string }>(key);
  assert.equal(result?.value, 'waiting_reply');
  db.close();
});

test('last_llm_state_writeback:<channelId> key round-trips correctly', () => {
  const { repo, db } = makeRepo();
  const key = 'last_llm_state_writeback:qq:group:999';
  const value = { source: 'reply', acceptedCount: 2, rejectedCount: 0, atMs: 1000 };
  repo.setRuntimeState(key, value, 1000);
  const result = repo.getRuntimeState<{ acceptedCount: number }>(key);
  assert.equal(result?.acceptedCount, 2);
  db.close();
});

test('channel_cooldown:<channelId> key round-trips correctly', () => {
  const { repo, db } = makeRepo();
  const key = 'channel_cooldown:qq:private:42';
  repo.setRuntimeState(key, { until: 2000 }, 1000);
  const result = repo.getRuntimeState<{ until: number }>(key);
  assert.equal(result?.until, 2000);
  db.close();
});

test('channel_waiting_reply:<channelId> key round-trips correctly', () => {
  const { repo, db } = makeRepo();
  const key = 'channel_waiting_reply:qq:group:777';
  repo.setRuntimeState(key, { since: 1000 }, 1000);
  const result = repo.getRuntimeState<{ since: number }>(key);
  assert.equal(result?.since, 1000);
  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// Multiple keys coexist independently
// ═══════════════════════════════════════════════════════════════════

test('multiple keys can coexist independently', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('self_mood', { valence: 0.1 }, 1000);
  repo.setRuntimeState('last_afterward:qq:private:1', { value: 'done' }, 1000);
  repo.setRuntimeState('last_llm_state_writeback:qq:private:1', { count: 1 }, 1000);

  assert.deepStrictEqual(repo.getRuntimeState('self_mood'), { valence: 0.1 });
  assert.deepStrictEqual(repo.getRuntimeState('last_afterward:qq:private:1'), { value: 'done' });
  assert.deepStrictEqual(repo.getRuntimeState('last_llm_state_writeback:qq:private:1'), { count: 1 });
  db.close();
});

test('keys in different channels are independent', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('last_afterward:qq:private:1', { value: 'waiting_reply' }, 1000);
  repo.setRuntimeState('last_afterward:qq:private:2', { value: 'cooling_down' }, 1000);
  repo.setRuntimeState('last_afterward:qq:group:1', { value: 'watching' }, 1000);

  assert.deepStrictEqual(
    repo.getRuntimeState('last_afterward:qq:private:1'),
    { value: 'waiting_reply' },
  );
  assert.deepStrictEqual(
    repo.getRuntimeState('last_afterward:qq:private:2'),
    { value: 'cooling_down' },
  );
  assert.deepStrictEqual(
    repo.getRuntimeState('last_afterward:qq:group:1'),
    { value: 'watching' },
  );
  db.close();
});

// ═══════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════

test('setRuntimeState with undefined value stores null', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('undef_val', undefined, 1000);
  // JSON.stringify(undefined) returns undefined, but stringifyJson
  // converts undefined to {} via `value ?? {}`.
  // Verify the stored value is {}.
  const row = db.prepare('SELECT value_json FROM runtime_state WHERE key = ?').get('undef_val') as { value_json: string } | undefined;
  assert.ok(row);
  assert.equal(row.value_json, '{}');
  db.close();
});

test('setRuntimeState with complex nested object', () => {
  const { repo, db } = makeRepo();
  const complex = {
    level1: {
      level2: {
        array: [1, { nested: true }, 'three'],
        bool: false,
      },
      empty: null,
    },
    topLevel: 'simple',
  };
  repo.setRuntimeState('complex', complex, 1000);
  const result = repo.getRuntimeState<typeof complex>('complex');
  assert.deepStrictEqual(result, complex);
  db.close();
});

test('runtime_state table is not affected by loadWorld', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('persist_key', { data: 'survives' }, 1000);

  // reload world
  repo.loadWorld();

  const result = repo.getRuntimeState<{ data: string }>('persist_key');
  assert.deepStrictEqual(result, { data: 'survives' });
  db.close();
});

test('setRuntimeState with nowMs=0 is valid', () => {
  const { repo, db } = makeRepo();
  repo.setRuntimeState('epoch_key', 'value', 0);
  const row = db.prepare('SELECT updated_at FROM runtime_state WHERE key = ?').get('epoch_key') as { updated_at: number } | undefined;
  assert.ok(row);
  assert.equal(row.updated_at, 0);
  db.close();
});
