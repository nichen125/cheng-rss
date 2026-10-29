import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AiClient, AiFailure, AiUsageRecord } from './client.ts';
import { EntryAnalysisSchema } from './schema.ts';
import { ANALYZE_SYSTEM, BODY_CLIP, PROMPT_VERSION, buildAnalyzeUser } from './prompt.ts';
import {
  FALLBACK_SLUG, categoryIdMap, ensureDefaultCategories, knownTopics, listCategories,
} from './taxonomy.ts';
import { unpackText } from '../db/text-blob.ts';
import { indexEntry } from '../search/index.ts';
import { htmlToText } from '../feeds/parse.ts';

// 单篇分析流水线（PLAN §7.1 L3 / §19.4 2.2）。
//
// 与 extract/run.ts 的分工相同：
//   analyze/analyze.ts 只回答"这一篇该怎么问模型、结果该长什么样"
//   这里回答"该怎么写库、失败了怎么记、重复跑怎么不重复计费"

export interface AnalyzeResult {
  ok: boolean;
  /** 内容没变、已有分析 → 跳过（不调模型） */
  skipped: boolean;
  /** 这次真的调了一次（成功或失败），用于验收脚本核计费 */
  called: boolean;
  failure: AiFailure | null;
  usage: AiUsageRecord | null;
  /** 分类 slug，无法识别的 slug 原样返回（2.3 之后才归一成 other） */
  categorySlug: string | null;
}

/**
 * 输入指纹：标题 + **喂给模型的那段**正文。
 *
 * 为什么取截断后的正文而不是全文 hash：正文尾部加一条"相关阅读"不该
 * 触发重分析 —— 那部分我们本来就没给模型看，它不影响结果。
 * 用全文 hash 会让这类无意义的改动反复计费。
 *
 * 为什么不用 entries.content_hash：那一列是 feed 侧的原始指纹，提取全文
 * 之后不会更新（§7.5 的 update 只写 word_count），拿它做判据会让
 * "摘要型源拿到全文后应重分析"这条永远不生效。
 */
export function analysisFingerprint(title: string, body: string): string {
  const h = createHash('sha256');
  h.update(title.trim());
  h.update('\n\u0000\n');
  h.update(body.slice(0, BODY_CLIP));
  return h.digest('hex');
}

export interface AnalyzeEntryRow {
  id: string;
  userId: string;
  title: string;
  siteName: string | null;
  author: string | null;
  body: string;
}

/** 读出分析一篇所需的全部输入 */
export function loadAnalyzeInput(db: DatabaseSync, entryId: string): AnalyzeEntryRow | null {
  const row = db.prepare(`
    SELECT e.id, e.user_id, e.title, e.site_name, e.author, c.html
      FROM entries e
      LEFT JOIN entry_contents c ON c.entry_id = e.id
     WHERE e.id = ?
  `).get(entryId) as {
    id: string; user_id: string; title: string; site_name: string | null;
    author: string | null; html: Uint8Array | null;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    siteName: row.site_name,
    author: row.author,
    body: htmlToText(unpackText(row.html)),
  };
}

/** 已有分析的指纹（没有分析行则 null） */
export function existingFingerprint(db: DatabaseSync, entryId: string): string | null {
  const r = db.prepare('SELECT source_hash FROM entry_analysis WHERE entry_id = ?')
    .get(entryId) as { source_hash: string | null } | undefined;
  return r?.source_hash ?? null;
}

/**
 * 分析一个条目并落库。
 *
 * 幂等有三个层次，缺一层就会重复计费或写坏数据：
 *   1. 指纹相同 → 直接跳过（不打网络）—— 覆盖"重跑同一条"
 *   2. 正文为空 → 判 failed 并说明，不调模型 —— 空输入必得编造输出
 *   3. 写库用 `INSERT ... ON CONFLICT DO UPDATE` —— 覆盖"两条任务同时在飞"
 */
export async function runAnalyze(
  db: DatabaseSync,
  client: AiClient,
  entryId: string,
  opts: { force?: boolean; now?: number } = {},
): Promise<AnalyzeResult> {
  const now = opts.now ?? Date.now();
  const input = loadAnalyzeInput(db, entryId);

  if (!input) {
    // 条目已删除：任务作废，不是失败
    return { ok: true, skipped: true, called: false, failure: null, usage: null, categorySlug: null };
  }

  const fingerprint = analysisFingerprint(input.title, input.body);

  if (!opts.force && existingFingerprint(db, entryId) === fingerprint) {
    return { ok: true, skipped: true, called: false, failure: null, usage: null, categorySlug: null };
  }

  if (input.body.trim() === '') {
    // 空正文不能送模型：它会照着标题编一段，而那段"摘要"看起来跟真的一样。
    // 记 failed 而不是 extracted —— 用户需要知道这篇没有分析结果，以及为什么。
    markFailed(db, entryId, '空正文：没有可分析的内容（正文提取失败或 feed 只有标题）');
    return {
      ok: false, skipped: false, called: false,
      failure: { kind: 'empty', message: '正文为空', retryable: false },
      usage: null, categorySlug: null,
    };
  }

  ensureDefaultCategories(db, input.userId);
  const categories = listCategories(db, input.userId);
  const idMap = categoryIdMap(db, input.userId);

  const r = await client.chatJson({
    schema: EntryAnalysisSchema,
    system: ANALYZE_SYSTEM,
    user: buildAnalyzeUser({
      title: input.title,
      siteName: input.siteName,
      author: input.author,
      body: input.body,
      categories,
      knownTopics: knownTopics(db, input.userId),
    }),
    model: client.config.models.strong,
    purpose: 'analyze',
    userId: input.userId,
    maxTokens: 1200,
  });

  if (!r.ok) {
    // 这几类是**全局配置问题**，不是这一篇的问题：
    //   no-key  环境变量里没 key —— 库里 500 篇会一起变 failed
    //   budget  预算闸门拦住 —— 明天额度恢复了它们该自己继续
    // 写成 stage=failed 的后果是「问题条目」列表被 500 条"没配 key"
    // 灌满，而用户真正要看的是哪几篇分析不出来。
    // 因此不改 stage，只记 ai_usage，由 UI 从 /stats 提示"去配 key"。
    //
    // abort 同理：它意味着"闸门叫停，这批现在不该继续"，而不是
    // "这篇内容有问题"。落到 failed 会让一次误抓紧造就几百条脏数据。
    if (r.failure.kind !== 'no-key' && r.failure.kind !== 'budget') {
      markFailed(db, entryId, `${r.failure.kind}: ${r.failure.message}`);
    }
    return {
      ok: false, skipped: false, called: true,
      failure: r.failure, usage: r.usage, categorySlug: null,
    };
  }

  const a = r.data;
  const categorySlug = a.category;
  // 2.2 只做 slug → id 的查表：不认识就是 NULL。
  // 「不认识 → 归 other」是 2.3 的行为（判据①），这里提前做掉会让 2.3 的
  // 断言永远绿 —— 而那正是它存在的理由。
  const categoryId = idMap.get(categorySlug) ?? null;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO entry_analysis (
        entry_id, summary, key_points, category_id, topics, entities,
        importance, tier, novelty, sentiment, reading_time, lang,
        model, prompt_version, in_tokens, out_tokens, cost_usd, created_at,
        source_hash, input_chars
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(entry_id) DO UPDATE SET
        summary = excluded.summary, key_points = excluded.key_points,
        category_id = excluded.category_id, topics = excluded.topics,
        entities = excluded.entities, importance = excluded.importance,
        tier = excluded.tier, novelty = excluded.novelty,
        sentiment = excluded.sentiment, reading_time = excluded.reading_time,
        model = excluded.model, prompt_version = excluded.prompt_version,
        in_tokens = excluded.in_tokens, out_tokens = excluded.out_tokens,
        cost_usd = excluded.cost_usd, created_at = excluded.created_at,
        source_hash = excluded.source_hash, input_chars = excluded.input_chars
    `).run(
      entryId,
      a.summary,
      JSON.stringify(a.key_points),
      categoryId,
      JSON.stringify(a.topics),
      JSON.stringify(a.entities),
      a.importance,
      tierForImportance(a.importance),
      a.novelty,
      a.sentiment,
      estimateReadingTime(input.body),
      null,
      client.config.models.strong,
      PROMPT_VERSION,
      r.usage.inTokens,
      r.usage.outTokens,
      r.usage.costUsd,
      now,
      fingerprint,
      input.body.length,
    );

    // 阶段推进用乐观锁：只有还在 extracted 的才推进。
    // 不用无条件 UPDATE 的原因：一条正在被手工重跑的条目，不该被一个
    // 更早排队的任务把 stage 从 analyzed 拖回去。
    db.prepare(`
      UPDATE entries SET stage = 'analyzed', stage_error = NULL
       WHERE id = ? AND stage IN ('extracted','analyzed')
    `).run(entryId);

    // FTS 里摘要要跟着更新（§7.3：索引范围含 AI 摘要）。
    // 不做的话，用户搜"裁员"搜不到那篇标题里没有这个词、摘要里有的文章。
    indexEntry(db, entryId, {
      title: input.title,
      summary: a.summary,
      topics: a.topics,
      excerpt: null,
    });

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    ok: true, skipped: false, called: true,
    failure: null, usage: r.usage, categorySlug,
  };
}

/**
 * 写 stage=failed 并带上可读原因。
 *
 * 只在条目还没被分析成功时降级 —— 一条已经 analyzed 的条目因为手工重跑
 * 失败，不该把已有的卡片抹掉：用户下次打开会看到"分析失败"，而库里
 * 明明有一份能用的结果。
 */
function markFailed(db: DatabaseSync, entryId: string, reason: string): void {
  db.prepare(`
    UPDATE entries SET stage = 'failed', stage_error = ?
     WHERE id = ? AND stage <> 'analyzed'
  `).run(reason.slice(0, 500), entryId);
}

/**
 * 阅读时长（分钟）。中文 400 字/分钟，英文 230 词/分钟。
 *
 * 存的是**分钟**而不是秒：UI 显示"3 分钟"就够了，存秒只会让读者以为
 * 这个数字有精度。
 */
export function estimateReadingTime(text: string): number {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length;
  const words = text.trim().split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  return Math.max(1, Math.round(cjk / 400 + words / 230));
}

// ── tier 换算 ────────────────────────────────────────────────
//
// 放在这里（而不是 routes 或 UI）的理由：tier 是**写库时**派生出来的，
// 存进 entry_analysis.tier 供列表筛选与索引使用。每次查询现算的话，
// `WHERE tier = 'must_read'` 就用不上 idx_analysis_tier。

export type Tier = 'must_read' | 'worth' | 'normal' | 'noise';

/** 分级阈值。2.3 的判据②逐个断言 39/40/69/70/89/90 这六个数 */
export const TIER_BOUNDS = {
  mustRead: 90,
  worth: 70,
  normal: 40,
} as const;

/**
 * importance → tier。
 *
 * 边界选择：**左闭右开**，即 90 是 must_read、89 是 worth。
 * 为什么是左闭：提示词里写的是"90+ 行业格局变化"，用户照这个数打分，
 * 90 就该是 must_read；若写成 90 是 worth，提示词与实现就差一格，
 * 黄金测试集的对齐会在边界上反复打架。
 */
export function tierForImportance(importance: number): Tier {
  const v = Number.isFinite(importance) ? importance : 0;
  if (v >= TIER_BOUNDS.mustRead) return 'must_read';
  if (v >= TIER_BOUNDS.worth) return 'worth';
  if (v >= TIER_BOUNDS.normal) return 'normal';
  return 'noise';
}

void FALLBACK_SLUG;
