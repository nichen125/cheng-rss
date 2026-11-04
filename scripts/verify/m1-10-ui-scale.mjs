#!/usr/bin/env node
// 控件形状尺度 —— 验收（PLAN §15.12）
//
// 这一节的起点是需求方的一句话：「部分按钮的形状太突兀」。
//
// 为什么必须单独一个脚本：这一节的缺陷**行为断言全是绿的**。按钮点得动、
// 文字没错、接口也通，m0-09/m1-05/m1-06 一条都不会红。它只能靠"量"抓 ——
// 把每个可见控件的圆角、高度、背景从 getComputedStyle 里读出来，
// 按尺寸分档比对。和 §15.8「藏起来和没有在截图上长得一样」是同一类教训：
// 外观缺陷要用度量，不能用点击。
//
// 实测到的四个真缺陷（改之前）：
//   ① 同一个 .btn 类出现 40px 与 42px 两个高度（<button class=btn> 与
//      <a class=btn> 的行盒不同）
//   ② .btn.block.prefs-reset 被自定义 padding 撞出 31px 的意外高度
//   ③ 22px 的迷你图标按钮用 7px 圆角，看着像胶囊
//   ④ 「只看分组·清除」是 129×40 的实心方块（命中全局 button 规则）
//
// 判据：
//   ① 所有可见按钮的圆角都在尺度内 {0, 4, 7, 999}（.seg 内允许 5）
//   ② 同一个 class 的按钮高度唯一
//   ③ 短边 < 24px 的控件圆角必须是 4px（不许跟 32px 的共用 7px）
//   ④ 胶囊控件真的是胶囊（chip），不是固定 14px
//   ⑤ .scope-clear 不是实心块：无背景、无边框、高度 < 28
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { removeDir } from '../lib/tmp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.10 控件形状尺度');

const CANDIDATES = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium'];

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器');
  console.log('        形状尺度必须量真实渲染结果；本机没有则跳过（不算失败）');
  summary('m1-10-ui-scale');
  process.exit(0);
}
if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-scale-'));
const dataDir = join(tmp, 'data');
const port = 45000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;

const srv = spawn(binPath, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
srv.stdout.on('data', () => { /* drain */ });

let ready = false;
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* not yet */ }
  await sleep(250);
}
check('服务就绪', () => ok(ready, srvErr.slice(0, 300)));

const cleanup = () => {
  killTree(srv.pid);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
if (!ready) { cleanup(); summary('m1-10-ui-scale'); process.exit(1); }

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'scale@test.local', password: 'scaletest12345' }),
});
const loginRes = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'scale@test.local', password: 'scaletest12345' }),
});
const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

// ── 造数据：一个组 3 个源（够展开出 3 个子行），一个组 1 个源 ────
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
const folderA = 'fld_scale_a';
const folderB = 'fld_scale_b';
db.prepare(`INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)`)
  .run(folderA, uid, '科技IT', 0);
db.prepare(`INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)`)
  .run(folderB, uid, '独立博客', 1);

const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?)`);
insFeed.run('sf_1', uid, 'https://s1.example.com/feed', 'https://s1.example.com', '源一', Date.now(), Date.now(), folderA);
insFeed.run('sf_2', uid, 'https://s2.example.com/feed', 'https://s2.example.com', '源二', Date.now(), Date.now(), folderA);
insFeed.run('sf_3', uid, 'https://s3.example.com/feed', 'https://s3.example.com', '源三', Date.now(), Date.now(), folderA);
insFeed.run('sf_4', uid, 'https://s4.example.com/feed', 'https://s4.example.com', '独苗', Date.now(), Date.now(), folderB);

const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,?)`);
for (const [fid, n] of [['sf_1', 3], ['sf_2', 2], ['sf_3', 2], ['sf_4', 2]]) {
  for (let i = 0; i < n; i++) {
    insEntry.run(`se_${fid}_${i}`, uid, fid, `g_${fid}_${i}`,
      `https://${fid}.example.com/${i}`, `${fid}.example.com/${i}`,
      `${fid} 的条目 ${i}`, '摘要一段', 1700000000000 + i, Date.now(), '测试');
  }
}
db.exec('COMMIT');
db.close();

// ── 浏览器 ─────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'cheng-rss-scaleprof-'));
const cdpPort = 9600 + Math.floor(Math.random() * 200);
const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,960', 'about:blank',
], { stdio: 'ignore' });

const killBrowser = () => {
  killTree(proc.pid);
  removeDir(profile);
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
  summary('m1-10-ui-scale');
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
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
const evaluate = async (expr) => {
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

const goto = async () => {
  await send('Page.navigate', { url: `${base}/` });
  for (let i = 0; i < 80; i++) {
    if (await evaluate('document.readyState === "complete"').catch(() => false)) break;
    await sleep(150);
  }
  await sleep(1200);
};
await goto();

// 采样函数：把页面上每个可见控件的外形读出来。
// 按 className+label 去重 —— 30 个列表行不需要量 30 次。
const PROBE = `(() => {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('button, a.btn, a.icon-btn, [role=button]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    const label = (el.getAttribute('title') || el.textContent || '').trim().slice(0, 20);
    const key = el.className + '|' + label;
    if (seen.has(key)) continue;
    seen.add(key);
    // 四个角必须一致，出现不对称多半是随手写了一个 "16px 16px 0 0"
    const corners = [cs.borderTopLeftRadius, cs.borderTopRightRadius,
      cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
    const px = (v) => parseFloat(v) || 0;
    out.push({
      cls: String(el.className),
      label,
      w: Math.round(r.width),
      h: Math.round(r.height),
      radius: px(corners[0]),
      cornersSame: corners.every((c) => px(c) === px(corners[0])),
      hasBg: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent',
      borderW: px(cs.borderTopWidth),
      inSeg: Boolean(el.closest('.seg')),
      font: cs.fontSize,
      rawCorners: corners,
    });
  }
  return out;
})()`;

const collect = async () => {
  const pages = {};
  // A. 列表页（含侧栏导航项、行内迷你按钮）
  pages.list = await evaluate(PROBE);

  // B. 选中分组 → 侧栏分组树展开、组内源作为子行出现（v1.13 起，§15.13）
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.tree-row')]
      .find((x) => (x.querySelector('.nav-label')?.textContent ?? '').includes('科技IT'));
    if (b) b.click();
    return Boolean(b);
  })()`);
  await sleep(1400);
  pages.folder = await evaluate(PROBE);
  // v1.13：分组内的源不再是列表头部的 chip 行，而是侧栏树里的子行。
  // 这个数（组内 3 个源 → 3 个子行）下面用来证明"点的确实是分组视图"，
  // 否则「清除按钮存在」那条可能在收件箱下就通过了。
  const leafCount = await evaluate(`document.querySelectorAll('.tree-leaf').length`);
  // 清除按钮只在这个视图下存在，必须在切走之前量 ——
  // 第一版把它放在 collect() 之后量，那时已经跳到订阅页，
  // 于是「按钮不存在」红的是测试自己，不是实现（§15.8 同类坑）。
  const scopeClear = await evaluate(`(() => {
    const el = document.querySelector('.scope-clear');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      bg: cs.backgroundColor,
      borderW: parseFloat(cs.borderTopWidth) || 0,
      text: (el.textContent || '').trim(),
      hasIcon: Boolean(el.querySelector('svg')),
      title: el.getAttribute('title'),
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
    };
  })()`);

  // C. 阅读区 + 偏好面板（segment 按钮在这里）
  await evaluate(`(async () => {
    const row = document.querySelector('.entry-item');
    if (row) row.click();
    await new Promise((r) => setTimeout(r, 1500));
  })()`);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.reader-bar .icon-btn')]
      .find((x) => (x.getAttribute('title') || '').includes('阅读设置'));
    if (b) b.click();
    return Boolean(b);
  })()`);
  await sleep(500);
  pages.reader = await evaluate(PROBE);

  // D. 订阅管理（v1.13：在配置弹窗的「订阅」分类里，不再是侧栏的一个页）
  await evaluate(`(() => {
    const gear = [...document.querySelectorAll('.icon-btn')]
      .find((x) => (x.getAttribute('title') || '').includes('配置'));
    if (gear) gear.click();
    return Boolean(gear);
  })()`);
  await sleep(1300);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find((x) => (x.textContent || '').trim().includes('订阅'));
    if (b) b.click();
    return Boolean(b);
  })()`);
  await sleep(900);
  pages.feeds = await evaluate(PROBE);

  return { pages, leafCount, scopeClear };
};

const { pages, leafCount, scopeClear } = await collect();

// 采样必须真的采到东西，否则后面所有断言都是空转（§15.8 的教训）
const totalSampled = Object.values(pages).reduce((n, p) => n + p.length, 0);
check('四个页面都采到了控件（否则下面的断言是空转）', () => {
  return ok(totalSampled >= 40 && pages.reader.length > 10 && pages.feeds.length > 10,
    `list=${pages.list.length} folder=${pages.folder.length} `
    + `reader=${pages.reader.length} feeds=${pages.feeds.length}`);
});

// ── ① 圆角必须落在尺度里 ──────────────────────────────────
//
// 尺度：0（共边的列表行）/ 4（<24px 的小控件）/ 7（默认）/
// 999（胶囊）。.seg 容器内的分段按钮额外允许 5（= 7 − 2px 内边距），
// 这是"内圆角跟着外圆角缩"的正确做法，不是随手写的数字。
// 尺度（设计方案 §6）：0（共边的列表行）/ 4（<24px 的小控件）/
// 8（默认控件）/ 999（胶囊）。.seg 内的分段按钮额外允许 5、6
// （= 外圆角 − 容器内边距），这是"内圆角跟着外圆角缩"的正确做法。
//
// 7 → 8 是"现代化"的一部分：7 来自旧版把控件压到 26~30px 的时期，
// 控件长到 32px 之后 7 看起来偏方。判据跟着规格走，不跟着历史走。
const SCALE = [0, 4, 8, 999];
const allButtons = Object.entries(pages).flatMap(([page, list]) => list.map((b) => ({ page, ...b })));
const offScale = allButtons.filter((b) => {
  if (SCALE.includes(b.radius)) return false;
  if (b.inSeg && (b.radius === 5 || b.radius === 6)) return false;
  return true;
});
check('所有可见按钮的圆角都在尺度内（0/4/8/999，.seg 内允许 5-6）', () => {
  if (offScale.length === 0) return ok(true);
  const sample = offScale.slice(0, 6).map((b) => `${b.page}:${b.cls}="${b.label}" r=${b.radius}px`);
  return ok(false, `${offScale.length} 个越界：\n        ${sample.join('\n        ')}`);
});

// ── ② 同一 class 的按钮高度必须唯一 ─────────────────────────
//
// 这是本次修的核心缺陷：<button class="btn"> 是 40px，
// <a class="btn"> 是 42px，因为 .btn 把 display 从 inline-block 改成
// inline-flex 之后行盒高度变了 —— 同类控件两个高度，肉眼就是"突兀"。
const byClass = new Map();
for (const b of allButtons) {
  // 只比"纯类名"，带状态的（active/on/open）不参与，否则同一控件会被拆成两组
  const base = b.cls.split(/\s+/).filter((c) => !/^(active|on|open|read|picked)$/.test(c)).sort().join(' ');
  if (!byClass.has(base)) byClass.set(base, new Map());
  const heights = byClass.get(base);
  if (!heights.has(b.h)) heights.set(b.h, []);
  heights.get(b.h).push(`${b.page}:"${b.label}"`);
}
const unstable = [...byClass.entries()].filter(([, hs]) => hs.size > 1);
check('同一 class 的按钮高度唯一（同类控件不许两个高度）', () => {
  if (unstable.length === 0) return ok(true);
  const detail = unstable.slice(0, 4)
    .map(([cls, hs]) => `${cls} → ${[...hs.entries()]
      .map(([h, who]) => `${h}px(${who.length}个，如 ${who[0]})`).join(' / ')}`);
  return ok(false, detail.join('\n        '));
});

// ── ③ 小控件用小圆角 ──────────────────────────────────────
//
// 22px 的图标按钮配 8px 圆角，观感接近胶囊；它必须用 4px。
// 判据写成"短边 < 24px 只能 4px"，而不是"不能等于 8px" —— 前者能顺带
// 抓住以后有人给它写 6px/8px 的情况。
//
// .seg 内的分段按钮排除在外：它们的圆角是"外圆角 − 容器内边距"
// 算出来的（5px），由上面那条尺度断言管，不该同时受这条约束 ——
// 一条缺陷被两条判据分别判红，修的时候会分不清该改哪条。
const tinyControls = allButtons.filter(
  (b) => Math.min(b.w, b.h) < 24 && b.radius > 0 && !b.inSeg,
);
const tinyBad = tinyControls.filter((b) => b.radius !== 4);
check('短边 <24px 的控件圆角必须是 4px（.seg 内的按外圆角推算，另算）', () => {
  if (tinyControls.length === 0) {
    return ok(false, '没采到任何 <24px 的非分段控件，这条断言走了空转路径');
  }
  if (tinyBad.length === 0) return ok(true);
  return ok(false, tinyBad.slice(0, 5)
    .map((b) => `${b.page}:${b.cls} ${b.w}×${b.h} r=${b.radius}`).join('; '));
});

// ── ④ 胶囊必须真的是胶囊 ──────────────────────────────────
//
// chip 原来是写死的 14px：chip 高度一变（手机上字号变小），
// 14px 就会在两端露出直角。改成 999px 之后高度怎么变都是胶囊。
const chips = allButtons.filter((b) => /\bchip\b/.test(b.cls));
check('分组/源筛选的 chip 是胶囊（不是写死的 14px）', () => {
  if (chips.length === 0) return ok(false, '页面上没采到 chip，断言空转');
  const bad = chips.filter((b) => b.radius !== 999);
  return ok(bad.length === 0,
    `采到 ${chips.length} 个 chip，越界 ${bad.length} 个：`
    + bad.slice(0, 3).map((b) => `${b.page}:${b.cls} r=${b.radius}`).join(', '));
});

// ── ⑤ 清除筛选的 × 不能是实心块 ────────────────────────────
//
// 改之前它是 129×40、有背景有边框的方块 —— 因为它命中了全局
// button 规则。这种"漏样式"靠肉眼看不出来，只能量。
check('分组筛选下「清除」按钮存在（否则下一条空转）', () => {
  return ok(scopeClear !== null, '页面上找不到 .scope-clear');
});
check('清除按钮不再是一整块实心按钮（无背景、无边框、< 28px）', () => {
  if (!scopeClear) return ok(false, '按钮不存在');
  const noBg = scopeClear.bg === 'rgba(0, 0, 0, 0)' || scopeClear.bg === 'transparent';
  return ok(noBg && scopeClear.borderW === 0 && scopeClear.h < 28,
    JSON.stringify(scopeClear));
});
check('清除按钮是图标（×）而不是一长串文字', () => {
  if (!scopeClear) return ok(false, '按钮不存在');
  // 图标按钮的 textContent 可以是空的（SVG 没有文字），关键是有 svg 且没有长文案
  return ok(scopeClear.hasIcon && scopeClear.text.length <= 2,
    `hasIcon=${scopeClear.hasIcon} text=${JSON.stringify(scopeClear.text)}`);
});

// ── ⑥ 采样覆盖面自检 ──────────────────────────────────────
//
// 没有这一条，前面几条有可能都在"页面上只有 3 个按钮"的情况下通过。
check('采样覆盖到了各类控件（图标按钮 / 文字按钮 / chip / 分段按钮）', () => {
  const has = (re) => allButtons.some((b) => re.test(b.cls));
  const kinds = {
    iconBtn: has(/\bicon-btn\b/),
    textBtn: has(/\bbtn\b/),
    chip: has(/\bchip\b/),
    seg: allButtons.some((b) => b.inSeg),
    row: has(/\bentry-item\b/),
  };
  return ok(Object.values(kinds).every(Boolean), JSON.stringify(kinds));
});

check('分组里有 3 个源时侧栏树渲染出 3 个子行（与 m1-11 的判据互不重复）', () => {
  return ok(leafCount === 3, `子行数 ${leafCount}（组内 3 个源各一行）`);
});

ws.close();
killBrowser();
summary('m1-10-ui-scale');
cleanup();
process.exit(process.exitCode ?? 0);
