#!/usr/bin/env node
// 收件箱阅读控制 —— 验收（PLAN §15.14）
//
// 需求方原话：「收件箱需要可以选择全部和未读，还要添加刷新按钮，让已读可以刷新」。
// 外加一条反馈：「收藏按钮在点击之后，还有收藏按钮，这样子就是两个收藏图标」。
//
// 这一节最容易假绿的地方（每条都写了"为什么这么验"）：
//
//   ① 「点未读后条数变少」很容易，但**变少的是不是恰好那些已读条目**才是
//      信息量。只断言"条数 < 全部"时，一个把列表清空的 bug 也能通过。
//   ② 「点刷新按钮后列表有内容」也会绿得理所当然 —— 因为列表本来就有内容。
//      必须**在外部改数据再刷新**，看到界面跟上，才算真的重新取了数。
//   ③ 「刷新不清空列表」如果只是"点完等它加载完再看"，实现里先 setItems([])
//      再填回去也一样绿。必须在请求在途时采样行数。
//   ④ 「刷新保留筛选」不能只看界面标题 —— 实现可能保留标题但请求里丢了
//      folderId。必须读实际发出的请求 URL。
//   ⑤ 「两个收藏图标」不能靠数 SVG —— 行内本来就有"收藏"和"新标签"两个
//      图标。判据是"这一行里有几个元素在表达收藏状态"。
//
// 判据：
//   ① 标题行里有「全部 / 未读」分段控件，默认「全部」激活
//   ② 点「未读」→ 列表不再含已读条目（逐条断言，不是只比条数）
//   ③ 点「全部」→ 已读条目回来（且仍是已读态），不是"再也不显示"
//   ④ 标题旁「N 条」跟着视图变（未读视图下是未读数，不是全库数）
//   ⑤ 侧栏「未读」与分段控件是同一份状态（点一处另一处同步）
//   ⑥ 刷新按钮存在、可点、刷新中变 disabled 且图标旋转
//   ⑦ 刷新不清空列表（请求在途时行数不为 0）
//   ⑧ 刷新真的重新取数（外部改数据后刷新，界面跟上）
//   ⑨ 刷新保留筛选（请求 URL 仍带 folderId / q，且视图仍是未读）
//   ⑩ 已收藏行只有一处收藏状态表达（star-mark 已删）
//   ⑪ 375px 视口下标题行无横向溢出
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.12 收件箱阅读控制');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-inbox-'));
const dataDir = join(tmp, 'data');
const port = 47200 + Math.floor(Math.random() * 700);
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
if (!ready) { cleanup(); summary('m1-12-inbox-view'); process.exit(1); }

await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ibv@test.local', password: 'ibvtest123456' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ibv@test.local', password: 'ibvtest123456' }),
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
// 数字是刻意选的，让"条数变化"能被具体数字抓住：
//   组「科技IT」2 个源：源甲 4 条（其中 2 条已读）、源乙 2 条（0 已读）
//   未分组 1 个源：散装 2 条（其中 1 条已读）
// 全库 8 条 / 已读 3 条 / 未读 5 条。三个数互相不等，写错任何一个都会红。
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)')
  .run('fd_ibv', uid, '科技IT', 0);

const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?)`);
insFeed.run('if_a', uid, 'https://ia.example.com/feed', 'https://ia.example.com', '源甲', Date.now(), Date.now(), 'fd_ibv');
insFeed.run('if_b', uid, 'https://ib.example.com/feed', 'https://ib.example.com', '源乙', Date.now(), Date.now(), 'fd_ibv');
insFeed.run('if_c', uid, 'https://ic.example.com/feed', 'https://ic.example.com', '散装', Date.now(), Date.now(), null);

const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,?)`);

/** 源甲 4 条：前 2 条已读，其中第 1 条已收藏 */
const A = [
  { id: 'ie_a0', read: 1, star: 1, title: 'A0 已读且收藏' },
  { id: 'ie_a1', read: 1, star: 0, title: 'A1 已读' },
  { id: 'ie_a2', read: 0, star: 0, title: 'A2 未读' },
  { id: 'ie_a3', read: 0, star: 0, title: 'A3 未读' },
];
/** 源乙 2 条：全未读 */
const B = [
  { id: 'ie_b0', read: 0, star: 0, title: 'B0 未读' },
  { id: 'ie_b1', read: 0, star: 0, title: 'B1 未读' },
];
/** 散装 2 条：1 条已读 */
const C = [
  { id: 'ie_c0', read: 1, star: 0, title: 'C0 已读' },
  { id: 'ie_c1', read: 0, star: 0, title: 'C1 未读' },
];

let clock = 1_700_000_000_000;
for (const [feedId, list, site] of [['if_a', A, '源甲'], ['if_b', B, '源乙'], ['if_c', C, '散装']]) {
  for (const e of list) {
    clock += 60_000;
    insEntry.run(
      e.id, uid, feedId, `g_${e.id}`, `https://x.example.com/${e.id}`, `x/${e.id}`,
      e.title, '摘要一段', clock, clock, e.read, e.star, site,
    );
  }
}
db.exec('COMMIT');
db.close();

// ── 后端口径自检（纯接口，先确认"全部/未读"两套数在服务端就是对的）──
const apiAll = await j('GET', '/entries?limit=100');
const apiUnread = await j('GET', '/entries?view=unread&limit=100');
check('后端：全部 8 条 / 未读 5 条（三个数字互不相等，写错就红）', () => {
  const all = apiAll.data?.items ?? [];
  const unread = apiUnread.data?.items ?? [];
  const allRead = all.filter((x) => x.isRead).length;
  return ok(all.length === 8 && unread.length === 5 && allRead === 3
    && apiAll.data?.total === 8 && apiUnread.data?.total === 5,
    `all=${all.length}(total ${apiAll.data?.total}) unread=${unread.length}(total ${apiUnread.data?.total}) 已读=${allRead}`);
});
check('后端：未读结果里一条已读都没有（不是只把 total 改了）', () => {
  const bad = (apiUnread.data?.items ?? []).filter((x) => x.isRead);
  return ok(bad.length === 0, `${bad.length} 条已读混进未读视图`);
});

// ── 浏览器 ────────────────────────────────────────────────
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
  summary('m1-12-inbox-view');
  cleanup();
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'ai-rss-ibvprof-'));
const cdpPort = 9900 + Math.floor(Math.random() * 90);
const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,960', 'about:blank',
], { stdio: 'ignore' });

const killBrowser = () => {
  killTree(proc.pid);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
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
  summary('m1-12-inbox-view');
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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
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
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});
await send('Network.setCookie', {
  name: 'ai_rss_sid', value: cookie.split('=')[1] ?? '',
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
await sleep(1500);

// ── 快照 ─────────────────────────────────────────────────
//
// 行信息里带上 `read` 类名：③「点全部后已读条目回来」必须能看出它们
// 回来时**仍是已读态**，否则"已读"和"未读"在视觉上分不出来，
// 用户点「全部」也就不知道自己在看什么。
const snapshot = () => ev(`(() => {
  const segBtns = [...document.querySelectorAll('.pane-seg .seg-btn')];
  const rows = [...document.querySelectorAll('.entry-item')].map((r) => ({
    title: r.querySelector('.entry-title')?.textContent ?? '',
    site: r.querySelector('.entry-site')?.textContent ?? '',
    read: r.className.includes('read'),
    // 收藏状态的表达者数量：旧实现是行内按钮 + 一个 star-mark = 2
    starExpr: r.querySelectorAll('.star-mark').length
      + r.querySelectorAll('.entry-ops button').length,
    starPressed: (() => {
      const b = [...r.querySelectorAll('.entry-ops button')]
        .find((x) => /收藏/.test(x.getAttribute('title') || ''));
      return b ? b.getAttribute('aria-pressed') : null;
    })(),
  }));
  const nav = [...document.querySelectorAll('.nav-item')].map((b) => ({
    label: (b.textContent || '').replace(/\\d+/g, '').trim(),
    active: b.className.includes('active'),
  }));
  const titleRow = document.querySelector('.pane-title');
  return {
    segCount: segBtns.length,
    segLabels: segBtns.map((b) => (b.textContent || '').trim()),
    segOn: segBtns.filter((b) => b.className.includes('on')).map((b) => (b.textContent || '').trim()),
    segAria: segBtns.map((b) => b.getAttribute('aria-pressed')),
    title: document.querySelector('.pane-title h1')?.textContent ?? '',
    count: (document.querySelector('.pane-count')?.textContent ?? '').trim(),
    rows,
    navUnreadActive: nav.some((n) => n.label === '未读' && n.active),
    navInboxActive: nav.some((n) => n.label === '收件箱' && n.active),
    hasRefresh: Boolean(document.querySelector('.refresh-btn')),
    refreshDisabled: document.querySelector('.refresh-btn')?.disabled ?? null,
    refreshSpinning: Boolean(document.querySelector('.refresh-btn.spinning')),
    titleOverflow: titleRow ? Math.max(0, titleRow.scrollWidth - titleRow.clientWidth) : null,
    starMarks: document.querySelectorAll('.star-mark').length,
  };
})()`);

const clickSeg = async (label) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.pane-seg .seg-btn')]
      .find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1200);
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

// 在页面里装一个 fetch 记录器：只记录 /entries? 的请求，并可选地加延迟。
//
// 为什么必须读实际请求而不是读界面：⑨ 要验的是"刷新有没有带着筛选重发"。
// 界面上的标题完全可以是本地 state 拼出来的 —— 标题对、请求错，
// 用户点一次刷新就被弹回全库，而断言如果只看标题会全绿。
await ev(`(() => {
  if (window.__probe) return true;
  const orig = window.fetch.bind(window);
  window.__probe = { calls: [], delay: 0 };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isEntries = url.includes('/entries?');
    if (isEntries) window.__probe.calls.push(url);
    if (isEntries && window.__probe.delay > 0) {
      await new Promise((r) => setTimeout(r, window.__probe.delay));
    }
    return orig(input, init);
  };
  return true;
})()`);

// ── ① 分段控件存在，默认「全部」 ──────────────────────────
const init = await snapshot();
check('标题行里有「全部 / 未读」分段控件（2 个按钮，文案对得上）', () => {
  return ok(init.segCount === 2
    && init.segLabels.includes('全部') && init.segLabels.includes('未读'),
    `segCount=${init.segCount} labels=${JSON.stringify(init.segLabels)}`);
});
check('默认「全部」激活、侧栏「收件箱」高亮', () => {
  return ok(init.segOn.length === 1 && init.segOn[0] === '全部' && init.navInboxActive,
    `segOn=${JSON.stringify(init.segOn)} navInbox=${init.navInboxActive}`);
});
check('默认列表是全库 8 条，其中 3 条是已读态', () => {
  const read = init.rows.filter((r) => r.read).length;
  return ok(init.rows.length === 8 && read === 3,
    `${init.rows.length} 条，已读 ${read} 条`);
});

// ── ② 点「未读」→ 只剩未读 ───────────────────────────────
const clickedUnread = await clickSeg('未读');
check('点「未读」能点中', () => ok(clickedUnread === true, '找不到「未读」分段按钮'));
const unreadView = await snapshot();

check('未读视图里一条已读都没有（逐条判，不是只比条数）', () => {
  const bad = unreadView.rows.filter((r) => r.read);
  return ok(unreadView.rows.length === 5 && bad.length === 0,
    `${unreadView.rows.length} 条，混进已读 ${bad.length} 条（${JSON.stringify(bad.slice(0, 3).map((x) => x.title))}）`);
});
check('未读视图的条目集合恰好是那 5 条未读（不多不少）', () => {
  const want = ['A2 未读', 'A3 未读', 'B0 未读', 'B1 未读', 'C1 未读'];
  const got = unreadView.rows.map((r) => r.title);
  const missing = want.filter((w) => !got.includes(w));
  const extra = got.filter((g) => !want.includes(g));
  return ok(missing.length === 0 && extra.length === 0,
    `缺 ${JSON.stringify(missing)}，多 ${JSON.stringify(extra)}`);
});
check('未读视图下分段控件「未读」激活、「全部」熄灭', () => {
  return ok(unreadView.segOn.length === 1 && unreadView.segOn[0] === '未读',
    `segOn=${JSON.stringify(unreadView.segOn)}`);
});
check('分段按钮带 aria-pressed，状态可机读（不只有 className）', () => {
  const pairs = Object.fromEntries(unreadView.segLabels.map((l, i) => [l, unreadView.segAria[i]]));
  return ok(pairs['未读'] === 'true' && pairs['全部'] === 'false', JSON.stringify(pairs));
});

// ── ④ 标题旁「N 条」跟着视图变 ───────────────────────────
//
// 这条抓的是"用 stats.entries 而不是查询 total"的实现：
// 未读视图下既没有搜索词也没有分组，旧条件会退回全库条数，
// 于是列表 5 条、标题写 8 条。
check('未读视图的「N 条」是 5，不是全库的 8（旧实现这里会显示 8）', () => {
  return ok(/^5 条/.test(unreadView.count), JSON.stringify(unreadView.count));
});

// ── ⑤ 侧栏「未读」与分段控件同一份状态 ───────────────────
check('在分段控件点「未读」后，侧栏「未读」也高亮（同一份状态）', () => {
  return ok(unreadView.navUnreadActive === true,
    `navUnreadActive=${unreadView.navUnreadActive}，侧栏与分段控件可能各存了一份 view`);
});
const clickedNavInbox = await clickNav('收件箱');
check('侧栏点「收件箱」能点中', () => ok(clickedNavInbox === true));
const viaNav = await snapshot();
check('侧栏点「收件箱」后，分段控件回到「全部」（反向联动）', () => {
  return ok(viaNav.segOn.length === 1 && viaNav.segOn[0] === '全部' && viaNav.rows.length === 8,
    `segOn=${JSON.stringify(viaNav.segOn)} ${viaNav.rows.length} 条`);
});

// ── ③ 点「全部」→ 已读条目回来，且仍是已读态 ─────────────
await clickSeg('未读');
const back1 = await snapshot();
check('（前置）再次进入未读视图，确认它不是空转', () => {
  return ok(back1.rows.length === 5, `${back1.rows.length} 条`);
});
await clickSeg('全部');
const backAll = await snapshot();
check('点「全部」后已读条目回到列表（8 条）', () => {
  return ok(backAll.rows.length === 8, `${backAll.rows.length} 条`);
});
check('回来的已读条目仍是「已读」外观（3 条 read，不是被当成未读显示）', () => {
  const read = backAll.rows.filter((r) => r.read).length;
  return ok(read === 3, `已读 ${read} 条，期望 3`);
});
check('「已读仍显示」是通过样式区分而不是隐藏（A0/A1/C0 都在列表里）', () => {
  const got = backAll.rows.map((r) => r.title);
  const want = ['A0 已读且收藏', 'A1 已读', 'C0 已读'];
  const missing = want.filter((w) => !got.includes(w));
  return ok(missing.length === 0, `缺 ${JSON.stringify(missing)}`);
});

// ── ⑩ 收藏状态只表达一次 ────────────────────────────────
check('整页没有 .star-mark 装饰星（旧实现"点完收藏出现两颗星"的根源）', () => {
  return ok(backAll.starMarks === 0, `找到 ${backAll.starMarks} 个 .star-mark`);
});
check('已收藏行里只有一处收藏状态表达（不是按钮 + 装饰星两颗）', () => {
  const row = backAll.rows.find((r) => r.title === 'A0 已读且收藏');
  if (!row) return ok(false, '找不到已收藏的那条，断言空转');
  return ok(row.starExpr === 1,
    `这一行有 ${row.starExpr} 个元素在表达收藏（star-mark + 行内按钮 = 2 就是旧 bug）`);
});
check('已收藏行的收藏按钮 aria-pressed=true（状态可机读）', () => {
  const row = backAll.rows.find((r) => r.title === 'A0 已读且收藏');
  return ok(row?.starPressed === 'true', String(row?.starPressed));
});

// ── ⑥ 刷新按钮存在且能点 ─────────────────────────────────
check('标题行里有刷新按钮', () => ok(backAll.hasRefresh === true));
check('空闲时刷新按钮可用（不是常驻 disabled）', () => {
  return ok(backAll.refreshDisabled === false, String(backAll.refreshDisabled));
});

// ── ⑧ 刷新真的重新取数 ──────────────────────────────────
//
// 在外部（直接用接口）把 A2 标成已读，然后点刷新：
// 「全部」视图下它应该从"未读外观"变成"已读外观"。
// 只断言"按钮点了有反应"是不够的 —— 界面完全可以从本地 state 拼出来。
const markRes = await j('POST', '/entries/read', { ids: ['ie_a2'] });
check('（外部动作）把 A2 标为已读', () => ok(markRes.data?.ok === true, JSON.stringify(markRes.data)));

await ev(`(() => { window.__probe.calls.length = 0; return true; })()`);
const clickRefresh = async () => {
  const r = await ev(`(() => {
    const b = document.querySelector('.refresh-btn');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  return r;
};
const refreshClicked = await clickRefresh();
check('刷新按钮能点中', () => ok(refreshClicked === true));
await sleep(1600);
const afterRefresh = await snapshot();

const callCount = await ev('window.__probe.calls.length');
check('刷新确实重新请求了条目列表（请求数 ≥ 1，不是纯本地重渲染）', () => {
  return ok(callCount >= 1, `录制到 ${callCount} 次 /entries 请求`);
});
check('刷新后 A2 的已读状态跟上了（外部改的数据被拉回来）', () => {
  const row = afterRefresh.rows.find((r) => r.title === 'A2 未读');
  if (!row) return ok(false, 'A2 不见了，断言空转');
  return ok(row.read === true, `A2 read=${row.read}，说明刷新没有重新取数`);
});
check('刷新后「全部」仍是激活态（刷新不重置视图）', () => {
  return ok(afterRefresh.segOn.length === 1 && afterRefresh.segOn[0] === '全部',
    JSON.stringify(afterRefresh.segOn));
});

// ── ⑦ 刷新不清空列表（请求在途时采样）────────────────────
//
// 给 fetch 加 700ms 延迟，点完刷新后 250ms 采样行数。
// 实现里若先 setItems([]) 再填回去，这一刻会读到 0。
await ev('(() => { window.__probe.delay = 700; window.__probe.calls.length = 0; return true; })()');
const beforeInflight = await snapshot();
await clickRefresh();
await sleep(250);
const inflight = await snapshot();
await sleep(1500);
await ev('(() => { window.__probe.delay = 0; return true; })()');

check('（前置）点刷新前列表有 8 条', () => {
  return ok(beforeInflight.rows.length === 8, `${beforeInflight.rows.length} 条`);
});
check('请求在途时列表不清空（不闪白）', () => {
  return ok(inflight.rows.length === beforeInflight.rows.length,
    `在途时 ${inflight.rows.length} 条，点之前 ${beforeInflight.rows.length} 条 —— 中途归零就是闪白`);
});
check('刷新中按钮进入 disabled（防重复点击）', () => {
  return ok(inflight.refreshDisabled === true, String(inflight.refreshDisabled));
});
check('刷新中图标旋转态生效（.spinning）', () => {
  return ok(inflight.refreshSpinning === true, String(inflight.refreshSpinning));
});

// ── ⑨ 刷新保留筛选 ──────────────────────────────────────
//
// 三重筛选同时挂上：分组 + 组内某个源 + 关键词。刷新后请求 URL
// 必须仍带这三个参数。只读标题是不够的 —— 标题可以是本地拼的。
const entered = await clickNav('科技IT');
check('（前置）进入「科技IT」分组', () => ok(entered === true));
await ev(`(() => {
  // v1.13：组内的源从"列表头部 chip 行"搬到侧栏分组树（§15.13），
  // 这里跟着改成点树里的子行。它验的是"刷新保留三重筛选"，
  // 与源选择控件长什么样无关 —— 但**必须真的选中一个源**，
  // 否则请求里只有两重参数，这条就退化成两重筛选的测试。
  const c = [...document.querySelectorAll('.tree-leaf')]
    .find((x) => (x.textContent || '').includes('源甲'));
  if (!c) return false;
  c.click();
  return true;
})()`);
await sleep(1200);
await ev(`(() => {
  const i = document.querySelector('.search-box input');
  if (!i) return false;
  const d = Object.getOwnPropertyDescriptor(i.constructor.prototype, 'value');
  d.set.call(i, '未读');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(1500);
const filtered = await snapshot();
check('（前置）分组 + 源 + 搜索三重筛选已生效（列表变窄且有清除按钮）', () => {
  const hasClear = Boolean(filtered.title && /源甲/.test(filtered.title));
  return ok(hasClear && filtered.rows.length > 0 && filtered.rows.length < 8,
    `title=${JSON.stringify(filtered.title)} rows=${filtered.rows.length}`);
});

await clickSeg('未读');
const beforeKept = await ev('window.__probe.calls.length');
await clickRefresh();
await sleep(1800);
const keptCalls = await ev(`window.__probe.calls.slice(${beforeKept})`);
const kept = await snapshot();

check('刷新保留了分组与源筛选（请求 URL 仍带 folderId 与 feedId）', () => {
  if (!Array.isArray(keptCalls) || keptCalls.length === 0) {
    return ok(false, `刷新后没录到 /entries 请求（只录到 ${keptCalls?.length} 条）`);
  }
  const last = keptCalls[keptCalls.length - 1];
  return ok(/folderId=fd_ibv/.test(last) && /feedId=if_a/.test(last),
    `请求=${last}`);
});
check('刷新保留了搜索词（请求 URL 仍带 q=）', () => {
  const last = (keptCalls ?? [])[keptCalls.length - 1] ?? '';
  return ok(/[?&]q=/.test(last), `请求=${last}`);
});
check('刷新保留了「未读」视图（请求 URL 仍带 view=unread，界面也未读仍亮）', () => {
  const last = (keptCalls ?? [])[keptCalls.length - 1] ?? '';
  return ok(/view=unread/.test(last) && kept.segOn[0] === '未读',
    `请求=${last} segOn=${JSON.stringify(kept.segOn)}`);
});
check('刷新后列表仍有内容（三重筛选 + 未读不是空交集）', () => {
  return ok(kept.rows.length > 0 && kept.rows.every((r) => !r.read),
    `${kept.rows.length} 条，含已读=${kept.rows.some((r) => r.read)}`);
});

// 收拾现场：清搜索、回收件箱，免得影响后面的移动端断言
await ev(`(() => {
  const i = document.querySelector('.search-box input');
  if (!i) return false;
  const d = Object.getOwnPropertyDescriptor(i.constructor.prototype, 'value');
  d.set.call(i, '');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(1200);
await clickNav('收件箱');

// ── ⑪ 375px 视口下标题行不溢出 ──────────────────────────
//
// 加了两个控件之后标题行变成「h1 + N 条 + × + 分段 + 刷新」，
// 在 375px 里 h1 必须让位（它有 min-width:0 + ellipsis）。
// 判据用 scrollWidth > clientWidth 而不是"看起来还行"。
await send('Emulation.setDeviceMetricsOverride', {
  width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
});
await sleep(1200);
const mobile = await snapshot();
check('375px 视口下标题行无横向溢出', () => {
  return ok(mobile.titleOverflow === 0,
    `溢出 ${mobile.titleOverflow}px（分段控件 + 刷新把标题挤出去了）`);
});
check('375px 下分段控件与刷新按钮都还在（不是被隐藏掉来"解决"溢出）', () => {
  return ok(mobile.segCount === 2 && mobile.hasRefresh === true,
    `seg=${mobile.segCount} refresh=${mobile.hasRefresh}`);
});
const docOverflow = await ev('Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)');
check('375px 视口下页面本身无横向滚动条', () => {
  return ok(docOverflow === 0, `溢出 ${docOverflow}px`);
});

ws.close();
killBrowser();
summary('m1-12-inbox-view');
cleanup();
process.exit(process.exitCode ?? 0);
