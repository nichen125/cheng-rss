import { Hono } from 'hono';
import { AppError, toErrorBody, unauthorized } from './errors.ts';
import { log } from './logger.ts';
import { getUserId } from './auth/require-user.ts';
import { countUsers } from './auth/session.ts';
import { authRoutes } from './routes/auth.ts';
import { entryRoutes } from './routes/entries.ts';
import { feedRoutes } from './routes/feeds.ts';
import { rsshubRoutes } from './routes/rsshub.ts';
import { settingsRoutes } from './routes/settings.ts';
import { digestRoutes } from './routes/digests.ts';
import { getStaticAssets, indexHtml, looksLikeAsset, mimeFor } from './static.ts';
import type { DbHandle } from './db/client.ts';
import type { RuntimeConfig } from './config.ts';

// 应用装配。
//
// 路由分区（PLAN §14.2）：
//   /api/v1/*  自有 API，Bearer 或 cookie 均可
//   /api/*     Huntly 插件兼容层，逐端点各自的响应形状，不要统一 wrapper
//   /          前端静态资源（SEA 内嵌，0.8 落地）
//
// 两块分开挂载是硬要求：插件对响应体形状极敏感，套一层统一 wrapper
// 会让它取不到值且不报错。

export interface AppContext {
  cfg: RuntimeConfig;
  dbh: DbHandle;
  version: string;
  startedAt: number;
}

// Hono 的 c.set/c.get 需要显式声明变量类型，否则 key 被推断为 never
export interface Variables {
  userId: string;
}

export function createApp(ctx: AppContext): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  // ── 错误处理：统一 { error: { code, message, retryable } } ──
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    if (status >= 500) {
      log.error(`${c.req.method} ${c.req.path} -> ${status}`, {
        err: err instanceof Error ? err.message : String(err),
      });
    } else {
      log.debug(`${c.req.method} ${c.req.path} -> ${status}`, { code: body.error.code });
    }
    return c.json(body, status as 400);
  });

  app.notFound((c) => {
    return c.json(
      { error: { code: 'NOT_FOUND', message: `没有这个路由: ${c.req.path}`, retryable: false } },
      404,
    );
  });

  // ── 健康检查：不鉴权，Docker healthcheck 用 ─────────────────
  app.get('/api/health', (c) => {
    const uptimeMs = Date.now() - ctx.startedAt;
    return c.json({
      ok: true,
      version: ctx.version,
      uptimeMs,
      // 库可达性：一条最轻的查询
      db: (() => {
        try {
          ctx.dbh.db.prepare('SELECT 1 AS x').get();
          return 'ok';
        } catch {
          return 'error';
        }
      })(),
      // 前端靠它决定首屏是初始化页还是登录页。判据必须与
      // POST /auth/setup 里那道 countUsers 门禁一致，否则会出现
      // "有账号却显示初始化页"这种自相矛盾。
      needsSetup: countUsers(ctx.dbh.db) === 0,
    });
  });

  // ── 请求日志（debug 级，生产默认不输出）─────────────────────
  app.use('*', async (c, next) => {
    const t0 = performance.now();
    await next();
    const ms = performance.now() - t0;
    if (c.res.status >= 400 || ms > 300) {
      log.warn(`${c.req.method} ${c.req.path} -> ${c.res.status} (${ms.toFixed(0)}ms)`);
    } else {
      log.debug(`${c.req.method} ${c.req.path} -> ${c.res.status} (${ms.toFixed(0)}ms)`);
    }
  });

  // ── 自有 API：除公开端点外必须登录 ─────────────────────────
  const v1 = new Hono<{ Variables: Variables }>();

  // 公开端点白名单：登录、初始化、健康检查不需要已有会话。
  // 用精确前缀匹配而非"包含"，避免 /auth/loginxxx 之类被误放行。
  const PUBLIC_V1 = ['/auth/login', '/auth/setup', '/health'];

  v1.use('*', async (c, next) => {
    const path = c.req.path.replace(/^\/api\/v1/, '');
    if (PUBLIC_V1.some((p) => path === p || path.startsWith(p + '/'))) {
      return next();
    }
    const uid = getUserId(c, ctx);
    if (!uid) throw unauthorized();
    c.set('userId', uid);
    await next();
  });

  v1.get('/me', (c) => {
    return c.json({ id: c.get('userId') });
  });


  // ── Huntly 插件兼容层（0.8 起逐步补齐）────────────────────
  const compat = new Hono<{ Variables: Variables }>();

  // 认证路由：自有与插件两套挂在不同前缀，响应形状各自独立。
  //
  // auth.v1 内部路由是 /login /logout /me /setup /password，要合并进
  // 上面的 v1 子应用（最终路径 /api/v1/auth/*），不能再 route 一次
  // '/auth' 到 app —— 那会绕过 v1 的白名单中间件。
  // auth.compat 内部路由已带 /auth/ 前缀，直接合并进 compat。
  const auth = authRoutes(ctx);
  v1.route('/auth', auth.v1);
  compat.route('/', auth.compat);

  // 订阅管理（含 OPML 导入导出、手动刷新）
  v1.route('/', feedRoutes(ctx));

  // 条目读取 + 已读标记
  v1.route('/', entryRoutes(ctx));

  // RSSHub 订阅搜索（/rsshub/*）
  v1.route('/', rsshubRoutes(ctx));

  // AI 配置（/settings/ai）
  v1.route('/', settingsRoutes(ctx));

  // 简报（/digests/*）
  v1.route('/', digestRoutes(ctx));

  app.route('/api/v1', v1);
  app.route('/api', compat);

  // ── 根路径：静态资源 + SPA fallback ───────────────────────
  //
  // SEO 无关的单页应用，除 /api 外所有非静态路径都回 index.html，
  // 让前端路由自己处理（PLAN §15）。
  app.get('*', async (c) => {
    const path = c.req.path;

    if (path.startsWith('/api/')) {
      return c.json(
        { error: { code: 'NOT_FOUND', message: `没有这个接口: ${path}`, retryable: false } },
        404,
      );
    }

    const assets = await getStaticAssets();

    if (!assets.ok) {
      // 前端还没构建：给出明确指引而不是 404
      return c.html(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>AI RSS</title></head>` +
        `<body style="font-family:system-ui;padding:3rem;max-width:640px;margin:0 auto;line-height:1.6">` +
        `<h1 style="font-size:20px">前端尚未构建</h1>` +
        `<p style="color:#666">当前运行的是 API 服务，前端资源不可用。</p>` +
        `<pre style="background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto">` +
        `./scripts/build.sh</pre>` +
        `<p>构建完成后重启服务即可。</p>` +
        `<p style="color:#888;font-size:13px">来源: ${assets.source}</p>` +
        `</body></html>`,
        200,
      );
    }

    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const buf = assets.get(rel);
    if (buf) {
      return new Response(toArrayBuffer(buf), {
        headers: {
          'content-type': mimeFor(rel),
          // 带 hash 的资源可长缓存；index.html 必须每次校验
          'cache-control': rel === 'index.html'
            ? 'no-cache'
            : 'public, max-age=31536000, immutable',
        },
      });
    }

    // SPA fallback：非静态资源路径交给前端路由
    const index = indexHtml(assets);
    if (index && !looksLikeAsset(path)) {
      return new Response(toArrayBuffer(index), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }

    return c.text('Not Found', 404);
  });

  return app;
}

/**
 * Uint8Array → ArrayBuffer，供 Response body 使用。
 *
 * 不能直接传 buf.buffer：如果 buf 是某个更大 Buffer 的视图
 * （Node 的 Buffer.from 常这样），会连带把整块内存当响应体发出去。
 */
function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
    return buf.buffer as ArrayBuffer;
  }
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy.buffer;
}
