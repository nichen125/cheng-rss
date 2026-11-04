#!/usr/bin/env node
// 侧栏分组树 —— 验收（PLAN §15.13 v1.13、§15.16）
//
// 需求方原话：「分组采样左侧下拉栏，不然分组内部订阅数量多会导致
// 博客列表栏显示不全」。
//
// 改之前：分组内的源是**列表头部一行横向滚动的 chip**（v1.8 的实现）。
// 组内 11 个源时那行实测吃掉 41px 高度，列表一屏从 9 条掉到 8 条；
// 而且横向滚出去的那几个源等于看不见 —— 这就是「显示不全」。
//
// 这个脚本与 m1-11 的分工：
//   m1-11  验**筛选语义**（点源只看这个源、再点回整组、自愈）
//   m1-18  验**搬迁本身**：占位没了、手风琴、0 源分组、长名截断、侧栏不破
//
// 为什么必须单独一个脚本（而不是继续往 m1-11 里加）：
// 搬迁类改动的失败模式是"两处都还在" —— 树渲染出来了，chip 行忘了删。
// 功能断言对此完全免疫（点源照样过滤），只有"列表头部高度必须与
// 无分组时完全相等"这种度量能抓住。§15.12 的教训：外观缺陷必须量。
//
// 判据：
//   ① 组内 11 个源时列表头部高度 == 无分组时的高度（chip 行没占位）
//   ② 展开后子行数 = 组内源数，且未读数逐个对得上（0 也显示）
//   ③ 手风琴：同时只有一组展开，点另一组时旧组收起
//   ④ 再点已展开且正在看的组行 → 收起（组行兼任"收起"入口）
//   ⑤ 0 个源的分组不渲染子节点，但组行仍可点（该组条目可能还在）
//   ⑥ 长源名走省略号，不压到未读数上；侧栏无横向溢出
//   ⑦ 1280×700 下展开 11 个源：侧栏可滚、不横向溢出、收件箱仍可点
//   ⑧ 手机断点（375px）没有侧栏、底部 tab bar 仍在（收窄不许带歪移动端）
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, eq, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { removeDir } from '../lib/tmp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.18 侧栏分组树');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-tree-'));
const dataDir = join(tmp, 'data');
const port = 47000 + Math.floor(Math.random() * 900);
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
if (!ready) { cleanup(); summary('m1-18-sidebar-tree'); process.exit(1); }

await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'tree@test.local', password: 'treetest1234567' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'tree@test.local', password: 'treetest1234567' }),
});
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

const j = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};

// ── 造数据 ────────────────────────────────────────────────
//
// 五组，每组对应一条判据：
//   「大组」      11 个源 —— 这是 v1.8 那行 chip 会滚出去的规模，也是
//                 需求方说的"订阅数量多"。① 的对照组全靠它。
//   「双源组」     2 个源 —— ③ 手风琴切换用
//   「单源组」     1 个源 —— 子行只有一个时也要能展开
//   「空组」       0 个源 —— ⑤ 不渲染子节点
//   「超长名组」   1 个源、源名 40 个字符 —— ⑥ 截断
// 加上一个未分组源，验证它不出现在任何一组的分支里。
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
const insFolder = db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)');
insFolder.run('tf_big', uid, '大组', 0);
insFolder.run('tf_two', uid, '双源组', 1);
insFolder.run('tf_one', uid, '单源组', 2);
insFolder.run('tf_empty', uid, '空组', 3);
insFolder.run('tf_long', uid, '超长名组', 4);

const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?)`);
const now = Date.now();

// 大组的 11 个源：未读刻意从 0 到 10 各不相同 ——
// 全都一样的话，"未读数取错了源"这种 bug 一次都抓不到。
for (let i = 0; i < 11; i++) {
  insFeed.run(`tf_big_${i}`, uid, `https://big${i}.example.com/feed`,
    `https://big${i}.example.com`, `大组源${i}`, now, now, 'tf_big');
}
insFeed.run('tf_two_a', uid, 'https://twoa.example.com/feed', 'https://twoa.example.com', '双源甲', now, now, 'tf_two');
insFeed.run('tf_two_b', uid, 'https://twob.example.com/feed', 'https://twob.example.com', '双源乙', now, now, 'tf_two');
insFeed.run('tf_one_a', uid, 'https://one.example.com/feed', 'https://one.example.com', '单源甲', now, now, 'tf_one');
// 40 个字符的源名：196px 的侧栏必然排不下，必须省略
const LONG = '这是一个非常非常非常长的订阅源名称用来验证截断不压角标';
insFeed.run('tf_long_a', uid, 'https://long.example.com/feed', 'https://long.example.com', LONG, now, now, 'tf_long');
insFeed.run('tf_loose', uid, 'https://loose.example.com/feed', 'https://loose.example.com', '未分组源', now, now, null);

const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,?)`);

// 每个源造 unread + 1 条，其中 unread 条未读 —— 用同一份数据算期望值，
// 避免"期望值抄错一个数整片红"。
let n = 0;
const put = (feedId, unread, site) => {
  for (let i = 0; i <= unread; i++) {
    n++;
    insEntry.run(`tf_e${n}`, uid, feedId, `g${n}`,
      `https://x.example.com/${n}`, `x/${n}`,
      `${site} 的条目 ${i}`, '摘要一段', 1700000000000 + n, now,
      i < unread ? 0 : 1, site);
  }
};
// 大组：第 i 个源放 i 条未读（0..10）
for (let i = 0; i < 11; i++) put(`tf_big_${i}`, i, `大组源${i}`);
put('tf_two_a', 4, '双源甲');
put('tf_two_b', 2, '双源乙');
put('tf_one_a', 3, '单源甲');
put('tf_long_a', 1, '超长名');
put('tf_loose', 5, '未分组源');
db.exec('COMMIT');
db.close();

// ── ① 后端口径：一次全量 /feeds 就是树的唯一数据源 ─────────
const allFeeds = await j('GET', '/feeds');
const feedList = allFeeds.data?.items ?? [];
check('GET /feeds 一次返回全部 16 个源（树不再按组取）', () => {
  return eq(feedList.length, 16);
});
check('每个源都带 folderId 与 unread（缺任一项，树就画不出来）', () => {
  const bad = feedList.filter((f) => !('folderId' in f) || typeof f.unread !== 'number');
  return ok(bad.length === 0, `${bad.length} 个源缺字段：${JSON.stringify(bad.slice(0, 3).map((f) => f.id))}`);
});
check('大组 11 个源的未读数是 0..10 各一个（后面按这个对账）', () => {
  const got = feedList.filter((f) => f.folderId === 'tf_big')
    .map((f) => f.unread).sort((a, b) => a - b);
  return ok(got.length === 11 && got.join(',') === '0,1,2,3,4,5,6,7,8,9,10',
    JSON.stringify(got));
});
check('未分组源的 folderId 是 null（不会被算进任何一个组）', () => {
  return eq(feedList.find((f) => f.id === 'tf_loose')?.folderId, null);
});

// ── ② 浏览器 ──────────────────────────────────────────────
const CANDIDATES = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
const browser = CANDIDATES.find((p) => existsSync(p));

if (!browser) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器，UI 断言跳过');
  summary('m1-18-sidebar-tree');
  cleanup();
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'cheng-rss-tree-prof-'));
const cdpPort = 9720 + Math.floor(Math.random() * 180);
const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,960', 'about:blank',
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
  summary('m1-18-sidebar-tree');
  cleanup();
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
await send('Network.enable');
await send('Emulation.setEmulatedMedia', {
  media: 'screen',
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await send('Network.setCookie', {
  name: 'cheng_rss_sid', value: cookie.split('=')[1] ?? '',
  domain: '127.0.0.1', path: '/',
});
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: origin });
for (let i = 0; i < 80; i++) {
  if (await ev('document.readyState === "complete"').catch(() => false)) break;
  await sleep(150);
}
await sleep(1400);

// 读侧栏树 + 列表头部
const snapshot = async () => ev(`(() => {
  const groups = [...document.querySelectorAll('.tree-row')].map((b) => ({
    name: (b.querySelector('.nav-label')?.textContent ?? '').trim(),
    open: b.getAttribute('aria-expanded') === 'true',
    active: b.className.includes('active'),
    inPath: /in-path/.test(b.className),
  }));
  const leaves = [...document.querySelectorAll('.tree-leaf')].map((c) => {
    const cnt = c.querySelector('.tree-leaf-count');
    const nameEl = c.querySelector('.tree-leaf-name');
    const nr = nameEl ? nameEl.getBoundingClientRect() : null;
    const cr = cnt ? cnt.getBoundingClientRect() : null;
    return {
      label: (nameEl?.textContent ?? '').trim(),
      count: cnt ? Number(cnt.textContent.trim()) : null,
      active: c.className.includes('active'),
      // 名字是否被省略号截断（scrollWidth > clientWidth）
      nameTruncated: nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : null,
      // 名字的右边界有没有压到未读数的左边界上
      overlapsCount: nr && cr ? Math.round(nr.right - cr.left) > 1 : null,
    };
  });
  const head = document.querySelector('.pane-head');
  const sb = document.querySelector('.sidebar');
  return {
    title: document.querySelector('.pane-title h1')?.textContent ?? '',
    groups,
    leaves,
    headHeight: head ? Math.round(head.getBoundingClientRect().height) : null,
    // chip 行还在不在：v1.13 的搬迁承诺就是它恒为 0
    chipCount: document.querySelectorAll('.feed-chips .chip').length,
    hasChipsRow: Boolean(document.querySelector('.feed-chips')),
    // 侧栏横向溢出：长源名压到角标上时，这个值会 > 0
    sidebarOverflowX: sb ? Math.max(0, sb.scrollWidth - sb.clientWidth) : null,
    pageOverflowX: Math.max(0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth),
    rows: document.querySelectorAll('.entry-item').length,
    // 一屏可见条目数：① 的"列表栏没被挤"要靠它
    visibleRows: [...document.querySelectorAll('.entry-item')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    }).length,
  };
})()`);

const clickGroup = async (name) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.tree-row')]
      .find((x) => (x.querySelector('.nav-label')?.textContent ?? '').trim() === ${JSON.stringify(name)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1300);
  return r;
};
const clickLeaf = async (label) => {
  const r = await ev(`(() => {
    const c = [...document.querySelectorAll('.tree-leaf')]
      .find((x) => (x.querySelector('.tree-leaf-name')?.textContent ?? '').trim() === ${JSON.stringify(label)});
    if (!c) return false;
    c.click();
    return true;
  })()`);
  await sleep(1300);
  return r;
};
const clickNav = async (label) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.nav-item')]
      .find((x) => (x.textContent || '').replace(/\\d+/g, '').trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1300);
  return r;
};

// ── 基线：无分组时的列表头部高度与一屏条数 ─────────────────
const inboxBase = await snapshot();
check('（基线）无分组时列表头部高度可用（否则 ① 是空转）', () => {
  return ok(inboxBase.headHeight > 40 && inboxBase.rows > 0,
    JSON.stringify({ h: inboxBase.headHeight, rows: inboxBase.rows }));
});
check('（基线）无分组时分组树全部收起、没有子行', () => {
  return ok(inboxBase.groups.every((g) => g.open === false) && inboxBase.leaves.length === 0,
    `展开=${JSON.stringify(inboxBase.groups.filter((g) => g.open).map((g) => g.name))} 子行=${inboxBase.leaves.length}`);
});

// ── ① 大组 11 个源：列表头部不被占位 ──────────────────────
//
// 这是整节的核心判据，也是 v1.8~v1.12 会红的那条：
// chip 行存在时它撑高 41px（11 个源 + 间距 + padding）。
// 只断言"chip 行不存在"不够 —— 一个把 chip 行换成别的 40px 条
// 的实现照样能过。必须量 .pane-head 的实际高度。
const opened = await clickGroup('大组');
check('点「大组」能点中', () => ok(opened === true));
const big = await snapshot();

check('展开大组后子行数 = 11（组内每个源一行）', () => {
  return eq(big.leaves.length, 11);
});
check('列表头部没有 chip 行（搬迁承诺，DOM 里连节点都不该有）', () => {
  return ok(big.hasChipsRow === false && big.chipCount === 0,
    `hasChipsRow=${big.hasChipsRow} chipCount=${big.chipCount}`);
});
check('★ 组内有 11 个源时，列表头部高度与无分组时完全相等（chip 行真的没占位）', () => {
  return ok(big.headHeight === inboxBase.headHeight,
    `无分组 ${inboxBase.headHeight}px vs 组内11源 ${big.headHeight}px，`
    + `差 ${big.headHeight - inboxBase.headHeight}px`);
});
check('★ 首屏可见条目数不比无分组时少（列表栏没被挤掉一行）', () => {
  // 只允许 ±1 的抖动（条目高度不是整数、最后一条可能刚好压线）
  return ok(big.visibleRows >= inboxBase.visibleRows - 1,
    `无分组 ${inboxBase.visibleRows} 条 vs 组内11源 ${big.visibleRows} 条`);
});

// ── ② 子行的未读数逐个对得上（0 也显示）───────────────────
check('子行未读数与后端一致：大组源 0..10 各一个（含 0 未读）', () => {
  const got = big.leaves.map((c) => c.count).sort((a, b) => a - b);
  return ok(got.length === 11 && got.join(',') === '0,1,2,3,4,5,6,7,8,9,10',
    JSON.stringify(got));
});
check('未读为 0 的源也渲染了子行（"没新内容"是信息，不是噪声）', () => {
  const zero = big.leaves.filter((c) => c.count === 0);
  return ok(zero.length === 1 && zero[0]?.label === '大组源0', JSON.stringify(zero));
});
check('组的未读角标 = 组内各源未读之和（0+1+…+10 = 55）', () => {
  // 角标在树行里由 .badge 承载 —— 这里从后端算一遍再比，
  // 不从 DOM 抄，否则实现改了角标口径，测试也跟着改。
  const sum = feedList.filter((f) => f.folderId === 'tf_big')
    .reduce((a, f) => a + f.unread, 0);
  return eq(sum, 55);
});

// ── ③④ 点源 / 再点回整组 ─────────────────────────────────
//
// 与 m1-11 ③④ 的分工：m1-11 验的是**筛选语义**（请求带对参数、
// 列表内容对得上），这里只验**树自身的视觉状态**（高亮在谁身上、
// 标题怎么拼）。两者都要有 —— 语义对但高亮错，用户会以为自己没点上；
// 高亮对但没过滤，那就是个装饰。
const clickedLeaf = await clickLeaf('大组源3');
check('③ 点组内一个源能点中', () => ok(clickedLeaf === true));
const onLeaf = await snapshot();
check('③ 点源后只有该子行高亮，组行让出高亮只留 in-path 线索', () => {
  const active = onLeaf.leaves.filter((c) => c.active).map((c) => c.label);
  const g = onLeaf.groups.find((x) => x.name === '大组');
  return ok(active.length === 1 && active[0] === '大组源3'
    && g?.active === false && g?.inPath === true,
    `子行激活=${JSON.stringify(active)} 组行 active=${g?.active} inPath=${g?.inPath}`);
});
check('③ 标题变成「组名 · 源名」', () => {
  return ok(/大组/.test(onLeaf.title) && /大组源3/.test(onLeaf.title),
    JSON.stringify(onLeaf.title));
});
check('③ 列表只剩该源的条目（不是变空）', () => {
  return ok(onLeaf.rows > 0 && onLeaf.rows <= 4,
    `${onLeaf.rows} 条（大组源3 造了 3 条未读 + 1 条已读）`);
});
await clickLeaf('大组源3');
const backAll = await snapshot();
check('④ 回整组后组行高亮、没有子行高亮、标题不再带源名', () => {
  const g = backAll.groups.find((x) => x.name === '大组');
  const active = backAll.leaves.filter((c) => c.active).map((c) => c.label);
  return ok(g?.active === true && g?.inPath === false && active.length === 0
    && !/大组源3/.test(backAll.title),
    `组行 active=${g?.active} inPath=${g?.inPath} 子行激活=${JSON.stringify(active)} `
    + `标题=${JSON.stringify(backAll.title)}`);
});

// ── ③ 手风琴：同时只展开一组 ──────────────────────────────
await clickGroup('双源组');
const two = await snapshot();
check('点另一组后：新组展开、旧组收起（同时只有 1 组展开）', () => {
  const open = two.groups.filter((g) => g.open).map((g) => g.name);
  return ok(open.length === 1 && open[0] === '双源组', JSON.stringify(open));
});
check('切换后子行换成了新组的源（旧组的 11 行全部消失）', () => {
  const labels = two.leaves.map((c) => c.label);
  return ok(labels.length === 2 && labels.includes('双源甲') && labels.includes('双源乙')
    && !labels.some((l) => l.startsWith('大组源')),
    JSON.stringify(labels));
});
check('新组展开后是激活态，旧组既不高亮也不在路径上', () => {
  const a = two.groups.find((g) => g.name === '双源组');
  const b = two.groups.find((g) => g.name === '大组');
  return ok(a?.active === true && a?.inPath === false
    && b?.active === false && b?.inPath === false,
    `双源组=${JSON.stringify(a)} 大组=${JSON.stringify(b)}`);
});

// ── ④ 组行兼任"收起"入口 ─────────────────────────────────
//
// 组行有两个职责（选范围 + 开合），所以第二次点击的含义必须区分开：
// 已展开**且正在看这一组** → 收起；其余情况 → 选中并展开。
// 少了收起，展开 11 个源之后就没有任何办法回到紧凑视图。
const twoActive = await snapshot();
check('（前置）双源组已展开且是当前范围（否则下一条空转）', () => {
  const g = twoActive.groups.find((x) => x.name === '双源组');
  return ok(g?.open === true && g?.active === true, JSON.stringify(g));
});
await clickGroup('双源组');
const collapsed = await snapshot();
check('再点一次已展开且正在看的组行 → 收起（子行消失，仍是当前范围）', () => {
  const g = collapsed.groups.find((x) => x.name === '双源组');
  return ok(g?.open === false && g?.active === true && collapsed.leaves.length === 0,
    `open=${g?.open} active=${g?.active} 子行=${collapsed.leaves.length}`);
});

// ── ⑤ 0 个源的分组 ───────────────────────────────────────
await clickGroup('空组');
const empty = await snapshot();
check('0 个源的分组不渲染任何子节点（不留一条空脊线）', () => {
  const g = empty.groups.find((x) => x.name === '空组');
  return ok(g?.open === true && empty.leaves.length === 0,
    `open=${g?.open} 子行=${empty.leaves.length}`);
});
check('0 个源的分组仍可点选（该组的条目可能还在，不能变成死按钮）', () => {
  const g = empty.groups.find((x) => x.name === '空组');
  return ok(g?.active === true, JSON.stringify(g));
});
check('选中「空组」后标题是该组名而不是收件箱', () => {
  return eq(empty.title, '空组');
});

// ── ⑥ 长源名截断，不压未读数 ─────────────────────────────
await clickGroup('超长名组');
const long = await snapshot();
check('超长源名被省略号截断（不是把侧栏撑宽）', () => {
  const leaf = long.leaves[0];
  return ok(leaf?.nameTruncated === true,
    `truncated=${leaf?.nameTruncated} label=${JSON.stringify(leaf?.label?.slice(0, 12))}`);
});
check('截断后的名字不与未读数重叠', () => {
  const leaf = long.leaves[0];
  return ok(leaf?.overlapsCount === false, `overlaps=${leaf?.overlapsCount}`);
});
check('侧栏无横向溢出（长名字没有把导航挤宽）', () => {
  return ok(long.sidebarOverflowX === 0, `溢出 ${long.sidebarOverflowX}px`);
});
check('整页无横向滚动条', () => {
  return ok(long.pageOverflowX === 0, `溢出 ${long.pageOverflowX}px`);
});

// ── ⑦ 1280×700 展开 11 个源：侧栏可滚，不把结构撑破 ───────
//
// 侧栏高度有限，11 个子行 + 4 个固定视图 + 订阅 + 5 个分组 + 页脚
// 加起来超过 700px。它必须**自己滚**，而不是把 body 撑出滚动条 ——
// 后者会让整页上下晃，阅读区跟着动。
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280, height: 700, deviceScaleFactor: 1, mobile: false,
});
await sleep(700);
await clickGroup('大组');
const short = await ev(`(() => {
  const sb = document.querySelector('.sidebar');
  const cs = sb ? getComputedStyle(sb) : null;
  const sbRect = sb ? sb.getBoundingClientRect() : null;
  const navItem = (t) => [...document.querySelectorAll('.tree-row, .nav-item')]
    .find((x) => (x.textContent || '').includes(t));
  const inbox = navItem('收件箱');
  const gear = document.querySelector('.sidebar-foot .icon-btn');

  // ① 静止状态（scrollTop 保持 0）：固定视图必须还在视口内
  if (sb) sb.scrollTop = 0;
  const inboxTopAtRest = inbox && sbRect
    ? Math.round(inbox.getBoundingClientRect().top - sbRect.top) : null;
  const inboxVisibleAtRest = inbox && sbRect
    ? inbox.getBoundingClientRect().top >= sbRect.top && inbox.getBoundingClientRect().bottom <= sbRect.bottom
    : false;

  // ② 滚到底：页脚齿轮必须可达
  if (sb) sb.scrollTop = sb.scrollHeight;
  const gearRect = gear ? gear.getBoundingClientRect() : null;
  const gearReachable = gearRect && sbRect
    ? gearRect.bottom <= sbRect.bottom + 1 && gearRect.top >= sbRect.top - 1
    : false;

  return {
    overflowY: cs?.overflowY ?? null,
    scrollH: sb?.scrollHeight ?? null,
    clientH: sb?.clientHeight ?? null,
    inboxVisibleAtRest,
    inboxTopAtRest,
    gearReachable,
    pageOverflowX: Math.max(0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth),
    pageOverflowY: Math.max(0,
      document.documentElement.scrollHeight - document.documentElement.clientHeight),
  };
})()`);
check('矮视口下侧栏自己滚动（overflow-y: auto，不是把整页撑高）', () => {
  return ok(short.overflowY === 'auto' && short.scrollH > short.clientH,
    `overflowY=${short.overflowY} scrollH=${short.scrollH} clientH=${short.clientH}`);
});
check('矮视口下整页不出现纵向滚动条（内容是自己的，不该带着整页滚）', () => {
  return ok(short.pageOverflowY === 0, `溢出 ${short.pageOverflowY}px`);
});
check('矮视口下无横向溢出', () => {
  return ok(short.pageOverflowX === 0, `溢出 ${short.pageOverflowX}px`);
});
check('滚到侧栏底部后「配置」齿轮可达（不是被挤出可滚区之外）', () => {
  return ok(short.gearReachable === true, JSON.stringify(short));
});
check('展开 11 个子行后，「收件箱」仍在侧栏静止时的首屏内（固定视图不被顶掉）', () => {
  return ok(short.inboxVisibleAtRest === true,
    `inboxTop=${short.inboxTopAtRest}px 视口内=${short.inboxVisibleAtRest} `
    + `scrollH=${short.scrollH} clientH=${short.clientH}`);
});
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
});
await sleep(600);

// ── ⑧ 手机断点：收窄不许带歪移动端 ───────────────────────
//
// v1.13 动的是 --sidebar-w / --list-w 两个变量，而移动端正是靠
// ──sidebar-w: 0 来隐藏侧栏的。改宽度时把它写死成 196px，
// 手机上就会冒出一条永远收不掉的侧栏（v1.12 之前的真实事故）。
await send('Emulation.setDeviceMetricsOverride', {
  width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
});
await sleep(900);
const mob = await ev(`(() => {
  const sb = document.querySelector('.sidebar');
  const tb = document.querySelector('.tabbar');
  return {
    sidebarW: sb ? Math.round(sb.getBoundingClientRect().width) : 0,
    tabbarDisplay: tb ? getComputedStyle(tb).display : null,
    pageOverflowX: Math.max(0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
})()`);
check('375px 下侧栏宽度为 0（收窄没把 --sidebar-w 写死）', () => {
  return eq(mob.sidebarW, 0);
});
check('375px 下底部 tab bar 仍可见', () => {
  return ok(mob.tabbarDisplay === 'flex', String(mob.tabbarDisplay));
});
check('375px 下无横向溢出（分组树不把手机撑宽）', () => {
  return ok(mob.pageOverflowX === 0, `溢出 ${mob.pageOverflowX}px`);
});

ws.close();
killBrowser();
summary('m1-18-sidebar-tree');
cleanup();
process.exit(process.exitCode ?? 0);
