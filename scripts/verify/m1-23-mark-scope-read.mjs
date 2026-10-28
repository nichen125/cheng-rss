#!/usr/bin/env node
// 分组 / 单源的未读清零 —— 验收（PLAN §15.21，需求表第 23 行）
//
// 需求方原话：「缺少清除分组未读、单个订阅所有未读等功能」。
//
// 这个功能的每一个断言都围绕"**范围不能错**"和"**不能伪造阅读记录**"：
//
//   ① 按源清 → 只有那个源的未读变已读，同一分组里别的源一动不动。
//      只断言"未读变成 0"是不够的：把全库都标已读同样能让它变 0。
//   ② 按分组清 → 组内所有源的未读都清空，组外的源一动不动。
//   ③ 不带范围的请求必须 400 —— 这是产品的边界，不是参数校验的副产品。
//      少这条断言，一个"没传范围就清全库"的实现会悄悄上线。
//   ④ **不写阅读历史**：first_read_at / last_read_at / read_count 全都不动。
//      这是本接口与 POST /entries/read 的全部区别，不测这一条，
//      两个接口就没有区别 —— 「历史」页会凭空多出几百条没打开过的文章。
//   ⑤ 重复条目不算：duplicate_of 非空的本来就看不见，不该被这个动作用来
//      刷高"已读"计数。
//   ⑥ UI：按钮只在有范围且有未读时出现；点它要确认；确认后三处角标归零。
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
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

group('1.23 分组 / 单源未读清零');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-markall-'));
const dataDir = join(tmp, 'data');
const port = 51000 + Math.floor(Math.random() * 900);
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
if (!ready) { cleanup(); summary('m1-23-mark-scope-read'); process.exit(1); }

await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ma@test.local', password: 'matest1234567' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ma@test.local', password: 'matest1234567' }),
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
// 甲组 4 个源 × 3 条 = 12 条（每源 2 未读 + 1 已读）
// 乙组 1 个源 × 2 条 = 2 条（都未读）
// 未分组 1 个源 × 2 条 = 2 条（都未读）
// 合计 16 条、12 条未读。
//
// 「每个源都有 2 条未读」是刻意的：按源清之后如果同一组另一个源也掉了，
// 立刻能看见。全部源未读数相同 —— 任何一个"多清了一个"的 bug 都会被抓到。
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
const now = Date.now();
const insFolder = db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)');
insFolder.run('ma_g1', uid, '甲组', 0);
insFolder.run('ma_g2', uid, '乙组', 1);

const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?)`);
for (let i = 1; i <= 4; i++) {
  insFeed.run(`ma_f${i}`, uid, `https://a${i}.example.com/feed`, `https://a${i}.example.com`,
    `甲源${i}`, now, now, 'ma_g1');
}
insFeed.run('ma_f5', uid, 'https://b1.example.com/feed', 'https://b1.example.com',
  '乙源', now, now, 'ma_g2');
insFeed.run('ma_f6', uid, 'https://n1.example.com/feed', null, '未分组源', now, now, null);

const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,?)`);
const insDup = db.prepare(`UPDATE entries SET duplicate_of = ? WHERE id = ?`);

let seq = 0;
const mk = (feedId, read) => {
  seq++;
  insEntry.run(`ma_e${seq}`, uid, feedId, `g${seq}`, `https://e.example.com/${seq}`,
    `e.example.com/${seq}`, `${read ? '已读' : '未读'}条目 ${seq}`, '摘要',
    now - seq * 60000, now, read ? 1 : 0, '测试源');
  return `ma_e${seq}`;
};
for (let i = 1; i <= 4; i++) {
  mk(`ma_f${i}`, false); mk(`ma_f${i}`, false); mk(`ma_f${i}`, true);
}
mk('ma_f5', false); mk('ma_f5', false);
mk('ma_f6', false); mk('ma_f6', false);

// 一条重复条目：它挂在甲源1下面但 duplicate_of 指向别处。
// 时间线里看不见它，标已读也不该把它算进 count。
const dupId = mk('ma_f1', false);
insDup.run('ma_e1', dupId);

db.exec('COMMIT');

const stat = () => {
  const d = new DatabaseSync(join(dataDir, 'app.db'), { readOnly: true });
  try {
    const one = (sql, ...p) => d.prepare(sql).get(...p);
    // byFeed 必须**现在**就把数字取出来，不能返回一个稍后执行的闭包 ——
    // finally 里会 close()，闭包里那个 `d` 已经关了。第一版写成
    // `byFeed: (id) => Number(one(..., id).c)`，于是每一条断言都报
    // “database is not open”，而它看起来像"清了但查不到"。
    const byFeed = {};
    for (const r of d.prepare(`SELECT feed_id AS id, COUNT(*) AS c FROM entries
        WHERE is_read = 0 AND duplicate_of IS NULL GROUP BY feed_id`).all()) {
      byFeed[r.id] = Number(r.c);
    }
    return {
      total: Number(one('SELECT COUNT(*) c FROM entries').c),
      unread: Number(one('SELECT COUNT(*) c FROM entries WHERE is_read = 0').c),
      unreadVisible: Number(one(
        'SELECT COUNT(*) c FROM entries WHERE is_read = 0 AND duplicate_of IS NULL').c),
      byFeed: (id) => byFeed[id] ?? 0,
      history: Number(one(
        'SELECT COUNT(*) c FROM entries WHERE first_read_at IS NOT NULL').c),
      readCountSum: Number(one('SELECT COALESCE(SUM(read_count),0) c FROM entries').c),
      dupUnread: Number(one(
        'SELECT COUNT(*) c FROM entries WHERE is_read = 0 AND duplicate_of IS NOT NULL').c),
    };
  } finally { d.close(); }
};

const s0 = stat();
check('（数据自检）16 条，可见未读 12，重复条目未读 1', () => ok(
  s0.total === 17 && s0.unreadVisible === 12 && s0.dupUnread === 1,
  `total=${s0.total} unreadVisible=${s0.unreadVisible} dupUnread=${s0.dupUnread}`,
));

// ═══ ③ 不带范围必须 400（先测，避免"清全库"的实现把后面的数据毁了）═══
const noScope = await j('POST', '/entries/mark-all-read', {});
check('③ 不带 feedId / folderId → 400（不提供"清全库"入口）', () =>
  eq(noScope.status, 400, JSON.stringify(noScope)));
const stillUnread = stat().unreadVisible;
check('③ 被拒之后一条都没被改（400 不是"先清了再报错"）', () =>
  eq(stillUnread, 12));

// ═══ ① 按单个源清 ═════════════════════════════════════════
const oneFeed = await j('POST', '/entries/mark-all-read', { feedId: 'ma_f1' });
check('① 按源清返回 count = 2（该源正好 2 条未读）', () =>
  eq(Number(oneFeed.data?.count), 2, JSON.stringify(oneFeed.data)));

const s1 = stat();
check('① 该源未读归零', () => eq(s1.byFeed('ma_f1'), 0));
check('① 同组其他源一条都没动（仍是各自 2 条）', () => ok(
  [2, 3, 4].every((i) => s1.byFeed(`ma_f${i}`) === 2),
  `f2=${s1.byFeed('ma_f2')} f3=${s1.byFeed('ma_f3')} f4=${s1.byFeed('ma_f4')}`,
));
check('① 组外的源也没被波及', () => ok(
  s1.byFeed('ma_f5') === 2 && s1.byFeed('ma_f6') === 2,
  `f5=${s1.byFeed('ma_f5')} f6=${s1.byFeed('ma_f6')}`,
));
check('① 全库可见未读从 12 减到 10（正好少 2）', () => eq(s1.unreadVisible, 10));

// ═══ ④ 不写阅读历史（本接口与 /entries/read 的全部区别）═══
check('④ 一次阅读历史都没写（first_read_at 全空）', () =>
  eq(s1.history, 0, `history=${s1.history}`));
check('④ read_count 之和仍是 0（没被当成"读过一次"）', () =>
  eq(s1.readCountSum, 0, `sum=${s1.readCountSum}`));

// ═══ ⑤ 重复条目不算进 count，也不被标已读 ══════════════════
check('⑤ 重复条目仍是未读（它本来就不在时间线里）', () =>
  ok(stat().dupUnread >= 1, `dupUnread=${stat().dupUnread}`));

// ═══ ② 按分组清 ═══════════════════════════════════════════
const groupClear = await j('POST', '/entries/mark-all-read', { folderId: 'ma_g1' });
check('② 按分组清返回 count = 6（甲组剩 3 个源 × 2 条）', () =>
  eq(Number(groupClear.data?.count), 6, JSON.stringify(groupClear.data)));

const s2 = stat();
check('② 甲组四个源全部归零', () => ok(
  [1, 2, 3, 4].every((i) => s2.byFeed(`ma_f${i}`) === 0),
  [1, 2, 3, 4].map((i) => `f${i}=${s2.byFeed(`ma_f${i}`)}`).join(' '),
));
check('② 乙组与未分组完全没被波及（仍各 2 条）', () => ok(
  s2.byFeed('ma_f5') === 2 && s2.byFeed('ma_f6') === 2,
  `f5=${s2.byFeed('ma_f5')} f6=${s2.byFeed('ma_f6')}`,
));
check('② 全库可见未读剩 4（乙组 2 + 未分组 2）', () => eq(s2.unreadVisible, 4));

// ═══ ⓐ 幂等：再清一次是 0 条，不是负增长也不是 500 ═════════
const again = await j('POST', '/entries/mark-all-read', { folderId: 'ma_g1' });
check('ⓐ 已经清空的分组再清一次 → count=0（幂等）', () =>
  ok(again.status === 200 && Number(again.data?.count) === 0, JSON.stringify(again.data)));
check('ⓐ 幂等调用没有改动任何数据', () => eq(stat().unreadVisible, 4));

// ═══ ⓑ 不存在的范围 → 0 条且 200（不是 500）════════════════
const ghost = await j('POST', '/entries/mark-all-read', { feedId: 'f_does_not_exist' });
check('ⓑ 不存在的源 → 200 且 count=0（不是 500）', () =>
  ok(ghost.status === 200 && Number(ghost.data?.count) === 0, JSON.stringify(ghost)));
const ghostFolder = await j('POST', '/entries/mark-all-read', { folderId: 'g_nope' });
check('ⓑ 不存在的分组 → 200 且 count=0', () =>
  ok(ghostFolder.status === 200 && Number(ghostFolder.data?.count) === 0,
    JSON.stringify(ghostFolder)));

// ═══ ⑥ UI：按钮的存在条件 + 确认 + 三处角标 ═════════════════
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
  summary('m1-23-mark-scope-read');
  cleanup();
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'ai-rss-markall-prof-'));
const cdpPort = 10000 + Math.floor(Math.random() * 80);
const proc = spawn(browserPath, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,950', 'about:blank',
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
  summary('m1-23-mark-scope-read');
  cleanup();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let dseq = 0;
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
  const id = ++dseq;
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
await send('Network.setCookie', {
  name: 'ai_rss_sid', value: cookie.split('=')[1] ?? '',
  domain: '127.0.0.1', path: '/',
});
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 950, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: origin });
for (let i = 0; i < 80; i++) {
  if (await ev('document.readyState === "complete"').catch(() => false)) break;
  await sleep(150);
}
await sleep(2200);

const SNAP = `(() => {
  const num = (t) => { const m = /(\\d+)/.exec(t || ''); return m ? Number(m[1]) : null; };
  const navUnread = [...document.querySelectorAll('.nav-item')]
    .find((b) => (b.textContent || '').replace(/\\d+/g, '').trim() === '未读');
  return {
    title: (document.querySelector('.pane-title h1')?.textContent ?? '').trim(),
    count: (document.querySelector('.pane-count')?.textContent ?? '').trim(),
    markBtn: Boolean(document.querySelector('.mark-read-btn')),
    clearBtn: Boolean(document.querySelector('.scope-clear')),
    segOn: [...document.querySelectorAll('.pane-seg .seg-btn')]
      .filter((b) => b.className.includes('on')).map((b) => (b.textContent || '').trim()),
    navUnread: navUnread ? num(navUnread.querySelector('.badge')?.textContent ?? '') ?? 0 : null,
    rows: [...document.querySelectorAll('.tree-row')].map((b) => ({
      name: (b.querySelector('.nav-label')?.textContent ?? '').trim(),
      badge: num(b.querySelector('.badge')?.textContent ?? '') ?? 0,
    })),
    leaves: [...document.querySelectorAll('.tree-leaf')].map((b) => ({
      name: (b.querySelector('.tree-leaf-name')?.textContent ?? '').trim(),
      count: num(b.querySelector('.tree-leaf-count')?.textContent ?? ''),
    })),
  };
})()`;
const snap = async () => ev(SNAP);

// 先展开甲组（还有 0 条未读？上面的接口调用已经把甲组清空了）。
// 换个思路：用没被清过的「未分组源」来测 UI —— 它还有 2 条未读。
// 未分组源不在任何分组里，侧栏没有它的行，只能从列表本身进。
// 所以这里改从「账号/订阅」之外的地方验证：直接看全库视图的按钮存在性。
const cold = await snap();
check('⑥ 全库视图（无范围）下不出现「清除未读」按钮', () => ok(
  cold.markBtn === false, `markBtn=${cold.markBtn}`,
));
check('⑥ 全库视图下也不出现「清除范围」×（本来就没范围）', () => ok(
  cold.clearBtn === false, `clearBtn=${cold.clearBtn}`,
));

// 进乙组：还有 2 条未读 → 按钮该出现
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
await clickGroup('乙组');
const inGroup = await snap();
check('⑥ 进有未读的分组 → 出现「清除未读」按钮和 × ', () => ok(
  inGroup.markBtn === true && inGroup.clearBtn === true,
  `markBtn=${inGroup.markBtn} clearBtn=${inGroup.clearBtn}`,
));

// 点它：确认框必须弹（用 CDP 覆盖 window.confirm 记录调用而不是真的弹窗）
const confirmProbe = await ev(`(() => {
  window.__confirmCalls = [];
  const orig = window.confirm;
  window.confirm = (msg) => { window.__confirmCalls.push(String(msg)); return false; };
  const b = document.querySelector('.mark-read-btn');
  if (!b) return { clicked: false };
  b.click();
  return { clicked: true };
})()`);
check('⑥ 能点中「清除未读」按钮', () =>
  ok(confirmProbe?.clicked === true, JSON.stringify(confirmProbe)));
await sleep(600);
const confirmInfo = await ev('window.__confirmCalls ?? []');
check('⑥ 点按钮先弹确认框（不是点一下就清）', () =>
  ok(confirmInfo.length === 1, JSON.stringify(confirmInfo)));
check('⑥ 确认文案里写明了要清多少条（2）', () =>
  ok(/\b2\b/.test(confirmInfo[0] ?? ''), JSON.stringify(confirmInfo[0])));
check('⑥ 取消之后一条都没被改（仍是 2 条未读）', () => {
  const d = new DatabaseSync(join(dataDir, 'app.db'), { readOnly: true });
  try {
    const c = d.prepare(
      'SELECT COUNT(*) c FROM entries WHERE is_read = 0 AND duplicate_of IS NULL AND feed_id = ?',
    ).get('ma_f5');
    return ok(Number(c.c) === 2, String(c.c));
  } finally { d.close(); }
});

// 现在真的确认：替换成 return true 再点一次
await ev(`(() => {
  window.confirm = () => true;
  return true;
})()`);
await ev(`(() => {
  const b = document.querySelector('.mark-read-btn');
  if (b) b.click();
  return Boolean(b);
})()`);
await sleep(2200);
const afterClear = await snap();
check('⑥ 确认后全库「未读」角标从 4 降到 2', () =>
  ok(afterClear.navUnread === 2, `nav=${afterClear.navUnread}`));
check('⑥ 乙组角标归零', () => {
  const g = afterClear.rows.find((r) => r.name === '乙组');
  return ok(g?.badge === 0, `乙组 badge=${g?.badge}`);
});
check('⑥ 乙组的源子行也归零', () => {
  const l = afterClear.leaves.find((x) => x.name === '乙源');
  return ok(l?.count === 0, `乙源 count=${l?.count}`);
});
check('⑥ 清完之后按钮自己消失（未读 0 时不该还留着）', () =>
  ok(afterClear.markBtn === false, `markBtn=${afterClear.markBtn}`));

// 后端数据也要对上：乙组的 2 条真的已读、甲组/未分组没被波及
check('⑥ 数据库侧：乙源未读 2 → 0', () => eq(stat().byFeed('ma_f5'), 0));
check('⑥ 数据库侧：未分组源仍是 2 条未读（分组操作不许越界）', () =>
  eq(stat().byFeed('ma_f6'), 2));

ws.close();
killBrowser();
summary('m1-23-mark-scope-read');
cleanup();
process.exit(process.exitCode ?? 0);
