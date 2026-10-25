import { Hono } from 'hono';
import type { AppContext, Variables } from '../app.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { requireUserId } from '../auth/require-user.ts';
import { log } from '../logger.ts';
import { discoverFeed, fetchFeed, FetchError } from '../feeds/fetch.ts';
import { parseFeed } from '../feeds/parse.ts';
import { buildOpml, parseOpml } from '../feeds/opml.ts';
import { sanitizeHtml } from '../feeds/sanitize.ts';
import {
  createFeed, deleteFeed, dueFeeds, enqueueFetch, findFeedByUrl, getFeed,
  listFeeds, updateFeed, upsertItems, recordFetchError, scheduleNextFetch,
  type FeedRow, type FeedStatus,
} from '../feeds/store.ts';

// 订阅管理 API（PLAN §18）。
//
// 端点形状刻意保持简单：POST /feeds 接受一个 URL 就去发现并订阅，
// 不需要前端先调"发现"再调"创建" —— 那会多一次往返，也要处理
// "发现到了但用户又改了"的状态同步。

export function feedRoutes(ctx: AppContext): Hono<{ Variables: Variables }> {
  const r = new Hono<{ Variables: Variables }>();

  // ── 列表 ────────────────────────────────────────────────
  r.get('/feeds', (c) => {
    const uid = requireUserId(c);
    const rows = listFeeds(ctx.dbh.db, uid);
    const items = rows.map(shapeFeed);
    return c.json({
      items,
      total: items.length,
      /** 各状态的源数，供侧栏与空态使用 */
      counts: {
        active: items.filter((f) => f.status === 'active').length,
        broken: items.filter((f) => f.status === 'broken').length,
        paused: items.filter((f) => f.status === 'paused').length,
        unread: items.reduce((n, f) => n + f.unread, 0),
      },
    });
  });

  // ── 发现（不落库）──────────────────────────────────────
  //
  // 单独暴露的意义：用户贴一个首页地址时，可能发现多个 feed
  // （主站 feed + 评论 feed），需要让他选，而不是替她随便挑一个。
  r.post('/feeds/discover', async (c) => {
    requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as { url?: string };
    const url = normalizeInputUrl(body.url);
    if (!url) throw badRequest('需要一个有效的 http(s) 订阅地址');

    const result = await discoverFeed(url);
    if (result.candidates.length === 0) {
      return c.json({
        found: false,
        candidates: [],
        notes: result.notes,
        message: '没有找到可用的 feed。请确认地址，或直接填 feed 文件的完整 URL。',
      });
    }

    // 补上元信息（标题/站点/图标），失败不影响返回
    const candidates = await Promise.all(result.candidates.map(async (u) => {
      try {
        const res = await fetchFeed(u);
        if (!res.body) return { url: u, title: null, siteUrl: null, iconUrl: null, itemCount: 0 };
        const f = parseFeed(res.body, res.finalUrl);
        return {
          url: res.finalUrl,
          title: f.title,
          siteUrl: f.siteUrl,
          iconUrl: f.iconUrl,
          itemCount: f.items.length,
        };
      } catch {
        return { url: u, title: null, siteUrl: null, iconUrl: null, itemCount: 0 };
      }
    }));

    return c.json({ found: true, candidates, notes: result.notes });
  });

  // ── 添加订阅 ────────────────────────────────────────────
  r.post('/feeds', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as {
      url?: string; folderId?: string | null; fetchInterval?: number;
    };
    const url = normalizeInputUrl(body.url);
    if (!url) throw badRequest('需要一个有效的 http(s) 订阅地址');

    // 已订阅过的直接返回，不报错 —— 用户重复点"订阅"不该看到红字
    const existing = findFeedByUrl(ctx.dbh.db, uid, url);
    if (existing) {
      return c.json({ created: false, feed: shapeFeed({ ...existing, unread: 0, total: 0 }) });
    }

    // 发现真实地址
    const disc = await discoverFeed(url);
    if (disc.candidates.length === 0) {
      throw badRequest(
        '这个地址没有可用的 feed。' + (disc.notes.length ? `（${disc.notes.join('；')}）` : ''),
      );
    }
    const feedUrl = disc.candidates[0]!;

    const dup = findFeedByUrl(ctx.dbh.db, uid, feedUrl);
    if (dup) {
      return c.json({ created: false, feed: shapeFeed({ ...dup, unread: 0, total: 0 }) });
    }

    // 先抓一次再落库：订阅一个拉不到内容的源对用户没有价值，
    // 而且能拿到标题/图标/首屏条目，添加后立刻有内容可看。
    let parsed;
    let fetched;
    try {
      fetched = await fetchFeed(feedUrl);
      if (!fetched.body) throw new FetchError('feed 内容为空');
      parsed = parseFeed(fetched.body, fetched.finalUrl);
    } catch (e) {
      throw badRequest(`无法读取该 feed：${(e as Error).message}`);
    }

    const feed = createFeed(ctx.dbh.db, {
      userId: uid,
      url: fetched.finalUrl,
      title: parsed.title,
      siteUrl: parsed.siteUrl,
      iconUrl: parsed.iconUrl,
      folderId: body.folderId ?? null,
      fetchInterval: body.fetchInterval,
      sourceKind: 'rss',
    });

    // 存条件请求的头，下次抓取可以走 304
    ctx.dbh.db.prepare('UPDATE feeds SET etag = ?, last_modified = ? WHERE id = ?')
      .run(fetched.etag, fetched.lastModified, feed.id);

    const stats = upsertItems(ctx.dbh.db, feed, parsed);
    scheduleNextFetch(ctx.dbh.db, feed);

    log.info(`新增订阅 ${feed.title ?? feed.url}`, { inserted: stats.inserted, skipped: stats.skipped });

    return c.json({
      created: true,
      feed: shapeFeed({ ...feed, title: parsed.title ?? feed.title, unread: stats.inserted, total: stats.inserted }),
      imported: stats.inserted,
    }, 201);
  });

  // ── 手动刷新 ────────────────────────────────────────────
  r.post('/feeds/:id/refresh', (c) => {
    const uid = requireUserId(c);
    const id = c.req.param('id');
    const feed = getFeed(ctx.dbh.db, uid, id);
    if (!feed) throw notFound('订阅不存在');
    enqueueFetch(ctx.dbh.db, id, 100);
    return c.json({ ok: true, queued: true });
  });

  // ── 修改 ────────────────────────────────────────────────
  r.patch('/feeds/:id', async (c) => {
    const uid = requireUserId(c);
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as {
      title?: string | null;
      fetchInterval?: number;
      status?: string;
      folderId?: string | null;
    };

    const patch: Parameters<typeof updateFeed>[3] = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.fetchInterval !== undefined) {
      const n = Number(body.fetchInterval);
      if (!Number.isFinite(n) || n < 300) throw badRequest('抓取间隔最小 300 秒');
      patch.fetchInterval = Math.round(n);
    }
    if (body.folderId !== undefined) patch.folderId = body.folderId;
    if (body.status !== undefined) {
      if (!['active', 'paused'].includes(body.status)) {
        throw badRequest('status 只能是 active 或 paused');
      }
      patch.status = body.status as FeedStatus;
    }

    const updated = updateFeed(ctx.dbh.db, uid, id, patch);
    if (!updated) throw notFound('订阅不存在');
    return c.json({ feed: shapeFeed({ ...updated, unread: 0, total: 0 }) });
  });

  // ── 删除 ────────────────────────────────────────────────
  r.delete('/feeds/:id', (c) => {
    const uid = requireUserId(c);
    const id = c.req.param('id');
    const ok = deleteFeed(ctx.dbh.db, uid, id);
    if (!ok) throw notFound('订阅不存在');
    return c.json({ ok: true });
  });

  // ── 全部刷新 ────────────────────────────────────────────
  r.post('/feeds/refresh-all', (c) => {
    const uid = requireUserId(c);
    const rows = listFeeds(ctx.dbh.db, uid).filter((f) => f.status !== 'paused');
    let queued = 0;
    for (const f of rows) {
      // 全部提到最高优先级并立刻可跑
      ctx.dbh.db.prepare('UPDATE feeds SET next_fetch_at = ? WHERE id = ?').run(Date.now(), f.id);
      if (enqueueFetch(ctx.dbh.db, f.id, 100) !== null) queued++;
    }
    return c.json({ ok: true, queued, total: rows.length });
  });

  // ── OPML ────────────────────────────────────────────────
  r.get('/feeds/export', (c) => {
    const uid = requireUserId(c);
    const rows = listFeeds(ctx.dbh.db, uid);
    const xml = buildOpml(rows.map((f) => ({
      url: f.url,
      title: f.title,
      siteUrl: f.site_url,
      folder: null,
    })));
    return c.body(xml, 200, {
      'content-type': 'text/x-opml; charset=utf-8',
      'content-disposition': `attachment; filename="ai-rss-feeds-${new Date().toISOString().slice(0, 10)}.opml"`,
    });
  });

  r.post('/feeds/import', async (c) => {
    const uid = requireUserId(c);
    const ct = c.req.header('content-type') ?? '';

    let xml: string;
    if (ct.includes('application/json')) {
      const body = await c.req.json().catch(() => ({})) as { opml?: string };
      xml = body.opml ?? '';
    } else {
      xml = await c.req.text();
    }
    if (!xml.trim()) throw badRequest('没有收到 OPML 内容');

    let parsed;
    try {
      parsed = parseOpml(xml);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    if (parsed.feeds.length === 0) {
      throw badRequest(
        `OPML 里没有可导入的订阅${parsed.skipped.length ? `（跳过 ${parsed.skipped.length} 项）` : ''}`,
      );
    }

    // 逐个创建：不并发是因为每个都要真实抓一次，并发会把对端打挂
    const created: { id: string; title: string | null; url: string }[] = [];
    const skipped: { url: string; reason: string }[] = [];

    for (const f of parsed.feeds) {
      if (findFeedByUrl(ctx.dbh.db, uid, f.url)) {
        skipped.push({ url: f.url, reason: '已订阅' });
        continue;
      }
      try {
        const res = await fetchFeed(f.url);
        if (!res.body) { skipped.push({ url: f.url, reason: '内容为空' }); continue; }
        const pf = parseFeed(res.body, res.finalUrl);
        if (pf.items.length === 0 && !pf.title) {
          skipped.push({ url: f.url, reason: '不是有效 feed' });
          continue;
        }
        if (findFeedByUrl(ctx.dbh.db, uid, res.finalUrl)) {
          skipped.push({ url: f.url, reason: '已订阅' });
          continue;
        }
        const feed = createFeed(ctx.dbh.db, {
          userId: uid,
          url: res.finalUrl,
          title: pf.title ?? f.title,
          siteUrl: pf.siteUrl ?? f.siteUrl,
          iconUrl: pf.iconUrl,
          sourceKind: 'opml',
        });
        ctx.dbh.db.prepare('UPDATE feeds SET etag = ?, last_modified = ? WHERE id = ?')
          .run(res.etag, res.lastModified, feed.id);
        upsertItems(ctx.dbh.db, feed, pf);
        scheduleNextFetch(ctx.dbh.db, feed);
        created.push({ id: feed.id, title: pf.title ?? f.title, url: feed.url });
      } catch (e) {
        skipped.push({ url: f.url, reason: (e as Error).message.slice(0, 120) });
      }
    }

    return c.json({
      created: created.length,
      skipped: skipped.length + parsed.skipped.length,
      items: created,
      details: skipped.slice(0, 20),
    });
  });

  // ── 抓取执行（给 job handler 与手动调试共用）────────────
  r.post('/feeds/:id/fetch-now', async (c) => {
    const uid = requireUserId(c);
    const id = c.req.param('id');
    const feed = getFeed(ctx.dbh.db, uid, id);
    if (!feed) throw notFound('订阅不存在');
    const result = await runFetch(ctx, feed);
    return c.json(result);
  });

  return r;
}

/**
 * 真正执行一次抓取。
 *
 * 抽成函数是因为三处都要用：手动刷新端点、job handler、OPML 导入。
 * 逻辑只写一遍，避免"手动刷新和定时抓取行为不一致"这类难查的 bug。
 */
export async function runFetch(
  ctx: AppContext,
  feed: FeedRow,
): Promise<{
  ok: boolean;
  notModified?: boolean;
  inserted?: number;
  skipped?: number;
  error?: string;
  status?: FeedStatus;
}> {
  try {
    const res = await fetchFeed(feed.url, { etag: feed.etag, lastModified: feed.last_modified });

    // 304：内容没变，但要推进 next_fetch_at，否则会一直重抓
    if (res.notModified) {
      scheduleNextFetch(ctx.dbh.db, feed);
      return { ok: true, notModified: true, inserted: 0, skipped: 0 };
    }
    if (!res.body) throw new FetchError('响应为空');

    const parsed = parseFeed(res.body, res.finalUrl);
    if (parsed.items.length === 0) {
      // 0 条目不算失败：有些源会临时返回空 feed。计数但不置 broken。
      scheduleNextFetch(ctx.dbh.db, feed);
      return { ok: true, inserted: 0, skipped: 0 };
    }

    const stats = upsertItems(ctx.dbh.db, feed, parsed);

    ctx.dbh.db.prepare(`
      UPDATE feeds SET etag = ?, last_modified = ?, title = COALESCE(title, ?),
                       site_url = COALESCE(site_url, ?), icon_url = COALESCE(icon_url, ?)
       WHERE id = ?
    `).run(res.etag, res.lastModified, parsed.title, parsed.siteUrl, parsed.iconUrl, feed.id);

    scheduleNextFetch(ctx.dbh.db, feed);

    if (stats.inserted > 0) {
      log.info(`${feed.title ?? feed.url} 抓到 ${stats.inserted} 条新内容`);
    }
    return { ok: true, inserted: stats.inserted, skipped: stats.skipped };
  } catch (e) {
    const retryable = e instanceof FetchError ? e.retryable : true;
    const message = (e as Error).message;
    const rec = recordFetchError(ctx.dbh.db, feed, { message, retryable });
    log.warn(`抓取失败 ${feed.title ?? feed.url}: ${message}`, {
      status: rec.status, errorCount: rec.errorCount,
    });
    return { ok: false, error: message, status: rec.status };
  }
}

/** 给定时 sweep 用：把到期的源入队 */
export function sweepDueFeeds(ctx: AppContext, now = Date.now()): number {
  const due = dueFeeds(ctx.dbh.db, 50, now);
  let n = 0;
  for (const f of due) {
    if (enqueueFetch(ctx.dbh.db, f.id) !== null) n++;
  }
  return n;
}

// ── 形状转换 ───────────────────────────────────────────────

interface ShapedFeed {
  id: string;
  url: string;
  title: string | null;
  siteUrl: string | null;
  iconUrl: string | null;
  status: FeedStatus;
  fetchInterval: number;
  lastFetchedAt: number | null;
  nextFetchAt: number | null;
  errorCount: number;
  unread: number;
  total: number;
}

function shapeFeed(f: FeedRow & { unread?: number; total?: number }): ShapedFeed {
  return {
    id: f.id,
    url: f.url,
    title: f.title,
    siteUrl: f.site_url,
    iconUrl: f.icon_url,
    status: f.status,
    fetchInterval: Number(f.fetch_interval),
    lastFetchedAt: f.last_fetched_at,
    nextFetchAt: f.next_fetch_at,
    errorCount: Number(f.error_count),
    unread: Number(f.unread ?? 0),
    total: Number(f.total ?? 0),
  };
}

/**
 * 用户输入的 URL 规范化。
 *
 * 三件常犯的错都要兜：
 *   · 只写域名（example.com/feed）→ 补 https://
 *   · 带空格或换行（从别处粘贴）
 *   · 是 feed:// 协议（有的阅读器导出这个）
 */
export function normalizeInputUrl(raw: string | undefined | null): string | null {
  let s = (raw ?? '').trim();
  if (!s) return null;
  // 从粘进来的整段文字里取出第一个 URL
  const m = /(https?:\/\/[^\s<>"']+)/i.exec(s);
  if (m) {
    s = m[1]!;
  } else if (/^feed:\/\//i.test(s)) {
    s = s.replace(/^feed:\/\//i, 'https://');
  } else if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) {
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

void conflict;
void sanitizeHtml;
