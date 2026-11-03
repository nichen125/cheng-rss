import { Hono } from 'hono';
import type { AppContext, Variables } from '../app.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { requireUserId } from '../auth/require-user.ts';
import { log } from '../logger.ts';
import { discoverFeed, fetchFeed, FetchError } from '../feeds/fetch.ts';
import { parseFeed } from '../feeds/parse.ts';
import { buildOpml, parseOpml } from '../feeds/opml.ts';
import {
  assignFeedsToFolder, createFolder, deleteFolder, ensureFolder, folderNameMap,
  FolderError, getFolder, listFolders, renameFolder, reorderFolders,
} from '../feeds/folders.ts';
import { sanitizeHtml } from '../feeds/sanitize.ts';
import {
  BULK_MAX, bulkDelete, bulkMoveToFolder, bulkSetStatus, normalizeIds, splitExisting,
} from '../feeds/bulk.ts';
import {
  createFeed, deleteFeed, dueFeeds, enqueueFetch, findFeedByUrl, getFeed,
  listFeeds, updateFeed, upsertItems, recordFetchError, scheduleNextFetch, arrangeFeeds,
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
    const folderNames = folderNameMap(ctx.dbh.db, uid);
    const items = rows.map((f) => ({
      ...shapeFeed(f),
      folderId: f.folder_id,
      folderName: f.folder_id ? (folderNames.get(f.folder_id) ?? null) : null,
    }));
    // 支持 ?folderId= 过滤（前端按组查看时用）
    const folderId = c.req.query('folderId');
    const filtered = folderId === undefined
      ? items
      : folderId === 'none'
        ? items.filter((f) => !f.folderId)
        : items.filter((f) => f.folderId === folderId);

    return c.json({
      items: filtered,
      total: filtered.length,
      folders: listFolders(ctx.dbh.db, uid),
      /** 各状态的源数，供侧栏与空态使用 */
      counts: {
        active: items.filter((f) => f.status === 'active').length,
        broken: items.filter((f) => f.status === 'broken').length,
        paused: items.filter((f) => f.status === 'paused').length,
        unread: items.reduce((n, f) => n + f.unread, 0),
        unfiled: items.filter((f) => !f.folderId).length,
      },
    });
  });

  // ── 分组 CRUD ───────────────────────────────────────────
  r.get('/folders', (c) => {
    const uid = requireUserId(c);
    return c.json({ items: listFolders(ctx.dbh.db, uid) });
  });

  r.post('/folders', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as { name?: string };
    try {
      const folder = createFolder(ctx.dbh.db, uid, body.name ?? '');
      return c.json({ folder }, 201);
    } catch (e) {
      throw toAppError(e);
    }
  });

  // ⚠️ 路由顺序：`/folders/reorder` 必须排在 `/folders/:id` **之前**。
  // Hono 按注册顺序匹配，反了的话 "reorder" 会被当成分组 id，
  // 接口永远返回 404「分组不存在」。和下面 `/folders/unfile/feeds`、
  // `/feeds/bulk/refresh` 是同一类坑，那几个都还留着注释。
  r.patch('/folders/reorder', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as { ids?: unknown };
    if (!Array.isArray(body.ids)) throw badRequest('需要 ids 数组');
    const ids = body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (ids.length !== body.ids.length) throw badRequest('ids 里只能是分组 id');
    if (ids.length === 0) throw badRequest('ids 不能为空');
    try {
      const items = reorderFolders(ctx.dbh.db, uid, ids);
      return c.json({ items });
    } catch (e) {
      throw toAppError(e);
    }
  });

  r.patch('/folders/:id', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as { name?: string };
    try {
      const folder = renameFolder(ctx.dbh.db, uid, c.req.param('id'), body.name ?? '');
      return c.json({ folder });
    } catch (e) {
      throw toAppError(e);
    }
  });

  r.delete('/folders/:id', (c) => {
    const uid = requireUserId(c);
    const ok = deleteFolder(ctx.dbh.db, uid, c.req.param('id'));
    if (!ok) throw notFound('分组不存在');
    return c.json({ ok: true });
  });

  // ⚠️ 路由顺序：Hono 按注册顺序匹配，静态段必须排在参数段之前。
  // 曾经把 /folders/:id/feeds 写在前面，导致 "unfile" 被当成分组 id，
  // 移出分组的接口永远返回 404「分组不存在」。
  r.post('/folders/unfile/feeds', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as { feedIds?: string[] };
    const ids = Array.isArray(body.feedIds) ? body.feedIds : [];
    if (ids.length === 0) throw badRequest('需要 feedIds');
    const moved = assignFeedsToFolder(ctx.dbh.db, uid, ids, null);
    return c.json({ ok: true, moved });
  });

  // 批量把订阅移进某个分组
  r.post('/folders/:id/feeds', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as { feedIds?: string[] };
    const ids = Array.isArray(body.feedIds) ? body.feedIds : [];
    if (ids.length === 0) throw badRequest('需要 feedIds');
    try {
      const moved = assignFeedsToFolder(ctx.dbh.db, uid, ids, c.req.param('id'));
      return c.json({ ok: true, moved });
    } catch (e) {
      throw toAppError(e);
    }
  });

  // ── 批量操作（§15.10）──────────────────────────────────
  //
  // ⚠️ 路由顺序：`POST /feeds/bulk/refresh` 与 `POST /feeds/:id/refresh`
  // 都是两段路径，注册顺序反了的话 "bulk" 会被当成 feed id，
  // 批量刷新永远返回「订阅不存在」。和之前 `/folders/unfile/feeds`
  // 那个 bug 是同一类 —— 静态段必须排在参数段之前。
  // ⚠️ 请求体只能读一次。所以这个 helper 收的是**已经解析好的 body**，
  // 而不是 Hono 的 context —— 第一版在 helper 里又读了一次 json()，
  // 第二次拿到的是空对象，`folderId` 永远是 null（全部移出分组）。
  const bulkIds = (body: { feedIds?: unknown }): string[] => {
    const ids = normalizeIds(body.feedIds);
    if (ids === null) throw badRequest('需要 feedIds 数组');
    if (ids.length === 0) throw badRequest('feedIds 不能为空');
    if (ids.length > BULK_MAX) throw badRequest(`一次最多 ${BULK_MAX} 个`);
    return ids;
  };

  r.post('/feeds/bulk/folder', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as {
      feedIds?: unknown; folderId?: string | null;
    };
    const ids = bulkIds(body);
    const folderId = body.folderId ?? null;
    if (folderId !== null && !getFolder(ctx.dbh.db, uid, folderId)) {
      throw badRequest('分组不存在');
    }
    return c.json(bulkMoveToFolder(ctx.dbh.db, uid, ids, folderId));
  });

  r.post('/feeds/bulk/status', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as {
      feedIds?: unknown; status?: string;
    };
    const ids = bulkIds(body);
    const status = body.status;
    if (status !== 'active' && status !== 'paused') {
      throw badRequest('status 只能是 active 或 paused');
    }
    return c.json(bulkSetStatus(ctx.dbh.db, uid, ids, status));
  });

  r.post('/feeds/bulk/delete', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as { feedIds?: unknown };
    return c.json(bulkDelete(ctx.dbh.db, uid, bulkIds(body)));
  });

  // `POST /feeds/arrange` 放在参数段之前。
  //
  // 目前**没有** `POST /feeds/:id`（只有 `/feeds/:id/refresh` 和
  // `/feeds/:id/fetch-now`，都是三段路径，不会和这里的二段路径撞），
  // 所以这一条今天不是必需的 —— 但 `/folders/unfile/feeds` 与
  // `/feeds/bulk/refresh` 都是"补一个两段参数路由时才会炸"的类型，
  // 等炸了再查要绕一圈。这里提前排好，以后加 `POST /feeds/:id` 也不会中招。
  //
  // 一个端点覆盖三种动作：组内调序、移入某组、移出到未分组。
  // 语义是「这批源现在归 folderId，顺序就是 ids」—— 见 store.ts 的注释。
  r.post('/feeds/arrange', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as { folderId?: unknown; ids?: unknown };
    if (!Array.isArray(body.ids)) throw badRequest('需要 ids 数组');
    const ids = body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (ids.length !== body.ids.length) throw badRequest('ids 里只能是订阅 id');
    if (ids.length === 0) throw badRequest('ids 不能为空');
    if (ids.length > BULK_MAX) throw badRequest(`一次最多 ${BULK_MAX} 个`);
    // folderId 缺省/ null = 未分组（"移出分组"不是另一个接口）
    const raw = body.folderId;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      throw badRequest('folderId 只能是字符串或 null');
    }
    try {
      const moved = arrangeFeeds(ctx.dbh.db, uid, (raw as string | null | undefined) ?? null, ids);
      return c.json({ ok: true, moved });
    } catch (e) {
      if (e instanceof Error && e.message === 'NOT_FOUND_FOLDER') throw notFound('分组不存在');
      if (e instanceof Error && e.message === 'NOT_FOUND_FEED') throw notFound('订阅不存在');
      if (e instanceof Error && e.message === 'DUPLICATE_FEED') throw badRequest('同一个订阅出现了两次');
      throw e;
    }
  });

  r.post('/feeds/bulk/refresh', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as { feedIds?: unknown };
    const ids = bulkIds(body);
    const { existing, missing } = splitExisting(ctx.dbh.db, uid, ids);
    let done = 0;
    let skipped = 0;
    for (const id of existing) {
      const f = getFeed(ctx.dbh.db, uid, id);
      // 暂停的源刷新会立刻又被 scheduleNextFetch 推远，等于假装刷了
      if (!f || f.status === 'paused') { skipped++; continue; }
      if (enqueueFetch(ctx.dbh.db, id, 100) !== null) done++;
      else skipped++;
    }
    return c.json({ requested: ids.length, done, skipped, missing });
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

  // ── 编辑（标题 / 分组 / 抓取间隔，一次改完）──────────────
  //
  // PATCH /feeds/:id 已经能改这些，为什么还要单独一个？
  // 因为它接受的字段太宽（status 也在里面），而"编辑弹窗"只应该
  // 改这三项。分开端点让前端的保存按钮语义明确，也让权限/审计
  // 更细（将来多用户时"改订阅信息"与"暂停抓取"可能是不同角色）。
  r.put('/feeds/:id', async (c) => {
    const uid = requireUserId(c);
    const id = c.req.param('id');
    const cur = getFeed(ctx.dbh.db, uid, id);
    if (!cur) throw notFound('订阅不存在');

    const body = await c.req.json().catch(() => ({})) as {
      title?: string | null;
      folderId?: string | null;
      fetchInterval?: number;
    };

    if (body.folderId !== undefined && body.folderId !== null) {
      if (!getFolder(ctx.dbh.db, uid, body.folderId)) throw badRequest('分组不存在');
    }

    const patch: Parameters<typeof updateFeed>[3] = {};
    if (body.title !== undefined) {
      const t = (body.title ?? '').trim();
      // 清空标题是合法的：列表会退回显示域名
      patch.title = t || null;
    }
    if (body.folderId !== undefined) patch.folderId = body.folderId;
    if (body.fetchInterval !== undefined) {
      const n = Number(body.fetchInterval);
      if (!Number.isFinite(n) || n < 300) throw badRequest('抓取间隔最小 300 秒');
      if (n > 86400 * 7) throw badRequest('抓取间隔最大 7 天');
      patch.fetchInterval = Math.round(n);
    }

    const updated = updateFeed(ctx.dbh.db, uid, id, patch);
    if (!updated) throw notFound('订阅不存在');
    const names = folderNameMap(ctx.dbh.db, uid);
    return c.json({
      feed: {
        ...shapeFeed({ ...updated, unread: 0, total: 0 }),
        folderId: updated.folder_id,
        folderName: updated.folder_id ? (names.get(updated.folder_id) ?? null) : null,
      },
    });
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

  // ── 复活所有「失效」源并立刻重抓（§15.23，v1.17）──────
  //
  // broken 是终态：sweep 只挑 active，所以一个被误判的源会永远停在
  // 「失效」，除非用户手动挨个点重试。v1.17 修了误判的来源
  // （瞬时失败不再置 broken，见 store.ts），但**已经坏掉的那批还躺在库里** ——
  // 修判据不会回头改数据，就像修 pending 那批要补录任务一样。
  //
  // 所以这里提供一个批量复活：status 改回 active、error_count 归零、
  // next_fetch_at 立刻到期，然后入队。
  //
  // 为什么不自动定期跑：复活的代价是一次抓取。对真的死掉的源
  // （域名没了）每小时试一次毫无意义，而它对用户可见的成本是
  // 日志里一排失败。让用户按一次按钮，比让服务自己猜要诚实。
  r.post('/feeds/retry-broken', (c) => {
    const uid = requireUserId(c);
    const rows = listFeeds(ctx.dbh.db, uid).filter((f) => f.status === 'broken');
    const now = Date.now();
    const upd = ctx.dbh.db.prepare(
      `UPDATE feeds SET status = 'active', error_count = 0, next_fetch_at = ?
        WHERE id = ? AND user_id = ? AND status = 'broken'`,
    );
    let revived = 0;
    let queued = 0;
    ctx.dbh.db.exec('BEGIN IMMEDIATE');
    try {
      for (const f of rows) {
        revived += Number(upd.run(now, f.id, uid).changes ?? 0);
        if (enqueueFetch(ctx.dbh.db, f.id, 100) !== null) queued++;
      }
      ctx.dbh.db.exec('COMMIT');
    } catch (e) {
      ctx.dbh.db.exec('ROLLBACK');
      throw e;
    }
    return c.json({ ok: true, revived, queued, total: rows.length });
  });

  // ── OPML ────────────────────────────────────────────────
  r.get('/feeds/export', (c) => {
    const uid = requireUserId(c);
    const rows = listFeeds(ctx.dbh.db, uid);
    const names = folderNameMap(ctx.dbh.db, uid);
    const xml = buildOpml(rows.map((f) => ({
      url: f.url,
      title: f.title,
      siteUrl: f.site_url,
      // 分组一起导出 —— 换到别的阅读器后分组还得在，
      // 否则"搬家"等于把所有整理工作重做一遍。
      folder: f.folder_id ? (names.get(f.folder_id) ?? null) : null,
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
        // 分组：按名字复用，不存在就建。重名不报错 ——
        // OPML 里两个文件夹同名是很常见的（不同导出工具的处理不同）。
        const folderId = ensureFolder(ctx.dbh.db, uid, f.folder);

        const feed = createFeed(ctx.dbh.db, {
          userId: uid,
          url: res.finalUrl,
          title: pf.title ?? f.title,
          siteUrl: pf.siteUrl ?? f.siteUrl,
          iconUrl: pf.iconUrl,
          folderId,
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
  /** 组内顺序（§15.28）。前端排序要用，缺了它所有并列项会退回标题序 */
  sort: number;
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
    sort: Number(f.sort ?? 0),
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

/**
 * FolderError → AppError。
 *
 * 必须做这层映射：直接 throw 会让 onError 走 500 分支，
 * 而"分组重名"是用户能修正的输入问题，应该是 400。
 */
function toAppError(e: unknown): unknown {
  if (e instanceof FolderError) {
    if (e.code === 'NOT_FOUND') return notFound(e.message);
    return badRequest(e.message);
  }
  return e;
}

void conflict;
void sanitizeHtml;
