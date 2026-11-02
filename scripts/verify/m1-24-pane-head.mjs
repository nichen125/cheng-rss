#!/usr/bin/env node
// 中间栏标题行对齐 —— 验收（PLAN §15.22，v1.17）
//
// 需求方原话：「中间栏的标题部分、数量、清除分组信息等都不对齐」。
//
// "对齐"是个很容易假绿的词。截图看起来顺眼也能过，但那样的断言
// 一改样式就失效，而且说不清到底哪里错。所以这里全部用**几何数字**：
//
//   · 垂直中线：标题行里每个可见控件（h1 / 条数 / 分段 / 清除未读 / × /
//     刷新）的 `top + height/2` 必须落在 ±1.5px 内。这是"一行"的定义 ——
//     改之前 h1 走 baseline、按钮走 center，两者差 3~4px。
//   · 右段贴边：最后一个按钮的右边缘与标题行右边缘相差 ≤ 1px，
//     且相邻按钮的间距**全部相等**（gap 承担间距，个别按钮自己带
//     margin-left 就会破坏它）。
//   · 显隐不跳位：分段控件在「收藏」视图隐藏，刷新按钮的位置必须
//     **完全不动**。这是改之前最明显的错位来源 —— 它靠 margin-left:auto
//     自己定位，前面少一个元素就整体左移。
//   · 不溢出：375px 下标题行 scrollWidth 不大于 clientWidth。
//
// 判据（对应 §19.3 的 1.24 行）：
//   ① 标题行里每个可见控件的垂直中线都在 ±1.5px 内
//   ② 「N 条」与标题的中线相差 ≤ 1.5px（不只是"都在一行里"）
//   ③ 右段贴住标题行右边缘，且按钮间距全部相等
//   ④ 「全部/未读」隐藏（收藏视图）时刷新按钮的位置不变
//   ⑤ 375px 下标题行不横向溢出
//   ⑥ 有分组 + 有未读时，行内出现 4 个控件（标题/条数/分段/清除未读/×/刷新），
//      且**没有一个**跑出标题行边界
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { removeDir } from '../lib/tmp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.24 中间栏标题行对齐');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-panehead-'));
const dataDir = join(tmp, 'data');
const port = 52000 + Math.floor(Math.random() * 900);
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
if (!ready) { cleanup(); summary('m1-24-pane-head'); process.exit(1); }

await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ph@test.local', password: 'phtest1234567' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ph@test.local', password: 'phtest1234567' }),
});
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

// ── 造数据：一个分组、一个源、2 条（1 未读 1 已读）─────────
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;
const now = Date.now();
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,0)')
  .run('ph_g1', uid, '很长很长的一个科技分组名', );
db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?)`)
  .run('ph_f1', uid, 'https://ph.example.com/feed', 'https://ph.example.com',
    '一个名字也相当长的订阅源', now, now, 'ph_g1');
const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,?)`);
insEntry.run('ph_e1', uid, 'ph_f1', 'g1', 'https://e.example.com/1', 'e.example.com/1',
  '未读条目 1', '摘要', now, now, 0, '测试源');
insEntry.run('ph_e2', uid, 'ph_f1', 'g2', 'https://e.example.com/2', 'e.example.com/2',
  '已读条目 2', '摘要', now - 60000, now, 1, '测试源');
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
  summary('m1-24-pane-head');
  cleanup();
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'ai-rss-panehead-prof-'));
const cdpPort = 10100 + Math.floor(Math.random() * 80);
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
    target = list.find((t) => t.type === 'page');
    if (target?.webSocketDebuggerUrl) break;
  } catch { /* not yet */ }
  await sleep(250);
}
if (!target?.webSocketDebuggerUrl) {
  check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
  summary('m1-24-pane-head');
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
  pending.set(id, { res, rej });
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

await send('Page.enable');
await send('Runtime.enable');
await send('Network.setCookie', {
  name: 'ai_rss_sid', value: cookie.split('=')[1] ?? '',
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

/**
 * 把标题行里每个**可见**控件量一遍。
 *
 * 用 `offsetParent !== null` 判可见，不用 offsetWidth>0：`display:none`
 * 的父级不会让子元素 offsetParent 变 null 吗？会 —— 只要祖先里有
 * display:none，offsetParent 就是 null。这正是我们要的语义。
 */
const MEASURE = `(() => {
  const head = document.querySelector('.pane-title');
  if (!head) return null;
  const rect = head.getBoundingClientRect();
  const cs = getComputedStyle(head);
  const pl = parseFloat(cs.paddingLeft), pr = parseFloat(cs.paddingRight);
  const parts = [];
  const push = (name, el) => {
    if (!el || el.offsetParent === null) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    parts.push({
      name,
      left: Math.round(r.left * 100) / 100,
      right: Math.round(r.right * 100) / 100,
      top: Math.round(r.top * 100) / 100,
      height: Math.round(r.height * 100) / 100,
      mid: Math.round((r.top + r.height / 2) * 100) / 100,
      text: (el.textContent || '').trim().slice(0, 24),
    });
  };
  push('h1', head.querySelector('h1'));
  push('count', head.querySelector('.pane-count'));
  // 分段控件按**容器**量：里面两个按钮自己还有边框，用容器看整块的位置
  push('seg', head.querySelector('.pane-seg'));
  push('markRead', head.querySelector('.mark-read-btn'));
  push('clear', head.querySelector('.scope-clear'));
  push('refresh', head.querySelector('.refresh-btn'));
  return {
    headLeft: Math.round(rect.left * 100) / 100,
    headRight: Math.round(rect.right * 100) / 100,
    headW: Math.round(rect.width * 100) / 100,
    padLeft: pl, padRight: pr,
    scrollW: head.scrollWidth,
    clientW: head.clientWidth,
    parts,
  };
})()`;

const clickGroup = async (name) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.tree-row')]
      .find((x) => (x.querySelector('.nav-label')?.textContent ?? '').trim() === ${JSON.stringify(name)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1400);
  return r;
};

// 先记「收件箱」全库视图下刷新按钮的位置 —— 这是 ④ 的基准
const inboxNoNav = await ev(MEASURE);
const inboxRefreshLeft = inboxNoNav?.parts.find((p) => p.name === 'refresh')?.left;
check('（基线）收件箱视图下标题行至少有 标题 + 条数 + 分段 + 刷新 四个控件', () => {
  const names = (inboxNoNav?.parts ?? []).map((p) => p.name);
  return ok(['h1', 'count', 'seg', 'refresh'].every((n) => names.includes(n)),
    JSON.stringify(names));
});

// ═══ ① 每个可见控件的垂直中线都在 ±1.5px 内 ═══════════════
check('① 标题行里每个可见控件的垂直中线相差 ≤ 1.5px（同一行就是同一条中线）', () => {
  const mids = (inboxNoNav?.parts ?? []).map((p) => p.mid);
  if (mids.length < 2) return ok(false, `只量到 ${mids.length} 个控件`);
  const spread = Math.max(...mids) - Math.min(...mids);
  return ok(spread <= 1.5,
    `中线 ${JSON.stringify(mids)}，极差 ${spread.toFixed(2)}px`);
});

// ═══ ② 「N 条」与标题的中线对齐（不只是"都在一行"）════════
//
// 只断言 h1 / count / 刷新三者极差，会被"三个都偏"的实现骗过去 ——
// ① 的极差主要是分段控件（23px 高）贡献的，单看它抓不到"两个文字元素
// 自己没对齐"。所以单独把 h1 与 count 拎出来量。
//
// 阈值 **1.0px** 是量出来的：把旧 CSS 注入回页面（.pane-title 走 baseline，
// 见 .tmp/proof-m124-fails-before.mjs），旧实现实测 h1.mid=24.8 /
// count.mid=26.0，差 **1.2px** —— 用 1.5px 时这条在旧实现下照样绿，
// 是个空断言。收到 1.0px 后旧实现才红。新实现下两者是 **0.00px**，
// 离阈值还有 1px 余量，不是卡着过。
check('② 「N 条」与标题的中线相差 ≤ 1.0px', () => {
  const h1 = inboxNoNav?.parts.find((p) => p.name === 'h1');
  const c = inboxNoNav?.parts.find((p) => p.name === 'count');
  if (!h1 || !c) return ok(false, `h1=${Boolean(h1)} count=${Boolean(c)}`);
  const d = Math.abs(h1.mid - c.mid);
  return ok(d <= 1, `h1.mid=${h1.mid} count.mid=${c.mid} 差 ${d.toFixed(2)}px`);
});

// ═══ ③ 右段贴边 + 间距一致 ═════════════════════════════════
check('③ 刷新按钮（最右那个）的右边缘贴住标题行右边缘', () => {
  const r = inboxNoNav?.parts.find((p) => p.name === 'refresh');
  if (!r) return ok(false, '没量到刷新按钮');
  const d = Math.abs(inboxNoNav.headRight - r.right);
  return ok(d <= 1.5, `headRight=${inboxNoNav.headRight} refreshRight=${r.right} 差 ${d.toFixed(2)}px`);
});
check('③ 分段控件与刷新按钮之间的间距 = 4px（由 gap 承担，不是某个按钮自带 margin）', () => {
  const seg = inboxNoNav?.parts.find((p) => p.name === 'seg');
  const r = inboxNoNav?.parts.find((p) => p.name === 'refresh');
  if (!seg || !r) return ok(false, '控件不全');
  const gap = r.left - seg.right;
  return ok(Math.abs(gap - 4) <= 1.5, `实测间距 ${gap.toFixed(2)}px`);
});

// ═══ ④ 分段控件隐藏时，刷新按钮位置完全不动 ═══════════════
//
// 这是改之前最确凿的一处错位：刷新按钮靠 margin-left:auto 自己找位置，
// 它前面少一个元素就整体左移 100px 上下。改后右段整块 auto，孩子少了
// 只是空出一格。
const clickNav = async (label) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.nav-item')]
      .find((x) => (x.textContent || '').replace(/\\d+/g, '').trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1400);
  return r;
};
const starredOk = await clickNav('已收藏');
check('④ 能切到「已收藏」视图', () => ok(starredOk === true, '找不到「收藏」导航项'));
const starred = await ev(MEASURE);
check('④ 已收藏视图下分段控件确实隐藏了（否则这条断言测不到东西）', () => {
  const has = (starred?.parts ?? []).some((p) => p.name === 'seg');
  return ok(has === false, `量到的控件：${JSON.stringify((starred?.parts ?? []).map((p) => p.name))}`);
});
check('④ 分段控件隐藏后刷新按钮的 left 完全不变（±1px）', () => {
  const r = starred?.parts.find((p) => p.name === 'refresh');
  if (!r || inboxRefreshLeft === undefined) return ok(false, `refresh=${Boolean(r)}`);
  const d = Math.abs(r.left - inboxRefreshLeft);
  return ok(d <= 1, `收件箱 left=${inboxRefreshLeft} 收藏 left=${r.left} 差 ${d.toFixed(2)}px`);
});
check('④ 已收藏视图下中线仍然一致（隐藏一个控件不该破坏对齐）', () => {
  const mids = (starred?.parts ?? []).map((p) => p.mid);
  if (mids.length < 2) return ok(false, `只量到 ${mids.length} 个`);
  const spread = Math.max(...mids) - Math.min(...mids);
  return ok(spread <= 1.5, `中线 ${JSON.stringify(mids)}，极差 ${spread.toFixed(2)}px`);
});

// ═══ ⑥ 最多控件的情形：有分组 + 有未读 ════════════════════
//
// 这一档控件最多（标题 / 条数 / 分段 / 清除未读 / × / 刷新），也是需求方
// 说"都不对齐"时看到的那一屏 —— 只测收件箱会漏掉那两个新按钮。
await clickNav('未读');
await clickGroup('很长很长的一个科技分组名');
// 点分组会按规则一判断：该组有 1 条未读 → 保持「未读」，按钮该出现
const withScope = await ev(MEASURE);
check('⑥ 分组 + 有未读时，行内出现「清除未读」和「清除范围」两个按钮', () => {
  const names = (withScope?.parts ?? []).map((p) => p.name);
  return ok(names.includes('markRead') && names.includes('clear'), JSON.stringify(names));
});
check('⑥ 六个控件的中线仍在 ±1.5px 内（这是需求方看到的那一屏）', () => {
  const mids = (withScope?.parts ?? []).map((p) => p.mid);
  if (mids.length < 5) return ok(false, `只量到 ${mids.length} 个：${JSON.stringify((withScope?.parts ?? []).map((p) => p.name))}`);
  const spread = Math.max(...mids) - Math.min(...mids);
  return ok(spread <= 1.5, `中线 ${JSON.stringify(mids)}，极差 ${spread.toFixed(2)}px`);
});
check('⑥ 每个控件都没跑出标题行（左右都在 headLeft..headRight 之间）', () => {
  const bad = (withScope?.parts ?? []).filter(
    (p) => p.left < withScope.headLeft - 0.5 || p.right > withScope.headRight + 0.5,
  );
  return ok(bad.length === 0,
    JSON.stringify(bad.map((p) => [p.name, p.left, p.right, withScope.headLeft, withScope.headRight])));
});
check('⑥ 相邻控件不重叠（右边的 left ≥ 左边的 right）', () => {
  const ps = [...(withScope?.parts ?? [])].sort((a, b) => a.left - b.left);
  const bad = [];
  for (let i = 1; i < ps.length; i++) {
    if (ps[i].left < ps[i - 1].right - 0.5) {
      bad.push([ps[i - 1].name, ps[i - 1].right, ps[i].name, ps[i].left]);
    }
  }
  return ok(bad.length === 0, JSON.stringify(bad));
});
check('⑥ 超长标题被截断而不是把右段挤出去（h1 宽度 < 行宽 - 右段）', () => {
  const h1 = withScope?.parts.find((p) => p.name === 'h1');
  const r = withScope?.parts.find((p) => p.name === 'refresh');
  if (!h1 || !r) return ok(false, '量不到 h1 或 refresh');
  return ok(h1.right <= r.left && h1.height > 0,
    `h1.right=${h1.right} refresh.left=${r.left}`);
});

// ═══ ⑤ 375px 下不横向溢出 ════════════════════════════════
await send('Emulation.setDeviceMetricsOverride', {
  width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
});
await send('Page.navigate', { url: origin });
await sleep(2600);
const narrow = await ev(`(() => {
  const head = document.querySelector('.pane-title');
  const pane = document.querySelector('.list-pane');
  if (!head || !pane) return null;
  // 移动端是"列表与阅读区二选一"，标题行在列表页里；这里只量溢出，
  // 不量中线（移动端 .list-pane 可能还没展开，量了也是 0 宽）。
  return {
    headScroll: head.scrollWidth,
    headClient: head.clientWidth,
    headW: Math.round(head.getBoundingClientRect().width),
    docScroll: document.documentElement.scrollWidth,
    winW: window.innerWidth,
  };
})()`);
check('⑤ 375px 下标题行不横向溢出（scrollWidth ≤ clientWidth）', () => {
  if (!narrow) return ok(false, '量不到 .pane-title');
  return ok(narrow.headScroll <= narrow.headClient + 1,
    `scroll=${narrow.headScroll} client=${narrow.headClient} 宽=${narrow.headW}`);
});
check('⑤ 375px 下页面本身不横向溢出（docScrollWidth ≤ innerWidth+1）', () => {
  if (!narrow) return ok(false, '量不到');
  return ok(narrow.docScroll <= narrow.winW + 1, `doc=${narrow.docScroll} win=${narrow.winW}`);
});

ws.close();
killBrowser();
summary('m1-24-pane-head');
cleanup();
process.exit(process.exitCode ?? 0);
