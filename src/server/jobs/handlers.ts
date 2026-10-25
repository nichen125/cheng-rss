import type { DatabaseSync } from 'node:sqlite';
import type { JobHandler } from './runner.ts';
import { getFeed } from '../feeds/store.ts';
import type { AppContext } from '../app.ts';

// 处理器注册表。
//
// M0 只放 noop / count 两个探针（验收脚本用来验证队列机制），
// M1 加 fetch_feed。extract / analyze / embed / cluster / digest 在 M2~M3。

export interface HandlerContext {
  dataDir: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** fetch_feed 需要完整的运行时上下文（DB + 配置） */
  app?: AppContext;
}

export function buildHandlers(ctx: HandlerContext): Record<string, JobHandler> {
  const handlers: Record<string, JobHandler> = {};

  // ── 探针：payload { echo?, fail?, sleepMs? } ─────────────
  // fail 为 true 时抛错，用来验证退避与死信
  handlers['noop'] = async (job, _db) => {
    const p = safeParse(job.payload);
    const sleepMs = Number(p.sleepMs ?? 0);
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
    if (p.fail) throw new Error(String(p.failMessage ?? '故意失败'));
    ctx.log?.('noop 完成', { id: job.id, echo: p.echo });
  };

  // ── 探针：记录执行次数，验证 dedupe ──────────────────────
  handlers['count'] = async (job, db: DatabaseSync) => {
    const p = safeParse(job.payload);
    const key = String(p.key ?? 'default');
    db.prepare(`
      INSERT INTO rsshub_cache (key, payload, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        payload = CAST(CAST(payload AS INTEGER) + 1 AS TEXT), fetched_at = excluded.fetched_at
    `).run(`verify:count:${key}`, '1', Date.now());
  };

  // ── 抓取单个订阅源 ──────────────────────────────────────
  //
  // handler 里不重复抓取逻辑：直接调 routes/feeds.ts 的 runFetch，
  // 保证「定时抓取」与「手动刷新」走完全相同的代码路径。
  handlers['fetch_feed'] = async (job, _db) => {
    const p = safeParse(job.payload);
    const feedId = String(p.feedId ?? '');
    if (!feedId) throw new Error('fetch_feed 缺少 feedId');
    if (!ctx.app) throw new Error('fetch_feed 需要 AppContext（仅 serve 模式可用）');

    const db = ctx.app.dbh.db;
    const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(feedId);
    if (!feed) {
      // 源已被删：任务作废，不是失败。抛错会白白退避重试 3 次。
      ctx.log?.('fetch_feed: 订阅已不存在，跳过', { feedId });
      return;
    }

    const { runFetch } = await import('../routes/feeds.ts');
    const r = await runFetch(ctx.app, feed as never);
    if (!r.ok) {
      // 永久失效（404/410 或连续失败置 broken）不再重试
      // retryable 的判断已经在 runFetch 里记账到 feeds.status 与 error_count，
      // 这里只需决定这个 job 是否该退避：status 变 broken 就不再抛错。
      if (r.status === 'broken') {
        ctx.log?.(`fetch_feed: 源已标记 broken，停止重试`, { feedId, error: r.error });
        return;
      }
      throw new Error(r.error ?? '抓取失败');
    }
    ctx.log?.(`fetch_feed 完成`, { feedId, inserted: r.inserted, notModified: r.notModified });
  };

  return handlers;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

void getFeed;

