import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, Variables } from '../app.ts';
import { badRequest, notFound } from '../errors.ts';
import { requireUserId } from '../auth/require-user.ts';
import { readBody } from '../http/validate.ts';
import { log } from '../logger.ts';
import {
  cacheInfo, clearMemoryCache, loadLibrary, previewRoute, readSettings,
  refreshLibrary, RsshubError, searchRoutes, writeSettings,
} from '../rsshub/index.ts';

// RSSHub 订阅搜索 API（PLAN §10 / §18）。
//
// 四个端点，都不写条目数据 —— 它们只负责"帮用户找到可订阅的地址"。
// 真正的订阅仍走 POST /feeds，这样"从搜索订阅"与"粘贴地址订阅"
// 是同一条代码路径，不会各自演化出不同的校验。

// ── 请求体 schema ────────────────────────────────────────────
//
// 两个字段都必须保持"可选"而非带默认值：writeSettings 用 `undefined`
// 表示"这项别动"，若 schema 给个 '' 默认，改 accessKey 时会顺手把
// baseUrl 清回默认地址。
// 也不接受 null —— 下游 writeSettings 直接 .trim()，null 会崩成 500。
const rsshubConfigBody = z.object({
  baseUrl: z.string().optional(),
  accessKey: z.string().optional(),
});

const rsshubPreviewBody = z.object({
  path: z.string().nullish(),
  route: z.string().nullish(),
  // 只约束成"字符串到字符串"的映射：fillRoute 拿到的值会直接拼进 URL，
  // 数字/对象混进来会被静默转成 "[object Object]"，生成的预览地址必然 404。
  params: z.record(z.string()).nullish(),
});

export function rsshubRoutes(ctx: AppContext): Hono<{ Variables: Variables }> {
  const r = new Hono<{ Variables: Variables }>();

  // ── 读配置 ──────────────────────────────────────────────
  r.get('/rsshub/config', (c) => {
    const uid = requireUserId(c);
    const s = readSettings(ctx.dbh.db, uid);
    const info = cacheInfo(ctx.dbh.db, uid);
    return c.json({ ...s, cache: info });
  });

  // ── 存配置 ──────────────────────────────────────────────
  //
  // 改地址时顺手清掉内存缓存：那是按 userId 存的，不清的话换实例之后
  // 仍会用旧实例拉下来的路由库（搜索结果与预览地址来自两个不同的上游，
  // 表现是"搜到的路由预览 404"，很难查）。
  r.put('/rsshub/config', async (c) => {
    const uid = requireUserId(c);
    const body = await readBody(c, rsshubConfigBody);
    if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') {
      throw badRequest('baseUrl 必须是字符串');
    }
    if (body.baseUrl) {
      const u = body.baseUrl.trim();
      // 只接受 http/https：有人会填 "rsshub.app"（缺协议），
      // 那样拼出来的地址直接语法错误，不如在这里说清楚
      if (!/^https?:\/\//i.test(u)) {
        throw badRequest('baseUrl 必须以 http:// 或 https:// 开头');
      }
    }
    const s = writeSettings(ctx.dbh.db, uid, {
      baseUrl: body.baseUrl,
      accessKey: body.accessKey,
    });
    clearMemoryCache(uid);
    return c.json({ ...s, cache: cacheInfo(ctx.dbh.db, uid) });
  });

  // ── 刷新路由库 ──────────────────────────────────────────
  r.post('/rsshub/refresh', async (c) => {
    const uid = requireUserId(c);
    const s = readSettings(ctx.dbh.db, uid);
    const t0 = Date.now();
    const r2 = await refreshLibrary(ctx.dbh.db, uid, s);
    const ms = Date.now() - t0;

    // 两个上游都失败时返回 ok:false，但仍给 200：
    // 这不是"请求错误"，是"上游不可用"，前端据此提示"用缓存继续"
    const ok = r2.routes > 0 || r2.radar > 0;
    if (!ok) {
      log.warn('RSSHub 路由库刷新失败', { errors: r2.errors });
    } else {
      log.info(`RSSHub 路由库已更新: ${r2.routes} 条路由 / ${r2.radar} 条域名规则`, { ms });
    }
    return c.json({
      ok,
      routes: r2.routes,
      radar: r2.radar,
      errors: r2.errors,
      ms,
      cache: cacheInfo(ctx.dbh.db, uid),
    });
  });

  // ── 搜索（关键词 / URL 反查）───────────────────────────
  r.get('/rsshub/search', (c) => {
    const uid = requireUserId(c);
    const q = (c.req.query('q') ?? '').trim();
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);

    const lib = loadLibrary(ctx.dbh.db, uid);
    const { items, type } = searchRoutes(lib, q);

    return c.json({
      items: items.slice(0, limit),
      total: items.length,
      type,
      // 缓存过期但仍在用：前端要提示"缓存是 8 天前的，去看看更新"
      stale: lib.stale,
      fetchedAt: lib.fetchedAt,
      /** 库里的规模，便于用户判断"是不是根本没拉到" */
      library: { routes: lib.routes.length, radar: lib.radar.length },
    });
  });

  // ── 试订阅预览 ──────────────────────────────────────────
  r.post('/rsshub/preview', async (c) => {
    const uid = requireUserId(c);
    const body = await readBody(c, rsshubPreviewBody);
    const path = (body.path ?? body.route ?? '').trim();
    if (!path) throw badRequest('需要 path');
    const params = body.params ?? {};

    const s = readSettings(ctx.dbh.db, uid);
    try {
      const r2 = await previewRoute(s, path, params);
      return c.json(r2);
    } catch (e) {
      if (e instanceof RsshubError) {
        if (e.code === 'BAD_PATH') throw badRequest(e.message);
        throw notFound(e.message);
      }
      throw e;
    }
  });

  return r;
}
