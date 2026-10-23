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
 */
export function claimBatch(db: DatabaseSync, workerId: string, limit: number): Job[] {
  db.exec('BEGIN IMMEDIATE');
  try {
    const now = Date.now();
    const rows = db.prepare(`
      SELECT * FROM jobs
       WHERE status = 'pending' AND run_after <= ?
       ORDER BY priority DESC, id
       LIMIT ?
    `).all(now, limit) as unknown as Job[];

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
 */
export function recoverStaleJobs(db: DatabaseSync, staleMs = STALE_LOCK_MS): number {
  const cutoff = Date.now() - staleMs;
  const r = db.prepare(`
    UPDATE jobs SET status='pending', locked_by=NULL, locked_at=NULL, updated_at=?
     WHERE status='running' AND (locked_at IS NULL OR locked_at < ?)
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
