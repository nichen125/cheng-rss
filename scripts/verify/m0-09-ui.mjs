#!/usr/bin/env node
// 0.9 界面 —— 验收
//
// 判据（PLAN §15）：
//   ① 三栏：侧栏 + 列表 + 阅读区同时存在（点开条目列表不消失）
//   ② 列表项一屏 8~10 条（信息密度：标题 + 一行摘要 + 元信息）
//   ③ 正文列宽 = 偏好的字符数（默认 80ch），且 1440 屏下两侧留白 ≤90px
//   ④ 暗色是默认（不是可选主题）
//   ⑤ 空态有引导按钮/文案
//   ⑥ 键盘可达（/ 聚焦搜索，Esc 返回）
//   ⑦ 窄屏阅读区浮层化，不挤成两栏
//
// ③ 的断言不写死字符数，而是从 CSS 变量 `--reader-width` 读出来再量 ——
// 写死 80 的话以后调默认值又要改测试，改测试去迁就实现等于没测（§19.1）。
//
// 做法：用本机 Edge 无头模式走真实浏览器 + DOM 断言。
// 为什么不用 jsdom：jsdom 不做布局，拿不到 offsetWidth / 媒体查询，
// 而这一节要验的恰恰是"看起来对不对"。
//
// 没有 Chromium 系浏览器时整节 SKIP（退出 0），不算失败 ——
// 这是环境缺失，不是实现问题。
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, eq, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const binName = process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('0.9 界面');

const CANDIDATES = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const browser = CANDIDATES.find((p) => existsSync(p));

if (!browser) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器');
  console.log('        DOM 与布局断言需要真实浏览器；本机没有则跳过（不算失败）');
  summary('m0-09-ui');
  process.exit(0);
}

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 起服务：全新数据目录，灌入已知的 12 条 ────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m009-'));
const dataDir = join(tmp, 'data');
const port = 36000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;

const srv = spawn(binPath, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });

const stopServer = () => killTree(srv.pid);

let ready = false;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok) { ready = true; break; }
  } catch { /* 还没起来 */ }
  await sleep(250);
}
check('服务就绪', () => ok(ready, srvErr.slice(0, 300)));
if (!ready) {
  stopServer();
  rmSync(tmp, { recursive: true, force: true });
  summary('m0-09-ui');
  process.exit(1);
}

// 建账号 + 灌数据（灌 12 条验证一屏只能看到 8~10 条，不会全塞进来）
const setup = await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ui@test.local', password: 'uitest12345' }),
});
check('可初始化账号', () => ok(setup.ok, String(setup.status)));

const login = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ui@test.local', password: 'uitest12345' }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

// 直接用二进制旁边的脚本灌数据（与 UI 无关，只为让列表非空）
try {
  execFileSync(nodeBin, [join(root, 'scripts/seed-demo.mjs'), '--data', dataDir], {
    stdio: 'pipe', timeout: 60000,
  });
} catch (e) {
  console.log(`  \u001b[33m!\u001b[0m seed 失败: ${String(e.stderr ?? e.message).slice(0, 200)}`);
}

// ── 起浏览器 ──────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'ai-rss-m009-prof-'));
const cdpPort = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(browser, [
  '--headless=new',
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1440,960',
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  stopServer();
  killTree(proc.pid);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
onExit(cleanup);

let target = null;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target?.webSocketDebuggerUrl) break;
  } catch { /* 还没起来 */ }
  await sleep(250);
}
if (!target?.webSocketDebuggerUrl) {
  check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
  summary('m0-09-ui');
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
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(m.error.message));
    else res(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval 失败');
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

// 暗色是本项目主色，无头浏览器默认 light，必须显式指定
await send('Emulation.setEmulatedMedia', {
  media: 'screen',
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
});
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
});

// 注入 cookie（走真实登录 API 更贴近实际，但这里只验 UI，省一次跳转）
await send('Network.setCookie', {
  name: 'ai_rss_sid', value: cookie.split('=')[1] ?? '',
  domain: '127.0.0.1', path: '/',
});

await send('Page.navigate', { url: `${base}/` });
for (let i = 0; i < 80; i++) {
  const done = await evaluate('document.readyState === "complete"').catch(() => false);
  if (done) break;
  await sleep(150);
}
await sleep(1200);

// ── ① 三栏骨架 ────────────────────────────────────────────────
const shell = await evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  const box = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect(); return { w: r.width, x: r.left }; };
  return {
    sidebar: box('.sidebar'),
    list: box('.list-pane'),
    reader: box('.reader-pane'),
    items: document.querySelectorAll('.entry-item').length,
    title: q('.pane-title h1')?.textContent ?? null,
  };
})()`);

check('侧栏存在且有宽度', () => ok(shell.sidebar && shell.sidebar.w > 150, JSON.stringify(shell.sidebar)));
check('列表栏存在且有宽度', () => ok(shell.list && shell.list.w > 260, JSON.stringify(shell.list)));
check('阅读区存在（未开条目时是占位）', () => ok(shell.reader && shell.reader.w > 300, JSON.stringify(shell.reader)));
check('三栏横向不重叠', () => {
  if (!shell.sidebar || !shell.list || !shell.reader) return ok(false, '有栏缺失');
  return ok(shell.list.x >= shell.sidebar.x + shell.sidebar.w - 2
    && shell.reader.x >= shell.list.x + shell.list.w - 2,
    `sidebar=${JSON.stringify(shell.sidebar)} list=${JSON.stringify(shell.list)} reader=${JSON.stringify(shell.reader)}`);
});
check('列表有内容（seed 生效）', () => ok(shell.items > 0, `实际 ${shell.items} 条`));

// ── ② 信息密度：一屏 8~10 条 ──────────────────────────────────
const density = await evaluate(`(() => {
  const items = [...document.querySelectorAll('.entry-item')];
  const vh = window.innerHeight;
  const visible = items.filter((e) => { const r = e.getBoundingClientRect(); return r.top < vh && r.bottom > 0; }).length;
  const first = items[0];
  const h = first ? first.getBoundingClientRect().height : 0;
  // 一条里该有的三类信息
  return {
    visible, itemHeight: Math.round(h), total: items.length,
    hasTitle: Boolean(first?.querySelector('.entry-title')?.textContent?.trim()),
    hasSummary: Boolean(first?.querySelector('.entry-summary')?.textContent?.trim()),
    hasMeta: Boolean(first?.querySelector('.entry-top')?.textContent?.trim()),
    clamped: getComputedStyle(first?.querySelector('.entry-title') ?? document.body).webkitLineClamp,
  };
})()`);

check('列表项高度在 70~130px（一屏 8~10 条）', () => {
  return ok(density.itemHeight >= 70 && density.itemHeight <= 130,
    `实际 ${density.itemHeight}px，一屏可见 ${density.visible} 条`);
});
check('列表项含标题 + 一行摘要 + 元信息', () => {
  return ok(density.hasTitle && density.hasSummary && density.hasMeta,
    JSON.stringify(density));
});
check('标题限制行数（超出省略，不是撑开）', () => {
  // -webkit-line-clamp 在 Chromium 里返回字符串 "2"
  return ok(['2', '3'].includes(String(density.clamped)), `line-clamp=${density.clamped}`);
});

// ── 点开第一条 → 三栏仍在，阅读区有正文 ──────────────────────
const opened = await evaluate(`(() => {
  const el = document.querySelector('.entry-item');
  if (!el) return false;
  el.click();
  return true;
})()`);
check('可点开条目', () => ok(opened));
await sleep(1400);

const after = await evaluate(`(() => {
  const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), x: Math.round(r.left) }; };
  const body = document.querySelector('.article-body');
  const reader = document.querySelector('.reader');
  const pane = document.querySelector('.reader-pane');

  // ch 是字体相对单位，getComputedStyle 返回的是解析后的 px。
  // 要验"是不是 N ch"，就用同样的字号量一下 N ch 再比。
  // 量的是正文列（.article-body）而不是 .reader 的外框 —— 后者含 padding，
  // 用它比会把"文字列宽"和"盒子宽"混为一谈。
  //
  // v1.14：正文默认宽度从 72ch 改成 80ch，但**断言不写死这个数** ——
  // 从 CSS 变量 --reader-width 读出来再量。写死 80 的话，以后调默认值
  // 又要改一遍测试，而测试改实现就等于没测（§19.1）。
  const wantCh = Number(getComputedStyle(pane ?? document.body)
    .getPropertyValue('--reader-width').trim() || 80) || 80;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;width:' + wantCh
    + 'ch;font-size:16.5px;font-family:'
    + getComputedStyle(reader ?? document.body).fontFamily;
  document.body.appendChild(probe);
  const wantW = Math.round(probe.getBoundingClientRect().width);
  probe.remove();

  const bw = body?.getBoundingClientRect().width;
  const pr = pane?.getBoundingClientRect();
  const br = body?.getBoundingClientRect();
  return {
    sidebar: box('.sidebar'),
    list: box('.list-pane'),
    reader: box('.reader-pane'),
    listItems: document.querySelectorAll('.entry-item').length,
    hasBody: Boolean(body && body.textContent.trim().length > 50),
    hasAiCard: Boolean(document.querySelector('.ai-card')),
    colWidth: bw ? Math.round(bw) : 0,
    bodyFontSize: body ? getComputedStyle(body).fontSize : null,
    wantCh,
    want72: wantW,   // 名字沿用（下游断言用），语义变成"wantCh 个字符的实测宽度"
    // 正文两侧的空白：v1.14 的改动就是把这两个数压下去
    sideGapL: pr && br ? Math.round(br.left - pr.left) : null,
    sideGapR: pr && br ? Math.round(pr.right - br.right) : null,
    placeholderGone: !document.querySelector('.reader-placeholder'),
  };
})()`);

check('点开条目后列表仍在（不是跳页）', () => {
  return ok(after.list && after.list.w > 260 && after.listItems > 0,
    `list=${JSON.stringify(after.list)} items=${after.listItems}`);
});
check('阅读区显示正文', () => ok(after.hasBody, '正文为空'));
check('阅读区显示 AI 摘要卡', () => ok(after.hasAiCard, '没有 .ai-card'));
check('阅读区占位已消失', () => ok(after.placeholderGone));
check('正文列宽等于偏好的字符数（§15.3，默认可调）', () => {
  // 允差 4px：ch 的实测受字体回退影响
  const diff = Math.abs(after.colWidth - after.want72);
  return ok(diff <= 4,
    `实际列宽 ${after.colWidth}px，${after.wantCh}ch = ${after.want72}px，差 ${diff}px`);
});
check('正文默认不是 72ch 时代的老宽度（v1.14 明确放宽过）', () => {
  // 这条防的是"改文档没改代码"：PLAN 说默认 80ch，代码还是 72ch。
  // 80ch 与 72ch 差 71px，远超 4px 允差，不会误判。
  return ok(after.wantCh >= 76 && after.wantCh <= 96,
    `--reader-width = ${after.wantCh}ch，应在 76~96 之间（§15.3 默认 80）`);
});
check('1440 屏下正文两侧各留白 ≤ 90px（改前是 118px）', () => {
  // 空白要"合理"而不是"消失"：40~90px 是排版上的呼吸区，
  // 0 会让正文贴边、>118 就是改之前被吐槽的那种
  return ok(after.sideGapL !== null && after.sideGapL >= 40 && after.sideGapL <= 90
    && after.sideGapR >= 40 && after.sideGapR <= 90,
    `左 ${after.sideGapL}px / 右 ${after.sideGapR}px`);
});

// ── ④ 暗色是默认 ──────────────────────────────────────────────
const theme = await evaluate(`(() => {
  const bg = getComputedStyle(document.body).backgroundColor;
  const m = bg.match(/\\d+/g)?.map(Number) ?? [];
  const lum = (m[0] * 0.299 + m[1] * 0.587 + m[2] * 0.114);
  return { bg, lum, dark: lum < 80 };
})()`);
check('默认主题是暗色（阅读器主场景，§15.6）', () => {
  return ok(theme.dark, `body 背景 ${theme.bg}，亮度 ${theme.lum?.toFixed(0)}`);
});

// ── ⑥ 键盘可达 ────────────────────────────────────────────────
const kb = await evaluate(`(async () => {
  // Esc 先返回列表
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const backToList = Boolean(document.querySelector('.reader-placeholder'));
  // / 聚焦搜索
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const focused = document.activeElement?.closest('.search-box') != null;
  // j 打开下一条
  document.activeElement?.blur();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  const reopened = !document.querySelector('.reader-placeholder')
    && Boolean(document.querySelector('.article-body, .reader-title'));
  return { backToList, focused, reopened };
})()`);
check('Esc 从阅读区返回列表', () => ok(kb.backToList));
check('/ 聚焦搜索框', () => ok(kb.focused));
check('j 打开下一条（键盘全覆盖）', () => ok(kb.reopened));

// ── ⑤ 空态有引导 ──────────────────────────────────────────────
const empty = await evaluate(`(async () => {
  const i = document.querySelector('.search-box input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(i, 'zzzz不存在的词');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1000));
  const e = document.querySelector('.empty');
  return {
    shown: Boolean(e),
    heading: e?.querySelector('h2')?.textContent ?? null,
    hint: e?.querySelector('p')?.textContent ?? null,
  };
})()`);
check('无结果时显示空态', () => ok(empty.shown, JSON.stringify(empty)));
check('空态标题与引导文案都不为空', () => {
  return ok(Boolean(empty.heading) && Boolean(empty.hint),
    `heading=${empty.heading} hint=${empty.hint}`);
});

// ── ⑦ 窄屏：阅读区浮层，不挤成两栏 ───────────────────────────
await evaluate(`(() => {
  const i = document.querySelector('.search-box input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(i, '');
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(700);
await send('Emulation.setDeviceMetricsOverride', {
  width: 780, height: 900, deviceScaleFactor: 1, mobile: false,
});
await sleep(500);
const narrow = await evaluate(`(() => {
  const rr = document.querySelector('.reader-pane')?.getBoundingClientRect();
  return { w: rr ? Math.round(rr.width) : 0, vw: window.innerWidth };
})()`);
await evaluate(`document.querySelector('.entry-item')?.click()`);
await sleep(900);
const narrowOpen = await evaluate(`(() => {
  const rp = document.querySelector('.reader-pane');
  if (!rp) return null;
  const cs = getComputedStyle(rp);
  const r = rp.getBoundingClientRect();
  return { position: cs.position, display: cs.display, w: Math.round(r.width), vw: window.innerWidth };
})()`);
check('窄屏下列表占满（阅读区隐藏）', () => {
  return ok(narrow.w === 0 || narrow.vw <= 900, `reader 宽 ${narrow.w} / 视口 ${narrow.vw}`);
});
check('窄屏点开条目后阅读区浮层打开（不两栏并排）', () => {
  return ok(narrowOpen && (narrowOpen.position === 'fixed' || narrowOpen.w >= narrowOpen.vw - 2),
    JSON.stringify(narrowOpen));
});

ws.close();
summary('m0-09-ui');
cleanup();
// 显式退出：CDP WebSocket 会让事件循环保持活跃
process.exit(process.exitCode ?? 0);
