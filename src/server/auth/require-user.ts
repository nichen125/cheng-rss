import type { Context } from 'hono';
import type { AppContext } from '../app.ts';

// 多人预留的唯一开关点（PLAN §18）。
//
// 当前：单用户模式，从 cookie session 或 Bearer token 取 userId。
// 将来支持多人时，只需扩展本文件 —— 所有 handler 都通过
// getUserId() 取用户，不直接读 session。
//
// 认证方式有两种，因为两个客户端不同（PLAN §14.3）：
//   cookie session  Huntly 插件是 credentials:'include'
//   Bearer token    MCP 客户端与脚本

export const SESSION_COOKIE = 'ai_rss_sid';

export interface AuthResult {
  userId: string;
  via: 'cookie' | 'bearer';
}

/** 从请求里解析 userId，未登录返回 null。不抛错，让调用方决定。 */
export async function getUserId(c: Context, ctx: AppContext): Promise<string | null> {
  // 1. cookie session
  const sid = readCookie(c.req.header('cookie') ?? '', SESSION_COOKIE);
  if (sid) {
    const uid = userIdFromSession(ctx, sid);
    if (uid) return uid;
  }

  // 2. Bearer token
  const auth = c.req.header('authorization') ?? '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      const uid = userIdFromToken(ctx, token);
      if (uid) return uid;
    }
  }

  return null;
}

function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function userIdFromSession(ctx: AppContext, sid: string): string | null {
  try {
    const row = ctx.dbh.db
      .prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?')
      .get(sid) as { user_id: string; expires_at: number } | undefined;
    if (!row) return null;
    if (Number(row.expires_at) < Date.now()) return null;
    return row.user_id;
  } catch {
    return null;
  }
}

// Bearer token 在 0.5 落地为 api_tokens 表；此刻复用 sessions 表，
// 把 token 当作长有效期会话，避免 0.4 引入未验证的表。
function userIdFromToken(ctx: AppContext, token: string): string | null {
  return userIdFromSession(ctx, token);
}

/** 供兼容层与 handler 断言用户已解析 */
export function requireUserId(c: Context): string {
  const uid = c.get('userId') as string | undefined;
  if (!uid) throw new Error('requireUserId 在未挂认证中间件的路由上被调用');
  return uid;
}
