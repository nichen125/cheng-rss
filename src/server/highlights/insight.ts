import type { DatabaseSync } from 'node:sqlite';
import type { AiClient } from '../ai/client.ts';
import type { AiFailure } from '../ai/client.ts';
import { HighlightInsightSchema } from '../ai/schema.ts';

// 高亮与 AI 的联动（PLAN §11.4）。
//
// §11.4 列了五种用途，这里实现**三种不依赖新基建的**：
//   · 单条解读（POST /highlights/:id/insight）
//   · 修正 importance（把近期高亮作为 few-shot 注入分析 prompt）
//   · 简报小节「你今天标记的要点」
// 另两种（高亮向量聚类、RAG 提权）依赖 M5 的检索与向量层，留到那里做 ——
// 现在做的话要先把 half-built 的向量管线接上，返工风险更大。
//
// 一个贯穿三种用途的原则：**高亮是用户主动信号，但不能替用户说话**。
// 所以解读只解释"他标这段为什么值得注意"，不提"你应该…"；few-shot 只给
// 校准方向而不是硬规则；简报小节只列原文，不加工。

export const INSIGHT_PROMPT_VERSION = 'highlight-insight-v1';

/** few-shot 最少几条才注入。1~2 条是噪声，会把 importance 整体抬高 */
export const FEWSHOT_MIN = 3;
/** 最多注入几条。多于 5 条会挤占正文的 token 预算（BODY_CLIP 4000） */
export const FEWSHOT_MAX = 5;
/** 每条示例的引文上限。150 字已足够看出主题，再长就是正文了 */
export const FEWSHOT_QUOTE_CLIP = 150;

export interface FewshotExample {
  quote: string;
  /** 标注这段时那篇文章的 importance（没有分析记录时为 null） */
  importance: number | null;
}

/**
 * 取近期高亮作为 few-shot。
 *
 * 三条约束都不是随手加的：
 *   1. **按用户隔离** —— 高亮是私人信号，串了就是数据泄漏
 *   2. 只取带引文的，且去掉重复引文 —— 同一段被标两次不该算两条示例
 *   3. 时间窗 30 天 —— 半年前的兴趣不代表现在
 */
export function recentHighlightsForFewshot(
  db: DatabaseSync, userId: string, now = Date.now(),
): FewshotExample[] {
  const since = now - 30 * 24 * 3600_000;
  const rows = db.prepare(`
    SELECT h.quote_exact AS quote, a.importance AS importance
      FROM highlights h
      LEFT JOIN entry_analysis a ON a.entry_id = h.entry_id
     WHERE h.user_id = ? AND h.created_at >= ? AND h.is_orphaned = 0
       AND LENGTH(TRIM(h.quote_exact)) >= 8
     ORDER BY h.created_at DESC
     LIMIT 40
  `).all(userId, since) as unknown as { quote: string; importance: number | null }[];

  const seen = new Set<string>();
  const out: FewshotExample[] = [];
  for (const r of rows) {
    const q = String(r.quote).trim().slice(0, FEWSHOT_QUOTE_CLIP);
    // 归一化后去重：只差空白/标点的两条在高亮场景下几乎总是同一段
    const key = q.replace(/\s+/g, '').slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ quote: q, importance: r.importance === null ? null : Number(r.importance) });
    if (out.length >= FEWSHOT_MAX) break;
  }
  return out;
}

/**
 * 是否值得注入 few-shot。
 *
 * 少于 FEWSHOT_MIN 条时**不注入**：1~2 条会让模型把这篇文章往"用户关心"
 * 的方向硬掰，而两篇的样本量根本说明不了兴趣。
 */
export function shouldInjectFewshot(examples: FewshotExample[]): boolean {
  return examples.length >= FEWSHOT_MIN;
}

/**
 * 拼 few-shot 段，接在分析 prompt 的正文之前。
 *
 * 措辞刻意保守：「可参考」「不要因为它而抬高无关文章」。写成
 * 「必须给高分」的话，用户标了两段芯片新闻，之后所有文章都会变 mustRead，
 * 分级就废了。
 */
export function buildFewshotBlock(examples: FewshotExample[]): string {
  if (!shouldInjectFewshot(examples)) return '';
  const lines = examples.map((e) => (
    e.importance === null
      ? `- “${e.quote}”`
      : `- “${e.quote}”（当时评分 ${e.importance}）`
  ));
  return `

用户近期主动标记过的高亮（这是他本人认为重要的信号，可作为 importance 打分的参考）：
${lines.join('\n')}
校准方式：与这些高亮主题接近的，评分可略高；主题无关的一律按原基准，不要因为它们而抬高。`;
}

// ── 单条解读 ────────────────────────────────────────────────

export const INSIGHT_SYSTEM = `你是一名阅读助手。用户在一篇文章里标了一段话，请解释这段话为什么值得注意。

硬性要求：
1. 只解释**这段话本身**的信息价值：它给出了什么事实、数字、判断，为什么这样的信息稀有或有后果。
2. 结合文章的上下文解释（比如这段话在反驳前文的什么说法）。
3. 不要复述原文超过一句；不要给建议（"你应该关注""建议进一步了解"这类一律不写）。
4. 不要编造原文与上下文都没有的信息。信息不足时直说"仅凭这一段无法判断"。
5. 输出 1~3 句中文，总长不超过 120 字。
6. 只输出 JSON，不要解释文字或 Markdown 围栏。`;

/** 解读时给模型看的上下文长度（引文前后各取多少字） */
export const INSIGHT_CONTEXT_CHARS = 600;

export interface InsightInput {
  quote: string;
  note: string | null;
  /** 引文在正文里的前后文（已裁好） */
  contextBefore: string;
  contextAfter: string;
  entryTitle: string;
  sourceName: string | null;
}

export function buildInsightUser(input: InsightInput): string {
  const lines = [
    `文章标题：${input.entryTitle}`,
    input.sourceName ? `来源：${input.sourceName}` : '',
    input.note ? `用户自己写的批注：${input.note}` : '',
    '',
    input.contextBefore ? `[前文]\n${input.contextBefore}\n` : '',
    `[用户标记的这段]\n${input.quote}`,
    input.contextAfter ? `\n[后文]\n${input.contextAfter}` : '',
  ];
  return lines.filter((x) => x !== '').join('\n');
}

/**
 * 按引文位置切出前后文。
 *
 * 用**已存的 pos**（重锚之后的）而不是重新搜引文：重锚已经把 pos 修正到
 * 当前位置了，再搜一次只会浪费，而且遇到重复文本时可能切到别处去。
 * pos 为 null（orphaned）时退回搜引文 —— 至少还能给出上下文。
 */
export function sliceContext(
  text: string, posStart: number | null, posEnd: number | null, exact: string,
  chars = INSIGHT_CONTEXT_CHARS,
): { before: string; after: string } {
  let s = posStart;
  let e = posEnd;
  if (s === null || e === null || text.slice(s, e) !== exact) {
    const i = text.indexOf(exact);
    if (i < 0) return { before: '', after: '' };
    s = i;
    e = i + exact.length;
  }
  return {
    before: text.slice(Math.max(0, s - chars), s),
    after: text.slice(e, Math.min(text.length, e + chars)),
  };
}

export interface InsightResult {
  ok: boolean;
  insight: string | null;
  failure: AiFailure | null;
  costUsd: number;
}

/**
 * 生成单条解读。
 *
 * 模型可能返回多余内容，也可能返回空 —— 两种都当失败，不要存几句话
 * 都算成"解读"。空字符串尤其危险：前端会渲染出一个空白气泡，用户以为
 * 功能坏了。
 */
export async function generateInsight(
  client: AiClient,
  input: InsightInput,
  opts: { userId: string },
): Promise<InsightResult> {
  const r = await client.chatJson({
    schema: HighlightInsightSchema,
    system: INSIGHT_SYSTEM,
    user: buildInsightUser(input),
    model: client.config.models.fast,
    purpose: 'highlight_insight',
    userId: opts.userId,
    maxTokens: 400,
  });

  if (!r.ok) return { ok: false, insight: null, failure: r.failure, costUsd: r.usage?.costUsd ?? 0 };

  const text = String((r.data as { insight?: string }).insight ?? '').trim();
  if (text === '') {
    // 空解读不落库：让调用方看到失败，而不是存一个空白字段
    return {
      ok: false, insight: null,
      failure: { kind: 'empty', message: '模型返回了空解读', retryable: true },
      costUsd: r.usage?.costUsd ?? 0,
    };
  }
  return { ok: true, insight: text, failure: null, costUsd: r.usage?.costUsd ?? 0 };
}

// ── 简报小节 ────────────────────────────────────────────────

/** 简报里「你今天标记的要点」最多列几条 */
export const DIGEST_HIGHLIGHT_MAX = 5;

export interface DigestHighlight {
  quote: string;
  entryTitle: string;
  note: string | null;
}

/**
 * 取某个时间窗内的高亮，给简报的独立小节用。
 *
 * 为什么**不交给模型写**：这一节的判据是"我今天标了什么"，而模型会
 * 概括、会漏、会改措辞。原文照列才对得上用户记忆里的那一段。
 */
export function listDayHighlights(
  db: DatabaseSync, userId: string, start: number, end: number,
  limit = DIGEST_HIGHLIGHT_MAX,
): DigestHighlight[] {
  const rows = db.prepare(`
    SELECT h.quote_exact AS quote, h.note AS note, e.title AS entry_title
      FROM highlights h
      JOIN entries e ON e.id = h.entry_id
     WHERE h.user_id = ? AND h.created_at >= ? AND h.created_at < ?
     ORDER BY h.created_at ASC
     LIMIT ?
  `).all(userId, start, end, limit) as unknown as {
    quote: string; note: string | null; entry_title: string;
  }[];
  return rows.map((r) => ({
    quote: String(r.quote),
    entryTitle: String(r.entry_title),
    note: r.note === null ? null : String(r.note),
  }));
}

/**
 * 渲染小节 Markdown。空列表返回空串 —— 调用方靠 `!== ''` 判断要不要
 * 追加，返回"\n\n**你今天标记的要点**"这种半截内容会让简报里出现一个
 * 没有内容的标题。
 */
export function renderDigestHighlightSection(items: DigestHighlight[]): string {
  if (items.length === 0) return '';
  const lines = items.map((h) => {
    const note = h.note ? `（批注：${h.note}）` : '';
    return `- **${h.entryTitle}**：“${h.quote}”${note}`;
  });
  return `\n\n---\n\n**你今天标记的要点**\n${lines.join('\n')}`;
}
