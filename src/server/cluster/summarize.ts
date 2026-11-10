import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { AiClient } from '../ai/client.ts';
import { ClusterSummarySchema, type ClusterSummary } from '../ai/schema.ts';
import { packVec } from '../dedupe/cosine.ts';
import type { Cluster } from './index.ts';

// 簇级归纳（PLAN §9.2 / §19.5 3.2）。
//
// 这一步是简报的**价值来源**。同类项目普遍停在「摘要 + 打分排序」，那只是
// 把 20 条摘要摞在一起；consensus / conflicts 才是"每天值得看"的东西 ——
// 它回答的是"这件事我知道什么、各方说法哪里不一样"。
//
// 三个必须做对的点，每个都有反例：
//   1. 单来源簇必须标注「单一来源，待验证」，且 conflicts 强制为空 ——
//      一篇报道不可能与自己冲突，让模型"找冲突"它就会编。
//   2. conflicts 里引用的来源必须是**输入里真实存在的**，不能是模型
//      顺手写的"据媒体报道"。所以归纳后再校验一次，把不存在的来源剔掉。
//   3. 输入里明确区分"第几篇 / 来源名 / 标题 / 摘要"。只塞正文的话，
//      模型无法说"来源A与来源B说法不同"，它连哪个句子来自哪个源都不知道。

export const CLUSTER_PROMPT_VERSION = 'cluster-v1';

export const CLUSTER_SYSTEM = `你是一名多源情报编辑。给你同一事件的若干篇报道，请综合成一张事件卡片。

硬性要求：
1. title 12 字以内，是事件本身，不是"某公司发布新品"这种泛标题。
2. summary 150 字内：发生了什么、各方观点的差异、最新进展。
3. key_points 每条须含具体事实（数字、名称、时间）。
4. consensus 只写**多篇报道一致**的事实。只有一篇时留空数组。
5. conflicts 只写**确有两篇说法不同**的点，sources 填涉及的来源名（用输入里给的原名）。
   只有一篇时**必须**留空数组 —— 不要为了凑内容编造分歧。
6. 原文未提及的一律不得推断补充。
7. 只输出 JSON，不要解释文字或 Markdown 围栏。`;

/**
 * 喂给模型的单篇正文上限。§8.5 的"只喂标题 + 摘要 + 前 4000 字"同源。
 *
 * 导出给 `run.ts` 用：它在 `loadMembers` 里也要按同一个数截断，
 * 两处阈值不一致时会变成"这里切 1200、那里切 800"，而症状只是
 * "模型看到的正文莫名其妙短了一截"，很难归因。
 */
export const PER_ENTRY_CLIP = 1200;
/** 一簇最多喂几篇。再多的话 token 成本翻倍而信息增量几乎为零 */
export const MAX_ENTRIES_PER_CLUSTER = 8;

export interface ClusterMember {
  entryId: string;
  /** 来源名（feed 标题）。conflicts.sources 必须取这里的值 */
  sourceName: string;
  title: string;
  summary: string | null;
  bodyText: string;
  publishedAt: number;
}

export function buildClusterUser(members: ClusterMember[], total: number): string {
  const use = members.slice(0, MAX_ENTRIES_PER_CLUSTER);
  const head = `本事件共 ${total} 篇报道，以下按相关度列出 ${use.length} 篇。` +
    (total > use.length ? `（其余 ${total - use.length} 篇主题相同，未逐一列出）` : '') +
    '\n\n';

  const parts = use.map((m, i) => {
    const body = m.bodyText.length > PER_ENTRY_CLIP
      ? m.bodyText.slice(0, PER_ENTRY_CLIP) + '…（已截断）'
      : m.bodyText;
    return `【第 ${i + 1} 篇】来源：${m.sourceName}\n标题：${m.title}\n摘要：${m.summary ?? '（无）'}\n正文节选：${body}`;
  });

  return head + parts.join('\n\n---\n\n');
}

export interface SummarizeResult {
  ok: boolean;
  summary: ClusterSummary | null;
  failure: string | null;
  /** 归纳后剔掉的、模型编造的来源名 */
  droppedSources: string[];
}

/**
 * 归纳一个簇。
 *
 * 失败不抛：3.3 的简报生成需要"部分簇成功也能出简报"，一个簇的归纳失败
 * 不该让整份简报消失。失败的簇在简报里退化为"标题 + 来源数"。
 */
export async function summarizeCluster(
  client: AiClient,
  members: ClusterMember[],
  opts: { userId?: string; model?: string; signal?: AbortSignal } = {},
): Promise<SummarizeResult> {
  if (members.length === 0) {
    return { ok: false, summary: null, failure: '空簇', droppedSources: [] };
  }

  const realSources = new Set(members.map((m) => m.sourceName));
  const user = buildClusterUser(members, members.length);

  const r = await client.chatJson({
    schema: ClusterSummarySchema,
    system: CLUSTER_SYSTEM,
    user,
    model: opts.model ?? client.config.models.strong,
    purpose: 'cluster',
    userId: opts.userId,
    maxTokens: 900,
    signalName: 'cluster_summary',
    signal: opts.signal,
  });

  if (!r.ok) {
    return { ok: false, summary: null, failure: `${r.failure.kind}: ${r.failure.message}`, droppedSources: [] };
  }

  const dropped: string[] = [];
  let data = r.data;

  // ① 单来源：conflicts 必须为空。模型经常"礼貌性地"编一条分歧，
  //    而在只有一篇报道的情况下那不是分歧，是幻觉。
  if (members.length === 1) {
    if ((data.conflicts ?? []).length > 0) {
      dropped.push(...data.conflicts.flatMap((c) => c.sources));
      data = { ...data, conflicts: [] };
    }
    // 标题也要能说明"待验证" —— 简报层据此加标注（见 describeSingleSource）
  }

  // ② conflicts 里引用的来源必须真实存在。模型会写"据多家媒体报道"、
  //    或把来源名写错（"新浪科技" vs "新浪科技频道"）。剔除而不是整条失败：
  //    剔掉后剩下的分歧仍然有价值，而整条失败会丢掉整段综述。
  const filteredConflicts = (data.conflicts ?? []).filter((c) => {
    const valid = c.sources.filter((s) => realSources.has(s));
    if (valid.length !== c.sources.length) {
      dropped.push(...c.sources.filter((s) => !realSources.has(s)));
    }
    if (valid.length < 2) {
      // 少于两个来源的"分歧"不是分歧 —— 无法交叉验证
      dropped.push(...valid);
      return false;
    }
    return true;
  });

  return {
    ok: true,
    summary: { ...data, conflicts: filteredConflicts.map((c) => ({
      claim: c.claim,
      sources: c.sources.filter((s) => realSources.has(s)),
    })) },
    failure: null,
    droppedSources: [...new Set(dropped)],
  };
}

/** 单来源簇在简报里的固定标注（§9.3 的硬约束） */
export const SINGLE_SOURCE_NOTE = '单一来源，待验证';

export function describeSingleSource(sourceCount: number): string | null {
  return sourceCount <= 1 ? SINGLE_SOURCE_NOTE : null;
}

// ── 落库 ──────────────────────────────────────────────────────

/**
 * 把一个已归纳的簇写进 clusters / cluster_entries。
 *
 * 幂等的关键：同一时间窗重复跑 3.1+3.2 会得到**新的**簇 id，因此这里
 * 不按 cluster_id upsert，而是先删掉该窗口内的旧簇再整体写。为什么可以
 * 整窗重算：聚类是窗口函数（输入是"最近 24 小时的全部条目"），任何一条
 * 新条目进来都可能改变分组，增量更新会得到与全量重算不一致的结果 ——
 * 而那种不一致很难解释给用户。
 */
export function saveCluster(
  db: DatabaseSync,
  userId: string,
  c: Cluster,
  summary: ClusterSummary | null,
  members: ClusterMember[],
  window: { start: number; end: number },
  now = Date.now(),
  /** 复用键：这组文章是不是同一批（见 memberKeyOf）。缺省 null = 未标定 */
  memberKey?: string | null,
): string {
  const id = `cl_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // is_primary 取**簇自身排好序的第一个成员**（与簇心最像的那篇），
  // 而不是 members[0]。两者通常一致，但 members 是调用方按"喂给模型的
  // 顺序"给的，可能与 memberIds 不同（比如按时间排）—— 那会得到
  // 0 个 primary，而简报的「代表条目」链接就没了。
  const primary = c.memberIds[0] ?? members[0]?.entryId ?? '';

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO clusters (id, user_id, kind, title, summary, key_points, consensus,
        conflicts, centroid, entry_count, source_count, heat, window_start, window_end,
        created_at, member_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, userId, 'event',
      summary?.title ?? fallbackTitle(members),
      summary?.summary ?? null,
      summary ? JSON.stringify(summary.key_points) : null,
      summary ? JSON.stringify(summary.consensus) : null,
      summary ? JSON.stringify(summary.conflicts) : null,
      packVec(c.centroid),
      c.entryCount, c.sourceCount, c.heat,
      window.start, window.end, now,
      memberKey ?? null,
    );

    const ins = db.prepare(`
      INSERT OR IGNORE INTO cluster_entries (cluster_id, entry_id, similarity, is_primary)
      VALUES (?,?,?,?)
    `);
    for (const mid of c.memberIds) {
      ins.run(id, mid, null, mid === primary ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return id;
}

/**
 * 归纳失败时的兜底标题。
 *
 * 用**代表条目的标题**而不是"事件 1"：一份简报里十条「事件 1/2/3」比
 * 没有标题更糟 —— 用户无法据此决定点不点。摘要失败只影响综述那段，
 * 标题来自原文，仍然是可信的。
 */
export function fallbackTitle(members: ClusterMember[]): string {
  const t = members[0]?.title ?? '';
  return t.length > 60 ? t.slice(0, 60) + '…' : (t || '未命名事件');
}

/** 清掉某窗口内的旧簇。整窗重算的前半段 */
export function clearWindowClusters(
  db: DatabaseSync,
  userId: string,
  windowStart: number,
): number {
  const r = db.prepare(
    'DELETE FROM clusters WHERE user_id = ? AND window_start = ?',
  ).run(userId, windowStart);
  return Number(r.changes ?? 0);
}

// ── 簇复用（PLAN §9.8 的 C7）──────────────────────────────────
//
// 为什么需要它：一次简报要逐簇归纳，而"归纳"是这段流程里最贵的一段
// （每簇一次模型调用）。用户点了「停止」之后再点「生成」，如果他做的是
// 同一批事件，把已经归纳好的结果重新归纳一遍就是纯粹地重复付钱。
// 缓存键取**成员条目的集合**，不取时间窗：同一批文章在十分钟后仍然是
// 同一件事，而"是不是同一批"跟哪一天、哪次运行无关，所以可以跨天命中。

/**
 * 一组成员的复用键。
 *
 * `sha256(排序后的 entry_id 拼接).slice(0,16)`：排序是为了"同一批"这
 * 个语义不被喂进来的顺序影响 —— 聚类结果的顺序会随阈值与新增条目变化，
 * 而它们描述的还是那几篇报道。
 *
 * 截到 16 个字符（64 bit）而不是更短：碰撞的后果是"把 A 事件的综述
 * 当成 B 事件"，那比"多花一次调用"严重得多。64 bit 在单用户的量级上
 * 远远够（生日界下要百万级成员组合才有一次碰撞）。
 */
export function memberKeyOf(entryIds: string[]): string {
  const sorted = [...entryIds].sort();
  return createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 16);
}

export interface CachedCluster {
  id: string;
  title: string;
  summary: string | null;
  keyPoints: string[];
  consensus: string[];
  conflicts: { claim: string; sources: string[] }[];
  entryCount: number;
  sourceCount: number;
  heat: number;
  memberKey: string;
  createdAt: number;
}

/**
 * 按 member_key 取回已归纳的簇。跨天，取最新的一条。
 *
 * 一次查回全部 key 而不是逐个查：簇有 12 个，逐查就是 12 次往返，
 * 而这条路径发生在用户点了"生成"之后的第一秒里，它不该是慢的部分。
 */
export function findCachedClusters(
  db: DatabaseSync,
  userId: string,
  keys: string[],
): Map<string, CachedCluster> {
  const out = new Map<string, CachedCluster>();
  if (keys.length === 0) return out;

  const rows = db.prepare(`
    SELECT * FROM clusters
     WHERE user_id = ? AND member_key IS NOT NULL
       AND member_key IN (${keys.map(() => '?').join(',')})
     ORDER BY created_at ASC
  `).all(userId, ...keys) as Record<string, unknown>[];

  for (const r of rows) {
    // 同一 key 有多行时（同一天重新跑过、或跨天命中）保留**最新**的：
    // ORDER BY created_at ASC 之后逐条覆盖，最后留下的就是最新那条。
    const key = String(r.member_key);
    out.set(key, {
      id: String(r.id),
      title: String(r.title ?? ''),
      summary: r.summary === null ? null : String(r.summary),
      keyPoints: parseArr<string>(r.key_points),
      consensus: parseArr<string>(r.consensus),
      conflicts: parseArr<{ claim: string; sources: string[] }>(r.conflicts),
      entryCount: Number(r.entry_count ?? 0),
      sourceCount: Number(r.source_count ?? 0),
      heat: Number(r.heat ?? 0),
      memberKey: key,
      createdAt: Number(r.created_at ?? 0),
    });
  }
  return out;
}

function parseArr<T>(raw: unknown): T[] {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * 清掉"这次运行之前"的簇，但**只清即将重算的那一批**。
 *
 * 原来的 `clearWindowClusters(db, userId, dayKey)` 传的是**日历日**，
 * 而 `saveCluster` 写进去的 `window_start` 是 `now - 24h` —— 两个键
 * 永不相等，所以它一条都没删过。实测库里 clusters 只增不减，
 * 抽掉这条清理之后"整窗重算"的语义就只剩一半。
 *
 * 现在按**时间**清：`created_at < sinceCreated` 的簇都算上一轮的产物。
 * 不传 cutoff 的老调用（验收脚本）仍走 clearWindowClusters 的原语义。
 */
export function clearClustersBeforeRun(
  db: DatabaseSync,
  userId: string,
  sinceCreated: number,
): number {
  const r = db.prepare(
    'DELETE FROM clusters WHERE user_id = ? AND created_at < ?',
  ).run(userId, sinceCreated);
  return Number(r.changes ?? 0);
}
