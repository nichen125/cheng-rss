#!/usr/bin/env node
// 1.27 分组与源的排序 —— 验收（PLAN §15.28）
//
// 判据：
//   A 接口层
//     ① PATCH /folders/reorder [C,A,B] → GET /folders 就是 C,A,B
//     ② 只提交一个 id → 它第一、其余相对次序不变（不丢、不乱）
//     ③ 提交未知 id → 4xx 且顺序**不变**
//     ④ ids 不是数组 / 空数组 → 4xx
//     ⑤ POST /feeds/arrange 把源移进另一组：folder_id 与 sort 都变
//     ⑥ POST /feeds/arrange 移出到未分组（folderId:null）同理
//     ⑦ 只排一部分源 → 未列出的保持原相对次序顺延在后（不丢）
//   B 界面层
//     ⑧ 未分组源行排在所有分组行**之前**（§15.28 的位置调整）
//     ⑨ 长按满 500ms → 进入排列模式（出现「完成」与 ↑↓）
//     ⑩ 按不满时长就松手 → **不进入**排列模式，且照常选中该分组
//     ⑪ 位移 > 8px 再松手 → 不算长按（既不进模式，也不当点击）
//     ⑫ 排列模式下点 ↓ → 顺序变化，且 GET 跟着变（不是只有 DOM 动了）
//     ⑬ 排列模式下拖动：浮起卡片出现、拖完后顺序落库
//     ⑭ 首行 ↑ / 末行 ↓ 禁用
//     ⑮ 点「完成」/ Esc → 退出排列模式
//     ⑯ 排列模式下侧栏无横向溢出、行高与排列前相同
//   C 配置页
//     ⑰ 配置 › 分组 有常显 ↑↓，首行禁用、能改顺序
//     ⑱ 展开分组 → 组内源的 ↑↓ 与「移到…」可用，能换组
//
// 为什么要单独一个脚本而不是并进 m1-18：m1-18 验的是"树搬迁"（chip 行有没有
// 真删掉、手风琴、0 源分组）。排序是**另一组失败模式** —— 树完全正常、
// 点击照常过滤，只有"顺序提交了但没落库"或"拖完 DOM 变了刷新又回去"才会红。
// 那两种症状在只看点击行为的断言下完全隐身。
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
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`);

group('1.27 分组与源排序');

if (!existsSync(BIN)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-arrange-'));
const dataDir = join(tmp, 'data');
const port = 48600 + Math.floor(Math.random() * 300);
const origin = `http://127.0.0.1:${port}`;
const API = `${origin}/api/v1`;

const srv = spawn(BIN, ['serve', '--data', dataDir, '--port', String(port)], {
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
if (!ready) { cleanup(); summary('m1-27-arrange'); process.exit(1); }

await fetch(`${API}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ar@test.local', password: 'arrangetest1234' }),
});
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ar@test.local', password: 'arrangetest1234' }),
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

// ── 造数据 ────────────────────────────────────────────────
//
// 三个分组（甲/乙/丙）+ 每个 2~3 个源 + 2 个未分组源。
// sort 刻意都写 0：模拟"迁移上来的老库"，也是并列时退回标题序的场合。
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
const insFolder = db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)');
insFolder.run('af_a', uid, '甲组', 0);
insFolder.run('af_b', uid, '乙组', 1);
insFolder.run('af_c', uid, '丙组', 2);

const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id,sort)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?,?)`);
const now = Date.now();
for (let i = 0; i < 3; i++) {
  insFeed.run(`fa_${i}`, uid, `https://a${i}.example.com/feed`, `https://a${i}.example.com`,
    `甲源${i}`, now, now, 'af_a', 0);
}
for (let i = 0; i < 2; i++) {
  insFeed.run(`fb_${i}`, uid, `https://b${i}.example.com/feed`, `https://b${i}.example.com`,
    `乙源${i}`, now, now, 'af_b', 0);
}
insFeed.run('fc_0', uid, 'https://c0.example.com/feed', 'https://c0.example.com', '丙源0', now, now, 'af_c', 0);
insFeed.run('fx_0', uid, 'https://x0.example.com/feed', 'https://x0.example.com', '散源零', now, now, null, 0);
insFeed.run('fx_1', uid, 'https://x1.example.com/feed', 'https://x1.example.com', '散源一', now, now, null, 0);
db.exec('COMMIT');
db.close();

const folderOrder = async () => {
  const r = await j('GET', '/folders');
  return (r.data?.items ?? []).map((f) => f.id);
};

// ── A 接口层 ──────────────────────────────────────────────
{
  const before = await folderOrder();
  check('A 初始分组顺序 = 甲,乙,丙', () => eq(before.join(','), 'af_a,af_b,af_c'));

  /**
   * ⚠️ 这条断言必须验"接口真的存在"而不是只看它返回了 2xx。
   * 路由顺序写反时（/folders/reorder 排在 /folders/:id 之后），
   * "reorder" 会被当成分组 id，PATCH 走 renameFolder → 404「分组不存在」。
   * 光看"接口能调"是不够的，要读**落库之后**的顺序。
   */
  const r1 = await j('PATCH', '/folders/reorder', { ids: ['af_c', 'af_a', 'af_b'] });
  check('① PATCH /folders/reorder 返回 200', () => eq(r1.status, 200));
  const _a1_after = await folderOrder();
  check('① 提交 [丙,甲,乙] 后 GET /folders 就是 丙,甲,乙', () => {
    const after = _a1_after;
    return eq(after.join(','), 'af_c,af_a,af_b');
  });

  // ② 只提交一个：它排第一，其余保持相对次序、不丢失
  const r2 = await j('PATCH', '/folders/reorder', { ids: ['af_b'] });
  check('② 只提交一个 id 时返回 200', () => eq(r2.status, 200));
  const _a2_after = await folderOrder();
  check('② 只提交乙 → 乙第一，丙、甲按原相对次序跟在后面（不丢）', () => {
    const after = _a2_after;
    // 提交前的顺序是 丙,甲,乙；未列出的 丙,甲 保持相对次序 → 乙,丙,甲
    return eq(after.join(','), 'af_b,af_c,af_a');
  });

  // ③ 未知 id：整体拒绝，且顺序不变
  const beforeUnknown = await folderOrder();
  const r3 = await j('PATCH', '/folders/reorder', { ids: ['af_a', 'no_such_folder'] });
  check('③ 提交未知分组 id 返回 4xx', () => {
    return ok(r3.status >= 400 && r3.status < 500, `status=${r3.status}`);
  });
  const _a3_after = await folderOrder();
  check('③ 未知 id 被拒绝后顺序**完全没变**（不是部分成功）', () => {
    const after = _a3_after;
    return eq(after.join(','), beforeUnknown.join(','));
  });

  // ④ 非法 body
  const r4a = await j('PATCH', '/folders/reorder', { ids: 'af_a' });
  check('④ ids 不是数组 → 400', () => eq(r4a.status, 400));
  const r4b = await j('PATCH', '/folders/reorder', { ids: [] });
  check('④ ids 是空数组 → 400', () => eq(r4b.status, 400));
  const r4c = await j('PATCH', '/folders/reorder', { ids: [1, 2] });
  check('④ ids 里混入数字 → 400', () => eq(r4c.status, 400));

  // ⑤ 把源移进另一组
  const r5 = await j('POST', '/feeds/arrange', { folderId: 'af_b', ids: ['fb_0', 'fa_0', 'fb_1'] });
  check('⑤ POST /feeds/arrange 移入分组返回 200', () => eq(r5.status, 200));
  const feedsAfter = async () => (await j('GET', '/feeds')).data.items;
  const _a4_items = await feedsAfter();
  check('⑤ 甲源0 的 folderId 变成乙组，并且在乙组里排第 2（顺序来自 ids）', () => {
    const items = _a4_items;
    const f = items.find((x) => x.id === 'fa_0');
    const bGroup = items.filter((x) => x.folderId === 'af_b')
      .sort((x, y) => x.sort - y.sort).map((x) => x.id);
    return ok(f?.folderId === 'af_b' && bGroup.join(',') === 'fb_0,fa_0,fb_1',
      `folderId=${f?.folderId} 乙组顺序=${bGroup.join(',')}`);
  });

  // ⑥ 移出到未分组
  const looseBefore = (await feedsAfter()).filter((x) => !x.folderId).map((x) => x.id);
  const r6 = await j('POST', '/feeds/arrange', {
    folderId: null,
    ids: [looseBefore[0], 'fa_0'],
  });
  check('⑥ POST /feeds/arrange folderId:null 返回 200', () => eq(r6.status, 200));
  const _a5_items = await feedsAfter();
  check('⑥ 甲源0 退回未分组，且排在提交给出的位置', () => {
    const items = _a5_items;
    const f = items.find((x) => x.id === 'fa_0');
    const loose = items.filter((x) => !x.folderId).sort((x, y) => x.sort - y.sort).map((x) => x.id);
    return ok(f?.folderId === null && loose[1] === 'fa_0',
      `folderId=${f?.folderId} 未分组顺序=${loose.join(',')}`);
  });

  // ⑦ 只排一部分：未列出的同组源保持相对次序顺延在后
  const _a6_r = await j('POST', '/feeds/arrange', { folderId: 'af_b', ids: ['fb_1'] });
  const _a6_items = await feedsAfter();
  check('⑦ 只给一个 id 排乙组 → 未列出的保持原相对次序跟在后面', () => {
    const r = _a6_r;
    if (r.status !== 200) return ok(false, `status=${r.status}`);
    const items = _a6_items;
    const bGroup = items.filter((x) => x.folderId === 'af_b')
      .sort((x, y) => x.sort - y.sort).map((x) => x.id);
    // 提交前乙组是 甲源0(fa_0 已移走) → 剩 fb_0,fb_1；提交 fb_1 后：fb_1,fb_0
    return ok(bGroup.join(',') === 'fb_1,fb_0', `乙组顺序=${bGroup.join(',')}`);
  });

  const r7b = await j('POST', '/feeds/arrange', { folderId: 'no_such', ids: ['fb_0'] });
  check('⑦ 不存在的分组 → 404', () => eq(r7b.status, 404));

  // 把数据摆回一个可预测的状态给界面层用：甲组 3 源、乙组 2 源、未分组 2 源
  await j('POST', '/feeds/arrange', { folderId: 'af_a', ids: ['fa_0', 'fa_1', 'fa_2'] });
  await j('POST', '/feeds/arrange', { folderId: 'af_b', ids: ['fb_0', 'fb_1'] });
  await j('POST', '/feeds/arrange', { folderId: null, ids: ['fx_0', 'fx_1'] });
  await j('PATCH', '/folders/reorder', { ids: ['af_a', 'af_b', 'af_c'] });
}

// ── 浏览器 ────────────────────────────────────────────────
const browser = findBrowser();
if (!browser) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器，跳过 UI 断言');
  cleanup();
  summary('m1-27-arrange');
  process.exit(0);
}

const b1 = await launchBrowser({ profilePrefix: 'cheng-rss-arrange-prof-', width: 1440, height: 960 });
onExit(b1.close);
if (!b1.wsUrl) {
  check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
  summary('m1-27-arrange');
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
  features: [{ name: 'prefers-color-scheme', value: 'light' }],
});
await send('Network.setCookie', {
  name: 'cheng_rss_sid', value: cookie.split('=')[1] ?? '',
  domain: '127.0.0.1', path: '/',
});
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
});

const reload = async () => {
  await send('Page.navigate', { url: origin });
  for (let i = 0; i < 80; i++) {
    if (await ev('document.readyState === "complete"').catch(() => false)) break;
    await sleep(150);
  }
  await sleep(1300);
};
await reload();

/** 侧栏快照：行顺序、几何、排列模式状态 */
const snap = async () => ev(`(() => {
  const all = [...document.querySelectorAll('.nav.tree [data-arrange-kind]')];
  const rows = all.map((b) => {
    const lab = b.querySelector('.nav-label') || b.querySelector('.tree-leaf-name');
    const r = b.getBoundingClientRect();
    return {
      kind: b.dataset.arrangeKind,
      id: b.dataset.arrangeId,
      label: (lab?.textContent ?? '').trim(),
      top: Math.round(r.top),
      height: Math.round(r.height),
      disabled: [...b.querySelectorAll('.arrange-arrow')].map((x) => x.disabled),
      expanded: b.getAttribute('aria-expanded'),
      pressed: b.getAttribute('aria-pressed'),
      badge: (() => {
        const bd = b.querySelector('.badge');
        return bd ? (bd.textContent ?? '').trim() : null;
      })(),
      cls: b.className,
    };
  });
  const side = document.querySelector('.sidebar');
  return {
    rows,
    arranging: Boolean(document.querySelector('.nav.tree.arranging')),
    headText: (document.querySelector('.nav-section.arrange-head')?.textContent ?? '').trim(),
    hasDone: Boolean([...document.querySelectorAll('.nav-section.arrange-head .btn')]
      .find((b) => (b.textContent || '').includes('完成'))),
    // 排列模式下侧栏不该出现横向溢出
    sideOverflowX: side ? Math.max(0, side.scrollWidth - side.clientWidth) : 0,
    ghost: Boolean(document.querySelector('.drag-ghost')),
    toast: (() => {
      const t = document.querySelector('.toast');
      return t ? { text: (t.querySelector('.toast-text')?.textContent ?? '').trim(), action: (t.querySelector('.toast-action')?.textContent ?? '').trim() } : null;
    })(),
    groupTitle: (document.querySelector('.pane-title h1')?.textContent ?? '').trim(),
    // 触摸屏的长按保护：真机长按会被浏览器的选字/上下文菜单抢走
    longPressGuard: (() => {
      const row = document.querySelector('.nav.tree .tree-row')
        ?? document.querySelector('.nav.tree [data-arrange-kind]');
      if (!row) return null;
      const cs = getComputedStyle(row);
      // -webkit-touch-callout 在 Chrome 里既读不出 computed 值，
      // 也不出现在 CSSStyleDeclaration.cssText 里（Chrome 不建模这个属性，
      // 序列化时就丢了），所以只能拉样式表**原文**来查。
      return {
        userSelect: cs.userSelect ?? '',
        touchAction: cs.touchAction,
        hasCallout: window.__cssHasCallout === undefined
          ? null : window.__cssHasCallout,
      };
    })(),
  };
})()`);

// 先把样式表原文抓一次（fetch 而不是读 cssRules：Chrome 的
// CSSStyleDeclaration.cssText 会丢掉 -webkit-touch-callout 这类它不建模的属性）
await ev(`(async () => {
  if (window.__cssHasCallout !== undefined) return;
  let has = false;
  const links = [...document.querySelectorAll('link[rel=stylesheet]')];
  for (const l of links) {
    try {
      const t = await (await fetch(l.href)).text();
      if (/-webkit-touch-callout\\s*:\\s*none/.test(t)) { has = true; break; }
    } catch { /* 读不到就跳过 */ }
  }
  if (!has) {
    // 内联 <style> 也要扫（dev 模式与嵌入构建都可能走这条路）
    const inline = [...document.querySelectorAll('style')].map((s) => s.textContent || '').join('\\n');
    has = /-webkit-touch-callout\\s*:\\s*none/.test(inline);
  }
  window.__cssHasCallout = has;
})()`);

let s = await snap();

// 排列模式之前先量一次行高。**不要写死阈值**：38px 是 .nav-item 的
// `padding 8×2 + 13.5px 字号` 算出来的正常行高，写死会把"正常"判成"撑高了"。
// 真正要守住的是"进入排列模式没让行变高"，所以拿它和自己比。
const normalRowH = s.rows.filter((r) => r.kind === 'folder').map((r) => r.height);

// ── ⑧ 未分组源在最前 ──────────────────────────────────────
{
  const loose = s.rows.filter((r) => r.kind === 'loose');
  const folders = s.rows.filter((r) => r.kind === 'folder');
  check('⑧ 侧栏有 2 个未分组源行、3 个分组行', () => {
    return ok(loose.length === 2 && folders.length === 3,
      `loose=${loose.length} folders=${folders.length}`);
  });
  check('⑧ **未分组源行排在所有分组行之前**（§15.28 的位置调整）', () => {
    if (loose.length === 0 || folders.length === 0) return ok(false, '缺行');
    const maxLoose = Math.max(...loose.map((r) => r.top));
    const minFolder = Math.min(...folders.map((r) => r.top));
    return ok(maxLoose < minFolder, `末个未分组 top=${maxLoose} 首个分组 top=${minFolder}`);
  });
  check('⑧ 未分组行之间仍按拼音序（散源零 ling < 散源一 yi）', () => {
    const names = loose.map((r) => r.label);
    return eq(names.join(','), '散源零,散源一');
  });
}

// ── ⑨⑩⑪ 长按判定 ────────────────────────────────────────
//
// 用真实的 pointer 事件而不是直接调 React 的 handler：长按的实现里
// 有一半逻辑在 window 上的 pointermove/pointerup 监听里，直接调 handler
// 会把那一半完全绕过 —— 于是"移动超过 8px 该取消"这条永远测不到。
const pressOn = async (kind, id, holdMs, moveBy = 0) => ev(`(async () => {
  const el = document.querySelector('[data-arrange-kind="${kind}"][data-arrange-id="${id}"]');
  if (!el) return 'no-el';
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
                 isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  await new Promise((res) => setTimeout(res, ${Math.floor(holdMs / 2)}));
  if (${moveBy} !== 0) {
    window.dispatchEvent(new PointerEvent('pointermove', {
      ...opts, clientX: x, clientY: y + ${moveBy},
    }));
    await new Promise((res) => setTimeout(res, 120));
  }
  await new Promise((res) => setTimeout(res, ${Math.max(0, Math.floor(holdMs / 2))}));
  window.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return 'ok';
})()`);

{
  // ⑩ 先验"不进入"：按 200ms 就松手
  await pressOn('folder', 'af_a', 200);
  await sleep(400);
  s = await snap();
  check('⑩ 按不满 500ms 就松手 → **不进入**排列模式', () => {
    return ok(s.arranging === false && s.hasDone === false, `arranging=${s.arranging}`);
  });
  check('⑩ 那一下仍照常当点击：选中「甲组」（标题变甲组）', () => {
    return ok(s.groupTitle.includes('甲组'), `标题=${s.groupTitle}`);
  });

  // ⑪ 位移超过 8px：既不算长按，也不当点击
  await pressOn('folder', 'af_b', 600, 40);
  await sleep(400);
  s = await snap();
  check('⑪ 位移 40px 后松手 → 不算长按（不进入排列模式）', () => {
    return ok(s.arranging === false, `arranging=${s.arranging}`);
  });

  // ⑨ 长按满 500ms
  await pressOn('folder', 'af_a', 700);
  await sleep(500);
  s = await snap();
  check('⑨ 长按满 500ms → 进入排列模式', () => {
    return ok(s.arranging === true, `arranging=${s.arranging}`);
  });
  check('⑨ 排列模式出现「完成」按钮', () => ok(s.hasDone === true, '没找到完成'));
  // 触摸屏保护（§15.7）：没有 user-select:none 时，真机长按会先被浏览器
  // 接管（iOS 弹「拷贝/查询」、Android 开始选字），用户等不到那 500ms，
  // 排序在手机上等于不存在。桌面上鼠标长按不会触发这些，所以只能量 CSS。
  check('⑪b 侧栏行禁用了长按选字（否则真机排序不可用）', () => {
    const g = s.longPressGuard;
    // 只断言 Chrome 真正能读到的两个。`-webkit-touch-callout` 在 Chrome 的
    // computedStyle 里读出来是空串（它是 iOS Safari 的属性，Chrome 不建模），
    // 所以那个键改成在 CSS 源文本里查 —— 见下面 ⑪c。
    // 少了 user-select:none，长按会先开始选字；少了 touch-action，
    // 移动端会把横向位移判成滚动手势，拖动被抢走。
    return ok(g?.userSelect === 'none' && g?.touchAction === 'pan-y', JSON.stringify(g));
  });
  check('⑪c CSS 里有 iOS 的长按菜单保护（-webkit-touch-callout: none）', () => {
    return ok(s.longPressGuard?.hasCallout === true,
      JSON.stringify(s.longPressGuard));
  });
  check('⑨ 排列模式下分组行出现两颗箭头', () => {
    const folderRows = s.rows.filter((r) => r.kind === 'folder');
    const bad = folderRows.filter((r) => r.disabled.length !== 2);
    return ok(bad.length === 0, JSON.stringify(folderRows.map((r) => r.disabled)));
  });
  check('⑭ 首行的 ↑ 禁用、末行的 ↓ 禁用', () => {
    const fs = s.rows.filter((r) => r.kind === 'folder');
    const first = fs[0];
    const last = fs[fs.length - 1];
    return ok(first.disabled[0] === true && last.disabled[1] === true,
      `first=${JSON.stringify(first.disabled)} last=${JSON.stringify(last.disabled)}`);
  });
}

// ── ⑫ 点 ↓ 改顺序，且落库 ────────────────────────────────
{
  const before = await folderOrder();
  const clicked = await ev(`(() => {
    const rows = [...document.querySelectorAll('.nav.tree [data-arrange-kind="folder"]')];
    const first = rows[0];
    const down = first.querySelectorAll('.arrange-arrow')[1];
    if (!down) return false;
    down.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  check('⑫ 点得到首行的 ↓', () => ok(clicked === true, '按钮没找到'));
  await sleep(1200);
  const _a7_after = await folderOrder();
  check('⑫ 点 ↓ 之后顺序变了，且 **GET /folders 跟着变**（不是只有 DOM 动了）', () => {
    const after = _a7_after;
    const swapped = after[0] === before[1] && after[1] === before[0];
    return ok(swapped, `before=${before.join(',')} after=${after.join(',')}`);
  });
  s = await snap();
  check('⑫ 刷新后界面顺序与服务端一致（页面重取过，不是本地乐观更新）', () => {
    const viewOrder = s.rows.filter((r) => r.kind === 'folder').map((r) => r.id);
    return ok(viewOrder[0] !== before[0], `视图顺序=${viewOrder.join(',')}`);
  });
}

// ── ⑬ 拖动：浮起卡片 + 落库 ──────────────────────────────
{
  const before = await folderOrder();
  // 长按抬起首行，移动到第 3 行下半部分，松手
  const dragged = await ev(`(async () => {
    const rows = [...document.querySelectorAll('.nav.tree [data-arrange-kind="folder"]')];
    if (rows.length < 3) return 'few-rows';
    const src = rows[0];
    const dst = rows[2];
    const sr = src.getBoundingClientRect();
    const dr = dst.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, pointerId: 2, pointerType: 'mouse',
                   isPrimary: true, button: 0, buttons: 1 };
    // ⚠️ 按在**行内的 button** 上，不是外层容器：排列模式下容器只是
    // 定位/高亮用的 div，pointerdown 处理器挂在里面的 button 上
    // （↑↓ 要能和行按钮做兄弟，不能嵌在它里面 —— 见 App.tsx 的注释）。
    // 按容器会让 press() 根本不触发，而症状是"ghost 没出现"，
    // 看起来像浮起卡片坏了。
    const srcBtn = src.querySelector('button') || src;
    srcBtn.dispatchEvent(new PointerEvent('pointerdown', {
      ...base, clientX: sr.left + 12, clientY: sr.top + 12 }));
    await new Promise((res) => setTimeout(res, 200));
    window.dispatchEvent(new PointerEvent('pointermove', {
      ...base, clientX: dr.left + 12, clientY: dr.top + dr.height - 3 }));
    await new Promise((res) => setTimeout(res, 250));
    const ghost = Boolean(document.querySelector('.drag-ghost'));
    const line = Boolean(document.querySelector('.nav.tree [class*="drop-"]'));
    window.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
    await new Promise((res) => setTimeout(res, 900));
    return { ghost, line };
  })()`);
  check('⑬ 拖动中浮起卡片出现（§15.28 的"悬浮"反馈）', () => {
    return ok(dragged !== 'few-rows' && dragged.ghost === true, JSON.stringify(dragged));
  });
  check('⑬ 拖动中目标行出现落点线', () => {
    return ok(dragged !== 'few-rows' && dragged.line === true, JSON.stringify(dragged));
  });
  const _a8_after = await folderOrder();
  check('⑬ 拖完顺序落库：首行被移到后面', () => {
    const after = _a8_after;
    return ok(after[0] !== before[0] && after.join(',') !== before.join(','),
      `before=${before.join(',')} after=${after.join(',')}`);
  });
  const _a9_g = await ev(`Boolean(document.querySelector('.drag-ghost'))`);
  check('⑬ 松手后浮起卡片消失', () => {
    const g = _a9_g;
    return ok(g === false, 'ghost 还在');
  });
}

// ── ⑯ 排列模式不破坏布局 ─────────────────────────────────
{
  s = await snap();
  check('⑯ 排列模式下侧栏无横向溢出', () => {
    return ok(s.sideOverflowX === 0, `溢出 ${s.sideOverflowX}px`);
  });
  check('⑯ 排列模式下分组行高与普通模式一致（进入模式不撑高侧栏）', () => {
    const now = s.rows.filter((r) => r.kind === 'folder').map((r) => r.height);
    // 逐行比。允许 1px 的亚像素误差 —— 加了 drag-grip 之后行内元素
    // 的基线可能让它进位，但那不算"撑高"。
    const bad = now.filter((h, i) => Math.abs(h - (normalRowH[i] ?? h)) > 1);
    return ok(bad.length === 0, `普通=${JSON.stringify(normalRowH)} 排列=${JSON.stringify(now)}`);
  });
}

// ── ⑮ 退出排列模式 ───────────────────────────────────────
{
  const orderBeforeExit = await folderOrder();
  await ev(`(() => {
    const b = [...document.querySelectorAll('.nav-section.arrange-head .btn')]
      .find((x) => (x.textContent || '').includes('完成'));
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  })()`);
  await sleep(600);
  s = await snap();
  check('⑮ 点「完成」退出排列模式', () => {
    return ok(s.arranging === false && s.hasDone === false, `arranging=${s.arranging}`);
  });
  const _a10_now = await folderOrder();
  check('⑮ 退出后顺序保持不变（完成不是撤销）', () => {
    const now = _a10_now;
    return eq(now.join(','), orderBeforeExit.join(','));
  });

  // Esc 也能退出：先重新进入
  await pressOn('folder', 'af_a', 700);
  await sleep(400);
  s = await snap();
  if (s.arranging) {
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(400);
    s = await snap();
  }
  check('⑮ Esc 也能退出排列模式', () => ok(s.arranging === false, `arranging=${s.arranging}`));
}

// ── ⑰ 配置页：常显 ↑↓ ────────────────────────────────────
const openSettings = async () => {
  await ev(`(() => {
    const b = [...document.querySelectorAll('.icon-btn')]
      .find((x) => (x.getAttribute('title') || '').includes('配置'));
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  })()`);
  await sleep(1200);
  await ev(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find((x) => (x.textContent || '').includes('分组'));
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  })()`);
  await sleep(900);
};

{
  await openSettings();
  const cfg = await ev(`(() => {
    const rows = [...document.querySelectorAll('.folder-manage-row')];
    return {
      count: rows.length,
      // 每个分组行两颗箭头，且常显（不需要先进入什么模式）
      arrows: rows.map((r) => [...r.querySelectorAll('.icon-arrow')].map((x) => x.disabled)),
      names: rows.map((r) => (r.querySelector('.folder-name')?.textContent ?? '').trim()),
    };
  })()`);
  check('⑰ 配置 › 分组 有 3 个分组行', () => eq(cfg.count, 3));
  check('⑰ 每个分组行都有两颗常显箭头（没有长按、没有「进入排列」前置步骤）', () => {
    const bad = cfg.arrows.filter((a) => a.length !== 2);
    return ok(bad.length === 0, JSON.stringify(cfg.arrows));
  });
  check('⑰ 首行 ↑ 禁用、末行 ↓ 禁用', () => {
    const first = cfg.arrows[0];
    const last = cfg.arrows[cfg.arrows.length - 1];
    return ok(first[0] === true && last[1] === true,
      `first=${JSON.stringify(first)} last=${JSON.stringify(last)}`);
  });

  const cfgBefore = await folderOrder();
  await ev(`(() => {
    const rows = [...document.querySelectorAll('.folder-manage-row')];
    const down = rows[0].querySelectorAll('.icon-arrow')[1];
    down.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  })()`);
  await sleep(1400);
  const _a11_after = await folderOrder();
  check('⑰ 配置页点 ↓ → GET /folders 顺序跟着变', () => {
    const after = _a11_after;
    return ok(after[0] === cfgBefore[1] && after[1] === cfgBefore[0],
      `before=${cfgBefore.join(',')} after=${after.join(',')}`);
  });

  // ── ⑱ 组内源：↑↓ 与「移到…」 ──────────────────────────
  //
  // 展开**按名字找**「甲组」，不能取 `.folder-twist` 的第一个：
  // 上面的 ⑰ 点过 ↓，首行已经换人了，而三个组各自的源数不同（3/2/1）。
  // 这一条第一版就是取第一个，于是拿到只有 1 个源的丙组，
  // 报出"期望 3，实际 1"—— 看起来像实现丢了源，其实是断言的假设错了。
  const expanded = await ev(`(() => {
    const rows = [...document.querySelectorAll('.folder-manage-row')];
    const row = rows.find((r) => (r.querySelector('.folder-name')?.textContent ?? '').trim() === '甲组');
    if (!row) return 'no-group';
    const t = row.querySelector('.folder-twist');
    if (!t) return 'no-twist';
    t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return 'ok';
  })()`);
  check('⑱ 能展开「甲组」看组内源', () => eq(expanded, 'ok'));
  await sleep(500);
  const kids = await ev(`(() => {
    const grp = document.querySelector('.folder-manage-group[data-folder-id="af_a"]');
    if (!grp) return { count: 0, missing: true };
    const items = [...grp.querySelectorAll('.folder-feed-list li')];
    return {
      count: items.length,
      // **只回传可序列化的标量**。返回 DOM 节点数组会让 CDP 报
      // "Object reference chain is too long" —— 那个错看起来像 CDP 挂了，
      // 实际是返回值里有循环引用（元素 → parentNode → …）。
      arrowCounts: items.map((r) => r.querySelectorAll('.icon-arrow').length),
      selects: items.filter((r) => r.querySelector('.folder-move-select')).length,
      names: items.map((r) => (r.querySelector('.folder-feed-name')?.textContent ?? '').trim()),
    };
  })()`);
  check('⑱ 甲组展开后出现 3 个源', () => eq(kids.count, 3));
  check('⑱ 每个组内源都有 ↑↓ 与「移到…」下拉', () => {
    return ok(kids.selects === kids.count && kids.arrowCounts.every((n) => n === 2),
      `selects=${kids.selects} arrows=${JSON.stringify(kids.arrowCounts)}`);
  });

  const kidBefore = await ev(`[...document.querySelectorAll('.folder-manage-group[data-folder-id="af_a"] .folder-feed-name')].map((x) => x.textContent.trim())`);
  await ev(`(() => {
    const grp = document.querySelector('.folder-manage-group[data-folder-id="af_a"]');
    const li = grp.querySelectorAll('.folder-feed-list li')[0];
    const down = li.querySelectorAll('.icon-arrow')[1];
    down.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  })()`);
  await sleep(1400);
  const kidAfter = await ev(`[...document.querySelectorAll('.folder-manage-group[data-folder-id="af_a"] .folder-feed-name')].map((x) => x.textContent.trim())`);
  const _a12_items = (await j('GET', '/feeds')).data.items;
  check('⑱ 组内源点 ↓ → 界面顺序变了，且落库（重新 GET 后一致）', () => {
    const items = _a12_items;
    const aGroup = items.filter((x) => x.folderId === 'af_a')
      .sort((x, y) => x.sort - y.sort).map((x) => x.title);
    return ok(kidAfter[0] === kidBefore[1] && aGroup[0] === kidBefore[1],
      `before=${kidBefore.join(',')} after=${kidAfter.join(',')} 库=${aGroup.join(',')}`);
  });

  // 「移到…」：把甲组第一个源移到乙组
  const moved = await ev(`(() => {
    const grp = document.querySelector('.folder-manage-group[data-folder-id="af_a"]');
    if (!grp) return 'no-group';
    const li = grp.querySelectorAll('.folder-feed-list li')[0];
    if (!li) return 'no-li';
    const sel = li.querySelector('.folder-move-select');
    if (!sel) return 'no-select';
    const opt = [...sel.options].find((o) => o.textContent.includes('乙组'));
    if (!opt) return 'no-opt';
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return opt.value;
  })()`);
  check('⑱ 找得到「移到…」里的目标分组', () => {
    return ok(moved !== 'no-group' && moved !== 'no-li' && moved !== 'no-select' && moved !== 'no-opt',
      String(moved));
  });
  await sleep(1500);
  const _a13_items = (await j('GET', '/feeds')).data.items;
  check('⑱ 移到乙组之后，库里那个源的 folderId 变成乙组', () => {
    const items = _a13_items;
    const inB = items.filter((x) => x.folderId === 'af_b').map((x) => x.title);
    return ok(inB.length === 3, `乙组现在=${inB.join(',')}（期望 3 个）`);
  });
}

// ── 跨组拖动 → toast + 撤销 ──────────────────────────────
{
  // 先关掉配置弹窗回到侧栏
  await ev(`(() => {
    const close = [...document.querySelectorAll('button')]
      .find((x) => (x.getAttribute('aria-label') || '') === '关闭配置');
    if (close) close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return Boolean(close);
  })()`);
  await sleep(900);
  await reload();

  const dragged = await ev(`(async () => {
    // 把侧栏里一个未分组源拖到「甲组」行上 = 放进该组
    const src = document.querySelector('[data-arrange-kind="loose"]');
    if (!src) return 'missing';
    const sr = src.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, pointerId: 3, pointerType: 'mouse',
                   isPrimary: true, button: 0, buttons: 1 };
    // 同上：按内部 button，不是外层容器
    const srcBtn = src.querySelector('button') || src;
    srcBtn.dispatchEvent(new PointerEvent('pointerdown', {
      ...base, clientX: sr.left + 12, clientY: sr.top + 12 }));
    await new Promise((res) => setTimeout(res, 700));

    // ⚠️ **必须在长按之后重新量目标行**。
    // 进入排列模式会收起手风琴（§15.28 的决定），展开着的子行消失、
    // 整棵树上移几十像素。用长按前量的坐标会落到下面好几行去 ——
    // 实测症状是"拖到甲组却进了丙组"，而代码本身没错。
    const dst = document.querySelector('[data-arrange-kind="folder"][data-arrange-id="af_a"]');
    if (!dst) return 'no-dst';
    const dr = dst.getBoundingClientRect();
    window.dispatchEvent(new PointerEvent('pointermove', {
      ...base, clientX: dr.left + 12, clientY: dr.top + dr.height / 2 }));
    await new Promise((res) => setTimeout(res, 250));
    const into = Boolean(document.querySelector('.nav.tree .into'));
    window.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
    await new Promise((res) => setTimeout(res, 1400));
    const t = document.querySelector('.toast');
    return {
      into,
      toast: t ? {
        text: (t.querySelector('.toast-text')?.textContent ?? '').trim(),
        action: (t.querySelector('.toast-action')?.textContent ?? '').trim(),
      } : null,
    };
  })()`);
  check('跨组拖动：悬停在分组行上时整行高亮（into 态）', () => {
    return ok(dragged !== 'missing' && dragged.into === true, JSON.stringify(dragged));
  });
  check('跨组拖动后弹出 toast，文案含源名与目标组名', () => {
    const t = dragged === 'missing' ? null : dragged.toast;
    return ok(!!t && t.text.includes('散源零') && t.text.includes('甲组'), JSON.stringify(t));
  });
  check('toast 带「撤销」按钮', () => {
    const t = dragged === 'missing' ? null : dragged.toast;
    return ok(!!t && t.action === '撤销', JSON.stringify(t));
  });

  const _a14_items = (await j('GET', '/feeds')).data.items;
  check('拖进甲组之后，那个源的 folderId 变成甲组', () => {
    const items = _a14_items;
    const f = items.find((x) => x.id === 'fx_0');
    return ok(f?.folderId === 'af_a', `folderId=${f?.folderId}`);
  });

  // 点撤销 → 回到未分组
  await ev(`(() => {
    const b = document.querySelector('.toast-action');
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  })()`);
  await sleep(1500);
  const _a15_items = (await j('GET', '/feeds')).data.items;
  check('点「撤销」→ 源回到未分组', () => {
    const items = _a15_items;
    const f = items.find((x) => x.id === 'fx_0');
    return ok(f?.folderId === null, `folderId=${f?.folderId}`);
  });
}

cdp.close();
cleanup();
await sleep(400);
summary('m1-27-arrange');

// 必须显式退出：CDP 的 WebSocket 会让事件循环保持活跃，即使浏览器已被
// killTree 掉 —— 于是脚本打完 PASS 就挂在那儿不返回（m1-26 的注释里
// 记着同一个坑，verify-all 串行跑时会表现为"整套验收停住"）。
process.exit(process.exitCode ?? 0);
