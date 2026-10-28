#!/usr/bin/env node
// 未读清零后的落点 —— 验收（PLAN §15.20，需求表第 22 行）
//
// 需求方原话两条：
//   「当没有未读数据的时候自动切换到对应订阅的所以订阅中」
//   「在某一个订阅中，没有新的未读信息，里面有一个跳转全部。应该跳转对应的全部，
//     而不是所有数据的全部」
//
// 这一条最容易假绿的地方全在"范围"上：断言「列表变多了」是没用的 ——
// 从某个源跳到全库，列表同样会变多。所以每一条都同时断言**标题是否还是
// 那个范围**，并且用"该范围条数 ≠ 全库条数"的数据把两种情况彻底分开。
//
// 判据（对应 §19.3 的 1.22 行）：
//   ① 点进未读为 0 的源 → 分段控件直接是「全部」，列表是该源全部条目（不是全库）
//   ② 点进未读为 0 的分组 → 同上且只含该组
//   ③ 点进仍有未读的源 / 分组 → 仍是「未读」
//   ④ 已在「全部」时点任何范围 → 仍是「全部」
//   ⑤ 读完一篇未读 → 侧栏「未读」、分组行、源行三处数字同时减 1（不用刷新）
//   ⑥ 在「未读」下进入一个已读光的范围 → 空态是「未读已经清零」而不是
//      「还没有订阅任何源」，且有「看全部」按钮
//   ⑦ 点「看全部」→ 视图变全部但范围不变（标题仍是组名/源名，条数=该范围总数）
//   ⑧ 真的空范围（源里 0 条）→ 按钮是「看全库条目」，点下去范围被清空
//   ⑨ 库里 0 个源 → 空态是「去添加订阅」，不出现「看全部」
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, eq, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.22 未读清零后的落点');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-empty-'));
const dataDir = join(tmp, 'data');
const port = 50000 + Math.floor(Math.random() * 900);
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
if (!ready) { cleanup(); summary('m1-22-empty-scope'); process.exit(1); }

await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'es@test.local', password: 'estest1234567' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'es@test.local', password: 'estest1234567' }),
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
// 三个分组共 10 条、只有 2 条未读。这个形状是刻意选的：
//   · 甲组：4 条全已读          → "读光了的分组"（要自动跳全部）
//   · 乙组：3 条含 2 未读 + 一个 0 条的空源 → "还有未读的分组"（不许跳）
//   · 丙组：3 条全已读          → 第二份"读光了"，用来区分"源"和"分组"
// 全库 10 条 vs 甲组 4 条 vs 乙组源 2 条 —— 三个数字互不相同，
// 于是"跳到全库"这件事在条数上就能被抓出来。
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
const now = Date.now();
const insFolder = db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)');
insFolder.run('es_g1', uid, '甲组', 0);
insFolder.run('es_g2', uid, '乙组', 1);
insFolder.run('es_g3', uid, '丙组', 2);

const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?)`);
insFeed.run('es_f1', uid, 'https://g1.example.com/feed', 'https://g1.example.com', '甲组源', now, now, 'es_g1');
insFeed.run('es_f2', uid, 'https://g2.example.com/feed', 'https://g2.example.com', '乙组源', now, now, 'es_g2');
insFeed.run('es_f5', uid, 'https://g2b.example.com/feed', 'https://g2b.example.com', '空源', now, now, 'es_g2');
insFeed.run('es_f4', uid, 'https://g3.example.com/feed', 'https://g3.example.com', '丙组源', now, now, 'es_g3');

const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,?)`);

// [feedId, 已读?, 序号]
const plan = [
  ['es_f1', true, 1], ['es_f1', true, 2], ['es_f1', true, 3], ['es_f1', true, 4],
  ['es_f2', true, 5], ['es_f2', false, 6], ['es_f2', false, 7],
  ['es_f4', true, 8], ['es_f4', true, 9], ['es_f4', true, 10],
];
plan.forEach(([feed, read, n], i) => {
  insEntry.run(`es_e${n}`, uid, feed, `g${n}`, `https://e.example.com/${n}`, `e.example.com/${n}`,
    `${read ? '已读' : '未读'}条目 ${n}`, '摘要',
    now - i * 60000, now, read ? 1 : 0, '测试源');
});
db.exec('COMMIT');
const counts = db.prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN is_read = 1 THEN 1 ELSE 0 END) AS read
  FROM entries`).get();
db.close();

const WANT_TOTAL = plan.length;                 // 10
const WANT_UNREAD = plan.filter(([, r]) => !r).length; // 2
check('（数据自检）库里 10 条，未读 2 条、甲组 4 条全已读', () => ok(
  Number(counts.total) === WANT_TOTAL && Number(counts.read) === 8 && WANT_UNREAD === 2,
  `total=${counts.total} read=${counts.read}`,
));

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
  summary('m1-22-empty-scope');
  cleanup();
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'ai-rss-empty-prof-'));
const cdpPort = 9900 + Math.floor(Math.random() * 80);
const proc = spawn(browserPath, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,950', 'about:blank',
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
  summary('m1-22-empty-scope');
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
await send('Network.setCookie', {
  name: 'ai_rss_sid', value: cookie.split('=')[1] ?? '',
  domain: '127.0.0.1', path: '/',
});

/**
 * 快照。
 *
 * 除了列表与分段控件，这里必须带上**三处未读数字**：
 *   · 侧栏固定视图「未读」的 badge
 *   · 分组行的 badge
 *   · 组内源子行右侧的数字
 * 需求方说的"要刷新才掉"就是这三处有的会动有的不动 —— 只断言其中一处
 * 会让另外两处静默坏掉。
 */
const SNAPSHOT = `(() => {
  const segBtns = [...document.querySelectorAll('.pane-seg .seg-btn')];
  const navUnreadBtn = [...document.querySelectorAll('.nav-item')]
    .find((b) => (b.textContent || '').replace(/\\d+/g, '').trim() === '未读');
  const num = (t) => {
    const m = /(\\d+)/.exec(t || '');
    return m ? Number(m[1]) : null;
  };
  const rows = [...document.querySelectorAll('.tree-row')].map((b) => ({
    name: (b.querySelector('.nav-label')?.textContent ?? '').trim(),
    badge: num(b.querySelector('.badge')?.textContent ?? '') ?? 0,
    hasBadge: Boolean(b.querySelector('.badge')),
    active: b.className.includes('active'),
  }));
  const leaves = [...document.querySelectorAll('.tree-leaf')].map((b) => ({
    name: (b.querySelector('.tree-leaf-name')?.textContent ?? '').trim(),
    count: num(b.querySelector('.tree-leaf-count')?.textContent ?? ''),
    active: b.className.includes('active'),
  }));
  const empty = document.querySelector('.empty');
  return {
    title: (document.querySelector('.pane-title h1')?.textContent ?? '').trim(),
    count: (document.querySelector('.pane-count')?.textContent ?? '').trim(),
    segOn: segBtns.filter((b) => b.className.includes('on')).map((b) => (b.textContent || '').trim()),
    navUnread: navUnreadBtn ? num(navUnreadBtn.querySelector('.badge')?.textContent ?? '') ?? 0 : null,
    navUnreadActive: navUnreadBtn ? navUnreadBtn.className.includes('active') : false,
    rows,
    leaves,
    items: [...document.querySelectorAll('.entry-item')].map((r) => ({
      title: (r.querySelector('.entry-title')?.textContent ?? '').trim(),
      read: r.className.includes('read'),
    })),
    empty: empty ? {
      heading: (empty.querySelector('h2')?.textContent ?? '').trim(),
      buttons: [...empty.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
    } : null,
  };
})()`;
const snapshot = async () => ev(SNAPSHOT);

const clickSeg = async (label) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.pane-seg .seg-btn')]
      .find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1300);
  return r;
};

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

const clickLeaf = async (name) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.tree-leaf')]
      .find((x) => (x.querySelector('.tree-leaf-name')?.textContent ?? '').trim() === ${JSON.stringify(name)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1400);
  return r;
};

const clickEmptyButton = async (label) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.empty button')]
      .find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1400);
  return r;
};

await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 950, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: origin });
for (let i = 0; i < 80; i++) {
  if (await ev('document.readyState === "complete"').catch(() => false)) break;
  await sleep(150);
}
await sleep(2200);

// ═══ 基线：冷启动是「未读」，只有 2 条 ═══════════════════
const base0 = await snapshot();
check('（基线）冷启动是「未读」，列表 2 条', () => ok(
  base0.segOn.length === 1 && base0.segOn[0] === '未读' && base0.items.length === WANT_UNREAD,
  `segOn=${JSON.stringify(base0.segOn)} items=${base0.items.length}`,
));
check('（基线）三处未读数字都是 2（侧栏 + 乙组分组行）', () => {
  const yi = base0.rows.find((r) => r.name === '乙组');
  // 子行这时还不存在（乙组没展开），所以源行那一处留到 ⑤ 断言 ——
  // 在这里断言它会是 `undefined === 2`，一条永远红的前置检查
  return ok(base0.navUnread === 2 && yi?.badge === 2,
    `nav=${base0.navUnread} 乙组=${yi?.badge}`);
});

// ═══ ① 点进已读光的源 → 直接「全部」，且只有这个源的 4 条 ═══
//
// 「甲组源」4 条全已读。规则一要把它直接送进「全部」。
// 断言的三个数必须同时成立：视图=全部、条数=4、标题=甲组 · 甲组源。
// 只断言条数会被"跳到全库"骗过去（那也能看到这 4 条）；只断言标题会被
// "标题对但列表空着"骗过去。三个一起才关得住。
await clickGroup('甲组');   // 先展开甲组，子行才存在
const leafRead = await clickLeaf('甲组源');
check('① 能点进组内的源', () => ok(leafRead === true, '找不到 .tree-leaf「甲组源」'));
const readDone = await snapshot();
check('① 点进 0 未读的源 → 分段控件直接是「全部」（不是「未读」）', () => ok(
  readDone.segOn.length === 1 && readDone.segOn[0] === '全部',
  `segOn=${JSON.stringify(readDone.segOn)}`,
));
check('① 列表给出该源全部 4 条（已读的也在）', () => ok(
  readDone.items.length === 4, `${readDone.items.length} 条`,
));
check('① 标题仍是「甲组 · 甲组源」（没跳到全库）', () => ok(
  readDone.title === '甲组 · 甲组源', JSON.stringify(readDone.title),
));
check('① 条数是 4 而不是全库 10（跳到全库在数字上就露了）', () => ok(
  /^4 条/.test(readDone.count), JSON.stringify(readDone.count),
));
check('① 源行本身没有未读角标（该源确实读光了）', () => {
  const leaf = readDone.leaves.find((l) => l.name === '甲组源');
  return ok(leaf?.count === 0, `甲组源 count=${leaf?.count}`);
});

// ═══ ② 点进 0 未读的分组 → 同上，且只含该组 ═══════════════
//
// 关键：先切回「未读」，否则上一步已经在「全部」，点丙组只是"保持全部"，
// 测不到规则一（自动切换）。这一步是断言能立住的前提，所以它自己也要验。
await clickSeg('未读');
const beforeGroup2 = await snapshot();
check('（前置）已切回「未读」，甲组源范围下确实空了', () => ok(
  beforeGroup2.segOn[0] === '未读' && beforeGroup2.items.length === 0,
  `segOn=${JSON.stringify(beforeGroup2.segOn)} items=${beforeGroup2.items.length}`,
));
await clickGroup('丙组');
const groupReadDone = await snapshot();
check('② 点进 0 未读的分组 → 分段控件是「全部」', () => ok(
  groupReadDone.segOn.length === 1 && groupReadDone.segOn[0] === '全部',
  `segOn=${JSON.stringify(groupReadDone.segOn)}`,
));
check('② 标题是「丙组」且条数是该组 3 条（不是全库 10、不是甲组 4）', () => ok(
  groupReadDone.title === '丙组' && /^3 条/.test(groupReadDone.count),
  `title=${groupReadDone.title} count=${groupReadDone.count}`,
));
check('② 列表里全是丙组的条目（逐条核对标题前缀）', () => {
  const bad = groupReadDone.items.filter((x) => !/已读条目 (8|9|10)$/.test(x.title));
  return ok(groupReadDone.items.length === 3 && bad.length === 0,
    `${groupReadDone.items.length} 条，不属于丙组 ${bad.length} 条`);
});

// ═══ ③ 有未读的范围不许被拉成「全部」 ════════════════════
//
// 规则一的反面：丙组是"读光了"，乙组还有 2 条未读，点它必须还是「未读」。
// 少了这条，一个"永远设成全部"的实现也能通过 ①②。
//
// 同样要先切回「未读」—— 上一步自动进了全部，不切的话这条测的是规则三
// （已在全部就保持全部），正好会把规则一的反面漏掉。
await clickSeg('未读');
await clickGroup('乙组');
const groupUnread = await snapshot();
check('③ 点进仍有未读的分组 → 仍是「未读」（不是一律跳到全部）', () => ok(
  groupUnread.segOn.length === 1 && groupUnread.segOn[0] === '未读',
  `segOn=${JSON.stringify(groupUnread.segOn)}`,
));
check('③ 该组列表只有 2 条未读（3 条里那 1 条已读不出现）', () => ok(
  groupUnread.items.length === 2 && groupUnread.items.every((x) => !x.read),
  `${groupUnread.items.length} 条，混进已读 ${groupUnread.items.filter((x) => x.read).length} 条`,
));
await clickLeaf('乙组源');
const feedUnread = await snapshot();
check('③ 点进仍有未读的源 → 仍是「未读」', () => ok(
  feedUnread.segOn.length === 1 && feedUnread.segOn[0] === '未读'
  && feedUnread.title === '乙组 · 乙组源',
  `segOn=${JSON.stringify(feedUnread.segOn)} title=${feedUnread.title}`,
));

// ═══ ④ 已在「全部」时点任何范围 → 仍是「全部」 ═══════════
//
// 用户点「全部」是一次明确表态。再点别处不该把它改回未读 ——
// 否则「全部」这个选择在任何一次导航后都会失效。
await clickSeg('全部');
await clickGroup('丙组');
const keepAll = await snapshot();
check('④ 手动选了「全部」之后点别的分组 → 仍是「全部」', () => ok(
  keepAll.segOn.length === 1 && keepAll.segOn[0] === '全部',
  `segOn=${JSON.stringify(keepAll.segOn)}`,
));

// ═══ ⑤ 读完一篇未读 → 三处数字同时减 1，且不用刷新 ═════════
//
// 这一条是需求方说的「读了一篇文章之后，对应的未读数量应该自动减少，
// 而不是需要我再刷新」。关键是**三处**：只减全局是原来就有的行为，
// 分组行和源行靠 reloadTick 才重取，所以读完一篇它们纹丝不动。
//
// 前置必须严格：进乙组源、**切回「未读」**、并且列表里恰好 2 条。
// 上一轮第一版漏了切「未读」，于是在「全部」里点了最上面那条 ——
// 那条正好是已读的，`open` 走的是"不重复减"分支，三处角标当然不动，
// 而断言看起来像"减一功能坏了"。**被测动作的前提没立住，红的是脚本。**
await clickGroup('乙组');
await clickLeaf('乙组源');
await clickSeg('未读');
const beforeRead = await snapshot();
check('（前置）进乙组源、在「未读」下、恰好 2 条未读', () => ok(
  beforeRead.items.length === 2 && beforeRead.segOn[0] === '未读'
  && beforeRead.items.every((x) => !x.read),
  `items=${beforeRead.items.length} segOn=${JSON.stringify(beforeRead.segOn)}`
  + ` read=${beforeRead.items.filter((x) => x.read).length}`,
));
check('（前置）点开之前三处未读都是 2（含源子行）', () => {
  const yi = beforeRead.rows.find((r) => r.name === '乙组');
  const leaf = beforeRead.leaves.find((l) => l.name === '乙组源');
  return ok(beforeRead.navUnread === 2 && yi?.badge === 2 && leaf?.count === 2,
    `nav=${beforeRead.navUnread} 乙组=${yi?.badge} 乙组源=${leaf?.count}`);
});

const opened = await ev(`(() => {
  const first = document.querySelector('.entry-item');
  if (!first) return null;
  const title = (first.querySelector('.entry-title')?.textContent ?? '').trim();
  const a = first.querySelector('.entry-title');
  // 点标题的 <a>：列表行本身是 div，只有标题是打开动作的入口
  if (a) a.click(); else first.click();
  return title;
})()`);
check('⑤ 能点开一篇未读', () => ok(typeof opened === 'string' && opened.length > 0, String(opened)));
await sleep(2000);
const afterRead = await snapshot();
check('⑤ 侧栏「未读」角标从 2 变成 1（没有点刷新）', () => ok(
  afterRead.navUnread === 1, `nav=${afterRead.navUnread}`,
));
check('⑤ 分组行「乙组」角标同步变成 1', () => {
  const yi = afterRead.rows.find((r) => r.name === '乙组');
  return ok(yi?.badge === 1, `乙组 badge=${yi?.badge}`);
});
check('⑤ 源子行「乙组源」的数字同步变成 1', () => {
  const leaf = afterRead.leaves.find((l) => l.name === '乙组源');
  return ok(leaf?.count === 1, `乙组源 count=${leaf?.count}`);
});
check('⑤ 读过的这条在列表里被标成已读（不是数字变了、列表没变）', () => {
  const hit = afterRead.items.find((x) => x.title === opened);
  return ok(hit?.read === true, JSON.stringify(afterRead.items));
});
check('⑤ 全库已读计数（0 未读的分组不该出现角标）', () => {
  const bing = afterRead.rows.find((r) => r.name === '丙组');
  return ok(bing?.hasBadge === false, `丙组 hasBadge=${bing?.hasBadge}`);
});

// ═══ ⑥ 「未读」下进入一个已读光的范围 → 空态是「未读已经清零」 ═
//
// 这正是一条里的第二个 bug 现场：改之前这里落到「收件箱是空的 /
// 还没有订阅任何源」—— 而用户有 4 个源、只是这个组读完了。
await clickGroup('丙组');   // 丙组 0 未读 → 自动进「全部」
await clickSeg('未读');     // 手动切回未读 → 才看得到空态
const emptyUnread = await snapshot();
check('⑥ 「未读」下进入已读光的范围确实空了', () => ok(
  emptyUnread.items.length === 0, `${emptyUnread.items.length} 条`,
));
check('⑥ 空态标题说的是"这个范围没有未读"，不是"还没有订阅任何源"', () => ok(
  emptyUnread.empty?.heading === '「丙组」里没有未读',
  JSON.stringify(emptyUnread.empty?.heading),
));
check('⑥ 空态里有「看全部」按钮', () => ok(
  (emptyUnread.empty?.buttons ?? []).includes('看全部'),
  JSON.stringify(emptyUnread.empty?.buttons),
));
check('⑥ 空态里没有把它说成"未订阅"的文案', () => ok(
  !(emptyUnread.empty?.heading ?? '').includes('订阅'),
  JSON.stringify(emptyUnread.empty?.heading),
));

// ═══ ⑦ 点「看全部」→ 视图变全部，但范围不变 ══════════════
//
// 一条里的第二个 bug：改之前按钮是 `setScope({})`，范围被一起清掉，
// 用户想看"这个源里都读过什么"却得到全库混合列表。
const clickedShowAll = await clickEmptyButton('看全部');
check('⑦ 能点中「看全部」', () => ok(clickedShowAll === true));
const afterShowAll = await snapshot();
check('⑦ 点「看全部」后视图是「全部」', () => ok(
  afterShowAll.segOn.length === 1 && afterShowAll.segOn[0] === '全部',
  `segOn=${JSON.stringify(afterShowAll.segOn)}`,
));
check('⑦ 范围没被清掉：标题仍是「丙组」', () => ok(
  afterShowAll.title === '丙组', JSON.stringify(afterShowAll.title),
));
check('⑦ 条数是丙组的 3 条，不是全库 10 条（这才是"对应的全部"）', () => ok(
  /^3 条/.test(afterShowAll.count) && afterShowAll.items.length === 3,
  `count=${afterShowAll.count} items=${afterShowAll.items.length}`,
));
check('⑦ 列表里的 3 条都属于丙组', () => {
  const bad = afterShowAll.items.filter((x) => !/已读条目 (8|9|10)$/.test(x.title));
  return ok(bad.length === 0, JSON.stringify(bad.map((x) => x.title)));
});

// ═══ ⑧ 真的空范围 → 按钮是「看全库条目」，点下去范围清空 ═══
//
// 与 ⑥⑦ 的区别：丙组是"有 3 条但都读过了"，空源是"一条都没有"。
// 后者的下一步不是"看我读过的"（没有可看的），而是"离开这里"。
//
// 「空源」在乙组下，子行只在乙组展开时存在 —— 上一步点的是丙组，
// 所以这里必须先切回乙组，否则取到的是 undefined 而不是"点不中"。
await clickGroup('乙组');
await clickLeaf('空源');
const emptyFeed = await snapshot();
check('⑧ 点进 0 条目的源 → 列表确实是空的', () => ok(
  emptyFeed.items.length === 0, `${emptyFeed.items.length} 条`,
));
check('⑧ 空范围的空态文案是「里还没有条目」', () => ok(
  (emptyFeed.empty?.heading ?? '').includes('还没有条目'),
  JSON.stringify(emptyFeed.empty?.heading),
));
check('⑧ 按钮是「看全库条目」而不是「看全部」（两者含义不同）', () => {
  const btns = emptyFeed.empty?.buttons ?? [];
  return ok(btns.includes('看全库条目') && !btns.includes('看全部'), JSON.stringify(btns));
});
const clickedLeave = await clickEmptyButton('看全库条目');
check('⑧ 能点中「看全库条目」', () => ok(clickedLeave === true));
const afterLeave = await snapshot();
check('⑧ 点下去范围被清空：标题回到固定视图名', () => ok(
  afterLeave.title === '收件箱' || afterLeave.title === '未读',
  JSON.stringify(afterLeave.title),
));
check('⑧ 清空后列表不再是被那个源筛过的空列表', () => ok(
  afterLeave.items.length > 0, `${afterLeave.items.length} 条`,
));
check('⑧ 清空后没有任何分组/源处于选中态', () => ok(
  afterLeave.rows.every((r) => !r.active) && afterLeave.leaves.every((l) => !l.active),
  JSON.stringify({
    rows: afterLeave.rows.filter((r) => r.active).map((r) => r.name),
    leaves: afterLeave.leaves.filter((l) => l.active).map((l) => l.name),
  }),
));

// ═══ ⑨ 库里 0 个源 → 「去添加订阅」，不出现「看全部」 ═══════
//
// 这一档必须由 feeds.length 判，不能靠 view 或 items.length 推：
// 一个刚初始化、一条源都没加的用户，和"全部读完了"的用户，items 都是空。
{
  const list = await j('GET', '/feeds');
  for (const f of list.data?.items ?? []) {
    await j('DELETE', `/feeds/${f.id}`);
  }
  const left = await j('GET', '/feeds');
  check('⑨（前置）源已全部删除', () => ok((left.data?.items ?? []).length === 0,
    JSON.stringify(left.data?.items?.length)));

  // 光删源还不够：`deleteFeed` 会**保留**已读/已收藏的条目并解绑 feed
  // （那是「取消订阅不该抹掉阅读历史」的正确语义）。所以库里还剩 8 条
  // 解绑的已读条目 —— 那样根本不是"新装用户的空库"，空态也就不会出现。
  // 这一档要模拟的是**真的一条条目都没有**，只能连条目一起清掉。
  {
    const w = new DatabaseSync(join(dataDir, 'app.db'));
    try {
      w.prepare('DELETE FROM entry_fts_map').run();
      w.prepare('DELETE FROM entries').run();
    } finally { w.close(); }
    const n = await j('GET', '/stats');
    check('⑨（前置）库里 0 条条目', () => eq(Number(n.data?.entries), 0));
  }

  await send('Page.reload', {});
  await sleep(2600);
  const noFeeds = await snapshot();
  check('⑨ 0 个源 + 0 条条目时空态是「收件箱是空的」', () => ok(
    noFeeds.empty?.heading === '收件箱是空的', JSON.stringify(noFeeds.empty?.heading),
  ));
  check('⑨ 0 个源时只给「去添加订阅」，不出现「看全部」', () => {
    const btns = noFeeds.empty?.buttons ?? [];
    return ok(btns.includes('去添加订阅') && !btns.includes('看全部'), JSON.stringify(btns));
  });
}

ws.close();
killBrowser();
summary('m1-22-empty-scope');
cleanup();
process.exit(process.exitCode ?? 0);
