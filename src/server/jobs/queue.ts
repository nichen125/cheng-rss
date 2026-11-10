import type { DatabaseSync } from 'node:sqlite';

// 任务队列。
//
// 设计要点（PLAN §7.2）：
//   · 单表当队列，不用外部 MQ —— NAS 上少一个组件就少一个装不上的理由
//   · claim 用 BEGIN IMMEDIATE 保证原子性（node:sqlite 是同步 API，
//     没有 db.transaction().immediate() 封装，必须手写事务）
//   · dedupe_key 唯一索引防重复入队（部分索引，只约束 pending/running）
//   · 崩溃恢复：启动时把锁超时的 running 重置为 pending

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'dead';

export interface Job {
  id: number;
  kind: string;
  dedupe_key: string | null;
  payload: string;
  status: JobStatus;
  priority: number;
  run_after: number;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** 锁超过这个时间仍未完成，视为处理进程已死 */
export const STALE_LOCK_MS = 10 * 60 * 1000;

export interface EnqueueOptions {
  kind: string;
  payload: unknown;
  /** 相同 key 在 pending/running 状态下只会有一条 */
  dedupeKey?: string;
  priority?: number;
  /** 延迟执行（ms 时间戳） */
  runAfter?: number;
  maxAttempts?: number;
}

export function enqueue(db: DatabaseSync, opts: EnqueueOptions): number | null {
  const now = Date.now();
  try {
    const r = db.prepare(`
      INSERT INTO jobs (kind, dedupe_key, payload, status, priority, run_after,
                        attempts, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?)
    `).run(
      opts.kind,
      opts.dedupeKey ?? null,
      JSON.stringify(opts.payload ?? {}),
      opts.priority ?? 0,
      opts.runAfter ?? 0,
      opts.maxAttempts ?? 3,
      now,
      now,
    );
    return Number(r.lastInsertRowid);
  } catch (e) {
    // 唯一索引冲突 = 已有同 dedupeKey 的任务在队列里，视为成功（幂等）
    const msg = (e as Error).message;
    if (/UNIQUE constraint failed/.test(msg)) return null;
    throw e;
  }
}

/**
 * 原子认领一批任务。
 *
 * BEGIN IMMEDIATE 立刻拿写锁，避免「先读后写」之间的竞态：
 * 两个 worker 同时读到同一批 pending，各自 UPDATE，就会重复执行。
 *
 * `capacity` 是**每个 kind 这一轮还能领几条**（并发上限 - 在飞数）。
 * 不传时保持老行为：`ORDER BY priority DESC, id LIMIT ?` 一把捞。
 *
 * 为什么必须按 kind 分名额（PLAN §7.2 的教训）：老取法只看全局 id 顺序，
 * 一种慢任务堆在前面就会把窗口占满。真实库上出现过 384 条 analyze
 * （并发 2、每条几秒）排在 21 条 fetch_feed 前面，每轮固定取到 20 条
 * analyze，fetch_feed 永远进不了这个窗口 —— 表现是订阅再也不抓、
 * 简报一直"最近 24 小时没有新条目"，而队列统计里 pending 不为 0，
 * 看起来只是"慢"，实际是饿死。按 kind 分配认领席位才是队列该有的形状。
 */
export function claimBatch(
  db: DatabaseSync,
  workerId: string,
  limit: number,
  capacity?: Record<string, number>,
): Job[] {
  db.exec('BEGIN IMMEDIATE');
  try {
    const now = Date.now();
    let rows: Job[];

    const kinds = capacity
      ? Object.keys(capacity).filter((k) => (capacity[k] ?? 0) > 0)
      : [];
    if (capacity && kinds.length === 0) {
      // 每种任务都满负荷，别白抢一轮
      db.exec('COMMIT');
      return [];
    }

    if (capacity) {
      // 每个 kind 内按优先级 + id 排名，只取自己名额内的那些。
      // 窗口函数在子查询里排名，外层再按 kind 的名额过滤 ——
      // 名额是每 kind 不同的值，所以在 JS 里筛，SQL 只负责粗筛
      // （rn <= 最大名额），避免把整张 pending 表拉回来。
      const maxCap = Math.max(...kinds.map((k) => capacity[k] ?? 0));
      const holes = kinds.map(() => '?').join(',');
      const ranked = db.prepare(`
        SELECT * FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY kind ORDER BY priority DESC, id
          ) AS rn
            FROM jobs
           WHERE status = 'pending' AND run_after <= ? AND kind IN (${holes})
        )
        WHERE rn <= ?
        ORDER BY priority DESC, id
      `).all(now, ...kinds, maxCap) as unknown as (Job & { rn: number })[];

      rows = ranked
        .filter((r) => r.rn <= (capacity[r.kind] ?? 0))
        .slice(0, limit)
        .map(({ rn: _rn, ...job }) => job as unknown as Job);
    } else {
      rows = db.prepare(`
        SELECT * FROM jobs
         WHERE status = 'pending' AND run_after <= ?
         ORDER BY priority DESC, id
         LIMIT ?
      `).all(now, limit) as unknown as Job[];
    }

    if (rows.length > 0) {
      const upd = db.prepare(
        `UPDATE jobs SET status='running', locked_by=?, locked_at=?, attempts=attempts+1,
                         updated_at=? WHERE id=?`,
      );
      for (const r of rows) upd.run(workerId, now, now, r.id);
    }

    db.exec('COMMIT');
    return rows;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function completeJob(db: DatabaseSync, id: number): void {
  db.prepare(
    `UPDATE jobs SET status='done', locked_by=NULL, locked_at=NULL, updated_at=? WHERE id=?`,
  ).run(Date.now(), id);
}

/**
 * 失败处理：未到上限就退回 pending 并延迟重试，到上限则置 dead。
 *
 * 退避用指数：attempts=1 → 1min，2 → 2min，3 → 4min……
 * 直接立即重试会让有问题的源在几秒内烧完所有尝试次数。
 */
export function failJob(
  db: DatabaseSync,
  id: number,
  error: string,
): { status: 'pending' | 'dead'; retryInMs: number } {
  const row = db.prepare('SELECT attempts, max_attempts FROM jobs WHERE id = ?')
    .get(id) as { attempts: number; max_attempts: number } | undefined;
  if (!row) return { status: 'dead', retryInMs: 0 };

  const now = Date.now();
  if (row.attempts >= row.max_attempts) {
    db.prepare(
      `UPDATE jobs SET status='dead', last_error=?, locked_by=NULL, locked_at=NULL,
                       updated_at=? WHERE id=?`,
    ).run(error.slice(0, 2000), now, id);
    return { status: 'dead', retryInMs: 0 };
  }

  const retryInMs = Math.min(60_000 * 2 ** (row.attempts - 1), 60 * 60_000);
  db.prepare(
    `UPDATE jobs SET status='pending', last_error=?, run_after=?, locked_by=NULL,
                     locked_at=NULL, updated_at=? WHERE id=?`,
  ).run(error.slice(0, 2000), now + retryInMs, now, id);
  return { status: 'pending', retryInMs };
}

/**
 * 启动时恢复：把锁超时的 running 任务退回 pending。
 *
 * 不打回 pending 的话，进程被 kill 后那些任务会永远卡在 running，
 * 对应条目也就永远停在处理中 —— 这在实际使用中是必现的。
 *
 * 判据用 `<=` 而不是 `<`：`staleMs=0`（启动时的单进程恢复）会拿
 * `Date.now()` 当 cutoff，而 `claimBatch` 刚写的 `locked_at` 很可能与它是
 * 同一毫秒。严格小于会让「刚认领就崩溃」的任务恰好漏掉 —— 那正是这次
 * 修复要覆盖的场景。默认 10 分钟的路径几乎不可能正好落在边界上。
 */
export function recoverStaleJobs(db: DatabaseSync, staleMs = STALE_LOCK_MS): number {
  const cutoff = Date.now() - staleMs;
  const r = db.prepare(`
    UPDATE jobs SET status='pending', locked_by=NULL, locked_at=NULL, updated_at=?
     WHERE status='running' AND (locked_at IS NULL OR locked_at <= ?)
  `).run(Date.now(), cutoff);
  return Number(r.changes ?? 0);
}

export interface QueueStats {
  pending: number;
  running: number;
  done: number;
  failed: number;
  dead: number;
  oldestPendingAgeMs: number;
}

export function queueStats(db: DatabaseSync): QueueStats {
  const rows = db.prepare('SELECT status, COUNT(*) AS c FROM jobs GROUP BY status')
    .all() as { status: string; c: number }[];
  const map = new Map(rows.map((r) => [r.status, Number(r.c)]));
  const oldest = db.prepare("SELECT MIN(created_at) AS t FROM jobs WHERE status='pending'")
    .get() as { t: number | null } | undefined;
  const t = Number(oldest?.t ?? 0);
  return {
    pending: map.get('pending') ?? 0,
    running: map.get('running') ?? 0,
    done: map.get('done') ?? 0,
    failed: map.get('failed') ?? 0,
    dead: map.get('dead') ?? 0,
    oldestPendingAgeMs: t ? Date.now() - t : 0,
  };
}

/** 清理已完成任务的旧记录，避免 jobs 表无限增长 */
export function pruneDoneJobs(db: DatabaseSync, keepDays = 7): number {
  const cutoff = Date.now() - keepDays * 86400_000;
  const r = db.prepare("DELETE FROM jobs WHERE status='done' AND updated_at < ?").run(cutoff);
  return Number(r.changes ?? 0);
}
