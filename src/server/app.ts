import { Hono } from 'hono';
import { AppError, toErrorBody, unauthorized } from './errors.ts';
import { log } from './logger.ts';
import { getUserId } from './auth/require-user.ts';
import { authRoutes } from './routes/auth.ts';
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

  // 先放一个受保护的探针，验证 401 契约
  v1.get('/feeds', (c) => c.json({ items: [], total: 0 }));

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

  app.route('/api/v1', v1);
  app.route('/api', compat);

  // ── 根路径：0.8 之前返回一个说明，之后由静态资源接管 ────────
  app.get('/', (c) =>
    c.html(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>AI RSS</title></head>` +
      `<body><div id="root"></div>` +
      `<p style="font-family:sans-serif;padding:2rem">前端资源尚未内嵌（0.8 步骤）。` +
      `API 可用：<code>/api/health</code></p></div></body></html>`,
    ),
  );

  return app;
}
