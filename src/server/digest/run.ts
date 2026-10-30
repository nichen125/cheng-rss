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
import { summarizeCluster, saveCluster, clearWindowClusters, type ClusterMember } from '../cluster/summarize.ts';
import { digestDue, recordAttempt, recordSkip, parseDigestConfig, localDayStart } from './schedule.ts';
import { listDayHighlights, renderDigestHighlightSection } from '../highlights/insight.ts';

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
}

/**
 * 跑一次简报。
 *
 * **不抛异常**：失败要能被调度器记进 digest_attempts 并退避重试，
 * 抛出去的话调用点只能看到"跑了但没结果"，无法区分"没内容"和"挂了"。
 */
export async function runDigest(
  ctx: AppContext,
  opts: DigestOptions,
): Promise<RunDigestResult> {
  const db = ctx.dbh.db;
  const now = opts.now ?? Date.now();
  const userId = opts.userId;
  const kind = opts.kind ?? 'daily';
  const dayKey = localDayStart(now);

  const rawCfg = db.prepare('SELECT digest_config FROM settings WHERE user_id = ?')
    .get(userId) as { digest_config: string } | undefined;
  const cfg = { ...parseDigestConfig(safeJson(rawCfg?.digest_config)), kind };

  // 手工触发跳过"时间到没到 / 今天做过没"这两关，但**不跳过**"有内容没"。
  if (!opts.manual) {
    const due = digestDue(db, userId, cfg, now);
    if (!due.due) return { ...EMPTY, reason: due.reason };
  }

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

  const minClusters = opts.allowSingle ? 1 : MIN_CLUSTERS_FOR_DIGEST;
  if (clusters.length < minClusters) {
    const r = `只有 ${clusters.length} 个事件，不足以构成简报`;
    recordSkip(db, userId, cfg, dayKey, r, now);
    return { ...EMPTY, reason: r, clusterCount: clusters.length, entryCount: win.items.length };
  }

  // ── 逐簇归纳 ───────────────────────────────────────────────
  const toast = { userId, model: client.config.models.strong };
  clearWindowClusters(db, userId, dayKey);

  const inputs: DigestClusterInput[] = [];
  for (const c of clusters.slice(0, 12)) {
    const members = loadMembers(db, c.memberIds);
    const s = await summarizeCluster(client, members, toast);
    const id = saveCluster(
      db, userId, c, s.summary, members,
      { start: since, end: now }, now,
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
  }

  // 簇归约后再判一次：全部失败时没有标题可用，也就没有简报
  if (inputs.length < minClusters) {
    const r = `簇归纳后只剩 ${inputs.length} 个可用事件`;
    recordSkip(db, userId, cfg, dayKey, r, now);
    return { ...EMPTY, reason: r, clusterCount: inputs.length, entryCount: win.items.length };
  }

  // ── 生成简报正文 ───────────────────────────────────────────
  const spendBefore = totalCost(db, userId, now);
  const gen = await generateDigestBody(client, inputs, toast);
  const costUsd = Math.max(0, totalCost(db, userId, now) - spendBefore);

  if (!gen.ok || !gen.body) {
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
 */
function loadMembers(db: DatabaseSync, ids: string[]): ClusterMember[] {
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT e.id, e.title, e.published_at,
           COALESCE(f.title, '未知来源') AS source_name,
           a.summary AS summary,
           substr(COALESCE(e.content_text, e.feed_content_text, ''), 1, 1200) AS body
      FROM entries e
      LEFT JOIN feeds f ON f.id = e.feed_id
      LEFT JOIN entry_analysis a ON a.entry_id = e.id
     WHERE e.id IN (${ph})
  `).all(...ids) as {
    id: string; title: string; published_at: number; source_name: string;
    summary: string | null; body: string;
  }[];

  // 按传入顺序排（SQL 的 IN 不保证顺序，而"第一个"要被当成代表条目）
  const map = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => map.get(id)).filter(Boolean).map((r) => ({
    entryId: r!.id,
    sourceName: r!.source_name,
    title: r!.title,
    summary: r!.summary,
    bodyText: r!.body ?? '',
    publishedAt: Number(r!.published_at),
  }));
}

export type { AiClient };
