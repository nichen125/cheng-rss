import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../app.ts';
import type { AiClient } from '../ai/client.ts';
import { aiForUser, runtimeAiBase } from '../ai/service.ts';
import { usageSince } from '../ai/usage.ts';
import {
  generateDigestBody, saveDigest, fallbackCitations, type DigestClusterInput,
} from './index.ts';
import {
  clusterVectors, loadClusterWindow, thresholdFor, CLUSTER_WINDOW_HOURS,
} from '../cluster/index.ts';
import {
  summarizeCluster, saveCluster, clearWindowClusters, type ClusterMember,
  PER_ENTRY_CLIP,
  memberKeyOf, findCachedClusters, clearClustersBeforeRun,
} from '../cluster/summarize.ts';
import { digestDue, recordAttempt, recordSkip, parseDigestConfig, localDayStart } from './schedule.ts';
import { setPhase, beatAndCheckCancel } from './runs.ts';
import { log } from '../logger.ts';
import { listDayHighlights, renderDigestHighlightSection } from '../highlights/insight.ts';
import { htmlToText } from '../feeds/parse.ts';
import { unpackText } from '../db/text-blob.ts';

// 简报的端到端流水线：取窗口 → 聚类 → 归约 → 生成 → 落库。
//
// 单独一层而不是塞进 job handler 的理由有三个调用方：
//   · 调度器（每天 08:00 自动跑）
//   · 手动「现在生成」（用户点按钮）
//   · 3.4 的验收脚本（要能在受控时间点跑）
// 三者只差"从哪读配置"和"跳过条件"，主干必须是一份。

export interface RunDigestResult {
  ok: boolean;
  digestId: string | null;
  /** 为什么没出简报（ok=false 时必有值） */
  reason: string | null;
  /** 参与生成的簇数 */
  clusterCount: number;
  entryCount: number;
  costUsd: number;
  invalidCites: number;
  strippedUrls: number;
  /** 这次是被停止的（用户点了停止、或撞上单次花费上限） */
  cancelled?: boolean;
  /** 谁停的：'用户手动停止' / '超过单次上限 $0.2' */
  cancelReason?: string | null;
}

const EMPTY: RunDigestResult = {
  ok: false, digestId: null, reason: null,
  clusterCount: 0, entryCount: 0, costUsd: 0, invalidCites: 0, strippedUrls: 0,
};

/** 一条簇至少要有的信息量。少于这个数进简报只会浪费一次调用 */
export const MIN_ENTRIES_FOR_DIGEST = 1;
/** 少于这么多簇时不出简报 —— 一则孤立的新闻不构成"日报" */
export const MIN_CLUSTERS_FOR_DIGEST = 2;

export interface DigestOptions {
  userId: string;
  kind?: string;
  /** 覆盖"哪天"（验收要用固定时间点）。缺省为本地今天 */
  now?: number;
  /** 手工触发时跳过节流判断（用户点了按钮就该生成） */
  manual?: boolean;
  /** 手工触发时允许只有 1 个簇（用户可能就是想看这一件事的综述） */
  allowSingle?: boolean;
  /**
   * 有值时写进度（`digest_runs` 的 phase / done_clusters / cost_usd）。
   * 不传则行为与改造前完全一致 —— 验收脚本直接调 runDigest 时走的就是这条。
   */
  runId?: string;
  /**
   * 取消信号。传进来之后它能中断**在飞的那次模型调用**，
   * 而不是等它跑完再看标志位。
   */
  signal?: AbortSignal;
  /** 单次花费上限（美元）。缺省取配置里的 maxCostUsd */
  maxCostUsd?: number;
}

/**
 * 被取消时抛它，而不是逐处 return。
 *
 * 主链有五个正常返回点（没 key / 没内容 / 簇不够 / 归纳后不够 / 生成失败），
 * 逐处加"是否被取消"判断会让业务原因与取消原因混在一起，而它们在
 * digest_skips 里必须分开写。抛出去之后由 runDigest 那层统一转成
 * cancel 结果 —— 那一层本来就在接异常。
 */
class CancelledError extends Error {
  // 显式声明而不是构造函数参数属性：tsconfig 开了 erasableSyntaxOnly，
  // 参数属性那种写法在擦除类型后会留下运行时代码，is not allowed。
  readonly cancelReason: string;

  constructor(cancelReason: string) {
    super(cancelReason);
    this.name = 'CancelledError';
    this.cancelReason = cancelReason;
  }
}

/**
 * 跑一次简报。
 *
 * **不抛异常**：失败要能被调度器记进 digest_attempts 并退避重试，
 * 抛出去的话调用点只能看到"跑了但没结果"，无法区分"没内容"和"挂了"。
 *
 * ## 这条契约之前没兑现（v2.2 修复）
 *
 * 上面那段话一直在这里，但实现只在**显式判定的四条路径**上返回，
 * 主链上的任何异常（DB 列名写错、解压失败、聚类抛错……）都会直接冒出去。
 * 而它冒出去的代价比"看到异常"更糟：
 *
 *   · `recordAttempt` 在异常之后那几行上，所以**一次都不会落**
 *     → `digestDue` 看到 attempts=0，判定"今天还没试过"，
 *       第二天、下一分钟都照跑，退避完全不存在
 *   · job handler 把异常吞成一句"简报未生成"（它自己写明"ok=false 不抛"），
 *     于是日志里那是 info 级的一行，不是错误
 *   · UI 停在 `pending`「正在准备今天的简报」，用户以为在排队
 *
 * 实测症状：`data/app.db` 里 `digest_attempts` 17 行全部是"没配置 API key"，
 * 而真正跑主链的那些次**一行都没有** —— 因为它们都抛在记 attempt 之前。
 *
 * 所以这里给整条主链包一层：**任何异常都记一次失败尝试并返回 ok:false**，
 * 让退避与世界可见性都回到契约上。异常本身仍然写进日志（带 reason 返回），
 * 不吞成静默。
 */
export async function runDigest(
  ctx: AppContext,
  opts: DigestOptions,
): Promise<RunDigestResult> {
  // 配置读取放在 try 外面：它不依赖主链，且失败时连"记 attempt"都没法做。
  const db = ctx.dbh.db;
  const now = opts.now ?? Date.now();
  const userId = opts.userId;
  const kind = opts.kind ?? 'daily';
  const dayKey = localDayStart(now);

  const rawCfg = db.prepare('SELECT digest_config FROM settings WHERE user_id = ?')
    .get(userId) as { digest_config: string } | undefined;
  const cfg = { ...parseDigestConfig(safeJson(rawCfg?.digest_config)), kind };

  // 取消检查的统一出口。每一处"要花下一次钱"之前都问一遍。
  const ac = new AbortController();
  const cancelReasonOf = opts.runId
    ? () => readCancelReason(db, opts.runId!)
    : () => null;
  // 外部 signal 与库里那个"已请求取消"的标志合并：前者是进程内的即时中断，
  // 后者让 queued 阶段的取消也成立（那时还没有任何在飞调用可中断）。
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  // 心跳与取消检查合并成一次往返（beatAndCheckCancel 的注释解释了为什么）。
  // 光读取消标记是不行的：那样子跑得再欢库里心跳也停在 started_at，
  // 60 秒后 viewOf 就会判 stale=true，UI 对着一次完全正常的生成说"心跳停了"。
  const heartbeatTimer = opts.runId
    ? setInterval(() => {
        const b = beatAndCheckCancel(db, opts.runId!);
        if (b.cancelRequested && !ac.signal.aborted) ac.abort();
      }, CANCEL_POLL_MS)
    : null;
  heartbeatTimer?.unref?.();

  try {
    return await runDigestInner(ctx, {
      db, now, userId, kind, dayKey, cfg, manual: Boolean(opts.manual),
      allowSingle: Boolean(opts.allowSingle),
      // runId 必须往下传：主链里每一处 `if (a.runId) setPhase(...)` 都靠它，
      // 漏了的话整个「进度」只存在于接口层 —— 库里永远是 0/0、phase=prepare，
      // 而 UI 会照常把一条全零的进度条画得很像在跑（§9.8 症状复现）。
      runId: opts.runId,
      signal: ac.signal,
      cancelReasonOf,
      maxCostUsd: opts.maxCostUsd ?? cfg.maxCostUsd,
    });
  } catch (e) {
    // 取消不是失败。单独一条分支的原因：它要落的是"跳过"而不是"失败"。
    // 失败会进 digest_attempts 的退避重试，而取消恰恰要求**别再自动跑** ——
    // 把两者混成一种记录，"停一次"就会变成"今天还会重试三次"。
    if (e instanceof CancelledError) {
      const msg = `已停止：${e.cancelReason}`;
      try { recordSkip(db, userId, cfg, dayKey, msg, now); } catch { /* 库不可写时无处可记 */ }
      return { ...EMPTY, reason: msg, cancelled: true, cancelReason: e.cancelReason };
    }

    // 记 attempt 本身也可能失败（库挂了）。那时只能返回，不能二次抛 ——
    // 调度器下一轮会再试，而抛出去会让整个 sweep 循环中断。
    const msg = `简报生成异常：${(e as Error).message}`;
    try {
      recordAttempt(db, userId, cfg, dayKey, false, msg.slice(0, 500), now);
    } catch { /* 库不可写时无处可记 */ }
    return { ...EMPTY, reason: msg };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

/** 取消标志的轮询间隔。1 秒：比簇间隔小一个量级，又不至于把库当热点 */
const CANCEL_POLL_MS = 1_000;

/** 库里是否已被要求取消，是则返回原因 */
function readCancelReason(db: DatabaseSync, runId: string): string | null {
  const row = db.prepare(
    'SELECT cancel_requested, cancel_reason FROM digest_runs WHERE id = ?',
  ).get(runId) as { cancel_requested: number; cancel_reason: string | null } | undefined;
  return Number(row?.cancel_requested ?? 0) === 1
    ? (row?.cancel_reason ?? '用户手动停止')
    : null;
}

/** 主链本体。异常由 runDigest 统一兜底，这里只关心业务流程。 */
async function runDigestInner(
  ctx: AppContext,
  a: {
    db: DatabaseSync; now: number; userId: string; kind: string;
    dayKey: number; cfg: ReturnType<typeof parseDigestConfig> & { kind: string };
    manual: boolean; allowSingle: boolean;
    /** 有值时写进度；没有则整条链不碰 digest_runs（验收脚本直接调时就是这样） */
    runId?: string;
    signal?: AbortSignal;
    /** 库里那个"已请求取消"的原因（没有则 null） */
    cancelReasonOf: () => string | null;
    maxCostUsd: number;
  },
): Promise<RunDigestResult> {
  const { db, now, userId, kind, dayKey, cfg } = a;

  // 每一处"即将再花一次钱"之前都先问它。抛 CancelledError 而不是返回，
  // 理由见 CancelledError 的注释。
  const checkCancel = (): void => {
    if (!a.signal?.aborted) return;
    throw new CancelledError(a.cancelReasonOf() ?? '已停止');
  };

  // 手工触发跳过"时间到没到 / 今天做过没"这两关，但**不跳过**"有内容没"。
  if (!a.manual) {
    const due = digestDue(db, userId, cfg, now);
    if (!due.due) return { ...EMPTY, reason: due.reason };
  }

  checkCancel();

  const { client, hasKey } = aiForUser(db, userId, runtimeAiBase(ctx.cfg));
  if (!hasKey) {
    const r = '没配置 API key，无法生成简报';
    recordAttempt(db, userId, cfg, dayKey, false, r, now);
    return { ...EMPTY, reason: r };
  }

  // ── 取窗口 + 聚类 ──────────────────────────────────────────
  const since = now - CLUSTER_WINDOW_HOURS * 3600_000;
  const win = loadClusterWindow(db, userId, since, now);
  if (win.items.length === 0) {
    const r = '最近 24 小时没有新条目';
    recordSkip(db, userId, cfg, dayKey, r, now);
    return { ...EMPTY, reason: r };
  }

  const clusters = clusterVectors(
    win.items.map((x) => ({
      id: x.id, vec: x.vec, publishedAt: x.publishedAt,
      sourceId: x.feedId ?? 'unknown',
    })),
    { threshold: thresholdFor(win.source), now },
  ).filter((c) => c.entryCount >= MIN_ENTRIES_FOR_DIGEST);

  const minClusters = a.allowSingle ? 1 : MIN_CLUSTERS_FOR_DIGEST;
  if (clusters.length < minClusters) {
    const r = `只有 ${clusters.length} 个事件，不足以构成简报`;
    recordSkip(db, userId, cfg, dayKey, r, now);
    return { ...EMPTY, reason: r, clusterCount: clusters.length, entryCount: win.items.length };
  }

  // ── 逐簇归纳 ───────────────────────────────────────────────
  const toast = { userId, model: client.config.models.strong };
  const use = clusters.slice(0, 12);

  // 进度：聚类完才知道总数，UI 的"3/12"从这里开始才有意义
  if (a.runId) setPhase(db, a.runId, { phase: 'clustering', totalClusters: use.length });

  // 清掉**这次运行之前**的簇。原来的 clearWindowClusters(db, userId, dayKey)
  // 传的是日历日、而 saveCluster 写的 window_start 是 now-24h，两者永不相等，
  // 所以它一条都没删过（§9.8 记录的现存缺陷）。
  //
  // 顺序很重要：**先算缓存快照，再删**。反过来的话"复用上一次的结果"
  // 永远命中不到，因为上一次的结果刚刚被自己删掉。
  const keys = use.map((c) => memberKeyOf(c.memberIds));
  const cached = findCachedClusters(db, userId, keys);
  // cutoff 传 `now`（不是 now - 24h）：
  //
  // 这里的语义是"这次运行会重算整窗，所以上一次的产物全部作废"。
  // 传 `now - CLUSTER_WINDOW_HOURS` 只删**窗外**的簇，而 saveCluster 写的
  // 是这次运行的时间（一定在窗内），于是每次手动生成都再插 2 行，
  // clusters 表只增不减 —— 正是这段注释上面说的那个缺陷没被修干净。
  // 缓存快照在删除之前读，所以复用不受影响。
  clearClustersBeforeRun(db, userId, now);

  const inputs: DigestClusterInput[] = [];
  let done = 0;
  let reused = 0;
  // 这次运行开始时的累计花费。上限要按"这次花了多少"判，而 ai_usage 的
  // usageSince 是"从某时刻起的**全部**花费" —— 它会把这次运行之前、
  // 同一时刻之后别人（fetch/analyze）花的钱也算进来。所以基线与当前值
  // 都取同一个口径，相减才是"这次花了多少"。
  const spendBaseline = usageSince(db, userId, since).usd;

  for (let i = 0; i < use.length; i++) {
    checkCancel();

    const c = use[i]!;
    const key = keys[i]!;
    const hit = cached.get(key) ?? null;

    // 命中缓存 → 不调模型，直接用已归纳的结果重写一行。
    //
    // 用**新 id** 重写而不是复用旧 id：旧行马上会被删掉（cache 快照是在
    // 删除之前读的），而复用 id 会让「删旧写新」变成主键冲突。语义上
    // 这次运行产出的就是一条新行，id 跟着换是诚实的。
    if (hit) {
      const members = loadMembers(db, c.memberIds);
      const newId = saveCluster(
        db, userId, c, {
          title: hit.title,
          summary: hit.summary ?? '',
          key_points: hit.keyPoints,
          consensus: hit.consensus,
          conflicts: hit.conflicts,
        }, members, { start: since, end: now }, now, key,
      );
      inputs.push({
        id: newId,
        title: hit.title,
        summary: hit.summary,
        keyPoints: hit.keyPoints,
        consensus: hit.consensus,
        conflicts: hit.conflicts,
        entryCount: c.entryCount,
        sourceCount: c.sourceCount,
        heat: c.heat,
      });
      reused++;
      done++;
      if (a.runId) setPhase(db, a.runId, { doneClusters: done });
      continue;
    }

    const members = loadMembers(db, c.memberIds);
    const s = await summarizeCluster(client, members, { ...toast, signal: a.signal });

    // 归纳被取消：这一簇没产出，不再写库也不再继续。判据是"失败种类",
    // 不是 abort 标志 —— 失败种类才说明**这次调用**是被我们中断的。
    if (!s.ok && s.failure?.startsWith('cancelled:')) {
      throw new CancelledError(a.cancelReasonOf() ?? '已停止');
    }

    const id = saveCluster(
      db, userId, c, s.summary, members,
      { start: since, end: now }, now, key,
    );
    inputs.push({
      id,
      title: s.summary?.title ?? members[0]?.title ?? '未命名事件',
      summary: s.summary?.summary ?? null,
      keyPoints: s.summary?.key_points ?? [],
      consensus: s.summary?.consensus ?? [],
      conflicts: s.summary?.conflicts ?? [],
      entryCount: c.entryCount,
      sourceCount: c.sourceCount,
      heat: c.heat,
    });
    done++;

    // 一簇落库之后立刻算钱并检查上限。放在"落库后"而不是"调用前"：
    // 花费是那次调用产生的，调用前检查会把刚花掉的那笔当成还没花。
    const spent = Math.max(0, usageSince(db, userId, since).usd - spendBaseline);
    if (a.runId) setPhase(db, a.runId, { doneClusters: done, costUsd: spent });
    if (spent > a.maxCostUsd) {
      throw new CancelledError(
        `超过单次上限 $${a.maxCostUsd}（本次已花 $${spent.toFixed(4)}）`,
      );
    }
  }

  // 复用命中时 costUsd 是 0，但这一次并不是"什么都没花钱"—— 省下的
  // 是上一次已经付过的。runs 表里照实写这次花的钱（0），是对的；
  // 而日志里明确说有多少簇是复用的，好让"为什么这次这么快"有据可查。
  if (reused > 0) {
    log.info(`简报复用 ${reused}/${use.length} 个已归纳事件，跳过模型调用`, {
      userId, reused, total: use.length,
    });
  }

  // 簇归约后再判一次：全部失败时没有标题可用，也就没有简报
  if (inputs.length < minClusters) {
    const r = `簇归纳后只剩 ${inputs.length} 个可用事件`;
    recordSkip(db, userId, cfg, dayKey, r, now);
    return { ...EMPTY, reason: r, clusterCount: inputs.length, entryCount: win.items.length };
  }

  // ── 生成简报正文 ───────────────────────────────────────────
  checkCancel();

  // 上限在正文前也要再判一次：正文那一次是**单次最贵**的调用（2000 token），
  // 只在簇间检查意味着它总会再花一笔才停。
  const beforeGen = Math.max(0, usageSince(db, userId, since).usd - spendBaseline);
  if (beforeGen > a.maxCostUsd) {
    throw new CancelledError(
      `超过单次上限 $${a.maxCostUsd}（本次已花 $${beforeGen.toFixed(4)}）`,
    );
  }

  if (a.runId) setPhase(db, a.runId, { phase: 'generating' });

  const spendBefore = totalCost(db, userId, now);
  const gen = await generateDigestBody(client, inputs, { ...toast, signal: a.signal });
  const costUsd = Math.max(0, totalCost(db, userId, now) - spendBefore);

  if (!gen.ok || !gen.body) {
    // 正文生成被取消：不记 attempt（它是"人不要了"，不是"这份简报坏了"）
    if (gen.failure?.startsWith('cancelled:')) {
      throw new CancelledError(a.cancelReasonOf() ?? '已停止');
    }
    const r = `简报生成失败：${gen.failure ?? '未知原因'}`;
    recordAttempt(db, userId, cfg, dayKey, false, r, now);
    return { ...EMPTY, reason: r, costUsd, clusterCount: inputs.length, entryCount: win.items.length };
  }

  // 模型一个引用都没写 → 用兜底脚注（正文不动，那是它的原样输出）
  let md = gen.rendered?.md ?? gen.body.body_md;
  if ((gen.rendered?.citations.length ?? 0) === 0) {
    const fb = fallbackCitations(inputs);
    if (fb.length > 0) {
      md += '\n\n---\n\n**今日事件索引**\n' +
        fb.map((f) => `${f.index}. ${f.title}`).join('\n');
    }
  }

  // 「你今天标记的要点」（§11.4 / M4）。
  //
  // 原文照列，**不交给模型**：这一节的判据是"我今天标了什么"，而模型会
  // 概括、会漏、会改措辞，对不上用户记忆里的那一段。位置放在引用索引
  // 之后、保存之前 —— 追加的是 Markdown 尾部，不影响正文的引用编号。
  const dayHl = listDayHighlights(db, userId, dayKey, now);
  md += renderDigestHighlightSection(dayHl);

  // 引用表必须**显式**存下来（§15.4 的脚注点开要看到"第 1 条是哪件事"）。
  //
  // body_md 里的 {{cite:cl_x}} 已经被 renderCitations 换成了 [1]，
  // 所以从正文反查簇 id 是不可能的 —— 之前 GET /digests/:id 就是这么做的，
  // clusters 恒为空、脚注点了没反应，而接口返回 200 一切正常。
  //
  // 兜底路径（模型一个引用都没写）也要存：那时脚注是程序补的"今日事件索引"，
  // 用户同样要能点开看是哪几件事。
  const cited = (gen.rendered?.citations.length ?? 0) > 0
    ? gen.rendered!.citations
    : fallbackCitations(inputs);

  const body = { ...gen.body, body_md: md };
  // 「落库」这一步也要报：它包含写引用表与写当天要点，在前端是一条
  // 可能停顿一两百毫秒的尾部。没有它，正文写完之后进度会停在
  // "写简报 12/12"不动，看起来又像卡住了。
  if (a.runId) setPhase(db, a.runId, { phase: 'saving', doneClusters: done });
  const id = saveDigest(db, {
    userId, kind, body,
    periodStart: dayKey, periodEnd: now,
    entryCount: win.items.length, clusterCount: inputs.length,
    model: client.config.models.strong, costUsd, now,
    citations: cited,
    worthReading: gen.body.worth_reading,
  });

  recordAttempt(db, userId, cfg, dayKey, true, null, now);

  return {
    ok: true,
    digestId: id,
    reason: null,
    clusterCount: inputs.length,
    entryCount: win.items.length,
    costUsd,
    invalidCites: gen.rendered?.invalid.length ?? 0,
    strippedUrls: gen.rendered?.strippedUrls.length ?? 0,
  };
}

/** 只算该用户从 `since` 起的总花费（用于算单次简报的成本） */
function totalCost(db: DatabaseSync, userId: string, since: number): number {
  return usageSince(db, userId, since).usd;
}
function safeJson(s: string | undefined): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * 取簇成员的展示信息。
 *
 * bodyText 用摘要 + 正文开头：喂给模型的是"这篇说了什么"，不是全文。
 * 全文会撑爆 token，而摘要在 2.2 已经生成过了 —— 那是我们花钱算出来的
 * 中间产物，这里正是它第二次发挥价值的地方。
 *
 * ## 正文不在 entries 上（v2.2 修复）
 *
 * 这里原本查 `e.content_text` / `e.feed_content_text`，而**这两列从 0001
 * 起就不存在** —— 正文一直存在 `entry_contents.html`（gzip BLOB，§13.3）。
 * 于是 `runDigest` 在"窗口里有条目"这条路上必然抛
 * `no such column: e.content_text`，而它抛在第一个 `recordAttempt` 之前，
 * 所以 digest_attempts 连一行都不落、退避机制不生效，handler 只记一句
 * "简报未生成"。症状是**简报从来没成功过一次，而日志像正常跳过**。
 *
 * 为什么既有 3.1~3.5 的验收没抓到：它们要么是纯函数（聚类 / 引用替换 /
 * 调度判定），要么像 m3-04 那样只走"没 key""窗口为空"两条**在调模型之前
 * 就返回**的路径。主链上一次都没被真正跑过。
 *
 * SQL 侧只取 BLOB，解压与转纯文本放在 JS 里：
 * `unpackText` 与 `htmlToText` 都是纯函数，放进 SQL 做不到（gzip 是自定义
 * 标记格式，不是 SQLite 内建能解的）。这也让"截断到 1200 字"发生在**解压
 * 之后**，避免对 gzip 字节做 substr 切出半截流。
 */
function loadMembers(db: DatabaseSync, ids: string[]): ClusterMember[] {
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT e.id, e.title, e.published_at,
           COALESCE(f.title, '未知来源') AS source_name,
           a.summary AS summary,
           c.html AS body_html
      FROM entries e
      LEFT JOIN feeds f ON f.id = e.feed_id
      LEFT JOIN entry_analysis a ON a.entry_id = e.id
      LEFT JOIN entry_contents c ON c.entry_id = e.id
     WHERE e.id IN (${ph})
  `).all(...ids) as {
    id: string; title: string; published_at: number; source_name: string;
    summary: string | null; body_html: Uint8Array | null;
  }[];

  // 按传入顺序排（SQL 的 IN 不保证顺序，而"第一个"要被当成代表条目）
  //
  // 先解压再截断：`substr` 作用在 gzip 字节上会切出半截流，
  // `unpackText` 随后会在 gunzip 里抛 `unexpected end of file`。
  const map = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => map.get(id)).filter(Boolean).map((r) => {
    const text = htmlToText(unpackText(r!.body_html) ?? '');
    return {
      entryId: r!.id,
      sourceName: r!.source_name,
      title: r!.title,
      summary: r!.summary,
      // 留 1200 字给 buildClusterUser 再按 PER_ENTRY_CLIP 截断，
      // 这里不再切第二次（两处阈值不一致时以 summarize.ts 为准）。
      bodyText: text.slice(0, PER_ENTRY_CLIP),
      publishedAt: Number(r!.published_at),
    };
  });
}

export type { AiClient };
