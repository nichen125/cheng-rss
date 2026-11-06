#!/usr/bin/env node
// 未读清零后的落点 —— 验收（PLAN §15.20，需求表第 22 行，v1.18 改版）
//
// 需求方原话（v1.17）两条：
//   「当没有未读数据的时候自动切换到对应订阅的所以订阅中」
//   「在某一个订阅中，没有新的未读信息，里面有一个跳转全部。应该跳转对应的全部，
//     而不是所有数据的全部」
//
// 需求方原话（v1.18，推翻了 v1.17 的落点方案）：
//   「从长知识的无未读，切换到其他分组（有未读）还是在全部里面，这个每次点击
//     需要判断一下。我切换未读之后，如果某一个里面没有未读，只给他临时切换到全部，
//     或者还是显示未读，是指在列表栏中分割线，补充上全部的列表，可以参考 huntly 实现」
//
// 所以 v1.17 的"点进 0 未读范围就自动切到「全部」"被整体推翻，换成：
//   · 分段控件**留在「未读」**（用户点的就是"未读"，不该被偷偷改掉）
//   · 列表在未读部分之后画一条分割线，把该范围的已读条目补上来
//   · 每次点选范围都重新判断 → 永远回到「未读」，不再沿用上一个范围的选择
//
// 这一条最容易假绿的地方全在"范围"和"分割线是否存在"上：
//   · 断言「列表有 4 条」不够 —— 全库也有 4 条以上，所以要同时断言标题、
//     条数、以及**每一条都属于该范围**
//   · 断言「有分割线」不够 —— 有未读的范围也必须没有分割线，所以 ③ 要做反面
//   · 断言「segOn 是未读」不够 —— 旧实现点丙组会留在「全部」，但它**在点
//     有未读的乙组时也是未读**（因为旧实现里"点源/组仍是未读"这条本来就成立）。
//     必须按 全部 → 点组 的顺序走，才测得到"沿用旧状态"这个 bug。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, eq, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { removeDir } from '../lib/tmp.mjs';
import { openSqlite } from '../lib/sqlite.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.22 未读清零后的落点（v1.18：分割线补已读）');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-empty-'));
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
// 四个分组共 10 条、只有 2 条未读。这个形状是刻意选的：
//   · 甲组：4 条全已读          → "读光了的分组/源"（要补分割线）
//   · 乙组：3 条含 2 未读 + 一个 0 条的空源 → "还有未读的分组"（不许补）
//   · 丙组：3 条全已读          → 第二份"读光了"，用来区分"源"和"分组"
// 全库 10 条 vs 甲组 4 条 vs 丙组 3 条 vs 乙组源 2 条 —— 四个数字互不相同，
// 于是"跳到全库"这件事在条数上就能被抓出来。
const db = openSqlite(join(dataDir, 'app.db'));
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

const profile = mkdtempSync(join(tmpdir(), 'cheng-rss-empty-prof-'));
const cdpPort = 9900 + Math.floor(Math.random() * 80);
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
  name: 'cheng_rss_sid', value: cookie.split('=')[1] ?? '',
  domain: '127.0.0.1', path: '/',
});

/**
 * 快照。
 *
 * 除了列表与分段控件，这里必须带上**三处未读数字**（侧栏 / 分组行 / 源子行）
 * 和**分割线**：
 *   · 只断言一处角标，另外两处会静默坏掉（需求方说的"要刷新才掉"就是这种）
 *   · 只断言"有分割线"，有未读的范围混进分割线也发现不了 → 所以要 order
 *   · order 把"分割线在不在、在几条之后"一起记下来，一条断言查两件事
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
  const div = document.querySelector('.list-divider');
  const listEl = document.querySelector('.entry-list');
  return {
    title: (document.querySelector('.pane-title h1')?.textContent ?? '').trim(),
    count: (document.querySelector('.pane-count')?.textContent ?? '').trim(),
    segOn: segBtns.filter((b) => b.className.includes('on')).map((b) => (b.textContent || '').trim()),
    navUnread: navUnreadBtn ? num(navUnreadBtn.querySelector('.badge')?.textContent ?? '') ?? 0 : null,
    navUnreadActive: navUnreadBtn ? navUnreadBtn.className.includes('active') : false,
    rows,
    leaves,
    divider: div ? { text: (div.textContent ?? '').trim(), count: div.dataset.count ?? null } : null,
    order: listEl ? [...listEl.children].map((li) => (
      li.classList.contains('list-divider') ? 'divider' : 'entry'
    )) : [],
    items: [...document.querySelectorAll('.entry-item')].map((r) => ({
      title: (r.querySelector('.entry-title')?.textContent ?? '').trim(),
      read: r.classList.contains('read'),
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
  await sleep(1400);
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
  await sleep(1600);
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
  await sleep(1600);
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
  await sleep(1500);
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
check('（基线）全库视图下不补已读（没有范围就没有"上下文"可言）', () => ok(
  base0.divider === null, JSON.stringify(base0.divider),
));
check('（基线）两处未读数字都是 2（侧栏 + 乙组分组行）', () => {
  // 子行这时还不存在（乙组没展开），所以源行那一处留到 ⑤ 断言 ——
  // 在这里断言它会是 `undefined === 2`，一条永远红的前置检查
  const yi = base0.rows.find((r) => r.name === '乙组');
  return ok(base0.navUnread === 2 && yi?.badge === 2,
    `nav=${base0.navUnread} 乙组=${yi?.badge}`);
});

// ═══ ① 点进已读光的源 → 仍是「未读」，分割线补出该源的 4 条已读 ═
//
// 这是 v1.18 推翻 v1.17 的核心：不再偷偷把分段控件切成「全部」。
// 四个数必须同时成立：视图=未读、条数=4、标题=甲组 · 甲组源、有分割线。
// 只断言条数会被"跳到全库"骗过去；只断言标题会被"标题对但列表空着"骗过去。
await clickGroup('甲组');   // 先展开甲组，子行才存在
const leafRead = await clickLeaf('甲组源');
check('① 能点进组内的源', () => ok(leafRead === true, '找不到 .tree-leaf「甲组源」'));
const readDone = await snapshot();
check('① 点进 0 未读的源 → 分段控件**仍是「未读」**（不再偷偷切成「全部」）', () => ok(
  readDone.segOn.length === 1 && readDone.segOn[0] === '未读',
  `segOn=${JSON.stringify(readDone.segOn)}`,
));
check('① 该源的 4 条已读被补进列表（未读 0 条 + 已读 4 条）', () => ok(
  readDone.items.length === 4 && readDone.items.every((x) => x.read),
  `${readDone.items.length} 条，其中未读 ${readDone.items.filter((x) => !x.read).length} 条`,
));
check('① 有一条分割线把"未读"和"更早的已读"分开', () => ok(
  readDone.divider !== null, JSON.stringify(readDone.divider),
));
check('① 分割线文案写明补了几条（"更早的 4 条已读"）', () => ok(
  (readDone.divider?.text ?? '').includes('4') && (readDone.divider?.text ?? '').includes('已读'),
  JSON.stringify(readDone.divider?.text),
));
check('① 分割线在列表最前面（未读部分为空，所以它在第 0 位之后）', () => ok(
  readDone.order[0] === 'divider' && readDone.order.filter((x) => x === 'divider').length === 1,
  JSON.stringify(readDone.order),
));
check('① 标题仍是「甲组 · 甲组源」（没跳到全库）', () => ok(
  readDone.title === '甲组 · 甲组源', JSON.stringify(readDone.title),
));
check('① 条数是 4 而不是全库 10（跳到全库在数字上就露了）', () => ok(
  /^4 条/.test(readDone.count), JSON.stringify(readDone.count),
));
check('① 补上来的 4 条都属于甲组（不是拿全库前 4 条凑数）', () => {
  const bad = readDone.items.filter((x) => !/^已读条目 [1-4]$/.test(x.title));
  return ok(bad.length === 0, JSON.stringify(bad.map((x) => x.title)));
});
check('① 源行本身没有未读角标（该源确实读光了）', () => {
  const leaf = readDone.leaves.find((l) => l.name === '甲组源');
  return ok(leaf?.count === 0, `甲组源 count=${leaf?.count}`);
});

// ═══ ② 分组也算范围：丙组 3 条全已读 → 同样只补 3 条 ═══════
await clickGroup('丙组');
const groupReadDone = await snapshot();
check('② 点进 0 未读的分组 → 分段控件是「未读」，分割线补出该组 3 条', () => ok(
  groupReadDone.segOn.length === 1 && groupReadDone.segOn[0] === '未读'
  && groupReadDone.divider !== null && groupReadDone.items.length === 3,
  `segOn=${JSON.stringify(groupReadDone.segOn)} divider=${JSON.stringify(groupReadDone.divider)}`
  + ` items=${groupReadDone.items.length}`,
));
check('② 标题是「丙组」且条数是该组 3 条（不是全库 10、不是甲组 4）', () => ok(
  groupReadDone.title === '丙组' && /^3 条/.test(groupReadDone.count),
  `title=${groupReadDone.title} count=${groupReadDone.count}`,
));
check('② 列表里全是丙组的条目（逐条核对标题）', () => {
  const bad = groupReadDone.items.filter((x) => !/^已读条目 (8|9|10)$/.test(x.title));
  return ok(groupReadDone.items.length === 3 && bad.length === 0,
    `${groupReadDone.items.length} 条，不属于丙组 ${bad.length} 条`);
});

// ═══ ③ 有未读的范围不许补已读（分割线的反面）════════════════
//
// 少了这条，一个"永远补全库"的实现也能通过 ①②。
await clickGroup('乙组');
const groupUnread = await snapshot();
check('③ 点进仍有未读的分组 → 仍是「未读」', () => ok(
  groupUnread.segOn.length === 1 && groupUnread.segOn[0] === '未读',
  `segOn=${JSON.stringify(groupUnread.segOn)}`,
));
check('③ 该组列表只有 2 条未读（3 条里那 1 条已读不出现）', () => ok(
  groupUnread.items.length === 2 && groupUnread.items.every((x) => !x.read),
  `${groupUnread.items.length} 条，混进已读 ${groupUnread.items.filter((x) => x.read).length} 条`,
));
check('③ 有未读时**没有**分割线（分割线只属于"读光了"的情况）', () => ok(
  groupUnread.divider === null && !groupUnread.order.includes('divider'),
  `divider=${JSON.stringify(groupUnread.divider)} order=${JSON.stringify(groupUnread.order)}`,
));
await clickLeaf('乙组源');
const feedUnread = await snapshot();
check('③ 点进仍有未读的源 → 仍是「未读」且没有分割线', () => ok(
  feedUnread.segOn.length === 1 && feedUnread.segOn[0] === '未读'
  && feedUnread.title === '乙组 · 乙组源' && feedUnread.divider === null,
  `segOn=${JSON.stringify(feedUnread.segOn)} title=${feedUnread.title}`
  + ` divider=${JSON.stringify(feedUnread.divider)}`,
));

// ═══ ④ 每次点选范围都重新判断 → 一律回到「未读」 ═══════════
//
// 需求方原话：「从长知识的无未读，切换到其他分组（有未读）还是在全部里面，
// 这个每次点击需要判断一下」。
//
// 现场：v1.17 的 viewForScope 里有 `if (base === 'inbox') return 'inbox'`，
// 于是"在任何一个范围里点过一次全部"之后，**所有**后续点选都留在全部。
// 测法必须是「先全部 → 再点另一个范围」，正序点选抓不到这个 bug。
await clickSeg('全部');
const allOn = await snapshot();
check('（前置）已手动切到「全部」', () => ok(
  allOn.segOn.length === 1 && allOn.segOn[0] === '全部', JSON.stringify(allOn.segOn),
));
await clickGroup('丙组');
const afterSwitchGroup = await snapshot();
check('④ 手动选了「全部」后点另一个分组 → 回到「未读」（本次修的 bug）', () => ok(
  afterSwitchGroup.segOn.length === 1 && afterSwitchGroup.segOn[0] === '未读',
  `segOn=${JSON.stringify(afterSwitchGroup.segOn)}`,
));
check('④ 回到「未读」之后，丙组的已读条目靠分割线补出来，不是靠切视图', () => ok(
  afterSwitchGroup.divider !== null && afterSwitchGroup.items.length === 3,
  `divider=${JSON.stringify(afterSwitchGroup.divider)} items=${afterSwitchGroup.items.length}`,
));

await clickSeg('全部');
// 手风琴只展开一个组：上一步点的是丙组，乙组源这时的子行**不存在**，
// 直接 clickLeaf 会点空、后续全部断言跟着红。先展开乙组。
await clickGroup('乙组');
const leafAll = await clickLeaf('乙组源');
check('④ 能点进乙组源（先展开乙组）', () => ok(leafAll === true, '找不到 .tree-leaf「乙组源」'));
const afterSwitchLeaf = await snapshot();
check('④ 手动选了「全部」后点组内的源 → 也回到「未读」', () => ok(
  afterSwitchLeaf.segOn.length === 1 && afterSwitchLeaf.segOn[0] === '未读'
  && afterSwitchLeaf.title === '乙组 · 乙组源',
  `segOn=${JSON.stringify(afterSwitchLeaf.segOn)} title=${afterSwitchLeaf.title}`,
));
check('④ 乙组源还有未读 → 列表 2 条未读、无分割线', () => ok(
  afterSwitchLeaf.items.length === 2
  && afterSwitchLeaf.items.every((x) => !x.read) && afterSwitchLeaf.divider === null,
  `items=${afterSwitchLeaf.items.length} divider=${JSON.stringify(afterSwitchLeaf.divider)}`,
));

// 再点同一个源 = 取消源筛选、回到整组。范围变了，读/全部也要重判。
await clickLeaf('乙组源');
const backToGroup = await snapshot();
check('④ 再点同一个源（取消筛选回整组）→ 视图仍按整组重判为「未读」', () => ok(
  backToGroup.segOn.length === 1 && backToGroup.segOn[0] === '未读' && backToGroup.title === '乙组',
  `segOn=${JSON.stringify(backToGroup.segOn)} title=${backToGroup.title}`,
));

// ═══ ⑤ 读完一篇未读 → 三处数字同时减 1，且不用刷新 ═════════
//
// 需求方说的「读了一篇文章之后，对应的未读数量应该自动减少，而不是需要我再刷新」。
// 关键是**三处**：只减全局是原来就有的行为，分组行和源行靠 reloadTick 才重取。
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
  const a = first.querySelector('.entry-title');
  const title = (a?.textContent ?? '').trim();
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
check('⑤ 0 未读的分组不该出现角标', () => {
  const bing = afterRead.rows.find((r) => r.name === '丙组');
  return ok(bing?.hasBadge === false, `丙组 hasBadge=${bing?.hasBadge}`);
});
check('⑤ 刚读完最后一篇的那一刻**不**自动补已读（列表仍是"未读+刚刚那条"）', () => ok(
  afterRead.divider === null, JSON.stringify(afterRead.divider),
));

// ═══ ⑥ 全库 0 未读 → 保持空态 + 「看全部」，不铺满整个库的已读 ═
//
// 分层判据：有范围时"补出这个范围的已读"是补上下文（几十条，有界）；
// 全库时补出来等于把整个阅读历史铺进列表（几百上千条）。所以全库这一档
// 仍然走空态 + 一个按钮，让用户自己决定要不要看。
{
  const unreadIds = plan.filter(([, r]) => !r).map(([, , n]) => `es_e${n}`);
  for (const id of unreadIds) await j('POST', '/entries/read', { ids: [id] });
  const st = await j('GET', '/stats');
  check('⑥（前置）全库未读已清零', () => eq(Number(st.data?.unread), 0));

  await send('Page.reload', {});
  await sleep(2600);
  const allRead = await snapshot();
  check('⑥ 全库未读为 0 时列表是空的（不把全库已读铺进来）', () => ok(
    allRead.items.length === 0 && allRead.divider === null,
    `items=${allRead.items.length} divider=${JSON.stringify(allRead.divider)}`,
  ));
  check('⑥ 空态标题是「未读已经清零」而不是「还没有订阅任何源」', () => ok(
    allRead.empty?.heading === '未读已经清零', JSON.stringify(allRead.empty?.heading),
  ));
  check('⑥ 空态里有「看全部」按钮', () => ok(
    (allRead.empty?.buttons ?? []).includes('看全部'),
    JSON.stringify(allRead.empty?.buttons),
  ));

  const clickedShowAll = await clickEmptyButton('看全部');
  check('⑥ 能点中「看全部」', () => ok(clickedShowAll === true));
  const afterShowAll = await snapshot();
  check('⑥ 点「看全部」后视图是「全部」且给出全库 10 条', () => ok(
    afterShowAll.segOn.length === 1 && afterShowAll.segOn[0] === '全部'
    && afterShowAll.items.length === 10,
    `segOn=${JSON.stringify(afterShowAll.segOn)} items=${afterShowAll.items.length}`,
  ));

  // 恢复那 2 条未读：⑧ 要验"清空范围后列表不是空的"。如果全库一直是
  // 0 未读，清空范围之后本来就该是空列表 —— 那样 ⑧ 会变成一条永远红的
  // 假前置（被测状态没恢复，红的是脚本不是实现）。
  for (const id of unreadIds) await j('POST', '/entries/unread', { ids: [id] });
  const restored = await j('GET', '/stats');
  check('⑥（复原）那 2 条已标回未读', () => eq(Number(restored.data?.unread), 2));
}

// ═══ ⑦ 搜索词优先于补已读：0 命中就只说 0 命中 ═════════════
//
// 有搜索词时切「全部」也不会变出内容（用户要找的是"含这个词的未读"）。
// 补已读会把搜索意图改掉 —— 所以 fillActive 必须带 !debounced。
{
  await clickGroup('甲组');
  await clickLeaf('甲组源');
  let q = '';
  q = await ev(`(() => {
    const el = document.querySelector('.search-box input');
    if (!el) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '不存在的词zzz');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);
  check('⑦ 能给搜索框输入关键词', () => ok(q === '不存在的词zzz', String(q)));
  await sleep(1800);
  const searched = await snapshot();
  check('⑦ 搜索 0 命中时是「没有匹配的条目」，不补分割线', () => ok(
    searched.empty?.heading === '没有匹配的条目' && searched.divider === null,
    `heading=${JSON.stringify(searched.empty?.heading)} divider=${JSON.stringify(searched.divider)}`,
  ));
}

// ═══ ⑧ 真的空范围 → 按钮是「看全库条目」，点下去范围清空 ═══
//
// 与 ①② 的区别：甲组源是"有 4 条但都读过了"，空源是"一条都没有"。
// 后者没有可补的已读，下一步不是"看我读过的"而是"离开这里"。
{
  await ev(`(() => {
    const el = document.querySelector('.search-box input');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(1600);
  await clickGroup('乙组');
  await clickLeaf('空源');
  const emptyFeed = await snapshot();
  check('⑧ 点进 0 条目的源 → 列表确实是空的', () => ok(
    emptyFeed.items.length === 0, `${emptyFeed.items.length} 条`,
  ));
  check('⑧ 真的空范围没有分割线（没有东西可补）', () => ok(
    emptyFeed.divider === null, JSON.stringify(emptyFeed.divider),
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
    afterLeave.title === '全部' || afterLeave.title === '未读' || afterLeave.title === '收件箱',
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
}

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
  // （那是「取消订阅不该抹掉阅读历史」的正确语义）。所以库里还剩 10 条
  // 解绑的已读条目 —— 那样根本不是"新装用户的空库"。这一档要模拟的是
  // **真的一条条目都没有**，只能连条目一起清掉。
  {
    const w = openSqlite(join(dataDir, 'app.db'));
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
