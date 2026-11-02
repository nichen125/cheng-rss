#!/usr/bin/env node
// 订阅一键批量管理 —— 验收
//
// 为什么这一节必须单独验：批量操作最容易出的问题**全都不会表现为
// "接口报错"**，而是"看起来成功了但数据不对"：
//
//   ① 前端循环调单条接口 → 第 17 个失败后一半在组里一半不在
//   ② 批量删除绕开 deleteFeed → 已读/已收藏的条目被连带删掉（历史丢了）
//   ③ 批量恢复没清 error_count → "恢复了但永远不抓"（退避窗口还没到）
//   ④ 混入不存在的 id → 整体 500 或静默成功，用户不知道少了一个
//   ⑤ 路由顺序错 → "bulk" 被当成 feed id，永远「订阅不存在」
//
// 判据：
//   ① 四个端点各自生效，返回 {requested, done, skipped, missing}
//   ② 空 feedIds / 非数组 → 400（不是静默成功）
//   ③ 混入不存在的 id → 其余照做，missing 报回来
//   ④ 批量删除保留已读/已收藏并解绑，只删未读
//   ⑤ 批量刷新跳过暂停的源
//   ⑥ 超过 500 个 id → 400
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, summary } from './harness.mjs';
import { removeDir } from '../lib/tmp.mjs';


const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.8 订阅一键批量管理');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-bulk-'));
const dataDir = join(tmp, 'data');
const port = 42000 + Math.floor(Math.random() * 900);
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

if (!ready) { summary('m1-08-bulk'); process.exit(1); }

// ── 账号 ──────────────────────────────────────────────────
await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'bulk@test.local', password: 'bulktest12345' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'bulk@test.local', password: 'bulktest12345' }),
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

// ── 造数据：直接写库（批量操作用不到网络）───────────────────
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind)
  VALUES (?,?,?,?,?,NULL,1800,?,?,?,?,'rss')`);
const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`);

// 8 个源：bf_0..bf_7。bf_2 暂停、bf_3 已 broken 且有 error_count
for (let i = 0; i < 8; i++) {
  insFeed.run(
    `bf_${i}`, uid,
    `https://bulk${i}.example.com/feed`, `https://bulk${i}.example.com`,
    `批量源 ${i}`, Date.now(), Date.now(),
    i === 3 ? 3 : 0,
    i === 2 ? 'paused' : (i === 3 ? 'broken' : 'active'),
  );
}
// 每个源 2 条：一条未读、一条已读。删除时未读该没、已读该留。
for (let i = 0; i < 8; i++) {
  insEntry.run(`be_${i}_u`, uid, `bf_${i}`, `g${i}u`,
    `https://bulk${i}.example.com/u`, `bulk${i}.example.com/u`,
    `未读 ${i}`, '摘要', 1700000000000 + i, Date.now(), 0, 0, 0);
  insEntry.run(`be_${i}_r`, uid, `bf_${i}`, `g${i}r`,
    `https://bulk${i}.example.com/r`, `bulk${i}.example.com/r`,
    `已读 ${i}`, '摘要', 1700000000000 + i, Date.now(), 1, 0, 1);
}
// 给 bf_0 一条已收藏但未读的，验证 "已读 OR 已收藏" 两个条件都在
insEntry.run('be_0_s', uid, 'bf_0', 'g0s',
  'https://bulk0.example.com/s', 'bulk0.example.com/s',
  '已收藏未读', '摘要', 1700000000000, Date.now(), 0, 1, 0);
db.exec('COMMIT');
db.close();

const feedCount = async () => (await j('GET', '/feeds')).data.items.length;
const feedIds = async () => (await j('GET', '/feeds')).data.items.map((f) => f.id).sort();
const entryIds = async () => {
  const r = await j('GET', '/entries?limit=200');
  return r.data.items.map((x) => x.id).sort();
};
void feedCount;

// ── ① 批量移入分组 ────────────────────────────────────────
const fld = await j('POST', '/folders', { name: '批量组' });
const folderId = fld.data?.folder?.id;
check('建分组成功', () => ok(fld.status === 201 && Boolean(folderId), `status=${fld.status}`));

const moved = await j('POST', '/feeds/bulk/folder', {
  feedIds: ['bf_0', 'bf_1', 'bf_2'], folderId,
});
check('批量移入返回 done=3', () => {
  return ok(moved.status === 200 && moved.data?.done === 3 && moved.data?.missing?.length === 0,
    JSON.stringify(moved.data));
});
const afterMove = await j('GET', `/feeds?folderId=${folderId}`);
check('三个源真的在组里', () => {
  const ids = afterMove.data.items.map((f) => f.id).sort();
  return ok(JSON.stringify(ids) === JSON.stringify(['bf_0', 'bf_1', 'bf_2']), JSON.stringify(ids));
});

// 移出：folderId=null
const unfiled = await j('POST', '/feeds/bulk/folder', { feedIds: ['bf_1'], folderId: null });
check('folderId=null 表示移出分组', () => {
  return ok(unfiled.data?.done === 1, JSON.stringify(unfiled.data));
});
const stillIn = (await j('GET', `/feeds?folderId=${folderId}`)).data.items.map((f) => f.id).sort();
check('移出后组里只剩两个', () => {
  return ok(JSON.stringify(stillIn) === JSON.stringify(['bf_0', 'bf_2']), JSON.stringify(stillIn));
});

// 移回，后面还要用
await j('POST', '/feeds/bulk/folder', { feedIds: ['bf_1'], folderId });

// ── ② 批量暂停 / 恢复 ─────────────────────────────────────
const paused = await j('POST', '/feeds/bulk/status', {
  feedIds: ['bf_4', 'bf_5'], status: 'paused',
});
check('批量暂停 done=2', () => ok(paused.data?.done === 2, JSON.stringify(paused.data)));
const pausedList = (await j('GET', '/feeds')).data.items.filter((f) => f.status === 'paused').map((f) => f.id).sort();
check('bf_4/bf_5 变成 paused（bf_2 原本就是）', () => {
  return ok(JSON.stringify(pausedList) === JSON.stringify(['bf_2', 'bf_4', 'bf_5']),
    JSON.stringify(pausedList));
});

// 恢复一个 broken 的源：必须同时清 error_count 并让 next_fetch_at 到期，
// 否则"恢复了但永远不抓"——这是最隐蔽的一类 bug。
const resumed = await j('POST', '/feeds/bulk/status', {
  feedIds: ['bf_3'], status: 'active',
});
check('批量恢复 broken 源', () => ok(resumed.data?.done === 1, JSON.stringify(resumed.data)));
const bf3 = (await j('GET', '/feeds')).data.items.find((f) => f.id === 'bf_3');
check('恢复后 status=active', () => ok(bf3?.status === 'active', `status=${bf3?.status}`));
check('恢复后 error_count 清零（否则退避窗口内永远不抓）', () => {
  return ok(bf3?.errorCount === 0, `errorCount=${bf3?.errorCount}`);
});
check('恢复后 next_fetch_at 已到期（不会等退避窗口）', () => {
  return ok(typeof bf3?.nextFetchAt === 'number' && bf3.nextFetchAt <= Date.now() + 1000,
    `nextFetchAt=${bf3?.nextFetchAt} now=${Date.now()}`);
});

// ── ③ 混入不存在的 id ─────────────────────────────────────
const withGhost = await j('POST', '/feeds/bulk/status', {
  feedIds: ['bf_6', 'bf_ghost', 'bf_ghost2'], status: 'paused',
});
check('混入幽灵 id 不整体失败（其余照做）', () => {
  return ok(withGhost.status === 200 && withGhost.data?.done === 1,
    `status=${withGhost.status} data=${JSON.stringify(withGhost.data)}`);
});
check('幽灵 id 通过 missing 报回来（不是静默吞掉）', () => {
  const m = withGhost.data?.missing ?? [];
  return ok(m.length === 2 && m.includes('bf_ghost') && m.includes('bf_ghost2'), JSON.stringify(m));
});
// 先把状态查出来，再断言。不能把 await 写进 check() 的回调里 ——
// 那会让回调变成 async，返回 Promise，而 Promise 恒真（见 harness.mjs）。
const feedsAfterGhost = (await j('GET', '/feeds')).data.items;
check('幽灵 id 不阻断真实的那个（bf_6 确实暂停了）', () => {
  const f = feedsAfterGhost.find((x) => x.id === 'bf_6');
  return ok(f?.status === 'paused', `status=${f?.status}`);
});
await j('POST', '/feeds/bulk/status', { feedIds: ['bf_6'], status: 'active' });

// ── ④ 参数校验 ────────────────────────────────────────────
const empty = await j('POST', '/feeds/bulk/status', { feedIds: [], status: 'paused' });
check('空 feedIds → 400（不是静默成功）', () => ok(empty.status === 400, `status=${empty.status}`));

const notArray = await j('POST', '/feeds/bulk/status', { feedIds: 'bf_0', status: 'paused' });
check('feedIds 不是数组 → 400', () => ok(notArray.status === 400, `status=${notArray.status}`));

const missingIds = await j('POST', '/feeds/bulk/status', { status: 'paused' });
check('完全没带 feedIds → 400', () => ok(missingIds.status === 400, `status=${missingIds.status}`));

const badStatus = await j('POST', '/feeds/bulk/status', { feedIds: ['bf_0'], status: 'broken' });
check('status 只接受 active/paused → 400', () => ok(badStatus.status === 400, `status=${badStatus.status}`));

const badFolder = await j('POST', '/feeds/bulk/folder', { feedIds: ['bf_0'], folderId: 'fo_nope' });
check('移到不存在的分组 → 400', () => ok(badFolder.status === 400, `status=${badFolder.status}`));

const tooMany = await j('POST', '/feeds/bulk/delete', {
  feedIds: Array.from({ length: 501 }, (_, i) => `x_${i}`),
});
check('超过 500 个 id → 400', () => ok(tooMany.status === 400, `status=${tooMany.status}`));

// 重复 id 去重：3 个相同 id 应该算 1 个
const dupIds = await j('POST', '/feeds/bulk/status', {
  feedIds: ['bf_7', 'bf_7', 'bf_7'], status: 'paused',
});
check('重复 id 去重后 requested=1', () => {
  return ok(dupIds.data?.requested === 1 && dupIds.data?.done === 1, JSON.stringify(dupIds.data));
});
await j('POST', '/feeds/bulk/status', { feedIds: ['bf_7'], status: 'active' });

// ── ⑤ 批量刷新跳过暂停的源 ────────────────────────────────
// bf_0 active、bf_2 paused
const refreshed = await j('POST', '/feeds/bulk/refresh', { feedIds: ['bf_0', 'bf_2'] });
check('批量刷新 done=1（暂停的跳过）', () => {
  return ok(refreshed.data?.done === 1, JSON.stringify(refreshed.data));
});
check('批量刷新 skipped=1（并说明是暂停的那个）', () => {
  return ok(refreshed.data?.skipped === 1, JSON.stringify(refreshed.data));
});

// ── ⑥ 批量删除保留已读/已收藏 ─────────────────────────────
const beforeFeeds = await feedIds();
const beforeEntries = await entryIds();
check('删除前 8 个源 / 17 条条目', () => {
  return ok(beforeFeeds.length === 8 && beforeEntries.length === 17,
    `源 ${beforeFeeds.length} 条 ${beforeEntries.length}`);
});

// 删 bf_0：它有 2 条未读（be_0_u 未读、be_0_s 已收藏未读）+ 1 条已读（be_0_r）
const delRes = await j('POST', '/feeds/bulk/delete', { feedIds: ['bf_0', 'bf_1'] });
check('批量删除 done=2', () => ok(delRes.data?.done === 2, JSON.stringify(delRes.data)));

const afterFeeds = await feedIds();
check('删后剩 6 个源', () => ok(afterFeeds.length === 6, `${afterFeeds.length}`));
check('被删的两个源确实不在了', () => {
  return ok(!afterFeeds.includes('bf_0') && !afterFeeds.includes('bf_1'),
    JSON.stringify(afterFeeds));
});

const afterEntries = await entryIds();
// bf_0: 未读 be_0_u 删；已读 be_0_r 留；已收藏未读 be_0_s 留 → 留 2 删 1
// bf_1: 未读 be_1_u 删；已读 be_1_r 留 → 留 1 删 1
// 共删 2 条未读，17 - 2 = 15
check('未读条目随订阅删除（17 → 15）', () => {
  return ok(afterEntries.length === 15, `${beforeEntries.length} → ${afterEntries.length}`);
});
check('已读条目被保留（不是全删）', () => {
  return ok(afterEntries.includes('be_0_r') && afterEntries.includes('be_1_r'),
    JSON.stringify(afterEntries.filter((x) => x.startsWith('be_0') || x.startsWith('be_1'))));
});
check('已收藏但未读的条目也被保留（OR 条件的第二个分支真的生效）', () => {
  return ok(afterEntries.includes('be_0_s'), JSON.stringify(afterEntries.slice(0, 6)));
});
check('纯未读条目确实被删了（证明上面那条不是空转）', () => {
  return ok(!afterEntries.includes('be_0_u') && !afterEntries.includes('be_1_u'),
    '未读条目还在，说明删除没生效');
});

// 保留的条目必须解绑 feed（否则下次删分组/查来源会指向不存在的 feed）
const db2 = new DatabaseSync(join(dataDir, 'app.db'));
const orphan = db2.prepare('SELECT feed_id FROM entries WHERE id = ?').get('be_0_r');
check('保留下来的条目 feed_id 被置空（解绑，不指向已删源）', () => {
  return ok(orphan?.feed_id === null, `feed_id=${JSON.stringify(orphan?.feed_id)}`);
});
db2.close();

// ── ⑦ 删除幽灵 id ─────────────────────────────────────────
const delGhost = await j('POST', '/feeds/bulk/delete', { feedIds: ['bf_ghost'] });
check('删除不存在的 id 返回 200 + missing（不是 404）', () => {
  return ok(delGhost.status === 200 && delGhost.data?.done === 0
    && (delGhost.data?.missing ?? []).length === 1,
  `status=${delGhost.status} data=${JSON.stringify(delGhost.data)}`);
});

// ── ⑧ 前端计数与按钮 disabled 一致 ────────────────────────
//
// 后端全绿不代表界面是对的：计数显示 0 但删除按钮可点、或者
// 全选后计数显示 0，都会让用户误操作。这四条只能读 DOM。
if (process.env.AI_RSS_SKIP_UI === '1') {
  console.log('  \u001b[33mSKIP\u001b[0m  界面断言（AI_RSS_SKIP_UI=1）');
} else {
  await uiChecks();
}

async function uiChecks() {
  const { spawn } = await import('node:child_process');
  const { existsSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));

  const browser = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find((p) => existsSync(p));
  if (!browser) {
    console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器');
    return;
  }

  // 界面断言要在桌面视口跑：手机断点会藏掉行内按钮，
  // 那是别一节的判据（m1-05/m1-06），这里只验计数的联动。
  const prof = mkdtempSync(join(tmpdir(), 'ai-rss-bulkui-'));
  const cdp = 43000 + Math.floor(Math.random() * 900);
  const br = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${cdp}`, `--user-data-dir=${prof}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });
  const killBr = () => {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(br.pid)], { stdio: 'ignore' });
      } else br.kill('SIGKILL');
    } catch { /* 已退出 */ }
    removeDir(prof);
  };
  process.on('exit', killBr);

  let tgt = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json();
      tgt = list.find((t) => t.type === 'page');
      if (tgt?.webSocketDebuggerUrl) break;
    } catch { /* wait */ }
    await sleep2(250);
  }
  if (!tgt?.webSocketDebuggerUrl) {
    check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
    killBr();
    return;
  }

  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let seq = 0;
  const pend = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      if (m.error) rej(new Error(m.error.message)); else res(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pend.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval fail');
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
  });

  const goto = async (url) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) {
      if (await ev('document.readyState === "complete"').catch(() => false)) break;
      await sleep2(150);
    }
    await sleep2(1200);
  };

  await goto(origin);
  await ev(`fetch('${base}/auth/login',{method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({email:'bulk@test.local',password:'bulktest12345'}),
    credentials:'include'}).then(r=>r.ok)`);
  await goto(origin);
  // 打开配置 → 订阅分类（v1.13：侧栏的「订阅」入口已删，唯一入口是齿轮）
  await ev(`(() => {
    const gear = [...document.querySelectorAll('.icon-btn')]
      .find((x) => (x.getAttribute('title') || '').includes('配置'));
    if (gear) { gear.click(); return 'ok'; }
    return 'miss';
  })()`);
  await sleep2(1300);
  await ev(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find((x) => (x.textContent || '').trim().includes('订阅'));
    if (b) { b.click(); return 'ok'; }
    return 'miss';
  })()`);
  await sleep2(900);

  const enter = await ev(`(() => {
    const b = [...document.querySelectorAll('.feeds-actions .btn')]
      .find((x) => x.textContent.trim() === '管理');
    if (!b) return 'no-btn';
    b.click(); return 'ok';
  })()`);
  check('能进入批量管理模式', () => ok(enter === 'ok', `结果 ${enter}`));
  await sleep2(500);

  const bar = await ev(`(() => {
    const bar = document.querySelector('.bulk-bar');
    if (!bar) return null;
    const count = bar.querySelector('.bulk-count')?.innerText ?? '';
    const btns = [...bar.querySelectorAll('button')]
      .map((b) => ({ t: b.textContent.trim(), dis: b.disabled }));
    return {
      count,
      checks: document.querySelectorAll('.bulk-check').length,
      rows: document.querySelectorAll('.feed-row').length,
      btns,
      selectDisabled: bar.querySelector('.bulk-select')?.disabled ?? null,
    };
  })()`);
  check('管理模式下每行都出勾选框', () => {
    return ok(bar && bar.checks > 0 && bar.checks >= bar.rows,
      `勾选框 ${bar?.checks} / 行 ${bar?.rows}`);
  });
  check('未选中时所有批量操作按钮都 disabled', () => {
    const active = (bar?.btns ?? []).filter((b) => ['恢复', '暂停', '刷新', '删除'].includes(b.t));
    return ok(active.length === 4 && active.every((b) => b.dis),
      JSON.stringify(bar?.btns));
  });
  check('未选中时分组下拉也 disabled', () => ok(bar?.selectDisabled === true,
    `disabled=${bar?.selectDisabled}`));

  // 点全选
  await ev(`[...document.querySelectorAll('.bulk-bar .btn')]
    .find((x) => x.textContent.trim() === '全选')?.click()`);
  await sleep2(500);
  const all = await ev(`(() => {
    const bar = document.querySelector('.bulk-bar');
    return {
      count: bar.querySelector('.bulk-count')?.innerText ?? '',
      picked: document.querySelectorAll('.feed-row.picked').length,
      rows: document.querySelectorAll('.feed-row').length,
      enabled: [...bar.querySelectorAll('button')]
        .filter((b) => ['恢复','暂停','刷新','删除'].includes(b.textContent.trim()))
        .every((b) => !b.disabled),
      selectEnabled: !(bar.querySelector('.bulk-select')?.disabled ?? true),
    };
  })()`);
  check('全选后计数显示全部条数', () => {
    // 必须取「已选」后面那个数字。第一版写的是 /(\d+)$/，
    // 而计数串是「已选 22 / 22」—— 尾部数字是**总数**，
    // 于是"计数恒为 0"这个改坏也能通过。反向验证抓到的。
    const m = /已选\s*(\d+)\s*\/\s*(\d+)/.exec(all.count.replace(/\s+/g, ' '));
    return ok(Boolean(m) && Number(m[1]) === all.rows && Number(m[2]) === all.rows,
      `计数 "${all.count}" / 行 ${all.rows}`);
  });
  check('全选后每一行都带 picked 底色', () => {
    return ok(all.picked === all.rows && all.rows > 0,
      `picked ${all.picked} / rows ${all.rows}`);
  });
  check('全选后批量按钮全部可点', () => ok(all.enabled, JSON.stringify(all)));
  check('全选后分组下拉可点', () => ok(all.selectEnabled, JSON.stringify(all)));

  // 清空
  await ev(`[...document.querySelectorAll('.bulk-bar .btn')]
    .find((x) => x.textContent.trim() === '清空')?.click()`);
  await sleep2(500);
  const cleared = await ev(`(() => {
    const bar = document.querySelector('.bulk-bar');
    return {
      count: bar.querySelector('.bulk-count')?.innerText ?? '',
      picked: document.querySelectorAll('.feed-row.picked').length,
      disabled: [...bar.querySelectorAll('button')]
        .filter((b) => ['恢复','暂停','刷新','删除'].includes(b.textContent.trim()))
        .every((b) => b.disabled),
    };
  })()`);
  check('清空后计数回到 0 且没有选中行', () => {
    return ok(/已选\s*0\s*\//.test(cleared.count.replace(/\s+/g, ' ')) && cleared.picked === 0,
      `count="${cleared.count}" picked=${cleared.picked}`);
  });
  check('清空后批量按钮重新 disabled', () => ok(cleared.disabled, JSON.stringify(cleared)));

  // 组头勾选框：只选一组，计数应等于该组行数
  const groupSel = await ev(`(() => {
    const heads = [...document.querySelectorAll('.feed-group-head')];
    const h = heads[0];
    if (!h) return { err: 'no-group' };
    const name = (h.innerText || '').trim().split('\\n')[0];
    const b = h.querySelector('.bulk-check');
    if (!b) return { err: 'no-check' };
    b.click();
    return { name };
  })()`);
  await sleep2(500);
  const oneGroup = await ev(`(() => {
    const bar = document.querySelector('.bulk-bar');
    const first = document.querySelector('.feed-group');
    return {
      count: bar.querySelector('.bulk-count')?.innerText ?? '',
      picked: document.querySelectorAll('.feed-row.picked').length,
      inFirst: first ? first.querySelectorAll('.feed-row').length : 0,
      rows: document.querySelectorAll('.feed-row').length,
    };
  })()`);
  check('组头勾选框只选中该组（不是全选）', () => {
    return ok(oneGroup.picked === oneGroup.inFirst && oneGroup.picked < oneGroup.rows,
      `选中 ${oneGroup.picked} / 该组 ${oneGroup.inFirst} / 全部 ${oneGroup.rows}，组名 ${JSON.stringify(groupSel)}`);
  });
  check('组选后计数等于该组行数', () => {
    const m = /已选\s*(\d+)/.exec(oneGroup.count.replace(/\s+/g, ' '));
    return ok(Boolean(m) && Number(m[1]) === oneGroup.picked,
      `计数 "${oneGroup.count}" / 选中 ${oneGroup.picked}`);
  });

  ws.close();
  killBr();
}

summary('m1-08-bulk');
cleanup();
process.exit(process.exitCode ?? 0);
