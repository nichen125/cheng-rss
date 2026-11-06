#!/usr/bin/env node
// 2.2 单篇分析流水线 —— 验收
//
// 判据（PLAN §19.4 2.2 + §7.1 L3 + §8.2）：
//   ① 20 篇真实文章全产出摘要（且每篇的摘要对应的是**它自己**的正文）
//   ② 缺字段 → stage=failed 且 stage_error 可读（说得出缺哪个字段）
//   ③ 重跑不重复计费（指纹相同的第二次一次请求都不发）
//   ④ 正文更新后（feed 摘要 → 抓到全文）会重新分析
//   ⑤ 空正文不调模型，直接 failed 并说明（空输入必得编造输出）
//   ⑥ 模型失败不覆盖已有的好结果
//   ⑦ 分析结果进 FTS（搜摘要里的词能命中标题里没有的条目）
//   ⑧ tier 由 importance 派生并落库；阅读时长按中英混排估算
//
// ① 的验法值得说明：mock 模型会**把收到的标题原样写进摘要**。于是
// 「20 篇都有摘要」是弱断言，而「20 篇的摘要各自对应自己的标题」才排除掉
// 「全部调用了第一篇文章」这种实现错误 —— 那同样能让 20 篇都有摘要。
//
// 全部用本地 mock 上游：与 m1-14 的离线夹具同理，验收必须离线可重复，
// 且"模型这次少给了一个字段"这种输入不可能靠真实服务稳定复现。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, gt, summary } from './harness.mjs';
import { killTree } from '../lib/proc.mjs';
import { openSqlite } from '../lib/sqlite.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ARTICLES = JSON.parse(readFileSync(join(root, 'tests/fixtures/ai/articles.json'), 'utf8'));

// ── mock：OpenAI 兼容 API ────────────────────────────────────
//
// 行为由「喂进来的标题」决定，而不是由调用顺序决定 —— 顺序相关的 mock
// 在并发下（analyze 并发 2）会串号，那时"20 篇都成功"仍然成立，
// 但它们对应的文章全错。
const ai = { calls: 0, okCalls: 0, embedCalls: 0, failFor: [], missingFor: [], log: [] };

const aiSrv = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += String(d); });
  req.on('end', () => {
    if (req.url === '/_ctl') {
      const c = JSON.parse(raw || '{}');
      ai.calls = 0; ai.okCalls = 0; ai.embedCalls = 0; ai.log = [];
      ai.failFor = Array.isArray(c.failFor) ? c.failFor : [];
      ai.missingFor = Array.isArray(c.missingFor) ? c.missingFor : [];
      res.writeHead(200); return res.end('{}');
    }
    if (req.url === '/_state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ calls: ai.calls, okCalls: ai.okCalls, embedCalls: ai.embedCalls, log: ai.log }));
    }
    if (!req.url || (!req.url.endsWith('/chat/completions') && !req.url.endsWith('/embeddings'))) {
      res.writeHead(404); return res.end('no');
    }

    // embedding 端点：返回一个确定性的向量（维度由请求里的 model 决定）
    if (req.url.endsWith('/embeddings')) {
      ai.embedCalls++;
      const dim = 64;
      const vec = Array.from({ length: dim }, (_, i) => Math.sin(i + 1) * 0.1);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: vec }],
        model: 'mock-embed',
        usage: { prompt_tokens: 20, total_tokens: 20 },
      }));
    }

    ai.calls++;
    let body;
    try { body = JSON.parse(raw); } catch { body = {}; }
    const userMsg = String((body.messages ?? []).find((m) => m.role === 'user')?.content ?? '');
    const title = (/^标题：(.*)$/m.exec(userMsg)?.[1] ?? '').trim();
    ai.log.push({ title, chars: userMsg.length });

    if (ai.failFor.some((t) => title.includes(t))) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'mock upstream error' } }));
    }

    const full = {
      // 摘要里带标题 —— 断言"摘要对应自己的文章"就靠这个
      summary: `${title}：文中给出两项具体数字，并与上一季度做了对比，结论是短期承压但订单未流失，交付节奏在四季度前不会改变。`,
      key_points: [`${title} 的首批交付在本季度`, '增速高于市场预期 8 个百分点'],
      category: 'industry',
      topics: ['交付', '产能'],
      entities: { people: [], orgs: ['某公司'], products: [], tech: [] },
      importance: 78,
      novelty: 66,
      sentiment: 'neutral',
    };

    ai.okCalls++;
    if (ai.missingFor.some((t) => title.includes(t))) {
      // 丢掉 sentiment / novelty —— 这是小模型最常见的漏字段方式
      const { sentiment, novelty, ...rest } = full;
      void sentiment; void novelty;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(chatBody(JSON.stringify(rest))));
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(chatBody(JSON.stringify(full))));
  });
});

const chatBody = (content) => ({
  id: 'x', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 900, completion_tokens: 180, total_tokens: 1080 },
});

await new Promise((r) => aiSrv.listen(0, '127.0.0.1', r));
const AI_PORT = aiSrv.address().port;
const aiCtl = (body = {}) => fetch(`http://127.0.0.1:${AI_PORT}/_ctl`, { method: 'POST', body: JSON.stringify(body) });
const aiState = async () => (await fetch(`http://127.0.0.1:${AI_PORT}/_state`)).json();

// ── mock：feed 服务器 ───────────────────────────────────────
let feedPort = 0;
const feedSrv = createServer((req, res) => {
  const m = /^\/feed\/(\d+)\.xml$/.exec(req.url ?? '');
  if (!m) { res.writeHead(404); return res.end(); }
  const a = ARTICLES[Number(m[1])];
  if (!a) { res.writeHead(404); return res.end(); }
  const P = `http://127.0.0.1:${feedPort}`;
  const body = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>源 ${m[1]}</title><link>${P}/</link><description>x</description>
<item>
  <title><![CDATA[${a.title}]]></title>
  <link>${a.url}</link>
  <guid>a-${m[1]}</guid>
  <pubDate>Wed, 21 Oct 2026 10:${String(Number(m[1]) % 60).padStart(2, '0')}:00 GMT</pubDate>
  <description><![CDATA[<p>导语很短。</p>]]></description>
  <content:encoded><![CDATA[<article><p>${a.body.replace(/\n\n/g, '</p><p>')}</p></article>]]></content:encoded>
</item>
</channel></rss>`;
  res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
  res.end(body);
});
await new Promise((r) => feedSrv.listen(0, '127.0.0.1', r));
feedPort = feedSrv.address().port;

// ── 起服务 ─────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m202-'));
const dataDir = join(tmp, 'data');
const port = 40000 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;

const srv = spawn(binPath, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    AI_API_KEY: 'sk-mock',
    AI_BASE_URL: `http://127.0.0.1:${AI_PORT}/v1`,
  },
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
srv.stdout.on('data', () => { /* 吃掉 */ });

const cleanup = () => {
  killTree(srv.pid);
  try { aiSrv.close(); } catch { /* ignore */ }
  try { feedSrv.close(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

group('2.2 单篇分析 · 前置');
let ready = false;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* 起 */ }
  await sleep(250);
}
check('服务就绪', () => ok(ready, srvErr.slice(0, 400)));
if (!ready) { summary('m2-02-analyze'); cleanup(); process.exit(1); }

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'an@test.local', password: 'analyzetest12345' }),
});
const loginRes = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'an@test.local', password: 'analyzetest12345' }),
});
const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
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

// 直接读库（stage / source_hash / 成本不在 API 里）
const dbPath = join(dataDir, 'app.db');
const q = (sql, ...args) => {
  const d = openSqlite(dbPath, { readOnly: true });
  try { return d.prepare(sql).all(...args); } finally { d.close(); }
};
const one = (sql, ...args) => q(sql, ...args)[0];
const write = (fn) => {
  const d = openSqlite(dbPath);
  try { return fn(d); } finally { d.close(); }
};

// ── 全部 20 个源 ────────────────────────────────────────────
let subscribed = 0;
for (let i = 0; i < ARTICLES.length; i++) {
  const r = await api('/feeds', {
    method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${feedPort}/feed/${i}.xml` }),
  });
  if (r.status === 201) subscribed++;
}
check(`20 个源全部订阅成功`, () => eq(subscribed, ARTICLES.length));
check('20 个源各抓到 1 条（共 20 条）', () =>
  eq(Number(one('SELECT COUNT(*) AS c FROM entries')?.c), ARTICLES.length));

// 等 extract 与 analyze 全部落定
const waitSettled = async (ms = 120000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const busy = one(`SELECT COUNT(*) AS c FROM entries WHERE stage IN ('pending','extracted')`);
    const jobs = one(`SELECT COUNT(*) AS c FROM jobs WHERE status IN ('pending','running')`);
    if (Number(busy?.c) === 0 && Number(jobs?.c) === 0) return true;
    await sleep(300);
  }
  return false;
};
const settled = await waitSettled();
check('流水线跑完（没有条目停在 pending/extracted，队列已空）', () => ok(
  settled,
  JSON.stringify({ stages: q('SELECT stage, COUNT(*) c FROM entries GROUP BY stage'), jobs: q("SELECT status, COUNT(*) c FROM jobs GROUP BY status") }),
));

// ── ① 20 篇全产出摘要，且各对应自己 ────────────────────────
group('2.2 单篇分析 · 产出');

const analyzed = q(`
  SELECT e.id, e.title, a.summary, a.tier, a.importance, a.category_id, a.reading_time,
         a.prompt_version, a.model, a.cost_usd, a.key_points, a.topics, a.source_hash
    FROM entries e JOIN entry_analysis a ON a.entry_id = e.id
`);
check('20 篇全部有分析行', () => eq(analyzed.length, ARTICLES.length));
check('每篇摘要非空且 > 25 字', () => {
  const bad = analyzed.filter((r) => String(r.summary ?? '').trim().length <= 25);
  return ok(bad.length === 0, `${bad.length} 篇过短: ${JSON.stringify(bad.slice(0, 2).map((b) => b.title))}`);
});
check('每篇摘要讲的是它自己（摘要里含本篇标题）', () => {
  const bad = analyzed.filter((r) => !String(r.summary).includes(String(r.title)));
  return ok(bad.length === 0, `${bad.length} 篇串号: ${JSON.stringify(bad.slice(0, 3).map((b) => b.title))}`);
});
check('没有条目停在 extracted', () => {
  const left = q(`SELECT stage, COUNT(*) c FROM entries WHERE stage <> 'analyzed' GROUP BY stage`);
  return ok(left.length === 0, JSON.stringify(left));
});
check('key_points / topics 是 JSON 数组（不是 "[object Object]"）', () => {
  const bad = analyzed.filter((r) => {
    try {
      return !Array.isArray(JSON.parse(r.key_points)) || !Array.isArray(JSON.parse(r.topics));
    } catch { return true; }
  });
  return ok(bad.length === 0, `${bad.length} 篇 JSON 坏`);
});
check('prompt_version 与 model 都记了', () => {
  const bad = analyzed.filter((r) => !r.prompt_version || !r.model);
  return ok(bad.length === 0, JSON.stringify(bad.slice(0, 2).map((b) => b.title)));
});
check('cost_usd 总和 > 0（真的记账，不是占位 0）', () => {
  const sum = analyzed.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
  return ok(sum > 0, `总计 ${sum}`);
});
check('ai_usage 里有 20 条 analyze 记录', () => {
  const c = one(`SELECT COUNT(*) c FROM ai_usage WHERE purpose='analyze' AND ok=1`);
  return eq(Number(c?.c), ARTICLES.length);
});
// 分析成功之后向量化应当自动排上并被消费（§7.1 L3 → L4）。
// 断言的是**产物**：库里有 20 条向量，且维度 = mock 返回的 64。
// 只断言"排了队"会被一个排队后 handler 直接 return 的实现骗过。
check('分析完成后 20 条都自动产出了向量', () => {
  const c = one('SELECT COUNT(*) c FROM embeddings');
  return eq(Number(c?.c), ARTICLES.length);
});
check('向量维度 = 模型返回的 64，且字节 = 64×4', () => {
  const r = one('SELECT dim, length(vec) AS bytes FROM embeddings LIMIT 1');
  return ok(Number(r?.dim) === 64 && Number(r?.bytes) === 256,
    `dim=${r?.dim} bytes=${r?.bytes}`);
});
check('向量表的写入没有污染去重指纹表（entry_vectors 仍是 256 维）', () => {
  const r = one(`SELECT COUNT(*) AS n, MAX(dim) AS dim FROM entry_vectors`);
  return ok(Number(r?.n) > 0 && Number(r?.dim) === 256,
    `n=${r?.n} dim=${r?.dim}`);
});
check('category_id 落成了外键（category 表里查得到 industry）', () => {
  const withCat = analyzed.filter((r) => r.category_id);
  const industry = one(`SELECT id FROM categories WHERE slug='industry'`);
  return ok(withCat.length > 0 && Boolean(industry?.id), `有 category_id 的行数=${withCat.length}`);
});
check('source_hash 落了（幂等判据）', () => {
  const bad = analyzed.filter((r) => !r.source_hash);
  return ok(bad.length === 0, `${bad.length} 篇没有 source_hash`);
});

// ── ⑧ tier / 阅读时长 ─────────────────────────────────────
group('2.2 单篇分析 · 派生字段');
check('importance=78 → tier=worth', () => {
  const bad = analyzed.filter((r) => Number(r.importance) === 78 && r.tier !== 'worth');
  return ok(bad.length === 0, `不符 ${bad.length} 篇`);
});
check('reading_time 是 ≥1 的整数（不是 null）', () => {
  const bad = analyzed.filter((r) => !Number.isInteger(Number(r.reading_time)) || Number(r.reading_time) < 1);
  return ok(bad.length === 0, JSON.stringify(analyzed.slice(0, 3).map((r) => r.reading_time)));
});

// ── ⑦ 摘要进 FTS ──────────────────────────────────────────
group('2.2 单篇分析 · 检索');
const hit = await api('/entries?q=' + encodeURIComponent('交付节奏'));
check('搜摘要里的词（标题里没有）能命中', () => ok(
  (hit.body?.items?.length ?? 0) > 0,
  `命中 ${hit.body?.items?.length ?? 0} 条，total=${hit.body?.total}`,
));
check('命中数不超过 20（不是"全部条目"）', () => ok(
  Number(hit.body?.total ?? 0) > 0 && Number(hit.body?.total ?? 0) <= ARTICLES.length,
  `total=${hit.body?.total}`,
));

// ── ⑪ 分析结果走通了 API 到 UI 的整条路 ────────────────────
//
// 前面那些断言都直接读库。库里有摘要不等于用户在界面上看得到 ——
// 一个忘了 JOIN entry_analysis 的详情接口同样让"库里有 20 条摘要"成立，
// 而用户点开每篇都是空的。这一节逐个查视图实际依赖的字段。
group('2.2 单篇分析 · API 与视图');

const listOne = await api('/entries?view=unread&limit=50');
const firstItem = listOne.body?.items?.find((x) => x.summary);
check('列表接口每条都带 summary（不是 null）', () => ok(
  Boolean(firstItem?.summary) && String(firstItem.summary).length > 20,
  `summary=${String(firstItem?.summary ?? '').slice(0, 60)}`,
));
check('列表接口的 tier 与库一致（不是硬编码 normal）', () => {
  const fromDb = one('SELECT tier FROM entry_analysis WHERE entry_id = ?', firstItem?.id);
  return ok(firstItem?.tier === fromDb?.tier && firstItem?.tier === 'worth',
    `api=${firstItem?.tier} db=${fromDb?.tier}`);
});

const detailOne = await api(`/entries/${firstItem?.id}`);
check('详情接口返回 analysis 对象', () => ok(
  detailOne.body?.analysis && typeof detailOne.body.analysis.summary === 'string',
  JSON.stringify(detailOne.body?.analysis)?.slice(0, 120),
));
check('详情接口的 analysis 带 keyPoints 数组与 readingTime', () => ok(
  Array.isArray(detailOne.body?.analysis?.keyPoints)
  && detailOne.body.analysis.keyPoints.length >= 2
  && Number.isInteger(detailOne.body?.analysis?.readingTime),
  JSON.stringify({
    kp: detailOne.body?.analysis?.keyPoints?.length,
    rt: detailOne.body?.analysis?.readingTime,
  }),
));
check('详情接口的 analysis 里 tier 是四级之一', () =>
  ok(['must_read', 'worth', 'normal', 'noise'].includes(String(detailOne.body?.analysis?.tier)),
    String(detailOne.body?.analysis?.tier)));

// ── ③ 重跑不重复计费 ──────────────────────────────────────
group('2.2 单篇分析 · 幂等');
const target = q(`SELECT id, title FROM entries ORDER BY published_at DESC LIMIT 1`)[0];

await aiCtl({});
{
  write((d) => d.prepare(`UPDATE entries SET stage='extracted' WHERE id=?`).run(target.id));
}
const rerun = await api(`/entries/${target.id}/analyze`, { method: 'POST' });
check('手动重跑接口返回 200/202', () => ok(
  rerun.status === 200 || rerun.status === 202,
  `status=${rerun.status} body=${JSON.stringify(rerun.body).slice(0, 200)}`,
));
await sleep(1200);
{
  const st = await aiState();
  check('内容没变的重跑：一次模型调用都不发', () => eq(st.calls, 0));
  check('重跑没把已有摘要清掉', () => {
    const now = one('SELECT summary FROM entry_analysis WHERE entry_id = ?', target.id);
    return ok(String(now?.summary ?? '').includes(String(target.title)), String(now?.summary ?? '').slice(0, 60));
  });
}

await aiCtl({});
{
  const forced = await api(`/entries/${target.id}/analyze`, {
    method: 'POST', body: JSON.stringify({ force: true }),
  });
  await sleep(1500);
  const st = await aiState();
  check('force=true 时真的重新调用一次', () => ok(
    st.calls === 1 && (forced.status === 200 || forced.status === 202),
    `status=${forced.status} calls=${st.calls}`,
  ));
}

// ── ④ 正文更新后重分析 ───────────────────────────────────
group('2.2 单篇分析 · 正文更新');
{
  // 走真实写入路径：正文是 gzip BLOB，用项目自己的 packText 写，
  // 与 extract 成功后的落库方式一致。
  const { packText } = await import('../../src/server/db/text-blob.ts');
  const newBody = '<article>' + Array.from({ length: 12 }, () =>
    '<p>这是更新后的正文段落，含独有标记 ZZQ8812，用于验证正文变化会触发重新分析。</p>').join('') + '</article>';
  write((d) => {
    d.prepare(`UPDATE entry_contents SET html=?, extracted_by='readability' WHERE entry_id=?`)
      .run(packText(newBody), target.id);
    d.prepare(`UPDATE entries SET stage='extracted' WHERE id=?`).run(target.id);
  });
}
await aiCtl({});
{
  await api(`/entries/${target.id}/analyze`, { method: 'POST' });
  await sleep(1500);
  const st = await aiState();
  check('正文变了 → 重新调用了一次模型', () => eq(st.calls, 1));
  check('重新分析后 source_hash 变了', () => {
    const h = one('SELECT source_hash FROM entry_analysis WHERE entry_id=?', target.id)?.source_hash;
    return ok(Boolean(h) && h !== analyzed.find((a) => a.id === target.id)?.source_hash,
      `新 hash=${String(h).slice(0, 12)}`);
  });
}

// ── ② 缺字段 → failed 且原因可读 ─────────────────────────
group('2.2 单篇分析 · 失败分类');
const missTitle = ARTICLES[3].title;
const missId = one('SELECT id FROM entries WHERE title = ?', missTitle)?.id;
check('找到用于缺字段测试的条目', () => ok(Boolean(missId), missTitle));
{
  // 抹掉它的分析、退回 extracted，然后让 mock 这次少给两个字段
  write((d) => {
    d.prepare('DELETE FROM entry_analysis WHERE entry_id=?').run(missId);
    d.prepare(`UPDATE entries SET stage='extracted', stage_error=NULL WHERE id=?`).run(missId);
  });
}
await aiCtl({ missingFor: [missTitle.slice(0, 10)] });
{
  await api(`/entries/${missId}/analyze`, { method: 'POST' });
  const deadline = Date.now() + 30000;
  let row = null;
  while (Date.now() < deadline) {
    row = one('SELECT stage, stage_error FROM entries WHERE id = ?', missId);
    if (row?.stage === 'failed') break;
    await sleep(300);
  }
  const st = await aiState();
  check('缺字段 → 自动重试一次（共 2 次调用）', () => eq(st.calls, 2));
  check('缺字段的条目 stage=failed', () => eq(row?.stage, 'failed'));
  check('stage_error 说得出是字段问题与哪个字段', () => {
    const msg = String(row?.stage_error ?? '');
    return ok(/schema/.test(msg) && /(sentiment|novelty)/.test(msg), `stage_error=${msg.slice(0, 240)}`);
  });
  check('失败条目没有半截分析落库', () => {
    const a = one('SELECT entry_id FROM entry_analysis WHERE entry_id = ?', missId);
    return ok(!a, `存在分析行: ${JSON.stringify(a)}`);
  });
  check('失败的调用也记了 ai_usage（成本账不能漏失败）', () => {
    const c = one(`SELECT COUNT(*) c FROM ai_usage WHERE purpose='analyze' AND ok=0`);
    return eq(Number(c?.c), 2);
  });
}

// ── ⑤ 空正文不调模型 ─────────────────────────────────────
await aiCtl({});
{
  write((d) => {
    d.prepare('DELETE FROM entry_contents WHERE entry_id=?').run(missId);
    d.prepare(`UPDATE entries SET stage='extracted', stage_error=NULL WHERE id=?`).run(missId);
  });
  await api(`/entries/${missId}/analyze`, { method: 'POST', body: JSON.stringify({ force: true }) });
  await sleep(1500);
  const st = await aiState();
  check('空正文：一次模型调用都不发', () => eq(st.calls, 0));
  const after = one('SELECT stage, stage_error FROM entries WHERE id = ?', missId);
  check('空正文：stage=failed 且原因写明"空正文"', () => ok(
    after?.stage === 'failed' && /空正文/.test(String(after?.stage_error)),
    `stage=${after?.stage} err=${String(after?.stage_error).slice(0, 120)}`,
  ));
}

// ── ⑨ 没配 key 时全库不变成 failed（全局配置问题 ≠ 内容问题）──
//
// 这一条挡的是一个很容易犯的实现错误：把"没有 API key"当作单篇分析失败
// 写进 stage。后果不是"少了一个功能"，而是**问题条目列表被整库灌满** ——
// 500 条都写着"没配 key"，而用户真正想看的是哪几篇内容分析不出来。
//
// 验法有个坑：条目必须**先退回 extracted** 再试。若拿一条已经是 analyzed
// 的条目来试，"不打成 failed" 这件事会被 markFailed 里那道
// `stage <> 'analyzed'` 的守卫顺手做到 —— 断言于是恒真。
// （实测：把 no-key 分支改成无条件 markFailed，用 analyzed 的条目测仍然全绿。）
group('2.2 单篇分析 · 全局配置缺失');
{
  const analysisBefore = Number(one('SELECT COUNT(*) c FROM entry_analysis')?.c);
  const victim = one(`SELECT id FROM entries WHERE stage='analyzed' LIMIT 1`)?.id;
  write((d) => d.prepare(`UPDATE entries SET stage='extracted', stage_error=NULL WHERE id=?`).run(victim));

  write((d) => {
    d.prepare(`UPDATE settings SET ai_config = ?`).run(JSON.stringify({ apiKeyEnv: 'NO_SUCH_ENV_VAR_XYZ' }));
  });
  const { resetAiCache } = await import('../../src/server/ai/service.ts');
  resetAiCache();

  await api(`/entries/${victim}/analyze`, { method: 'POST', body: JSON.stringify({ force: true }) });
  await sleep(1200);

  const after = one('SELECT stage, stage_error FROM entries WHERE id=?', victim);
  check('没配 key：条目停在 extracted，没有被写成 failed', () => ok(
    after?.stage === 'extracted' && after?.stage_error === null,
    `stage=${after?.stage} err=${String(after?.stage_error).slice(0, 160)}`,
  ));
  check('没配 key：没有产生任何半截分析行', () =>
    eq(Number(one('SELECT COUNT(*) c FROM entry_analysis')?.c), analysisBefore));

  write((d) => d.prepare(`UPDATE settings SET ai_config = '{}'`).run());
  resetAiCache();
}

// ── ⑥ 失败不覆盖已有的好结果 ─────────────────────────────
group('2.2 单篇分析 · 不回归');
{
  const before = one('SELECT summary FROM entry_analysis WHERE entry_id=?', target.id);
  write((d) => d.prepare(`UPDATE entries SET stage='analyzed' WHERE id=?`).run(target.id));
  await aiCtl({ failFor: [String(target.title).slice(0, 10)] });
  await api(`/entries/${target.id}/analyze`, { method: 'POST', body: JSON.stringify({ force: true }) });
  await sleep(4000);
  const after = one(
    `SELECT a.summary AS summary, e.stage AS stage
       FROM entry_analysis a JOIN entries e ON e.id=a.entry_id WHERE a.entry_id=?`, target.id);
  check('分析失败时已有摘要没被清掉', () => ok(
    String(after?.summary ?? '') !== '' && String(after?.summary) === String(before?.summary),
    `before=${String(before?.summary).slice(0, 40)} after=${String(after?.summary).slice(0, 40)}`,
  ));
  check('分析失败时 stage 不会从 analyzed 掉成 failed', () => eq(after?.stage, 'analyzed'));
}

summary('m2-02-analyze');
cleanup();
await sleep(50);
process.exit(process.exitCode ?? 0);
