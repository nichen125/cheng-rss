#!/usr/bin/env node
// 4.3 高亮 UI（真实浏览器）—— 验收
//
// 判据（PLAN §11.3）：
//   ① 划词后工具条出现在选区上方（不是屏幕别处）
//   ② 点色块后选区那一段带上底色（<mark> 真的插进了那段文字）
//   ③ 高亮列表出现这一条，点击能滚回去
//   ④ 加批注后批注可见，改颜色后底色跟着变
//   ⑤ 渲染位置与**服务端算的位置一致** —— 这是整条链最容易断的地方：
//      浏览器侧算的纯文本偏移必须与服务端 htmlToText 的规则等价，
//      不等价的话高亮会画在错误的字符上（而且看起来"像成功了"）
//   ⑥ orphaned 的高亮在列表里单独一段可见
//
// ⑤ 是这一节的核心。只断言"页面里有 <mark>"是空断言 —— 一个把整段
// 都标黄的实现同样满足。必须断言 mark 的文本**等于**当初选中的那段。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, gt, summary } from './harness.mjs';
import { killTree } from '../lib/proc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BROWSERS = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
const browser = BROWSERS.find((p) => existsSync(p));
const BIN = join(root, 'dist', process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`);

if (!browser) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器，跳过 UI 断言');
  summary('m4-03-highlights-ui');
  process.exit(0);
}
if (!existsSync(BIN)) {
  console.log('  \u001b[33mSKIP\u001b[0m  没有构建产物');
  summary('m4-03-highlights-ui');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'ai-rss-m403-'));
const port = 46800 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const proc = spawn(BIN, ['serve', '--data', join(dir, 'data'), '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AI_API_KEY: '' },
});
const profile = join(dir, 'profile');
let edge = null;
const cleanup = () => {
  killTree(proc.pid);
  killTree(edge?.pid);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

let up = false;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) { up = true; break; } } catch { /* 起 */ }
  await new Promise((r) => setTimeout(r, 200));
}
check('服务就绪', () => ok(up, '二进制没起来'));

if (!up) { summary('m4-03-highlights-ui'); cleanup(); process.exit(1); }

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'hu@t.local', password: 'hupass12345678' }),
});
const login = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'hu@t.local', password: 'hupass12345678' }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];

// ── 造一篇有正文的文章 ──────────────────────────────────────
const PARA = '长江存储宣布 232 层 QLC 闪存量产，单颗容量 1Tb。';
{
  const { DatabaseSync } = await import('node:sqlite');
  const { packText } = await import('../../src/server/db/text-blob.ts');
  const w = new DatabaseSync(join(dir, 'data', 'app.db'));
  const uid = w.prepare('SELECT id FROM users LIMIT 1').get().id;
  w.prepare(`INSERT INTO entries (id, user_id, feed_id, guid, url, url_norm, title,
      published_at, fetched_at, stage) VALUES ('e_ui', ?, NULL, 'gui',
      'https://e.test/ui', 'https://e.test/ui', '高亮 UI 测试文章', ?, ?, 'extracted')`)
    .run(uid, Date.now(), Date.now());
  const html = [
    '<p>导语：这是一篇关于存储芯片的报道，用于验证划词高亮的界面交互。</p>',
    `<p>${PARA}</p>`,
    `<p>该产品面向企业级 SSD 市场，四季度出货。这一段足够长，方便用户拖选。</p>`,
    '<p>最后一段：以上为全文内容，用于凑出足够的可选文本。</p>',
  ].join('');
  w.prepare('INSERT INTO entry_contents (entry_id, html) VALUES (?,?)')
    .run('e_ui', packText(html));
  w.close();
}

// ── 起浏览器 ────────────────────────────────────────────────
edge = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--window-size=1440,1000', base,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let wsUrl = '';
edge.stderr.on('data', (d) => {
  const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
  if (m) wsUrl = m[1];
});
for (let i = 0; i < 100 && !wsUrl; i++) await new Promise((r) => setTimeout(r, 200));
check('浏览器调试端口可用', () => ok(Boolean(wsUrl), 'CDP 没起来'));

if (!wsUrl) { summary('m4-03-highlights-ui'); cleanup(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
  }
};
const raw = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++msgId;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const targets = await raw('Target.getTargets');
const pageT = targets.targetInfos.find((t) => t.type === 'page');
const { sessionId } = await raw('Target.attachToTarget', { targetId: pageT.targetId, flatten: true });
const sess = (method, params = {}) => raw(method, params, sessionId);
const evalJs = async (expr) => {
  const r = await sess('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.text));
  return r.result?.value;
};

await sess('Network.enable');
await sess('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=')[1], url: base });
await sess('Page.navigate', { url: base });
await new Promise((r) => setTimeout(r, 2500));

// 打开这篇文章
const opened = await evalJs(`(async () => {
  for (let i = 0; i < 30; i++) {
    const row = document.querySelector('.entry-item');
    if (row) { row.click(); await new Promise(r => setTimeout(r, 1200)); return 'ok'; }
    await new Promise(r => setTimeout(r, 200));
  }
  return 'no-row';
})()`);
check('能打开一篇文章的阅读页', () => ok(opened === 'ok', String(opened)));

const hasBody = await evalJs(`Boolean(document.querySelector('.article-body'))`);
check('正文渲染出来了', () => ok(hasBody === true));

// ── ② 划词 → 工具条 ────────────────────────────────────────
//
// 用 JS 直接构造 Range 而不是模拟鼠标拖动：headless 下的拖选坐标不稳，
// 而这里要验的是"选区 → 工具条 → 高亮"这条链，不是"鼠标事件能不能收到"。
const selected = await evalJs(`(() => {
  const body = document.querySelector('.article-body');
  if (!body) return { err: 'no-body' };
  const target = ${JSON.stringify(PARA)};

  // 找到包含目标文字的那个文本节点
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node = null, at = -1;
  while (walker.nextNode()) {
    const t = walker.currentNode;
    const i = t.data.indexOf(target);
    if (i >= 0) { node = t; at = i; break; }
  }
  if (!node) return { err: 'text-not-found' };

  const r = document.createRange();
  r.setStart(node, at);
  r.setEnd(node, at + target.length);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);

  // 触发与用户松手同一个事件
  body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return { ok: true, text: r.toString() };
})()`);
check('成功在正文里定位到目标段落', () =>
  ok(selected?.ok === true, JSON.stringify(selected)?.slice(0, 120)));

await new Promise((r) => setTimeout(r, 500));
const tb = await evalJs(`(() => {
  const el = document.querySelector('.hl-toolbar');
  if (!el) return { exists: false };
  const r = el.getBoundingClientRect();
  const body = document.querySelector('.article-body').getBoundingClientRect();
  const swatches = el.querySelectorAll('.hl-swatch').length;
  return {
    exists: true, swatches,
    // 工具条应落在正文区域内（不是左上角 0,0，也不是屏幕外）
    insideX: r.left >= body.left - 40 && r.right <= body.right + 40,
    insideY: r.top >= body.top - 120 && r.bottom <= body.bottom + 120,
    w: Math.round(r.width), h: Math.round(r.height),
  };
})()`);
check('划词后工具条出现', () => ok(tb?.exists === true, JSON.stringify(tb)));
check('工具条有 3 个颜色块（§11.3 三色即可）', () =>
  eq(tb?.swatches, 3));
check('工具条出现在选区附近（不是屏幕左上角）', () =>
  ok(tb?.insideX === true && tb?.insideY === true,
    `insideX=${tb?.insideX} insideY=${tb?.insideY}`));

// ── ② 点色块 → 高亮真的落到那一段 ─────────────────────────
const clicked = await evalJs(`(async () => {
  const btn = document.querySelector('.hl-toolbar .hl-swatch-yellow');
  if (!btn) return 'no-btn';
  btn.click();
  await new Promise(r => setTimeout(r, 1200));
  return 'ok';
})()`);
check('点黄色块能提交', () => ok(clicked === 'ok', String(clicked)));

const markInfo = await evalJs(`(() => {
  const marks = [...document.querySelectorAll('.article-body mark.hl')];
  return {
    count: marks.length,
    texts: marks.map(m => m.textContent),
    colorClass: marks[0]?.className ?? '',
    inList: document.querySelectorAll('.reader-hl .hl-card').length,
  };
})()`);
check('页面上出现了一个 <mark class="hl">', () => ok(
  markInfo?.count === 1, `count=${markInfo?.count} texts=${JSON.stringify(markInfo?.texts)}`,
));
check('**被标记的文本正好是选中的那一段**（不是整段正文）', () =>
  eq(markInfo?.texts?.[0], PARA));
check('是黄色（点了黄块）', () => ok(/hl-yellow/.test(String(markInfo?.colorClass)),
  String(markInfo?.colorClass)));
check('高亮列表里也出现了这一条', () => eq(markInfo?.inList, 1));

// ── ⑤ 前后端位置一致 ───────────────────────────────────────
//
// 服务端按 htmlToText(html) 算位置，浏览器按自己的 buildTextMap 算。
// 两者不一致时高亮会画在**别的字符**上 —— 而它看起来完全正常（有 mark、
// 有颜色），只有真的比对文本才能发现。
const consistency = await evalJs(`(async () => {
  const id = document.querySelector('.article-body mark.hl')?.dataset.highlightId;
  if (!id) return { err: 'no-id' };
  const r = await fetch('/api/v1/entries/e_ui/highlights', { credentials: 'include' });
  const j = await r.json();
  const h = j.items.find(x => x.id === id);
  return {
    quote: h?.quote ?? null,
    posStart: h?.posStart ?? null,
    posEnd: h?.posEnd ?? null,
    id,
  };
})()`);
check('服务端存下的 quote 与选中的文本一致', () => eq(consistency?.quote, PARA));
check('服务端给出了有效的 posStart/posEnd', () => ok(
  typeof consistency?.posStart === 'number' && consistency.posEnd > consistency.posStart,
  JSON.stringify(consistency),
));

// ── ④ 加批注 / 改颜色 ─────────────────────────────────────
const edited = await evalJs(`(async () => {
  const link = document.querySelector('.reader-hl .hl-edit-link');
  if (!link) return 'no-link';
  link.click();
  await new Promise(r => setTimeout(r, 400));
  const ta = document.querySelector('.reader-hl .hl-edit textarea');
  if (!ta) return 'no-textarea';
  // React 受控组件要走原生 setter 才能触发 onChange
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '这条值得跟进');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));

  const green = document.querySelector('.reader-hl .hl-edit .hl-swatch-green');
  if (green) { green.click(); await new Promise(r => setTimeout(r, 500)); }

  const save = [...document.querySelectorAll('.reader-hl .hl-edit .btn')]
    .find(b => b.textContent.includes('保存'));
  if (save) { save.click(); await new Promise(r => setTimeout(r, 800)); }
  return 'ok';
})()`);
check('能打开批注编辑器并保存', () => ok(edited === 'ok', String(edited)));

const afterEdit = await evalJs(`(() => ({
  note: document.querySelector('.reader-hl .hl-note')?.textContent ?? '',
  colorClass: document.querySelector('.article-body mark.hl')?.className ?? '',
}))()`);
check('批注显示出来了', () => ok(/这条值得跟进/.test(String(afterEdit?.note)),
  String(afterEdit?.note)));
check('改成绿色后 mark 的 class 跟着变', () =>
  ok(/hl-green/.test(String(afterEdit?.colorClass)), String(afterEdit?.colorClass)));

// AI 解读按钮存在，且**没配 key 时的提示不是红色报错**
//
// 这里只验按钮接上了。解读本身要真模型，m4-04 用 mock 已覆盖；
// 在这个无 key 的环境里调一次会很慢（要等超时），所以不调。
const insightBtn = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('.reader-hl .hl-actions .hl-edit-link')];
  return { labels: btns.map(b => b.textContent.trim()) };
})()`);
check('每条高亮都有「AI 解读」入口', () =>
  ok(insightBtn?.labels?.includes('AI 解读'), JSON.stringify(insightBtn?.labels)));
check('有批注的那条仍显示「编辑批注」（不是两个按钮合并）', () =>
  ok(insightBtn?.labels?.includes('编辑批注'), JSON.stringify(insightBtn?.labels)));

// 真正的往返：**刷新页面**，让服务端存的 posStart/posEnd 重新驱动一次渲染。
//
// 为什么不用"在页面里按 posStart 手动切一遍"来自检：那样切出来的文本
// 依赖我在测试里重写一遍空白折叠规则，写错了测的就是我自己，不是产品。
// 刷新后重画的路径与"用户第二天打开这篇文章"完全相同，而且它绕开了
// 浏览器侧刚算出的那份偏移 —— 只有服务端的位置是对的，<mark> 才会落回
// 原来的字上。
//
// ⚠ 刷新前要把 is_read 清零：刚才点开这篇文章已经把它标成已读，而默认
// 视图是「未读」（§15.19），刷新后列表本来就是空的 —— 那不是高亮的问题，
// 但会让下面的断言全部因为"没有文章"而失败，看起来很像是高亮坏了。
{
  const { DatabaseSync } = await import('node:sqlite');
  const w = new DatabaseSync(join(dir, 'data', 'app.db'));
  w.prepare("UPDATE entries SET is_read = 0 WHERE id = 'e_ui'").run();
  w.close();
}
await sess('Page.reload');
await new Promise((r) => setTimeout(r, 2500));
const roundTrip = await evalJs(`(async () => {
  let clicked = 'none';
  for (let i = 0; i < 30; i++) {
    const row = document.querySelector('.entry-item');
    if (row) { row.click(); clicked = 'ok'; await new Promise(r => setTimeout(r, 1400)); break; }
    await new Promise(r => setTimeout(r, 200));
  }
  const marks = [...document.querySelectorAll('.article-body mark.hl')];
  const api = await (await fetch('/api/v1/entries/e_ui/highlights')).json();
  return {
    clicked,
    hasBody: Boolean(document.querySelector('.article-body')),
    apiStatus: api.items ? 'ok' : JSON.stringify(api).slice(0, 120),
    apiCount: api.items?.length ?? -1,
    listCards: document.querySelectorAll('.reader-hl .hl-card').length,
    count: marks.length, texts: marks.map(m => m.textContent),
  };
})()`);
check('刷新后仍能打开同一篇文章', () => ok(roundTrip?.hasBody === true,
  JSON.stringify({ clicked: roundTrip?.clicked, hasBody: roundTrip?.hasBody })));
check('刷新后高亮接口仍返回这一条', () => eq(roundTrip?.apiCount, 1));
check('刷新页面后高亮按服务端位置重新画出来', () =>
  ok(roundTrip?.count === 1, `count=${roundTrip?.count} texts=${JSON.stringify(roundTrip?.texts)}`),
);
check('**重画落在同一段文字上**（服务端偏移与浏览器纯文本规则等价）', () =>
  eq(roundTrip?.texts?.[0], PARA));

// ── ⑥ orphaned 可见 ───────────────────────────────────────
//
// 把正文改掉再重锚，然后把页面刷新 —— 列表里必须出现
// 「原文已变化，无法定位」那一段。
{
  const { DatabaseSync } = await import('node:sqlite');
  const { packText } = await import('../../src/server/db/text-blob.ts');
  const { reanchorEntry } = await import('../../src/server/highlights/anchor.ts');
  const w = new DatabaseSync(join(dir, 'data', 'app.db'));
  const NEW = '这是一段完全重写过的正文，与之前的任何内容都不重叠。';
  w.prepare('UPDATE entry_contents SET html = ? WHERE entry_id = ?')
    .run(packText(`<p>${NEW}</p>`), 'e_ui');
  // 同样要把 is_read 清零，否则默认视图里根本没有这篇文章可以点开
  w.prepare("UPDATE entries SET is_read = 0 WHERE id = 'e_ui'").run();
  reanchorEntry(w, 'e_ui', NEW);
  w.close();
}
await sess('Page.reload');
await new Promise((r) => setTimeout(r, 2500));
const orphanUi = await evalJs(`(async () => {
  for (let i = 0; i < 30; i++) {
    const row = document.querySelector('.entry-item');
    if (row) { row.click(); await new Promise(r => setTimeout(r, 1200)); break; }
    await new Promise(r => setTimeout(r, 200));
  }
  return {
    head: document.querySelector('.reader-hl .hl-orphan-head')?.textContent ?? '',
    cards: document.querySelectorAll('.reader-hl .hl-group-orphan .hl-card').length,
    marks: document.querySelectorAll('.article-body mark.hl').length,
  };
})()`);
check('原文变化后高亮列表里出现「原文已变化」那一段', () =>
  ok(/原文已变化/.test(String(orphanUi?.head)), String(orphanUi?.head)));
check('orphaned 的高亮仍然被列出来（不静默丢）', () =>
  eq(orphanUi?.cards, 1));
check('orphaned 的不再画底色（画了也是错的）', () => eq(orphanUi?.marks, 0));

ws.close();
summary('m4-03-highlights-ui');
cleanup();
process.exitCode = process.exitCode ?? 0;
