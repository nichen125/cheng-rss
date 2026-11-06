#!/usr/bin/env node
// 2.7 单篇总结 + 可编辑提示词 —— 验收
//
// 判据（PLAN §19.4 2.7 / §8.9）：
//   ① POST /entries/:id/summary 返回 Markdown 且落库
//   ② 同提示词再点 = 0 次请求（cached:true）；force 才重算
//   ③ 改提示词 → 指纹变、另存一条，旧的不删；改回来立刻命中旧缓存
//   ④ 占位符 {{title}}/{{body}}/{{summary}}/{{highlights}} 都被替换，
//      缺失的占位符被**追加**并记 warn（不是静默吞）
//   ⑤ 正文按 SUMMARY_BODY_CLIP=12000 截断且写明"已截断"
//   ⑥ 越权取别人的总结返回 404
//   ⑦ 提示词为空/超长/无占位符被拒并说明
//   ⑧ 「恢复默认」后 isDefault=true 且指纹回到默认
//   ⑨ 渲染走现有 parseMarkdown（不生成 HTML 字符串）
//
// ③ 是这一节的核心：只断言"改提示词后能生成新总结"是弱断言 ——
// 一个"覆盖上一次"的实现同样满足。必须再断言"改回来后 0 次请求"，
// 那条只有在按指纹存（而不是覆盖）时才成立。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, gt, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { openSqlite } from '../lib/sqlite.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(root, 'dist', process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`);

group('2.7 单篇总结');

if (!existsSync(BIN)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock 上游 ────────────────────────────────────────────────
// 总结请求返回一段带 Markdown 结构的文本，并且**把收到的 user 消息
// 里的标题回显进结论** —— 这样"总结对应的是这一篇"才是可断言的。
const ai = { calls: 0, log: [], mode: 'normal' };

const chatBody = (content) => ({
  id: 'x', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3000, completion_tokens: 260, total_tokens: 3260 },
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
    if (!String(req.url).endsWith('/chat/completions')) { res.writeHead(404); return res.end('no'); }

    ai.calls++;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    const sys = String(body.messages?.[0]?.content ?? '');
    const user = String(body.messages?.find((m) => m.role === 'user')?.content ?? '');
    ai.log.push({ sys: sys.slice(0, 80), user, len: user.length, model: body.model });

    const purpose = /速读/.test(sys) ? 'summary'
      : /信息分析编辑/.test(sys) ? 'analyze'
        : 'other';

    if (ai.mode === 'empty' && purpose === 'summary') {
      res.writeHead(200);
      return res.end(JSON.stringify(chatBody('   ')));
    }

    if (purpose === 'summary') {
      // 把 user 里"标题："那一行抠出来回显，便于断言"这条总结对应哪一篇"
      const t = /标题：(.+)/.exec(user)?.[1] ?? '(无标题)';
      res.writeHead(200);
      return res.end(JSON.stringify(chatBody(
        `## 结论\n${t} 讲的是存储层数与容量。\n\n## 要点\n- 232 层堆叠\n- 单颗 1Tb\n\n---\n\n收尾一句。`,
      )));
    }

    // analyze
    res.writeHead(200);
    return res.end(JSON.stringify(chatBody(JSON.stringify({
      summary: '机器摘要：长江存储发布 232 层 QLC 闪存。',
      key_points: ['232 层堆叠', '单颗 1Tb 容量'],
      category: 'industry',
      topics: ['存储'],
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
const dir = mkdtempSync(join(tmpdir(), 'cheng-rss-m207-'));
const dataDir = join(dir, 'data');
const port = 47700 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const API = `${base}/api/v1`;
const proc = spawn(BIN, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    AI_API_KEY: 'sk-mock-m207',
    AI_BASE_URL: `http://127.0.0.1:${AI_PORT}/v1`,
  },
});
let err = '';
proc.stderr.on('data', (d) => { err += String(d); });
proc.stdout.on('data', () => { /* drain */ });
const cleanup = () => {
  killTree(proc.pid);
  try { aiSrv.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
};
onExit(cleanup);

let up = false;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) { up = true; break; } } catch { /* not yet */ }
  await sleep(250);
}
check('服务就绪', () => ok(up, err.slice(0, 300)));
if (!up) { cleanup(); summary('m2-07-summary'); process.exit(1); }

await fetch(`${API}/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 's@test.local', password: 'sumtest12345678' }),
});
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 's@test.local', password: 'sumtest12345678' }),
});
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

const j = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};

// ── 造数据：两条带正文的条目，第二条属于另一个用户（⑥ 越权）──
const { packText } = await import('../../src/server/db/text-blob.ts');
const db = openSqlite(join(dataDir, 'app.db'));
const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id;
const now = Date.now();

// 正文刻意超过 12000 字，验 ⑤ 的截断。
// 用可辨识的句子拼：截断后能看出"结尾那句不在里面"。
const FILLER = '这是一段用于撑长度的正文内容，讲的是存储行业的技术演进与产能布局。';
const LONG_BODY = '<p>' + FILLER.repeat(400) + '</p><p>结尾一句：这一段应该被截断掉。</p>';
const SHORT_BODY = '<p>长江存储发布 232 层 QLC 闪存，单颗容量 1Tb，面向企业级市场。</p>';

const insE = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name,stage)
  VALUES (?,?,NULL,?,?,?,?,?,?,?,0,0,0,0,?, 'extracted')`);
const insC = db.prepare(
  'INSERT INTO entry_contents (entry_id, html, markdown, raw_html, extracted_by) VALUES (?,?,NULL,NULL,?)',
);
const insA = db.prepare(`INSERT INTO entry_analysis (entry_id, summary, key_points, category_id,
  topics, entities, importance, tier, novelty, sentiment, reading_time, model, prompt_version,
  created_at, source_hash, input_chars)
  VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)`);

db.exec('BEGIN IMMEDIATE');
insE.run('s_long', uid, 'g1', 'https://s.example.com/1', 's/1',
  '存储行业的长文', '导语', now, now, 's.example.com');
insC.run('s_long', packText(LONG_BODY), 'feed');
insA.run('s_long', '机器摘要：一篇很长的存储行业分析。', '["要点一"]', '["存储"]', '{}',
  70, 'worth', 50, 'neutral', 20, 'mock', 'analyze-v2', now, 'h1', 30000);

insE.run('s_short', uid, 'g2', 'https://s.example.com/2', 's/2',
  '长江存储的新闪存', '导语', now, now, 's.example.com');
insC.run('s_short', packText(SHORT_BODY), 'feed');
insA.run('s_short', '机器摘要：长江存储发布 232 层 QLC。', '["232 层"]', '["存储"]', '{}',
  78, 'mustRead', 66, 'neutral', 3, 'mock', 'analyze-v2', now, 'h2', 900);
db.exec('COMMIT');

// 第二个用户 + 一条条目（⑥ 越权）
db.exec('BEGIN IMMEDIATE');
const uid2 = 'u_other_m207';
db.prepare('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)')
  .run(uid2, 'other@test.local', 'scrypt$00$00', now);
insE.run('s_other', uid2, 'g3', 'https://s.example.com/3', 's/3',
  '别人的文章', '导语', now, now, 'other.example.com');
insC.run('s_other', packText(SHORT_BODY), 'feed');
db.exec('COMMIT');
db.close();

// ── ① 生成一条总结 ─────────────────────────────────────────
{
  await aiCtl({ mode: 'normal' });
  const r = await j('POST', '/entries/s_short/summary', {});
  check('① 生成成功、返回 Markdown、cached=false', () => {
    return ok(r.data?.ok === true && r.data?.cached === false
      && typeof r.data?.summary === 'string' && r.data.summary.length > 20,
      JSON.stringify(r.data).slice(0, 300));
  });
  check('① 返回的总结对应**这一篇**（标题回显在结论里）', () => {
    return ok(String(r.data?.summary ?? '').includes('长江存储的新闪存'),
      String(r.data?.summary ?? '').slice(0, 200));
  });
  check('① 输出含 Markdown 结构（## 与 - 与 ---）', () => {
    const s = String(r.data?.summary ?? '');
    return ok(s.includes('## ') && s.includes('- ') && s.includes('---'), s.slice(0, 160));
  });

  const st = await aiState();
  check('① mock 上游被调用 1 次', () => eq(st.calls, 1));

  const d = openSqlite(join(dataDir, 'app.db'));
  const row = d.prepare("SELECT body, prompt_fp FROM summaries WHERE entry_id = 's_short'").get();
  check('① 总结真的落库了（body 非空）', () => ok(Boolean(row?.body && row.body.length > 20),
    JSON.stringify(row)?.slice(0, 200)));
  check('① 落库同时记了提示词指纹（16 位十六进制）', () => {
    return ok(/^[0-9a-f]{16}$/.test(String(row?.prompt_fp ?? '')), String(row?.prompt_fp));
  });
  d.close();
}

// ── ② 再点一次 = 0 次请求 ──────────────────────────────────
{
  await aiCtl({ mode: 'normal' });
  const r = await j('POST', '/entries/s_short/summary', {});
  const st = await aiState();
  check('② 同提示词再点一次 cached=true', () => ok(r.data?.cached === true, JSON.stringify(r.data)));
  check('② **再点一次 0 次上游请求**（这是按指纹缓存的全部意义）', () => eq(st.calls, 0));

  await aiCtl({ mode: 'normal' });
  const f = await j('POST', '/entries/s_short/summary', { force: true });
  const st2 = await aiState();
  check('② force:true 才重算（1 次请求，cached=false）', () => {
    return ok(f.data?.cached === false && st2.calls === 1, `calls=${st2.calls}`);
  });

  const g = await j('GET', '/entries/s_short/summary');
  check('② GET 只读缓存、不生成（summary 非空、promptFp 一致）', () => {
    return ok(typeof g.data?.summary === 'string' && g.data.summary.length > 20
      && typeof g.data?.promptFp === 'string', JSON.stringify(g.data).slice(0, 200));
  });
}

// ── ③ 改提示词 → 另存一条；改回来 → 命中旧的 ──────────────
{
  const custom = '用三句话总结这篇文章，每句一个事实。标题：{{title}}\n正文：{{body}}';
  const w = await j('PATCH', '/settings/ai', { summaryPrompt: custom });
  check('③ 保存自定义提示词成功', () => ok(w.status === 200, JSON.stringify(w.data)));

  const cfg = await j('GET', '/settings/ai');
  check('③ 配置里 summaryPromptIsDefault=false 且回显自定义内容', () => {
    return ok(cfg.data?.summaryPromptIsDefault === false
      && String(cfg.data?.summaryPrompt ?? '').includes('用三句话总结'), JSON.stringify({
      isDefault: cfg.data?.summaryPromptIsDefault,
    }));
  });

  await aiCtl({ mode: 'normal' });
  const r = await j('POST', '/entries/s_short/summary', {});
  const st = await aiState();
  check('③ 改提示词后再点 = 1 次请求（不是缓存命中）', () => {
    return ok(r.data?.cached === false && st.calls === 1, `calls=${st.calls} cached=${r.data?.cached}`);
  });

  const d = openSqlite(join(dataDir, 'app.db'));
  const n = d.prepare("SELECT COUNT(*) c FROM summaries WHERE entry_id = 's_short'").get();
  check('③ **旧的那条没被覆盖**（同一篇有 2 行）', () => eq(Number(n.c), 2));
  d.close();

  // 改回来 —— 这是「按指纹而不是覆盖」的决定性断言
  await j('PATCH', '/settings/ai', { summaryPrompt: '' });
  const cfg2 = await j('GET', '/settings/ai');
  check('③ 传空串恢复默认，isDefault=true', () => {
    return ok(cfg2.data?.summaryPromptIsDefault === true, JSON.stringify({
      isDefault: cfg2.data?.summaryPromptIsDefault,
      prompt: String(cfg2.data?.summaryPrompt ?? '').slice(0, 40),
    }));
  });

  await aiCtl({ mode: 'normal' });
  const back = await j('POST', '/entries/s_short/summary', {});
  const st2 = await aiState();
  check('③ **改回默认提示词后立刻命中旧缓存（0 次请求）**', () => {
    return ok(back.data?.cached === true && st2.calls === 0,
      `cached=${back.data?.cached} calls=${st2.calls}`);
  });
}

// ── ④ 占位符替换 ──────────────────────────────────────────
{
  // 缺 {{summary}} 与 {{highlights}} 的模板：正文与标题要照常进去，
  // 缺的那两个要被**追加**在末尾（不是静默丢掉）
  const tpl = '只按这个来：{{title}}\n正文如下：{{body}}';
  await j('PATCH', '/settings/ai', { summaryPrompt: tpl });
  await aiCtl({ mode: 'normal' });
  await j('POST', '/entries/s_long/summary', {});
  const st = await aiState();
  const u = String(st.log?.[0]?.user ?? '');

  check('④ 模板里的 {{title}} 被替换成真实标题', () => {
    return ok(u.includes('标题：存储行业的长文'), u.slice(0, 200));
  });
  check('④ 正文确实被喂进去了（含正文里的字样）', () => {
    return ok(u.includes('存储行业的技术演进'), `user 长度=${u.length}`);
  });
  check('④ 模板里没写的 {{summary}} 被**追加**（不是静默丢掉）', () => {
    return ok(u.includes('机器摘要：一篇很长的存储行业分析'), u.slice(-300));
  });
  check('④ user 里不再残留任何未替换的占位符', () => {
    const leftovers = ['{{title}}', '{{body}}', '{{summary}}', '{{highlights}}']
      .filter((p) => u.includes(p));
    return ok(leftovers.length === 0, `残留 ${leftovers.join(',')}`);
  });
  check('④ 没有高亮时不追加空的 {{highlights}} 段', () => {
    return ok(!u.includes('我在这篇文章里标出的高亮'), '出现了空高亮段');
  });
}

// ── ⑤ 长文截断 ────────────────────────────────────────────
{
  await j('PATCH', '/settings/ai', { summaryPrompt: '' });
  await aiCtl({ mode: 'normal' });
  await j('POST', '/entries/s_long/summary', { force: true });
  const st = await aiState();
  const u = String(st.log?.[0]?.user ?? '');

  check('⑤ 长文被截断到 SUMMARY_BODY_CLIP=12000 附近（user 总长 < 14000）', () => {
    return ok(u.length < 14000, `user 长度 ${u.length}`);
  });
  check('⑤ **结尾那句确实被截掉了**（否则等于没截断）', () => {
    return ok(!u.includes('这一段应该被截断掉'), '结尾仍在，截断没生效');
  });
  check('⑤ 截断处写明了"已截断"与总字数', () => {
    return ok(/已截断，共 \d+ 字/.test(u), u.slice(-200));
  });
}

// ── ⑥ 越权 ────────────────────────────────────────────────
{
  const r = await j('GET', '/entries/s_other/summary');
  check('⑥ 读别人的条目总结返回 404（不是 403，避免泄露"存在"）', () => {
    return ok(r.status === 404, `status=${r.status} body=${JSON.stringify(r.data)}`);
  });
  const p = await j('POST', '/entries/s_other/summary', {});
  check('⑥ 给别人的条目生成总结也返回 404', () => ok(p.status === 404, `status=${p.status}`));
}

// ── ⑦ 提示词校验 ──────────────────────────────────────────
{
  const noPh = await j('PATCH', '/settings/ai', { summaryPrompt: '总结这篇文章，不要占位符。' });
  check('⑦ **没有占位符的提示词被拒**（否则正文不会被喂进去）', () => {
    const msg = noPh.data?.error?.message ?? noPh.data?.message ?? '';
    return ok(noPh.status === 400 && /占位符/.test(String(msg)), `status=${noPh.status} msg=${msg}`);
  });

  const tooLong = await j('PATCH', '/settings/ai', {
    summaryPrompt: '{{body}}' + 'x'.repeat(9000),
  });
  check('⑦ 超长提示词（>8000 字）被拒并给出上限', () => {
    const msg = tooLong.data?.error?.message ?? tooLong.data?.message ?? '';
    return ok(tooLong.status === 400 && /8000/.test(String(msg)), `status=${tooLong.status} msg=${msg}`);
  });

  const wrongType = await j('PATCH', '/settings/ai', { summaryPrompt: 123 });
  check('⑦ 非字符串被拒', () => ok(wrongType.status === 400, `status=${wrongType.status}`));

  // 校验失败不能写进库：读回来还是默认
  const cfg = await j('GET', '/settings/ai');
  check('⑦ 校验失败后配置没有被写脏（仍为默认）', () => {
    return ok(cfg.data?.summaryPromptIsDefault === true, String(cfg.data?.summaryPrompt).slice(0, 60));
  });
}

// ── ⑧ 空正文 / 空模型输出 ─────────────────────────────────
{
  const d = openSqlite(join(dataDir, 'app.db'));
  d.prepare("UPDATE entry_contents SET html = NULL WHERE entry_id = 's_short'").run();
  d.close();

  const r = await j('POST', '/entries/s_short/summary', { force: true });
  check('⑧ 空正文不调模型、返回 kind=empty', () => {
    return ok(r.data?.ok === false && r.data?.failure?.kind === 'empty',
      JSON.stringify(r.data));
  });

  const { packText: pt } = await import('../../src/server/db/text-blob.ts');
  const d2 = openSqlite(join(dataDir, 'app.db'));
  d2.prepare("UPDATE entry_contents SET html = ? WHERE entry_id = 's_short'")
    .run(pt(SHORT_BODY));
  d2.close();

  await aiCtl({ mode: 'empty' });
  const e = await j('POST', '/entries/s_short/summary', { force: true });
  check('⑧ 模型返回空白时判 empty 且**不落库**', () => {
    return ok(e.data?.ok === false && e.data?.summary === null, JSON.stringify(e.data).slice(0, 200));
  });
  await aiCtl({ mode: 'normal' });
}

// ── ⑨ 渲染契约 ────────────────────────────────────────────
{
  // 解析器是纯函数（`digest/md-parse.ts`，无 JSX），可以直接 import。
  // 渲染器（markdown.tsx）返回 React 节点、必须有 .tsx，那段靠
  // m3-05 的浏览器断言覆盖 —— 这里只验"文本永远不会变成 HTML"这条契约。
  const mod = await import('../../src/client/digest/md-parse.ts');
  const blocks = mod.parseMarkdown('## 结论\n第一段。\n\n- 甲\n- 乙\n\n---');
  check('⑨ parseMarkdown 认出 h2 / p / ul / hr 四种块', () => {
    const kinds = blocks.map((b) => b.kind).join(',');
    return eq(kinds, 'h2,p,ul,hr');
  });
  check('⑨ 列表块带 2 个条目', () => {
    const ul = blocks.find((b) => b.kind === 'ul');
    return ok(ul && Array.isArray(ul.items) && ul.items.length === 2, JSON.stringify(ul));
  });
  check('⑨ 模型写出的 HTML 标签不会被当成标签（只切块、不解析 HTML）', () => {
    const b = mod.parseMarkdown('<script>alert(1)</script>');
    return ok(b.length === 1 && b[0].kind === 'p' && b[0].text.includes('<script>'),
      JSON.stringify(b));
  });
  check('⑨ parseInline 把 [n] 识别为 cite 段（渲染层据此做成按钮）', () => {
    const segs = mod.parseInline('前文 [2] 后文');
    const cite = segs.find((s) => s.kind === 'cite');
    return ok(cite && cite.n === 2, JSON.stringify(segs));
  });
  check('⑨ parseInline 把 [文字](url) 当普通文字（不给模型留"偷偷写链接"的路）', () => {
    const segs = mod.parseInline('见 [这里](https://evil.example.com)');
    const text = segs.map((s) => s.text ?? '').join('');
    return ok(text.includes('[这里](https://evil.example.com)'), JSON.stringify(segs));
  });
}

cleanup();
await sleep(300);
summary('m2-07-summary');
