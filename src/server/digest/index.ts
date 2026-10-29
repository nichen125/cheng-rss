import type { DatabaseSync } from 'node:sqlite';
import type { AiClient } from '../ai/client.ts';
import { DigestBodySchema, type DigestBody } from '../ai/schema.ts';
import { describeSingleSource } from '../cluster/summarize.ts';

// 简报生成（PLAN §9.3 / §19.5 3.3）。
//
// 整份简报的**唯一安全边界**在这里：模型不许写 URL，只能写 {{cite:id}}。
// 为什么是"占位符由程序替换"而不是"生成后校验 URL 合法性"：
//   · 校验只能判"像不像 URL"，判不出"这个链接指向的是不是它说的那件事"
//   · 模型非常擅长写 https://example.com/xxx 这种看起来合理的死链
//   · 占位符方案的失败模式是"没有链接"，那是可见的缺陷；伪造链接的失败
//     模式是"有链接但错"，用户要点了才知道 —— 后者严重得多
//
// 因此渲染时对不存在的 id **直接删掉整条引用**并留一个可见标记，
// 而不是猜一个最接近的。

export const DIGEST_PROMPT_VERSION = 'digest-v1';

/** §9.1：取 heat 排序前 12 簇 */
export const MAX_DIGEST_CLUSTERS = 12;
/** §9.3：今日要点 3 条 */
export const HIGHLIGHT_COUNT = 3;

export const DIGEST_SYSTEM = `你是一名新闻简报主编。根据给出的事件卡片，写一份当日简报。

硬性要求：
1. title 是这一天的概括（不是"日报"这种空话）。
2. highlights 恰好 3 条，各一句，是最重要的事。
3. body_md 用 Markdown，分主题展开，每主题 2~4 句。
   每个论断后面**必须**紧跟形如 {{cite:cl_xxx}} 的引用占位符，
   其中的 id 只能取输入里给出的 id。
4. worth_reading 填 1~3 条"低热度但值得读"的事件 id。
5. 绝对不能自己写 URL、链接或"来源：xxx"。引用一律用占位符。
6. 输入里标了"单一来源"的主题，正文里必须写明"单一来源，待验证"。
7. 只输出 JSON，不要解释文字或 Markdown 围栏。`;

export interface DigestClusterInput {
  id: string;
  title: string;
  summary: string | null;
  keyPoints: string[];
  consensus: string[];
  conflicts: { claim: string; sources: string[] }[];
  entryCount: number;
  sourceCount: number;
  heat: number;
}

/**
 * 把簇卡片渲染成喂给模型的文本。
 *
 * id 显式写出来（`id=cl_abc`）是关键：模型必须能原样抄进 {{cite:...}}。
 * 只给标题的话它会自己编一个"cl_1"之类的短 id，而那些 id 在渲染时
 * 全部会被判为无效 —— 整份简报的引用就空了。
 */
export function buildDigestUser(clusters: DigestClusterInput[]): string {
  const parts = clusters.map((c, i) => {
    const lines = [
      `【事件 ${i + 1}】id=${c.id}`,
      `标题：${c.title}`,
      `来源数：${c.sourceCount}｜条目数：${c.entryCount}｜热度：${c.heat}`,
    ];
    const single = describeSingleSource(c.sourceCount);
    if (single) lines.push(`标注：${single}`);
    if (c.summary) lines.push(`综述：${c.summary}`);
    if (c.keyPoints.length) lines.push(`要点：${c.keyPoints.join('；')}`);
    if (c.consensus.length) lines.push(`多方一致：${c.consensus.join('；')}`);
    if (c.conflicts.length) {
      lines.push('分歧：' + c.conflicts
        .map((x) => `${x.claim}（${x.sources.join(' vs ')}）`).join('；'));
    }
    return lines.join('\n');
  });
  return `今日共 ${clusters.length} 个事件。\n\n` + parts.join('\n\n---\n\n');
}

// ── 引用替换 ──────────────────────────────────────────────────

const CITE_RE = /\{\{cite:([A-Za-z0-9_-]+)\}\}/g;

/**
 * 裸 URL。模型偶尔无视"不许写 URL"的指令 —— 它见过太多"据 xxx 报道
 * （https://...）"的语料。这些链接一旦渲染出去，用户很难分辨"这是模型
 * 编的"还是"这是真实来源"，而点开一个 404 或钓鱼链接的代价远高于
 * 少一个链接。所以一律抹掉并留可见标记。
 *
 * 只抹 http(s) 与 markdown 链接语法两种。纯文本里的 "example.com"
 * 不抹 —— 它不构成可点击的链接，且可能是正文里正常提到的一个域名。
 */
const URL_RE = /https?:\/\/[^\s)\]"'<>]+/gi;
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;

export interface RenderResult {
  md: string;
  /** 展示给用户的已替换结果（正文 + 引用变成 [n] 形式的脚注） */
  citations: { index: number; id: string; title: string }[];
  /** 模型写了但输入里不存在的 id —— 必须可见，不能静默删 */
  invalid: string[];
  /** 被抹掉的裸 URL（可观测：出现就说明模型在违反指令） */
  strippedUrls: string[];
}

/**
 * 把 `{{cite:id}}` 换成脚注标记，并返回脚注表。
 *
 * 不做成 `[标题](url)` 内联链接的理由：同一簇在正文里会被引用多次，
 * 内联会让正文被长标题撑得很碎。脚注把"哪几件事"放在文末统一列出。
 */
export function renderCitations(
  md: string,
  clusters: Map<string, { title: string }>,
): RenderResult {
  const order: string[] = [];
  const invalid: string[] = [];
  const strippedUrls: string[] = [];
  const seen = new Set<string>();

  // ① 先抹裸 URL 与 markdown 链接，再做占位符替换。
  //    顺序很重要：URL 里可能含 `[` `]`，先替换占位符会让 URL 正则
  //    吃到正文里刚生成的脚注标记。
  let work = md.replace(MD_LINK_RE, (m, text: string, target: string) => {
    // 保留可见文字，丢掉目标 —— 文字通常是有意义的（"路透社报道"）
    strippedUrls.push(target);
    void m;
    return text || '[链接已移除]';
  });
  work = work.replace(URL_RE, (m) => {
    strippedUrls.push(m);
    return '[链接已移除]';
  });

  const replaced = work.replace(CITE_RE, (_m, id: string) => {
    if (!clusters.has(id)) {
      if (!invalid.includes(id)) invalid.push(id);
      // 换成可见标记而不是空串：静默删除会让"有 5 条引用"和"有 2 条"
      // 看起来一样，而前者说明模型在编 id
      return '[?]';
    }
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
    return `[${order.indexOf(id) + 1}]`;
  });

  return {
    md: replaced,
    citations: order.map((id, i) => ({
      index: i + 1,
      id,
      title: clusters.get(id)!.title,
    })),
    invalid,
    strippedUrls: [...new Set(strippedUrls)],
  };
}

// ── 生成 ──────────────────────────────────────────────────────

export interface DigestResult {
  ok: boolean;
  body: DigestBody | null;
  rendered: RenderResult | null;
  failure: string | null;
}

export async function generateDigestBody(
  client: AiClient,
  clusters: DigestClusterInput[],
  opts: { userId?: string; model?: string } = {},
): Promise<DigestResult> {
  if (clusters.length === 0) {
    return { ok: false, body: null, rendered: null, failure: '没有可用的簇' };
  }

  const use = clusters.slice(0, MAX_DIGEST_CLUSTERS);
  const map = new Map(use.map((c) => [c.id, { title: c.title }]));

  const r = await client.chatJson({
    schema: DigestBodySchema,
    system: DIGEST_SYSTEM,
    user: buildDigestUser(use),
    model: opts.model ?? client.config.models.strong,
    purpose: 'digest',
    userId: opts.userId,
    maxTokens: 2000,
    signalName: 'digest',
  });

  if (!r.ok) {
    return {
      ok: false, body: null, rendered: null,
      failure: `${r.failure.kind}: ${r.failure.message}`,
    };
  }

  return { ok: true, body: r.data, rendered: renderCitations(r.data.body_md, map), failure: null };
}

/**
 * 模型完全没写引用时的兜底。
 *
 * 这种情况比"写了 12 个引用坏了 2 个"更麻烦：正文看起来完好，但每个论断
 * 都无法追溯到具体事件。此时按 body 里出现的**标题关键词**回填不合适
 * （等于猜），正确做法是把当日 heat 前几名直接挂到文末 —— 让用户知道
 * "今天这几件最重要"，即使正文没有逐句绑定。
 */
export function fallbackCitations(
  clusters: DigestClusterInput[],
  limit = 5,
): { index: number; id: string; title: string }[] {
  return clusters.slice(0, limit).map((c, i) => ({ index: i + 1, id: c.id, title: c.title }));
}

// ── 落库 ──────────────────────────────────────────────────────

export interface SaveDigestInput {
  userId: string;
  kind: string;
  body: DigestBody;
  periodStart: number;
  periodEnd: number;
  entryCount: number;
  clusterCount: number;
  model: string | null;
  costUsd: number | null;
  now?: number;
}

/**
 * 写入 digests。
 *
 * 用 `INSERT ... ON CONFLICT(user_id, kind, period_start) DO UPDATE`：
 * 同一天重跑简报应该是**覆盖**，不是新增一份。否则用户 08:00 看一份、
 * 09:00 重跑又看一份，而两份内容不同且没有"哪份是新的"的标记。
 *
 * id 保持不变（不重新生成）：简报可能已经被推送到邮件/Webhook，
 * 换 id 会让那些地方引用的旧链接失效。
 */
export function saveDigest(db: DatabaseSync, input: SaveDigestInput): string {
  const now = input.now ?? Date.now();
  const existing = db.prepare(
    'SELECT id FROM digests WHERE user_id = ? AND kind = ? AND period_start = ?',
  ).get(input.userId, input.kind, input.periodStart) as { id: string } | undefined;

  const id = existing?.id ?? `dg_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  db.prepare(`
    INSERT INTO digests (id, user_id, kind, title, intro, body_md, period_start, period_end,
      entry_count, cluster_count, model, cost_usd, delivered_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)
    ON CONFLICT(user_id, kind, period_start) DO UPDATE SET
      title = excluded.title,
      intro = excluded.intro,
      body_md = excluded.body_md,
      period_end = excluded.period_end,
      entry_count = excluded.entry_count,
      cluster_count = excluded.cluster_count,
      model = excluded.model,
      cost_usd = excluded.cost_usd,
      created_at = excluded.created_at
  `).run(
    id, input.userId, input.kind, input.body.title,
    input.body.highlights.join('\n'),
    input.body.body_md,
    input.periodStart, input.periodEnd,
    input.entryCount, input.clusterCount,
    input.model, input.costUsd, now,
  );
  return id;
}

/** 本地日历日的起止（§9.3 每天 08:00 生成"昨天"的简报） */
export function localDayRange(t: number): { start: number; end: number } {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  const e = new Date(start);
  e.setDate(e.getDate() + 1);
  return { start, end: e.getTime() };
}
