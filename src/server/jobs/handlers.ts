import type { DatabaseSync } from 'node:sqlite';
import type { JobHandler } from './runner.ts';

// 处理器注册表。
//
// M0 只放一个 noop 探针（验收脚本用它验证队列机制），
// 真正的 fetch/extract/analyze/embed/cluster/digest 在 M1~M3 落地。
// 这样 0.6 的验收不依赖任何外部服务。

export interface HandlerContext {
  dataDir: string;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
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
