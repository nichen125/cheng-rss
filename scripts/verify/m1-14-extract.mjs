#!/usr/bin/env node
// 1.14 正文提取（Readability 兜底）—— 验收
//
// 判据（PLAN §19.3 1.14 + §7.5）：
//   ① 5 个真实站点正文 > 参照容器文本 60%（离线夹具，不打外网）
//   ② 提取失败回退 feed 内 HTML，不丢条目
//   ③ 触发条件生效：feed 正文够长就不抓原文（少打 400 次请求的收益）
//   ④ 提取结果不比 feed 更长时不替换（认错节点时保留可读内容）
//   ⑤ 落库字段齐：extracted_by / stage / stage_error / word_count
//   ⑥ 失败原因可读（HTTP 404、非 HTML），且不影响源健康
//   ⑦ 重复入队不重复抓（幂等）
//   ⑧ 并发提取不丢条目（20 条短摘要全部推进到 extracted）
//
// 真实页面已经落成 tests/fixtures/extract/*.html（各 20~80KB，共 252KB）。
// 不做在线抓取的理由与 m1-04 相同：验收必须离线可重复，且真实站点会改版。
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';
import { parseHTML } from 'linkedom';
import {
  MIN_FEED_CHARS, MIN_IMPROVEMENT, needsExtract, extractArticle, extractForEntry, estimateWordCount,
} from '../../src/server/extract/article.ts';
import { openSqlite } from '../lib/sqlite.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);
const fxDir = join(root, 'tests/fixtures/extract');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
/** 提取结果 HTML 的纯文本长度。用 linkedom 而不是正则：正则会被属性里的 '>' 骗 */
const textOf = (html) => {
  const { document } = parseHTML(`<html><body>${html ?? ''}</body></html>`);
  return norm(document.body?.textContent);
};

// ── A. 模块级：真实页面夹具 ─────────────────────────────────
group('1.14 正文提取 · 真实页面');

if (!existsSync(fxDir)) {
  console.error(`夹具目录不存在: ${fxDir}`);
  process.exit(1);
}

/**
 * 参照文本长度。
 *
 * 刻意不复用被测代码：这里只看页面的语义容器（article / main / role=main
 * / 常见正文 class），它是"这篇页面到底有多少正文"的独立估计。
 * 取各容器最大值而不是第一个命中 —— 有的页面侧栏也是 <main>。
 */
function referenceChars(html) {
  const { document } = parseHTML(html);
  const sels = [
    'article', '[itemprop=articleBody]', '[role=main]', 'main',
    '.entry-content', '.post-content', '.article-content', '.entry', '.post-body', '#content',
  ];
  let best = 0;
  for (const s of sels) {
    for (const el of document.querySelectorAll(s)) {
      best = Math.max(best, norm(el.textContent).length);
    }
  }
  if (best === 0) best = norm(document.documentElement?.textContent).length;
  return best;
}

// 五个真实站点。danluu 单独用于"没有 body"的健壮性断言，不参与 60% 比值。
const REAL_SITES = ['jvns.html', 'simonwillison.html', 'tonsky.html', 'martinfowler.html', 'nelhage.html'];

for (const file of REAL_SITES) {
  const html = readFileSync(join(fxDir, file), 'utf8');
  const ref = referenceChars(html);
  const t0 = performance.now();
  const art = extractArticle(html, `https://example.com/${file.replace(/\.html$/, '')}`);
  const ms = performance.now() - t0;
  const got = textOf(art.html).length;

  check(`${file} 提出正文且 ≥ 参照的 60%`, () => {
    const ratio = ref ? got / ref : 0;
    return ok(
      art.failure === null && ratio >= 0.6,
      `failure=${art.failure} note=${art.note} 提出=${got} 参照=${ref} 比值=${ratio.toFixed(2)} 耗时=${ms.toFixed(0)}ms`,
    );
  });
  check(`${file} 提取正文不含 script/style`, () => ok(
    !/<script|<style|onerror=/i.test(art.html ?? ''),
    `前 200 字: ${String(art.html ?? '').slice(0, 200)}`,
  ));
}

check('真实页面提取时延 < 2s（单篇，含 DOM 解析）', () => {
  const html = readFileSync(join(fxDir, 'simonwillison.html'), 'utf8');
  const t0 = performance.now();
  extractArticle(html, 'https://simonwillison.net/x');
  const ms = performance.now() - t0;
  return ok(ms < 2000, `实际 ${ms.toFixed(0)}ms`);
});

// 没有 <body> 的页面：Readability 在 _grabArticle 里直接崩在 null.tagName 上。
// 真实存在（danluu.com 就是把内容直接挂在 <html> 下）。
{
  const html = readFileSync(join(fxDir, 'danluu-crash.html'), 'utf8');
  let threw = null;
  let art = null;
  try {
    art = extractArticle(html, 'https://danluu.com/cocktail-ideas/');
  } catch (e) {
    threw = e.message;
  }
  check('无 <body> 的页面不抛异常', () => ok(threw === null, `抛出: ${threw}`));
  check('无 <body> 的页面把裸元素搬进 body 后能提出正文', () => {
    const chars = norm(art?.text).length;
    return ok(chars > 3000, `failure=${art?.failure} note=${art?.note} 提出=${chars} 字`);
  });
}

// 纯文本（非 HTML）不应崩
{
  const art = extractArticle('这不是网页，只是一段文字。'.repeat(100), 'https://example.com/plain');
  check('非 HTML 输入返回失败而不是抛异常', () => ok(
    art.failure !== null && art.html === null,
    `failure=${art.failure} html=${art.html ? '有' : 'null'}`,
  ));
}

check('相对链接被补成绝对 URL', () => {
  // martinfowler 的提取结果里有 29 个相对链接与 29 张相对图片
  const html = readFileSync(join(fxDir, 'martinfowler.html'), 'utf8');
  const art = extractArticle(html, 'https://martinfowler.com/articles/patterns-of-distributed-systems/');
  const { document } = parseHTML(`<html><body>${art.html ?? ''}</body></html>`);
  const bad = [];
  for (const el of document.querySelectorAll('a[href]')) {
    const h = el.getAttribute('href') ?? '';
    if (!/^(https?:|mailto:|tel:|#)/i.test(h)) bad.push(h);
  }
  for (const el of document.querySelectorAll('img[src]')) {
    const s = el.getAttribute('src') ?? '';
    if (!/^(https?:|data:)/i.test(s)) bad.push(s);
  }
  return ok(
    bad.length === 0 && document.querySelectorAll('a[href]').length > 10,
    `残留相对地址 ${bad.length} 个: ${bad.slice(0, 3).join(' ')}`,
  );
});

// ── B. 模块级：触发条件与回退 ───────────────────────────────
group('1.14 正文提取 · 触发与回退');

check(`feed 正文 < ${MIN_FEED_CHARS} 字才需要抓原文`, () => {
  const short = needsExtract('<p>只有一小段导语。</p>');
  const long = needsExtract(`<p>${'正文内容。'.repeat(400)}</p>`);
  return ok(short === true && long === false, `short=${short} long=${long}`);
});

check('feed 正文为空时也需要抓', () => ok(needsExtract(null) === true && needsExtract('') === true));

{
  const html = readFileSync(join(fxDir, 'jvns.html'), 'utf8');
  const out = await extractForEntry({
    url: 'https://jvns.ca/x', feedHtml: '<p>短摘要</p>',
    fetchPageImpl: async () => ({ body: html, contentType: 'text/html; charset=utf-8', finalUrl: 'https://jvns.ca/x', status: 200 }),
  });
  check('短摘要 + 抓得到原文 → 替换', () => ok(
    out.replaced === true && out.html !== null && out.failure === null,
    `replaced=${out.replaced} failure=${out.failure} note=${out.note}`,
  ));
  check('替换判定理由可读（feed 字数 / 提出字数）', () => ok(
    out.feedChars < MIN_FEED_CHARS && out.articleChars > MIN_FEED_CHARS,
    `feedChars=${out.feedChars} articleChars=${out.articleChars}`,
  ));
}

{
  // feed 正文已经够长 → 一次网络请求都不能发
  let called = 0;
  const out = await extractForEntry({
    url: 'https://example.com/full',
    feedHtml: `<p>${'已经足够长的正文。'.repeat(200)}</p>`,
    fetchPageImpl: async () => { called++; throw new Error('不该被调用'); },
  });
  check('feed 正文够长时完全不打网络', () => ok(called === 0, `被调用 ${called} 次`));
  check('够长时 failure=feed-enough 且不替换', () => ok(
    out.replaced === false && out.failure === 'feed-enough' && out.html === null,
    `replaced=${out.replaced} failure=${out.failure}`,
  ));
}

{
  const out = await extractForEntry({
    url: 'https://example.com/x', feedHtml: '<p>短</p>',
    fetchPageImpl: async () => {
      const e = new Error('原文 HTTP 404');
      e.name = 'FetchError';
      throw e;
    },
  });
  check('抓取失败 → failure=fetch-failed 且不替换', () => ok(
    out.replaced === false && out.failure === 'fetch-failed' && out.html === null,
    `failure=${out.failure} note=${out.note}`,
  ));
}

{
  const out = await extractForEntry({
    url: 'https://example.com/x.pdf', feedHtml: '<p>短</p>',
    fetchPageImpl: async () => ({ body: '%PDF-1.4 ...', contentType: 'application/pdf', finalUrl: 'https://example.com/x.pdf', status: 200 }),
  });
  check('非 HTML 响应 → failure=not-html', () => ok(
    out.replaced === false && out.failure === 'not-html',
    `failure=${out.failure} note=${out.note}`,
  ));
}

{
  // 页面能抓，但 Readability 只提出了不够多的一段（认错节点）。
  //
  // 这组数字要卡在**只有 1.2 倍余量才能挡住**的区间，否则断言是空的：
  //   feed 450 字（<500，仍要提取）→ 阈值 max(500, 450×1.2=540)
  //   原文提出 520 字：> 500 但 < 540
  // 把 MIN_IMPROVEMENT 改成 0 时阈值退化为 500，520 就被判"够好"并替换，
  // 这条断言必须因此变红 —— 实测确认过（变异测试记录在 §19.3）。
  const out = await extractForEntry({
    url: 'https://example.com/x',
    feedHtml: `<p>${'测'.repeat(450)}</p>`,
    fetchPageImpl: async () => ({
      body: `<html><body><article><p>${'文'.repeat(520)}</p></article></body></html>`,
      contentType: 'text/html', finalUrl: 'https://example.com/x', status: 200,
    }),
  });
  check(`提出内容不到阈值（max(500, feed×${MIN_IMPROVEMENT})）时不替换`, () => ok(
    out.replaced === false && out.failure === 'no-improvement' && out.html === null,
    `failure=${out.failure} feedChars=${out.feedChars} articleChars=${out.articleChars}`,
  ));
}

check('estimateWordCount 中文按 2 字符/词', () => {
  // 200 个汉字 → 100 词
  return eq(estimateWordCount('汉'.repeat(200)), 100);
});
check('estimateWordCount 英文按空格切', () => eq(estimateWordCount('one two three four'), 4));

// ── C. 端到端：调度、落库、失败不丢条目 ─────────────────────
group('1.14 正文提取 · 端到端');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

// 每页命中计数，用来证明"够长的 feed 一次都没抓"
const hits = new Map();
const bump = (k) => hits.set(k, (hits.get(k) ?? 0) + 1);

const ARTICLE = `<html><head><title>原文标题</title></head><body>
<main><h1>原文标题</h1>
<p>${'这是从原文页面提取到的正文内容，它比 feed 里的摘要长得多。'.repeat(40)}</p>
<p>ORIGINAL-MARKER-815</p>
</main></body></html>`;

const SHORT_DESC = '<p>只有一段导语，必须去抓原文。</p>';
const LONG_DESC = `<p>${'feed 自带全文，不需要抓原文。'.repeat(120)}</p><p>FEED-MARKER-244</p>`;

let mockPort = 0;
const mock = createServer((req, res) => {
  const u = req.url ?? '/';
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

  if (u === '/feed.xml') {
    bump('/feed.xml');
    const P = `http://127.0.0.1:${mockPort}`;
    const items = [
      ['short-1', '短摘要条目', `${P}/article/short-1`, SHORT_DESC],
      ['full-2', '自带全文条目', `${P}/article/full-2`, LONG_DESC],
      ['broken-3', '原文 404 条目', `${P}/article/broken-3`, SHORT_DESC],
      ['pdf-4', '原文是 PDF 的条目', `${P}/article/pdf-4`, SHORT_DESC],
    ];
    const body = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>提取验收源</title><link>${P}/</link><description>提取用</description>
${items.map(([guid, title, link, desc], i) => `<item>
  <title>${title}</title><link>${link}</link><guid>${guid}</guid>
  <pubDate>Wed, ${20 + i} Oct 2026 10:00:00 GMT</pubDate>
  <description><![CDATA[${desc}]]></description>
  <content:encoded><![CDATA[${desc}]]></content:encoded>
</item>`).join('\n')}
</channel></rss>`;
    return send(200, 'application/rss+xml; charset=utf-8', body);
  }
  if (u.startsWith('/article/')) {
    bump(u);
    if (u === '/article/broken-3') return send(404, 'text/plain', 'gone');
    if (u === '/article/pdf-4') return send(200, 'application/pdf', '%PDF-1.4 fake');
    return send(200, 'text/html; charset=utf-8', ARTICLE);
  }
  return send(404, 'text/plain', 'not found');
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
mockPort = mock.address().port;
const MOCK = `http://127.0.0.1:${mockPort}`;

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m114-'));
const dataDir = join(tmp, 'data');
const port = 39000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;

const srv = spawn(binPath, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
srv.stdout.on('data', () => { /* 吃掉 */ });

const cleanup = () => {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(srv.pid)], { stdio: 'ignore' });
    } else { srv.kill('SIGKILL'); }
  } catch { /* 已退出 */ }
  try { mock.close(); } catch { /* ignore */ }
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
if (!ready) { summary('m1-14-extract'); cleanup(); process.exit(1); }

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'extract@test.local', password: 'extracttest12345' }),
});
const loginRes = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'extract@test.local', password: 'extracttest12345' }),
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
  return { status: r.status, body };
};

// 直接读库：stage / extracted_by / stage_error 不在列表 API 里
const dbPath = join(dataDir, 'app.db');
const db = () => openSqlite(dbPath, { readOnly: true });
const q = (sql, ...args) => {
  const d = db();
  try { return d.prepare(sql).all(...args); } finally { d.close(); }
};
const one = (sql, ...args) => q(sql, ...args)[0];

const created = await api('/feeds', { method: 'POST', body: JSON.stringify({ url: `${MOCK}/feed.xml` }) });
check('订阅 mock 源成功且抓到 4 条', () => ok(
  created.status === 201 && created.body?.imported === 4,
  `status=${created.status} imported=${created.body?.imported}`,
));

const entryByGuid = (guid) => one(
  `SELECT e.id, e.stage, e.stage_error, e.word_count, c.extracted_by
     FROM entries e LEFT JOIN entry_contents c ON c.entry_id = e.id
    WHERE e.guid = ?`, guid,
);

// 等提取任务全部落定（extract 并发 4，4 条应在一轮内跑完）
let settled = false;
for (let i = 0; i < 100; i++) {
  const rows = q("SELECT stage FROM entries WHERE stage = 'pending'");
  if (rows.length === 0) { settled = true; break; }
  await sleep(200);
}
check('4 条条目全部离开 pending（提取任务被消费）', () => ok(settled, '仍有 pending 条目'));
// 给写库收尾一点时间（stage 与正文是两个 UPDATE）
await sleep(200);

// ── ① 短摘要 → 抓原文成功 ──
const shortRow = entryByGuid('short-1');
check('短摘要条目 stage=extracted', () => eq(shortRow?.stage, 'extracted'));
check('短摘要条目 extracted_by=readability', () => eq(shortRow?.extracted_by, 'readability'));
check('短摘要条目 stage_error 为空', () => ok(shortRow?.stage_error === null, String(shortRow?.stage_error)));
check('短摘要条目 word_count 按正文重算（> 100）', () => ok(
  Number(shortRow?.word_count) > 100, `word_count=${shortRow?.word_count}`,
));
check('真去抓了原文（/article/short-1 命中 1 次）', () => eq(hits.get('/article/short-1'), 1));

// ── ② 长正文 → 一次都不抓 ──
const fullRow = entryByGuid('full-2');
check('长正文条目 extracted_by 仍是 feed', () => eq(fullRow?.extracted_by, 'feed'));
check('长正文条目 stage=extracted', () => eq(fullRow?.stage, 'extracted'));
check('长正文条目完全没有抓原文', () => ok(
  hits.get('/article/full-2') === undefined,
  `命中 ${hits.get('/article/full-2')} 次`,
));
// 只断言"没打网络"是不够的：extractForEntry 里还有一道 needsExtract 兜底，
// 所以就算入队规则坏了、长正文的条目也被排进队列，网络请求仍然是 0 次
// （它会在 runExtract 里立刻判 feed-enough 返回）。那样"省下四五百次请求"
// 依然成立，但 jobs 表会被垃圾任务灌满。这条断言查的是队列本身。
check('长正文条目没有排进提取队列（队列里没有它的任务）', () => {
  const jobs = q("SELECT payload FROM jobs WHERE kind = 'extract'");
  const hit = jobs.filter((j) => String(j.payload).includes(String(fullRow?.id)));
  return ok(hit.length === 0, `排进去 ${hit.length} 个: ${hit.map((j) => j.payload).join(' ')}`);
});
check('短摘要条目排进过提取队列', () => {
  const jobs = q("SELECT payload FROM jobs WHERE kind = 'extract'");
  return ok(
    jobs.some((j) => String(j.payload).includes(String(shortRow?.id))),
    `队列里 ${jobs.length} 个 extract 任务: ${jobs.slice(0, 3).map((j) => j.payload).join(' ')}`,
  );
});

// ── ③ 原文 404 → 回退 feed 正文，条目还在 ──
const brokenRow = entryByGuid('broken-3');
check('原文 404 的条目没有被丢掉', () => ok(Boolean(brokenRow?.id), '条目不存在'));
check('原文 404 的条目 stage 仍是 extracted（不卡在处理中）', () => eq(brokenRow?.stage, 'extracted'));
check('原文 404 的条目记录了失败原因', () => ok(
  String(brokenRow?.stage_error ?? '').includes('404'),
  `stage_error=${brokenRow?.stage_error}`,
));
check('原文 404 的条目正文仍是 feed 自带的', () => eq(brokenRow?.extracted_by, 'feed'));

// ── ④ 非 HTML → 同样回退 ──
const pdfRow = entryByGuid('pdf-4');
check('非 HTML 的条目回退到 feed 正文', () => eq(pdfRow?.extracted_by, 'feed'));
check('非 HTML 的原因写进了 stage_error', () => ok(
  /pdf|application/i.test(String(pdfRow?.stage_error ?? '')),
  `stage_error=${pdfRow?.stage_error}`,
));

// ── ⑤ 详情接口读到的是替换后的正文 ──
const shortId = shortRow?.id;
const detail = await api(`/entries/${shortId}`);
check('详情接口返回原文正文（含 ORIGINAL-MARKER-815）', () => ok(
  String(detail.body?.contentHtml ?? '').includes('ORIGINAL-MARKER-815'),
  `contentHtml 前 200 字: ${String(detail.body?.contentHtml ?? '').slice(0, 200)}`,
));
const fullDetail = await api(`/entries/${fullRow?.id}`);
check('长正文条目的详情仍是 feed 正文（含 FEED-MARKER-244）', () => ok(
  String(fullDetail.body?.contentHtml ?? '').includes('FEED-MARKER-244'),
  `前 200 字: ${String(fullDetail.body?.contentHtml ?? '').slice(0, 200)}`,
));

// ── ⑥ 重复入队不重复抓（幂等） ──
{
  const w = openSqlite(dbPath);
  try {
    w.prepare(`INSERT INTO jobs (kind, dedupe_key, payload, status, priority, run_after,
                                 attempts, max_attempts, created_at, updated_at)
               VALUES ('extract', NULL, ?, 'pending', 0, 0, 0, 3, ?, ?)`)
      .run(JSON.stringify({ entryId: shortId }), Date.now(), Date.now());
  } finally { w.close(); }
  let done = false;
  for (let i = 0; i < 60; i++) {
    const pending = q("SELECT id FROM jobs WHERE kind='extract' AND status='pending'");
    if (pending.length === 0) { done = true; break; }
    await sleep(150);
  }
  check('重复入队的提取任务被消费', () => ok(done, '任务一直是 pending'));
  check('重复提取没有再抓一次原文', () => eq(hits.get('/article/short-1'), 1));
  const again = entryByGuid('short-1');
  check('重复提取没有覆盖已有结果', () => ok(
    again?.extracted_by === 'readability' && again?.stage === 'extracted',
    `extracted_by=${again?.extracted_by} stage=${again?.stage}`,
  ));
}

// ── ⑦ 失败不影响源健康 ──
const feeds = await api('/feeds');
check('提取失败不影响订阅状态（active 且 errorCount=0）', () => {
  const f = feeds.body?.items?.[0];
  return ok(f?.status === 'active' && Number(f?.errorCount) === 0,
    `status=${f?.status} errorCount=${f?.errorCount}`);
});

// ── ⑧ 并发：20 条短摘要全部推进 ──
{
  // 20 条**只带短摘要**的条目：它们会全部入队 extract，用来看并发与容错。
  //
  // 注意 feed 里的 <link> 必须指向这个 bulk 服务自己 —— 早先写成
  // mockPort 时，原文抓取打到 mock 上全是 404，于是 20 条全部
  // "成功的失败"（stage=extracted + stage_error），断言看到 0 条 readability。
  let bulkPort = 0;
  const bulk = createServer((req, res) => {
    const u = req.url ?? '/';
    if (u === '/bulk.xml') {
      const P = `http://127.0.0.1:${bulkPort}`;
      const items = Array.from({ length: 20 }, (_, i) => `<item>
  <title>并发条目 ${i}</title><link>${P}/bulk/${i}</link><guid>bulk-${i}</guid>
  <pubDate>Wed, 21 Oct 2026 10:00:00 GMT</pubDate>
  <description><![CDATA[<p>短摘要 ${i}</p>]]></description>
</item>`).join('\n');
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>并发源</title>
<link>${P}/</link><description>x</description>${items}</channel></rss>`);
      return;
    }
    if (u.startsWith('/bulk/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body><article><p>${'并发正文。'.repeat(300)}</p><p>BULK-OK</p></article></body></html>`);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => bulk.listen(0, '127.0.0.1', r));
  bulkPort = bulk.address().port;
  const bulkUrl = `http://127.0.0.1:${bulkPort}/bulk.xml`;
  try {
    const c2 = await api('/feeds', { method: 'POST', body: JSON.stringify({ url: bulkUrl }) });
    check('并发源订阅成功（20 条）', () => ok(c2.body?.imported === 20, `imported=${c2.body?.imported}`));

    let allDone = false;
    for (let i = 0; i < 150; i++) {
      const pending = one(
        `SELECT COUNT(*) AS c FROM entries WHERE guid LIKE 'bulk-%' AND stage = 'pending'`,
      );
      if (Number(pending?.c) === 0) { allDone = true; break; }
      await sleep(200);
    }
    check('20 条短摘要全部推进到 extracted', () => ok(allDone, '仍有 pending'));
    const stats = one(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN stage = 'extracted' THEN 1 ELSE 0 END) AS extracted,
        SUM(CASE WHEN stage = 'pending' THEN 1 ELSE 0 END) AS pending
      FROM entries WHERE guid LIKE 'bulk-%'`);
    check('并发提取没有丢条目（20 条都在）', () => eq(Number(stats?.total), 20));
    check('并发提取成功率 100%', () => {
      const r = one(`SELECT COUNT(*) AS c FROM entry_contents c2
                       JOIN entries e ON e.id = c2.entry_id
                      WHERE e.guid LIKE 'bulk-%' AND c2.extracted_by = 'readability'`);
      const bad = one(
        `SELECT COUNT(*) AS c FROM entries WHERE guid LIKE 'bulk-%' AND stage_error IS NOT NULL`,
      );
      return ok(Number(r?.c) === 20,
        `readability=${Number(r?.c)} 有 stage_error=${Number(bad?.c)}`);
    });
  } finally {
    try { bulk.close(); } catch { /* ignore */ }
  }
}

summary('m1-14-extract');
cleanup();
