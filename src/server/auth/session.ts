import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// 认证服务。
//
// 两个硬约束（PLAN §14.3），它们不是风格选择：
//   1. Hurtly 插件用 credentials:'include'，所以必须有 cookie session，
//      且 SameSite 必须是 Lax —— Strict 会导致跨站场景不回传 cookie。
//   2. /api/auth/loginUserInfo 未登录时返回 200 + null 语义，不能返回 401。
//      插件对 401 的处理是直接报错，不会引导登录。

export const SESSION_COOKIE = 'ai_rss_sid';

export interface SessionRecord {
  id: string;
  token: string;
  userId: string;
  expiresAt: number;
}

// ── 密码哈希：scrypt（Node 内置，无原生依赖）──────────────────
// 存储格式 scrypt$<salt-hex>$<hash-hex>，便于将来换算法时识别旧格式。
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expect = Buffer.from(parts[2]!, 'hex');
  const actual = scryptSync(password, salt, expect.length);
  // 长度不等时 timingSafeEqual 会抛错，先比长度
  if (actual.length !== expect.length) return false;
  return timingSafeEqual(actual, expect);
}

// ── 会话 ──────────────────────────────────────────────────────

export function createSession(
  db: DatabaseSync,
  userId: string,
  ttlDays: number,
): SessionRecord {
  const id = `s_${randomBytes(8).toString('hex')}`;
  // token 比 id 长且不可猜，作为 cookie 的值
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + ttlDays * 86400_000;

  db.prepare(
    'INSERT INTO sessions (id, user_id, token, expires_at, created_at) VALUES (?,?,?,?,?)',
  ).run(id, userId, token, expiresAt, now);

  return { id, token, userId, expiresAt };
}

export function findSessionByToken(db: DatabaseSync, token: string): SessionRecord | null {
  if (!token) return null;
  const row = db.prepare(
    'SELECT id, user_id, token, expires_at FROM sessions WHERE token = ?',
  ).get(token) as { id: string; user_id: string; token: string; expires_at: number } | undefined;
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    // 顺手清理过期会话，避免表无限增长
    try {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    } catch { /* ignore */ }
    return null;
  }
  return { id: row.id, token: row.token, userId: row.user_id, expiresAt: Number(row.expires_at) };
}

export function deleteSession(db: DatabaseSync, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** 定期清理过期会话；serve 启动时跑一次即可（单进程场景足够） */
export function purgeExpiredSessions(db: DatabaseSync): number {
  const r = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return Number(r.changes ?? 0);
}

// ── Cookie 构造 ───────────────────────────────────────────────
//
// SameSite=Lax 而非 Strict：插件从 chrome-extension:// 发起请求，
// 属于跨站上下文；Strict 下浏览器不会带上 cookie，插件表现为"永远未登录"。
// Path=/ 是必须的：插件访问的是 /api/*，若 cookie 限定在某子路径会取不到。
export function sessionCookie(
  token: string,
  opts: { maxAgeSec: number; secure: boolean },
): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSec}`,
  ];
  // Secure 只在 HTTPS 下加。自托管常见 http://nas:3000，加了会导致
  // cookie 根本不被存储 —— 这是本地部署最常见的"登录无效"原因。
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 从原始 Cookie 头解析某个键 */
export function readCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

// ── 用户 ──────────────────────────────────────────────────────

export interface UserRecord {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
}

export function findUserByEmail(db: DatabaseSync, email: string): UserRecord | null {
  const row = db.prepare('SELECT id, email, name, role FROM users WHERE email = ?')
    .get(email) as UserRecord | undefined;
  return row ?? null;
}

export function findUserById(db: DatabaseSync, id: string): UserRecord | null {
  const row = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?')
    .get(id) as UserRecord | undefined;
  return row ?? null;
}

export function countUsers(db: DatabaseSync): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  return Number(r.c);
}

/**
 * 首次启动时创建 owner 账号。
 *
 * 单用户场景下不应该逼用户先填注册表单再登录 —— 那会让
 * 「下载即用」变成「下载 → 读文档 → 建账号 → 登录」。
 * 密码随机生成并打印一次，用户可在设置里改。
 */
export function ensureOwnerUser(
  db: DatabaseSync,
  email: string,
  passwordHash?: string,
): { created: boolean; plainPassword?: string; userId: string } {
  const existing = findUserByEmail(db, email);
  if (existing) return { created: false, userId: existing.id };

  const id = `u_${randomBytes(8).toString('hex')}`;
  const plain = passwordHash ? undefined : randomBytes(12).toString('base64url');
  const hash = passwordHash ?? hashPassword(plain!);

  db.prepare(
    'INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)',
  ).run(id, email, 'Owner', 'owner', hash, Date.now());
  db.prepare('INSERT OR IGNORE INTO settings (user_id) VALUES (?)').run(id);

  return { created: true, plainPassword: plain, userId: id };
}

export function getPasswordHash(db: DatabaseSync, userId: string): string | null {
  const r = db.prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(userId) as { password_hash: string | null } | undefined;
  return r?.password_hash ?? null;
}
