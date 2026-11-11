import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, Variables } from '../app.ts';
import { requireUserId } from '../auth/require-user.ts';
import { badRequest, notFound } from '../errors.ts';
import { readBody } from '../http/validate.ts';
import { makeAnchor, resolveAnchor, insertHighlight, toApi, type HighlightRow } from '../highlights/anchor.ts';
import { generateInsight, sliceContext } from '../highlights/insight.ts';
import { aiForUser, runtimeAiBase } from '../ai/service.ts';
import { unpackText } from '../db/text-blob.ts';
import { htmlToText } from '../feeds/parse.ts';
import type { HighlightListItem, HighlightListResponse } from '../../shared/dto.ts';

// 高亮 API（PLAN §11.2 / §19.6 M4 第四步）。
//
// 三个刻意的设计：
//   1. 创建时**由服务端算 anchor**（不是信前端传的 pos）。用户从浏览器发来
//      start/end，服务端拿当前正文切一遍确认——前端可能拿着旧正文（页面
//      开了很久、后台重提取过），那份偏移与库里不一致。
//   2. 列表**包含 orphaned**，且带 `isOrphaned` 标记。§11.1 的硬要求是
//      "不静默丢"，那就必须让它们出现在列表里。
//   3. 颜色只接受三个值。§11.3 明确"三种色即可，不做调色盘 —— 选择过载
//      会让人不用"。允许任意字符串会让前端与后端各存一套命名。

export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue'] as const;
export type HighlightColor = typeof HIGHLIGHT_COLORS[number];

// ── 请求体 schema ────────────────────────────────────────────
//
// color 这里只校验"是不是字符串"，三个合法值仍交给 pickColor 判 ——
// 那条报错文案（`color 只能是 yellow / green / blue`）是前端提示的一部分，
// 换成 zod 生成的措辞属于无谓的行为变化。
const createHighlightBody = z.object({
  entryId: z.string().nullish(),
  start: z.number().nullish(),
  end: z.number().nullish(),
  quote: z.string().nullish(),
  color: z.string().nullish(),
  note: z.string().nullish(),
});

const patchHighlightBody = z.object({
  color: z.string().nullish(),
  note: z.string().nullish(),
});

const forceBody = z.object({ force: z.boolean().nullish() });

function pickColor(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !(HIGHLIGHT_COLORS as readonly string[]).includes(v)) {
    throw badRequest(`color 只能是 ${HIGHLIGHT_COLORS.join(' / ')}`);
  }
  return v;
}

/**
 * 取条目的**纯文本**正文，作为高亮的定位基准。
 *
 * 正文存在 entry_contents.html（gzip BLOB），没有现成的纯文本列，
 * 所以这里解压 + htmlToText。
 *
 * 为什么按纯文本而不是 HTML 定位：标签一变（清洗规则调整、把 <br> 换成 <p>）
 * 全文偏移就全变了，而纯文本不受标签变化影响 —— 那正是 §11.1 要三选择器的意义。
 *
 * 返回 null = 条目不存在（→404）；返回空串 = 条目在但正文还没提取到
 * （要告诉用户"正文还没到"，而不是"找不到这段文字"）。
 */
function entryText(ctx: AppContext, userId: string, entryId: string): string | null {
  const row = ctx.dbh.db.prepare(
    'SELECT id FROM entries WHERE id = ? AND user_id = ?',
  ).get(entryId, userId) as { id: string } | undefined;
  if (!row) return null;

  const c = ctx.dbh.db.prepare('SELECT html FROM entry_contents WHERE entry_id = ?')
    .get(entryId) as { html: Uint8Array | null } | undefined;
  return htmlToText(unpackText(c?.html) ?? '');
}

export function highlightRoutes(ctx: AppContext): Hono<{ Variables: Variables }> {
  const r = new Hono<{ Variables: Variables }>();

  r.get('/entries/:id/highlights', (c) => {
    const uid = requireUserId(c);
    const entryId = c.req.param('id');
    const rows = ctx.dbh.db.prepare(`
      SELECT * FROM highlights WHERE user_id = ? AND entry_id = ?
      ORDER BY COALESCE(pos_start, 1e18), created_at
    `).all(uid, entryId) as unknown as HighlightRow[];
    // 排序把 orphaned（pos 为 NULL）放最后：它们没有位置，混在中间会让前端
    // 的"按位置跳转"逻辑要多一次判断
    return c.json({ items: rows.map(toApi) });
  });

  r.post('/highlights', async (c) => {
    const uid = requireUserId(c);
    const body = await readBody(c, createHighlightBody);
    const entryId = String(body.entryId ?? '');
    if (!entryId) throw badRequest('缺少 entryId');

    const text = entryText(ctx, uid, entryId);
    if (text === null) throw notFound('条目不存在');

    // 优先用 start/end（用户在浏览器里选的精确位置），但要**当场校验**：
    // 前端拿的正文可能已经旧了（页面开着时后台重新提取过）。
    let anchor;
    if (typeof body.start === 'number' && typeof body.end === 'number'
      && body.end > body.start) {
      const slice = text.slice(body.start, body.end);
      if (body.quote && slice !== body.quote) {
        // 偏移对不上 → 退回按 quote 搜，别存一条必然错位的高亮
        const found = resolveAnchor(text, { exact: body.quote });
        if (found.start === null) {
          throw badRequest('选中的文字在当前正文里找不到（正文可能刚更新过），请重新选择');
        }
        anchor = makeAnchor(text, found.start as number, found.end as number);
      } else {
        anchor = makeAnchor(text, body.start, body.end);
      }
    } else if (body.quote) {
      const found = resolveAnchor(text, { exact: body.quote });
      if (found.start === null) throw badRequest('选中的文字在当前正文里找不到，请重新选择');
      anchor = makeAnchor(text, found.start as number, found.end as number);
    } else {
      throw badRequest('需要 start/end 或 quote 之一');
    }

    const id = insertHighlight(ctx.dbh.db, {
      userId: uid, entryId, anchor,
      color: pickColor(body.color),
      note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
    });
    const row = ctx.dbh.db.prepare('SELECT * FROM highlights WHERE id = ?')
      .get(id) as unknown as HighlightRow;
    return c.json(toApi(row), 201);
  });

  r.patch('/highlights/:id', async (c) => {
    const uid = requireUserId(c);
    const id = c.req.param('id');
    const body = await readBody(c, patchHighlightBody);

    const cur = ctx.dbh.db.prepare(
      'SELECT * FROM highlights WHERE id = ? AND user_id = ?',
    ).get(id, uid) as unknown as HighlightRow | undefined;
    if (!cur) throw notFound('高亮不存在');

    // 只更新**传了**的字段。用 COALESCE 会有一个坑：想把 note 清空时
    // 传空串会被当成"没传"，于是永远清不掉。这里显式判断 key 是否存在。
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if ('color' in body) {
      sets.push('color = ?');
      vals.push(pickColor(body.color));
    }
    if ('note' in body) {
      const n = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
      sets.push('note = ?');
      vals.push(n);
    }
    if (sets.length === 0) throw badRequest('没有要改的字段');

    sets.push('updated_at = ?');
    vals.push(Date.now());
    vals.push(id);
    ctx.dbh.db.prepare(`UPDATE highlights SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    const row = ctx.dbh.db.prepare('SELECT * FROM highlights WHERE id = ?')
      .get(id) as unknown as HighlightRow;
    return c.json(toApi(row));
  });

  r.delete('/highlights/:id', (c) => {
    const uid = requireUserId(c);
    const res = ctx.dbh.db.prepare(
      'DELETE FROM highlights WHERE id = ? AND user_id = ?',
    ).run(c.req.param('id'), uid);
    if (Number(res.changes ?? 0) === 0) throw notFound('高亮不存在');
    return c.json({ ok: true });
  });

  /**
   * 全局列表（跨条目）。
   *
   * 游标分页而不是 offset：高亮会被删，offset 分页在有删除时会漏行
   * （删掉第 1 页的一条，第 2 页的第一条就跳过了）。
   */
  r.get('/highlights', (c) => {
    const uid = requireUserId(c);
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 30)));
    const cursor = c.req.query('cursor');
    const entryId = c.req.query('entryId');
    const color = c.req.query('color');

    const where: string[] = ['h.user_id = ?'];
    const vals: (string | number | null)[] = [uid];
    if (entryId) { where.push('h.entry_id = ?'); vals.push(entryId); }
    if (color) { where.push('h.color = ?'); vals.push(color); }
    if (cursor) {
      const t = Number(cursor);
      if (Number.isFinite(t)) { where.push('h.created_at < ?'); vals.push(t); }
    }

    const rows = ctx.dbh.db.prepare(`
      SELECT h.*, e.title AS entry_title, COALESCE(f.title,'未知来源') AS source_name
        FROM highlights h
        JOIN entries e ON e.id = h.entry_id
        LEFT JOIN feeds f ON f.id = e.feed_id
       WHERE ${where.join(' AND ')}
       ORDER BY h.created_at DESC
       LIMIT ?
    `).all(...vals, limit + 1) as unknown as (HighlightRow & {
      entry_title: string; source_name: string;
    })[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items: HighlightListItem[] = page.map((h) => ({
      ...toApi(h),
      entryTitle: h.entry_title,
      sourceName: h.source_name,
    }));
    const body: HighlightListResponse = {
      items,
      nextCursor: hasMore ? String(page[page.length - 1]?.created_at ?? '') : null,
    };
    return c.json(body);
  });

  /**
   * 单条解读（§11.4）。
   *
   * **同步**返回，不像简报那样走任务队列：用户点了「解读」就是现在要看，
   * 排进队列再轮询的体验更差。代价是这次请求要等 1~3 秒。
   *
   * 缓存：已算过就直接返回，除非 `force: true`。与 /entries/:id/analyze
   * 一致 —— 用户可能想重算（换了模型、觉得上次答得不好）。
   */
  r.post('/highlights/:id/insight', async (c) => {
    const uid = requireUserId(c);
    const id = c.req.param('id');
    const body = await readBody(c, forceBody);

    const h = ctx.dbh.db.prepare(
      'SELECT * FROM highlights WHERE id = ? AND user_id = ?',
    ).get(id, uid) as unknown as HighlightRow | undefined;
    if (!h) throw notFound('高亮不存在');

    if (!body.force && h.ai_insight) {
      return c.json({ ok: true, insight: h.ai_insight, cached: true, costUsd: 0 });
    }

    const entry = ctx.dbh.db.prepare(`
      SELECT e.title AS title, COALESCE(f.title, e.site_name) AS source_name
        FROM entries e LEFT JOIN feeds f ON f.id = e.feed_id
       WHERE e.id = ? AND e.user_id = ?
    `).get(h.entry_id, uid) as { title: string; source_name: string | null } | undefined;
    if (!entry) throw notFound('条目不存在');

    const text = entryText(ctx, uid, h.entry_id) ?? '';
    const cx = sliceContext(text, h.pos_start, h.pos_end, h.quote_exact);

    // 用 runtimeAiBase 而不是直接传 ctx.cfg.ai（v2.0）：后者少了 dataDir，
    // 于是界面上填的 key（data/secrets.json）在这条路径上不生效 ——
    // 症状是"别处分析正常，只有 AI 解读说没配 key"。
    const ai = aiForUser(ctx.dbh.db, uid, runtimeAiBase(ctx.cfg));
    const r = await generateInsight(ai.client, {
      quote: h.quote_exact,
      note: h.note,
      contextBefore: cx.before,
      contextAfter: cx.after,
      entryTitle: entry.title,
      sourceName: entry.source_name,
    }, { userId: uid });

    if (!r.ok) {
      // 失败也返回 200 + ok:false，不用 4xx：没配 key 不是"请求错了"，
      // 前端要显示的是「去配 key」，而不是一个红色报错。
      return c.json({
        ok: false,
        insight: null,
        failureKind: r.failure?.kind ?? 'unknown',
        message: r.failure?.message ?? '解读失败',
        costUsd: r.costUsd,
      });
    }

    ctx.dbh.db.prepare('UPDATE highlights SET ai_insight = ?, updated_at = ? WHERE id = ?')
      .run(r.insight, Date.now(), id);

    return c.json({ ok: true, insight: r.insight, cached: false, costUsd: r.costUsd });
  });

  return r;
}
