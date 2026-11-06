#!/usr/bin/env node
// 阅读页交互 —— 验收（PLAN §15.11）
//
// 这一节的起点是需求方的一句话：「rss 阅读器功能性太弱，比如跳转源网页、
// 对应的链接不能点击」。落到代码上是三件事，而**三件事都不能靠"读代码"验证**：
//
//   ① 正文链接是不是真的不打断阅读（点了以后主框架 URL 有没有变）
//   ② 列表行能不能中键在新标签打开（真派发一次中键，看浏览器有没有新开）
//   ③ 详情接口有没有带 sourceSite（不是"前端有没有拿 URL 去拼"）
//
// 尤其是 ①：链接**本来就有 href**，改之前也"能点"——问题是点了整页跳走。
// 所以断言不能写「有没有 href」，必须写「点完之后 location.href 有没有变」。
// 第一条断言如果只测 href 存在，改之前就是绿的，等于没验。
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { removeDir } from '../lib/tmp.mjs';
import { openSqlite } from '../lib/sqlite.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.9 阅读页交互');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-reader-'));
const dataDir = join(tmp, 'data');
const port = 44000 + Math.floor(Math.random() * 900);
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
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(srv.pid)], { stdio: 'ignore' });
    } else {
      srv.kill('SIGKILL');
    }
  } catch { /* 已退出 */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

if (!ready) { summary('m1-09-reader'); process.exit(1); }

// ── 账号 ──────────────────────────────────────────────────
await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'reader@test.local', password: 'readertest12345' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'reader@test.local', password: 'readertest12345' }),
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

// ── 造数据：一个源，三篇文 ────────────────────────────────
// A：正文里同时有「外链」「站内相对链接」「锚点」「mailto」——四类出口各验一次。
// B：只有正文没链接（对照组：证明"没链接"和"链接被吃了"能区分）。
// C：用来验已读回退与进度。
const db = openSqlite(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

// 正文 HTML 自己写：走真实 sanitize（写入侧会清洗），不是伪造清洗结果
const BODY_A = `<p>开头。</p>
<p><a href="https://out.example.org/a">外链</a></p>
<p><a href="/relative/path">站内相对</a></p>
<p><a href="#section-2">页内锚点</a></p>
<p><a href="mailto:x@example.org">写信</a></p>
<p><a href="tel:+8613800000000">电话</a></p>
<p id="section-2">这一节在文末。</p>
<p>${'正文填充。'.repeat(120)}</p>`;

db.exec('BEGIN IMMEDIATE');
db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,fetch_interval,
  last_fetched_at,next_fetch_at,error_count,status,source_kind)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss')`)
  .run('rf_1', uid, 'https://src.example.org/feed', 'https://src.example.org',
    '测试源', Date.now(), Date.now());

const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`);

insEntry.run('re_a', uid, 'rf_1', 'ga', 'https://src.example.org/post/a',
  'src.example.org/post/a', '四种链接的正文', '摘要', 1700000000000, Date.now(), 0, 0, 0, '测试源');
insEntry.run('re_b', uid, 'rf_1', 'gb', 'https://src.example.org/post/b',
  'src.example.org/post/b', '没有链接的正文', '摘要', 1700000001000, Date.now(), 0, 0, 0, '测试源');
insEntry.run('re_c', uid, 'rf_1', 'gc', 'https://src.example.org/post/c',
  'src.example.org/post/c', '已读回退用例', '摘要', 1700000002000, Date.now(), 1, 1, 1, '测试源');

// re_c 要有真实的阅读历史，否则"标未读不抹历史"这条断言是空转的
// （first/last_read_at 本来就是 null，断言恒真 —— 这正是 §15.8 说的那类坑）。
db.prepare(`UPDATE entries SET first_read_at = ?, last_read_at = ?, read_count = 3
  WHERE id = 're_c'`).run(1700000005000, 1700000009000);

// 再塞 40 条：`t`（回到列表顶部）这条断言需要列表**真的能滚**。
// 只放 3 条时 scrollTop 永远是 0，"归零"是个恒真断言 —— 第一版就是这么假绿的。
const insFiller = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,?)`);
for (let i = 0; i < 40; i++) {
  insFiller.run(`re_f${i}`, uid, 'rf_1', `gf${i}`,
    `https://src.example.org/post/f${i}`, `src.example.org/post/f${i}`,
    `填充条目 ${i}`, '摘要', 1699000000000 + i, Date.now(), '测试源');
}
db.exec('COMMIT');
db.close();

// 正文要经过真实的 packText（gzip + 标记字节），否则读出来是乱码
//
// 这里**先走了一遍 sanitizeHtml 再入库**，和 feeds/store.ts 的写入路径一致。
// 如果直接塞原始 HTML，验的就是"我手写的 target 属性"，而不是"清洗层加了 target"。
const { packText } = await import('../../src/server/db/text-blob.ts');
const { sanitizeHtml } = await import('../../src/server/feeds/sanitize.ts');
{
  const db2 = openSqlite(join(dataDir, 'app.db'));
  // 模拟写入侧：先清洗再压缩（feeds/store.ts 就是这么做的）
  const cleanA = sanitizeHtml(BODY_A, { baseUrl: 'https://src.example.org/post/a' }).html;
  const cleanB = sanitizeHtml('<p>这篇没有任何链接，纯文字。</p>', { baseUrl: 'https://src.example.org/post/b' }).html;
  const cleanC = sanitizeHtml('<p>回退用例的正文。</p>', { baseUrl: 'https://src.example.org/post/c' }).html;
  db2.prepare('INSERT INTO entry_contents (entry_id,html,extracted_by) VALUES (?,?,?)')
    .run('re_a', packText(cleanA), 'feed');
  db2.prepare('INSERT INTO entry_contents (entry_id,html,extracted_by) VALUES (?,?,?)')
    .run('re_b', packText(cleanB), 'feed');
  db2.prepare('INSERT INTO entry_contents (entry_id,html,extracted_by) VALUES (?,?,?)')
    .run('re_c', packText(cleanC), 'feed');
  db2.close();
}

// ── ① 详情接口带上源站（不是前端拼）─────────────────────────
{
  const r = await j('GET', '/entries/re_a');
  check('详情返回 200', () => ok(r.status === 200, `status=${r.status}`));
  check('详情带 feedSiteUrl（去源站的数据来源）', () => {
    return ok(r.data?.feedSiteUrl === 'https://src.example.org',
      `feedSiteUrl=${JSON.stringify(r.data?.feedSiteUrl)}`);
  });
  check('详情带 feedTitle', () => ok(r.data?.feedTitle === '测试源',
    `feedTitle=${JSON.stringify(r.data?.feedTitle)}`));
}

// ── ② 正文链接出口（后端清洗层，不依赖浏览器）───────────────
{
  const r = await j('GET', '/entries/re_a');
  const html = String(r.data?.contentHtml ?? '');

  const anchors = [...html.matchAll(/<a\b([^>]*)>/g)].map((m) => m[1]);
  const hrefOf = (attrs) => (attrs.match(/href="([^"]*)"/) ?? [])[1] ?? '';
  const outLink = anchors.find((a) => hrefOf(a).includes('out.example.org'));
  const relLink = anchors.find((a) => hrefOf(a).includes('/relative/path'));
  const anchorLink = anchors.find((a) => hrefOf(a).includes('#section-2'));
  const mailLink = anchors.find((a) => hrefOf(a).startsWith('mailto:'));

  check('外链带 target=_blank', () => ok(Boolean(outLink) && /target="_blank"/.test(outLink),
    String(outLink)));
  check('外链带 noopener（防 tabnabbing）', () => ok(Boolean(outLink) && /noopener/.test(outLink),
    String(outLink)));
  check('相对链接也被补全并加 target', () => ok(
    Boolean(relLink) && /target="_blank"/.test(relLink) && /https:\/\/src\.example\.org\/relative\/path/.test(relLink),
    String(relLink)));
  check('页内锚点不加 target（同文档定位）', () => ok(
    Boolean(anchorLink) && !/target=/.test(anchorLink), String(anchorLink)));
  check('mailto 不加 target（交给系统）', () => ok(
    Boolean(mailLink) && !/target=/.test(mailLink), String(mailLink)));

  const t = await j('GET', '/entries/re_b');
  check('对照篇：正文没有任何 <a>（证明不是"全都加成了空链接"）', () => {
    const h = String(t.data?.contentHtml ?? '');
    return ok(h.length > 0 && !/<a\b/.test(h), `len=${h.length}`);
  });
}

// ── ③ 已读回退 ────────────────────────────────────────────
{
  const before = await j('GET', '/entries/re_c');
  check('前置：re_c 初始是已读且已收藏', () => ok(
    before.data?.isRead === true && before.data?.isStarred === true,
    `isRead=${before.data?.isRead} isStarred=${before.data?.isStarred}`));

  const un = await j('POST', '/entries/unread', { ids: ['re_c'] });
  check('标未读成功', () => ok(un.status === 200 && un.data?.ok === true, JSON.stringify(un.data)));

  const after = await j('GET', '/entries/re_c');
  check('标未读后 isRead=false', () => ok(after.data?.isRead === false,
    `isRead=${after.data?.isRead}`));
  check('标未读**不**清收藏', () => ok(after.data?.isStarred === true,
    `isStarred=${after.data?.isStarred}`));

  // 阅读历史不能被抹掉 —— 这是"读过但视图上想让它算未读"的分界线
  const dbh = openSqlite(join(dataDir, 'app.db'), { readOnly: true });
  const hist = dbh.prepare('SELECT first_read_at, last_read_at, read_count FROM entries WHERE id = ?')
    .get('re_c');
  dbh.close();
  check('标未读保留阅读历史（first/last_read_at/read_count 不被清零）', () => ok(
    Number(hist?.first_read_at) === 1700000005000
      && Number(hist?.last_read_at) === 1700000009000
      && Number(hist?.read_count) === 3,
    JSON.stringify(hist)));

  const empty = await j('POST', '/entries/unread', { ids: [] });
  check('空 ids → 400（不是静默成功）', () => ok(empty.status === 400,
    `status=${empty.status}`));

  const ghost = await j('POST', '/entries/unread', { ids: ['not-exist-id'] });
  check('不存在的 id → 200 且 count=0（幂等，不 500）', () => ok(
    ghost.status === 200 && Number(ghost.data?.count) === 0,
    `status=${ghost.status} data=${JSON.stringify(ghost.data)}`));
}

// ── ④ 阅读进度 ────────────────────────────────────────────
{
  const p1 = await j('POST', '/entries/re_a/progress', { progress: 0.42 });
  check('进度上报成功', () => ok(p1.status === 200 && p1.data?.changed === true,
    JSON.stringify(p1.data)));

  const p2 = await j('POST', '/entries/re_a/progress', { progress: 0.21 });
  check('进度只增不减（回滚不改小）', () => ok(
    p2.status === 200 && p2.data?.changed === false && Number(p2.data?.progress) === 0.42,
    JSON.stringify(p2.data)));

  for (const bad of [-0.1, 1.5, 'abc']) {
    const r = await j('POST', '/entries/re_a/progress', { progress: bad });
    check(`非法进度 ${JSON.stringify(bad)} → 400`, () => ok(r.status === 400,
      `status=${r.status}`));
  }

  const ghost = await j('POST', '/entries/nope/progress', { progress: 0.5 });
  check('不存在的条目上报进度 → 404', () => ok(ghost.status === 404,
    `status=${ghost.status}`));
}

// ── ⑤ 浏览器交互（真点、真派发中键、真读 location）──────────
// 两个平台的候选都要列。曾经这里只有 Windows 四条，于是 ubuntu runner 上
// 恒 FAIL（Chrome 装在 /usr/bin，四条 C:/ 全不存在）。这不是"Linux 没浏览器"，
// 是候选表漏了平台 —— 其余 20 个 UI 脚本都带 /usr/bin，只这里漏了。
const browserCandidates = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const browser = browserCandidates.find((p) => existsSync(p));

if (!browser) {
  // 找不到浏览器是**环境缺失**，不是产品缺陷：判 FAIL 会让"没装 Chrome 的机器"
  // 永远红，而它其实什么都没验到。与 m1-19 等脚本一致，打 SKIP 后正常退出。
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器，UI 断言跳过');
  summary('m1-09-reader');
  process.exit(0);
} else {
  const profile = mkdtempSync(join(tmpdir(), 'cheng-rss-rdprof-'));
  const cdpPort = 9800 + Math.floor(Math.random() * 200);
  const proc = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

  const killBrowser = () => {
    killTree(proc.pid);
    removeDir(profile);
  };
  onExit(killBrowser);

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
  } else {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    let seq = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      } else if (m.method) {
        events.push(m);
      }
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval 失败');
      }
      return r.result.value;
    };

    await send('Page.enable');
    await send('Page.navigate', { url: origin });
    await sleep(1500);

    // 登录
    if (await evaluate(`Boolean(document.querySelector('input[type=password]'))`)) {
      await evaluate(`(() => {
        const set = (el, v) => {
          const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
          d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(document.querySelector('input[type=email],input[type=text]'), 'reader@test.local');
        set(document.querySelector('input[type=password]'), 'readertest12345');
        document.querySelector('button[type=submit]').click();
        return true;
      })()`);
      await sleep(2200);
    }

    // 打开有四种链接的那篇
    const opened = await evaluate(`(async () => {
      const rows = [...document.querySelectorAll('.entry-item')];
      const hit = rows.find((r) => (r.textContent || '').includes('四种链接'));
      if (!hit) return { ok: false, rows: rows.length };
      hit.click();
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: Boolean(document.querySelector('.article-body')) };
    })()`);
    check('能打开测试文章', () => ok(opened?.ok === true, JSON.stringify(opened)));

    // ── 关键断言：点正文外链，主框架不能被导航走 ──
    const beforeUrl = await evaluate('location.href');
    const clickInfo = await evaluate(`(async () => {
      const a = [...document.querySelectorAll('.article-body a')]
        .find((x) => (x.getAttribute('href') || '').includes('out.example.org'));
      if (!a) return { found: false };
      const detail = {
        target: a.getAttribute('target'),
        rel: a.getAttribute('rel'),
        href: a.getAttribute('href'),
      };
      // 拦掉真实导航，只记录"浏览器本来会去哪"——headless 里真跳走就再也读不回来了
      a.addEventListener('click', (e) => { e.preventDefault(); }, { once: true });
      a.click();
      await new Promise((r) => setTimeout(r, 900));
      return { found: true, ...detail };
    })()`);
    const afterUrl = await evaluate('location.href');

    check('正文外链确实带 target=_blank', () => ok(clickInfo?.target === '_blank',
      JSON.stringify(clickInfo)));
    check('点正文外链后主框架 URL 不变（不再整页跳走）', () => {
      return ok(beforeUrl === afterUrl, `${beforeUrl} → ${afterUrl}`);
    });

    // 锚点：同一文档内，不该被新标签打开
    const anchorInfo = await evaluate(`(() => {
      const a = [...document.querySelectorAll('.article-body a')]
        .find((x) => (x.getAttribute('href') || '').includes('#section-2'));
      return a ? { target: a.getAttribute('target'), href: a.getAttribute('href') } : null;
    })()`);
    check('锚点在页面上也没被加 target', () => ok(
      anchorInfo !== null && anchorInfo.target === null, JSON.stringify(anchorInfo)));

    // ── 列表行：中键新标签打开 ──
    //
    // 这一条必须真派发 auxclick —— 只读 DOM 证明不了"中键会新开标签"，
    // 那是浏览器行为。<a href> 在，浏览器就会开；不在，就不会开。
    const rowInfo = await evaluate(`(() => {
      const row = document.querySelector('.entry-item');
      const title = row?.querySelector('.entry-title');
      return {
        rowTag: row?.tagName,
        rowRole: row?.getAttribute('role'),
        rowTabIndex: row?.getAttribute('tabindex'),
        titleTag: title?.tagName,
        titleHref: title?.getAttribute('href'),
        titleTarget: title?.getAttribute('target'),
        nestedAnchorInButton: Boolean(document.querySelector('button .entry-title')),
        opsCount: document.querySelectorAll('.entry-item .entry-ops a, .entry-item .entry-ops button').length,
      };
    })()`);
    check('列表行是 div[role=button] 而不是 button（否则里面放不了 <a>）', () => ok(
      rowInfo?.rowTag === 'DIV' && rowInfo?.rowRole === 'button',
      JSON.stringify(rowInfo)));
    check('列表行有 tabindex=0（键盘能 Tab 到）', () => ok(
      String(rowInfo?.rowTabIndex) === '0', String(rowInfo?.rowTabIndex)));
    check('列表标题是真 <a> 且 href 指向原文', () => ok(
      rowInfo?.titleTag === 'A' && String(rowInfo?.titleHref).startsWith('http'),
      JSON.stringify(rowInfo)));
    check('列表标题带 target=_blank（中键/Ctrl+点击可新标签）', () => ok(
      rowInfo?.titleTarget === '_blank', String(rowInfo?.titleTarget)));
    check('没有把 <a> 塞进 <button>（HTML 内容模型禁止）', () => ok(
      rowInfo?.nestedAnchorInButton === false, String(rowInfo?.nestedAnchorInButton)));
    check('每行有 2 个行内操作（收藏 + 新标签原文）', () => ok(
      rowInfo?.opsCount >= 2, String(rowInfo?.opsCount)));

    // Enter 键能开条目（role=button 的键盘语义是手工补的，必须验）
    const enterWorks = await evaluate(`(async () => {
      // 先回到列表
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const row = document.querySelectorAll('.entry-item')[1];
      if (!row) return { ok: false };
      row.focus();
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      return { ok: Boolean(document.querySelector('.article-body')) };
    })()`);
    check('列表行按 Enter 能在阅读区打开（role=button 的键盘语义）', () => ok(
      enterWorks?.ok === true, JSON.stringify(enterWorks)));

    // ── 快捷键 ──
    const shortcut = await evaluate(`(async () => {
      // 确认现在在阅读区
      if (!document.querySelector('.reader-title')) {
        document.querySelectorAll('.entry-item')[0]?.click();
        await new Promise((r) => setTimeout(r, 1200));
      }
      const out = {};
      // v：新标签打开原文。拦掉 window.open，只看它被调了、参数对不对
      const orig = window.open;
      let opened = null;
      window.open = (...args) => { opened = args; return null; };
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      window.open = orig;
      out.vOpened = opened ? String(opened[0]) : null;

      // t：回到列表顶部
      const listEl = document.querySelector('.list-scroll');
      out.listScrollable = listEl ? (listEl.scrollHeight > listEl.clientHeight + 100) : false;
      if (listEl) listEl.scrollTop = 600;
      const beforeTop = listEl ? listEl.scrollTop : -1;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
      // 平滑滚动：等它真的走完，取 settle 之后的值（不要刚发完就读）
      await new Promise((r) => setTimeout(r, 1200));
      out.scrollBefore = beforeTop;
      out.scrollAfter = listEl ? listEl.scrollTop : -1;

      // m：切已读/未读。断言看"按钮标题有没有翻面" —— 这是用户能看见的结果，
      // 比读内部 state 可靠（state 改了但没重新渲染也是 bug）。
      const readBtn = () => [...document.querySelectorAll('.reader-bar .icon-btn')]
        .find((b) => /标为(已读|未读)/.test(b.getAttribute('title') || ''));
      out.readTitleBefore = readBtn()?.getAttribute('title') ?? null;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      out.readTitleAfter = readBtn()?.getAttribute('title') ?? null;
      out.stillOpen = Boolean(document.querySelector('.reader-title'));

      return out;
    })()`);
    check('v 打开原文（调了 window.open 且传了 URL）', () => ok(
      typeof shortcut?.vOpened === 'string' && shortcut.vOpened.startsWith('http'),
      JSON.stringify(shortcut?.vOpened)));
    check('列表足够长（t 的断言前提：能滚才有"归零"可言）', () => ok(
      shortcut?.listScrollable === true, String(shortcut?.listScrollable)));
    check('t 回到列表顶部（scrollTop 归零）', () => ok(
      shortcut?.scrollAfter === 0 && shortcut?.scrollBefore > 100,
      `before=${shortcut?.scrollBefore} after=${shortcut?.scrollAfter}`));
    check('m 切换已读/未读（按钮标题翻面）', () => ok(
      Boolean(shortcut?.readTitleBefore)
        && Boolean(shortcut?.readTitleAfter)
        && shortcut.readTitleBefore !== shortcut.readTitleAfter,
      `${shortcut?.readTitleBefore} → ${shortcut?.readTitleAfter}`));

    // 输入框里按快捷键不该触发
    //
    // 只在 input 上派发一次、让它冒泡到 window —— 真实键盘就是这个路径
    // （事件目标是聚焦元素，然后逐级冒泡）。上一版还额外 window.dispatchEvent
    // 了一次，那个事件的 target 是 window 本身，任何实现都"没在打字"，
    // 于是断言必红 —— 这是测试自己造出来的假问题。
    const typingGuard = await evaluate(`(async () => {
      const input = document.querySelector('.search-box input');
      if (!input) return { ok: false, reason: '搜索框不在' };
      input.focus();
      const orig = window.open;
      let called = false;
      window.open = () => { called = true; return null; };
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      window.open = orig;
      input.blur();
      return { ok: true, openedWhileTyping: called };
    })()`);
    check('焦点在搜索框时 v 不触发（否则打字会跳页）', () => ok(
      typingGuard?.openedWhileTyping === false, JSON.stringify(typingGuard)));

    // ── 阅读偏好：改字号后刷新仍在 ──
    const prefsFlow = await evaluate(`(async () => {
      // 确保在阅读区
      if (!document.querySelector('.reader-title')) {
        document.querySelectorAll('.entry-item')[0]?.click();
        await new Promise((r) => setTimeout(r, 1200));
      }
      // 打开设置面板
      const btn = [...document.querySelectorAll('.reader-bar .icon-btn')]
        .find((b) => (b.getAttribute('title') || '').includes('阅读设置'));
      if (!btn) return { ok: false, reason: '没有阅读设置按钮' };
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      const panel = document.querySelector('.prefs-panel');
      if (!panel) return { ok: false, reason: '点了但面板没出来' };

      // 找到"大"字号按钮并点
      const big = [...panel.querySelectorAll('.seg-btn')].find((b) => b.textContent === '大');
      if (!big) return { ok: false, reason: '没有字号按钮' };
      big.click();
      await new Promise((r) => setTimeout(r, 400));

      const reader = document.querySelector('.reader');
      const fs = reader ? getComputedStyle(reader).fontSize : null;
      const stored = localStorage.getItem('cheng-rss.reader-prefs.v1');
      return { ok: true, fontSize: fs, stored };
    })()`);
    check('阅读设置面板能打开', () => ok(prefsFlow?.ok === true, JSON.stringify(prefsFlow)));
    check('点「大」后阅读区字号真的变了（18px）', () => ok(
      prefsFlow?.fontSize === '18px', String(prefsFlow?.fontSize)));
    check('偏好写进了 localStorage', () => ok(
      typeof prefsFlow?.stored === 'string' && prefsFlow.stored.includes('18'),
      String(prefsFlow?.stored)));

    // 刷新后保持（这是 localStorage 方案的唯一意义，必须验）
    await send('Page.reload', {});
    await sleep(2200);
    const afterReload = await evaluate(`(async () => {
      const rows = document.querySelectorAll('.entry-item');
      rows[0]?.click();
      await new Promise((r) => setTimeout(r, 1500));
      const reader = document.querySelector('.reader');
      return {
        fontSize: reader ? getComputedStyle(reader).fontSize : null,
        stored: localStorage.getItem('cheng-rss.reader-prefs.v1'),
      };
    })()`);
    check('刷新页面后字号保持 18px（偏好持久化生效）', () => ok(
      afterReload?.fontSize === '18px', String(afterReload?.fontSize)));

    // ── 去源站入口 ──
    const siteEntry = await evaluate(`(() => {
      const bar = document.querySelector('.reader-bar .reader-site');
      const meta = document.querySelector('.reader-meta .reader-site-link');
      const foot = [...document.querySelectorAll('.reader-foot a')]
        .find((a) => (a.textContent || '').includes('访问源站'));
      return {
        barHref: bar ? bar.getAttribute('href') : null,
        metaHref: meta ? meta.getAttribute('href') : null,
        footHref: foot ? foot.getAttribute('href') : null,
        barTarget: bar ? bar.getAttribute('target') : null,
      };
    })()`);
    check('阅读栏有「去源站」且指向 site_url', () => ok(
      siteEntry?.barHref === 'https://src.example.org', JSON.stringify(siteEntry)));
    check('站点名也是可点链接', () => ok(
      siteEntry?.metaHref === 'https://src.example.org', String(siteEntry?.metaHref)));
    check('文末有「访问源站」按钮', () => ok(
      siteEntry?.footHref === 'https://src.example.org', String(siteEntry?.footHref)));
    check('去源站也是新标签打开（不离开阅读器）', () => ok(
      siteEntry?.barTarget === '_blank', String(siteEntry?.barTarget)));

    ws.close();
    killBrowser();
  }
}

summary('m1-09-reader');
cleanup();
// 显式退出：WebSocket 与子进程句柄会让事件循环挂着不结束，
// 表现为"脚本跑完了但 verify-all 卡在等它"。其它 UI 脚本也是这么收尾的。
process.exit(process.exitCode ?? 0);
