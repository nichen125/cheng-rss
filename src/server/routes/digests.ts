import { Hono } from 'hono';
import type { AppContext, Variables } from '../app.ts';
import { requireUserId } from '../auth/require-user.ts';
import { notFound } from '../errors.ts';

// 简报的读取与手动生成（PLAN §18 / §19.5 3.4）。
//
// 手动「现在生成」与定时生成走同一条 runDigest，只差 `manual: true`：
// 手动时**跳过时间与今日是否已做**这两关（用户点了按钮就该生成），
// 但不跳过"有没有内容" —— 没有内容时明确告诉他为什么，而不是产出空白。

export function digestRoutes(ctx: AppContext): Hono<{ Variables: Variables }> {
  const r = new Hono<{ Variables: Variables }>();

  r.get('/digests', async (c) => {
    const uid = requireUserId(c);
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20)));
    const rows = ctx.dbh.db.prepare(`
      SELECT id, title, intro, period_start, period_end, entry_count, cluster_count,
             model, cost_usd, delivered_at, created_at, day_key
        FROM digests WHERE user_id = ?
        ORDER BY day_key DESC, created_at DESC LIMIT ?
    `).all(uid, limit) as Record<string, unknown>[];

    return c.json({
      items: rows.map((x) => ({
        id: x.id,
        title: x.title,
        intro: String(x.intro ?? '').split('\n').filter(Boolean),
        periodStart: x.period_start,
        periodEnd: x.period_end,
        dayKey: x.day_key,
        entryCount: x.entry_count,
        clusterCount: x.cluster_count,
        model: x.model,
        costUsd: x.cost_usd,
        deliveredAt: x.delivered_at,
        createdAt: x.created_at,
      })),
    });
  });

  r.get('/digests/latest', (c) => {
    const uid = requireUserId(c);
    const row = ctx.dbh.db.prepare(`
      SELECT * FROM digests WHERE user_id = ? ORDER BY day_key DESC, created_at DESC LIMIT 1
    `).get(uid) as Record<string, unknown> | undefined;
    if (!row) throw notFound('还没有简报');
    return c.json(shape(row));
  });

  // ⚠ 顺序：`/digests/status` 必须注册在 `/digests/:id` **之前**。
  // 反过来的话 "status" 会被当成一个 id 去查库，结果是 404「简报不存在」——
  // 一个看起来像"今天没有简报"的假象，而真实原因是路由顺序。
  // 同一个坑在 /entries 的 history / mark-all-read 上踩过一次（§7.5）。
  /** 今天的简报状态：为什么没有、什么时候会再试 */
  r.get('/digests/status', async (c) => {
    const uid = requireUserId(c);
    const { digestStatus, parseDigestConfig } = await import('../digest/schedule.ts');
    const row = ctx.dbh.db.prepare('SELECT digest_config FROM settings WHERE user_id = ?')
      .get(uid) as { digest_config: string } | undefined;
    let raw: unknown = null;
    try { raw = row?.digest_config ? JSON.parse(row.digest_config) : null; } catch { /* 坏配置用默认 */ }
    return c.json(digestStatus(ctx.dbh.db, uid, parseDigestConfig(raw)));
  });

  r.get('/digests/:id', (c) => {
    const uid = requireUserId(c);
    const row = ctx.dbh.db.prepare(
      'SELECT * FROM digests WHERE id = ? AND user_id = ?',
    ).get(c.req.param('id'), uid) as Record<string, unknown> | undefined;
    if (!row) throw notFound('简报不存在');

    // 简报引用的簇：正文里只有 [1] [2] 这样的脚注号，
    // 用户点开要能看到"第 1 条对应哪件事、那件事有几篇报道"。
    const ids = String(row.body_md ?? '').match(/\{\{cite:([A-Za-z0-9_-]+)\}\}/g)
      ?.map((m) => m.slice(7, -2)) ?? [];
    const clusters = ids.length === 0 ? [] : ctx.dbh.db.prepare(`
      SELECT id, title, summary, entry_count, source_count, heat
        FROM clusters WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})
    `).all(uid, ...ids) as Record<string, unknown>[];

    return c.json({ ...shape(row), clusters });
  });

  /**
   * 手动生成。
   *
   * 返回 200 + `ok:false` 而不是 4xx：**"没有内容"不是请求错误**。
   * 用户点"生成今天的简报"时如果今天确实没什么新闻，那是正常结果，
   * 用 4xx 会让前端弹一个红色错误框，而正确表现是一句说明。
   */
  r.post('/digests/run', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as { force?: boolean };

    const { runDigest } = await import('../digest/run.ts');
    const r2 = await runDigest(ctx, {
      userId: uid,
      manual: true,
      // allowSingle：手动生成时 1 个簇也出 —— 用户可能就想看这一件事的综述；
      // force 的语义是"跳过'只有 1 个事件不值得'这条判断"，不是绕过内容检查
      allowSingle: Boolean(body.force),
    });

    return c.json({
      ok: r2.ok,
      digestId: r2.digestId,
      reason: r2.reason,
      clusterCount: r2.clusterCount,
      entryCount: r2.entryCount,
      costUsd: Number(r2.costUsd.toFixed(6)),
      invalidCites: r2.invalidCites,
      strippedUrls: r2.strippedUrls,
    });
  });

  return r;
}

function shape(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    intro: String(row.intro ?? '').split('\n').filter(Boolean),
    bodyMd: row.body_md,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    dayKey: row.day_key,
    entryCount: row.entry_count,
    clusterCount: row.cluster_count,
    model: row.model,
    costUsd: row.cost_usd,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  };
}
