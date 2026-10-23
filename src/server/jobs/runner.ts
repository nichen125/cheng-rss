import type { DatabaseSync } from 'node:sqlite';
import { claimBatch, completeJob, failJob, pruneDoneJobs, queueStats, recoverStaleJobs, type Job } from './queue.ts';
import { log } from '../logger.ts';

// Job runner：单进程内轮询 + 按 kind 分并发。
//
// 为什么不用外部 MQ：见 PLAN §7.2。50 源规模下 SQLite 队列绰绰有余，
// 引入 Redis 只会让 NAS 部署多一个组件。
//
// 并发分配依据实测（PLAN §5.2）：
//   fetch    5  网络等待为主，可高并发
//   extract  4  实测 4 路并发收益已饱和，再高只吃内存
//   analyze  2  受模型 RPM 限制，主要瓶颈在 API
//   embed    4
//   cluster/digest 1  长上下文调用，与提取抢 CPU

export type JobHandler = (job: Job, db: DatabaseSync) => Promise<void>;

export interface RunnerOptions {
  db: DatabaseSync;
  handlers: Record<string, JobHandler>;
  workerId?: string;
  /** 轮询间隔，默认 200ms */
  pollMs?: number;
  /** 各 kind 的并发上限；未列出的 kind 用 defaultConcurrency */
  concurrency?: Record<string, number>;
  defaultConcurrency?: number;
}

const DEFAULT_CONCURRENCY: Record<string, number> = {
  fetch_feed: 5,
  extract: 4,
  analyze: 2,
  embed: 4,
  cluster: 1,
  digest: 1,
};

export class JobRunner {
  private readonly db: DatabaseSync;
  private readonly handlers: Record<string, JobHandler>;
  private readonly workerId: string;
  private readonly pollMs: number;
  private readonly concurrency: Record<string, number>;
  private readonly defaultConcurrency: number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /** 当前各 kind 的在飞数量 */
  private inflight = new Map<string, number>();
  /** 未知 kind 的任务（handler 缺失）只报一次，避免刷屏 */
  private warnedKinds = new Set<string>();

  constructor(opts: RunnerOptions) {
    this.db = opts.db;
    this.handlers = opts.handlers;
    this.workerId = opts.workerId ?? `w_${process.pid}`;
    this.pollMs = opts.pollMs ?? 200;
    this.concurrency = { ...DEFAULT_CONCURRENCY, ...(opts.concurrency ?? {}) };
    this.defaultConcurrency = opts.defaultConcurrency ?? 1;
  }

  /**
   * 启动：先恢复僵尸任务，再进入轮询。
   *
   * 恢复必须在这里做而不是靠人工 —— 进程被 Ctrl-C / kill -9 后，
   * running 状态的任务不会自己回到 pending。
   */
  start(): void {
    const recovered = recoverStaleJobs(this.db);
    if (recovered > 0) {
      log.warn(`恢复了 ${recovered} 个僵死任务（上次未正常退出）`);
    }
    this.stopped = false;
    this.scheduleNext(0);
    log.info('job runner 已启动', { workerId: this.workerId, pollMs: this.pollMs });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // 等待在飞任务结束，最多 5 秒
    const deadline = Date.now() + 5000;
    while (this.totalInflight() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** 跑一轮认领与派发。导出给验收脚本直接调用，避免依赖真实定时器。 */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let dispatched = 0;
    try {
      // 各 kind 的剩余额度不同，这里取最大值认领，再按 kind 分别控制
      const limit = 20;
      const jobs = claimBatch(this.db, this.workerId, limit);

      for (const job of jobs) {
        const cap = this.concurrency[job.kind] ?? this.defaultConcurrency;
        const cur = this.inflight.get(job.kind) ?? 0;

        if (cur >= cap) {
          // 超额：立刻退回 pending，下一轮再抢
          // 不用 failJob —— 那不是失败，只是暂时没额度
          this.db.prepare(
            `UPDATE jobs SET status='pending', locked_by=NULL, locked_at=NULL,
                             attempts=MAX(attempts-1, 0), updated_at=? WHERE id=?`,
          ).run(Date.now(), job.id);
          continue;
        }

        const handler = this.handlers[job.kind];
        if (!handler) {
          if (!this.warnedKinds.has(job.kind)) {
            this.warnedKinds.add(job.kind);
            log.warn(`没有 ${job.kind} 的处理器，任务将置为 dead`);
          }
          // 缺 handler 是永久性错误，重试多少次都不会变好，
          // 因此直接置 dead 而不是走 failJob 的退避逻辑。
          this.db.prepare(
            `UPDATE jobs SET status='dead', last_error=?, locked_by=NULL, locked_at=NULL,
                             updated_at=? WHERE id=?`,
          ).run(`没有注册 ${job.kind} 的处理器`, Date.now(), job.id);
          continue;
        }

        this.inflight.set(job.kind, cur + 1);
        dispatched++;
        this.dispatch(job, handler);
      }
    } finally {
      this.running = false;
    }
    return dispatched;
  }

  private dispatch(job: Job, handler: JobHandler): void {
    // 用 queueMicrotask 让 tick 先返回，避免阻塞认领循环
    Promise.resolve()
      .then(() => handler(job, this.db))
      .then(() => {
        completeJob(this.db, job.id);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        const r = failJob(this.db, job.id, msg);
        if (r.status === 'dead') {
          log.error(`任务 ${job.id} (${job.kind}) 已达重试上限，置为 dead`, { err: msg.slice(0, 200) });
        } else {
          log.warn(`任务 ${job.id} (${job.kind}) 失败，${Math.round(r.retryInMs / 1000)}s 后重试`, {
            err: msg.slice(0, 200),
          });
        }
      })
      .finally(() => {
        const n = (this.inflight.get(job.kind) ?? 1) - 1;
        if (n <= 0) this.inflight.delete(job.kind);
        else this.inflight.set(job.kind, n);
        if (!this.stopped) this.scheduleNext(this.pollMs);
      });
  }

  private scheduleNext(delay: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick()
        .catch((e) => log.error('job runner tick 失败', { err: (e as Error).message }))
        .finally(() => {
          if (!this.stopped) this.scheduleNext(this.pollMs);
        });
    }, delay);
    this.timer.unref?.();
  }

  private totalInflight(): number {
    let n = 0;
    for (const v of this.inflight.values()) n += v;
    return n;
  }

  stats() {
    return queueStats(this.db);
  }

  prune(keepDays = 7): number {
    return pruneDoneJobs(this.db, keepDays);
  }
}
