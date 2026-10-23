import { Hono } from 'hono';
import type { AppContext, Variables } from '../app.ts';
import { badRequest, unauthorized } from '../errors.ts';
import { log } from '../logger.ts';
import {
  clearSessionCookie, countUsers, createSession, deleteSession, ensureOwnerUser,
  findUserByEmail, getPasswordHash, hashPassword, readCookie, sessionCookie,
  verifyPassword, SESSION_COOKIE,
} from '../auth/session.ts';
import { getUserId } from '../auth/require-user.ts';

// 认证路由。分两组：
//   /api/v1/auth/*   自有 API，标准错误体
//   /api/auth/*      Huntly 插件兼容，响应形状按插件期待（见各 handler 注释）

export function authRoutes(ctx: AppContext): {
  v1: Hono<{ Variables: Variables }>;
  compat: Hono<{ Variables: Variables }>;
} {
  const v1 = new Hono<{ Variables: Variables }>();
  const compat = new Hono<{ Variables: Variables }>();

  const secureCookie = (): boolean => {
    // 只有明确走 https 时才加 Secure。自托管常见 http://nas:3000，
    // 加了会导致 cookie 不被保存，表现为"登录成功但立刻又未登录"。
    return process.env.AI_RSS_HTTPS === '1';
  };

  // ══ 自有 API ═══════════════════════════════════════════════

  v1.post('/login', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { email?: string; password?: string };
    const email = (body.email ?? '').trim();
    const password = body.password ?? '';
    if (!email || !password) throw badRequest('需要 email 与 password');

    const user = findUserByEmail(ctx.dbh.db, email);
    if (!user) {
      // 不区分"用户不存在"与"密码错误"，避免枚举账号
      throw unauthorized('邮箱或密码错误');
    }
    const stored = getPasswordHash(ctx.dbh.db, user.id);
    if (!stored || !verifyPassword(password, stored)) {
      throw unauthorized('邮箱或密码错误');
    }

    const s = createSession(ctx.dbh.db, user.id, ctx.cfg.sessionDays);
    c.header('set-cookie', sessionCookie(s.token, {
      maxAgeSec: ctx.cfg.sessionDays * 86400,
      secure: secureCookie(),
    }));

    return c.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      expiresAt: s.expiresAt,
    });
  });

  v1.post('/logout', (c) => {
    const token = readCookie(c.req.header('cookie') ?? '', SESSION_COOKIE);
    if (token) deleteSession(ctx.dbh.db, token);
    c.header('set-cookie', clearSessionCookie());
    return c.json({ ok: true });
  });

  v1.get('/me', (c) => {
    const uid = getUserId(c, ctx);
    if (!uid) throw unauthorized();
    const row = ctx.dbh.db
      .prepare('SELECT id, email, name, role FROM users WHERE id = ?')
      .get(uid) as { id: string; email: string | null; name: string | null; role: string };
    return c.json({ user: row });
  });

  // 首次使用：库里没有任何用户时允许创建 owner。
  // 一旦有用户，此端点永久关闭 —— 否则任何人都能重置管理员。
  v1.post('/setup', async (c) => {
    if (countUsers(ctx.dbh.db) > 0) {
      throw badRequest('已存在用户，初始化接口已关闭');
    }
    const body = await c.req.json().catch(() => ({})) as {
      email?: string; password?: string;
    };
    const email = (body.email ?? '').trim();
    if (!email) throw badRequest('需要 email');
    if (body.password !== undefined && body.password.length > 0 && body.password.length < 8) {
      throw badRequest('密码至少 8 位');
    }

    const r = ensureOwnerUser(
      ctx.dbh.db, email,
      body.password ? hashPassword(body.password) : undefined,
    );
    return c.json({
      created: r.created,
      // 自动生成的密码只在创建时返回一次
      password: r.plainPassword,
      userId: r.userId,
    });
  });

  v1.post('/password', async (c) => {
    const uid = getUserId(c, ctx);
    if (!uid) throw unauthorized();
    const body = await c.req.json().catch(() => ({})) as {
      current?: string; next?: string;
    };
    if (!body.next || body.next.length < 8) throw badRequest('新密码至少 8 位');
    const stored = getPasswordHash(ctx.dbh.db, uid);
    if (stored) {
      if (!body.current || !verifyPassword(body.current, stored)) {
        throw unauthorized('当前密码不正确');
      }
    }
    ctx.dbh.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hashPassword(body.next), uid);
    // 改密后清掉所有会话，强制重新登录
    ctx.dbh.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
    c.header('set-cookie', clearSessionCookie());
    return c.json({ ok: true });
  });

  // ══ Huntly 插件兼容 ════════════════════════════════════════
  //
  // 关键契约（PLAN §14.3）：
  //   loginUserInfo 未登录时返回 200 + null，不能返回 401。
  //   插件对 401 直接报错，不会引导登录 —— 表现为"连不上服务器"。

  compat.get('/auth/loginUserInfo', (c) => {
    const sid = readCookie(c.req.header('cookie') ?? '', SESSION_COOKIE);
    if (!sid) {
      // 200 + null：插件据此判断"需要登录"
      return c.json(null);
    }
    const uid = getUserId(c, ctx);
    if (!uid) return c.json(null);

    const u = ctx.dbh.db
      .prepare('SELECT id, email, name, role FROM users WHERE id = ?')
      .get(uid) as { id: string; email: string | null; name: string | null; role: string };

    // 插件读的是裸用户对象（不是 {user:{...}}）
    return c.json({
      id: u.id,
      username: u.name ?? u.email ?? 'owner',
      email: u.email,
      nickname: u.name ?? 'Owner',
      photo: null,
    });
  });

  // 插件登录：表单或 JSON 都可能
  compat.post('/auth/login', async (c) => {
    let email = '';
    let password = '';
    const ct = c.req.header('content-type') ?? '';
    if (ct.includes('application/json')) {
      const b = await c.req.json().catch(() => ({})) as { username?: string; email?: string; password?: string };
      email = (b.email ?? b.username ?? '').trim();
      password = b.password ?? '';
    } else {
      const f = await c.req.parseBody().catch(() => ({})) as Record<string, string>;
      email = (f.username ?? f.email ?? '').trim();
      password = f.password ?? '';
    }

    const user = findUserByEmail(ctx.dbh.db, email);
    if (!user) throw unauthorized('邮箱或密码错误');
    const stored = getPasswordHash(ctx.dbh.db, user.id);
    if (!stored || !verifyPassword(password, stored)) throw unauthorized('邮箱或密码错误');

    const s = createSession(ctx.dbh.db, user.id, ctx.cfg.sessionDays);
    c.header('set-cookie', sessionCookie(s.token, {
      maxAgeSec: ctx.cfg.sessionDays * 86400,
      secure: secureCookie(),
    }));
    log.info('插件登录成功', { userId: user.id });

    // 插件期待裸用户对象
    return c.json({
      id: user.id,
      username: user.name ?? user.email ?? 'owner',
      email: user.email,
      nickname: user.name ?? 'Owner',
    });
  });

  compat.post('/auth/logout', (c) => {
    const token = readCookie(c.req.header('cookie') ?? '', SESSION_COOKIE);
    if (token) deleteSession(ctx.dbh.db, token);
    c.header('set-cookie', clearSessionCookie());
    return c.json(true);
  });

  // 插件探测是否已配置：很多版本会先调这个
  compat.get('/auth/checkUserExist', (c) => {
    return c.json({ exist: countUsers(ctx.dbh.db) > 0 });
  });

  return { v1, compat };
}
