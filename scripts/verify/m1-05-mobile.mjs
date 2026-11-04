#!/usr/bin/env node
// 1.10 移动端 —— 验收
//
// 判据（PLAN §15.7）：
//   ① 手机上侧栏隐藏，换成底部 tab bar（5 个入口）
//   ② 触摸目标 ≥ 44px（Apple HIG / Material 的下限）
//   ③ 输入框字号 ≥ 16px（iOS 上小于 16 会把页面放大）
//   ④ 底部安全区有 padding（不被 Home 条盖住）
//   ⑤ 阅读区在手机上全屏浮层，不挤成两栏
//   ⑥ 订阅页在手机上可用（能添加、能导入导出）
//   ⑦ 横屏（矮视口）不出现侧栏
//   ⑧ 无横向溢出（scrollWidth 不超过视口）
//
// 用真实浏览器 + 设备模拟。没有 Chromium 时整节 SKIP。
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { removeDir } from '../lib/tmp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const binName = process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.5 移动端');

const CANDIDATES = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium'];

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器');
  console.log('        移动端布局断言需要真实浏览器；本机没有则跳过（不算失败）');
  summary('m1-05-mobile');
  process.exit(0);
}
if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 起服务 ─────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-mob-'));
const dataDir = join(tmp, 'data');
const port = 38000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;

const srv = spawn(binPath, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
srv.stdout.on('data', () => { /* drain */ });

let ready = false;
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; }
  } catch { /* not yet */ }
  await sleep(250);
}
check('服务就绪', () => ok(ready, srvErr.slice(0, 300)));
if (!ready) {
  killTree(srv.pid);
  rmSync(tmp, { recursive: true, force: true });
  summary('m1-05-mobile');
  process.exit(1);
}

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'mob@test.local', password: 'mobtest12345' }),
});
const loginRes = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'mob@test.local', password: 'mobtest12345' }),
});
const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

// 灌几条数据，列表才有内容可测
try {
  execFileSync(nodeBin, [join(root, 'scripts/seed-demo.mjs'), '--data', dataDir], {
    stdio: 'pipe', timeout: 60000,
  });
} catch (e) {
  console.log(`  \u001b[33m!\u001b[0m seed 失败: ${String(e.stderr ?? e.message).slice(0, 150)}`);
}

// §15.28 起还要有分组：配置 › 分组的排序控件是手机上调顺序的唯一入口。
//
// seed-demo **只写 entries，不建 feeds 也不建 folders**（它自己的注释写着
// "只写 entries / entry_contents / entry_analysis"），所以这里得自己造。
// 第一版以为 seed 里有源可以挪过去，结果 SELECT 拿到空数组 ——
// 组内源那一层没有控件，两条断言报"测不到"。那不是通过，是前提不成立。
try {
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(join(dataDir, 'app.db'));
  const uid = d.prepare('SELECT id FROM users LIMIT 1').get()?.id;
  if (uid) {
    d.exec('BEGIN IMMEDIATE');
    d.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)')
      .run('m5_f1', uid, '移动端分组甲', 0);
    d.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)')
      .run('m5_f2', uid, '乙组', 1);
    // 第一组放两个源：组内源那层才有 ↑↓ 与「移到…」可量
    const now = Date.now();
    const ins = d.prepare(`INSERT INTO feeds (id,user_id,folder_id,url,site_url,title,
      icon_url,fetch_interval,last_fetched_at,next_fetch_at,error_count,status,sort,source_kind)
      VALUES (?,?,?,?,?,?,NULL,1800,?,?,0,'active',?,'rss')`);
    ins.run('m5_feed1', uid, 'm5_f1', 'https://m5a.example.com/feed',
      'https://m5a.example.com', '移动端源甲', now, now, 0);
    ins.run('m5_feed2', uid, 'm5_f1', 'https://m5b.example.com/feed',
      'https://m5b.example.com', '移动端源乙', now, now, 1);
    d.exec('COMMIT');
    d.close();
  }
} catch (e) {
  console.log(`  \u001b[33m!\u001b[0m 造分组失败: ${String(e?.message ?? e).slice(0, 150)}`);
}

// ── 浏览器 ─────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'ai-rss-mobprof-'));
const cdpPort = 9600 + Math.floor(Math.random() * 300);
const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  killTree(srv.pid);
  killTree(proc.pid);
  removeDir(profile);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
onExit(cleanup);

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
  summary('m1-05-mobile');
  process.exit(1);
}

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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval 失败');
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setEmulatedMedia', {
  media: 'screen',
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await send('Network.setCookie', {
  name: 'ai_rss_sid', value: cookie.split('=')[1] ?? '',
  domain: '127.0.0.1', path: '/',
});

/** iPhone 14 Pro 逻辑尺寸 + 真实安全区 */
const setPhone = async (w = 393, h = 852) => {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 3, mobile: true,
  });
  try {
    await send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: 59, bottom: 34, left: 0, right: 0 },
    });
  } catch { /* 旧版 Chromium 无此命令 */ }
};

const goto = async (url) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) {
    if (await evaluate('document.readyState === "complete"').catch(() => false)) break;
    await sleep(150);
  }
  await sleep(1000);
};

await setPhone();
await goto(`${base}/`);
await sleep(800);

// ── ① 底部导航替代侧栏 ────────────────────────────────────
const shell = await evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  const box = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) }; };
  const tabs = [...document.querySelectorAll('.tab')];
  return {
    sidebar: box('.sidebar'),
    tabbar: box('.tabbar'),
    tabCount: tabs.length,
    tabLabels: tabs.map((t) => t.querySelector('.tab-label')?.textContent ?? ''),
    tabWidths: tabs.map((t) => Math.round(t.getBoundingClientRect().width)),
    vw: window.innerWidth,
    vh: window.innerHeight,
    docScrollW: document.documentElement.scrollWidth,
  };
})()`);

check('手机上侧栏不可见', () => {
  return ok(!shell.sidebar || shell.sidebar.w === 0, JSON.stringify(shell.sidebar));
});
check('底部 tab bar 可见', () => ok(shell.tabbar && shell.tabbar.h > 40, JSON.stringify(shell.tabbar)));
// v1.24：5 → 6。简报页（§15.4）上线后成为一等入口，桌面侧栏与移动端
// tab 都要有。390px 宽下 6 格每格约 65px，仍高于 44px 触摸下限；
// 真正的约束是**高度**不是宽度（见 §15.7 的表）。
check('tab bar 有 6 个入口', () => ok(shell.tabCount === 6, `实际 ${shell.tabCount}: ${JSON.stringify(shell.tabLabels)}`));
check('tab 覆盖收件箱/未读/收藏/历史/简报/配置', () => {
  // v1.13：第 5 格从「订阅」改名「配置」—— 它打开的是整个配置弹窗
  // （订阅/分组/账户），订阅管理只是其中一分类。名字得对上行为。
  // v1.24：加入「简报」—— 它是每天的入口，藏进二级菜单等于没有。
  const want = ['收件箱', '未读', '已收藏', '历史', '简报', '配置'];
  const missing = want.filter((w) => !shell.tabLabels.includes(w));
  return ok(missing.length === 0, `缺 ${JSON.stringify(missing)}，实际 ${JSON.stringify(shell.tabLabels)}`);
});
// 6 格之后每格更窄 —— 断言它们仍然过 44px 的触摸下限。
// 不加这条的话"加了第 6 格把每格挤到 60px 以下"不会被发现，
// 而那是加格子的主要风险。
check('6 格之后每个 tab 仍 ≥44px 宽', () => {
  const narrow = (shell.tabLabels ?? []).length;
  return ok((shell.tabWidths ?? []).every((w) => w >= 44),
    `${narrow} 格，宽度 ${JSON.stringify(shell.tabWidths)}`);
});

check('tab bar 在最底部', () => {
  return ok(shell.tabbar && Math.abs(shell.tabbar.y + shell.tabbar.h - shell.vh) <= 40,
    `tabbar 底 = ${shell.tabbar ? shell.tabbar.y + shell.tabbar.h : '?'}, 视口高 = ${shell.vh}`);
});

// ── ② 触摸目标 ≥ 44px ─────────────────────────────────────
const touch = await evaluate(`(() => {
  const measure = (sel) => [...document.querySelectorAll(sel)].map((e) => {
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), text: (e.textContent ?? '').trim().slice(0, 12) };
  });
  return {
    tabs: measure('.tab'),
    items: measure('.entry-item').slice(0, 3),
    iconBtns: measure('.icon-btn').slice(0, 5),
  };
})()`);

check('tab 触摸目标高度 ≥ 44px', () => {
  const bad = touch.tabs.filter((t) => t.h < 44);
  return ok(bad.length === 0, `不达标 ${JSON.stringify(bad)}`);
});
check('列表项高度 ≥ 44px（够手指点）', () => {
  const bad = touch.items.filter((t) => t.h < 44);
  return ok(bad.length === 0, `不达标 ${JSON.stringify(bad)}`);
});

// ── ③ 输入框字号 ≥ 16px（防 iOS 自动放大）────────────────
const fontSize = await evaluate(`(() => {
  const i = document.querySelector('.search-box input');
  return i ? parseFloat(getComputedStyle(i).fontSize) : null;
})()`);
check('搜索框字号 ≥ 16px（iOS 不会自动放大）', () => {
  return ok(typeof fontSize === 'number' && fontSize >= 16, `实际 ${fontSize}px`);
});

// ── ④ 安全区 ──────────────────────────────────────────────
const safe = await evaluate(`(() => {
  const t = document.querySelector('.tabbar');
  const lp = document.querySelector('.list-pane');
  const cs = t ? getComputedStyle(t) : null;
  return {
    tabbarPadBottom: cs?.paddingBottom ?? null,
    listPadBottom: lp ? getComputedStyle(lp).paddingBottom : null,
  };
})()`);
check('tab bar 有底部安全区 padding', () => {
  // env() 在模拟环境里可能解析为 0（浏览器不支持时），至少要是 calc() 声明
  const v = String(safe.tabbarPadBottom ?? '');
  return ok(v.includes('px'), `padding-bottom=${v}`);
});
check('列表底部留出了 tab bar 的高度（最后一条不被盖）', () => {
  const v = String(safe.listPadBottom ?? '');
  const n = parseFloat(v);
  return ok(Number.isFinite(n) && n >= 56, `padding-bottom=${v}`);
});

// ── ⑧ 无横向溢出 ─────────────────────────────────────────
check('页面无横向溢出', () => {
  const diff = shell.docScrollW - shell.vw;
  return ok(diff <= 1, `scrollWidth ${shell.docScrollW} > 视口 ${shell.vw}（溢出 ${diff}px）`);
});

// ── ⑤ 阅读区全屏浮层 ─────────────────────────────────────
const opened = await evaluate(`(() => {
  const el = document.querySelector('.entry-item');
  if (!el) return false;
  el.click();
  return true;
})()`);
check('可点开条目', () => ok(opened));
await sleep(1300);

const reader = await evaluate(`(() => {
  const rp = document.querySelector('.reader-pane');
  if (!rp) return null;
  const cs = getComputedStyle(rp);
  const r = rp.getBoundingClientRect();
  const body = document.querySelector('.article-body');
  return {
    position: cs.position,
    display: cs.display,
    w: Math.round(r.width),
    h: Math.round(r.height),
    vw: window.innerWidth,
    vh: window.innerHeight,
    z: cs.zIndex,
    hasBody: Boolean(body && body.textContent.trim().length > 30),
    readerMaxW: document.querySelector('.reader')
      ? getComputedStyle(document.querySelector('.reader')).maxWidth : null,
  };
})()`);

check('阅读区在手机上全屏浮层', () => {
  return ok(reader && (reader.position === 'fixed' || reader.w >= reader.vw - 2),
    JSON.stringify(reader));
});
check('阅读浮层盖住 tab bar（z-index 更高）', () => {
  return ok(Number(reader?.z ?? 0) >= 30, `z-index=${reader?.z}`);
});
check('阅读区显示正文', () => ok(reader?.hasBody, '正文为空'));

// 返回
await evaluate(`(() => {
  const b = document.querySelector('.reader-bar .icon-btn');
  if (b) b.click();
})()`);
await sleep(700);

// ── ⑥ 配置在手机上可用 ───────────────────────────────────
//
// v1.13：底部导航那一格从「订阅」改名成「配置」（齿轮图标），
// 因为它打开的是整个配置弹窗（订阅/分组/账户），不是"订阅页"。
// 手机侧栏是隐藏的，所以这一格是移动端**唯一**的配置入口 ——
// 它不能跟着桌面的「订阅源」整块一起被删掉。
const toFeeds = await evaluate(`(() => {
  const t = [...document.querySelectorAll('.tab')].find((x) => x.textContent.includes('配置'));
  if (!t) return false;
  t.click();
  return true;
})()`);
check('可从底部导航进入配置', () => ok(toFeeds));
await sleep(900);

// 订阅管理现在在配置弹窗的「订阅」分类里，点进去再量
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.settings-nav-item')]
    .find((x) => (x.textContent || '').trim().includes('订阅'));
  if (b) b.click();
})()`);
await sleep(700);

const feedsPage = await evaluate(`(() => {
  const fp = document.querySelector('.feeds-page');
  if (!fp) return null;
  const r = fp.getBoundingClientRect();
  const btns = [...fp.querySelectorAll('button')].map((b) => ({
    text: (b.textContent ?? '').trim().slice(0, 10),
    h: Math.round(b.getBoundingClientRect().height),
    w: Math.round(b.getBoundingClientRect().width),
  }));
  return {
    w: Math.round(r.width),
    vw: window.innerWidth,
    padBottom: getComputedStyle(fp).paddingBottom,
    buttons: btns,
    hasAdd: btns.some((b) => b.text.includes('添加订阅')),
    hasImport: btns.some((b) => b.text.includes('导入')),
    hasExport: btns.some((b) => b.text.includes('导出')),
    docScrollW: document.documentElement.scrollWidth,
  };
})()`);

check('订阅页占满手机宽度', () => {
  return ok(feedsPage && feedsPage.w >= feedsPage.vw - 2,
    `宽 ${feedsPage?.w} / 视口 ${feedsPage?.vw}`);
});
check('订阅页有添加/导入/导出三个入口', () => {
  return ok(feedsPage?.hasAdd && feedsPage?.hasImport && feedsPage?.hasExport,
    JSON.stringify(feedsPage?.buttons?.map((b) => b.text)));
});
check('订阅页按钮高度 ≥ 36px（可点）', () => {
  const bad = (feedsPage?.buttons ?? []).filter((b) => b.h > 0 && b.h < 36);
  return ok(bad.length === 0, `不达标 ${JSON.stringify(bad)}`);
});
check('订阅页无横向溢出', () => {
  return ok(feedsPage && feedsPage.docScrollW - feedsPage.vw <= 1,
    `${feedsPage?.docScrollW} vs ${feedsPage?.vw}`);
});

// 打开添加面板
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.feeds-page button')]
    .find((x) => x.textContent.includes('添加订阅'));
  if (b) b.click();
})()`);
await sleep(600);
const addPanel = await evaluate(`(() => {
  const i = document.querySelector('.add-panel input');
  if (!i) return null;
  const r = i.getBoundingClientRect();
  const btn = [...document.querySelectorAll('.add-panel button')]
    .find((b) => b.textContent.includes('查找'));
  return {
    inputH: Math.round(r.height),
    inputFont: parseFloat(getComputedStyle(i).fontSize),
    inputW: Math.round(r.width),
    panelW: Math.round(document.querySelector('.add-panel').getBoundingClientRect().width),
    vw: window.innerWidth,
    btnH: btn ? Math.round(btn.getBoundingClientRect().height) : null,
  };
})()`);
check('手机上添加面板的输入框可用（高度 ≥ 40、字号 ≥ 16）', () => {
  return ok(addPanel && addPanel.inputH >= 40 && addPanel.inputFont >= 16,
    JSON.stringify(addPanel));
});
check('添加面板不超出屏幕', () => {
  return ok(addPanel && addPanel.panelW <= addPanel.vw,
    `${addPanel?.panelW} vs ${addPanel?.vw}`);
});

// ── ⑨ 配置 › 分组的排序控件（§15.28）─────────────────────
//
// 这一组控件在手机上是**唯一**能调分组顺序与组内源顺序的地方：侧栏在
// ≤640px 是 display:none，长按排列模式根本不存在。所以它必须过触摸红线，
// 而且不能指望桌面尺寸 —— 桌面是折叠箭头 18×18、↑↓ 24×26、
// 「移到…」22 高，三个都点不中。
//
// 这条原本不存在：m1-05 只量订阅页的按钮，配置 › 分组整页的控件
// 不在任何触摸断言里。实测 375px 下分别是 18 / 24 / 22，
// 全都不达标，而整套验收仍然全绿。
await setPhone(390, 844);
await sleep(500);
await evaluate(`(() => {
  const t = [...document.querySelectorAll('.tab')].find((x) => x.textContent.includes('配置'));
  if (t) t.click();
})()`);
await sleep(800);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.settings-nav-item')]
    .find((x) => (x.textContent || '').trim().includes('分组'));
  if (b) b.click();
})()`);
await sleep(700);
// 展开一个分组：组内源那一层的控件也要量
await evaluate(`(() => {
  const t = document.querySelector('.folder-twist');
  if (t) t.click();
})()`);
await sleep(500);

const folderCtl = await evaluate(`(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    twist: box(document.querySelector('.folder-twist')),
    rowArrows: [...document.querySelectorAll('.folder-manage-row .icon-arrow')].map(box),
    feedArrows: [...document.querySelectorAll('.folder-feed-list .icon-arrow')].map(box),
    selects: [...document.querySelectorAll('.folder-move-select')].map(box),
    hasRows: Boolean(document.querySelector('.folder-manage-row')),
    hasFeeds: Boolean(document.querySelector('.folder-feed-list li')),
    overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
})()`);

// 先确认真的渲染出了行，否则下面几条"全都不达标"是空真
check('配置 › 分组 在手机上渲染出分组行', () => {
  return ok(folderCtl?.hasRows === true, JSON.stringify(folderCtl));
});
check('配置 › 分组的折叠箭头 ≥36px（触摸下限，桌面是 18×18）', () => {
  const t = folderCtl?.twist;
  return ok(t && t.w >= 36 && t.h >= 36, JSON.stringify(t));
});
check('配置 › 分组的 ↑↓ ≥36px（桌面是 24×26）', () => {
  const bad = (folderCtl?.rowArrows ?? []).filter((a) => !a || a.w < 36 || a.h < 36);
  return ok(bad.length === 0, `不达标 ${JSON.stringify(bad)}`);
});
check('配置 › 组内源的 ↑↓ ≥36px', () => {
  const list = folderCtl?.feedArrows ?? [];
  // 没展开出源行时是"测不到"，不是"通过"
  if (!folderCtl?.hasFeeds) return ok(false, '没有展开出组内源行，测不到');
  const bad = list.filter((a) => !a || a.w < 36 || a.h < 36);
  return ok(bad.length === 0, `不达标 ${JSON.stringify(bad)}`);
});
check('配置 › 分组的「移到…」下拉 ≥36px 高（桌面是 22）', () => {
  const list = folderCtl?.selects ?? [];
  if (!folderCtl?.hasFeeds) return ok(false, '没有展开出组内源行，测不到');
  const bad = list.filter((s) => !s || s.h < 36);
  return ok(bad.length === 0, `不达标 ${JSON.stringify(bad)}`);
});
check('配置 › 分组 在手机上无横向溢出', () => {
  return ok(folderCtl?.overflowX === 0, `溢出 ${folderCtl?.overflowX}px`);
});

// ── ⑦ 横屏不出现侧栏 ─────────────────────────────────────
await setPhone(852, 393);
await sleep(700);
const landscape = await evaluate(`(() => {
  const sb = document.querySelector('.sidebar');
  const tb = document.querySelector('.tabbar');
  return {
    sidebarW: sb ? Math.round(sb.getBoundingClientRect().width) : 0,
    tabbarDisplay: tb ? getComputedStyle(tb).display : null,
    docScrollW: document.documentElement.scrollWidth,
    vw: window.innerWidth,
  };
})()`);
check('横屏（矮视口）不显示侧栏', () => {
  return ok(landscape.sidebarW === 0, `侧栏宽 ${landscape.sidebarW}px`);
});
check('横屏无横向溢出', () => {
  return ok(landscape.docScrollW - landscape.vw <= 1,
    `${landscape.docScrollW} vs ${landscape.vw}`);
});

// ── 桌面断点未被破坏（反向验证：放大后回到三栏）───────────
await setPhone(1440, 960);
await sleep(700);
const desktop = await evaluate(`(() => {
  const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return Math.round(r.width); };
  return {
    sidebar: box('.sidebar'),
    tabbar: document.querySelector('.tabbar') ? getComputedStyle(document.querySelector('.tabbar')).display : null,
  };
})()`);
check('放大到桌面尺寸后侧栏回来（移动端样式没污染桌面）', () => {
  return ok(desktop.sidebar > 150, `侧栏宽 ${desktop.sidebar}px`);
});
check('桌面下底部 tab bar 隐藏', () => {
  return ok(desktop.tabbar === 'none', `display=${desktop.tabbar}`);
});

ws.close();
summary('m1-05-mobile');
cleanup();
process.exit(process.exitCode ?? 0);
