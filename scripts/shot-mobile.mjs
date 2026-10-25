#!/usr/bin/env node
// 移动端截图：手机尺寸 + 触摸目标 + 安全区
//
// 用法: node scripts/shot-mobile.mjs [--base http://127.0.0.1:3000]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const base = arg('--base', 'http://127.0.0.1:3000');
const outDir = resolve(arg('--out', join(root, '.tmp/shots-mobile')));
const email = arg('--email', 'admin@localhost');
const password = arg('--password', 'admin12345');

const CANDIDATES = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium'];

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.log('未找到 Chromium 系浏览器，跳过截图');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'ai-rss-mob-'));
const port = 9500 + Math.floor(Math.random() * 300);
const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  try { proc.kill(); } catch { /* ignore */ }
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

let target = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target?.webSocketDebuggerUrl) break;
  } catch { /* not yet */ }
  await sleep(250);
}
if (!target?.webSocketDebuggerUrl) { console.error('浏览器没起来'); process.exit(0); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(m.error.message)); else res(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setEmulatedMedia', {
  media: 'screen',
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});

mkdirSync(outDir, { recursive: true });

/** iPhone 14 Pro 逻辑分辨率；带刘海 → 安全区非 0 */
const setPhone = async (w = 393, h = 852) => {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 3, mobile: true,
  });
  // 让 env(safe-area-inset-*) 有值，验证底部导航不被 Home 条盖住
  await send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  }).catch(() => { /* 老版本 Chromium 不支持，忽略 */ });
};

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = join(outDir, `${name}.png`);
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log(`  ${p}`);
};

const goto = async (url) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    const ok = await evaluate('document.readyState === "complete"').catch(() => false);
    if (ok) break;
    await sleep(150);
  }
  await sleep(900);
};

// ── 手机 ──────────────────────────────────────────────────
await setPhone();
await goto(`${base}/`);
await shot('m01-login');

const loggedIn = await evaluate(`(async () => {
  const r = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }),
    credentials: 'include',
  });
  return r.ok;
})()`);
if (!loggedIn) { console.error('登录失败'); process.exit(1); }

await goto(`${base}/`);
await sleep(700);
await shot('m02-list');

// 打一条看阅读浮层
await evaluate(`document.querySelector('.entry-item')?.click()`);
await sleep(1300);
await shot('m03-reader');

// 订阅页
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('.tab')];
  const t = tabs.find((x) => x.textContent.includes('订阅'));
  if (t) { t.click(); return true; }
  return false;
})()`);
await sleep(900);
await shot('m04-feeds');

// 添加订阅面板
await evaluate(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find((x) => x.textContent.includes('添加订阅'));
  if (b) { b.click(); return true; }
  return false;
})()`);
await sleep(600);
await shot('m05-add-feed');

// ── 横屏 ──────────────────────────────────────────────────
await setPhone(852, 393);
await sleep(600);
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('.tab')];
  const t = tabs.find((x) => x.textContent.includes('收件箱'));
  if (t) t.click();
})()`);
await sleep(800);
await shot('m06-landscape');

ws.close();
console.log(`\n截图完成 → ${outDir}`);
cleanup();
process.exit(0);
