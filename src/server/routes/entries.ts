import { Hono } from 'hono';
import type { AppContext, Variables } from '../app.ts';
import { badRequest, notFound } from '../errors.ts';
import { requireUserId } from '../auth/require-user.ts';
import { searchKeyword, searchLike } from '../search/index.ts';
import { queueStats } from '../jobs/queue.ts';
import { unpackText } from '../db/text-blob.ts';

// 条目相关 API。
//
// M0 只做读取 + 已读标记 —— 足够支撑前端验收。
// 抓取、分析、高亮在 M1~M4 落地。

export function entryRoutes(ctx: AppContext): Hono<{ Variables: Variables }> {
  const r = new Hono<{ Variables: Variables }>();

  // ── 列表 ────────────────────────────────────────────────
  // 游标用 publishedAt + id 复合，避免同一毫秒多条时漏/重。
  r.get('/entries', (c) => {
    const uid = requireUserId(c);
    const view = c.req.query('view') ?? 'inbox';
    const q = (c.req.query('q') ?? '').trim();
    const limit = Math.min(Number(c.req.query('limit') ?? 30) || 30, 100);
    const cursor = c.req.query('cursor') ?? null;

    const where: string[] = ['e.user_id = ?'];
    const params: (string | number)[] = [uid];

    if (view === 'unread') where.push('e.is_read = 0');
    else if (view === 'starred') where.push('e.is_starred = 1');
    else if (view === 'history') where.push('e.last_read_at IS NOT NULL');
    else where.push('e.is_hidden = 0');

    // 关键词检索走 FTS，把命中的 id 列表作为过滤条件。
    // 这样分页与排序仍由 SQL 处理，不需要把整个结果集捞进内存。
    let ftsIds: string[] | null = null;
    if (q) {
      const hits = searchKeyword(ctx.dbh.db, uid, q, 2000);
      const used = hits.length > 0 ? hits.map((h) => h.entryId) : searchLike(ctx.dbh.db, uid, q, 2000).map((h) => h.entryId);
      if (used.length === 0) {
        return c.json({ items: [], total: 0, nextCursor: null });
      }
      ftsIds = used;
    }

    if (ftsIds) {
      where.push(`e.id IN (${ftsIds.map(() => '?').join(',')})`);
      params.push(...ftsIds);
    }

    if (cursor) {
      const [pubStr, idStr] = cursor.split('_');
      const pub = Number(pubStr);
      if (Number.isFinite(pub)) {
        // 严格小于游标位置；同毫秒用 id 打破平局
        where.push('(e.published_at < ? OR (e.published_at = ? AND e.id < ?))');
        params.push(pub, pub, idStr ?? '');
      }
    }

    const orderCol = view === 'history' ? 'e.last_read_at' : 'e.published_at';
    const sql = `
      SELECT e.id, e.title, e.url, e.author, ${orderCol} AS sort_at,
             e.published_at AS published_at, e.excerpt, e.is_read, e.is_starred,
             e.highlight_count, e.site_name, e.read_count, e.last_read_at,
             e.favicon_url, e.thumbnail_url, e.word_count,
             a.summary AS summary, a.tier AS tier
        FROM entries e
        LEFT JOIN entry_analysis a ON a.entry_id = e.id
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderCol} DESC, e.id DESC
       LIMIT ?
    `;
    const rows = ctx.dbh.db.prepare(sql).all(...params, limit + 1) as Record<string, unknown>[];

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const items = page.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      author: row.author,
      publishedAt: Number(view === 'history' ? (row.last_read_at ?? row.published_at) : row.published_at),
      excerpt: row.excerpt,
      isRead: Boolean(row.is_read),
      isStarred: Boolean(row.is_starred),
      tier: row.tier,
      summary: row.summary,
      siteName: row.site_name,
      highlightCount: Number(row.highlight_count ?? 0),
      faviconUrl: row.favicon_url,
      thumbnailUrl: row.thumbnail_url,
      wordCount: row.word_count === null ? null : Number(row.word_count),
    }));

    const last = page[page.length - 1];
    let nextCursor: string | null = null;
    if (hasMore && last) {
      const cursorTime = view === 'history'
        ? Number(last.last_read_at ?? last.published_at)
        : Number(last.published_at);
      nextCursor = `${cursorTime}_${String(last.id)}`;
    }

    const totalRow = ctx.dbh.db.prepare(
      `SELECT COUNT(*) AS c FROM entries e WHERE ${where.join(' AND ')}`,
    ).get(...params) as { c: number };

    return c.json({ items, total: Number(totalRow.c), nextCursor });
  });

  // ── 详情 ────────────────────────────────────────────────
  r.get('/entries/:id', (c) => {
    const uid = requireUserId(c);
    const id = c.req.param('id');

    const row = ctx.dbh.db.prepare(`
      SELECT e.*, a.summary, a.key_points, a.topics, a.importance, a.tier, a.reading_time
        FROM entries e
        LEFT JOIN entry_analysis a ON a.entry_id = e.id
       WHERE e.id = ? AND e.user_id = ?
    `).get(id, uid) as Record<string, unknown> | undefined;

    if (!row) throw notFound('条目不存在');

    // 正文是 gzip BLOB，解压后给前端
    let html: string | null = null;
    const content = ctx.dbh.db.prepare('SELECT html FROM entry_contents WHERE entry_id = ?')
      .get(id) as { html: Uint8Array | null } | undefined;
    if (content?.html) {
      html = unpackText(content.html);
    }

    const analysis = row.summary
      ? {
          summary: String(row.summary),
          keyPoints: safeJsonArray(row.key_points),
          topics: safeJsonArray(row.topics),
          importance: Number(row.importance ?? 0),
          tier: String(row.tier ?? 'normal'),
          readingTime: row.reading_time === null ? null : Number(row.reading_time),
        }
      : null;

    return c.json({
      id: row.id,
      title: row.title,
      url: row.url,
      author: row.author,
      publishedAt: Number(row.published_at),
      excerpt: row.excerpt,
      isRead: Boolean(row.is_read),
      isStarred: Boolean(row.is_starred),
      tier: row.tier,
      summary: row.summary,
      siteName: row.site_name,
      highlightCount: Number(row.highlight_count ?? 0),
      contentHtml: html,
      contentMarkdown: null,
      analysis,
    });
  });

  // ── 标记已读（幂等，PLAN §7.4）───────────────────────────
  r.post('/entries/read', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as {
      ids?: string[];
      progress?: number;
    };
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length === 0) throw badRequest('需要 ids');

    const now = Date.now();
    const upd = ctx.dbh.db.prepare(`
      UPDATE entries SET
        first_read_at = COALESCE(first_read_at, ?),
        last_read_at  = ?,
        read_count    = read_count + 1,
        is_read       = 1,
        read_progress = COALESCE(?, read_progress)
      WHERE id = ? AND user_id = ?
    `);
    const progress = body.progress === undefined ? null : Number(body.progress);

    ctx.dbh.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) upd.run(now, now, progress, id, uid);
      ctx.dbh.db.exec('COMMIT');
    } catch (e) {
      ctx.dbh.db.exec('ROLLBACK');
      throw e;
    }
    return c.json({ ok: true, count: ids.length });
  });

  // ── 收藏切换 ────────────────────────────────────────────
  r.post('/entries/:id/star', (c) => {
    const uid = requireUserId(c);
    const id = c.req.param('id');
    const row = ctx.dbh.db.prepare('SELECT is_starred FROM entries WHERE id = ? AND user_id = ?')
      .get(id, uid) as { is_starred: number } | undefined;
    if (!row) throw notFound('条目不存在');
    const next = row.is_starred ? 0 : 1;
    ctx.dbh.db.prepare('UPDATE entries SET is_starred = ? WHERE id = ? AND user_id = ?')
      .run(next, id, uid);
    return c.json({ isStarred: Boolean(next) });
  });

  // ── 统计 ────────────────────────────────────────────────
  r.get('/stats', (c) => {
    const uid = requireUserId(c);
    const one = (sql: string): number => {
      const x = ctx.dbh.db.prepare(sql).get(uid) as { c: number } | undefined;
      return Number(x?.c ?? 0);
    };
    const q = queueStats(ctx.dbh.db);
    return c.json({
      entries: one('SELECT COUNT(*) c FROM entries WHERE user_id = ?'),
      feeds: one('SELECT COUNT(*) c FROM feeds WHERE user_id = ?'),
      unread: one('SELECT COUNT(*) c FROM entries WHERE user_id = ? AND is_read = 0'),
      starred: one('SELECT COUNT(*) c FROM entries WHERE user_id = ? AND is_starred = 1'),
      queue: { pending: q.pending, running: q.running, dead: q.dead },
    });
  });

  return r;
}

function safeJsonArray(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x.map(String) : [];
  } catch {
    return [];
  }
}
