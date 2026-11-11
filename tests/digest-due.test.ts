// digestDue 的"今天还该不该生成"判定（fix/digest-attempt-count）。
//
// 这里锁住的是一个只会被真库读出来的错：digest_attempts 里成功的那几行
// （run.ts 生成成功后会记 ok=1）如果也被算进"失败次数"，那么"今天成功过
// 3 次"就会被判成"今天失败过 3 次"——退避与放弃上限全部误触发。
// 平时它被 digests 表里有行挡住，只有 digests 行被清掉/重建时才会真的
// 拦死重生成，所以必须在 SQL 层面单测，而不是等集成场景撞上。
//
// 用 node:sqlite 的内存库按 0004_digest_day_key.sql 的列建三张表，
// 只建 digestDue 真正读到的列。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  digestDue,
  recordAttempt,
  localDayStart,
  parseDigestConfig,
  type DigestConfig,
} from '../src/server/digest/schedule.ts';

const cfg: DigestConfig = parseDigestConfig({ enabled: true, at: '00:00', kind: 'daily' });
const userId = 'u1';

/** 三张表的最小列（照 0004 迁移里 digest_attempts / digests / digest_skips） */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE digests (
      id      TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind    TEXT NOT NULL,
      day_key INTEGER
    );
    CREATE TABLE digest_skips (
      user_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      day_key    INTEGER NOT NULL,
      reason     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind, day_key)
    );
    CREATE TABLE digest_attempts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      day_key    INTEGER NOT NULL,
      ok         INTEGER NOT NULL,
      error      TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

/** 今天中午 12:00：必然晚于 at=00:00 的触发时刻，也不跨日 */
const now = (): number => localDayStart(Date.now()) + 12 * 3600_000;

test('今天成功过 3 次 → 仍该生成（成功不能算进失败次数）', () => {
  const db = freshDb();
  const t = now();
  const dayKey = localDayStart(t);
  // 失败退避之外的三次成功：若 ok=1 被算进去，就是 attempts=3 ≥ 3 → 放弃
  recordAttempt(db, userId, cfg, dayKey, true, null, t - 120 * 60_000);
  recordAttempt(db, userId, cfg, dayKey, true, null, t - 60 * 60_000);
  recordAttempt(db, userId, cfg, dayKey, true, null, t - 10 * 60_000);

  const r = digestDue(db, userId, cfg, t);
  assert.equal(r.due, true, `成功记录不该拦住重生成，实际 reason=${r.reason}`);
});

test('今天失败过 3 次 → 不再生成，理由含"失败"', () => {
  const db = freshDb();
  const t = now();
  const dayKey = localDayStart(t);
  recordAttempt(db, userId, cfg, dayKey, false, 'timeout', t - 120 * 60_000);
  recordAttempt(db, userId, cfg, dayKey, false, 'timeout', t - 60 * 60_000);
  recordAttempt(db, userId, cfg, dayKey, false, 'schema', t - 10 * 60_000);

  const r = digestDue(db, userId, cfg, t);
  assert.equal(r.due, false);
  assert.match(r.reason, /失败/);
});

test('今天刚失败 1 次 → 退避中，理由含"退避"', () => {
  const db = freshDb();
  const t = now();
  recordAttempt(db, userId, cfg, localDayStart(t), false, 'timeout', t);

  const r = digestDue(db, userId, cfg, t);
  assert.equal(r.due, false);
  assert.match(r.reason, /退避/);
});
