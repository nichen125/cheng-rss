#!/usr/bin/env node
// 4.4 高亮 × AI 联动 —— 验收
//
// 判据（PLAN §11.4）：
//   ① 单条解读：POST /highlights/:id/insight 能拿到解读并落库，重复调用走缓存
//   ② 解读的上下文确实是**这一段的前后文**（不是整篇，也不是空）
//   ③ few-shot：≥3 条高亮才注入，且注入的是**这个用户自己的**高亮
//   ④ few-shot 措辞**不能是硬规则**（写成"必须给高分"会让分级废掉）
//   ⑤ 简报小节：「你今天标记的要点」原文照列，位置与条数正确
//
// 这一节最容易写成空断言的地方是 ③：
// "prompt 里出现了高亮引文" 是不够的 —— 一个把**所有用户**的高亮都塞进去
// 的实现同样满足，而那是数据泄漏。所以必须造第二个用户的高亮，断言他的
// 引文**不在** prompt 里。
//
// ②同理：只断言"context 非空"不够，要断言它**等于**正文里那段前后文，
// 否则一个把整篇文章都塞进去的实现也能通过（而它会让 token 爆掉）。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, gt, summary } from './harness.mjs';
import { killTree } from '../lib/proc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(root, 'dist', process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`);

if (!existsSync(BIN)) {
  console.log('  \u001b[33mSKIP\u001b[0m  没有构建产物');
  summary('m4-04-ai-linkage');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock：OpenAI 兼容 API ───────────────────────────────────
const ai = { calls: 0, log: [], mode: 'normal' };

const chatBody = (content) => ({
  id: 'x', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 800, completion_tokens: 120, total_tokens: 920 },
});

const aiSrv = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += String(d); });
  req.on('end', () => {
    if (req.url === '/_ctl') {
      const c = JSON.parse(raw || '{}');
      ai.calls = 0; ai.log = []; ai.mode = c.mode ?? 'normal';
      res.writeHead(200); return res.end('{}');
    }
    if (req.url === '/_state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ calls: ai.calls, log: ai.log }));
    }
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); return res.end('no'); }

    ai.calls++;
    let body;
    try { body = JSON.parse(raw); } catch { body = {}; }
    const sys = String((body.messages ?? []).find((m) => m.role === 'system')?.content ?? '');
    const user = String((body.messages ?? []).find((m) => m.role === 'user')?.content ?? '');
    // 用 system 的首句区分用途：分析 / 解读
    const purpose = /阅读助手/.test(sys) ? 'insight'
      : /信息分析编辑/.test(sys) ? 'analyze'
        : 'other';
    ai.log.push({ purpose, sys: sys.slice(0, 60), user, size: user.length });

    if (ai.mode === 'empty-insight' && purpose === 'insight') {
      res.writeHead(200); return res.end(JSON.stringify(chatBody(JSON.stringify({ insight: '   ' }))));
    }

    if (purpose === 'insight') {
      res.writeHead(200); return res.end(JSON.stringify(chatBody(
        JSON.stringify({ insight: '这段话给出了具体的层数与容量，是判断量产节奏的关键依据。' }),
      )));
    }

    // analyze：返回一个合法结构
    res.writeHead(200); return res.end(JSON.stringify(chatBody(JSON.stringify({
      summary: '长江存储发布 232 层 QLC 闪存，单颗容量 1Tb，面向企业级市场。',
      key_points: ['232 层堆叠', '单颗 1Tb 容量'],
      category: 'industry',
      topics: ['存储', '闪存'],
      entities: { people: [], orgs: [], products: [], tech: [] },
      importance: 78, novelty: 66, sentiment: 'neutral',
    }))));
  });
});
await new Promise((r) => aiSrv.listen(0, '127.0.0.1', r));
const AI_PORT = aiSrv.address().port;
const aiCtl = (b = {}) => fetch(`http://127.0.0.1:${AI_PORT}/_ctl`, { method: 'POST', body: JSON.stringify(b) });
const aiState = async () => (await fetch(`http://127.0.0.1:${AI_PORT}/_state`)).json();

// ── 起服务 ─────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'ai-rss-m404-'));
const port = 46400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const proc = spawn(BIN, ['serve', '--data', join(dir, 'data'), '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    AI_API_KEY: 'sk-mock',
    AI_BASE_URL: `http://127.0.0.1:${AI_PORT}/v1`,
  },
});
const cleanup = () => {
  killTree(proc.pid);
  try { aiSrv.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

let up = false;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) { up = true; break; } } catch { /* 起 */ }
  await sleep(200);
}
if (!up) {
  check('服务就绪', () => ok(false, '二进制没起来'));
  summary('m4-04-ai-linkage');
  cleanup();
  process.exit(1);
}

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ai@t.local', password: 'aipass12345678' }),
});
const login = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ai@t.local', password: 'aipass12345678' }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
const api = async (p, init = {}) => {
  const r = await fetch(`${base}/api/v1${p}`, {
    ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* 空 */ }
  return { status: r.status, body };
};
const post = (p, o) => api(p, { method: 'POST', body: JSON.stringify(o) });

// ── 造数据 ─────────────────────────────────────────────────
const PARAS = [
  '导语：存储芯片行业本周迎来新一轮产品发布潮，多家厂商公布了量产时间表。',
  '长江存储宣布 232 层 QLC 闪存量产，单颗容量 1Tb，位密度较上代提升约 33%。',
  '该产品面向企业级 SSD 市场，四季度出货，主要客户为国内数据中心与云厂商。',
  '分析师认为，QLC 在写入寿命上的短板仍限制了它在高频写入场景的采用。',
  // 这一段是刻意加长到 ~700 字的填充：目的是把下面那句"结尾"推到
  // INSIGHT_CONTEXT_CHARS（600）之外，这样"没有把整篇正文灌进去"
  // 才是一条真断言。不加长的话整篇都短于窗口，那句话必然在 prompt 里，
  // 而那只说明用例太短，不说明实现有问题。
  '中间段落：' + '这一段用于撑开前后文的窗口边界，内容本身不重要。'.repeat(30),
  '结尾：以上为全文内容，后续进展将在下一季度财报中披露。',
];
const QUOTE = '长江存储宣布 232 层 QLC 闪存量产，单颗容量 1Tb';

const DB_PATH = join(dir, 'data', 'app.db');
const { DatabaseSync } = await import('node:sqlite');
const { packText } = await import('../../src/server/db/text-blob.ts');
const { htmlToText } = await import('../../src/server/feeds/parse.ts');
const toHtml = (ps) => ps.map((p) => `<p>${p}</p>`).join('');

{
  const w = new DatabaseSync(DB_PATH);
  const uid = w.prepare('SELECT id FROM users LIMIT 1').get().id;
  w.prepare(`INSERT INTO entries (id, user_id, feed_id, guid, url, url_norm, title,
      published_at, fetched_at, stage) VALUES ('e_ai', ?, NULL, 'gai',
      'https://e.test/ai', 'https://e.test/ai', '存储芯片周报', ?, ?, 'extracted')`)
    .run(uid, Date.now(), Date.now());
  w.prepare('INSERT INTO entry_contents (entry_id, html) VALUES (?,?)')
    .run('e_ai', packText(toHtml(PARAS)));
  // 另造一个用户 + 他的高亮，用来验 few-shot 隔离
  w.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
    .run('u_other', 'other@t.local', 'Other', 'member', Date.now());
  w.prepare(`INSERT INTO entries (id, user_id, feed_id, guid, url, url_norm, title,
      published_at, fetched_at, stage) VALUES ('e_other', 'u_other', NULL, 'go2',
      'https://e.test/o2', 'https://e.test/o2', '别人的文章', ?, ?, 'extracted')`)
    .run(Date.now(), Date.now());
  w.prepare(`INSERT INTO highlights (id, user_id, entry_id, quote_exact, pos_start, pos_end,
      is_orphaned, created_at, updated_at) VALUES ('hl_other', 'u_other', 'e_other',
      '别人标的一段绝密内容', 0, 3, 0, ?, ?)`).run(Date.now(), Date.now());
  w.close();
}

const TEXT = htmlToText(toHtml(PARAS));
const qStart = TEXT.indexOf(QUOTE);

// ── ① 单条解读 ─────────────────────────────────────────────
group('4.4 联动 · 单条解读');

await aiCtl();
const created = await post('/highlights', {
  entryId: 'e_ai', start: qStart, end: qStart + QUOTE.length, color: 'yellow',
});
check('先造一条高亮', () => eq(created.status, 201));
const HL = created.body;

const ins = await post(`/highlights/${HL.id}/insight`, {});
check('解读接口返回 200 且 ok=true', () =>
  ok(ins.status === 200 && ins.body?.ok === true, JSON.stringify(ins.body)?.slice(0, 160)));
check('拿到了非空的解读文本', () =>
  ok(typeof ins.body?.insight === 'string' && ins.body.insight.length > 0,
    JSON.stringify(ins.body?.insight)));
check('首次调用不算缓存命中', () => eq(ins.body?.cached, false));

{
  const state = await aiState();
  const insightCalls = state.log.filter((x) => x.purpose === 'insight');
  check('确实调了模型（1 次）', () => eq(insightCalls.length, 1));
  check('用的是分析之外的 purpose（成本能分开记账）', () =>
    ok(insightCalls.length === 1 && insightCalls[0].purpose === 'insight',
      JSON.stringify(state.log.map((x) => x.purpose))));
}

// ② 上下文是这一段的前后文
{
  const state = await aiState();
  const user = state.log.find((x) => x.purpose === 'insight')?.user ?? '';
  check('prompt 里带上了原文标题（模型要知道在讲什么）', () =>
    ok(user.includes('存储芯片周报'), user.slice(0, 120)));
  check('prompt 里带上了被标记的那一段', () => ok(user.includes(QUOTE), user.slice(0, 200)));
  check('带上了前文（上一段的内容）', () =>
    ok(user.includes('多家厂商公布了量产时间表'), user.slice(0, 300)));
  check('带上了后文（下一段的内容）', () =>
    ok(user.includes('面向企业级 SSD 市场'), user.slice(0, 400)));
  check('**没有把整篇正文灌进去**（否则 token 白烧）', () => {
    // 全文最后一段不该出现在解读 prompt 里 —— 它离高亮隔了 3 段 600 字以外
    return ok(!user.includes('后续进展将在下一季度财报中披露'),
      `prompt 长度=${user.length}`);
  });
  check('prompt 长度在合理范围内（< 2000 字）', () =>
    ok(user.length < 2000, `len=${user.length}`));
}

// 重复调用走缓存
{
  await aiCtl();
  const again = await post(`/highlights/${HL.id}/insight`, {});
  check('重复调用返回同样的解读', () => eq(again.body?.insight, ins.body?.insight));
  check('重复调用标 cached=true', () => eq(again.body?.cached, true));
  const state = await aiState();
  check('**重复调用没有再次请求模型**（0 次）', () => eq(state.calls, 0));
}

{
  await aiCtl();
  const forced = await post(`/highlights/${HL.id}/insight`, { force: true });
  check('force=true 时重新请求模型', () => eq(forced.body?.cached, false));
  const state = await aiState();
  check('force 确实发了一次请求', () => eq(state.calls, 1));
}

const afterInsight = await api('/entries/e_ai/highlights');
const storedHl = afterInsight.body.items.find((x) => x.id === HL.id);
check('解读落库了（ai_insight 有值）', () =>
  ok(typeof storedHl?.aiInsight === 'string' && storedHl.aiInsight.length > 0,
    JSON.stringify(storedHl?.aiInsight)?.slice(0, 80)));

// 解读别人的高亮 → 404（越权）
{
  const r = await post('/highlights/hl_other/insight', {});
  check('解读别人的高亮 → 404', () => eq(r.status, 404));
}

// 空解读不落库
{
  await aiCtl({ mode: 'empty-insight' });
  const r = await post(`/highlights/${HL.id}/insight`, { force: true });
  check('模型返回空解读时 ok=false（不存一条空白）', () =>
    ok(r.body?.ok === false, JSON.stringify(r.body)?.slice(0, 140)));
  check('空解读的 failureKind 是 empty', () => eq(r.body?.failureKind, 'empty'));
  await aiCtl();
}

// ── ③④ few-shot ──────────────────────────────────────────
group('4.4 联动 · few-shot 校准');

const { buildFewshotBlock, recentHighlightsForFewshot, shouldInjectFewshot, FEWSHOT_MIN } =
  await import('../../src/server/highlights/insight.ts');

check(`FEWSHOT_MIN 是 ${FEWSHOT_MIN}（少于它不注入）`, () => ok(FEWSHOT_MIN >= 3, String(FEWSHOT_MIN)));

{
  const w = new DatabaseSync(DB_PATH);
  const uid = w.prepare('SELECT id FROM users LIMIT 1').get().id;

  // 先清空，测"不足 3 条不注入"
  w.prepare('DELETE FROM highlights WHERE user_id = ?').run(uid);
  for (let i = 0; i < FEWSHOT_MIN - 1; i++) {
    w.prepare(`INSERT INTO highlights (id, user_id, entry_id, quote_exact, pos_start, pos_end,
        is_orphaned, created_at, updated_at) VALUES (?,?,'e_ai',?,0,10,0,?,?)`)
      .run(`hl_s${i}`, uid, `样本引文第 ${i} 条，足够长的内容占位`, Date.now() - i * 1000, Date.now());
  }
  const few = recentHighlightsForFewshot(w, uid);
  check(`只有 ${FEWSHOT_MIN - 1} 条时 shouldInjectFewshot=false`, () =>
    ok(shouldInjectFewshot(few) === false, JSON.stringify(few.length)));
  check('不足时 buildFewshotBlock 返回空串（不是半截标题）', () =>
    eq(buildFewshotBlock(few), ''));

  // 补到 3 条
  w.prepare(`INSERT INTO highlights (id, user_id, entry_id, quote_exact, pos_start, pos_end,
      is_orphaned, created_at, updated_at) VALUES ('hl_s3',?,'e_ai',?,0,10,0,?,?)`)
    .run(uid, '第三条样本引文，数量刚好够', Date.now(), Date.now());
  const few3 = recentHighlightsForFewshot(w, uid);
  check(`满 ${FEWSHOT_MIN} 条后开始注入`, () => ok(shouldInjectFewshot(few3) === true, String(few3.length)));
  w.close();
}

{
  const w = new DatabaseSync(DB_PATH);
  const uid = w.prepare('SELECT id FROM users LIMIT 1').get().id;
  const few = recentHighlightsForFewshot(w, uid);
  const block = buildFewshotBlock(few);

  check('few-shot 段里带上了引文', () => ok(block.includes('样本引文第 0 条'), block.slice(0, 200)));
  check('**不含别人的高亮**（数据隔离）', () =>
    ok(!block.includes('别人标的一段绝密内容'), block.slice(0, 300)));
  check('不含当前条自己的引文（它刚被 DELETE 掉，不该出现在示例里）', () =>
    ok(!block.includes('长江存储宣布 232 层'), block.slice(0, 300)));

  check('**措辞是"参考"而不是硬规则**（写成必须会给所有文章打高分）', () => {
    // 不能出现"必须给高分/一律 mustRead/所有文章都"这类表达
    const bad = /必须给高分|一律\s*mustRead|所有文章都|一定给\s*9/;
    return ok(!bad.test(block), block.slice(0, 220));
  });
  check('明确写了"主题无关的一律按原基准"（防止分级整体上浮）', () =>
    ok(/无关/.test(block), block.slice(-120)));
  check('few-shot 段以两个换行开头（能干净地接在正文前）', () =>
    ok(block.startsWith('\n\n'), JSON.stringify(block.slice(0, 6))));

  // orphaned 的不能当示例：它的位置已经失效，引文可能对不上现在这篇
  w.prepare("UPDATE highlights SET is_orphaned = 1 WHERE id = 'hl_s3'").run();
  const few2 = recentHighlightsForFewshot(w, uid);
  check('orphaned 的高亮不进 few-shot', () =>
    ok(!few2.some((x) => x.quote.includes('第三条样本')), JSON.stringify(few2.map((x) => x.quote))));
  w.prepare("UPDATE highlights SET is_orphaned = 0 WHERE id = 'hl_s3'").run();

  // 30 天以外的也不进
  w.prepare("UPDATE highlights SET created_at = ? WHERE id = 'hl_s0'")
    .run(Date.now() - 40 * 24 * 3600_000);
  const few3 = recentHighlightsForFewshot(w, uid);
  check('30 天以前的高亮不进 few-shot', () =>
    ok(!few3.some((x) => x.quote.includes('第 0 条')), JSON.stringify(few3.map((x) => x.quote))));
  w.close();
}

{
  // 端到端：分析时 prompt 里真的出现了 few-shot 段
  const w = new DatabaseSync(DB_PATH);
  const uid = w.prepare('SELECT id FROM users LIMIT 1').get().id;
  w.prepare('DELETE FROM highlights WHERE user_id = ?').run(uid);
  for (let i = 0; i < 4; i++) {
    w.prepare(`INSERT INTO highlights (id, user_id, entry_id, quote_exact, pos_start, pos_end,
        is_orphaned, created_at, updated_at) VALUES (?,?,'e_ai',?,0,10,0,?,?)`)
      .run(`hl_f${i}`, uid, `端到端示例引文编号${i}，内容足够长`, Date.now() - i, Date.now());
  }
  w.prepare('DELETE FROM entry_analysis WHERE entry_id = ?').run('e_ai');
  w.close();

  await aiCtl();
  await post('/entries/e_ai/analyze', { force: true });
  // analyze 是同步接口，但队列里也可能跑一次 —— 只要有一次带 few-shot 就算
  const state = await aiState();
  const analyzeCalls = state.log.filter((x) => x.purpose === 'analyze');
  check('分析时确实请求了模型', () => gt(analyzeCalls.length, 0, 'analyze 调用次数'));
  check('**分析 prompt 里注入了 few-shot 段**', () =>
    ok(analyzeCalls.some((x) => x.user.includes('端到端示例引文编号')), 
      analyzeCalls.map((x) => x.user.length).join(',')));
  check('few-shot 段出现在正文之前（不打断正文的连续性）', () => {
    const u = analyzeCalls.find((x) => x.user.includes('端到端示例引文编号'))?.user ?? '';
    const iFew = u.indexOf('端到端示例引文编号');
    const iBody = u.indexOf('正文：');
    return ok(iFew > 0 && iBody > 0 && iFew < iBody, `few=${iFew} body=${iBody}`);
  });
}

// ── ⑤ 简报小节 ────────────────────────────────────────────
group('4.4 联动 · 简报小节');

const { listDayHighlights, renderDigestHighlightSection, DIGEST_HIGHLIGHT_MAX } =
  await import('../../src/server/highlights/insight.ts');

{
  const w = new DatabaseSync(DB_PATH);
  const uid = w.prepare('SELECT id FROM users LIMIT 1').get().id;
  w.prepare('DELETE FROM highlights WHERE user_id = ?').run(uid);

  const now = Date.now();
  w.prepare(`INSERT INTO highlights (id, user_id, entry_id, quote_exact, note, pos_start, pos_end,
      is_orphaned, created_at, updated_at) VALUES ('hl_d1',?,'e_ai',?,?,0,10,0,?,?)`)
    .run(uid, '今天标的第一个要点', '我自己的批注', now - 1000, now);
  w.prepare(`INSERT INTO highlights (id, user_id, entry_id, quote_exact, pos_start, pos_end,
      is_orphaned, created_at, updated_at) VALUES ('hl_d2',?,'e_ai',?,0,10,0,?,?)`)
    .run(uid, '今天标的第二个要点', now, now);
  // 窗口外的
  w.prepare(`INSERT INTO highlights (id, user_id, entry_id, quote_exact, pos_start, pos_end,
      is_orphaned, created_at, updated_at) VALUES ('hl_old',?,'e_ai',?,0,10,0,?,?)`)
    .run(uid, '昨天的要点不该出现', now - 3 * 24 * 3600_000, now);

  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const items = listDayHighlights(w, uid, dayStart.getTime(), now + 1000);
  check('只取当天窗口内的高亮（昨天的被排除）', () =>
    ok(!items.some((x) => x.quote.includes('昨天')), JSON.stringify(items.map((x) => x.quote))));
  check('当天两条都在', () => eq(items.length, 2));
  check('按创建时间正序（读起来像时间线）', () =>
    eq(items[0].quote, '今天标的第一个要点'));
  check('带上了条目标题', () => ok(items[0].entryTitle === '存储芯片周报', items[0].entryTitle));
  check('带上了批注', () => eq(items[0].note, '我自己的批注'));
  check('第二条没有批注时 note 为 null', () => eq(items[1].note, null));

  const md = renderDigestHighlightSection(items);
  check('小节标题是「你今天标记的要点」', () => ok(md.includes('**你今天标记的要点**'), md.slice(0, 80)));
  check('引文原文照列（不概括、不改写）', () => ok(
    md.includes('今天标的第一个要点') && md.includes('今天标的第二个要点'), md.slice(0, 200),
  ));
  check('批注用小括号附在后面', () => ok(md.includes('（批注：我自己的批注）'), md.slice(0, 200)));
  check('每条都带来源标题', () => ok(md.includes('**存储芯片周报**'), md.slice(0, 200)));
  check('以 --- 分隔线与前文隔开', () => ok(md.includes('---'), md.slice(0, 40)));

  check('空列表返回空串（不会留下半截标题）', () =>
    eq(renderDigestHighlightSection([]), ''));
  check(`最多列 ${DIGEST_HIGHLIGHT_MAX} 条`, () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      quote: `要点${i}`, entryTitle: 'T', note: null,
    }));
    const out = renderDigestHighlightSection(many.slice(0, DIGEST_HIGHLIGHT_MAX));
    return ok((out.match(/^- /gm) ?? []).length === DIGEST_HIGHLIGHT_MAX,
      `行数=${(out.match(/^- /gm) ?? []).length}`);
  });

  w.close();
}

// 端到端：简报里真的出现这个小节
{
  // 这里不跑完整 runDigest（那要造 12 个簇，m3-03/m3-04 已覆盖），
  // 只验"runDigest 里那两行调用被接上了"：用源码断言。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(root, 'src/server/digest/run.ts'), 'utf8');
  check('runDigest 调用了 listDayHighlights', () => ok(
    /listDayHighlights\(db,\s*userId/.test(src), '找不到调用',
  ));
  check('runDigest 把小节追加进了 body_md', () => ok(
    /md \+= renderDigestHighlightSection/.test(src), '找不到追加',
  ));
  check('追加发生在 saveDigest 之前（否则存的是没有小节的版本）', () => {
    const iAppend = src.indexOf('md += renderDigestHighlightSection');
    const iSave = src.indexOf('saveDigest(db,');
    return ok(iAppend > 0 && iSave > iAppend, `append=${iAppend} save=${iSave}`);
  });
}

summary('m4-04-ai-linkage');
cleanup();
process.exitCode = process.exitCode ?? 0;
