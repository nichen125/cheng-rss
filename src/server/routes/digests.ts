import { Hono } from 'hono';
import { z } from 'zod';
import type {
  DigestCluster, DigestDetail, DigestListResponse, DigestSummary, DigestWorthReading,
} from '../../shared/dto.ts';
import type { AppContext, Variables } from '../app.ts';
import { requireUserId } from '../auth/require-user.ts';
import { notFound } from '../errors.ts';
import { readBody } from '../http/validate.ts';

// `force` 的语义是"忽略今日已生成的判断"，只接受真正的布尔值：
// 旧代码 `Boolean(body.force)` 会把字符串 "false" 当成 true，
// 那等于用户明确说"别重跑"却重跑了一遍、多花一份钱。
const digestRunBody = z.object({ force: z.boolean().nullish() });

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
             model, cost_usd, delivered_at, created_at, day_key, cites
        FROM digests WHERE user_id = ?
        ORDER BY day_key DESC, created_at DESC LIMIT ?
    `).all(uid, limit) as Record<string, unknown>[];

    // 标注成 DigestSummary[]：列表是详情页左栏的唯一数据源，
    // 字段少一个（比如 citeCount）编译器当场报错，而不是等页面少显示一行。
    const items: DigestSummary[] = rows.map((x) => ({
      id: String(x.id),
      title: String(x.title),
      intro: String(x.intro ?? '').split('\n').filter(Boolean),
      // 四列在 0001_init.sql 里都是可空（INTEGER 没加 NOT NULL），
      // 但每一行都由 saveDigest 写入、实际都有值。DTO 要求 number，
      // 客户端也是直接拼文案（`${d.entryCount} 篇`）——
      // 这里 null → 0，宁可显示"0 篇"，也不要把 null 印到页面上。
      periodStart: Number(x.period_start),
      periodEnd: Number(x.period_end),
      dayKey: numOrNull(x.day_key),
      entryCount: Number(x.entry_count ?? 0),
      clusterCount: Number(x.cluster_count ?? 0),
      model: strOrNull(x.model),
      costUsd: numOrNull(x.cost_usd),
      deliveredAt: numOrNull(x.delivered_at),
      createdAt: Number(x.created_at),
      citeCount: parseJsonArray<unknown>(x.cites).length,
    }));

    const body: DigestListResponse = { items };
    return c.json(body);
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
    const { latestRun, viewOf } = await import('../digest/runs.ts');
    const row = ctx.dbh.db.prepare('SELECT digest_config FROM settings WHERE user_id = ?')
      .get(uid) as { digest_config: string } | undefined;
    let raw: unknown = null;
    try { raw = row?.digest_config ? JSON.parse(row.digest_config) : null; } catch { /* 坏配置用默认 */ }
    return c.json({
      ...digestStatus(ctx.dbh.db, uid, parseDigestConfig(raw)),
      // 进度挂在状态上而不是单独一个接口：前端本来就在轮询它。
      // 多一个真相源就多一处会不同步的地方 —— "状态说在跑、进度说没跑"
      // 那种自相矛盾，用户无法判断该信哪个。
      run: viewOf(latestRun(ctx.dbh.db, uid)),
    });
  });

  /**
   * 停止正在生成的那一次。
   *
   * 返回的语义是**「已经请求停止」**，不是「已经停止」：在飞的那次模型
   * 调用要等它自己被 abort（最多一秒的轮询间隔 + 一次网络收尾）。
   * 前端据此显示"正在停止…"，然后继续轮询状态直到 status 变成 cancelled。
   *
   * 为什么不做成同步等待到停下：那会让这个请求同样挂几分钟，而用户点
   * "停止"时最不想看到的就是又一个转不完的圈。
   */
  r.post('/digests/runs/:id/stop', async (c) => {
    const uid = requireUserId(c);
    const { getRun, requestCancel } = await import('../digest/runs.ts');
    const runId = c.req.param('id');
    const row = getRun(ctx.dbh.db, runId);
    // 不属于这个用户的 run 一律按"不存在"处理，不泄露别人有没有在跑
    if (!row || row.user_id !== uid) throw notFound('没有这次生成');

    const res = requestCancel(ctx.dbh.db, runId);
    return c.json({
      ok: res.ok,
      status: res.status,
      // cancelled = 还没开始就停掉了（不用再等）；requested = 已在跑，等它收尾
      cancelled: res.cancelled,
      requested: res.requested,
      message: res.cancelled
        ? '已停止（还没开始，直接作废）'
        : res.requested ? '已请求停止，正在收尾' : '这次生成已经结束，无需停止',
    });
  });

  r.get('/digests/:id', (c) => {
    const uid = requireUserId(c);
    const row = ctx.dbh.db.prepare(
      'SELECT * FROM digests WHERE id = ? AND user_id = ?',
    ).get(c.req.param('id'), uid) as Record<string, unknown> | undefined;
    if (!row) throw notFound('简报不存在');

    // 简报引用的簇：正文里只有 [1] [2] 这样的脚注号，用户点开要能看到
    // "第 1 条对应哪件事、那件事有几篇报道、各方说法是否一致"。
    //
    // 引用表**从 cites 列读**，不从正文反查：body_md 落库前
    // renderCitations 已经把 {{cite:cl_x}} 换成了 [1]，簇 id 不在里面。
    // 3.5 之前这里是正则反查，永远匹配不到，clusters 恒为空 ——
    // 接口 200、页面不报错，只是 [1] 点了没反应。
    const cites = parseJsonArray<{ index: number; id: string; title: string }>(row.cites);
    // worth_reading 的 id 通常**不在**引用表里（"低热度"就意味着正文没提它），
    // 所以要一起查，否则标题会退化成裸 id。
    const wrIds = parseJsonArray<string>(row.worth_reading);
    const ids = [...new Set([...cites.map((x) => x.id), ...wrIds])];

    // 一次查完，再按 cites 的顺序重排 ——
    // SQL 的 IN 不保证顺序，而脚注号必须与正文的 [1][2][3] 对齐。
    const byId = new Map<string, Record<string, unknown>>();
    if (ids.length > 0) {
      const rows = ctx.dbh.db.prepare(`
        SELECT id, title, summary, key_points, consensus, conflicts,
               entry_count, source_count, heat
          FROM clusters WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})
      `).all(uid, ...ids) as Record<string, unknown>[];
      for (const r of rows) byId.set(String(r.id), r);
    }

    // 簇被整窗重算清掉后，cites 里仍有标题（saveDigest 时存了快照）——
    // 这时给一条只有标题的条目，脚注不会变成空号。
    //
    // entry_count / source_count / heat 走 numOrNull（而不是把 unknown 直接
    // 塞进去）：DTO 里这三列是 `number | null`，簇表虽然 NOT NULL DEFAULT 0，
    // 但"缺详细数据"那条分支本来就给 null，两边都得收敛到同一形状。
    const clusters: DigestCluster[] = cites.map((x) => {
      const row2 = byId.get(x.id);
      if (!row2) {
        return {
          id: x.id, index: x.index, title: x.title, summary: null,
          keyPoints: [], consensus: [], conflicts: [],
          entry_count: null, source_count: null, heat: null, missing: true,
        };
      }
      return {
        id: x.id,
        index: x.index,
        title: String(row2.title ?? x.title),
        summary: row2.summary === null ? null : String(row2.summary),
        keyPoints: parseJsonArray<string>(row2.key_points),
        // conflicts 有两种历史形状：字符串数组，或 {claim, sources} 对象数组
        consensus: parseJsonArray<string>(row2.consensus),
        conflicts: parseJsonArray<{ claim: string; sources: string[] }>(row2.conflicts),
        entry_count: numOrNull(row2.entry_count),
        source_count: numOrNull(row2.source_count),
        heat: numOrNull(row2.heat),
        missing: false,
      };
    });

    // 「值得一读」：模型给的是 id，要换成标题才可读
    const wr: DigestWorthReading[] = wrIds.map((id) => {
      const hit = byId.get(id) ?? null;
      const cite = cites.find((x) => x.id === id);
      return {
        id,
        title: hit ? String(hit.title) : (cite?.title ?? id),
        summary: hit && hit.summary !== null ? String(hit.summary) : null,
        entryCount: numOrNull(hit?.entry_count),
        sourceCount: numOrNull(hit?.source_count),
        heat: numOrNull(hit?.heat),
      };
    });

    // 详情 = 摘要字段的超集 + 正文 + 引用簇 + 值得一读。
    //
    // 标上 DigestDetail 后第一次跑就报错：shape() 把 `row.body_md` 原样
    // 塞出来，驱动给的是 unknown，而契约要求 bodyMd: string。
    // 换句话说，之前那些 `x.id` / `x.entry_count` 之类的裸列值没有任何
    // 收敛，注解一加才暴露出来 —— 修法见文件末尾的 shape()。
    const body: DigestDetail = { ...shape(row), clusters, worthReading: wr };
    return c.json(body);
  });

  /**
   * 手动生成。**202 + 立即返回**，不再等那 8~9 分钟。
   *
   * 之前的实现是全同步：`await runDigest(...)` 之后才响应，于是前端点了
   * 「现在生成」就盯着一个 disabled 按钮直到整条链跑完（实测 528 秒）。
   * 浏览器不会超时，用户只能刷新页面 —— 而刷新之后连"还在跑"都看不到。
   *
   * 现在返回的是一个 runId，进度与结果都从 `GET /digests/status` 的 `run`
   * 字段读。202 而不是 200：语义确实是"已受理，尚未完成"，这是让客户端
   * （以及将来的任何调用方）不用猜"这个 200 到底是跑完了还是刚开始"。
   *
   * 已经有一次在跑时**不新建**，把那一次的 runId 交回去（queued:false）：
   * 用户连点两下按钮不该花两份钱，而"等它这次跑完"才是他真正想要的。
   */
  r.post('/digests/run', async (c) => {
    const uid = requireUserId(c);
    const body = await readBody(c, digestRunBody);
    const { liveRun, createRun, setRunJob } = await import('../digest/runs.ts');
    const { digestStatus, parseDigestConfig, localDayStart } = await import('../digest/schedule.ts');
    const { enqueue } = await import('../jobs/queue.ts');

    const db = ctx.dbh.db;
    const existing = liveRun(db, uid);
    if (existing) {
      return c.json({
        ok: true,
        queued: false,
        runId: existing.id,
        status: existing.status,
        message: existing.status === 'queued'
          ? '已经在排队，稍后自动开始'
          : '已经有一次正在生成',
      }, 202);
    }

    const cfgRow = db.prepare('SELECT digest_config FROM settings WHERE user_id = ?')
      .get(uid) as { digest_config: string } | undefined;
    let raw: unknown = null;
    try { raw = cfgRow?.digest_config ? JSON.parse(cfgRow.digest_config) : null; } catch { /* 坏配置用默认 */ }
    const cfg = parseDigestConfig(raw);

    const run = createRun(db, { userId: uid, manual: true });

    // dedupeKey 用 runId：同一用户同一天可以手动跑多次（每次都是新的 run），
    // 而"同一 run 不重复入队"仍要成立 —— 用 dayKey 做键会把第二次手动跑
    // 吞掉，症状是"点了没反应，但上一次的结果出现了"。
    // enqueue 返回的是 job **id**（不是行对象）；null 表示去重命中，
    // 而这里的 dedupeKey 带 runId，不可能命中已存在的那条。
    const jobId = enqueue(db, {
      kind: 'digest',
      payload: {
        userId: uid, kind: cfg.kind, manual: true,
        allowSingle: Boolean(body.force), runId: run.id,
      },
      dedupeKey: `digest-run:${run.id}`,
      priority: 1,
      maxAttempts: 1,
    });
    setRunJob(db, run.id, jobId);

    // 没有 worker（纯 API 进程）时任务会一直 pending。那种部署下
    // 把 run 留在 queued 是诚实的 —— 但至少要让用户知道它不会自己动。
    const st = digestStatus(db, uid, cfg);
    return c.json({
      ok: true,
      queued: true,
      runId: run.id,
      status: run.status,
      dayKey: localDayStart(Date.now()),
      // 复用现有的"为什么今天可能不出"逻辑，前端不必自己推
      hint: st.state === 'skipped' ? st.skipReason : null,
    }, 202);
  });

  return r;
}

/**
 * 解析存成 JSON 的列。
 *
 * 坏数据一律当空数组：简报页读不出来时应该是"这一块没有内容"，
 * 而不是整页 500。这些列都是我们自己写的，出现坏值说明迁移或手工改库
 * 出了问题 —— 那时用户更需要能打开简报看正文。
 */
function parseJsonArray<T>(raw: unknown): T[] {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * 一行 digests 记录 → 对外形状：摘要字段 + 正文。
 *
 * 返回值刻意标成 `DigestSummary & { bodyMd: string }` 而不是笼统对象：
 * - `GET /digests/:id` 要 `DigestDetail`，它继承 DigestSummary 且多一个 bodyMd，
 *   展开这个类型正好凑齐，编译器会核对摘要那一半；
 * - 列表端点不要 bodyMd（正文是几十 KB，列表只画日期与条数），所以列表
 *   自己 map 一遍而不是复用这里。
 */
function shape(row: Record<string, unknown>): DigestSummary & { bodyMd: string } {
  return {
    id: String(row.id),
    title: String(row.title),
    intro: String(row.intro ?? '').split('\n').filter(Boolean),
    bodyMd: String(row.body_md ?? ''),
    periodStart: Number(row.period_start),
    periodEnd: Number(row.period_end),
    dayKey: numOrNull(row.day_key),
    entryCount: Number(row.entry_count ?? 0),
    clusterCount: Number(row.cluster_count ?? 0),
    model: strOrNull(row.model),
    costUsd: numOrNull(row.cost_usd),
    deliveredAt: numOrNull(row.delivered_at),
    createdAt: Number(row.created_at),
    // 引用条数：页面上"3 个事件"这类概括文案要用，不必先拉全量详情
    citeCount: parseJsonArray<unknown>(row.cites).length,
  };
}

/** SQL 行里"可能是 null 的字符串" → `string | null`（null 不能变成 "null"） */
function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return Number(v);
}
