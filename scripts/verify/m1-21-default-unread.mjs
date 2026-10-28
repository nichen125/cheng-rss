#!/usr/bin/env node
// 默认只看未读 —— 验收（PLAN §15.19，需求表第 21 行）
//
// 需求方原话：「记得默认进去查看的都是未读数据，只有点击全部才会显示全部数据」。
//
// 这一条改的是一个**初值**，所以最容易假绿的地方全在"初值"周围：
//
//   ① 只看界面"未读"两个字亮着是不够的 —— 如果实现是"先拉全部、前端再过滤"，
//      界面完全一样，但 10 万条库上要多传几十页，分页游标也会错位。
//      所以必须**在请求层面**断言冷启动那次请求的 URL 里就有 view=unread。
//   ② 只看列表"没有已读条目"也不够 —— 可能真的是全库恰好都未读（空转）。
//      所以要先从外部造出已读条目，再断言它不在默认列表里。
//   ③ "侧栏高亮一致"要同时断言「未读亮」和「收件箱不亮」。只断言前者的话，
//      两处都亮着（状态矛盾）也能通过。
//   ④ "刷新后回到未读"这条抓的是"把上次选择存进 localStorage"的实现 ——
//      那种实现用户体验上是"我以为默认改了，结果它记住了我上次点全部"。
//
// 判据（对应 §19.3 的 1.21 行）：
//   ① 首次进入：「未读」激活、「全部」不激活，列表里没有已读条目
//   ② 侧栏「未读」高亮、「收件箱」不亮（状态一致，不是两处都亮）
//   ③ 点「全部」后已读条目出现，侧栏高亮转到「收件箱」
//   ④ 刷新页面后回到「未读」（默认状态不持久化）
//   ⑤ 从分组 / 单个源进入时也只看未读
//   ⑥ 「全部」条数 ≥ 「未读」条数，差值 = 该范围内已读数
//   ⑦ 冷启动那次请求的 URL 就带 view=unread（不是先拉全部再前端过滤）
//   ⑧ 手机上底部导航「未读」同样高亮
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

group('1.21 默认只看未读');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-unread-'));
const dataDir = join(tmp, 'data');
const port = 49000 + Math.floor(Math.random() * 900);
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
if (!ready) { cleanup(); summary('m1-21-default-unread'); process.exit(1); }

await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'def@test.local', password: 'deftest1234567' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'def@test.local', password: 'deftest1234567' }),
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
// 两个分组，共 12 条：8 条已读、4 条未读。
//   · 分组 df_g1「甲组」：4 条（3 已读 + 1 未读）
//   · 分组 df_g2「乙组」：5 条（4 已读 + 1 未读）
//   · 未分组：3 条（1 已读 + 2 未读）
// 已读占多数正是这条需求要解决的问题 —— 默认给"混着的 12 条"，
// 用户第一屏几乎全是读过的。
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
const now = Date.now();
db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,0)')
  .run('df_g1', uid, '甲组');
db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,1)')
  .run('df_g2', uid, '乙组');

const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?)`);
insFeed.run('df_f1', uid, 'https://g1.example.com/feed', 'https://g1.example.com', '甲组源', now, now, 'df_g1');
insFeed.run('df_f2', uid, 'https://g2.example.com/feed', 'https://g2.example.com', '乙组源', now, now, 'df_g2');
insFeed.run('df_f3', uid, 'https://n1.example.com/feed', null, '未分组源', now, now, null);

const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,?)`);

// [feedId, 已读?, 序号]
const plan = [
  ['df_f1', true, 1], ['df_f1', true, 2], ['df_f1', true, 3], ['df_f1', false, 4],
  ['df_f2', true, 5], ['df_f2', true, 6], ['df_f2', true, 7], ['df_f2', true, 8], ['df_f2', false, 9],
  ['df_f3', true, 10], ['df_f3', false, 11], ['df_f3', false, 12],
];
plan.forEach(([feed, read, n], i) => {
  insEntry.run(`df_e${n}`, uid, feed, `g${n}`, `https://e.example.com/${n}`, `e.example.com/${n}`,
    `${read ? '已读' : '未读'}条目 ${n}`, '摘要',
    now - i * 60000, now, read ? 1 : 0, '测试源');
});
db.exec('COMMIT');
const totalRows = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
const readRows = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE is_read = 1').get().n;
db.close();

const WANT_TOTAL = plan.length;                       // 12
const WANT_READ = plan.filter(([, r]) => r).length;   // 8
const WANT_UNREAD = WANT_TOTAL - WANT_READ;           // 4
check('（数据自检）库里 12 条，其中已读 8、未读 4',
  () => ok(totalRows === WANT_TOTAL && readRows === WANT_READ
    && WANT_UNREAD === 4, `总 ${totalRows} 已读 ${readRows}`));

// ── 浏览器 ────────────────────────────────────────────────
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
  summary('m1-21-default-unread');
  cleanup();
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'ai-rss-unread-prof-'));
const cdpPort = 9820 + Math.floor(Math.random() * 60);
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
  summary('m1-21-default-unread');
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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
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
await send('Network.setCookie', {
  name: 'ai_rss_sid', value: cookie.split('=')[1] ?? '',
  domain: '127.0.0.1', path: '/',
});

/** 装一个 fetch 记录器。**必须在首次导航之前装** —— 冷启动那次请求是
 *  这条验证的核心，装晚了就录不到。 */
const installProbe = async () => {
  // Page.addScriptToEvaluateOnNewDocument 才能在页面脚本跑之前注入
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__probe = { calls: [] };
      const orig = window.fetch;
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.includes('/entries?') || url.endsWith('/entries')) {
            window.__probe.calls.push(url);
          }
        } catch { /* 记录失败不影响请求 */ }
        return orig(input, init);
      };
    })();`,
  });
};

const SNAPSHOT = `(() => {
  const segBtns = [...document.querySelectorAll('.pane-seg .seg-btn')];
  const nav = [...document.querySelectorAll('.nav-item')].map((b) => ({
    label: (b.textContent || '').replace(/\\d+/g, '').trim(),
    active: b.className.includes('active'),
  }));
  const rows = [...document.querySelectorAll('.entry-item')].map((r) => ({
    title: (r.querySelector('.entry-title')?.textContent ?? '').trim(),
    read: r.className.includes('read'),
  }));
  return {
    segOn: segBtns.filter((b) => b.className.includes('on')).map((b) => (b.textContent || '').trim()),
    segAria: Object.fromEntries(segBtns.map((b) => [(b.textContent || '').trim(), b.getAttribute('aria-pressed')])),
    navUnread: nav.some((n) => n.label === '未读' && n.active),
    navInbox: nav.some((n) => n.label === '收件箱' && n.active),
    groupActive: [...document.querySelectorAll('.tree-row')]
      .some((b) => b.className.includes('active')),
    rows,
    count: (document.querySelector('.pane-count')?.textContent ?? '').trim(),
    title: (document.querySelector('.pane-title h1')?.textContent ?? '').trim(),
    calls: (window.__probe?.calls ?? []).slice(),
  };
})()`;

const snapshot = async () => ev(SNAPSHOT);

const clickSeg = async (label) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.pane-seg .seg-btn')]
      .find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1300);
  return r;
};

const clickNav = async (label) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.nav-item')]
      .find((x) => (x.textContent || '').replace(/\\d+/g, '').trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1400);
  return r;
};

const clickGroup = async (name) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.tree-row')]
      .find((x) => (x.textContent || '').includes(${JSON.stringify(name)}));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1500);
  return r;
};

// ═══ ⑦ 冷启动那次请求就带 view=unread ═════════════════════
//
// 先注入记录器，再**第一次**导航。这一步是所有断言里最不容易假绿的：
// 它看的是网络层，界面长什么样都骗不过去。
await installProbe();
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 950, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: origin });
for (let i = 0; i < 80; i++) {
  if (await ev('document.readyState === "complete"').catch(() => false)) break;
  await sleep(150);
}
await sleep(2000);
const first = await snapshot();

check('⑦ 冷启动那次 /entries 请求的 URL 里就有 view=unread（不是先拉全部再过滤）', () => {
  const firstEntryCall = first.calls[0] ?? '';
  return ok(firstEntryCall.includes('view=unread'),
    `第一次请求：${firstEntryCall || '(没录到)'}`);
});
check('⑦ 冷启动只请求了一次条目列表（不是"先全部再未读"两次）', () => {
  return ok(first.calls.length === 1, `录到 ${first.calls.length} 次：${JSON.stringify(first.calls)}`);
});

// ═══ ① 首次进入：未读激活，列表无已读 ═════════════════════
check('① 分段控件「未读」激活、「全部」不激活', () => {
  return ok(first.segOn.length === 1 && first.segOn[0] === '未读',
    `segOn=${JSON.stringify(first.segOn)}`);
});
check('① aria-pressed 也一致（未读 true / 全部 false）', () => {
  return ok(first.segAria['未读'] === 'true' && first.segAria['全部'] === 'false',
    JSON.stringify(first.segAria));
});
check('① 默认列表里一条已读都没有（逐条判）', () => {
  const bad = first.rows.filter((r) => r.read);
  return ok(first.rows.length > 0 && bad.length === 0,
    `${first.rows.length} 条，混进已读 ${bad.length} 条：${JSON.stringify(bad.map((x) => x.title))}`);
});
check('① 默认列表恰好是那 4 条未读（不多不少）', () => {
  const want = plan.filter(([, r]) => !r).map(([, , n]) => `未读条目 ${n}`);
  const got = first.rows.map((r) => r.title);
  const missing = want.filter((w) => !got.includes(w));
  const extra = got.filter((g) => !want.includes(g));
  return ok(missing.length === 0 && extra.length === 0,
    `缺 ${JSON.stringify(missing)}，多 ${JSON.stringify(extra)}`);
});
check('① 默认的「N 条」是 4，不是全库 12', () => {
  return ok(/^4 条/.test(first.count), JSON.stringify(first.count));
});

// ═══ ② 侧栏状态一致 ═══════════════════════════════════════
check('② 侧栏「未读」高亮', () => {
  return ok(first.navUnread === true, `navUnread=${first.navUnread}`);
});
check('② 侧栏「收件箱」不亮（两处不能同时说自己是当前范围）', () => {
  return ok(first.navInbox === false, `navInbox=${first.navInbox}`);
});

// ═══ ③ 点「全部」→ 已读回来，侧栏换高亮 ═══════════════════
const clickedAll = await clickSeg('全部');
check('③ 点「全部」能点中', () => ok(clickedAll === true));
const allView = await snapshot();
check('③ 「全部」放出 12 条（已读 8 条也回来）', () => {
  return ok(allView.rows.length === WANT_TOTAL, `${allView.rows.length} 条`);
});
check('③ 回来的已读条目仍是已读外观（8 条 read）', () => {
  const read = allView.rows.filter((r) => r.read).length;
  return ok(read === WANT_READ, `已读 ${read} 条，期望 ${WANT_READ}`);
});
check('③ 「全部」下侧栏高亮转到「收件箱」', () => {
  return ok(allView.navInbox === true && allView.navUnread === false,
    `navInbox=${allView.navInbox} navUnread=${allView.navUnread}`);
});
check('③ 「全部」的「N 条」是 12', () => {
  return ok(/^12 条/.test(allView.count), JSON.stringify(allView.count));
});

// ═══ ⑥ 条数与差值对得上 ═══════════════════════════════════
check('⑥ 「全部」条数 ≥ 「未读」条数，且差值 = 已读条数', () => {
  const num = (s) => Number((s.match(/\d+/) ?? ['0'])[0]);
  const a = num(allView.count);
  const u = num(first.count);
  return ok(a >= u && a - u === WANT_READ, `全部 ${a} / 未读 ${u} / 已读 ${WANT_READ}`);
});

// ═══ ④ 刷新页面回到「未读」（不持久化）═══════════════════
//
// 现在正处于「全部」。刷新后如果还是「全部」，说明实现把选择存起来了 ——
// 那种实现让"默认未读"变成只生效一次。
await send('Page.reload', {});
await sleep(2600);
const afterReload = await snapshot();
check('④ 在「全部」下刷新页面 → 回到「未读」（默认值不持久化）', () => {
  return ok(afterReload.segOn.length === 1 && afterReload.segOn[0] === '未读'
    && afterReload.navUnread === true,
    `segOn=${JSON.stringify(afterReload.segOn)} navUnread=${afterReload.navUnread}`);
});
check('④ 刷新后列表也真的只有未读（不是只有按钮回到未读）', () => {
  const bad = afterReload.rows.filter((r) => r.read);
  return ok(afterReload.rows.length === WANT_UNREAD && bad.length === 0,
    `${afterReload.rows.length} 条，混进已读 ${bad.length} 条`);
});

// ═══ ⑤ 分组 / 单个源进入时也只看未读 ═════════════════════
const inGroup = await clickGroup('甲组');
check('⑤ 能点进「甲组」分组', () => ok(inGroup === true, '找不到分组行'));
const groupView = await snapshot();
check('⑤ 进分组后仍是「未读」视图（累计切分组就把默认改回全部是 bug）', () => {
  return ok(groupView.segOn.length === 1 && groupView.segOn[0] === '未读',
    `segOn=${JSON.stringify(groupView.segOn)}`);
});
check('⑤ 分组里只有 1 条未读（该组共 4 条、3 条已读）', () => {
  const bad = groupView.rows.filter((r) => r.read);
  return ok(groupView.rows.length === 1 && bad.length === 0,
    `${groupView.rows.length} 条，已读 ${bad.length} 条`);
});
check('⑤ 分组视图下分段控件仍是「未读」（范围换了，读/全部 的筛选没换）', () => {
  return ok(groupView.segOn.length === 1 && groupView.segOn[0] === '未读',
    `segOn=${JSON.stringify(groupView.segOn)}`);
});
check('⑤ 分组视图下侧栏高亮给了「甲组」（v1.13 规则：范围优先于固定视图）', () => {
  // 侧栏只有一个"当前"位置：选了分组就是分组，这时固定视图不该再亮 ——
  // 否则「未读」和「甲组」会同时亮，看起来像点了两个地方。读/全部的
  // 状态由列表头部的分段控件表达，两者分工不同。
  return ok(groupView.navUnread === false && groupView.groupActive === true,
    `navUnread=${groupView.navUnread} groupActive=${groupView.groupActive}`);
});

// 在分组里点「全部」→ 该组 4 条都出来，验证默认值与范围正交
await clickSeg('全部');
const groupAll = await snapshot();
check('⑤ 分组内点「全部」→ 该组 4 条都出来（默认值与范围正交）', () => {
  return ok(groupAll.rows.length === 4 && groupAll.rows.filter((r) => r.read).length === 3,
    `${groupAll.rows.length} 条，已读 ${groupAll.rows.filter((r) => r.read).length} 条`);
});

// 进到单个源：也是只看未读（§15.19 要求默认值作用于所有范围）
//
// 注意这里**不能先收起分组**：.tree-leaf 只在组展开时才存在。
// 上一步点「甲组」已经把这一组展开了，直接点子行即可。
const leafOk = await ev(`(() => {
  const b = [...document.querySelectorAll('.tree-leaf')]
    .find((x) => (x.textContent || '').includes('甲组源'));
  if (!b) return false;
  b.click();
  return true;
})()`);
await sleep(1600);
// 回到「未读」再断言 —— 上一步在分组里点了「全部」，那是**同一个**视图状态，
// 会一直生效；不切回去的话这条断言测的是「全部」，与标题说的不是一回事。
await clickSeg('未读');
const leafView = await snapshot();
check('⑤ 能点进组内的单个源', () => ok(leafOk === true, '找不到 .tree-leaf'));
check('⑤ 单源视图也是只看未读（1 条未读，3 条已读不出现）', () => {
  const bad = leafView.rows.filter((r) => r.read);
  return ok(leafView.rows.length === 1 && bad.length === 0,
    `${leafView.rows.length} 条，已读 ${bad.length} 条`);
});

// ═══ ⑧ 手机上底部导航「未读」同样高亮 ═════════════════════
await send('Emulation.setDeviceMetricsOverride', {
  width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
});
await send('Page.navigate', { url: origin });
await sleep(2800);
const mob = await ev(`(() => {
  const tabs = [...document.querySelectorAll('.tabbar .tab')].map((b) => ({
    label: (b.textContent || '').replace(/\\d+/g, '').trim(),
    active: b.className.includes('active'),
  }));
  const rows = [...document.querySelectorAll('.entry-item')].map((r) => ({
    title: (r.querySelector('.entry-title')?.textContent ?? '').trim(),
    read: r.className.includes('read'),
  }));
  return { tabs, rows, tabbarVisible: Boolean(document.querySelector('.tabbar')) };
})()`);
check('⑧ 375px 下底部导航可见', () => ok(mob.tabbarVisible === true));
check('⑧ 375px 下底部导航「未读」高亮、「收件箱」不亮', () => {
  const unread = mob.tabs.find((t) => t.label === '未读');
  const inbox = mob.tabs.find((t) => t.label === '收件箱');
  return ok(unread?.active === true && inbox?.active === false,
    JSON.stringify(mob.tabs));
});
check('⑧ 375px 下列表也只有未读', () => {
  const bad = mob.rows.filter((r) => r.read);
  return ok(mob.rows.length === WANT_UNREAD && bad.length === 0,
    `${mob.rows.length} 条，混进已读 ${bad.length} 条`);
});

ws.close();
killBrowser();
summary('m1-21-default-unread');
cleanup();
process.exit(process.exitCode ?? 0);
