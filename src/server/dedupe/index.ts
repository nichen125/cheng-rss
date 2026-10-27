import type { DatabaseSync } from 'node:sqlite';
import { canonicalUrl } from './url.ts';
import {
  DUP_THRESHOLD, LOCAL_MODEL, SAME_EVENT_THRESHOLD,
  cosine, hashEmbed, packVec, signatureText, unpackVec,
} from './cosine.ts';
import type { DuplicateHit, DuplicateReason } from './types.ts';
import { htmlToText } from '../feeds/parse.ts';

// 再导出：url 规范化与同文判定是同一条判重链上的工具，
// 调用方（feeds/store.ts）只需要认这一个模块的出口。
export { canonicalUrl, sameUrl } from './url.ts';
export type { DuplicateHit, DuplicateReason } from './types.ts';

// 去重（PLAN §7.1 L2）。
//
// 三层，按代价从低到高，命中即停：
//   1. URL 规范化   —— 免费，吃掉 utm 追踪参数与末尾斜杠
//   2. 内容指纹     —— 一次 sha1，吃掉标题+正文完全相同的转载
//   3. 向量余弦     —— 256 维本地嵌入，吃掉"改了标题/加了一段导语"的转载
//
// 为什么第 3 层不能省：前两层要求几乎逐字相同。真实的跨站转载总会加一句
// 导语、改个标点、挂上自己站名的后缀 —— 实测这类改动能把 sha1 完全打散，
// 但余弦仍在 0.99 以上。
//
// 为什么本地嵌入而不是调模型：M1 阶段还没有模型 API（M2 才有），而去重
// 必须在 M1 就成立 —— 否则每天进库的重复内容会污染后面的分类与简报，
// 等 M2 再补就要重跑整个历史。local-hash-v1 与真实模型写进 embeddings 表时
// 用 model 字段区分，互不覆盖。

/** 向量层只看最近这么多天内的候选（PLAN §7.3 的"先用时间窗收窄"） */
export const VECTOR_WINDOW_DAYS = 14;

/**
 * 单次判重的候选上限。
 *
 * 不设上限时，一次全量重扫会随库增长线性变慢（10 万条 × 256 维 ≈ 400ms/篇）。
 * 400 条 × 256 维实测 1.7ms，而"同一篇文章在两周内的 400 条新内容里"
 * 几乎必然出现 —— 漏判需要对方恰好推了 400 篇之后才转载，实际不会发生。
 */
export const VECTOR_CANDIDATES = 400;

export interface DedupeInput {
  userId: string;
  url: string;
  title: string;
  /** 已清洗的正文 HTML；允许为空（有些源只给摘要） */
  html?: string | null;
  /** 内容指纹；传 null 表示跳过第 2 层 */
  contentHash?: string | null;
  /** 排除自己（重新抓取已有条目时用） */
  excludeEntryId?: string;
}

/**
 * 三层判重。
 *
 * 返回 null 表示"没找到重复"。找到时返回已存在的那条 —— 调用方据此写
 * `duplicate_of`，而不是把新条目丢掉：新条目记着"哪个源也发了这篇"，
 * M3 统计热度时要用。
 */
export function findDuplicate(db: DatabaseSync, input: DedupeInput): DuplicateHit | null {
  // ── 1. URL ──
  const urlNorm = canonicalUrl(input.url);
  const byUrl = db.prepare(
    `SELECT id FROM entries
      WHERE user_id = ? AND url_norm = ? AND (? IS NULL OR id <> ?)
      ORDER BY duplicate_of IS NOT NULL, published_at DESC
      LIMIT 1`,
  ).get(input.userId, urlNorm, input.excludeEntryId ?? null, input.excludeEntryId ?? null) as
    { id: string } | undefined;
  if (byUrl) return { entryId: byUrl.id, reason: 'url', similarity: 1 };

  // ── 2. 内容指纹 ──
  // 没有正文就算不出可信指纹（空指纹会把所有"无正文"的条目判成同一篇）
  if (input.contentHash && (input.html ?? '').length > 200) {
    const byHash = db.prepare(
      `SELECT id FROM entries
        WHERE user_id = ? AND content_hash = ? AND (? IS NULL OR id <> ?)
        ORDER BY duplicate_of IS NOT NULL, published_at DESC
        LIMIT 1`,
    ).get(input.userId, input.contentHash, input.excludeEntryId ?? null, input.excludeEntryId ?? null) as
      { id: string } | undefined;
    if (byHash) return { entryId: byHash.id, reason: 'hash', similarity: 1 };
  }

  // ── 3. 向量 ──
  const text = signatureText(input.title, htmlToText(input.html));
  // 特征太少的文本（如标题为空、正文只有一行）算出的向量不可信 ——
  // 实测这类向量之间的余弦会虚高到 0.5~0.8，容易误判。
  if (text.replace(/\s+/g, '').length < 40) return null;

  const vec = hashEmbed(text);
  const cutoff = Date.now() - VECTOR_WINDOW_DAYS * 86400_000;

  const rows = db.prepare(
    `SELECT e.id, v.vec
       FROM entries e
       JOIN entry_vectors v ON v.entry_id = e.id
      WHERE e.user_id = ? AND v.model = ?
        AND e.published_at >= ?
        AND (? IS NULL OR e.id <> ?)
      ORDER BY e.published_at DESC
      LIMIT ?`,
  ).all(
    input.userId, LOCAL_MODEL, cutoff,
    input.excludeEntryId ?? null, input.excludeEntryId ?? null,
    VECTOR_CANDIDATES,
  ) as { id: string; vec: Uint8Array }[];

  let best: { id: string; sim: number } | null = null;
  for (const r of rows) {
    const sim = cosine(vec, unpackVec(r.vec));
    if (sim > DUP_THRESHOLD && (!best || sim > best.sim)) best = { id: r.id, sim };
  }
  return best ? { entryId: best.id, reason: 'vector', similarity: best.sim } : null;
}

/**
 * 写入本地去重向量（幂等）。
 *
 * 在入库当下同步写：判重要读它，异步补写会出现"新条目在写向量之前被
 * 另一条判重命中"的窗口 —— 那种 bug 只在并发抓取时复现，排查成本
 * 远高于省下的 0.3ms。
 *
 * 只写 entry_vectors 而不碰 embeddings：后者是 M2 真实语义向量的位置，
 * 两者用途不同（判重 vs 检索），混在一张表会让 M2 覆盖掉判重指纹。
 */
export function ensureLocalVector(
  db: DatabaseSync,
  entryId: string,
  title: string,
  html: string | null | undefined,
): boolean {
  const text = signatureText(title, htmlToText(html));
  // 特征太少的文本（标题空 + 正文一行）算出的向量不可信，
  // 写入只会给判重层制造噪声
  if (text.replace(/\s+/g, '').length < 40) return false;

  const vec = hashEmbed(text);
  const r = db.prepare(
    `INSERT INTO entry_vectors (entry_id, dim, vec, model, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(entry_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec,
                                        model = excluded.model, created_at = excluded.created_at`,
  ).run(entryId, vec.length, packVec(vec), LOCAL_MODEL, Date.now());
  return Number(r.changes) > 0;
}

/** 供 M3 聚类：0.88~0.95 判"同事件不同报道" */
export function isSameEvent(similarity: number): boolean {
  return similarity >= SAME_EVENT_THRESHOLD && similarity <= DUP_THRESHOLD;
}

/** 统计用：某用户有多少条目被判为重复 */
export function duplicateStats(db: DatabaseSync, userId: string): {
  total: number; duplicates: number; rate: number;
} {
  const r = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN duplicate_of IS NOT NULL THEN 1 ELSE 0 END) AS dups
      FROM entries WHERE user_id = ?
  `).get(userId) as { total: number; dups: number | null } | undefined;
  const total = Number(r?.total ?? 0);
  const duplicates = Number(r?.dups ?? 0);
  return { total, duplicates, rate: total > 0 ? duplicates / total : 0 };
}

/**
 * 清掉过期的去重向量。
 *
 * 为什么必须清：判重只看近 14 天（VECTOR_WINDOW_DAYS），更早的向量永远
 * 不会被读到。而一条向量是 256×4 + 约 30 字节索引开销 ≈ 1 KB —— 10 万条
 * 就是 100 MB，占压缩后整库（约 0.9 GB）的 11%，纯属白占 NAS 空间。
 *
 * 留一倍余量（清理 2× 窗口之前）而不是刚好 14 天：清理发生在定时器里，
 * 与判重的时间戳比较有一次取整差异，卡在边界上会随机删掉"其实还用得上"的向量。
 */
export function pruneOldVectors(db: DatabaseSync, now = Date.now()): number {
  const cutoff = now - VECTOR_WINDOW_DAYS * 2 * 86400_000;
  const r = db.prepare(`
    DELETE FROM entry_vectors
     WHERE entry_id IN (SELECT id FROM entries WHERE published_at < ?)
  `).run(cutoff);
  return Number(r.changes ?? 0);
}
