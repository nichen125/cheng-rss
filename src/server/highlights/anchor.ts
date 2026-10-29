import type { DatabaseSync } from 'node:sqlite';

// 高亮的锚定与恢复（PLAN §11.1 / §19.6 M4 第一步）。
//
// 这个模块只做**纯文本层**的定位：不做 DOM、不碰 XPath。理由：
//   · XPath 是浏览器侧的表示，服务端无法验证，也无法在正文重新提取后
//     重算 —— 它只能原样存着等前端去试
//   · 微信/RSS 正文经过清洗后，段落结构会变，而字符偏移与引文更稳定
// 所以判断"这条高亮还活着吗"的责任，落在 position → quote 两级上；
// range 只是留给前端在两者都失配时的最后一次机会。

/** quote 搜索时前后各取多少字符做唯一性约束（§11.1 说 32） */
export const CONTEXT_CHARS = 32;

/** 高亮存下来时用的三选择器（与 W3C Web Annotation 对齐） */
export interface HighlightAnchor {
  exact: string;
  prefix?: string | null;
  suffix?: string | null;
  posStart?: number | null;
  posEnd?: number | null;
  rangeJson?: string | null;
}

export interface ResolvedAnchor {
  /** 最终定位到的 [start, end)。找不到时为 null */
  start: number | null;
  end: number | null;
  /** 用哪一级定位成功的。none 表示全部失配 */
  via: 'position' | 'quote' | 'range' | 'none';
  /** 失配的观察：position 那级校验过吗、quote 匹配了几次 */
  note: string;
}

/**
 * 按 §11.1 的降级链解析一条高亮。
 *
 * `text` 是**当前**的正文纯文本。如果把这条高亮按 position 切出来等于
 * quote.exact，说明偏移没漂移，直接用 —— 这是最快也最准的一级。
 *
 * ⚠ position 一级**必须校验 quote**，不能"位置存在就算命中"。
 * 只信 position 的话，正文在最前面多了一段（典型：提取器升级后加上了
 * 导语），整篇所有高亮会**整体偏移但都"找到"了**，用户看到是"高亮跑到
 * 别处去了"，比"找不到"更难发现问题。
 */
export function resolveAnchor(text: string, a: HighlightAnchor): ResolvedAnchor {
  const exact = a.exact ?? '';
  if (!exact) {
    return { start: null, end: null, via: 'none', note: 'quote 为空' };
  }

  // ── 第 1 级：position + quote 校验 ──────────────────────
  if (typeof a.posStart === 'number' && typeof a.posEnd === 'number'
    && a.posStart >= 0 && a.posEnd > a.posStart && a.posEnd <= text.length) {
    if (text.slice(a.posStart, a.posEnd) === exact) {
      return { start: a.posStart, end: a.posEnd, via: 'position', note: '偏移未变' };
    }
    // 偏移漂了，但只在附近 —— 记下来便于观察提取器改动的幅度
    const near = text.slice(Math.max(0, a.posStart - 200), a.posEnd + 200);
    const idx = near.indexOf(exact);
    if (idx >= 0) {
      const s = Math.max(0, a.posStart - 200) + idx;
      return { start: s, end: s + exact.length, via: 'quote', note: `偏移漂移 ${s - a.posStart} 字` };
    }
  }

  // ── 第 2 级：quote + prefix/suffix ───────────────────────
  const q = findByQuote(text, exact, a.prefix ?? null, a.suffix ?? null);
  if (q.start !== null) {
    return { start: q.start, end: q.end, via: 'quote', note: q.note };
  }

  // ── 第 3 级：只靠 quote 精确匹配（哪怕有歧义取第一个）───
  const first = text.indexOf(exact);
  if (first >= 0) {
    return {
      start: first, end: first + exact.length, via: 'quote',
      note: '无上下文约束，取首次出现（可能不是原位）',
    };
  }

  // ── 第 4 级：range 只能交给前端，服务端判 orphaned ─────
  return {
    start: null, end: null, via: 'none',
    note: a.rangeJson ? 'position 与 quote 都失配，range 待前端尝试' : 'position 与 quote 都失配',
  };
}

/**
 * 用 quote + 上下文找高亮位置。
 *
 * 上下文的作用是**消歧**：同一段文字在正文里出现多次时（常见于"点击
 * 这里"、转述的名言），单靠 exact 会取到第一处，而用户标的是第三处。
 *
 * 三种匹配强度，逐级放松：
 *   1. prefix+exact+suffix 全匹配
 *   2. 只有 exact+suffix 或 prefix+exact（一侧上下文够）
 *   3. 只靠 exact（交给调用方判断是否可接受）
 */
function findByQuote(
  text: string, exact: string, prefix: string | null, suffix: string | null,
): { start: number | null; end: number | null; note: string } {
  const hasPre = Boolean(prefix);
  const hasSuf = Boolean(suffix);

  // 收集所有出现位置（上限 50，避免在极长正文里做无谓扫描）
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(exact, from);
    if (i < 0 || hits.length >= 50) break;
    hits.push(i);
    from = i + 1;
  }
  if (hits.length === 0) return { start: null, end: null, note: 'quote 不存在' };

  const end = (s: number) => s + exact.length;
  const preOk = (s: number) => !hasPre
    || text.slice(Math.max(0, s - prefix!.length), s) === prefix;
  const sufOk = (s: number) => !hasSuf
    || text.slice(end(s), end(s) + suffix!.length) === suffix;

  // ① 上下文两侧都对
  if (hasPre || hasSuf) {
    const both = hits.find((s) => preOk(s) && sufOk(s));
    if (both !== undefined) {
      return { start: both, end: end(both), note: `上下文匹配（${hits.length} 处候选）` };
    }
    // ② 一侧对也算（正文在开头/结尾被截断时另一侧可能没了）
    const one = hits.find((s) => (hasPre ? preOk(s) : true) || (hasSuf ? sufOk(s) : true));
    if (one !== undefined) {
      return { start: one, end: end(one), note: `单侧上下文匹配（${hits.length} 处候选）` };
    }
  }

  if (hits.length === 1) {
    return { start: hits[0]!, end: end(hits[0]!), note: '唯一匹配' };
  }
  return { start: null, end: null, note: `歧义：${hits.length} 处且上下文都不匹配` };
}

/**
 * 生成一条高亮的锚定数据。
 *
 * 为什么把 prefix/suffix 单独取 32 字而不是存整段：
 * 正文可能上万字，10 条高亮就把整篇正文存了十遍。32 字足够消歧，
 * 也与 §11.1 的 JSON 示例一致。
 */
export function makeAnchor(text: string, start: number, end: number): HighlightAnchor {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  if (e === s) throw new Error('高亮区间为空');
  return {
    exact: text.slice(s, e),
    prefix: s > 0 ? text.slice(Math.max(0, s - CONTEXT_CHARS), s) : null,
    suffix: e < text.length ? text.slice(e, Math.min(text.length, e + CONTEXT_CHARS)) : null,
    posStart: s,
    posEnd: e,
    rangeJson: null,
  };
}

// ── 落库 ──────────────────────────────────────────────────────

export interface HighlightRow {
  id: string;
  entry_id: string;
  quote_exact: string;
  quote_prefix: string | null;
  quote_suffix: string | null;
  pos_start: number | null;
  pos_end: number | null;
  range_json: string | null;
  color: string | null;
  note: string | null;
  ai_insight: string | null;
  is_orphaned: number;
  created_at: number;
  updated_at: number;
}

export function insertHighlight(
  db: DatabaseSync,
  input: {
    userId: string; entryId: string; anchor: HighlightAnchor;
    color?: string | null; note?: string | null; now?: number;
  },
): string {
  const now = input.now ?? Date.now();
  const id = `hl_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO highlights (id, user_id, entry_id, quote_exact, quote_prefix, quote_suffix,
      pos_start, pos_end, range_json, color, note, ai_insight, is_orphaned, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,0,?,?)
  `).run(
    id, input.userId, input.entryId,
    input.anchor.exact, input.anchor.prefix ?? null, input.anchor.suffix ?? null,
    input.anchor.posStart ?? null, input.anchor.posEnd ?? null,
    input.anchor.rangeJson ?? null,
    input.color ?? null, input.note ?? null, now, now,
  );
  return id;
}

/**
 * 重新锚定某篇文章的所有高亮。
 *
 * 在**正文被重新提取后**调用。这是整条降级链的真正用途：不是"理论上
 * 可能失配"，而是每次提取器升级/清洗规则调整都会触发一次。
 *
 * 关键设计：**失败的标 orphaned，不删**。删掉的话用户再也找不回来；
 * 而"原文已变化，无法定位"单独列出来是可解释的，用户至少知道它存在过。
 */
export function reanchorEntry(
  db: DatabaseSync,
  entryId: string,
  text: string,
  now = Date.now(),
): { total: number; byVia: Record<string, number>; orphaned: number } {
  const rows = db.prepare(
    'SELECT * FROM highlights WHERE entry_id = ?',
  ).all(entryId) as unknown as HighlightRow[];

  const byVia: Record<string, number> = {};
  let orphaned = 0;

  const upd = db.prepare(`
    UPDATE highlights SET pos_start = ?, pos_end = ?, is_orphaned = ?, updated_at = ?
     WHERE id = ?
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const h of rows) {
      const r = resolveAnchor(text, {
        exact: h.quote_exact,
        prefix: h.quote_prefix,
        suffix: h.quote_suffix,
        posStart: h.pos_start,
        posEnd: h.pos_end,
        rangeJson: h.range_json,
      });
      byVia[r.via] = (byVia[r.via] ?? 0) + 1;
      if (r.via === 'none') orphaned++;
      upd.run(r.start, r.end, r.via === 'none' ? 1 : 0, now, h.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { total: rows.length, byVia, orphaned };
}

/** 从 row 转成前端要的形状（`created_at` 这些下划线名不该泄漏到 API） */
export function toApi(h: HighlightRow) {
  return {
    id: h.id,
    entryId: h.entry_id,
    quote: h.quote_exact,
    prefix: h.quote_prefix,
    suffix: h.quote_suffix,
    posStart: h.pos_start,
    posEnd: h.pos_end,
    color: h.color,
    note: h.note,
    aiInsight: h.ai_insight,
    isOrphaned: Boolean(h.is_orphaned),
    createdAt: h.created_at,
    updatedAt: h.updated_at,
  };
}
