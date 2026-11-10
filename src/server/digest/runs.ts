import type { DatabaseSync } from 'node:sqlite';

// 简报"跑一次"的账本（PLAN §9.8）。
//
// 这张表回答的问题不是"任务队列里有什么"，而是**用户此刻看到什么**：
// 正在跑到第几个事件、已经花了多少钱、是不是被谁停了、跑了多久。
//
// 三条刻意的设计取舍：
//
//   · 与 `jobs` 分表（理由见 0010 的注释）：jobs 的行会被 pruneDoneJobs
//     删掉，而进度是用户要回头看的资产。
//   · `cancel_requested` 是**库里的一个字段**，不是进程内的注册表。
//     路由进程与 runner 同进程时看起来两者等价，但 queued 阶段的取消
//     只有写在库里才成立 —— 任务还没被认领，内存里没有任何东西可打断。
//   · 心跳用 1 秒、stale 判定用 60 秒。两者的量级差不是随手取的：
//     心跳要远小于"一个簇的正常耗时"（十几秒），stale 要远大于它，
//     否则一次慢调用就会被误判成"服务死了"。

/**
 * 心跳超过这么久没有更新，就认为跑它的进程已经不在了。
 *
 * 60 秒：单次模型调用的超时是 60 秒（AiConfig.timeoutMs 默认值），
 * 所以"整整一分钟没有心跳"意味着一轮循环都没转完，正常跑不可能这样。
 * 它**不能**复用 `STALE_LOCK_MS`（10 分钟）—— 那个管的是队列认领，
 * 两者语义不同，用同一个值会让 UI 卡在"生成中"长达十分钟。
 */
export const STALE_RUN_MS = 60_000;

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export type RunPhase = 'prepare' | 'clustering' | 'generating' | 'saving';

const LIVE: RunStatus[] = ['queued', 'running'];

export interface DigestRunRow {
  id: string;
  user_id: string;
  job_id: number | null;
  kind: string;
  status: RunStatus;
  phase: RunPhase;
  done_clusters: number;
  total_clusters: number;
  cost_usd: number;
  cancel_requested: number;
  cancel_reason: string | null;
  reason: string | null;
  digest_id: string | null;
  manual: number;
  started_at: number;
  heartbeat_at: number;
  finished_at: number | null;
}

/** 给接口用的形状。字段名按客户端习惯用 camelCase */
export interface RunView {
  id: string;
  status: RunStatus;
  phase: RunPhase;
  doneClusters: number;
  totalClusters: number;
  costUsd: number;
  startedAt: number;
  heartbeatAt: number;
  elapsedMs: number;
  /** 跑它的进程已经不在了（心跳停了），而不是任务本身失败 */
  stale: boolean;
  cancelReason: string | null;
  reason: string | null;
  digestId: string | null;
  manual: boolean;
}

function newRunId(now: number): string {
  // 与 saveCluster 的 id 同风格：时间在前便于粗排序，随机位防同毫秒撞车
  return `dr_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 该用户正在跑（或排队中）的那一次。没有则 null */
export function liveRun(db: DatabaseSync, userId: string, kind = 'daily'): DigestRunRow | null {
  const row = db.prepare(`
    SELECT * FROM digest_runs
     WHERE user_id = ? AND kind = ? AND status IN ('queued','running')
     ORDER BY started_at DESC LIMIT 1
  `).get(userId, kind);
  return row ? (row as unknown as DigestRunRow) : null;
}

/** 最近一次（含已结束的）。状态接口显示的就是它 */
export function latestRun(db: DatabaseSync, userId: string, kind = 'daily'): DigestRunRow | null {
  const row = db.prepare(`
    SELECT * FROM digest_runs
     WHERE user_id = ? AND kind = ?
     ORDER BY started_at DESC LIMIT 1
  `).get(userId, kind);
  return row ? (row as unknown as DigestRunRow) : null;
}

export function createRun(
  db: DatabaseSync,
  a: { userId: string; kind?: string; manual?: boolean; now?: number },
): DigestRunRow {
  const now = a.now ?? Date.now();
  const kind = a.kind ?? 'daily';
  const id = newRunId(now);

  db.prepare(`
    INSERT INTO digest_runs
      (id, user_id, job_id, kind, status, phase, done_clusters, total_clusters,
       cost_usd, cancel_requested, cancel_reason, reason, digest_id, manual,
       started_at, heartbeat_at, finished_at)
    VALUES (?,?,NULL,?,'queued','prepare',0,0,0,0,NULL,NULL,NULL,?,?,?,NULL)
  `).run(id, a.userId, kind, a.manual ? 1 : 0, now, now);

  return db.prepare('SELECT * FROM digest_runs WHERE id = ?').get(id) as unknown as DigestRunRow;
}

export function getRun(db: DatabaseSync, runId: string): DigestRunRow | null {
  const row = db.prepare('SELECT * FROM digest_runs WHERE id = ?').get(runId);
  return row ? (row as unknown as DigestRunRow) : null;
}

export function setRunJob(db: DatabaseSync, runId: string, jobId: number | null): void {
  db.prepare('UPDATE digest_runs SET job_id = ? WHERE id = ?').run(jobId, runId);
}

/** runner 认领之后把它从 queued 转成 running */
export function startRun(db: DatabaseSync, runId: string, now = Date.now()): void {
  db.prepare(`
    UPDATE digest_runs SET status = 'running', phase = 'prepare',
           started_at = ?, heartbeat_at = ?
     WHERE id = ? AND status IN ('queued','running')
  `).run(now, now, runId);
}

/**
 * 心跳 + 顺手读一次取消标记。
 *
 * 两件事放在一次往返里：心跳每秒都写，而取消检查也是每秒一次 ——
 * 分开查会白多一次索引查找，而它们的时机要求完全一致。
 * 返回 cancel_requested、cancel_reason —— 调用方据此决定要不要 abort。
 */
export function beatAndCheckCancel(
  db: DatabaseSync,
  runId: string,
  now = Date.now(),
): { cancelRequested: boolean; cancelReason: string | null } {
  db.prepare('UPDATE digest_runs SET heartbeat_at = ? WHERE id = ? AND status = \'running\'')
    .run(now, runId);
  const row = db.prepare('SELECT cancel_requested, cancel_reason FROM digest_runs WHERE id = ?')
    .get(runId) as { cancel_requested: number; cancel_reason: string | null } | undefined;
  return {
    cancelRequested: Number(row?.cancel_requested ?? 0) === 1,
    cancelReason: row?.cancel_reason ?? null,
  };
}

export function setPhase(
  db: DatabaseSync,
  runId: string,
  a: { phase?: RunPhase; totalClusters?: number; doneClusters?: number; costUsd?: number },
): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (a.phase !== undefined) { sets.push('phase = ?'); args.push(a.phase); }
  if (a.totalClusters !== undefined) { sets.push('total_clusters = ?'); args.push(a.totalClusters); }
  if (a.doneClusters !== undefined) { sets.push('done_clusters = ?'); args.push(a.doneClusters); }
  if (a.costUsd !== undefined) { sets.push('cost_usd = ?'); args.push(a.costUsd); }
  if (sets.length === 0) return;
  args.push(runId);
  db.prepare(`UPDATE digest_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args as never[]);
}

/**
 * 请求停止。
 *
 * 三种返回，语义各不相同，调用方（与 UI）必须能分出它们：
 *   · cancelled=true  —— 任务还没开始跑，直接终结，不用等在飞调用
 *   · requested=true  —— 已在跑，标记写进库，runner 下一秒就会 abort
 *   · 都没有          —— 已经是终态，幂等返回（重复点"停止"不该报错）
 */
export function requestCancel(
  db: DatabaseSync,
  runId: string,
  reason = '用户手动停止',
  now = Date.now(),
): { ok: boolean; status: RunStatus | null; cancelled: boolean; requested: boolean } {
  const row = getRun(db, runId);
  if (!row) return { ok: false, status: null, cancelled: false, requested: false };

  if (row.status === 'queued') {
    db.prepare(`
      UPDATE digest_runs SET status = 'cancelled', cancel_requested = 1,
             cancel_reason = ?, reason = ?, finished_at = ?
       WHERE id = ? AND status = 'queued'
    `).run(reason, '已停止', now, runId);
    return { ok: true, status: 'cancelled', cancelled: true, requested: false };
  }

  if (row.status === 'running') {
    db.prepare(`
      UPDATE digest_runs SET cancel_requested = 1, cancel_reason = ?
       WHERE id = ? AND status = 'running'
    `).run(reason, runId);
    return { ok: true, status: 'running', cancelled: false, requested: true };
  }

  return { ok: true, status: row.status, cancelled: false, requested: false };
}

/** 已经在库里被要求取消了（runner 每秒读它一次） */
export function cancelRequested(db: DatabaseSync, runId: string): boolean {
  const row = db.prepare('SELECT cancel_requested FROM digest_runs WHERE id = ?')
    .get(runId) as { cancel_requested: number } | undefined;
  return Number(row?.cancel_requested ?? 0) === 1;
}

export function finishRun(
  db: DatabaseSync,
  runId: string,
  a: {
    status: RunStatus;
    reason?: string | null;
    digestId?: string | null;
    costUsd?: number;
    /**
     * 「谁停的」。
     *
     * 必须能传进来，不能只靠 requestCancel 写 —— 花费上限触发的中断是
     * **runDigest 自己抛的 CancelledError**，库里从来没有 cancel_requested
     * 被置位那一刻。不写进去的话，UI 的 `cancelReason ?? '用户手动停止'`
     * 会把"超限停下"显示成"用户手动停止"：一个用户根本没做过的动作。
     */
    cancelReason?: string | null;
    now?: number;
  },
): void {
  const now = a.now ?? Date.now();
  db.prepare(`
    UPDATE digest_runs
       SET status = ?, reason = COALESCE(?, reason),
           cancel_reason = COALESCE(?, cancel_reason),
           digest_id = COALESCE(?, digest_id),
           cost_usd = COALESCE(?, cost_usd),
           finished_at = ?, heartbeat_at = ?
     WHERE id = ?
  `).run(a.status, a.reason ?? null, a.cancelReason ?? null, a.digestId ?? null,
    a.costUsd ?? null, now, now, runId);
}

/**
 * 启动时把上个进程留下的"活着"的行判成中断。
 *
 * 单进程 + SQLite：启动时还是 queued/running 的行一定是上一个进程的遗留，
 * 不存在"另一个 worker 正在跑"的可能，所以不需要保守的时长判断 ——
 * 那种判断会让刚重启的系统头一分钟什么都不肯显示。
 */
export function markInterruptedRuns(db: DatabaseSync, now = Date.now()): number {
  const r = db.prepare(`
    UPDATE digest_runs
       SET status = 'interrupted', reason = '服务重启，生成已中断',
           cancel_requested = 1, finished_at = ?
     WHERE status IN ('queued','running')
  `).run(now);
  return Number(r.changes ?? 0);
}

/** 终态且超过保留期的清掉。与 pruneDoneJobs 同一个维护窗口调用 */
export function pruneDigestRuns(db: DatabaseSync, keepDays = 30, now = Date.now()): number {
  const cut = now - keepDays * 86400_000;
  const r = db.prepare(`
    DELETE FROM digest_runs
     WHERE status NOT IN ('queued','running')
       AND COALESCE(finished_at, started_at) < ?
  `).run(cut);
  return Number(r.changes ?? 0);
}

/** 行的对外形状。stale 只在 running 时才有意义 */
export function viewOf(row: DigestRunRow | null, now = Date.now()): RunView | null {
  if (!row) return null;
  const status = row.status;
  return {
    id: row.id,
    status,
    phase: row.phase,
    doneClusters: Number(row.done_clusters ?? 0),
    totalClusters: Number(row.total_clusters ?? 0),
    costUsd: Number(row.cost_usd ?? 0),
    startedAt: Number(row.started_at),
    heartbeatAt: Number(row.heartbeat_at),
    elapsedMs: Math.max(0, (Number(row.finished_at ?? now)) - Number(row.started_at)),
    stale: status === 'running' && now - Number(row.heartbeat_at) > STALE_RUN_MS,
    cancelReason: row.cancel_reason,
    reason: row.reason,
    digestId: row.digest_id,
    manual: Number(row.manual ?? 0) === 1,
  };
}

export function isLive(status: RunStatus): boolean {
  return LIVE.includes(status);
}
