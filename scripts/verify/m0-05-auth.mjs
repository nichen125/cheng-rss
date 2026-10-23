#!/usr/bin/env node
// 0.5 认证 —— 验收
//
// 判据（PLAN §19.2）：
//   ① 登录返回 Set-Cookie，且 SameSite=Lax、Path=/
//   ② 带 cookie 请求 200
//   ③ 带 Bearer 请求 200
//   ④ /api/auth/loginUserInfo 未登录返回 200（不是 401）
//   ⑤（补充）密码错误不区分"用户不存在"，防枚举
//   ⑥（补充）未配置用户时 /auth/setup 只能成功一次
//   ⑦（补充）改密后旧会话全部失效
//   ⑧（补充）http 环境不加 Secure（否则自托管登录永远无效）
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const entry = join(root, 'src/index.ts');

if (!existsSync(nodeBin)) {
  console.error('项目内 node 缺失，先运行 bootstrap');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m005-'));
const dataDir = join(tmp, 'data');
const port = 33000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;

// 起服务
const proc = spawn(nodeBin, [
  '--experimental-strip-types', '--no-warnings', entry, 'serve',
  '--data', dataDir, '--port', String(port), '--host', '127.0.0.1',
], {
  cwd: root,
  env: { ...process.env, AI_RSS_PRINT_READY: '1', LOG_LEVEL: 'error' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
proc.stdout.on('data', (d) => { stdout += d; });
proc.stderr.on('data', (d) => { stderr += d; });

const ready = await new Promise((res) => {
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (stdout.includes('READY')) { clearInterval(timer); res(true); }
    else if (Date.now() - t0 > 15000) { clearInterval(timer); res(false); }
  }, 100);
});

group('0.5 认证');

if (!ready) {
  console.error('服务未就绪:\n' + stderr.slice(0, 800));
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

const CREDS = { email: 'owner@test.local', password: 'test-password-123' };

// ── 初始化 owner ───────────────────────────────────────────
const setupRes = await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(CREDS),
});
const setupBody = await setupRes.json();

check('首次 setup 创建 owner 成功', () => eq(setupRes.status, 200));
check('setup 返回 created=true', () => eq(setupBody?.created, true));

const setup2 = await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'other@test.local', password: 'x'.repeat(12) }),
});
check('已存在用户后 setup 被拒（400）', () => eq(setup2.status, 400));

// ── ① 登录与 cookie 属性 ────────────────────────────────────
const loginRes = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(CREDS),
});
const setCookie = loginRes.headers.get('set-cookie') ?? '';
const loginBody = await loginRes.json();

check('登录返回 200', () => eq(loginRes.status, 200));
check('登录返回 Set-Cookie', () => ok(setCookie.includes('ai_rss_sid='), `set-cookie: ${setCookie}`));
check('cookie 含 Path=/', () => ok(/Path=\//i.test(setCookie), setCookie));
check('cookie 含 SameSite=Lax（Strict 会让插件永远未登录）', () => {
  return ok(/SameSite=Lax/i.test(setCookie), setCookie);
});
check('cookie 含 HttpOnly', () => ok(/HttpOnly/i.test(setCookie), setCookie));
check('http 环境不加 Secure（否则本地登录无效）', () => {
  return ok(!/;\s*Secure/i.test(setCookie), `意外带了 Secure: ${setCookie}`);
});

const cookieToken = /ai_rss_sid=([^;]+)/.exec(setCookie)?.[1] ?? '';

// 错误的 Content-Type 也应能处理（插件有时用表单）
const failLogin = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: CREDS.email, password: 'wrong-password' }),
});
const failBody = await failLogin.json();
check('密码错误返回 401', () => eq(failLogin.status, 401));
check('密码错误的提示不暴露用户是否存在', () => {
  return ok(failBody?.error?.message === '邮箱或密码错误', `实际: ${failBody?.error?.message}`);
});

const noUserLogin = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'nobody@test.local', password: 'whatever' }),
});
const noUserBody = await noUserLogin.json();
check('不存在的用户与密码错误返回同一提示', () => {
  return eq(noUserBody?.error?.message, failBody?.error?.message);
});

// ── ② cookie 访问 ──────────────────────────────────────────
const meByCookie = await fetch(`${base}/api/v1/auth/me`, {
  headers: { cookie: `ai_rss_sid=${cookieToken}` },
});
const meCookieBody = await meByCookie.json();
check('带 cookie 访问 /auth/me 返回 200', () => eq(meByCookie.status, 200));
check('cookie 模式识别出正确 email', () => eq(meCookieBody?.user?.email, CREDS.email));

// ── ③ Bearer 访问 ──────────────────────────────────────────
const meByBearer = await fetch(`${base}/api/v1/auth/me`, {
  headers: { authorization: `Bearer ${cookieToken}` },
});
check('带 Bearer 访问 /auth/me 返回 200', () => eq(meByBearer.status, 200));

// ── ④ 插件 loginUserInfo 契约（最关键的一条）─────────────────
const infoNoAuth = await fetch(`${base}/api/auth/loginUserInfo`);
const infoNoAuthBody = await infoNoAuth.json().catch(() => 'not-json');
check('loginUserInfo 未登录返回 200（不是 401）', () => {
  return ok(infoNoAuth.status === 200,
    `返回 ${infoNoAuth.status} —— 插件会直接报"连不上服务器"`);
});
check('loginUserInfo 未登录时 body 为 null', () => {
  return ok(infoNoAuthBody === null, `实际: ${JSON.stringify(infoNoAuthBody)}`);
});

const infoAuth = await fetch(`${base}/api/auth/loginUserInfo`, {
  headers: { cookie: `ai_rss_sid=${cookieToken}` },
});
const infoAuthBody = await infoAuth.json();
check('loginUserInfo 已登录返回裸用户对象（无 wrapper）', () => {
  return ok(
    infoAuthBody && typeof infoAuthBody === 'object' &&
    'id' in infoAuthBody && 'username' in infoAuthBody,
    `实际: ${JSON.stringify(infoAuthBody)}`,
  );
});

// 插件登录端点（此处密码尚未修改，用原密码）
const compatLogin = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: CREDS.email, password: CREDS.password }),
});
const compatSetCookie = compatLogin.headers.get('set-cookie') ?? '';
const compatBody = await compatLogin.json().catch(() => null);

check('插件登录端点返回 200', () => eq(compatLogin.status, 200));
check('插件登录返回裸用户对象（无 {user:...} 包装）', () => {
  return ok(
    compatBody && typeof compatBody === 'object' && 'id' in compatBody && 'username' in compatBody,
    `实际: ${JSON.stringify(compatBody)}`,
  );
});
check('插件登录设置 cookie', () => ok(compatSetCookie.includes('ai_rss_sid='), compatSetCookie));

// ── ⑦ 改密后旧会话失效 ─────────────────────────────────────
const changeRes = await fetch(`${base}/api/v1/auth/password`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    cookie: `ai_rss_sid=${cookieToken}`,
  },
  body: JSON.stringify({ current: CREDS.password, next: 'new-password-456' }),
});
check('改密成功', () => eq(changeRes.status, 200));

const meAfterChange = await fetch(`${base}/api/v1/auth/me`, {
  headers: { cookie: `ai_rss_sid=${cookieToken}` },
});
check('改密后旧 cookie 立即失效（401）', () => eq(meAfterChange.status, 401));

const oldPwLogin = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(CREDS),
});
check('改密后旧密码无法登录', () => eq(oldPwLogin.status, 401));

const newPwLogin = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: CREDS.email, password: 'new-password-456' }),
});
check('改密后新密码可登录', () => eq(newPwLogin.status, 200));

// 清理
try { proc.kill('SIGTERM'); } catch { /* ignore */ }
await new Promise((r) => setTimeout(r, 400));
try { proc.kill('SIGKILL'); } catch { /* ignore */ }
rmSync(tmp, { recursive: true, force: true });

summary('m0-05-auth');
