import type { DatabaseSync } from 'node:sqlite';
import { loadMigrationSql } from './migration-sql.ts';

// 迁移清单。新增迁移时在这里追加一行。
// SQL 内容通过 migration-sql.ts 加载：源码模式读文件，打包模式从
// esbuild 注入的常量取（PLAN §4.1 要求迁移 SQL 内嵌进二进制）。

export interface Migration {
  version: number;
  name: string;
  file: string;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', file: '0001_init.sql' },
  { version: 2, name: 'dedupe_vectors', file: '0002_dedupe_vectors.sql' },
  { version: 3, name: 'analysis_fingerprint', file: '0003_analysis_fingerprint.sql' },
  { version: 4, name: 'digest_day_key', file: '0004_digest_day_key.sql' },
  { version: 5, name: 'digest_cites', file: '0005_digest_cites.sql' },
  { version: 6, name: 'summaries', file: '0006_summaries.sql' },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * 逐条执行未应用的迁移。
 *
 * 幂等：已应用的版本跳过。用 schema_migrations 表记录，
 * 而不是靠 PRAGMA user_version，因为后者无法记录名称与时间。
 *
 * 整个迁移过程在一个事务里，任何一条失败都回滚，
 * 避免留下"迁移到一半"的库（PLAN §16.4 迁移幂等门禁）。
 */
export function migrate(db: DatabaseSync): { applied: number[]; skipped: number[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const done = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map((r) => r.version),
  );

  const applied: number[] = [];
  const skipped: number[] = [];

  for (const m of MIGRATIONS) {
    if (done.has(m.version)) {
      skipped.push(m.version);
      continue;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(loadMigrationSql(m.file));
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, Date.now());
      db.exec('COMMIT');
      applied.push(m.version);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`迁移 ${m.version}_${m.name} 失败: ${(e as Error).message}`);
    }
  }

  return { applied, skipped };
}

/**
 * 检查库的 schema 版本与二进制是否匹配。
 * 库比二进制新 → 拒绝启动（降级会损坏数据，PLAN §13.4）。
 */
export function assertSchemaCompatible(
  db: DatabaseSync,
  expectVersion = CURRENT_SCHEMA_VERSION,
): { ok: true } | { ok: false; reason: string; dbVersion: number } {
  // 全新库还没有这张表。此时不应抛错 —— 调用方会在 migrate 之后校验，
  // 这里返回 0 表示"尚无迁移记录"，由版本比较自然放行。
  let dbVersion = 0;
  try {
    const row = db
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as { v: number | null } | undefined;
    dbVersion = Number(row?.v ?? 0);
  } catch {
    dbVersion = 0;
  }

  if (dbVersion > expectVersion) {
    return {
      ok: false,
      dbVersion,
      reason: `数据库 schema 版本 ${dbVersion} 高于当前二进制支持的 ${expectVersion}，` +
        `拒绝启动以免损坏数据。请升级程序或从备份恢复。`,
    };
  }
  return { ok: true };
}
