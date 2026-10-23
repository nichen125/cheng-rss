import type { Context } from 'hono';
import type { AppContext } from '../app.ts';
import { SESSION_COOKIE, findSessionByToken, readCookie } from './session.ts';

// 多人预留的唯一开关点（PLAN §18）。
//
// 当前：单用户模式，从 cookie session 或 Bearer token 取 userId。
// 将来支持多人时只扩展本文件 —— 所有 handler 通过 getUserId() 取用户，
// 不直接碰 session 表。
//
// 两种凭证并存的原因（PLAN §14.3）：
//   cookie session  Huntly 插件是 credentials:'include'
//   Bearer token    MCP 客户端与脚本

export { SESSION_COOKIE };

export interface AuthResult {
  userId: string;
  via: 'cookie' | 'bearer';
}

/** 从请求解析 userId；未登录返回 null，由调用方决定抛 401 还是返回 200+null */
export function getUserId(c: Context, ctx: AppContext): string | null {
  // 1. cookie session
  const sid = readCookie(c.req.header('cookie') ?? '', SESSION_COOKIE);
  if (sid) {
    const s = findSessionByToken(ctx.dbh.db, sid);
    if (s) return s.userId;
  }

  // 2. Bearer token（复用 sessions 表，当作长有效期会话）
  const auth = c.req.header('authorization') ?? '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      const s = findSessionByToken(ctx.dbh.db, token);
      if (s) return s.userId;
    }
  }

  return null;
}

/** 供 handler 断言用户已解析 */
export function requireUserId(c: Context): string {
  const uid = c.get('userId') as string | undefined;
  if (!uid) throw new Error('requireUserId 在未挂认证中间件的路由上被调用');
  return uid;
}
