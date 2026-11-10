import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

// 数据库访问层。
//
// 只有一层：原生 node:sqlite 的 DatabaseSync，事务/PRAGMA/迁移/查询都走它。
// 表结构的真相在 migrations/*.sql（手写 DDL），本文件不参与建表。
//
// 抽 adapter 的目的是：node:sqlite 目前是 RC，将来若换 better-sqlite3，
// 只改这个文件。

export interface OpenOptions {
  dataDir: string;
  /** 只读打开（doctor 自检、备份校验用） */
  readonly?: boolean;
  /** 页缓存大小（KB），默认 16MB */
  cacheKb?: number;
  /** mmap 大小（字节），默认 256MB；0 表示关闭 */
  mmapBytes?: number;
}

export interface DbHandle {
  db: DatabaseSync;
  close(): void;
}

/**
 * 打开数据库并施加一致的 PRAGMA 组合。
 *
 * PRAGMA 选择依据（PLAN §6.1）：
 *   journal_mode=WAL     读写不互斥，单进程 + 偶发 CLI 场景必需
 *   synchronous=NORMAL   WAL 下的推荐值，掉电最多丢最后一个事务
 *   foreign_keys=ON      SQLite 默认关闭，必须显式开
 *   busy_timeout=5000    并发写时等待而非立即报 SQLITE_BUSY
 *   cache_size=-16000    16MB 页缓存（负值单位是 KB）
 *   mmap_size=256MB      实测全表扫描 353ms → 184ms
 */
export function openDb(opts: OpenOptions): DbHandle {
  const path = `${opts.dataDir}/app.db`;

  // 数据目录必须已存在。自动创建会让调用方（migrate/serve）与
  // 只读命令（doctor）的行为不一致，因此在这里显式报错并给出指引。
  // 正常路径由 ensureDataDirs() 负责创建。
  if (!existsSync(opts.dataDir)) {
    throw new Error(
      `数据目录不存在: ${opts.dataDir}\n` +
      `可先运行: cheng-rss migrate --data ${opts.dataDir}`,
    );
  }

  const db = opts.readonly
    ? new DatabaseSync(path, { readOnly: true })
    : new DatabaseSync(path);

  // 只读连接不能改 journal_mode，但可以读
  if (!opts.readonly) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA busy_timeout = 5000;`);

  const cacheKb = opts.cacheKb ?? 16000;
  db.exec(`PRAGMA cache_size = -${cacheKb};`);

  const mmap = opts.mmapBytes ?? 268435456;
  if (mmap > 0) db.exec(`PRAGMA mmap_size = ${mmap};`);

  return {
    db,
    close() {
      try {
        // WAL 未 checkpoint 的内容会留在 -wal 文件里，关闭前合并回主库，
        // 否则 cp app.db 得到的是残缺副本（备份用 VACUUM INTO，但这仍是好习惯）
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch {
        /* 只读连接会失败，忽略 */
      }
      db.close();
    },
  };
}

/** 读当前 PRAGMA 状态，供 doctor 与验收脚本使用 */
export function readPragmas(db: DatabaseSync): Record<string, string | number> {
  const one = (pragma: string): string | number => {
    const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
    if (!row) return 'unknown';
    const v = Object.values(row)[0];
    return typeof v === 'number' || typeof v === 'string' ? v : String(v);
  };
  return {
    journal_mode: one('journal_mode'),
    synchronous: one('synchronous'),
    foreign_keys: one('foreign_keys'),
    busy_timeout: one('busy_timeout'),
    cache_size: one('cache_size'),
    mmap_size: one('mmap_size'),
  };
}
