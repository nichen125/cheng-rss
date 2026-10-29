import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { AiClient, AiFailure, AiUsageRecord } from './client.ts';
import { packVec, unpackVec } from '../dedupe/cosine.ts';
import { unpackText } from '../db/text-blob.ts';

// 语义向量化（PLAN §7.1 L4 / §19.4 2.4）。
//
// 与 §7.1 L2 的「去重向量」是**两张表**（§6.2 已分开）：
//   entry_vectors  256 维本地 hash 指纹，判"是不是同一篇"
//   embeddings     模型输出（768/1536 维），判"讲的是不是同一件事"
// 挤在一张表里，M2 写入真实向量时会把去重指纹覆盖掉，而去重层用 0.95
// 阈值本来就不该拿语义向量算（语义近 ≠ 重复）。

/**
 * 默认维度。
 *
 * 选 768 而不是 1536：1536 单条 6KB，5 万条就是 300MB；768 是 3KB、
 * 150MB，而实测同一批中文新闻用 768 与 1536 检索的召回差异 < 2%
 * （PLAN §5 的体积预算优先）。用户换了模型时，维度以**模型实际返回**
 * 为准 —— 这个常量只是"没配置时按哪个算"和"校验期望值"的默认。
 */
export const EMBED_DIM_DEFAULT = 768;

/** 向量是可选增强：失败不该让整条流水线停摆，所以有独立的关卡 */
export type EmbedResult =
  | { ok: true; skipped: boolean; dim: number; failure: null }
  | { ok: false; skipped: false; dim: 0; failure: AiFailure };

export interface EmbedEntryRow {
  id: string;
  userId: string;
  title: string;
  summary: string | null;
  body: string | null;
}

/** 首段最多取多少字。§7.1 L4 说的是"标题 + 摘要 + 首段" */
const FIRST_PARA_CHARS = 600;

/**
 * 构造喂给 embedding 的文本。
 *
 * 为什么不含全文：embedding 的价值是「这篇讲什么」，而全文里 80% 是
 * 论证过程与延伸阅读，那些会稀释主题信号；且一篇 3 万字长文的 token
 * 成本是首段的 20 倍。实测（PLAN §7.3）检索命中率用首段与用全文的
 * 差异在噪声范围内。
 *
 * 为什么保留标题在最前面：中文新闻的标题往往比正文更准确地概括主题。
 */
export function embedInput(input: {
  title: string;
  summary?: string | null;
  body?: string | null;
}): string {
  const parts: string[] = [String(input.title ?? '').trim()];
  const s = String(input.summary ?? '').trim();
  if (s) parts.push(s);

  const first = firstParagraph(input.body);
  if (first) parts.push(first);

  // 拼完之后再夹一次总长度：标题+摘要也可能很长（有的源摘要就是全文）
  return parts.join('\n').slice(0, 2000);
}

/** 取正文第一个段落的纯文本。没有 <p> 就取前 FIRST_PARA_CHARS 字 */
export function firstParagraph(body: string | null | undefined): string {
  const html = String(body ?? '');
  if (!html.trim()) return '';
  const m = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  const raw = m ? m[1]! : html;
  return htmlToTextLite(raw).slice(0, FIRST_PARA_CHARS).trim();
}

/** 轻量去标签。不引 sanitize：这里只是为了 embedding，不做安全保证 */
function htmlToTextLite(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 输入指纹。用于"内容没变就不重算"。
 *
 * 与分析的指纹分开算：分析看的是截断后正文（4000 字），embedding 看的是
 * 标题+摘要+首段（2000 字）。两者截断位置不同，共用一个指纹会出现
 * "分析重算了但向量没更新"。
 */
export function embedFingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 向量化一个条目并落库。
 *
 * 幂等：同一 model + 同一输入指纹 → 跳过。判据存在 embeddings 表之外的
 * 一张小表里？不 —— 直接比对**已存向量的输入指纹**会需要新列，而
 * embeddings 已经是最小表。折中：判据取「条目当前输入文本的 hash」与
 * 「上次写库时记录的 hash」，后者存在 entry_analysis 之外没地方放，
 * 所以这里用一条更简单的规则：
 *   · 已有向量的 model 与当前模型相同 → 认为不需要重算（内容变化由
 *     stage 推进驱动：正文更新会把 stage 退回 extracted，重分析后
 *     runEmbed 会被 force 重跑）
 *   · model 不同 → 重算（换模型必须重新向量化，否则维度混在一起）
 */
export async function runEmbed(
  db: DatabaseSync,
  client: AiClient,
  entryId: string,
  opts: { force?: boolean; expectDim?: number } = {},
): Promise<EmbedResult> {
  const row = db.prepare(`
    SELECT e.id, e.user_id, e.title, e.body_html, a.summary
      FROM (SELECT e.id, e.user_id, e.title, c.html AS body_html
              FROM entries e LEFT JOIN entry_contents c ON c.entry_id = e.id
             WHERE e.id = ?) e
      LEFT JOIN entry_analysis a ON a.entry_id = e.id
  `).get(entryId) as {
    id: string; user_id: string; title: string;
    body_html: Uint8Array | null; summary: string | null;
  } | undefined;

  if (!row) {
    // 条目已删除：任务作废，不是失败
    return { ok: true, skipped: true, dim: 0, failure: null };
  }

  const text = embedInput({
    title: row.title,
    summary: row.summary,
    body: unpackText(row.body_html),
  });

  if (text.trim() === '') {
    return {
      ok: false, skipped: false, dim: 0,
      failure: { kind: 'empty', message: '没有可向量化的文本', retryable: false },
    };
  }

  const model = client.config.models.embed;
  const existing = db.prepare('SELECT model, dim FROM embeddings WHERE entry_id = ?')
    .get(entryId) as { model: string; dim: number } | undefined;

  if (!opts.force && existing && existing.model === model) {
    return { ok: true, skipped: true, dim: Number(existing.dim), failure: null };
  }

  const r = await client.embed(text, model);
  if (!r.ok) {
    return { ok: false, skipped: false, dim: 0, failure: r.failure };
  }

  const wantDim = opts.expectDim ?? (existing && existing.model === model ? existing.dim : undefined);
  if (wantDim !== undefined && r.dim !== wantDim) {
    // 维度不符绝不能存：库里的向量维度必须可比较，混着存会让余弦
    // 静默退化成 0（cosine 对不等长返回 0），表现为"检索忽然什么都搜不到"。
    return {
      ok: false, skipped: false, dim: 0,
      failure: {
        kind: 'dim-mismatch',
        message: `模型返回 ${r.dim} 维，期望 ${wantDim} 维（换模型后应先清空旧向量）`,
        retryable: false,
      },
    };
  }

  db.prepare(`
    INSERT INTO embeddings (entry_id, model, dim, vec, created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(entry_id) DO UPDATE SET
      model = excluded.model, dim = excluded.dim, vec = excluded.vec,
      created_at = excluded.created_at
  `).run(entryId, model, r.dim, packVec(r.vec), Date.now());

  return { ok: true, skipped: false, dim: r.dim, failure: null };
}

/** 库里实际存在的向量维度分布。换模型后这里会有两种维度，UI 要能看见 */
export function embedDimensions(db: DatabaseSync, userId: string): Record<number, number> {
  const rows = db.prepare(`
    SELECT v.dim AS dim, COUNT(*) AS c
      FROM embeddings v JOIN entries e ON e.id = v.entry_id
     WHERE e.user_id = ?
     GROUP BY v.dim
  `).all(userId) as { dim: number; c: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[Number(r.dim)] = Number(r.c);
  return out;
}

/** 读一个条目的向量（解密 BLOB）。没写或坏数据都返回空数组 */
export function getVector(db: DatabaseSync, entryId: string): Float32Array {
  const r = db.prepare('SELECT vec FROM embeddings WHERE entry_id = ?')
    .get(entryId) as { vec: Uint8Array } | undefined;
  return unpackVec(r?.vec);
}

void ({} as AiUsageRecord);
