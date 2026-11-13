#!/usr/bin/env node
// 列表滚动到底自动加载 —— 验收（PLAN §15.26，v6.8）
//
// 需求方原话：「列表下拉栏应该自动加载，而不是点击加载」。
//
// 用 IntersectionObserver 观察列表底部的一个 1px 哨兵。判据全部是行为断言，
// 不看代码里有没有 observer：
//
//   ① 列表底部**没有**可点的加载按钮（改前是两个 .btn）。
//   ② 滚到底会自动追加下一页：滚动前后条目数**严格增加**。
//   ③ 不滚就不加载：静置 3 秒，条目数保持不变（否则会无限翻滚请求）。
//   ④ 一屏放得下（搜索结果很少）时也会加载 —— 这是 scroll 事件方案的
//      死穴：内容不够高就永远不产生 scroll 事件，那一页永远取不到。
//      用 observer 时哨兵一开始就在视口内，必须立刻触发。
//   ⑤ 全部加载完显示「没有更多了」，且**不是**按钮。
//   ⑥ 历史视图不被自动加载污染：滚到底时条目数不变。
//      （历史走 listHistory，load() 走 listEntries，服务端把未知 view
//       当 inbox —— 少了守卫就会往历史列表里插一批未读。）
//
// 判据（对应 §19.3 的 1.27 行）：
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { removeDir } from '../lib/tmp.mjs';
import { openSqlite } from '../lib/sqlite.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.27 列表滚动自动加载');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-al-'));
const dataDir = join(tmp, 'data');
const port = 56000 + Math.floor(Math.random() * 900);
const origin = `http://127.0.0.1:${port}`;
const base = `${origin}/api/v1`;

const srv = spawn(binPath, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
srv.stdout.on('data', () => { /* drain */ });

let ready = false;
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch { /* not yet */ }
  await sleep(250);
}
check('服务就绪', () => ok(ready, srvErr.slice(0, 300)));

const cleanup = () => {
  killTree(srv.pid);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
if (!ready) { cleanup(); summary('m1-27-auto-load'); process.exit(1); }

await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'al@test.local', password: 'altest1234567' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'al@test.local', password: 'altest1234567' }),
});
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

// ── 造数据：80 条互相区别的条目（一条独特的关键词，用来测搜索结果）──
const db = openSqlite(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;
const now = Date.now();
db.exec('BEGIN IMMEDIATE');
db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',NULL)`)
  .run('al_f1', uid, 'https://al.example.com/feed', 'https://al.example.com', '自动加载测试源', now, now);
const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,?)`);
for (let i = 0; i < 80; i += 1) {
  // 前 3 条带一个独特关键词 rareword，用来制造"结果很少、一屏放得下"
  const title = i < 3 ? `rareword 第 ${i} 条` : `普通条目第 ${i} 条`;
  insEntry.run(`al_e${String(i).padStart(3, '0')}`, uid, 'al_f1', `g${i}`,
    `https://al.example.com/${i}`, `al.example.com/${i}`,
    title, '摘要', now - i * 60000, now, '自动加载测试源');
}
// 一条已读记录，让历史视图有内容可渲染
db.prepare('UPDATE entries SET is_read = 1 WHERE id = ?').run('al_e000');
db.exec('COMMIT');
db.close();

// ── 浏览器 ────────────────────────────────────────────────
const CANDIDATES = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
const browserPath = CANDIDATES.find((p) => existsSync(p));

if (!browserPath) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器，UI 断言跳过');
  summary('m1-27-auto-load');
  cleanup();
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'cheng-rss-al-prof-'));
const cdpPort = 10800 + Math.floor(Math.random() * 80);
const proc = spawn(browserPath, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,950', 'about:blank',
], { stdio: 'ignore' });

const killBrowser = () => {
  killTree(proc.pid);
  removeDir(profile);
};
onExit(() => { killBrowser(); cleanup(); });

let target = null;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && !/^(edge|chrome|devtools):/i.test(t.url ?? ''));
    if (target?.webSocketDebuggerUrl) break;
  } catch { /* not yet */ }
  await sleep(250);
}
if (!target?.webSocketDebuggerUrl) {
  check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
  summary('m1-27-auto-load');
  cleanup();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let dseq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(m.error.message)); else res(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++dseq;
  const timer = setTimeout(() => {
    pending.delete(id);
    rej(new Error(`CDP 命令超时 60000ms: ${method}`));
  }, 60000);
  pending.set(id, {
    res: (v) => { clearTimeout(timer); res(v); },
    rej: (e) => { clearTimeout(timer); rej(e); },
  });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval 失败');
  }
  return r.result.value;
};

const SETQ = (q) => `(() => {
  const i = document.querySelector('.search-box input');
  if (!i) return false;
  i.focus();
  // React 的受控输入必须用它自己的 value setter，直接赋值不会触发 onChange
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(i, ${JSON.stringify(q)});
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

const scrollToBottom = () => ev(`(() => {
  const l = document.querySelector('.list-scroll');
  if (!l) return false;
  l.scrollTop = l.scrollHeight;
  return true;
})()`);

const state = () => ev(`(() => {
  const l = document.querySelector('.list-scroll');
  const more = document.querySelector('.load-more');
  return {
    rows: document.querySelectorAll('.entry-item').length,
    rowsInList: document.querySelectorAll('.list-scroll .entry-item').length,
    buttons: document.querySelectorAll('.load-more button').length,
    moreText: (more?.textContent ?? '').trim(),
    moreClass: more?.className ?? null,
    sentinel: Boolean(document.querySelector('.list-sentinel')),
    scrollH: l ? l.scrollHeight : 0,
    clientH: l ? l.clientHeight : 0,
  };
})()`);

await send('Page.enable');
await send('Runtime.enable');
await send('Network.setCookie', {
  name: 'cheng_rss_sid', value: cookie.split('=')[1] ?? '',
  domain: '127.0.0.1', path: '/',
});
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 950, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: origin });
for (let i = 0; i < 80; i++) {
  if (await ev('document.readyState === "complete"').catch(() => false)) break;
  await sleep(150);
}
await sleep(2200);

const first = await state();

// ═══ ① 底部没有可点的加载按钮 ═══════════════════════════════
check('① 列表底部没有「加载更多」按钮（改前是两个 .btn）', () => {
  return ok(first.buttons === 0,
    `.load-more 里还有 ${first.buttons} 个按钮，文案=${JSON.stringify(first.moreText)}`);
});

check('① 底部有 1px 的自动加载哨兵（否则 observer 没有观察对象）', () => {
  return ok(first.sentinel, JSON.stringify(first));
});

// ═══ ② 不滚就不加载 ═════════════════════════════════════════
const idleBefore = (await state()).rowsInList;
await sleep(3000);
const idleAfter = (await state()).rowsInList;
check('② 静置 3 秒不自动加载（哨兵还没进可见区）', () => {
  return ok(idleAfter === idleBefore, `${idleBefore} → ${idleAfter} 条`);
});

// ═══ ③ 滚到底自动追加 ═══════════════════════════════════════
await scrollToBottom();
await sleep(2000);
const afterScroll = await state();
check('③ 滚到底自动追加下一页（条目严格增加）', () => {
  return ok(afterScroll.rowsInList > idleAfter,
    `滚动前 ${idleAfter} 条，滚动后 ${afterScroll.rowsInList} 条`);
});

// ═══ ④ 一屏放得下时也要加载 ═════════════════════════════════
//
// 这是 scroll 事件方案的死穴：内容不够高 → 不产生滚动 → 永远不触发。
// 把视口抬到 3600px，让一页（30 条 × ~103px ≈ 3090px）整个装进一屏 ——
// 此时哨兵从一开始就在可见区内，且**用户一次都不用滚**。
// 如果实现用的是 scroll 事件，这一页永远是 30 条；用 observer 则会自己
// 追加到 60。这是两种实现唯一能互相区分开的场景。
await ev(SETQ(''));
await sleep(1500);
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 3600, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: origin });
for (let i = 0; i < 80; i++) {
  if (await ev('document.readyState === "complete"').catch(() => false)) break;
  await sleep(150);
}
await sleep(4000); // 不滚动，只是等
const tall = await state();
check('④ 一屏放得下一页时也会自己加载（不经滚动，这是 scroll 事件做不到的）', () => {
  const fits = tall.scrollH <= tall.clientH + 4 || tall.rowsInList > 30;
  return ok(fits && tall.rowsInList > 30,
    `视口 3600px，scrollH=${tall.scrollH} clientH=${tall.clientH}，`
      + `未滚动就加载到 ${tall.rowsInList} 条`);
});

// ═══ ⑤ 「没有更多了」不是按钮 ═══════════════════════════════
// 换回正常视口，搜一个只有两条结果的词（其中一条已被标为已读，所以未读视图里
// 只剩 2 条）。结果远少于一屏，必然到底。
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 950, deviceScaleFactor: 1, mobile: false,
});
await ev(SETQ('rareword'));
await sleep(2500);
const rare = await state();
check('⑤ 结果很少时写出「没有更多了」，且它不是可点按钮', () => {
  return ok(rare.moreText.includes('没有更多') && rare.buttons === 0,
    `文案=${JSON.stringify(rare.moreText)}，按钮 ${rare.buttons} 个`);
});

// ═══ ⑥ 历史视图不被自动加载污染 ═════════════════════════════
await ev(SETQ(''));
await sleep(2200);
await ev(`(() => {
  const b = [...document.querySelectorAll('.nav-item')]
    .find((x) => (x.textContent ?? '').includes('历史'));
  if (b) b.click();
  return Boolean(b);
})()`);
await sleep(2500);
const histBefore = (await state()).rowsInList;
await scrollToBottom();
await sleep(2000);
const histAfter = (await state()).rowsInList;
check('⑥ 历史视图滚到底不会自动追加（它走 listHistory，不是 listEntries）', () => {
  return ok(histAfter === histBefore,
    `滚动前 ${histBefore} 条，滚动后 ${histAfter} 条`);
});

killBrowser();
cleanup();
summary('m1-27-auto-load');
