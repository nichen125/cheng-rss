import type { DatabaseSync } from 'node:sqlite';
import type { JobHandler } from './runner.ts';
import { getFeed } from '../feeds/store.ts';
import { enqueue } from './queue.ts';
import { shouldLog } from '../ai/notice.ts';
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

  // ── 正文提取（PLAN §7.5）────────────────────────────────
  //
  // 失败一律在本函数内吃掉：extract 只有 4 个并发槽位，
  // 一个 404 的原文重试 3 次就是 3 次白占槽位，而用户已经有 feed 正文可读。
  // 失败原因写进 entries.stage_error，条目照常推进到 extracted。
  handlers['extract'] = async (job, db: DatabaseSync) => {
    const p = safeParse(job.payload);
    const entryId = String(p.entryId ?? '');
    if (!entryId) throw new Error('extract 缺少 entryId');

    const { runExtract } = await import('../extract/run.ts');
    const r = await runExtract(db, entryId);
    ctx.log?.(`extract 完成`, {
      entryId, replaced: r.replaced, skipped: r.skipped,
      failure: r.failure ?? undefined,
    });

    // 提取完立刻把分析排上（PLAN §7.1：L1 产出 → L3 消费）。
    //
    // 为什么在这里排而不是在 upsertItems 里同时排两个任务：
    // 摘要型源的条目入库时正文只有几十个字，那个状态下分析出来的摘要
    // 是照着导语编的。等提取落定再排，模型看到的就是最终正文。
    // feed 自带全文的条目根本不会走到这里（它们在入库时就是 extracted），
    // 那条路径由 upsertItems 直接排。
    enqueue(db, {
      kind: 'analyze',
      payload: { entryId },
      dedupeKey: `analyze:${entryId}`,
    });
  };

  // ── 单篇分析（PLAN §8 / §19.4 2.2）──────────────────────
  //
  // 与 extract 的分工相同：这里只做调度与记账，真正的模型调用在
  // ai/analyze.ts 里，验收脚本因此可以单独测它而不启动 HTTP 服务。
  //
  // 失败**抛错**而不是在内部吃掉 —— 与 extract 相反。原因是代价不同：
  // 提取失败用户还有 feed 正文可读，分析失败这条条目就永远没有卡片。
  // 3 次退避能挡住限流与瞬时 5xx。但 schema/no-key/empty 是例外：
  // 它们再跑还是错，抛错只会白烧三次调用，所以要吃掉并落 failed。
  handlers['analyze'] = async (job, db: DatabaseSync) => {
    const p = safeParse(job.payload);
    const entryId = String(p.entryId ?? '');
    if (!entryId) throw new Error('analyze 缺少 entryId');
    if (!ctx.app) throw new Error('analyze 需要 AppContext（仅 serve 模式可用）');

    const { aiForUser, runtimeAiBase } = await import('../ai/service.ts');
    const { runAnalyze } = await import('../ai/analyze.ts');

    const row = db.prepare('SELECT user_id FROM entries WHERE id = ?').get(entryId) as
      { user_id: string } | undefined;
    if (!row) {
      // 条目已删除：任务作废，不是失败
      ctx.log?.('analyze: 条目已不存在，跳过', { entryId });
      return;
    }

    const { client } = aiForUser(db, row.user_id, runtimeAiBase(ctx.app.cfg));
    const r = await runAnalyze(db, client, entryId, { force: p.force === true });

    if (!r.ok && !r.skipped) {
      const kind = r.failure?.kind ?? 'network';
      const terminal = kind === 'no-key' || kind === 'schema' || kind === 'bad-json'
        || kind === 'empty' || kind === 'budget'
        || r.failure?.retryable === false;
      // 全局性失败（没 key / 超预算 / 429 冷却）只报一次（§8.8）。
      // 报 745 次不会多出信息，只会把真正的错误埋掉。
      if (shouldLog(kind)) {
        ctx.log?.(`analyze 失败`, { entryId, kind, message: r.failure?.message?.slice(0, 160) });
      }
      if (!terminal) throw new Error(`${kind}: ${r.failure?.message ?? '分析失败'}`);
      return;
    }

    ctx.log?.(`analyze 完成`, {
      entryId, skipped: r.skipped, called: r.called,
      category: r.categorySlug ?? undefined,
    });

    // 分析成功 → 立刻把向量化排上（PLAN §7.1 L3 → L4）。
    //
    // 为什么在 handler 里排而不是在 runAnalyze 内部排：runAnalyze 也被
    // 手动重跑接口同步调用，在那里排队会让"点一下重跑"变成"顺手多打一次
    // embedding" —— 而用户点重跑通常只是想刷新摘要。
    //
    // skip 时也排：向量可能是上次失败没写成的，让它再试一次。
    // dedupe_key 保证不会重复排队。
    enqueue(db, {
      kind: 'embed',
      payload: { entryId },
      dedupeKey: `embed:${entryId}`,
    });
  };

  // ── 向量化（PLAN §7.1 L4 / §19.4 2.4）───────────────────
  //
  // 失败**吃掉**，与 extract 同策略：向量是可选增强（没有它照样能读、
  // 能按分类筛），为一个 embedding 的 500 重试 3 次会白占 4 个槽位。
  // 失败原因由 client 记进 ai_usage，条目 stage 不动。
  handlers['embed'] = async (job, db: DatabaseSync) => {
    const p = safeParse(job.payload);
    const entryId = String(p.entryId ?? '');
    if (!entryId) throw new Error('embed 缺少 entryId');
    if (!ctx.app) throw new Error('embed 需要 AppContext（仅 serve 模式可用）');

    const { aiForUser, runtimeAiBase } = await import('../ai/service.ts');
    const { runEmbed } = await import('../ai/embed.ts');

    const row = db.prepare('SELECT user_id FROM entries WHERE id = ?').get(entryId) as
      { user_id: string } | undefined;
    if (!row) {
      ctx.log?.('embed: 条目已不存在，跳过', { entryId });
      return;
    }

    const { client } = aiForUser(db, row.user_id, runtimeAiBase(ctx.app.cfg));
    const r = await runEmbed(db, client, entryId, { force: p.force === true });
    // 与 analyze 同一套抑制规则：embedding 也是"没 key 时每篇都会失败"，
    // 不抑制的话它会在 analyze 的 745 行之外再刷 745 行。
    if (r.ok || shouldLog(r.failure.kind)) {
      ctx.log?.(r.ok ? 'embed 完成' : 'embed 失败', {
        entryId, skipped: r.skipped, dim: r.dim,
        failure: r.ok ? undefined : `${r.failure.kind}: ${r.failure.message}`.slice(0, 160),
      });
    }
  };

  // ── 简报（PLAN §9.1 / §19.5 3.4）────────────────────────
  //
  // 与 embed 相反：简报失败**要抛**。理由是成本与语义都不同 ——
  // 向量是可选增强（没有它照样能读），而简报是用户 08:00 打开就想要的东西，
  // 静默吃掉失败等于"今天没有简报"且没有任何痕迹。
  //
  // 但抛出去不代表无限重试：schedule.ts 的 digest_attempts + 退避会把它
  // 限制在每天 3 次。两层保护各管一件事 —— 队列管"进程崩了还能再试"，
  // 退避管"不因为一次网络抖动把 3 次配额在 30 秒里烧光"。
  handlers['digest'] = async (job, db: DatabaseSync) => {
    const p = safeParse(job.payload);
    const userId = String(p.userId ?? '');
    if (!userId) throw new Error('digest 缺少 userId');
    if (!ctx.app) throw new Error('digest 需要 AppContext（仅 serve 模式可用）');

    const { runDigest } = await import('../digest/run.ts');
    const r = await runDigest(ctx.app, { userId, kind: p.kind ? String(p.kind) : undefined });

    ctx.log?.(r.ok ? '简报已生成' : '简报未生成', {
      userId,
      digestId: r.digestId,
      clusters: r.clusterCount,
      entries: r.entryCount,
      // ok=false 不抛：那是"今天没内容"，是正常结果。
      // 真正的基础设施失败（DB 挂了）会在上面抛出来。
      reason: r.reason ?? undefined,
    });
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

