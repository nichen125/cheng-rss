import { Hono } from 'hono';
import type { AppContext, Variables } from '../app.ts';
import { badRequest, notFound } from '../errors.ts';
import { requireUserId } from '../auth/require-user.ts';
import { searchKeyword, searchLike } from '../search/index.ts';
import { queueStats } from '../jobs/queue.ts';
import { unpackText } from '../db/text-blob.ts';
import { sanitizeHtml } from '../feeds/sanitize.ts';
import { duplicateStats } from '../dedupe/index.ts';
import { groupByDay } from '../entries/history.ts';

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

    // 按订阅源 / 分组过滤（侧栏点分组时用）。
    // 与 view 是并列条件：既能"只看这个组的未读"，也能"只看这个源的全部"。
    const feedId = c.req.query('feedId');
    const folderId = c.req.query('folderId');

    const where: string[] = ['e.user_id = ?'];
    const params: (string | number)[] = [uid];

    // 重复条目不进时间线（PLAN §7.1 L2）。
    //
    // 判重命中时条目照样入库（写 duplicate_of 指回原件），所以"这篇文章
    // 被几个源报道"是可查的。但把它摆进列表就是给用户看两遍同一篇 ——
    // 这正是去重要解决的问题本身。
    //
    // 例外两处：
    //   · view=starred / history：用户明确标记过的，藏起来会更困惑
    //   · ?includeDuplicates=1：排查"为什么这条没显示"时的出口
    const includeDuplicates = c.req.query('includeDuplicates') === '1';
    if (!includeDuplicates && view !== 'starred' && view !== 'history') {
      where.push('e.duplicate_of IS NULL');
    }

    if (view === 'unread') where.push('e.is_read = 0');
    else if (view === 'read') {
      // 「已读」是 v1.18 给列表底部分割线用的（§15.24）。
      // 与 history 的区别：history 要求 last_read_at IS NOT NULL，只认
      // "真的读过"的；read 只认 is_read = 1 —— 包括被「清除分组未读」
      // 批量标记的那些（那个接口刻意不写阅读历史，见下文注释）。
      // 分割线要补的是"这个范围里剩下的条目"，它必须和「全部」视图里
      // 扣除未读之后的那批**完全一致**，否则会出现"全部里看得到、
      // 分割线下看不到"的条目。
      where.push('e.is_read = 1');
      where.push('e.is_hidden = 0');
    }
    else if (view === 'starred') where.push('e.is_starred = 1');
    else if (view === 'history') where.push('e.last_read_at IS NOT NULL');
    else where.push('e.is_hidden = 0');

    if (feedId) {
      where.push('e.feed_id = ?');
      params.push(feedId);
    }
    if (folderId === 'none') {
      // 未分组 = feed 属于没有 folder 的源，或来自网页捕获（feed_id 为 NULL）
      where.push(
        '(e.feed_id IS NULL OR e.feed_id IN (SELECT id FROM feeds WHERE user_id = ? AND folder_id IS NULL))',
      );
      params.push(uid);
    } else if (folderId) {
      where.push(
        'e.feed_id IN (SELECT id FROM feeds WHERE user_id = ? AND folder_id = ?)',
      );
      params.push(uid, folderId);
    }

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

    // 排序键必须在游标比较之前确定：历史视图按 last_read_at 排，
    // 若游标仍拿 published_at 比，翻页会在"发布时间最新但读得最早"的
    // 那几条上原地打转（或跳过大段）。
    const orderCol = view === 'history' ? 'e.last_read_at' : 'e.published_at';

    // 先把"不含游标"的条件存一份，供 total 使用。
    // 带游标算 total 的话，翻页时标题行的数字会一路缩小（30 → 20 → 10），
    // 用户会以为数据在丢 —— 它其实只是"这条游标之后还剩多少"。
    const baseWhere = [...where];
    const baseParams = [...params];

    if (cursor) {
      // 游标格式 `<时间戳>_<id>`，而 id 本身形如 `e_1a2b3c…`（含下划线）。
      //
      // 这里必须**只按第一个下划线切**。早先写的是 `cursor.split('_')`
      // 再取 `[1]`，拿到的是 `'e'` —— 于是同一毫秒的条目全部被判为
      // "id 不小于游标"，翻页时那一批被整段跳过（且悄无声息）。
      // 只在"同一毫秒多于 limit 条"时才复现，所以一直没被发现。
      const sep = cursor.indexOf('_');
      const pubStr = sep < 0 ? cursor : cursor.slice(0, sep);
      const idStr = sep < 0 ? '' : cursor.slice(sep + 1);
      const pub = Number(pubStr);
      if (Number.isFinite(pub)) {
        // 严格小于游标位置；同毫秒用 id 打破平局
        where.push(`(${orderCol} < ? OR (${orderCol} = ? AND e.id < ?))`);
        params.push(pub, pub, idStr);
      }
    }

    const sql = `
      SELECT e.id, e.title, e.url, e.author, ${orderCol} AS sort_at,
             e.published_at AS published_at, e.excerpt, e.is_read, e.is_starred,
             e.highlight_count, e.site_name, e.read_count, e.last_read_at,
             e.favicon_url, e.thumbnail_url, e.word_count,
             e.feed_id AS feed_id, fd.title AS feed_title,
             a.summary AS summary, a.tier AS tier
        FROM entries e
        LEFT JOIN entry_analysis a ON a.entry_id = e.id
        LEFT JOIN feeds fd ON fd.id = e.feed_id
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
      // 网页捕获的条目没有源，这两个字段为 null
      feedId: row.feed_id ?? null,
      feedTitle: row.feed_title ?? null,
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
      `SELECT COUNT(*) AS c FROM entries e WHERE ${baseWhere.join(' AND ')}`,
    ).get(...baseParams) as { c: number };

    return c.json({ items, total: Number(totalRow.c), nextCursor });
  });

  // ── 阅读历史（按日期分组，PLAN §7.4）───────────────────
  //
  // **必须注册在 `/entries/:id` 之前**。Hono 按注册顺序匹配，若晚一步，
  // `/entries/history` 会被 `:id` 吃掉，把 "history" 当成一个条目 id
  // 去查库，返回 404 —— 而且报错信息（"条目不存在"）完全指不到真正原因。
  r.get('/entries/history', (c) => {
    const uid = requireUserId(c);
    const rawLimit = Number(c.req.query('limit') ?? 60);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 60, 1), 200);
    const cursor = c.req.query('cursor') ?? null;

    const where: string[] = ['e.user_id = ?', 'e.last_read_at IS NOT NULL'];
    const params: (string | number)[] = [uid];
    // total 用**不含游标**的条件算（见下方注释），所以先把基础条件存一份
    const baseWhere = [...where];
    const baseParams = [...params];

    // 历史只看"读过的"，与 inbox 的 is_hidden 无关：
    // 隐藏一条未读是为了不看它，不代表"我读过它"该从历史里消失。
    if (cursor) {
      const sep = cursor.indexOf('_');
      const atStr = sep < 0 ? cursor : cursor.slice(0, sep);
      const idStr = sep < 0 ? '' : cursor.slice(sep + 1);
      const at = Number(atStr);
      if (Number.isFinite(at)) {
        where.push('(e.last_read_at < ? OR (e.last_read_at = ? AND e.id < ?))');
        params.push(at, at, idStr);
      }
    }

    const rows = ctx.dbh.db.prepare(`
      SELECT e.id, e.title, e.url, e.author, e.published_at, e.last_read_at,
             e.first_read_at, e.read_count, e.read_progress, e.is_read, e.is_starred,
             e.excerpt, e.site_name, e.favicon_url, e.word_count,
             e.feed_id AS feed_id, fd.title AS feed_title,
             a.summary AS summary, a.tier AS tier
        FROM entries e
        LEFT JOIN entry_analysis a ON a.entry_id = e.id
        LEFT JOIN feeds fd ON fd.id = e.feed_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.last_read_at DESC, e.id DESC
       LIMIT ?
    `).all(...params, limit + 1) as Record<string, unknown>[];

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const items = page.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      author: row.author,
      publishedAt: Number(row.published_at),
      // readAt 与 publishedAt 分开给：历史页的时间轴用 readAt，
      // 而卡片上仍要显示"原文发表于何时"。混成一个字段就没法区分了。
      readAt: Number(row.last_read_at),
      firstReadAt: row.first_read_at === null ? null : Number(row.first_read_at),
      readCount: Number(row.read_count ?? 0),
      readProgress: row.read_progress === null ? null : Number(row.read_progress),
      isRead: Boolean(row.is_read),
      isStarred: Boolean(row.is_starred),
      excerpt: row.excerpt,
      siteName: row.site_name,
      summary: row.summary,
      tier: row.tier,
      faviconUrl: row.favicon_url,
      wordCount: row.word_count === null ? null : Number(row.word_count),
      feedId: row.feed_id ?? null,
      feedTitle: row.feed_title ?? null,
    }));

    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? `${Number(last.last_read_at)}_${String(last.id)}`
      : null;

    // total 用**不含游标**的条件算：带了游标就只剩"这页之后还有几条"，
    // 标题行显示的数字会在翻页时一路缩小 —— 看着像数据丢了。
    const totalRow = ctx.dbh.db.prepare(
      `SELECT COUNT(*) AS c FROM entries e WHERE ${baseWhere.join(' AND ')}`,
    ).get(...baseParams) as { c: number };

    return c.json({
      groups: groupByDay(items, (x) => x.readAt),
      count: items.length,
      total: Number(totalRow.c),
      nextCursor,
    });
  });

  // ── 详情 ────────────────────────────────────────────────
  r.get('/entries/:id', (c) => {
    const uid = requireUserId(c);
    const id = c.req.param('id');

    const row = ctx.dbh.db.prepare(`
      SELECT e.*, a.summary, a.key_points, a.topics, a.importance, a.tier, a.reading_time,
             fd.site_url AS feed_site_url, fd.title AS feed_title
        FROM entries e
        LEFT JOIN entry_analysis a ON a.entry_id = e.id
        LEFT JOIN feeds fd ON fd.id = e.feed_id
       WHERE e.id = ? AND e.user_id = ?
    `).get(id, uid) as Record<string, unknown> | undefined;

    if (!row) throw notFound('条目不存在');

    // 正文是 gzip BLOB，解压后给前端
    let html: string | null = null;
    const content = ctx.dbh.db.prepare('SELECT html FROM entry_contents WHERE entry_id = ?')
      .get(id) as { html: Uint8Array | null } | undefined;
    if (content?.html) {
      // 读时再洗一次：写入侧已清（feeds/store.ts），但历史数据可能来自
      // 早期版本或插件导入路径，不能假设它已经干净。
      html = sanitizeHtml(unpackText(content.html), { baseUrl: String(row.url) }).html;
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
      // 源站首页（feed 的 site_url），用于阅读页的"去源站"出口（§15.11）。
      // 网页捕获的条目没有 feed，这里是 null，前端据此不渲染入口。
      feedSiteUrl: row.feed_site_url ?? null,
      feedTitle: row.feed_title ?? null,
      // v1.17：阅读时要把"这篇所属的源/分组"的未读数就地减一（§15.14 修订），
      // 详情接口就得说清它属于谁。列表接口早就有这个字段（列表行要知道源名），
      // 详情此前只有 feedTitle —— 靠标题反查源 id 在改名或重名时会错。
      feedId: row.feed_id ?? null,
      highlightCount: Number(row.highlight_count ?? 0),
      // 阅读历史三件套：读过几次 / 第一次读 / 读了多少
      readCount: Number(row.read_count ?? 0),
      firstReadAt: row.first_read_at === null ? null : Number(row.first_read_at),
      lastReadAt: row.last_read_at === null ? null : Number(row.last_read_at),
      readProgress: row.read_progress === null ? null : Number(row.read_progress),
      contentHtml: html,
      contentMarkdown: null,
      analysis,
    });
  });

  // ── 把一个范围内的未读全部标为已读（§15.21，v1.17）──
  //
  // 范围只接受分组或源，不接受"全库"：需求方明确只要求 ① 按分组
  // ② 按单个订阅。留一个不带范围的入口等于给产品开一个"一键把整个库
  // 读光"的按钮 —— 那个操作的代价（所有未读消失）和它的收益（省几十次
  // 点击）完全不成比例。
  //
  // 语义上刻意**不写阅读历史**：`first_read_at` / `last_read_at` /
  // `read_count` 一概不动，只把 `is_read` 置 1。
  //
  // 理由是这个动作的真实含义是"这些我不打算看了"，不是"我读过了"。
  // 若在这里补 `last_read_at = now`，「历史」页会凭空多出 200 条我从未
  // 打开过的文章，且每条都带"今天读过"的时间戳 —— 那是在伪造阅读记录。
  // 与 POST /entries/read 的区别正在此：那个是"我真的打开了"，
  // 这个是"我不想看见它了"。
  r.post('/entries/mark-all-read', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as {
      feedId?: string | null;
      folderId?: string | null;
    };
    const feedId = typeof body.feedId === 'string' && body.feedId ? body.feedId : null;
    const folderId = typeof body.folderId === 'string' && body.folderId ? body.folderId : null;
    if (!feedId && !folderId) {
      throw badRequest('需要 feedId 或 folderId —— 不支持把整个库一次标为已读');
    }

    const where: string[] = ['e.user_id = ?', 'e.is_read = 0', 'e.duplicate_of IS NULL'];
    const params: (string | number)[] = [uid];
    if (feedId) {
      where.push('e.feed_id = ?');
      params.push(feedId);
    }
    if (folderId === 'none') {
      where.push(
        '(e.feed_id IS NULL OR e.feed_id IN (SELECT id FROM feeds WHERE user_id = ? AND folder_id IS NULL))',
      );
      params.push(uid);
    } else if (folderId) {
      where.push('e.feed_id IN (SELECT id FROM feeds WHERE user_id = ? AND folder_id = ?)');
      params.push(uid, folderId);
    }

    const r = ctx.dbh.db.prepare(
      `UPDATE entries SET is_read = 1 WHERE id IN (
         SELECT e.id FROM entries e WHERE ${where.join(' AND ')}
       )`,
    ).run(...params);

    return c.json({ ok: true, count: Number(r.changes ?? 0) });
  });

  // ── 标记已读（幂等，PLAN §7.4）───────────────────────────
  // ── 手动重跑分析（PLAN §18 / §19.4 2.2）──────────────────
  //
  // 两种语义刻意分开：
  //   POST /entries/:id/analyze                内容没变就跳过（幂等，默认）
  //   POST /entries/:id/analyze {force:true}   强制重算（改了提示词/换了模型）
  //
  // 默认不是 force 的理由：这个接口最常被点到的场景是"我改完提示词，
  // 想把这批重跑一遍"。若默认 force，用户点第二篇时第一篇刚算好的结果
  // 会被同一段正文再算一次 —— 白花一倍的钱，且结果一模一样。
  //
  // 同步返回而不是入队：单篇 2~8 秒，用户点一下等结果比"排队了但不知道
  // 什么时候好"更符合预期。批量重跑将来走队列。
  r.post('/entries/:id/analyze', async (c) => {
    const uid = requireUserId(c);
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as { force?: boolean };

    const row = ctx.dbh.db.prepare('SELECT id FROM entries WHERE id = ? AND user_id = ?')
      .get(id, uid) as { id: string } | undefined;
    if (!row) throw notFound('条目不存在');

    const { aiForUser, runtimeAiBase } = await import('../ai/service.ts');
    const { runAnalyze } = await import('../ai/analyze.ts');
    const { client } = aiForUser(ctx.dbh.db, uid, runtimeAiBase(ctx.cfg));

    const r = await runAnalyze(ctx.dbh.db, client, id, { force: body.force === true });

    if (!r.ok) {
      // 返 200 而不是 4xx/5xx：调用方（前端）要展示的是"为什么没分析成"，
      // 而错误包装只会留下 message，kind 会丢 —— kind 才是"该去改 key
      // 还是该去换模型"的依据。
      return c.json({
        ok: false,
        skipped: r.skipped,
        failure: r.failure
          ? { kind: r.failure.kind, message: r.failure.message, retryable: r.failure.retryable }
          : null,
      });
    }

    return c.json({ ok: true, skipped: r.skipped, called: r.called, category: r.categorySlug });
  });

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

  // ── 标记未读（§15.11：已读可回退）───────────────────────
  //
  // 为什么必须有反向操作：原来点开一篇就永久变已读，误点之后只能去库里改。
  // 阅读历史字段（first_read_at/last_read_at/read_count）**不清零** ——
  // "读过了"是事实，"不想让它算未读"是视图层的意图，两者不能互相污染。
  // 否则 unread 一次就把阅读历史抹了，「历史」页会凭空少一条。
  r.post('/entries/unread', async (c) => {
    const uid = requireUserId(c);
    const body = await c.req.json().catch(() => ({})) as { ids?: string[] };
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length === 0) throw badRequest('需要 ids');

    const upd = ctx.dbh.db.prepare(
      'UPDATE entries SET is_read = 0 WHERE id = ? AND user_id = ?',
    );
    let changed = 0;
    ctx.dbh.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) changed += Number(upd.run(id, uid).changes ?? 0);
      ctx.dbh.db.exec('COMMIT');
    } catch (e) {
      ctx.dbh.db.exec('ROLLBACK');
      throw e;
    }
    return c.json({ ok: true, count: changed });
  });

  // ── 阅读进度（§15.11）───────────────────────────────────
  //
  // 前端滚动时节流上报（1 次 / 2s），所以这里必须便宜：
  // 一条 UPDATE、不走事务、不改 read_count。
  // 进度只往大里更新（GREATEST 语义）：往回滚不该把"读到 80%"降回 30%。
  r.post('/entries/:id/progress', async (c) => {
    const uid = requireUserId(c);
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as { progress?: number };
    const raw = Number(body.progress);
    if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
      throw badRequest('progress 必须在 0~1 之间');
    }
    const row = ctx.dbh.db.prepare('SELECT read_progress FROM entries WHERE id = ? AND user_id = ?')
      .get(id, uid) as { read_progress: number | null } | undefined;
    if (!row) throw notFound('条目不存在');
    const prev = row.read_progress === null ? 0 : Number(row.read_progress);
    if (raw <= prev) return c.json({ ok: true, progress: prev, changed: false });
    ctx.dbh.db.prepare('UPDATE entries SET read_progress = ? WHERE id = ? AND user_id = ?')
      .run(raw, id, uid);
    return c.json({ ok: true, progress: raw, changed: true });
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
  r.get('/stats', async (c) => {
    const uid = requireUserId(c);
    const one = (sql: string): number => {
      const x = ctx.dbh.db.prepare(sql).get(uid) as { c: number } | undefined;
      return Number(x?.c ?? 0);
    };
    const q = queueStats(ctx.dbh.db);
    const dup = duplicateStats(ctx.dbh.db, uid);

    // AI 段（2.5）：预算档位、今日/本月花费、未配 key 的提示。
    // 放在 /stats 而不是单独的 /ai/status：前端本来每轮列表变化就会取一次
    // /stats，多一个端点等于多一次往返，且两者几乎总是一起看。
    const { aiBudgetFor, runtimeAiBase } = await import('../ai/service.ts');
    const budget = aiBudgetFor(ctx.dbh.db, uid, runtimeAiBase(ctx.cfg));
    const { embedDimensions } = await import('../ai/embed.ts');
    const analyzed = one(
      "SELECT COUNT(*) c FROM entry_analysis a JOIN entries e ON e.id=a.entry_id WHERE e.user_id = ?",
    );
    const failed = one(
      "SELECT COUNT(*) c FROM entries WHERE user_id = ? AND stage = 'failed'",
    );
    const dims = embedDimensions(ctx.dbh.db, uid);

    return c.json({
      entries: one('SELECT COUNT(*) c FROM entries WHERE user_id = ?'),
      feeds: one('SELECT COUNT(*) c FROM feeds WHERE user_id = ?'),
      // 未读/收藏都不计重复条目，与列表可见范围一致
      unread: one('SELECT COUNT(*) c FROM entries WHERE user_id = ? AND is_read = 0 AND duplicate_of IS NULL'),
      starred: one('SELECT COUNT(*) c FROM entries WHERE user_id = ? AND is_starred = 1 AND duplicate_of IS NULL'),
      // 去重效果可观测：重复率是 §19.3 1.15 判据 ③（<1%）的运行时数据来源
      duplicates: { count: dup.duplicates, rate: Number(dup.rate.toFixed(4)) },
      queue: { pending: q.pending, running: q.running, dead: q.dead },
      ai: {
        analyzed,
        failed,
        // 维度分布：换模型后这里会同时出现两种维度，是"该清理旧向量"的信号
        dims,
        ...budget,
      },
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
