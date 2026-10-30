#!/usr/bin/env node
// 1.26 未分组源平铺到侧栏 —— 验收
//
// 判据（PLAN §15.26 / §19.3 1.26）：
//   ① 未分组源作为外层行出现在分组区块里，与分组行同缩进（左右各差 ≤1px）
//   ② 它不出现在任何分组的子行里（不重复）
//   ③ 点它 → 请求带 folderId=none&feedId=<id>，列表只剩该源条目
//   ④ 再点同一行 → 取消源筛选回 folderId=none
//   ⑤ 未分组源也显示未读角标（0 不显示、>0 显示数字）
//   ⑥ 一个未分组源都没有时整块不渲染、也不留空标题
//   ⑦ 页面上的源行总数 = /feeds 返回的源数（不漏不重）
//   ⑧ 选中未分组源后标题行显示「未分组 · 源名」
//   ⑨ 375px 抽屉里未分组行仍可点
//
// ⑦ 是这一节最容易写错的一条：平铺的实现在"分组子行"与"未分组平铺行"
// 两处各写一份渲染，于是很容易出现某个源被两边都画到（或多画一遍）。
// 只断言"未分组源出现了"抓不到它 —— 必须数总数对账。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { findBrowser, launchBrowser, connectCdp } from '../lib/cdp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(root, 'dist', process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`);

group('1.26 未分组源平铺');

if (!existsSync(BIN)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-loose-'));
const dataDir = join(tmp, 'data');
const port = 48200 + Math.floor(Math.random() * 300);
const origin = `http://127.0.0.1:${port}`;
const API = `${origin}/api/v1`;

const srv = spawn(BIN, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
srv.stdout.on('data', () => { /* drain */ });

const cleanup = () => {
  killTree(srv.pid);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
onExit(cleanup);

let ready = false;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch { /* not yet */ }
  await sleep(250);
}
check('服务就绪', () => ok(ready, srvErr.slice(0, 300)));
if (!ready) { cleanup(); summary('m1-26-ungrouped'); process.exit(1); }

await fetch(`${API}/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'l@test.local', password: 'loosetest1234567' }),
});
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'l@test.local', password: 'loosetest1234567' }),
});
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

// ── 造数据 ────────────────────────────────────────────────
//
// 两个分组（一个 3 源、一个 1 源）+ 3 个未分组源。
// 未分组源的未读数刻意取 0 / 3 / 7：0 用来验"不显示 badge"，
// 两个非零用来验"数字对得上且不是抄了别人的"。
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
db.exec('PRAGMA busy_timeout = 8000;');
const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id;
const now = Date.now();

db.exec('BEGIN IMMEDIATE');
const insF = db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)');
insF.run('lf_a', uid, '组甲', 0);
insF.run('lf_b', uid, '组乙', 1);

const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?)`);
for (let i = 0; i < 3; i++) {
  insFeed.run(`lf_a${i}`, uid, `https://a${i}.example.com/feed`, `https://a${i}.example.com`,
    `甲的源${i}`, now, now, 'lf_a');
}
insFeed.run('lf_b0', uid, 'https://b0.example.com/feed', 'https://b0.example.com', '乙的源', now, now, 'lf_b');
// 未分组：0 / 3 / 7
insFeed.run('lf_x0', uid, 'https://x0.example.com/feed', 'https://x0.example.com', '散源零', now, now, null);
insFeed.run('lf_x3', uid, 'https://x3.example.com/feed', 'https://x3.example.com', '散源三', now, now, null);
insFeed.run('lf_x7', uid, 'https://x7.example.com/feed', 'https://x7.example.com', '散源七', now, now, null);

const insE = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,0,?)`);
let n = 0;
const put = (feedId, unread, site) => {
  for (let i = 0; i <= unread; i++) {
    n++;
    insE.run(`le${n}`, uid, feedId, `lg${n}`, `https://l.example.com/${n}`, `l/${n}`,
      `${site} 的条目 ${i}`, '摘要一段', 1700000000000 + n, now,
      i < unread ? 0 : 1, site);
  }
};
put('lf_a0', 2, '甲的源0');
put('lf_a1', 1, '甲的源1');
put('lf_a2', 0, '甲的源2');
put('lf_b0', 4, '乙的源');
put('lf_x0', 0, '散源零');
put('lf_x3', 3, '散源三');
put('lf_x7', 7, '散源七');
db.exec('COMMIT');
db.close();

// ── 后端口径：/feeds 是唯一数据源 ─────────────────────────
const feedsRes = await fetch(`${API}/feeds`, { headers: { cookie } });
const feedsBody = await feedsRes.json();
const feedList = feedsBody?.items ?? [];
check('/feeds 一次返回 7 个源（3 组内 + 1 组内 + 3 未分组）', () => eq(feedList.length, 7));
check('3 个未分组源的 folderId 都是 null', () => {
  const loose = feedList.filter((f) => f.folderId === null).map((f) => f.id).sort();
  return ok(JSON.stringify(loose) === JSON.stringify(['lf_x0', 'lf_x3', 'lf_x7']),
    JSON.stringify(loose));
});

// ── 浏览器 ────────────────────────────────────────────────
const browser = findBrowser();
if (!browser) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器，跳过 UI 断言');
  cleanup();
  summary('m1-26-ungrouped');
  process.exit(0);
}

const b1 = await launchBrowser({ profilePrefix: 'ai-rss-loose-prof-', width: 1440, height: 960 });
onExit(b1.close);
if (!b1.wsUrl) {
  check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
  summary('m1-26-ungrouped');
  cleanup();
  process.exit(1);
}
const cdp = await connectCdp(b1.wsUrl);
const { send, evaluate: ev } = cdp;

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setEmulatedMedia', {
  media: 'screen',
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});
await send('Network.setCookie', {
  name: 'ai_rss_sid', value: cookie.split('=')[1] ?? '',
  domain: '127.0.0.1', path: '/',
});
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url: origin });
for (let i = 0; i < 80; i++) {
  if (await ev('document.readyState === "complete"').catch(() => false)) break;
  await sleep(150);
}
await sleep(1500);

/** 侧栏快照：分组行、未分组行、子行，以及它们的几何 */
const snap = async () => ev(`(() => {
  const rows = [...document.querySelectorAll('.tree-row')].map((b) => {
    const lab = b.querySelector('.nav-label');
    const r = b.getBoundingClientRect();
    const lr = lab ? lab.getBoundingClientRect() : null;
    return {
      label: (lab?.textContent ?? '').trim(),
      isLoose: b.classList.contains('tree-loose-row'),
      active: b.className.includes('active'),
      open: b.getAttribute('aria-expanded') === 'true',
      left: Math.round(r.left * 10) / 10,
      height: Math.round(r.height),
      // **文字左边界**才是"同级"的真正判据。
      // 量按钮的 left 抓不到 padding-left 造成的缩进：按钮盒子照样贴左，
      // 只有里面的文字被推右 —— 而"看起来是子行"正是文字位置造成的。
      // 第一版只量按钮 left，给未分组行加 20px padding 的变异照样全绿。
      labelLeft: lr ? Math.round(lr.left * 10) / 10 : null,
      caretW: (() => {
        const c = b.querySelector('.tree-caret');
        return c ? Math.round(c.getBoundingClientRect().width) : 0;
      })(),
      badge: (() => {
        const bd = b.querySelector('.badge');
        return bd ? (bd.textContent ?? '').trim() : null;
      })(),
    };
  });
  const leaves = [...document.querySelectorAll('.tree-leaf')].map((c) => ({
    label: (c.querySelector('.tree-leaf-name')?.textContent ?? '').trim(),
    active: c.className.includes('active'),
  }));
  const head = document.querySelector('.pane-title h1');
  return {
    rows,
    leaves,
    looseBlock: Boolean(document.querySelector('[data-testid="loose-feeds"]')),
    title: (head?.textContent ?? '').trim(),
    rowCount: document.querySelectorAll('.entry-item').length,
    lastReq: window.__lastReq ?? null,
  };
})()`);

let s = await snap();

// ── ① 未分组行出现、与分组行同级 ──────────────────────────
{
  const looseRows = s.rows.filter((r) => r.isLoose);
  check('① 侧栏出现 3 个未分组源行', () => {
    return ok(looseRows.length === 3, JSON.stringify(looseRows.map((r) => r.label)));
  });
  check('① 未分组行按拼音序排（零 ling < 七 qi < 三 san）', () => {
    const names = looseRows.map((r) => r.label);
    // **不能断言码点序**：码点序给出 七(4E03) < 三(4E09) < 零(96F6)，
    // 那正是"用默认比较器"的实现会得到的结果 —— 它不报错，只是清单看起来是乱的。
    // zh-CN collation 给出 零(ling) < 七(qi) < 三(san)。
    return ok(names.join(',') === '散源零,散源七,散源三', names.join(','));
  });
  check('① **未分组行的文字左边界与分组行差 ≤1px**（同级视觉，不缩进成子行）', () => {
    // 量 label 的 left 而不是按钮的 left：padding-left 只推文字、不推按钮盒子。
    // 用按钮 left 的版本对"加了缩进"的变异是瞎的（实测：加 20px padding 仍全绿）。
    const groupLabelLeft = s.rows.find((r) => !r.isLoose)?.labelLeft;
    const bad = looseRows.filter((r) => Math.abs((r.labelLeft ?? 0) - groupLabelLeft) > 1);
    return ok(bad.length === 0,
      `分组 labelLeft=${groupLabelLeft}；未分组 ${JSON.stringify(looseRows.map((r) => ({ l: r.label, x: r.labelLeft })))}`);
  });
  check('① 未分组行高与分组行一致（同一种"行"）', () => {
    const gh = s.rows.find((r) => !r.isLoose)?.height;
    const bad = looseRows.filter((r) => Math.abs(r.height - gh) > 1);
    return ok(bad.length === 0, `组高=${gh} 未分组=${JSON.stringify(looseRows.map((r) => r.height))}`);
  });
  check('① 未分组行也有箭头占位（文字起点与分组行对齐）', () => {
    const gw = s.rows.find((r) => !r.isLoose)?.caretW;
    const bad = looseRows.filter((r) => Math.abs(r.caretW - gw) > 1);
    return ok(bad.length === 0, `组箭头宽=${gw} 未分组=${JSON.stringify(looseRows.map((r) => r.caretW))}`);
  });
}

// ── ② 不重复：未分组源不出现在任何分组子行里 ──────────────
{
  const looseLabels = s.rows.filter((r) => r.isLoose).map((r) => r.label);
  const inLeaves = s.leaves.filter((l) => looseLabels.includes(l.label));
  check('② 未分组源**不出现在分组子行里**（不重复渲染）', () => {
    return ok(inLeaves.length === 0, `子行里出现了：${JSON.stringify(inLeaves.map((l) => l.label))}`);
  });
}

// ── ⑤ 未读角标 ────────────────────────────────────────────
{
  const byLabel = Object.fromEntries(s.rows.filter((r) => r.isLoose).map((r) => [r.label, r.badge]));
  check('⑤ 0 未读的未分组源不显示角标', () => eq(byLabel['散源零'], null));
  check('⑤ 3 未读显示「3」', () => eq(byLabel['散源三'], '3'));
  check('⑤ 7 未读显示「7」', () => eq(byLabel['散源七'], '7'));
}

// ── ⑦ 总数对账：不漏不重 ──────────────────────────────────
{
  // 恒等式必须是**按实际展开状态**算的，不能假设"默认展开了第一组"：
  // 初始状态没有任何范围被选中，所以一个组都没展开（leaves=0）。
  // 断言要能在这个状态下成立，而不是把测试的假设写进期望值。
  const openGroupIds = s.rows
    .filter((r) => !r.isLoose && r.open)
    .map((r) => r.label);
  const leafCount = s.leaves.length;
  const looseCount = s.rows.filter((r) => r.isLoose).length;

  check('⑦ 页面上源行总数（已展开组的子行 + 未展开组内源 + 未分组行）= /feeds 源数', () => {
    // 分组名 → id 的对照只在这条断言里用一次，直接按名字算
    const feedsByGroupName = {
      组甲: feedList.filter((f) => f.folderId === 'lf_a').length,
      组乙: feedList.filter((f) => f.folderId === 'lf_b').length,
    };
    let total = leafCount + looseCount;
    for (const [name, n] of Object.entries(feedsByGroupName)) {
      if (!openGroupIds.includes(name)) total += n;
    }
    return ok(total === feedList.length,
      `leaves=${leafCount} loose=${looseCount} 已展开=${JSON.stringify(openGroupIds)} 合计=${total} 期望=${feedList.length}`);
  });

  check('⑦ 未展开的分组不渲染子行（手风琴仍生效）', () => {
    const bLeaves = s.leaves.filter((l) => l.label === '乙的源');
    const bOpen = openGroupIds.includes('组乙');
    return ok(bLeaves.length === 0 && !bOpen, `乙的源子行 ${bLeaves.length} 个，组乙 open=${bOpen}`);
  });

  // 再展开一个组，恒等式仍要成立（防止"展开时把未分组行挤掉"或反之）
  await ev(`(() => {
    const b = [...document.querySelectorAll('.tree-row')]
      .find((x) => !x.classList.contains('tree-loose-row')
        && (x.querySelector('.nav-label')?.textContent ?? '').trim() === '组乙');
    if (b) b.click();
    return Boolean(b);
  })()`);
  await sleep(1300);
  s = await snap();
  const openAfter = s.rows.filter((r) => !r.isLoose && r.open).map((r) => r.label);
  check('⑦ 展开「组乙」后：子行 +1、未分组行仍是 3（互不挤占）', () => {
    const looseAfter = s.rows.filter((r) => r.isLoose).length;
    const bLeaves = s.leaves.filter((l) => l.label === '乙的源').length;
    return ok(looseAfter === 3 && bLeaves === 1 && openAfter.includes('组乙'),
      `loose=${looseAfter} 乙子行=${bLeaves} 已展开=${JSON.stringify(openAfter)}`);
  });
}

// ── ③④ 点未分组源 → 过滤；再点 → 回到未分组全部 ───────────
const clickLoose = async (label) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.tree-loose-row')]
      .find((x) => (x.querySelector('.nav-label')?.textContent ?? '').trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1200);
  return r;
};

// 记录所有 /entries 请求的 query，用来断言"请求真的带上了 folderId=none"
await ev(`(() => {
  if (window.__reqPatched) return true;
  window.__reqPatched = true;
  window.__reqs = [];
  const of = window.fetch;
  window.fetch = function (u, o) {
    try {
      const s = String(u);
      if (s.includes('/entries?')) window.__reqs.push(s);
    } catch { /* ignore */ }
    return of.apply(this, arguments);
  };
  return true;
})()`);

{
  const clicked = await clickLoose('散源三');
  check('③ 点「散源三」这一行有反应', () => ok(clicked, '没找到该行'));
  await sleep(600);
  s = await snap();

  check('③ 点后该行 active', () => {
    const r = s.rows.find((x) => x.isLoose && x.label === '散源三');
    return ok(r?.active === true, `active=${r?.active}`);
  });
  check('③ 标题行显示「未分组 · 散源三」', () => {
    return ok(s.title.includes('未分组') && s.title.includes('散源三'), s.title);
  });
  check('③ 列表只剩这个源的条目（4 条：3 未读 + 1 已读里显示未读部分）', () => {
    // 默认只看未读 → 3 条
    return eq(s.rowCount, 3);
  });

  const reqs = await ev('window.__reqs ?? []');
  check('③ **请求真的带上了 folderId=none 与 feedId**', () => {
    const hit = reqs.some((u) => u.includes('folderId=none') && u.includes('feedId=lf_x3'));
    return ok(hit, JSON.stringify(reqs.slice(-4)));
  });
}

{
  // ④ 再点同一行 = 取消源筛选，回到整个未分组范围
  await clickLoose('散源三');
  s = await snap();
  check('④ 再点同一行取消源筛选：该行不再 active', () => {
    const r = s.rows.find((x) => x.isLoose && x.label === '散源三');
    return ok(r?.active === false, `active=${r?.active}`);
  });
  check('④ 回到「未分组」整体：标题是「未分组」', () => {
    return ok(s.title.includes('未分组') && !s.title.includes('散源三'), s.title);
  });
  check('④ 列表回到未分组全部（3 + 7 = 10 条未读）', () => eq(s.rowCount, 10));
}

/**
 * 刷新页面并等它稳定。
 *
 * **不能用 `Runtime.evaluate('location.reload()')`**：刷新会销毁当前执行
 * 上下文，那个 evaluate 的应答永远不会回来，脚本就挂在那里（实测卡死
 * 5 分钟无输出）。`Page.reload` 是对页面发命令，不依赖 JS 上下文。
 */
const reload = async () => {
  await send('Page.reload', { ignoreCache: false });
  for (let i = 0; i < 80; i++) {
    if (await ev('document.readyState === "complete"').catch(() => false)) break;
    await sleep(150);
  }
  await sleep(1600);
};

// ── ⑥ 没有未分组源时整块不渲染 ────────────────────────────
{
  const { DatabaseSync: DS } = await import('node:sqlite');
  const d = new DS(join(dataDir, 'app.db'));
  d.exec('PRAGMA busy_timeout = 8000;');
  d.exec('BEGIN IMMEDIATE');
  d.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)')
    .run('lf_tmp', uid, '暂存', 2);
  d.prepare("UPDATE feeds SET folder_id = 'lf_tmp' WHERE id IN ('lf_x0','lf_x3','lf_x7')").run();
  d.exec('COMMIT');
  d.close();

  await reload();
  s = await snap();
  check('⑥ 全部源都有分组后，未分组块整块不渲染', () => ok(s.looseBlock === false, '块仍在'));
  check('⑥ 也没有残留的空「未分组」行', () => {
    return ok(s.rows.filter((x) => x.isLoose).length === 0,
      JSON.stringify(s.rows.filter((x) => x.isLoose).map((x) => x.label)));
  });
  check('⑥ 分组区块仍正常（没有因为未分组消失而整块消失）', () => {
    return ok(s.rows.filter((x) => !x.isLoose).length === 3,
      `分组行数 ${s.rows.filter((x) => !x.isLoose).length}`);
  });

  // 还原，供 ⑨ 手机用例
  const d2 = new DS(join(dataDir, 'app.db'));
  d2.exec('PRAGMA busy_timeout = 8000;');
  d2.prepare("UPDATE feeds SET folder_id = NULL WHERE id IN ('lf_x0','lf_x3','lf_x7')").run();
  d2.prepare("DELETE FROM folders WHERE id = 'lf_tmp'").run();
  d2.close();
  await reload();
}

// ── ⑨ 手机：侧栏本就 display:none，未分组块不能因此留空壳 ──
//
// v2.0 修的是"桌面上找不到未分组的源"。手机上 `.sidebar { display: none }`
// （§15.7：底部 tab bar 一行六个入口）是**既有行为**，本次不改 ——
// 真要按源筛选得先设计抽屉或二级页，那是新增需求。
//
// 所以这一条验的不是"抽屉里能点"（那个抽屉不存在），而是：
// 未分组块在手机上**不能制造任何可见残留**，也不能影响 tab bar。
{
  await send('Emulation.setDeviceMetricsOverride', {
    width: 375, height: 812, deviceScaleFactor: 1, mobile: true,
  });
  await reload();

  const mobile = await ev(`(() => {
    const sb = document.querySelector('.sidebar');
    const cs = sb ? getComputedStyle(sb) : null;
    const tabs = [...document.querySelectorAll('.tabbar .tab')].map((t) => {
      const r = t.getBoundingClientRect();
      return { label: (t.querySelector('.tab-label')?.textContent ?? '').trim(), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return {
      sidebarDisplay: cs ? cs.display : 'missing',
      // 未分组行在 DOM 里可能还在（React 照常渲染），但整个侧栏不可见 ——
      // 判断"有没有可见残留"要看的是 document.body 上的横向溢出
      pageOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      tabCount: tabs.length,
      tabs,
      // 列表栏是否仍然占满：手机上不该出现半截空白栏
      listWidth: Math.round((document.querySelector('.list-pane')?.getBoundingClientRect().width ?? 0)),
    };
  })()`);

  check('⑨ 375px 下侧栏是 display:none（既有行为，本次不改）', () => {
    return eq(mobile.sidebarDisplay, 'none');
  });
  check('⑨ 未分组块没有在手机上造成横向溢出（页面不出现左右滚动）', () => {
    return ok(mobile.pageOverflowX === 0, `横向溢出 ${mobile.pageOverflowX}px`);
  });
  check('⑨ 底部 tab bar 仍是 6 格（未分组没有偷偷加一格）', () => {
    return eq(mobile.tabCount, 6);
  });
  check('⑨ 6 格每格仍 ≥44px 宽（§15.7 的触控下限）', () => {
    const bad = mobile.tabs.filter((t) => t.w < 44);
    return ok(bad.length === 0, JSON.stringify(mobile.tabs));
  });
  check('⑨ 列表栏在手机上占满 375px（没有因为多一块而留半截空白）', () => {
    return ok(Math.abs(mobile.listWidth - 375) <= 2, `list-pane 宽 ${mobile.listWidth}`);
  });

  // 回到桌面尺寸，确认未分组行还在（排除"手机上测完把状态弄坏了"）
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
  });
  await reload();
  s = await snap();
  check('⑨ 回到桌面尺寸后未分组行仍正常渲染（3 个）', () => {
    const n = s.rows.filter((x) => x.isLoose).length;
    return eq(n, 3);
  });
}

cdp.close();
cleanup();
await sleep(400);
summary('m1-26-ungrouped');

// **必须显式退出**：CDP 的 WebSocket 会让事件循环保持活跃，即使浏览器
// 已经被 killTree 掉 —— 于是脚本打完 `33/33 PASS` 就挂在那儿不返回。
//
// 这个症状特别难认：单独跑时用 `timeout 300` 包一层，`tail` 照样能看到
// PASS，看起来是"通过了"；放进 verify-all 串行跑时，就变成"整套验收停在
// 某个脚本上，20 分钟没有输出"。实测就是这个原因，不是 CDP 回包丢失。
//
// 这里用 process.exit 而不是 process.exitCode：in-flight 的 fetch 已全部
// await 过，此刻没有活动的 libuv 句柄（m0-09 用的是同一套写法）。
process.exit(process.exitCode ?? 0);
