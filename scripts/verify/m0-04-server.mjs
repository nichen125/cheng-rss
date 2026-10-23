#!/usr/bin/env node
// 0.4 HTTP 骨架与子命令 —— 验收
//
// 判据（PLAN §19.2）：
//   ① version / doctor 有输出
//   ② /api/health 返回 200
//   ③ 未登录访问 /api/v1/feeds 返回 401
//   ④（补充）错误体形状统一为 { error: { code, message, retryable } }
//   ⑤（补充）未知路由返回 404 且同形状
//   ⑥（补充）cookie 与 Bearer 两种凭证都能通过 v1 鉴权（为 0.5 打基础）
import { execFileSync, spawn } from 'node:child_process';
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

const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m004-'));
const dataDir = join(tmp, 'data');

function cli(args, expectFail = false) {
  try {
    return {
      ok: true,
      out: execFileSync(nodeBin, [
        '--experimental-strip-types', '--no-warnings', entry, ...args,
      ], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }),
    };
  } catch (e) {
    if (expectFail) return { ok: false, out: e.stderr || '', code: e.status };
    throw e;
  }
}

group('0.4 HTTP 骨架与子命令');

// ── ① 子命令 ───────────────────────────────────────────────
const ver = cli(['version']);
check('version 输出版本号与 schema 版本', () => {
  return ok(/ai-rss \d+\.\d+\.\d+/.test(ver.out) && /schema \d+/.test(ver.out),
    `输出: ${ver.out.slice(0, 120)}`);
});

const mig = cli(['migrate', '--data', dataDir]);
check('migrate 建库并输出结果', () => {
  return ok(/已应用迁移|已是最新/.test(mig.out), `输出: ${mig.out.slice(0, 120)}`);
});

const mig2 = cli(['migrate', '--data', dataDir]);
check('migrate 幂等（第二次显示已是最新）', () => {
  return ok(/已是最新/.test(mig2.out), `输出: ${mig2.out.slice(0, 120)}`);
});

const doc = cli(['doctor', '--data', dataDir]);
check('doctor 有输出且包含关键检查项', () => {
  const need = ['数据目录可写', 'schema 版本', 'integrity_check'];
  const missing = need.filter((k) => !doc.out.includes(k));
  return ok(missing.length === 0, `缺少: ${missing.join(', ')}`);
});

// 未知命令应以非零退出
const bad = cli(['nosuchcmd'], true);
check('未知命令以非零码退出', () => ok(bad.ok === false && bad.code !== 0, '未知命令竟然成功'));

// ── ② 起服务 ────────────────────────────────────────────────
const port = 31000 + Math.floor(Math.random() * 2000);

async function startServer() {
  const p = spawn(nodeBin, [
    '--experimental-strip-types', '--no-warnings', entry, 'serve',
    '--data', dataDir, '--port', String(port), '--host', '127.0.0.1',
  ], {
    cwd: root,
    env: { ...process.env, AI_RSS_PRINT_READY: '1', LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });

  const ready = await new Promise((res) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (stdout.includes('READY')) { clearInterval(timer); res(true); }
      else if (Date.now() - t0 > 15000) { clearInterval(timer); res(false); }
    }, 100);
  });
  return { proc: p, ready, getStdout: () => stdout, getStderr: () => stderr };
}

const srv = await startServer();

check('serve 在 15s 内就绪', () => ok(srv.ready, `stderr: ${srv.getStderr().slice(0, 300)}`));

if (srv.ready) {
  const base = `http://127.0.0.1:${port}`;

  // health
  const hr = await fetch(`${base}/api/health`);
  const hb = await hr.json();
  check('/api/health 返回 200', () => eq(hr.status, 200));
  check('/api/health 报告 db=ok', () => eq(hb.db, 'ok'));

  // 未登录 → 401
  const ur = await fetch(`${base}/api/v1/feeds`);
  const ub = await ur.json();
  check('未登录访问 /api/v1/feeds 返回 401', () => eq(ur.status, 401));
  check('401 的错误体形状正确', () => {
    return ok(
      ub?.error && typeof ub.error.code === 'string' &&
      typeof ub.error.message === 'string' && typeof ub.error.retryable === 'boolean',
      `实际: ${JSON.stringify(ub)}`,
    );
  });
  check('401 的 code = UNAUTHORIZED', () => eq(ub?.error?.code, 'UNAUTHORIZED'));

  // 未知路由 404 且同形状
  const nr = await fetch(`${base}/nosuch/route`);
  const nb = await nr.json();
  check('未知路由返回 404 且错误体同形状', () => {
    return ok(nr.status === 404 && nb?.error?.code === 'NOT_FOUND',
      `实际: ${nr.status} ${JSON.stringify(nb)}`);
  });

  // 根路径可用
  const rr = await fetch(`${base}/`);
  const rt = await rr.text();
  check('根路径返回 HTML 且含 #root 挂载点', () => {
    return ok(rr.status === 200 && rt.includes('id="root"'), `${rr.status}`);
  });

  // ── 凭证：直接往 sessions 插一条，验证两种传递方式都通 ──
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dataDir, 'app.db'));
  db.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)')
    .run('u-test', Date.now());
  db.prepare('INSERT INTO sessions (id, user_id, token, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run('s1', 'u-test', 'tok-abc', Date.now() + 86400000, Date.now());
  db.close();

  const cr = await fetch(`${base}/api/v1/me`, {
    headers: { cookie: 'ai_rss_sid=tok-abc' },
  });
  const cb = await cr.json();
  check('cookie session 可访问 /api/v1/me', () => eq(cr.status, 200));
  check('cookie 模式解析出正确 userId', () => eq(cb?.id, 'u-test'));

  const br2 = await fetch(`${base}/api/v1/me`, {
    headers: { authorization: 'Bearer tok-abc' },
  });
  const bb = await br2.json();
  check('Bearer token 可访问 /api/v1/me', () => eq(br2.status, 200));
  check('Bearer 模式解析出正确 userId', () => eq(bb?.id, 'u-test'));

  // 过期会话应被拒
  const db2 = new DatabaseSync(join(dataDir, 'app.db'));
  db2.prepare('INSERT INTO sessions (id, user_id, token, expires_at, created_at) VALUES (?,?,?,?,?)')
    .run('s2', 'u-test', 'tok-expired', Date.now() - 1000, Date.now());
  db2.close();
  const er = await fetch(`${base}/api/v1/me`, { headers: { cookie: 'ai_rss_sid=tok-expired' } });
  check('过期会话被拒（401）', () => eq(er.status, 401));
}

// ── 清理 ────────────────────────────────────────────────────
try { srv.proc.kill('SIGTERM'); } catch { /* ignore */ }
await new Promise((r) => setTimeout(r, 500));
try { srv.proc.kill('SIGKILL'); } catch { /* ignore */ }
rmSync(tmp, { recursive: true, force: true });

summary('m0-04-server');
