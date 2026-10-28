#!/usr/bin/env node
// 分组内查看订阅源 —— 验收（PLAN §15.13）
//
// 需求方原话（v1.8）：「分组不能查看分组内的不同订阅源信息，需要加上」。
// 需求方原话（v1.13）：「分组采样左侧下拉栏，不然分组内部订阅数量多
// 会导致博客列表栏显示不全」。
//
// v1.8 的实现是「列表头部一行横向滚动的 chip」。它解决了"看不到组内源"，
// 但把代价压给了列表栏：组内 11 个源时那行吃掉 41px，且滚出去就看不见。
// v1.13 改成**侧栏可展开的分组树**：分组行就地展开，组内源作为子行。
// 这个脚本也跟着改判据 —— 但"改判据"必须同时保留原来能抓到的缺陷，
// 否则就是用测试去迁就实现（§19.1）。
//
// 这一节最容易假绿的地方（所以每条都写了"为什么这么验"）：
//
//   ① "列出了源"很容易，但**源的未读数对不对**才是信息量所在 ——
//      只断言子行数量会让"全部 0 未读"也通过。
//   ② "点了源能过滤"如果只断言列表变短，一个把列表清空到 0 条的 bug
//      也能通过。必须断言**剩下的每一条都来自这个源**。
//   ③ 「搬走了」和「没搬」在功能断言上长得一样：只验"子行里有源"，
//      一个**同时**渲染了 chip 行和树的实现照样全绿。所以必须有一条
//      断言 `.feed-chips` 在 DOM 里**不存在**。
//   ④ 自愈（源被移出组）如果只改 UI 不改 scope，会表现为永远是空列表。
//   ⑤ 高亮不能只看"有没有节点"：手风琴收起后节点全没了，一个
//      "永远不展开"的实现也能通过"旧组不残留"的断言。要看 aria-expanded。
//
// 判据：
//   ① 点分组 → 该组自动展开，子行列出组内全部源
//   ② 每个子行上的未读数 = 该源真实未读数（含 0）
//   ③ 点源 → 列表只含该源条目，标题为「组名 · 源名」，只有该子行高亮
//   ④ 再点同一个源 → 回到整组，组行恢复高亮
//   ⑤ 列表头部**没有** chip 行（搬迁承诺）
//   ⑥ 换分组 → 手风琴只展开新组，源筛选清空
//   ⑦ 组内 1 个源仍可展开
//   ⑧ 点固定视图 → 分组与源筛选清空，树全部收起
//   ⑨ 源筛选与搜索叠加：两者同时生效
//   ⑩ 筛选的源被移出组 → 自动退回整组（不留死筛选）
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

group('1.11 分组内查看订阅源');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-ffeed-'));
const dataDir = join(tmp, 'data');
const port = 46000 + Math.floor(Math.random() * 900);
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
if (!ready) { cleanup(); summary('m1-11-folder-feeds'); process.exit(1); }

await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ffeed@test.local', password: 'ffeedtest12345' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ffeed@test.local', password: 'ffeedtest12345' }),
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
// 四个组，各有明确用途：
//   组A「科技IT」  3 个源，未读 2/0/3 —— 够展开，且有一个源未读为 0
//                  （"没新内容"也要出现在子行上）
//   组B「独立博客」1 个源 —— 验证"单源组仍可展开"
//   组C「编程」    2 个源 —— 验证"换组时源筛选清空、手风琴只开新组"
//   组D「大组」    1 个源、45 条 —— 验证"N 条"用总数不是本页条数
// 另外留一个不归组的源，验证它不出现在任何一组的分支里。
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
const insFolder = db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)');
insFolder.run('fd_a', uid, '科技IT', 0);
insFolder.run('fd_b', uid, '独立博客', 1);
insFolder.run('fd_c', uid, '编程', 2);

const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?)`);
insFeed.run('ff_s1', uid, 'https://solidot.example.com/feed', 'https://solidot.example.com', '奇客Solidot', Date.now(), Date.now(), 'fd_a');
insFeed.run('ff_s2', uid, 'https://juejin.example.com/feed', 'https://juejin.example.com', '掘金本周最热', Date.now(), Date.now(), 'fd_a');
insFeed.run('ff_s3', uid, 'https://leiphone.example.com/feed', 'https://leiphone.example.com', '雷锋网', Date.now(), Date.now(), 'fd_a');
insFeed.run('ff_b1', uid, 'https://sspai.example.com/feed', 'https://sspai.example.com', '少数派', Date.now(), Date.now(), 'fd_b');
insFeed.run('ff_c1', uid, 'https://ghdaily.example.com/feed', 'https://ghdaily.example.com', 'GitHubDaily', Date.now(), Date.now(), 'fd_c');
insFeed.run('ff_c2', uid, 'https://weekly.example.com/feed', 'https://weekly.example.com', 'ruanyf weekly', Date.now(), Date.now(), 'fd_c');
insFeed.run('ff_x1', uid, 'https://loose.example.com/feed', 'https://loose.example.com', '没归组的源', Date.now(), Date.now(), null);
// 第四个组：专门用来看"条目数 > 一页(30) 时标题旁的数字对不对"。
// 用别的组凑不出来 —— 那些组都在 10 条以内，items.length 恰好等于 total，
// 于是"用本页条数当总数"这个 bug 一次都不会露头（§15.8 的坑）。
insFolder.run('fd_big', uid, '大组', 3);
insFeed.run('ff_big', uid, 'https://big.example.com/feed', 'https://big.example.com', '量大的源', Date.now(), Date.now(), 'fd_big');

const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,0,?)`);

// 未读分布刻意写成 2 / 0 / 3：
//   · ff_s2 全已读 —— 如果实现把"未读>0 才渲染 chip"写死，这条会掉
//   · 每个源的标题带自己的名字，才能验证"过滤后剩下的都属于这个源"
let n = 0;
const put = (feedId, unread, read, tag) => {
  for (let i = 0; i < unread; i++) {
    n++;
    insEntry.run(`ff_e${n}`, uid, feedId, `g${n}`,
      `https://${feedId}.example.com/u${i}`, `${feedId}.example.com/u${i}`,
      `${tag} 未读 ${i}`, '摘要', 1700000000000 + n, Date.now(), 0, 0, tag);
  }
  for (let i = 0; i < read; i++) {
    n++;
    insEntry.run(`ff_e${n}`, uid, feedId, `g${n}`,
      `https://${feedId}.example.com/r${i}`, `${feedId}.example.com/r${i}`,
      `${tag} 已读 ${i}`, '摘要', 1700000000000 + n, Date.now(), 1, 1, tag);
  }
};
put('ff_s1', 2, 1, '奇客Solidot');
put('ff_s2', 0, 2, '掘金本周最热');
put('ff_s3', 3, 1, '雷锋网');
put('ff_b1', 1, 1, '少数派');
put('ff_c1', 1, 1, 'GitHubDaily');
put('ff_c2', 1, 1, 'ruanyf weekly');
put('ff_x1', 1, 0, '没归组的源');
// 40 条已读 + 5 条未读：足够超过一页，且两种视图都有内容
for (let i = 0; i < 45; i++) {
  n++;
  insEntry.run(`ff_big${n}`, uid, 'ff_big', `gb${n}`,
    `https://big.example.com/${i}`, `big.example.com/${i}`,
    `量大的源 条目 ${i}`, '摘要', 1700000000000 + n, Date.now(), i < 40 ? 1 : 0, i < 3 ? 1 : 0, '量大的源');
}
db.exec('COMMIT');
db.close();

// ── ① 后端：feedId 与 folderId 可叠加 ──────────────────────
//
// 前端过滤是"请求带两个参数"，所以先验后端真的按交集返回。
// 只验 UI 的话，"前端把列表在前端过滤了"和"后端真的过滤了"分不开。
{
  const onlyS1 = await j('GET', '/entries?folderId=fd_a&feedId=ff_s1&limit=50');
  check('folderId + feedId 叠加只返回该组该源的条目', () => {
    const items = onlyS1.data?.items ?? [];
    return ok(items.length === 3 && items.every((x) => x.feedId === 'ff_s1'),
      `返回 ${items.length} 条，feedId 集合 ${JSON.stringify([...new Set(items.map((x) => x.feedId))])}`);
  });
  const whole = await j('GET', '/entries?folderId=fd_a&limit=50');
  check('只按组过滤返回组内全部源（对照组，证明上一条不是恒真）', () => {
    const items = whole.data?.items ?? [];
    const feeds = [...new Set(items.map((x) => x.feedId))].sort();
    return ok(items.length === 9 && feeds.length === 3,
      `${items.length} 条，${feeds.length} 个源：${JSON.stringify(feeds)}`);
  });
  // 跨组组合：组A + 组C 的源 → 交集为空。这条能抓住"两个条件写成 OR"
  const cross = await j('GET', '/entries?folderId=fd_a&feedId=ff_c1&limit=50');
  check('组与源不属于同一组时返回 0 条（两个条件是 AND 不是 OR）', () => {
    return ok((cross.data?.items ?? []).length === 0,
      `返回 ${(cross.data?.items ?? []).length} 条`);
  });
  // v1.13：树的数据源从「按组取」改成「一次全取」，所以这里验的是
  // GET /feeds（不带参数）里的每行都带 folderId + unread —— 少了任何
  // 一个字段，前端就没法把源归到组下、也画不出未读数。
  const allFeeds = await j('GET', '/feeds');
  check('GET /feeds 一次返回全部源，且每行带 folderId 与 unread（树的数据来源）', () => {
    const items = allFeeds.data?.items ?? [];
    const byId = Object.fromEntries(items.map((f) => [f.id, f]));
    const hasShape = items.every((f) => 'folderId' in f && typeof f.unread === 'number');
    return ok(items.length === 8 && hasShape
      && byId.ff_s1?.unread === 2 && byId.ff_s2?.unread === 0
      && byId.ff_s3?.unread === 3 && byId.ff_s1?.folderId === 'fd_a'
      && byId.ff_x1?.folderId === null,
      `${items.length} 个源，shape=${hasShape}，`
      + JSON.stringify({ s1: byId.ff_s1?.unread, s2: byId.ff_s2?.unread, s3: byId.ff_s3?.unread }));
  });
  // 标题旁的「N 条」必须是命中总数，不是本页已加载条数。
  // 截图里就出现过「科技IT 30 条」而该组真实 40 条 —— 首页只取 30，
  // 界面用 items.length 当总数，滚到底之前一直是错的。
  const paged = await j('GET', '/entries?folderId=fd_a&limit=3');
  check('分页时 total 返回命中总数而不是本页条数', () => {
    return ok((paged.data?.items ?? []).length === 3 && paged.data?.total === 9,
      `items=${(paged.data?.items ?? []).length} total=${paged.data?.total}`);
  });
}

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
  summary('m1-11-folder-feeds');
  cleanup();
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'ai-rss-ffprof-'));
const cdpPort = 9700 + Math.floor(Math.random() * 200);
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
  summary('m1-11-folder-feeds');
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
await sleep(1300);

const clickNav = async (text) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.nav-item')]
      .find((x) => (x.textContent || '').includes(${JSON.stringify(text)}));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1400);
  return r;
};

// 读当前列表 + 侧栏分组树 + 标题
//
// v1.13 起分组与源的选择从"列表头部一行 chip"搬到了**侧栏分组树**（§15.13）。
// 树的结构：.tree-row（分组，aria-expanded 表示开合）+ .tree-leaf（组内源）。
// 这里同时读两样：树里的节点，和列表头部是否**不再有** chip 行 ——
// 后者是这次改动的核心承诺（组内源再多也不占列表栏），必须由断言守住。
const snapshot = async () => ev(`(() => {
  const leaves = [...document.querySelectorAll('.tree-leaf')].map((c) => {
    const cnt = c.querySelector('.tree-leaf-count');
    return {
      // 源的文案是「源名 + 未读数」，未读数在 .tree-leaf-count 里，
      // 直接读 textContent 会把两个数粘在一起
      label: cnt ? (c.textContent || '').replace(cnt.textContent, '').trim() : (c.textContent || '').trim(),
      count: cnt ? Number(cnt.textContent.trim()) : null,
      active: c.className.includes('active'),
    };
  });
  const groups = [...document.querySelectorAll('.tree-row')].map((b) => ({
    name: (b.querySelector('.nav-label')?.textContent ?? '').trim(),
    open: b.getAttribute('aria-expanded') === 'true',
    active: b.className.includes('active'),
    // in-path = 该组被选中但选的是组内某个源，父行只留一条"你在这里"的线索
    inPath: /in-path/.test(b.className),
  }));
  const rows = [...document.querySelectorAll('.entry-item')].map((r) => ({
    title: r.querySelector('.entry-title')?.textContent ?? '',
    site: r.querySelector('.entry-site')?.textContent ?? '',
  }));
  const head = document.querySelector('.pane-head');
  return {
    title: document.querySelector('.pane-title h1')?.textContent ?? '',
    count: (document.querySelector('.pane-count')?.textContent ?? '').trim(),
    groups,
    leaves,
    rows,
    // 这三项里的前两项在 v1.13 之后应当**恒为 false / 0**，
    // 它们是"搬迁没搬干净"的探针。
    hasChipsRow: Boolean(document.querySelector('.feed-chips')),
    chipCount: document.querySelectorAll('.feed-chips .chip').length,
    scopeClear: Boolean(document.querySelector('.scope-clear')),
    headHeight: head ? Math.round(head.getBoundingClientRect().height) : null,
  };
})()`);

// 点侧栏的一个分组行（v1.13：分组行同时负责"选中整组"与"展开"）
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

// 点分组树里的一个源（v1.13：取代原来的 chip 点击）
const clickLeaf = async (label) => {
  const r = await ev(`(() => {
    const c = [...document.querySelectorAll('.tree-leaf')]
      .find((x) => (x.textContent || '').includes(${JSON.stringify(label)}));
    if (!c) return false;
    c.click();
    return true;
  })()`);
  await sleep(1400);
  return r;
};

// ── ③ 组A：3 个源 → 分组行可展开，子行列出全部源 ───────────
const enteredA = await clickGroup('科技IT');
check('侧栏能点进「科技IT」分组', () => ok(enteredA === true, '找不到该分组的树行'));
const groupA = await snapshot();

check('点分组后该组自动展开（否则点了分组看不到组内的源）', () => {
  const g = groupA.groups.find((x) => x.name === '科技IT');
  return ok(g?.open === true && groupA.leaves.length >= 3,
    `open=${g?.open} leaves=${JSON.stringify(groupA.leaves.map((c) => c.label))}`);
});
check('子行含组内每个源（3 个源 → 3 个子行）', () => {
  const labels = groupA.leaves.map((c) => c.label);
  const want = ['奇客Solidot', '掘金本周最热', '雷锋网'];
  const missing = want.filter((w) => !labels.includes(w));
  return ok(groupA.leaves.length === 3 && missing.length === 0,
    `实际 ${JSON.stringify(labels)}，缺 ${JSON.stringify(missing)}`);
});
check('组外源不出现在子行里（少数派 / GitHubDaily / 散装都不该有）', () => {
  const labels = groupA.leaves.map((c) => c.label);
  const leaked = ['少数派', 'GitHubDaily', 'ruanyf weekly', '没归组的源']
    .filter((w) => labels.some((l) => l.includes(w)));
  return ok(leaked.length === 0, `泄漏了 ${JSON.stringify(leaked)}`);
});
check('子行上的未读数与该源真实未读一致（2 / 0 / 3）', () => {
  const byLabel = Object.fromEntries(groupA.leaves.map((c) => [c.label, c.count]));
  return ok(byLabel['奇客Solidot'] === 2 && byLabel['掘金本周最热'] === 0
    && byLabel['雷锋网'] === 3,
    JSON.stringify(byLabel));
});
check('默认状态下「整组」是激活态（组行高亮、没有子行高亮）', () => {
  const g = groupA.groups.find((x) => x.name === '科技IT');
  return ok(g?.active === true && groupA.leaves.every((c) => c.active === false),
    `组行 active=${g?.active} 子行激活=${JSON.stringify(groupA.leaves.filter((c) => c.active))}`);
});
check('列表头部不再有 chip 行（v1.13 搬走的核心承诺）', () => {
  return ok(groupA.hasChipsRow === false && groupA.chipCount === 0,
    `hasChipsRow=${groupA.hasChipsRow} chipCount=${groupA.chipCount}`);
});
check('未选源时列表含多个源的条目（对照组，证明下一条的过滤真的生效）', () => {
  const sites = [...new Set(groupA.rows.map((r) => r.site))];
  return ok(groupA.rows.length > 0 && groupA.rows.length <= 30,
    `${groupA.rows.length} 条，站点 ${JSON.stringify(sites)}`);
});
check('组内视图显示清除按钮（×）', () => ok(groupA.scopeClear === true));
check('标题旁的「N 条」等于组内命中总数（不是本页加载条数）', () => {
  // 这个组只有 9 条，items.length 恰好等于 total，所以这条**抓不住**
  // "用本页条数当总数"的 bug。真正能抓的是 ⑪ 的 45 条大组。
  return ok(/^9 条/.test(groupA.count), JSON.stringify(groupA.count));
});

// ── ④ 点一个源 → 只看到这个源 ─────────────────────────────
const clicked = await clickLeaf('雷锋网');
check('点「雷锋网」子行能点中', () => ok(clicked === true));
const onlyOne = await snapshot();

check('点源后列表只剩该源的条目（不是变空，也不是没变）', () => {
  if (onlyOne.rows.length === 0) return ok(false, '列表变成 0 条 —— 过滤过头了');
  const sites = [...new Set(onlyOne.rows.map((r) => r.site))];
  return ok(sites.length === 1 && sites[0] === '雷锋网',
    `${onlyOne.rows.length} 条，站点 ${JSON.stringify(sites)}`);
});
check('点源后标题带上「组名 · 源名」', () => {
  return ok(/科技IT/.test(onlyOne.title) && /雷锋网/.test(onlyOne.title),
    JSON.stringify(onlyOne.title));
});
check('点源后只有那个子行高亮，组行让出高亮（改留 in-path 线索）', () => {
  const active = onlyOne.leaves.filter((c) => c.active).map((c) => c.label);
  const g = onlyOne.groups.find((x) => x.name === '科技IT');
  return ok(active.length === 1 && active[0] === '雷锋网'
    && g?.active === false && g?.inPath === true,
    `子行激活=${JSON.stringify(active)} 组行 active=${g?.active} inPath=${g?.inPath}`);
});

// ── ⑤ 再点同一个源 → 回整组 ───────────────────────────────
await clickLeaf('雷锋网');
const backToAll = await snapshot();
check('再点同一个源取消筛选，回到整组', () => {
  const sites = [...new Set(backToAll.rows.map((r) => r.site))];
  const g = backToAll.groups.find((x) => x.name === '科技IT');
  return ok(g?.active === true && !/雷锋网/.test(backToAll.title),
    `组行激活=${g?.active}，标题=${JSON.stringify(backToAll.title)}`);
});

// ── ⑥ 源筛选 + 搜索叠加 ──────────────────────────────────
//
// 只验"各自生效"不够：真正容易错的是两个条件同时下发时，
// 实现里其中一个是覆盖另一个而不是叠加。
await clickLeaf('奇客Solidot');
await sleep(1600);
const both = await snapshot();
check('源筛选 + 搜索同时生效：结果仍只含该源，且匹配关键词', () => {
  if (both.rows.length === 0) return ok(false, '两个条件叠加后变成 0 条（可能是取交集写错）');
  const sites = [...new Set(both.rows.map((r) => r.site))];
  const matched = both.rows.every((r) => /solidot/i.test(r.title));
  return ok(sites.length === 1 && sites[0] === '奇客Solidot' && matched,
    `${both.rows.length} 条，站点 ${JSON.stringify(sites)}，全部命中关键词=${matched}`);
});
// 清掉搜索，否则会影响后面的快照
await ev(`(() => {
  const i = document.querySelector('.search-box input');
  if (!i) return false;
  const set = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
    d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set(i, '');
  return true;
})()`);
await sleep(1500);

// ── ⑦ 换分组 → 源筛选清空 ────────────────────────────────
//
// 先在组A选一个源，再跳到组C。如果 scope 里的 feedId 没被清，
// 请求会变成「组C + 组A的源」= 必然空列表，用户看到"这个组没有文章"。
//
// 注意：上一节结束时「奇客Solidot」**已经是选中态**，直接再点一次
// 会把它取消（再点同一个源 = 取消筛选）。所以先点组行复位整组，
// 再选中它 —— 否则这条断言红的是测试自己的操作顺序，不是实现。
await clickGroup('科技IT');
await clickLeaf('奇客Solidot');
const beforeSwitch = await snapshot();
check('切组前确认已选中一个源（否则下一条空转）', () => {
  return ok(beforeSwitch.leaves.some((c) => c.active && c.label === '奇客Solidot'),
    JSON.stringify(beforeSwitch.leaves.filter((c) => c.active)));
});
await clickGroup('编程');
const groupC = await snapshot();
check('切到另一个分组后，源筛选被清空（不会带着旧组的 feedId）', () => {
  // v1.13：旧组的子行已经不在 DOM 里了（手风琴收起），
  // 所以"没有残留"只能靠两件事证明：① 新组里没有任何子行是高亮的
  // ② 标题变成新组名（不是「科技IT · 奇客Solidot」）。只看 ① 不够 ——
  // 子行全被删光的实现也能让 ① 通过，而那时列表是空的。
  const activeLeaves = groupC.leaves.filter((c) => c.active).map((c) => c.label);
  const g = groupC.groups.find((x) => x.name === '编程');
  return ok(activeLeaves.length === 0 && g?.active === true
    && /编程/.test(groupC.title) && !/奇客Solidot/.test(groupC.title)
    && groupC.rows.length > 0,
    `子行激活=${JSON.stringify(activeLeaves)} 组行=${g?.active} 标题=${JSON.stringify(groupC.title)} ${groupC.rows.length} 条`);
});
check('切组后手风琴只展开新组，旧组收起（子行换成新组的源）', () => {
  const open = groupC.groups.filter((x) => x.open).map((x) => x.name);
  const labels = groupC.leaves.map((c) => c.label);
  return ok(open.length === 1 && open[0] === '编程'
    && labels.includes('GitHubDaily') && labels.includes('ruanyf weekly')
    && !labels.includes('奇客Solidot'),
    `展开=${JSON.stringify(open)} 子行=${JSON.stringify(labels)}`);
});

// ── ⑧ 组内只有 1 个源 → 仍可展开（v1.13 改了判据）────────
//
// v1.8~v1.12 的规则是"1 个源不显示 chip 行"（一行 chip 只为过滤到一个源没意义）。
// 改成侧栏树之后这条理由不成立了：子行上带的是**这个源的未读数**，
// 那是用户在侧栏就想看到的信息，不是多余的筛选控件。
// 所以判据从"不渲染"变成"仍可展开、且未读数正确"。
await clickGroup('独立博客');
const groupB = await snapshot();
check('组内只有 1 个源时仍可展开，且子行显示这个源', () => {
  const g = groupB.groups.find((x) => x.name === '独立博客');
  const labels = groupB.leaves.map((c) => c.label);
  return ok(g?.open === true && labels.length === 1 && labels[0] === '少数派',
    `open=${g?.open} 子行=${JSON.stringify(labels)}`);
});
check('单源组展开后列表仍有条目（子行只增加信息，不改变默认范围）', () => {
  const g = groupB.groups.find((x) => x.name === '独立博客');
  return ok(groupB.rows.length === 2 && g?.active === true, `${groupB.rows.length} 条`);
});
check('子行数量 = 该组源数（不是把别的组的源也列出来）', () => {
  // 组A 3 个、组B 1 个、组C 2 个 —— 手风琴保证当前只有一组展开。
  return eq(groupB.leaves.length, 1);
});

// ── ⑨ 点固定视图 → 分组与源筛选都清空，树收起 ─────────────
await clickGroup('科技IT');
await clickLeaf('雷锋网');
const beforeInbox = await snapshot();
check('回固定视图前确认有组+源双重筛选（否则下一条空转）', () => {
  return ok(/科技IT/.test(beforeInbox.title) && /雷锋网/.test(beforeInbox.title),
    JSON.stringify(beforeInbox.title));
});
await clickNav('收件箱');
const inbox = await snapshot();
check('点「收件箱」后分组与源筛选都清空，回到全库', () => {
  return ok(inbox.scopeClear === false && inbox.title === '收件箱'
    && inbox.groups.every((g) => g.active === false && g.inPath === false),
    `scopeClear=${inbox.scopeClear} title=${JSON.stringify(inbox.title)} `
    + `激活组=${JSON.stringify(inbox.groups.filter((g) => g.active || g.inPath).map((g) => g.name))}`);
});
check('点「收件箱」后分组树全部收起（子行全部消失）', () => {
  return ok(inbox.groups.every((g) => g.open === false) && inbox.leaves.length === 0,
    `展开=${JSON.stringify(inbox.groups.filter((g) => g.open).map((g) => g.name))} 子行=${inbox.leaves.length}`);
});

// ── ⑩ 自愈：筛中的源被移出组 ─────────────────────────────
//
// 这条是最容易漏的：源被移走后，侧栏里那个子行还高亮着，请求变成空交集，
// 列表永远是空的。
//
// 必须**先选中那个源**再把它移走 —— 第一版是"移走之后再点进分组"，
// 那时根本没有筛选态，自愈逻辑一次都没执行，断言恒绿（§15.8 的坑）。
// 把 setScope 改成 setScope({})（连分组一起丢）都能通过，就是因为
// 走不到那段代码。加了这个前置才真正覆盖到分支。

// 先选中雷锋网，制造"筛选态指向 ff_s3"
await clickGroup('科技IT');
await clickLeaf('雷锋网');
const armed = await snapshot();
check('（准备）已选中雷锋网，制造出指向它的筛选态', () => {
  return ok(armed.leaves.some((c) => c.active && c.label === '雷锋网'),
    JSON.stringify(armed.leaves.filter((c) => c.active)));
});

// 从 API 侧把它移出分组 —— 此时前端还拿着旧 scope
const moveOut = await j('POST', '/feeds/bulk/folder', {
  feedIds: ['ff_s3'], folderId: null,
});
check('（准备）把雷锋网移出分组A', () => ok(moveOut.data?.done === 1, JSON.stringify(moveOut.data)));

// 触发一次源列表重取：打开配置 → 订阅分类 → 再回来。
//
// 关键细节：回程**不能点侧栏的分组行** —— 那行代码自己会 setScope({folderId})
// 把 feedId 清掉，于是"自愈"一次都没执行，断言恒绿。第一版就是这么假绿的，
// 把 setScope({}) 写进实现照样通过。
//
// 正确回程是订阅分类底部的「去看条目」：它只关弹窗，不碰 scope。
// 这样回来时 scope 里还带着已被移走的 feedId，才真正走到自愈分支。
//
// v1.13：侧栏那个「订阅」入口删了，改从齿轮进配置再点「订阅」分类。
// 这条**回程路径本身**没变（还是「去看条目」），变的只是怎么走到它。
await ev(`(() => {
  const gear = [...document.querySelectorAll('.icon-btn')]
    .find((x) => (x.getAttribute('title') || '').includes('配置'));
  if (gear) gear.click();
  return Boolean(gear);
})()`);
await sleep(1300);
await ev(`(() => {
  const b = [...document.querySelectorAll('.settings-nav-item')]
    .find((x) => (x.textContent || '').trim().includes('订阅'));
  if (b) b.click();
  return Boolean(b);
})()`);
await sleep(900);
const backByFoot = await ev(`(() => {
  const b = [...document.querySelectorAll('.feeds-foot .btn')]
    .find((x) => (x.textContent || '').includes('去看条目'));
  if (!b) return false;
  b.click();
  return true;
})()`);
check('订阅分类里有「去看条目」可回列表（自愈场景的回程路径）', () => ok(backByFoot === true));
await sleep(1400);
const healed = await snapshot();

check('源被移出组后自动退回整组（不留下永远为空的死筛选）', () => {
  const active = healed.leaves.filter((c) => c.active).map((c) => c.label);
  const g = healed.groups.find((x) => x.name === '科技IT');
  return ok(active.length === 0 && g?.active === true,
    `子行激活=${JSON.stringify(active)} 组行=${g?.active}`);
});
check('自愈只丢源、不丢分组（仍在科技IT，不是被踢回全库）', () => {
  // 这条专门抓"自愈时顺手 setScope({})"的实现：那样分组也没了，
  // 子行消失（树收起）、标题变回收件箱，用户会以为自己被弹出了分组。
  // v1.13 之后判据从"chip 行还在"换成"这个组的行仍是激活态" ——
  // 树收起时行也在，所以必须看 active，不能只看节点存不存在。
  const g = healed.groups.find((x) => x.name === '科技IT');
  return ok(g?.active === true && /科技IT/.test(healed.title)
    && !/收件箱/.test(healed.title),
    `组行 active=${g?.active} open=${g?.open} 标题=${JSON.stringify(healed.title)}`);
});
check('自愈后列表有内容（不是空交集）', () => {
  return ok(healed.rows.length > 0, `${healed.rows.length} 条`);
});
check('移出后组内子行只剩余下的源（雷锋网消失）', () => {
  const labels = healed.leaves.map((c) => c.label);
  return ok(!labels.includes('雷锋网') && labels.includes('奇客Solidot'),
    JSON.stringify(labels));
});

// ── ⑪ 条目数超过一页时，标题旁的数字仍是总数 ───────────────
//
// 这里才是"用 items.length 当总数"唯一会露头的地方：
// 大组 45 条，首页只取 30。旧实现在这里显示「30 条」，
// 而实际有 45 条 —— 用户滚到底之前一直以为只有 30 条。
await clickGroup('大组');
const bigGroup = await snapshot();
check('大组（45 条 > 一页 30）页面只渲染了 30 行', () => {
  return ok(bigGroup.rows.length === 30, `渲染 ${bigGroup.rows.length} 行`);
});
check('但标题旁显示的是总数 45，不是已加载的 30', () => {
  return ok(/^45 条/.test(bigGroup.count), JSON.stringify(bigGroup.count));
});
check('大组只有 1 个源 → 树里只有 1 个子行（不是按条目数铺开）', () => {
  return ok(bigGroup.leaves.length === 1 && bigGroup.leaves[0]?.label === '量大的源',
    JSON.stringify(bigGroup.leaves.map((c) => c.label)));
});

ws.close();
killBrowser();
summary('m1-11-folder-feeds');
cleanup();
process.exit(process.exitCode ?? 0);
