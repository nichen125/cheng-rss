#!/usr/bin/env node
// 配置台尺度 —— 验收（PLAN §15.15 的设置页）
//
// 这个脚本只守**四条会真的坏掉的**约束，不守"好看"：
//
//   ① 行内操作图标的命中区不互相压盖。
//      `.icon-btn::after` 把命中区撑到 44×44，那是给孤立按钮设计的。一排相邻
//      按钮上，两个 44 的矩形会重叠 —— DOM 靠后的赢，于是"点左边那个的右沿"
//      会落到右边的邻居上。这是**点错**，不是不好看，所以必须有断言。
//   ② 行内操作静止时不是完全透明。
//      0 的元素拿到键盘焦点时仍然看不见；而且它会让"键盘用户能不能发现这些按钮"
//      这件事静默退化成灰。55% 与 0 的差别，只有度量能分清。
//   ③ 配置台内容区底色 ≠ 卡片底色。
//      两者同为纯白时，层次只能由 1px 描边承担 —— 四张卡叠起来会被读成一张表。
//   ④ 禁用态的主按钮仍然读得出字。
//      主按钮的字是白的、底色是主色；禁用只换底色不换字色，就会渲染成
//      "白字压白底 + 一个蓝框"。而「保存 Key」在没输入 key 时就处于禁用态 ——
//      也就是它最常被看到的样子。这条用**对比度**判，不写死色值：
//      色值会随主题变，对比度不会。
//
// 刻意不做的：字号种类数、控件高度的具体档位。它们是设计意图，不是不变量；
// 写进断言只会让下一次有意调整（比如新增一档 32px 的大输入框）被迫改测试，
// 而测试改多了就没人看它了。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { findBrowser, launchBrowser, connectCdp } from '../lib/cdp.mjs';
import { openSettings } from '../lib/ui.mjs';
import { openSqlite } from '../lib/sqlite.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(root, 'dist', process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`);

group('1.28 配置台尺度');

if (!existsSync(BIN)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-scale-cfg-'));
const dataDir = join(tmp, 'data');
const port = 48500 + Math.floor(Math.random() * 300);
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
if (!ready) { cleanup(); summary('m1-28-settings-scale'); process.exit(1); }

await fetch(`${API}/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 's@test.local', password: 'scaletest1234567' }),
});
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 's@test.local', password: 'scaletest1234567' }),
});
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

// ── 造数据：两个分组、三个源。够撑出一张组卡 + 多行 ──────────
const db = openSqlite(join(dataDir, 'app.db'));
const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id;
const now = Date.now();

db.exec('BEGIN IMMEDIATE');
const insF = db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)');
insF.run('cf_a', uid, '科技IT', 0);
insF.run('cf_b', uid, '独立博客', 1);

const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?)`);
insFeed.run('cf_a0', uid, 'https://a0.example.com/feed', 'https://a0.example.com', '源甲零', now, now, 'cf_a');
insFeed.run('cf_a1', uid, 'https://a1.example.com/feed', 'https://a1.example.com', '源甲一', now, now, 'cf_a');
insFeed.run('cf_b0', uid, 'https://b0.example.com/feed', 'https://b0.example.com', '源乙零', now, now, 'cf_b');

const insE = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,?)`);
let n = 0;
for (const [fid, site] of [['cf_a0', '源甲零'], ['cf_a1', '源甲一'], ['cf_b0', '源乙零']]) {
  for (let i = 0; i < 3; i++) {
    n++;
    insE.run(`ce${n}`, uid, fid, `cg${n}`, `https://c.example.com/${n}`, `c/${n}`,
      `${site} 的条目 ${i}`, '摘要一段', 1700000000000 + n, now, site);
  }
}
db.exec('COMMIT');
db.close();

// ── 浏览器 ────────────────────────────────────────────────
const browser = findBrowser();
if (!browser) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器，跳过 UI 断言');
  cleanup();
  summary('m1-28-settings-scale');
  process.exit(0);
}

const b1 = await launchBrowser({ profilePrefix: 'cheng-rss-scale-cfg-', width: 1440, height: 960 });
onExit(b1.close);
if (!b1.wsUrl) {
  check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
  cleanup();
  summary('m1-28-settings-scale');
  process.exit(1);
}
const { send, evaluate: ev, close: closeCdp } = await connectCdp(b1.wsUrl);

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
await send('Page.navigate', { url: origin });
for (let i = 0; i < 80; i++) {
  if (await ev('document.readyState === "complete"').catch(() => false)) break;
  await sleep(150);
}
await sleep(1500);

const opened = await openSettings(ev, { section: '订阅', sleep });
check('配置 › 订阅 可打开', () => ok(opened.opened, JSON.stringify(opened)));
await sleep(900);

// ── ① ② 行内操作 ──────────────────────────────────────────
const ops = await ev(`(() => {
  const row = document.querySelector('.settings-pane:not([hidden]) .feed-row');
  if (!row) return null;
  const icons = [...row.querySelectorAll('.feed-ops .icon-btn')]
    .filter((b) => getComputedStyle(b).display !== 'none');
  if (icons.length < 2) return { count: icons.length, pitch: null };
  const boxes = icons.map((b) => b.getBoundingClientRect());
  const after = icons.map((b) => parseFloat(getComputedStyle(b, '::after').width) || 0);
  // 相邻两个的命中矩形中心距，以及两者半宽之和
  const pairs = [];
  for (let i = 1; i < boxes.length; i++) {
    const pitch = (boxes[i].left + boxes[i].width / 2) - (boxes[i - 1].left + boxes[i - 1].width / 2);
    pairs.push({ pitch: Math.round(pitch * 10) / 10, need: Math.round((after[i] + after[i - 1]) / 2 * 10) / 10 });
  }
  return {
    count: icons.length,
    pitch: pairs[0]?.pitch ?? null,
    need: pairs[0]?.need ?? null,
    overlap: pairs.filter((p) => p.pitch < p.need - 0.5),
    opacity: Number(getComputedStyle(icons[0]).opacity),
    colors: icons.map((b) => getComputedStyle(b).opacity),
  };
})()`);
check('订阅行渲染出了行内操作（否则下面两条是空转）', () => ok(ops && ops.count >= 2, JSON.stringify(ops)));

check('相邻操作图标的命中区不互相压盖', () => {
  if (!ops || ops.pitch === null) return ok(false, '没采到相邻按钮');
  return ok(ops.overlap.length === 0,
    JSON.stringify(ops.overlap.length ? ops.overlap : { pitch: ops.pitch, need: ops.need }));
});

check('行内操作静止时不完全透明（opacity > 0）', () => {
  if (!ops) return ok(false, '没采到操作按钮');
  return ok(ops.opacity > 0, `opacity ${ops.opacity}`);
});

// ── ③ 底色分层 ────────────────────────────────────────────
// 订阅页的"卡片"是 .feed-group，AI 页的是 .settings-card —— 两层是同一个意思，
// 所以选择器把两者都算上，否则换一个分类跑这条断言就会变成空转。
const layers = await ev(`(() => {
  const pane = document.querySelector('.settings-pane:not([hidden])');
  const body = document.querySelector('.settings-body');
  const card = pane ? pane.querySelector('.settings-card, .feed-group') : null;
  return {
    body: body ? getComputedStyle(body).backgroundColor : null,
    card: card ? getComputedStyle(card).backgroundColor : null,
  };
})()`);
check('取到内容区与卡片两层的底色', () => ok(!!layers?.body && !!layers?.card, JSON.stringify(layers)));
check('内容区底色与卡片底色不同（层次靠底色，不靠描边）', () => {
  if (!layers?.body || !layers?.card) return ok(false, '没取到底色');
  return ok(layers.body !== layers.card, `body ${layers.body} / card ${layers.card}`);
});

// ── ④ 禁用态主按钮的可读性 ────────────────────────────────
// 换到 AI 分类：那里有「保存 Key」，未输入时是禁用态。
const toAi = await ev(`(() => {
  const b = [...document.querySelectorAll('.settings-nav-item')]
    .find((x) => (x.textContent || '').trim().includes('AI 分析'));
  if (!b) return false;
  b.click();
  return true;
})()`);
check('可切到 AI 分类', () => ok(toAi === true));
await sleep(900);

const disabled = await ev(`(() => {
  const el = [...document.querySelectorAll('.settings-pane:not([hidden]) .settings-card .btn.primary')]
    .find((b) => b.disabled);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const num = (s) => (s.match(/[\\d.]+/g) ?? []).map(Number);
  const fg = num(cs.color);
  const bg = num(cs.backgroundColor);
  const op = Number(cs.opacity);
  const mix = [0, 1, 2].map((i) => fg[i] * op + bg[i] * (1 - op));
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const L1 = lum(mix);
  const L2 = lum(bg.slice(0, 3));
  return {
    ratio: Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100,
    color: cs.color,
    bg: cs.backgroundColor,
    opacity: op,
    label: (el.textContent ?? '').trim(),
  };
})()`);
check('存在一个禁用态的主按钮（否则第 ④ 条是空转）', () => ok(!!disabled, JSON.stringify(disabled)));
check('禁用态主按钮的文字对比度 ≥ 2.5:1（读得出来，而不是白字压白底）', () => {
  if (!disabled) return ok(false, '没取到禁用态主按钮');
  return ok(disabled.ratio >= 2.5, JSON.stringify(disabled));
});

cleanup();
// 两件事必须显式做，否则脚本"跑完了却不退出"，整套验收会停在这里：
//   · 关掉 CDP 长连接 —— WebSocket 一直挂着事件循环；
//   · 关掉无头浏览器 —— spawn 出来的子进程同样占着事件循环（onExit 只在真退出时跑）。
// 不写 process.exit()：summary() 已经设好 exitCode，强制 0 会把失败改成通过。
closeCdp();
b1.close();
summary('m1-28-settings-scale');
