#!/usr/bin/env node
// 用本机 Edge 无头模式给 UI 截图，产出验收用的视觉证据。
//
// 为什么不用 playwright/puppeteer：这两个都要下载一份 Chromium
// （300MB+），而 Windows 自带 Edge 就是 Chromium，用 CDP 直接驱它
// 是零依赖的。代价是只能跑在有 Edge 的 Windows 上 —— 所以本脚本
// 找不到浏览器时退出 0 并说明跳过，不当作失败。
//
// 用法：
//   node scripts/shot-ui.mjs                       # 截图到 .tmp/shots/
//   node scripts/shot-ui.mjs --base http://127.0.0.1:3000 --out shots/
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const base = arg('--base', 'http://127.0.0.1:3000');
const outDir = resolve(arg('--out', join(root, '.tmp/shots')));
const email = arg('--email', 'admin@localhost');
const password = arg('--password', 'admin12345');

const CANDIDATES = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.log('未找到 Chromium 系浏览器，跳过截图（不算失败）');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 起一个带远程调试端口的浏览器
const profile = mkdtempSync(join(tmpdir(), 'ai-rss-shot-'));
const port = 9200 + Math.floor(Math.random() * 400);
const proc = spawn(browser, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=1440,960',
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  try { proc.kill(); } catch { /* ignore */ }
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
    } catch { /* 已退出 */ }
  }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

// 等 CDP 起来
let target = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = await r.json();
    target = list.find((t) => t.type === 'page');
    if (target?.webSocketDebuggerUrl) break;
  } catch { /* 还没起来 */ }
  await sleep(250);
}
if (!target?.webSocketDebuggerUrl) {
  console.error('浏览器调试端口没起来，跳过');
  process.exit(0);
}

// 极简 CDP 客户端（Node 24 自带 WebSocket）
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(msg.error.message));
    else res(msg.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
});
// 无头 Edge 默认 prefers-color-scheme: light，不显式指定就永远截不到
// 暗色主题 —— 而暗色才是本项目的主色（PLAN §15.6）。
await send('Emulation.setEmulatedMedia', {
  media: 'screen',
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});

mkdirSync(outDir, { recursive: true });

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const p = join(outDir, `${name}.png`);
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log(`  ${p}`);
};

const goto = async (url) => {
  await send('Page.navigate', { url });
  // 等 load + React 首屏渲染完；用 document 状态轮询而不是固定 sleep
  for (let i = 0; i < 60; i++) {
    const ok = await evaluate('document.readyState === "complete"').catch(() => false);
    if (ok) break;
    await sleep(150);
  }
  await sleep(900);
};

// ── 1. 登录页 ──────────────────────────────────────────────
await goto(`${base}/`);
await shot('01-login');

// 登录：直接调 API 拿 cookie，再刷新页面就进主界面
const loggedIn = await evaluate(`(async () => {
  const r = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }),
    credentials: 'include',
  });
  return r.ok;
})()`);
if (!loggedIn) {
  console.error('登录失败，无法进入主界面截图');
  process.exit(1);
}

// ── 2. 主界面：列表空态 ────────────────────────────────────
await goto(`${base}/`);
await sleep(600);
await shot('02-inbox');

// 点第一条进阅读区（三栏，列表保留）
const clicked = await evaluate(`(() => {
  const el = document.querySelector('.entry-item');
  if (!el) return false;
  el.click();
  return true;
})()`);
if (clicked) {
  await sleep(1200);
  await shot('03-reader');
}

// ── 3. 搜索态 ──────────────────────────────────────────────
await evaluate(`(() => {
  const i = document.querySelector('.search-box input');
  if (!i) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(i, '产能');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(900);
await shot('04-search');

// ── 4. 浅色主题 ────────────────────────────────────────────
// setEmulatedMedia 必须带 media:'' 才会重算样式；只给 features 时
// Chromium 会把当前 media 类型当成已满足，页面不重绘。
await send('Emulation.setEmulatedMedia', {
  media: 'screen',
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await evaluate(`(() => {
  const i = document.querySelector('.search-box input');
  if (i) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, '');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }
})()`);
await sleep(900);
// 断言真的变色了，否则截出来的图会被误当成"浅色也好看"
const bg = await evaluate('getComputedStyle(document.body).backgroundColor');
if (!/^rgb\((2[0-9]{2}|1[89][0-9]),\s*(2[0-9]{2}|1[89][0-9])/.test(bg)) {
  console.warn(`  ! 浅色主题没生效（body 背景 ${bg}），跳过 05-light`);
} else {
  await shot('05-light');
}

// ── 5. 窄屏 ────────────────────────────────────────────────
// 回到暗色再截窄屏，否则这张图会混进浅色
await send('Emulation.setEmulatedMedia', {
  media: 'screen',
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});
await send('Emulation.setDeviceMetricsOverride', {
  width: 860, height: 900, deviceScaleFactor: 1, mobile: false,
});
await sleep(700);
await shot('06-narrow');

ws.close();
console.log(`\n截图完成 → ${outDir}`);
// 必须显式退出：CDP 的 WebSocket 与浏览器子进程都会让事件循环
// 保持活跃，脚本会一直挂着（第一次跑就挂了 3 分钟）。
cleanup();
process.exit(0);
