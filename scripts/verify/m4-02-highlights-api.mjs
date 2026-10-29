#!/usr/bin/env node
// 4.2 高亮 API —— 验收
//
// 判据（PLAN §11.2 / §19.6 M4）：
//   ① POST 创建、GET 按条目列、GET 全局列、PATCH 改、DELETE 删
//   ② **前端拿旧正文提交时不被静默接受**（偏移对不上就按 quote 重算，或明确报错）
//   ③ 颜色只接受三种（§11.3：不做调色盘）
//   ④ note 能被清空（用 COALESCE 的实现清不掉，这是真坑）
//   ⑤ 列表**包含 orphaned** 且带标记（§11.1 不静默丢）
//   ⑥ 游标分页在有删除时也不漏行（offset 分页会漏）
//   ⑦ 越权：别人的高亮读不到、改不了、删不掉
//
// ②④⑥⑦ 是重点。它们都不是"接口能通"，而是"接口在特定输入下会不会给出
// 错误的结果" —— 那类错误在手工点一遍时看不出来。
//
// ⚠ harness 的 check() 回调必须同步，所以本文件先跑完所有异步请求、
// 把结果收进变量，再集中断言。这不是风格偏好，是硬约束。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
  console.log('  \u001b[33mSKIP\u001b[0m  没有构建产物，先跑 scripts/build.sh --sea');
  summary('m4-02-highlights-api');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'ai-rss-m402-'));
const port = 46200 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const proc = spawn(BIN, ['serve', '--data', join(dir, 'data'), '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AI_API_KEY: '' },
});
const cleanup = () => {
  killTree(proc.pid);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

let up = false;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) { up = true; break; } } catch { /* 起 */ }
  await new Promise((r) => setTimeout(r, 200));
}
if (!up) {
  check('服务就绪', () => ok(false, '二进制没起来'));
  summary('m4-02-highlights-api');
  cleanup();
  process.exit(1);
}

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'h@t.local', password: 'hpass12345678' }),
});
const login = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'h@t.local', password: 'hpass12345678' }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

const api = async (p, init = {}) => {
  const r = await fetch(`${base}/api/v1${p}`, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* 空响应 */ }
  return { status: r.status, body };
};
const post = (p, obj) => api(p, { method: 'POST', body: JSON.stringify(obj) });
const patch = (p, obj) => api(p, { method: 'PATCH', body: JSON.stringify(obj) });
const del = (p) => api(p, { method: 'DELETE' });

/**
 * 正文的**纯文本**形态。
 *
 * ⚠ 不能用原始段落文本直接算偏移：htmlToText 会把段落之间压成一个空格，
 * 所以 "<p>甲</p><p>乙</p>" 出来是 "甲 乙" 而不是 "甲\n\n乙"。高亮的
 * position 是在这份纯文本上算的，测试里的期望值也必须用同一份 —— 否则
 * 用例本身算错了偏移，真实代码反而会被误判。
 */
const { htmlToText } = await import('../../src/server/feeds/parse.ts');
const PARAS = [
  '导语：这是一篇关于存储芯片的报道。',
  '长江存储宣布 232 层 QLC 闪存量产，单颗容量 1Tb。',
  '该产品面向企业级 SSD 市场，四季度出货。',
];
const toHtml = (ps) => ps.map((p) => `<p>${p}</p>`).join('');
const TEXT = htmlToText(toHtml(PARAS));
const PARA = PARAS[1];
const start = TEXT.indexOf(PARA);
if (start < 0) {
  // 早失败早解释：这条用例的期望值算错了，下面的断言全都没有意义
  throw new Error(`测试自身算错了偏移：TEXT=${JSON.stringify(TEXT)} PARA=${JSON.stringify(PARA)}`);
}

// 直接写库造条目（走 API 造要配 feed，与本节无关）
const { DatabaseSync } = await import('node:sqlite');
const { packText } = await import('../../src/server/db/text-blob.ts');
const DB_PATH = join(dir, 'data', 'app.db');
const w = new DatabaseSync(DB_PATH);
const uid = w.prepare('SELECT id FROM users LIMIT 1').get().id;

/**
 * 造一条带正文的条目。
 *
 * 正文存在 entry_contents.html（gzip BLOB），而且必须是**带标签的 HTML** ——
 * 高亮定位跑在 htmlToText 之后的纯文本上，没有段落标签就分不清段落。
 *
 * 参数是**段落数组**而不是一整段文本：这个测试的期望偏移是从
 * htmlToText(toHtml(PARAS)) 算出来的，写库必须用同一个函数，否则
 * 用例与实现会各算一套（第一版就是这么错的）。
 */
function addEntry(id, paragraphs = PARAS) {
  w.prepare(`INSERT INTO entries (id, user_id, feed_id, guid, url, url_norm, title,
      published_at, fetched_at, stage) VALUES (?,?,NULL,?,?,?,?,?,?,'extracted')`)
    .run(id, uid, `g-${id}`, `https://e.test/${id}`, `https://e.test/${id}`,
      '高亮测试条目', Date.now(), Date.now());
  w.prepare('INSERT INTO entry_contents (entry_id, html) VALUES (?,?)')
    .run(id, packText(toHtml(paragraphs)));
}
addEntry('e1');
addEntry('e2');
addEntry('e3', ['另一篇文章的正文，内容完全不同。']);
w.close();

// ── ① 创建 ─────────────────────────────────────────────────
group('4.2 高亮 API · 创建');

const c1 = await post('/highlights', {
  entryId: 'e1', start, end: start + PARA.length, color: 'yellow',
});
check('POST 创建返回 201', () => eq(c1.status, 201));
check('返回体带 id / quote / posStart', () => ok(
  typeof c1.body?.id === 'string' && c1.body.quote === PARA && c1.body.posStart === start,
  JSON.stringify(c1.body)?.slice(0, 160),
));
check('服务端补全了 prefix / suffix（不依赖前端传）', () =>
  ok(typeof c1.body?.prefix === 'string' && c1.body.prefix.length > 0,
    JSON.stringify(c1.body?.prefix)));
check('返回体是驼峰字段（不泄漏库结构）', () =>
  ok('entryId' in (c1.body ?? {}) && !('entry_id' in (c1.body ?? {})),
    JSON.stringify(Object.keys(c1.body ?? {}))));
const h1 = c1.body;

const cQuote = await post('/highlights', { entryId: 'e1', quote: '四季度出货' });
check('不带 start/end 但带 quote 也能创建', () =>
  ok(cQuote.status === 201 && cQuote.body.quote === '四季度出货',
    JSON.stringify(cQuote.body)?.slice(0, 100)));

const cNoAnchor = await post('/highlights', { entryId: 'e1' });
check('既没有 start/end 也没有 quote → 400', () => eq(cNoAnchor.status, 400));

const cNoEntry = await post('/highlights', { entryId: 'nope', quote: 'x' });
check('条目不存在 → 404', () => eq(cNoEntry.status, 404));

const cMissing = await post('/highlights', { entryId: 'e1', quote: '这段文字根本不在正文里' });
check('quote 在正文里找不到 → 400 且说明原因（不静默存一条错位高亮）', () =>
  ok(cMissing.status === 400 && /找不到/.test(String(cMissing.body?.error?.message)),
    JSON.stringify(cMissing.body)));

// ── ② 旧正文提交 ────────────────────────────────────────────
group('4.2 高亮 API · 旧正文');

const staleStart = TEXT.indexOf('导语');
const cStale = await post('/highlights', {
  entryId: 'e1', start: staleStart, end: staleStart + PARA.length, quote: PARA,
});
check('偏移与 quote 不一致时按 quote 重算（返回 201）', () => eq(cStale.status, 201));
check('重算后的位置指向 quote 那一段，而不是前端给的旧偏移', () => {
  if (!cStale.body) return ok(false, '没有返回体');
  return eq(TEXT.slice(cStale.body.posStart, cStale.body.posEnd), PARA);
});
check('重算后的 posStart 与旧偏移不同（证明确实重算了）', () => {
  if (!cStale.body) return ok(false, '没有返回体');
  return ok(cStale.body.posStart !== staleStart,
    `旧=${staleStart} 新=${cStale.body?.posStart}`);
});

const cBad = await post('/highlights', { entryId: 'e3', start: 0, end: 6, quote: PARA });
check('旧偏移与 quote 都对不上时 → 400 并提示重新选择', () =>
  ok(cBad.status === 400 && /重新选择/.test(String(cBad.body?.error?.message)),
    JSON.stringify(cBad.body)));

// ── ③ 颜色 ─────────────────────────────────────────────────
group('4.2 高亮 API · 颜色');

const colorResults = [];
for (const color of ['yellow', 'green', 'blue']) {
  colorResults.push(await post('/highlights', { entryId: 'e2', quote: '企业级', color }));
}
check('三种颜色（yellow/green/blue）都被接受', () =>
  ok(colorResults.every((r, i) => r.status === 201
    && r.body.color === ['yellow', 'green', 'blue'][i]),
  JSON.stringify(colorResults.map((r) => `${r.status}:${r.body?.color}`))));

const cNoColor = await post('/highlights', { entryId: 'e2', quote: '市场' });
check('不传颜色时 color 为 null（不是硬编码 yellow）', () =>
  ok(cNoColor.status === 201 && cNoColor.body.color === null,
    JSON.stringify(cNoColor.body?.color)));

const cBadColor = await post('/highlights', { entryId: 'e2', quote: '企业级', color: 'red' });
check('任意颜色（如 red）→ 400 且列出允许值', () =>
  ok(cBadColor.status === 400 && /yellow/.test(String(cBadColor.body?.error?.message)),
    JSON.stringify(cBadColor.body)));

// ── ① 读 ───────────────────────────────────────────────────
group('4.2 高亮 API · 读取');

const listE1 = await api('/entries/e1/highlights');
check('按条目列出全部高亮', () => ok(
  listE1.status === 200 && Array.isArray(listE1.body.items) && listE1.body.items.length >= 3,
  `items=${listE1.body?.items?.length}`,
));
check('列表按位置排序（不是按创建时间乱序）', () => {
  const pos = listE1.body.items.map((x) => x.posStart).filter((x) => x !== null);
  const sorted = [...pos].sort((a, b) => a - b);
  return ok(JSON.stringify(pos) === JSON.stringify(sorted), JSON.stringify(pos));
});
check('别的条目的高亮不混进来', () =>
  ok(listE1.body.items.every((x) => x.entryId === 'e1'),
    JSON.stringify(listE1.body.items.map((x) => x.entryId))));

const listAll = await api('/highlights');
check('全局列表返回 items 与 nextCursor', () =>
  ok(listAll.status === 200 && Array.isArray(listAll.body.items) && 'nextCursor' in listAll.body,
    JSON.stringify(Object.keys(listAll.body ?? {}))));
check('全局列表带 entryTitle 与 sourceName（列表要显示来自哪篇）', () =>
  ok(listAll.body.items.length > 0 && 'entryTitle' in listAll.body.items[0]
    && 'sourceName' in listAll.body.items[0],
  JSON.stringify(Object.keys(listAll.body.items[0] ?? {}))));

// ── ④ PATCH ────────────────────────────────────────────────
group('4.2 高亮 API · 修改');

const pNote = await patch(`/highlights/${h1.id}`, { note: '这条要跟进' });
check('PATCH 能加批注', () =>
  ok(pNote.status === 200 && pNote.body.note === '这条要跟进', JSON.stringify(pNote.body?.note)));
check('PATCH 不动位置（note 是元数据，不该重算锚点）', () => eq(pNote.body.posStart, start));

const pColor = await patch(`/highlights/${h1.id}`, { color: 'green' });
check('PATCH 能改颜色', () =>
  ok(pColor.status === 200 && pColor.body.color === 'green', JSON.stringify(pColor.body?.color)));
check('改颜色不影响 note', () => eq(pColor.body.note, '这条要跟进'));

const pClear = await patch(`/highlights/${h1.id}`, { note: '' });
check('**note 能被清空**（用 COALESCE 的实现清不掉）', () =>
  ok(pClear.status === 200 && pClear.body.note === null, JSON.stringify(pClear.body?.note)));

const pBadColor = await patch(`/highlights/${h1.id}`, { color: 'purple' });
check('PATCH 也校验颜色', () => eq(pBadColor.status, 400));

const pEmpty = await patch(`/highlights/${h1.id}`, {});
check('PATCH 空对象 → 400（不假装成功）', () => ok(pEmpty.status === 400, `status=${pEmpty.status}`));

const pNoRow = await patch('/highlights/hl_nope', { note: 'x' });
check('PATCH 不存在的高亮 → 404', () => eq(pNoRow.status, 404));

// ── ⑤ orphaned 可见 ─────────────────────────────────────────
group('4.2 高亮 API · orphaned 可见');

// 造一条 e3 的高亮，然后把正文彻底改掉，再跑一次重锚（提取器重跑时会发生）
await post('/highlights', { entryId: 'e3', quote: '完全不同' });
const NEW_E3 = '这是一段全新的、与之前没有任何重叠的正文。';
{
  const w2 = new DatabaseSync(DB_PATH);
  w2.prepare('UPDATE entry_contents SET html = ? WHERE entry_id = ?')
    .run(packText(`<p>${NEW_E3}</p>`), 'e3');
  w2.close();
}
// 重锚的触发点在提取流程里（m4-01 已验证库函数）。这里直接调用它，
// 因为 API 层不负责"正文变了就重锚" —— 那是提取器的职责。
const { reanchorEntry } = await import('../../src/server/highlights/anchor.ts');
{
  const w3 = new DatabaseSync(DB_PATH);
  reanchorEntry(w3, 'e3', NEW_E3);
  w3.close();
}
const listE3 = await api('/entries/e3/highlights');
check('正文被改写后，高亮仍然被列出来（不静默丢）', () =>
  ok(listE3.status === 200 && listE3.body.items.length === 1,
    JSON.stringify(listE3.body)?.slice(0, 120)));
check('被标记 isOrphaned=true', () => eq(listE3.body.items[0]?.isOrphaned, true));
check('orphaned 的 pos 为 null（不保留会指向错地方的旧值）', () =>
  eq(listE3.body.items[0]?.posStart, null));
check('orphaned 的 quote 仍保留（用户至少看得到原来标的是什么）', () =>
  ok(typeof listE3.body.items[0]?.quote === 'string' && listE3.body.items[0].quote.length > 0,
    String(listE3.body.items[0]?.quote)));

// ── ⑥ 游标分页 ─────────────────────────────────────────────
group('4.2 高亮 API · 游标分页');

{
  const w4 = new DatabaseSync(DB_PATH);
  w4.prepare(`INSERT INTO entries (id, user_id, feed_id, guid, url, url_norm, title,
      published_at, fetched_at, stage) VALUES ('e4', ?, NULL, 'g4',
      'https://e.test/4', 'https://e.test/4', '分页测试', ?, ?, 'extracted')`)
    .run(uid, Date.now(), Date.now());
  // 每个汉字包一个 <p>，这样每段都是独立可定位的
  const chars = '甲乙丙丁戊己庚辛壬癸子丑';
  w4.prepare('INSERT INTO entry_contents (entry_id, html) VALUES (?,?)')
    .run('e4', packText([...chars].map((c) => `<p>${c}</p>`).join('')));
  w4.close();
}
for (const ch of '甲乙丙丁戊己庚辛壬癸子丑'.split('')) {
  await post('/highlights', { entryId: 'e4', quote: ch });
}

const p1 = await api('/highlights?limit=5');
check('第一页给 5 条并给出 nextCursor', () =>
  ok(p1.body.items.length === 5 && typeof p1.body.nextCursor === 'string',
    `items=${p1.body.items?.length} cursor=${p1.body.nextCursor}`));

// 删掉第一页里的一条，再取第二页 —— offset 分页会因此漏掉一条
await del(`/highlights/${p1.body.items[0].id}`);
const p2 = await api(`/highlights?limit=5&cursor=${p1.body.nextCursor}`);
check('删掉第一页的一条后，第二页不漏行（游标分页的意义）', () => {
  const ids = new Set(p2.body.items.map((x) => x.id));
  const overlap = p1.body.items.filter((x) => ids.has(x.id));
  return ok(overlap.length === 0, `两页重叠 ${overlap.length} 条`);
});
check('第二页有内容（不是被删除操作搞空）', () => gt(p2.body.items.length, 0, '第二页条数'));

// ── ⑦ 越权 ─────────────────────────────────────────────────
group('4.2 高亮 API · 越权');

{
  const w5 = new DatabaseSync(DB_PATH);
  w5.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
    .run('u_other', 'o@t.local', 'O', 'member', Date.now());
  w5.prepare(`INSERT INTO entries (id, user_id, feed_id, guid, url, url_norm, title,
      published_at, fetched_at, stage) VALUES ('e_other', 'u_other', NULL,
      'go', 'https://e.test/o', 'https://e.test/o', '别人的条目', ?, ?, 'extracted')`)
    .run(Date.now(), Date.now());
  w5.prepare('INSERT INTO entry_contents (entry_id, html) VALUES (?,?)')
    .run('e_other', packText(toHtml(['别人的正文内容'])));
  w5.prepare(`INSERT INTO highlights (id, user_id, entry_id, quote_exact, pos_start, pos_end,
      is_orphaned, created_at, updated_at) VALUES ('hl_other', 'u_other', 'e_other', '别人的', 0, 3, 0, ?, ?)`)
    .run(Date.now(), Date.now());
  w5.close();
}

const xPatch = await patch('/highlights/hl_other', { note: 'x' });
check('改别人的高亮 → 404（不是 403，避免泄露"这条存在"）', () => eq(xPatch.status, 404));

const xDel = await del('/highlights/hl_other');
check('删别人的高亮 → 404', () => eq(xDel.status, 404));

const xList = await api('/highlights?limit=100');
check('别人的高亮不出现在我的全局列表里', () =>
  ok(!xList.body.items.some((x) => x.id === 'hl_other'), '出现了别人的高亮'));

const xEntry = await api('/entries/e_other/highlights');
check('读别人的条目高亮列表是空数组（不是 404，也不是他的数据）', () =>
  ok(xEntry.status === 200 && xEntry.body.items.length === 0, JSON.stringify(xEntry.body)));

// 确认越权操作真的没改成
{
  const w6 = new DatabaseSync(DB_PATH);
  const row = w6.prepare("SELECT note FROM highlights WHERE id='hl_other'").get();
  w6.close();
  check('越权 PATCH 没有真的写进去', () => eq(row.note, null));
}

// ── DELETE ─────────────────────────────────────────────────
group('4.2 高亮 API · 删除');

const d1 = await del(`/highlights/${h1.id}`);
check('DELETE 返回 200', () => eq(d1.status, 200));
const afterDel = await api('/entries/e1/highlights');
check('删掉后不再出现在列表里', () =>
  ok(!afterDel.body.items.some((x) => x.id === h1.id), '仍在列表里'));
const d2 = await del(`/highlights/${h1.id}`);
check('重复删除返回 404（幂等但不假装成功）', () => eq(d2.status, 404));

const noAuth = await fetch(`${base}/api/v1/highlights`);
check('未登录访问 → 401', () => eq(noAuth.status, 401));

summary('m4-02-highlights-api');
cleanup();
process.exitCode = process.exitCode ?? 0;
