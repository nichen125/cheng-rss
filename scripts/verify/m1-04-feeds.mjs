#!/usr/bin/env node
// 1.x 订阅全链路 —— 验收
//
// 判据（PLAN §19.3 1.1/1.2/1.3）：
//   ① POST /feeds 能订阅一个真实可访问的 feed，立刻拿到条目
//   ② 重复订阅幂等（created=false，不重复入库）
//   ③ 条件请求：第二次带 If-None-Match → 304，不重复入库
//   ④ 源 404 → error_count 递增，3 次后 broken
//   ⑤ 删除订阅：未读条目随之删，已读/已收藏条目保留并解绑
//   ⑥ OPML 导出→导入往返，源数一致
//   ⑦ 正文入库前已清洗（<script> 不落库）
//   ⑧ 错误的 URL 返回 400 而不是 500
//
// 用本地 mock HTTP 服务当 feed 源，不打外网 —— 验收必须离线可重复。
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const binName = process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.x 订阅全链路');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock feed 服务 ─────────────────────────────────────────
//
// 行为由路径决定：
//   /feed.xml      正常 RSS，带 ETag；请求带匹配的 If-None-Match 时 304
//   /atom.xml      Atom
//   /site          返回 HTML，内含 <link rel=alternate>，用于测发现
//   /missing       永远 404
//   /evil.xml      正文里带 <script>，验证清洗
//   /empty.xml     合法但 0 条目

let feedVersion = 1;
const FEED_ETAG = () => `"v${feedVersion}"`;

function rss(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Mock 科技源</title>
    <link>http://127.0.0.1:PORT/site</link>
    <description>本地验收用</description>
    <item>
      <title>第一篇 v${version}</title>
      <link>http://127.0.0.1:PORT/a/1</link>
      <guid>mock-1-v${version}</guid>
      <pubDate>Wed, 23 Oct 2026 10:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>第一篇正文，足够长以便被认为有内容。</p><p>第二段。</p>]]></content:encoded>
    </item>
    <item>
      <title>第二篇</title>
      <link>http://127.0.0.1:PORT/a/2</link>
      <guid>mock-2</guid>
      <pubDate>Wed, 22 Oct 2026 10:00:00 GMT</pubDate>
      <description>只有摘要的条目</description>
    </item>
  </channel>
</rss>`;
}

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Mock Atom</title>
  <link rel="alternate" href="http://127.0.0.1:PORT/"/>
  <entry>
    <title>Atom 条目</title>
    <id>atom-1</id>
    <link rel="alternate" href="http://127.0.0.1:PORT/atom/1"/>
    <updated>2026-10-20T08:00:00Z</updated>
    <content type="html">&lt;p&gt;Atom 正文&lt;/p&gt;</content>
  </entry>
</feed>`;

const EVIL = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>危险源</title>
<link>http://127.0.0.1:PORT/</link>
<item><title>带脚本的条目</title><link>http://127.0.0.1:PORT/evil/1</link>
<guid>evil-1</guid><pubDate>Wed, 23 Oct 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>正文</p><script>alert('xss')</script><img src=x onerror="alert(1)">]]></description>
</item></channel></rss>`;

const EMPTY_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>空源</title>
<link>http://127.0.0.1:PORT/</link></channel></rss>`;

let mockPort = 0;
const mock = createServer((req, res) => {
  const url = req.url ?? '/';
  const send = (status, type, body, extra = {}) => {
    res.writeHead(status, { 'content-type': type, ...extra });
    res.end(body);
  };

  if (url === '/feed.xml') {
    const inm = req.headers['if-none-match'];
    if (inm && inm === FEED_ETAG()) {
      res.writeHead(304, { etag: FEED_ETAG() });
      res.end();
      return;
    }
    return send(200, 'application/rss+xml; charset=utf-8',
      rss(feedVersion).replaceAll('PORT', String(mockPort)),
      { etag: FEED_ETAG() });
  }
  if (url === '/atom.xml') {
    return send(200, 'application/atom+xml', ATOM.replaceAll('PORT', String(mockPort)));
  }
  if (url === '/evil.xml') {
    return send(200, 'application/rss+xml', EVIL.replaceAll('PORT', String(mockPort)));
  }
  if (url === '/empty.xml') {
    return send(200, 'application/rss+xml', EMPTY_FEED.replaceAll('PORT', String(mockPort)));
  }
  // ⑨ 瞬时失败的靶子：500 是**可重试**的（站点临时挂了），
  // 与 /missing 的 404 形成对照 —— 这是 v1.17 判据的分界线。
  if (url === '/boom') {
    return send(500, 'text/plain', 'temporary failure');
  }
  if (url === '/site') {
    // 一个没有 feed <link> 的普通网页
    return send(200, 'text/html', '<html><body><h1>只是个网页</h1></body></html>');
  }  if (url === '/site-with-link') {
    return send(200, 'text/html', `<html><head>
      <link rel="alternate" type="application/rss+xml" href="http://127.0.0.1:${mockPort}/feed.xml">
      </head><body>有订阅链接的网页</body></html>`);
  }
  return send(404, 'text/plain', 'not found');
});

await new Promise((r) => mock.listen(0, '127.0.0.1', r));
mockPort = mock.address().port;
const MOCK = `http://127.0.0.1:${mockPort}`;

// 第二个 origin：只有一个普通网页，没有任何 feed。
// 必须换端口 —— discoverFeed 会探测同源的 /feed、/atom.xml 等常见路径，
// 与 MOCK 同源的话它总能撞到上面那些能用的 feed，测不出"找不到"。
const barren = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body><h1>纯网页，没有订阅源</h1></body></html>');
});
await new Promise((r) => barren.listen(0, '127.0.0.1', r));
const BARREN = `http://127.0.0.1:${barren.address().port}`;

// ── 起服务 ─────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m1-'));
const dataDir = join(tmp, 'data');
const port = 37000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;

const srv = spawn(binPath, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
srv.stdout.on('data', () => { /* 吃掉，避免管道满 */ });

const cleanup = () => {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(srv.pid)], { stdio: 'ignore' });
    } else {
      srv.kill('SIGKILL');
    }
  } catch { /* 已退出 */ }
  try { mock.close(); } catch { /* ignore */ }
  try { barren.close(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

let ready = false;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok) { ready = true; break; }
  } catch { /* 还没起来 */ }
  await sleep(250);
}
check('服务就绪', () => ok(ready, srvErr.slice(0, 300)));
if (!ready) { summary('m1-04-feeds'); cleanup(); process.exit(1); }

// ── 登录 ───────────────────────────────────────────────────
await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'feed@test.local', password: 'feedtest12345' }),
});
const loginRes = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'feed@test.local', password: 'feedtest12345' }),
});
const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
check('登录成功', () => ok(cookie.includes('='), cookie));

const api = async (path, init = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
};

// ── ① 订阅 ─────────────────────────────────────────────────
const created = await api('/feeds', {
  method: 'POST',
  body: JSON.stringify({ url: `${MOCK}/feed.xml` }),
});
check('POST /feeds 返回 201', () => eq(created.status, 201, 'status'));
check('订阅立刻带回条目数', () => ok(created.body?.imported === 2, `imported=${created.body?.imported}`));
check('订阅标题取自 feed', () => ok(created.body?.feed?.title === 'Mock 科技源', String(created.body?.feed?.title)));

const feedId = created.body?.feed?.id;
check('拿到 feedId', () => ok(Boolean(feedId), String(feedId)));

const list1 = await api('/feeds');
check('列表里有 1 个源', () => ok(list1.body?.items?.length === 1, String(list1.body?.items?.length)));
check('列表带未读数', () => ok(list1.body?.items?.[0]?.unread === 2, String(list1.body?.items?.[0]?.unread)));

const entries1 = await api('/entries?limit=10');
check('条目列表有 2 条', () => ok(entries1.body?.items?.length === 2, String(entries1.body?.items?.length)));

// ── ② 幂等 ─────────────────────────────────────────────────
const again = await api('/feeds', {
  method: 'POST',
  body: JSON.stringify({ url: `${MOCK}/feed.xml` }),
});
check('重复订阅返回 200 且 created=false', () => {
  return ok(again.status === 200 && again.body?.created === false,
    `status=${again.status} created=${again.body?.created}`);
});
const list2 = await api('/feeds');
check('重复订阅没有产生第二个源', () => ok(list2.body?.items?.length === 1, String(list2.body?.items?.length)));

// ── ③ 条件请求 ─────────────────────────────────────────────
// 手动刷新一次：内容没变，应走 304
const refresh = await api(`/feeds/${feedId}/fetch-now`, { method: 'POST' });
check('内容未变时返回 notModified', () => ok(refresh.body?.notModified === true, JSON.stringify(refresh.body)));
const entries2 = await api('/entries?limit=10');
check('304 后没有重复入库', () => ok(entries2.body?.total === 2, String(entries2.body?.total)));

// 内容变了：版本号 +1，ETag 变，应抓到新条目
feedVersion = 2;
const refresh2 = await api(`/feeds/${feedId}/fetch-now`, { method: 'POST' });
check('内容更新后抓到了变化', () => {
  return ok(refresh2.body?.ok === true, JSON.stringify(refresh2.body));
});
const entries3 = await api('/entries?limit=10');
// mock 的 v2 换了 guid 但 URL 不变：这是同一篇文章被重新发布。
// 按 url_norm 判重后应保持 2 条，不能因为 guid 变了就重复入库。
check('同 URL 换 guid 不产生重复条目', () => ok(entries3.body?.total === 2, String(entries3.body?.total)));

// ── ⑦ 清洗 ─────────────────────────────────────────────────
const evil = await api('/feeds', {
  method: 'POST',
  body: JSON.stringify({ url: `${MOCK}/evil.xml` }),
});
check('危险源也能订阅', () => ok(evil.status === 201, `status=${evil.status}`));

const evilEntries = await api('/entries?limit=50');
const evilItem = evilEntries.body?.items?.find((e) => e.title === '带脚本的条目');
check('危险源条目已入库', () => ok(Boolean(evilItem), '没找到条目'));

if (evilItem) {
  const detail = await api(`/entries/${evilItem.id}`);
  const html = String(detail.body?.contentHtml ?? '');
  check('正文里的 <script> 被清洗掉', () => ok(!/<script/i.test(html) && !html.includes("alert('xss')"), html.slice(0, 200)));
  check('正文里的 onerror 被清洗掉', () => ok(!/onerror/i.test(html), html.slice(0, 200)));
  check('正文文字本身保留', () => ok(html.includes('正文'), html.slice(0, 200)));
}

// ── ⑧ 错误 URL ─────────────────────────────────────────────
const bad = await api('/feeds', {
  method: 'POST',
  body: JSON.stringify({ url: 'not a url at all %%%' }),
});
check('非法 URL 返回 400', () => eq(bad.status, 400, 'status'));
check('非法 URL 的错误码是 BAD_REQUEST', () => ok(bad.body?.error?.code === 'BAD_REQUEST', JSON.stringify(bad.body)));

const html = await api('/feeds', {
  method: 'POST',
  body: JSON.stringify({ url: BARREN }),
});
check('普通网页（无 feed）返回 400 且原因可读', () => {
  return ok(html.status === 400 && /feed/.test(String(html.body?.error?.message)),
    `status=${html.status} msg=${html.body?.error?.message}`);
});

const missing = await api('/feeds', {
  method: 'POST',
  body: JSON.stringify({ url: `${BARREN}/nope.xml` }),
});
check('404 地址返回 400 而不是 500', () => ok(missing.status === 400, String(missing.status)));

// ── 发现 ───────────────────────────────────────────────────
const disc = await api('/feeds/discover', {
  method: 'POST',
  body: JSON.stringify({ url: `${MOCK}/site-with-link` }),
});
check('从 HTML 的 <link> 里发现 feed', () => {
  return ok(disc.body?.found === true && disc.body?.candidates?.length >= 1,
    JSON.stringify(disc.body));
});
check('发现结果带标题与条目数', () => {
  const c = disc.body?.candidates?.[0];
  return ok(c?.title === 'Mock 科技源' && c?.itemCount > 0, JSON.stringify(c));
});

const discNone = await api('/feeds/discover', {
  method: 'POST',
  body: JSON.stringify({ url: BARREN }),
});
check('没有 feed 时 found=false 且给出说明', () => {
  return ok(discNone.body?.found === false && (discNone.body?.notes?.length ?? 0) > 0,
    JSON.stringify(discNone.body));
});

// ── ④ 404 源置 broken ──────────────────────────────────────
// 直接建一个指向 404 的源，然后刷新三次。
// 404 是**永久失效**，第一次就该置 broken；但仍然抓三次，是为了顺带确认
// "已经 broken 的源再抓也不会变成别的状态"（v1.17 起判据只剩 !retryable，
// 三次的写法保留是因为它同时覆盖了"再次失败不该把 broken 改回 active"）。
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const ghostId = 'f_ghosttest0001';
const uidRow = db.prepare('SELECT id FROM users LIMIT 1').get();
db.prepare(`
  INSERT INTO feeds (id, user_id, url, title, fetch_interval, error_count, status, source_kind)
  VALUES (?,?,?,'已失效的源',1800,0,'active','rss')
`).run(ghostId, uidRow.id, `${MOCK}/missing`);
db.close();

const r1 = await api(`/feeds/${ghostId}/fetch-now`, { method: 'POST' });
check('404 源第一次抓取失败', () => ok(r1.body?.ok === false, JSON.stringify(r1.body)));
const r2 = await api(`/feeds/${ghostId}/fetch-now`, { method: 'POST' });
const r3 = await api(`/feeds/${ghostId}/fetch-now`, { method: 'POST' });
check('404/410 是永久失效 → 置 broken', () => ok(r3.body?.status === 'broken', JSON.stringify(r3.body)));

const db2 = new DatabaseSync(join(dataDir, 'app.db'));
const ghost = db2.prepare('SELECT error_count, status FROM feeds WHERE id = ?').get(ghostId);
check('error_count 已累加到 3', () => ok(Number(ghost?.error_count) === 3, String(ghost?.error_count)));
check('broken 源不再被 sweep 选中', () => {
  const due = db2.prepare(
    "SELECT COUNT(*) c FROM feeds WHERE status='active' AND id = ?",
  ).get(ghostId);
  return ok(Number(due?.c) === 0, String(due?.c));
});
db2.close();

// ── ⑨ 瞬时失败永不置 broken（v1.17 新增判据）──────────────
//
// 这是一次真实事故回归：原来 `!retryable || count >= 3` 会在"连续三次
// 网络抖动"之后把源判成永久失效，而 broken 是**终态**（sweep 只认 active），
// 于是源再也不会被自动抓取 —— 用户必须手动点重试才回来。
// 实测 21 个源里有 15 个落到 broken，其中 11 个的失败原因只是
// `网络错误: fetch failed` 和 `请求超时（30s）`。
//
// 断言必须打满 5 次（远超旧的 BROKEN_AFTER=3）：只跑 3 次的话，一个
// "第 4 次才置 broken"的实现照样能通过，那不叫修好了。
{
  const flakyId = 'f_flakytest0001';
  const d = new DatabaseSync(join(dataDir, 'app.db'));
  d.prepare(`
    INSERT INTO feeds (id, user_id, url, title, fetch_interval, error_count, status, source_kind)
    VALUES (?,?,?,'网络抖动的源',1800,0,'active','rss')
  `).run(flakyId, uidRow.id, `${MOCK}/boom`);
  d.close();

  let last = null;
  for (let i = 0; i < 5; i++) {
    last = await api(`/feeds/${flakyId}/fetch-now`, { method: 'POST' });
  }
  check('⑨ 瞬时失败（500）5 次后仍是 active，没有变成 broken', () =>
    ok(last?.body?.ok === false && last?.body?.status === 'active', JSON.stringify(last?.body)));

  const d2 = new DatabaseSync(join(dataDir, 'app.db'));
  const f = d2.prepare('SELECT error_count, status FROM feeds WHERE id = ?').get(flakyId);
  d2.close();
  check('⑨ 瞬时失败仍在累加 error_count（供退避与"最近老失败"提示用）', () =>
    ok(Number(f?.error_count) === 5, String(f?.error_count)));
  check('⑨ 瞬时失败的源仍在 sweep 的候选里（status=active 且已到期）', () => {
    const d3 = new DatabaseSync(join(dataDir, 'app.db'));
    const due = d3.prepare(
      "SELECT COUNT(*) c FROM feeds WHERE status='active' AND next_fetch_at <= ? AND id = ?",
    ).get(Date.now() + 86400_000, flakyId);
    d3.close();
    return ok(Number(due?.c) === 1, `count=${due?.c}`);
  });

  // ── ⑩ 重试失效源：把误判的源拉回时间线（v1.17）─────────
  //
  // 修判据不会回头改数据 —— 已经躺在 broken 里的那批需要一个显式动作。
  // 这里同时验证：只碰 broken（不动 active/paused）、error_count 归零、
  // next_fetch_at 立刻到期。
  const before = await api('/feeds');
  const brokenBefore = (before.body?.items ?? []).filter((x) => x.status === 'broken');
  check('⑩ 前置：库里确实有 broken 源（含刚造的 404 源）', () =>
    ok(brokenBefore.length >= 1, JSON.stringify(brokenBefore.map((x) => x.title))));

  const revived = await api('/feeds/retry-broken', { method: 'POST' });
  check('⑩ 重试失效源返回 revived 数量', () =>
    ok(Number(revived.body?.revived) === brokenBefore.length, JSON.stringify(revived.body)));

  const after = await api('/feeds');
  const items = after.body?.items ?? [];
  check('⑩ 重试之后一个 broken 都不剩', () =>
    ok(items.filter((x) => x.status === 'broken').length === 0,
      JSON.stringify(items.filter((x) => x.status === 'broken').map((x) => x.title))));
  check('⑩ 原来就是 active 的源没被误改（还是 active）', () => {
    const normal = items.find((x) => x.url === `${MOCK}/feed.xml`);
    return ok(normal?.status === 'active', JSON.stringify(normal?.status));
  });
  check('⑩ 复活的源 error_count 已归零', () => {
    const g = items.find((x) => x.id === ghostId);
    return ok(Number(g?.errorCount) === 0, String(g?.errorCount));
  });

  const d4 = new DatabaseSync(join(dataDir, 'app.db'));
  const nf = d4.prepare('SELECT next_fetch_at FROM feeds WHERE id = ?').get(ghostId);
  d4.close();
  check('⑩ 复活的源 next_fetch_at 立刻到期（不用等退避窗口）', () =>
    ok(Number(nf?.next_fetch_at) <= Date.now() + 1000, String(nf?.next_fetch_at)));
}

// ── ⑤ 删除订阅 ─────────────────────────────────────────────
// 先把 mock 源的两条标一条已读、一条收藏，再看删除行为
const mockEntries = await api('/entries?limit=50');
const mockItems = (mockEntries.body?.items ?? []).filter((e) => e.siteName === 'Mock 科技源');
check('mock 源有多条条目', () => ok(mockItems.length >= 2, String(mockItems.length)));

if (mockItems.length >= 2) {
  await api('/entries/read', {
    method: 'POST',
    body: JSON.stringify({ ids: [mockItems[0].id] }),
  });
  await api(`/entries/${mockItems[1].id}/star`, { method: 'POST' });

  const before = mockItems.length;
  const del = await api(`/feeds/${feedId}`, { method: 'DELETE' });
  check('删除订阅成功', () => ok(del.status === 200, String(del.status)));

  const afterList = await api('/entries?limit=50');
  const survivors = (afterList.body?.items ?? []).filter((e) => e.siteName === 'Mock 科技源');
  const readAlive = survivors.find((e) => e.id === mockItems[0].id);
  const starAlive = survivors.find((e) => e.id === mockItems[1].id);
  check('已读条目在取消订阅后保留（历史不能丢）', () => ok(Boolean(readAlive), `存活 ${survivors.length}/${before}`));
  check('已收藏条目在取消订阅后保留', () => ok(Boolean(starAlive), `存活 ${survivors.length}/${before}`));

  const unreadGone = survivors.filter((e) => !e.isRead && !e.isStarred);
  check('未读条目随订阅一起删除', () => ok(unreadGone.length === 0, `还剩 ${unreadGone.length} 条未读`));

  const afterFeeds = await api('/feeds');
  check('订阅列表里已无该源', () => {
    return ok(!(afterFeeds.body?.items ?? []).some((f) => f.id === feedId), '源还在');
  });
}

// ── ⑥ OPML 往返 ────────────────────────────────────────────
{
  // 先删掉两个"纯失败"的源：ghost（404）与 flaky（500）都会被导出，
  // 而导入时必然失败，留着会让「导入数 === 导出数」变成恒假。
  await api(`/feeds/${ghostId}`, { method: 'DELETE' });
  await api('/feeds/f_flakytest0001', { method: 'DELETE' });
}
const atom = await api('/feeds', {
  method: 'POST',
  body: JSON.stringify({ url: `${MOCK}/atom.xml` }),
});
check('订阅 Atom 源', () => ok(atom.status === 201, String(atom.status)));

const exported = await fetch(`${base}/api/v1/feeds/export`, { headers: { cookie } });
const opmlText = await exported.text();
check('导出 OPML 返回 200', () => eq(exported.status, 200, 'status'));
check('导出的 content-type 是 opml', () => {
  return ok((exported.headers.get('content-type') ?? '').includes('opml'),
    exported.headers.get('content-type') ?? '');
});
check('导出的 OPML 含 xmlUrl', () => ok(/xmlUrl=/.test(opmlText), opmlText.slice(0, 200)));

const feedCountBefore = (await api('/feeds')).body?.items?.length ?? 0;

// 清空已订阅，再导入 —— 这样才真的验了"导入"而不是"全都已订阅"
for (const f of (await api('/feeds')).body?.items ?? []) {
  await api(`/feeds/${f.id}`, { method: 'DELETE' });
}
const emptied = await api('/feeds');
check('清空后订阅数为 0', () => ok(emptied.body?.items?.length === 0, String(emptied.body?.items?.length)));

const imported = await api('/feeds/import', {
  method: 'POST',
  headers: { 'content-type': 'text/x-opml' },
  body: opmlText,
});
check('导入 OPML 成功', () => ok(imported.status === 200 && imported.body?.created > 0, JSON.stringify(imported.body)));
check('导入后源数恢复', () => {
  return ok(imported.body?.created === feedCountBefore,
    `导入前 ${feedCountBefore}，导入 ${imported.body?.created}`);
});

const afterImport = await api('/feeds');
check('导入的源都能给出条目', () => {
  return ok((afterImport.body?.items ?? []).every((f) => f.total > 0),
    JSON.stringify((afterImport.body?.items ?? []).map((f) => [f.title, f.total])));
});

// 空 OPML 应 400
const emptyImport = await api('/feeds/import', {
  method: 'POST',
  headers: { 'content-type': 'text/x-opml' },
  body: '<?xml version="1.0"?><opml version="2.0"><body></body></opml>',
});
check('空 OPML 返回 400', () => eq(emptyImport.status, 400, 'status'));

// ── stats 联动 ─────────────────────────────────────────────
const stats = await api('/stats');
check('stats 报告 feeds 数', () => ok((stats.body?.feeds ?? 0) >= 1, JSON.stringify(stats.body)));

summary('m1-04-feeds');
cleanup();
process.exit(process.exitCode ?? 0);
