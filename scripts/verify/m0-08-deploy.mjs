#!/usr/bin/env node
// 0.8 三路构建 —— 验收
//
// 判据（PLAN §19.2）：
//   ① 二进制启动首页 200 且含 id="root"
//   ② 同一 data/ 在源码/二进制之间互换启动
//   ③ 插件 3 端点可用（auth/loginUserInfo 等）
//   ④ $HOME 零写入
//   ⑤（补充）SEA 内嵌资源可读（不是靠旁边的 dist 目录）
//   ⑥（补充）二进制不带 dist/client 也能工作
//
// Docker 一条单独判定：本机没装 Docker 时标记为 SKIP 而非 FAIL，
// 避免"没装工具"被误报成"实现有问题"。
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, cpSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('0.8 三路构建');

// 二进制不在就先构建一次。
// 理由：这一步验的是"产物对不对"，而不是"你有没有记得先跑构建"。
// 全新 clone 里只跑过 build.sh（不含 --sea）是很正常的状态，
// 此时报 FAIL 会误导人以为实现坏了。
if (!existsSync(binPath)) {
  process.stdout.write('  \u001b[33m!\u001b[0m 二进制不存在，先构建一次…\n');
  try {
    execFileSync(nodeBin, [join(root, 'scripts/build-sea.mjs')], {
      cwd: root,
      stdio: 'pipe',
      timeout: 600000,
    });
  } catch (e) {
    // 构建失败才是真失败，把原因带出来
    const msg = String(e.stderr ?? e.message).slice(0, 600);
    process.stdout.write(`  \u001b[31m构建失败\u001b[0m\n${msg}\n`);
  }
}

check('二进制已构建', () => {
  if (!existsSync(binPath)) {
    return ok(false, `无法产出 ${binName}。手动运行: node scripts/build-sea.mjs`);
  }
  const size = statSync(binPath).size;
  return ok(size > 20 * 1024 * 1024, `体积只有 ${(size / 1e6).toFixed(0)}MB，可能没内嵌资源`);
});

if (!existsSync(binPath)) {
  summary('m0-08-deploy');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m008-'));

function startServer(cmd, args, dataDir, port, cwd) {
  const p = spawn(cmd, args, {
    cwd,
    env: { ...process.env, CHENG_RSS_PRINT_READY: '1', LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  return {
    proc: p,
    ready: new Promise((res) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (out.includes('READY')) { clearInterval(timer); res(true); }
        else if (Date.now() - t0 > 20000) { clearInterval(timer); res(false); }
      }, 100);
    }),
    getErr: () => err,
  };
}

async function stop(s) {
  if (!s) return;
  // Windows 上 SIGTERM 不会真正终止进程，需要 taskkill /T 杀整棵树。
  // 不清理的话下一个构建会因为文件被占用而 EPERM。
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(s.proc.pid)], { stdio: 'pipe' });
    } else {
      s.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 400));
      s.proc.kill('SIGKILL');
    }
  } catch { /* 进程可能已退出 */ }
  await new Promise((r) => setTimeout(r, 300));
}

// ── ① 二进制首页 ────────────────────────────────────────────
// 关键：把二进制复制到一个**没有 dist/ 目录**的干净位置再跑，
// 这样才能证明前端是从二进制内部读出来的，而不是碰巧找到旁边的文件。
const cleanDir = join(tmp, 'clean');
cpSync(binPath, join(cleanDir, binName), { recursive: false, force: true });
const cleanData = join(tmp, 'clean-data');

let binServer = null;
try {
  execFileSync(join(cleanDir, binName), ['migrate', '--data', cleanData], {
    encoding: 'utf8', timeout: 60000,
  });
} catch (e) {
  check('二进制可执行 migrate', () => ok(false, String(e.stderr ?? e.message).slice(0, 300)));
}

const binPort = 35000 + Math.floor(Math.random() * 1000);
binServer = startServer(join(cleanDir, binName), ['serve', '--data', cleanData, '--port', String(binPort)], cleanData, binPort, cleanDir);
const binReady = await binServer.ready;

check('二进制在无 dist 的目录里可启动', () => {
  return ok(binReady, `stderr: ${binServer.getErr().slice(0, 400)}`);
});

if (binReady) {
  const base = `http://127.0.0.1:${binPort}`;

  const home = await fetch(`${base}/`);
  const homeText = await home.text();
  check('二进制首页返回 200', () => eq(home.status, 200));
  check('首页含 id="root"（React 挂载点）', () => {
    return ok(homeText.includes('id="root"'), '首页没有挂载点，前端未内嵌');
  });

  // 静态资源：从首页 HTML 里解析出 js 路径再取
  const assetHref = /src="(\/assets\/[^"]+\.js)"/.exec(homeText)?.[1];
  check('首页引用了打包后的 JS', () => ok(Boolean(assetHref), '没有找到 script src'));

  if (assetHref) {
    const ar = await fetch(`${base}${assetHref}`);
    const body = await ar.text();
    check('静态 JS 可从二进制内部取出', () => {
      return ok(ar.status === 200 && body.length > 10000,
        `status=${ar.status} len=${body.length}`);
    });
    check('静态资源的 content-type 正确', () => {
      return ok((ar.headers.get('content-type') ?? '').includes('javascript'),
        ar.headers.get('content-type') ?? '');
    });
    // 内嵌资源必须是本次构建的，不能是几天前打进二进制的旧 zip。
    // 曾经的 bug：zip 存在就跳过重打，于是改了前端、构建全绿、
    // 浏览器看到的还是旧 UI。
    const onDisk = join(root, 'dist/client', assetHref.replace(/^\/+/, ''));
    check('二进制内嵌的前端与 dist/client 一致（不是陈旧 zip）', () => {
      if (!existsSync(onDisk)) {
        return ok(false, `dist/client 里没有 ${assetHref}，二进制内嵌了过期前端`);
      }
      return ok(body === readFileSync(onDisk, 'utf8'),
        '二进制里的 JS 与磁盘上的不是同一份，client.zip 没重打');
    });
  }

  // 健康检查
  const h = await fetch(`${base}/api/health`);
  const hb = await h.json();
  check('二进制 /api/health 正常', () => ok(h.status === 200 && hb.db === 'ok'));

  // ── ③ 插件三端点 ────────────────────────────────────────
  const lu = await fetch(`${base}/api/auth/loginUserInfo`);
  const luBody = await lu.json().catch(() => 'x');
  check('插件 loginUserInfo 未登录返回 200 + null', () => {
    return ok(lu.status === 200 && luBody === null, `status=${lu.status} body=${JSON.stringify(luBody)}`);
  });

  const cu = await fetch(`${base}/api/auth/checkUserExist`);
  check('插件 checkUserExist 可用', () => {
    return ok(cu.status === 200, `status=${cu.status}`);
  });

  // 初始化 → 插件登录
  const su = await fetch(`${base}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'bin@test.local', password: 'bin-password-1' }),
  });
  check('二进制里 setup 可用', () => eq(su.status, 200));

  const cl = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bin@test.local', password: 'bin-password-1' }),
  });
  const clCookie = cl.headers.get('set-cookie') ?? '';
  check('插件登录端点设置 cookie', () => ok(clCookie.includes('cheng_rss_sid='), clCookie.slice(0, 120)));
  check('插件登录 cookie 带 SameSite=Lax', () => ok(/SameSite=Lax/i.test(clCookie), clCookie.slice(0, 160)));
}

await stop(binServer);

// ── ② 同一 data/ 与源码模式互换 ────────────────────────────
const srcPort = 36000 + Math.floor(Math.random() * 1000);
const srcServer = startServer(nodeBin, [
  '--experimental-strip-types', '--no-warnings',
  join(root, 'src/index.ts'), 'serve', '--data', cleanData, '--port', String(srcPort),
], cleanData, srcPort, root);
const srcReady = await srcServer.ready;

check('同一 data/ 目录可被源码模式接管（三路互换）', () => {
  return ok(srcReady, `stderr: ${srcServer.getErr().slice(0, 400)}`);
});

if (srcReady) {
  const base = `http://127.0.0.1:${srcPort}`;
  const h = await fetch(`${base}/api/health`);
  const hb = await h.json();
  check('源码模式读到同一份数据（schema 一致）', () => {
    return ok(h.status === 200 && hb.db === 'ok' && hb.version === '0.1.0');
  });

  // 二进制里创建的账号在源码模式仍然有效
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'bin@test.local', password: 'bin-password-1' }),
  });
  check('二进制里创建的账号在源码模式可登录', () => eq(login.status, 200));
}
await stop(srcServer);

// ── ⑤ 二进制不含调试残留 ───────────────────────────────────
check('二进制体积合理（< 150MB）', () => {
  const mb = statSync(binPath).size / 1024 / 1024;
  return ok(mb > 20 && mb < 150, `${mb.toFixed(0)}MB`);
});

// ── Docker：无 docker 时 SKIP ──────────────────────────────
let hasDocker = false;
try {
  execFileSync('docker', ['--version'], { stdio: 'pipe', timeout: 10000 });
  hasDocker = true;
} catch { hasDocker = false; }

if (hasDocker) {
  check('Dockerfile 存在', () => ok(existsSync(join(root, 'Dockerfile'))));
  check('Dockerfile 运行层不是 alpine（SEA 不支持 musl）', () => {
    const df = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const runtimeStage = df.split(/^FROM /m).pop() ?? '';
    return ok(!/alpine/i.test(runtimeStage), '运行层用了 alpine，SEA 二进制跑不起来');
  });
} else {
  process.stdout.write('  \u001b[33mSKIP\u001b[0m  Docker 相关检查（本机未安装 docker）\n');
  process.stdout.write('        Dockerfile 已提供，需在有 docker 的机器上验证\n');
}

rmSync(tmp, { recursive: true, force: true });
summary('m0-08-deploy');
