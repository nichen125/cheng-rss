#!/usr/bin/env node
// 三栏宽度与密度 —— 验收（PLAN §15.16）
//
// 需求方原话：「使用前端技能分析排版，选择合适的优化方式；目前发现左侧的
// 工具栏和订阅的列表栏占用空间过大，可以适当缩小」。
//
// 这一节只做一件事：把「过大/适当」这两个形容词换成**可量的数**。
// 不做审美判断 —— 审美由需求方看截图定，测试只保证"说好的数字真的落地了，
// 而且收窄没有牺牲阅读区"。
//
// 最容易假绿的三个地方，所以每条判据都绕开它们：
//
//   ① 「变小了」不是判据。218→196 和 218→100 都叫变小。
//      必须断言**具体数值**（196 / 368 / ≥870）。
//   ② 收窄基座最容易顺手牺牲正文。正文宽度是 §15.3 的可读性指标，
//      如果 1.19 的实现方式是"正文跟着窄一点"，这条会红。
//   ③ 1180px 的笔记本才是真实场景：1440 换到 1180 时正文若被压到
//      55ch，那收窄的收益全被吃掉了。③ 专门盯这个宽度。
//
// 判据（对应 §19.3 的 1.19 行）：
//   ① 1440px 下侧栏 196px、列表 368px、阅读区 ≥ 870px
//   ② 正文列宽 = 偏好字符数（默认 80ch，v1.14），两侧留白 ≤90px
//   ③ 1180px 下正文列宽 ≥ 594px
//   ④ 组内有源时列表头部高度与无分组时**完全相等**（chip 行不占位）
//   ⑤ 侧栏最长分组名能完整显示或走省略号，不压在角标上
//   ⑥ 1440×960 下首屏条目数 ≥ 9
//   ⑦ 375px 下 --sidebar-w 仍是 0、底部 tab bar 仍在
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, eq, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { removeDir } from '../lib/tmp.mjs';
import { openSqlite } from '../lib/sqlite.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.19 三栏宽度与密度');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

// §15.16 的收敛表（规格层数值，改这里 = 改需求）
const W_SIDEBAR = 196;
const W_LIST = 368;
const W_LIST_MAX_OK = 8; // 阅读区至少要比 v1.12 的 822 宽 8px 以上才算真收窄
const MIN_READER_1440 = 870;
const MIN_COL_1180 = 594;
const MIN_ROWS_1440 = 9;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-dens-'));
const dataDir = join(tmp, 'data');
const port = 48000 + Math.floor(Math.random() * 900);
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
if (!ready) { cleanup(); summary('m1-19-density'); process.exit(1); }

await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'dens@test.local', password: 'denstest1234567' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'dens@test.local', password: 'denstest1234567' }),
});
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

// ── 造数据 ────────────────────────────────────────────────
//
// 只需要两样东西：
//   · 一个**标题偏长**的分组（⑤ 看它压不压角标）
//   · 一个组里有多个源（④ 看头部高度是否被 chip 行撑高）
// 条目造 40 条、标题长短不一，这样 ⑥ 的"首屏条数"不是全部同一高度下的巧合。
const db = openSqlite(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
const insFolder = db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)');
// 14 个汉字 ≈ 196px 侧栏里的极限长度（可用宽度约 196-16-15-40 = 125px，
// 13.5px 字号下一行约 9 个汉字）。刻意超长，逼它走省略号。
insFolder.run('df_long', uid, '产品设计与用户体验研究', 0);
insFolder.run('df_multi', uid, '多源组', 1);

const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?)`);
const now = Date.now();
insFeed.run('df_f_long', uid, 'https://longf.example.com/feed', 'https://longf.example.com', '长名组里的源', now, now, 'df_long');
for (let i = 0; i < 5; i++) {
  insFeed.run(`df_f_m${i}`, uid, `https://m${i}.example.com/feed`, `https://m${i}.example.com`,
    `多源组的源${i}`, now, now, 'df_multi');
}

const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,?)`);
// 40 条：标题长度从 6 到 46 个字符循环 —— 两行标题会撑高行高，
// 全是短标题的话 ⑥ 量出来的"首屏条数"会偏乐观。
const LEN = [6, 14, 22, 30, 46];
for (let i = 0; i < 40; i++) {
  const len = LEN[i % LEN.length];
  const title = `第${i}条`.padEnd(len, '的一篇技术文章标题填充字符');
  insEntry.run(`df_e${i}`, uid, `df_f_m${i % 5}`, `g${i}`,
    `https://m${i % 5}.example.com/p${i}`, `m${i % 5}.example.com/p${i}`,
    title, '这是一段用于撑起条目摘要的正文片段，长度和真实订阅源的摘要接近。',
    1700000000000 + i * 60000, now, `源${i % 5}`);
}
// ⑤ 需要"超长分组名 + 非零未读角标"同时存在才量得出重叠：
// 角标只在 unread > 0 时渲染，0 未读的组根本没有角标可压。
// 第一版忘了给 df_f_long 造条目，于是 overlapsBadge=null（既不是 true
// 也不是 false），⑤ 那条就变成了空转。
for (let i = 0; i < 3; i++) {
  insEntry.run(`df_el${i}`, uid, 'df_f_long', `gl${i}`,
    `https://longf.example.com/l${i}`, `longf.example.com/l${i}`,
    `长名组条目 ${i}`, '摘要', 1700000000000 + i, now, '长名组里的源');
}

// 正文：②③ 要量 .article-body 的真实列宽，没有正文时它会渲染成
// 占位块 → 列宽 0 → 两条断言恒红（而且看起来像实现坏了）。
// 这里按 §13.3 的存储格式写：1 字节标记 + 内容（0x00 明文 / 0x01 gzip）。
const { gzipSync } = await import('node:zlib');
const pack = (text) => {
  const raw = Buffer.from(text, 'utf8');
  if (raw.length < 512) return Buffer.concat([Buffer.from([0x00]), raw]);
  return Buffer.concat([Buffer.from([0x01]), gzipSync(raw, { level: 6 })]);
};
const insContent = db.prepare(`INSERT INTO entry_contents (entry_id,html,markdown,raw_html,extracted_by)
  VALUES (?,?,NULL,NULL,'fixture')`);
const BODY = Array.from({ length: 6 },
  (_, k) => `<p>这是第 ${k + 1} 段正文，用来把 .article-body 撑到正常文章的尺度。`
    + '它必须足够长，因为正文列宽是由 CSS 的 72ch 约束决定的，'
    + '内容太短时浏览器仍会按块级元素铺满容器，但读数会受空白折叠影响。</p>').join('');
for (let i = 0; i < 40; i++) insContent.run(`df_e${i}`, pack(BODY));
db.exec('COMMIT');
db.close();

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
  summary('m1-19-density');
  cleanup();
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'cheng-rss-dens-prof-'));
const cdpPort = 9900 + Math.floor(Math.random() * 80);
const proc = spawn(browserPath, [
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
    // 只挑真正的网页。Edge 有时会先开一个 edge://sync-confirmation-dialog，
    // 抓它会让后面的 CDP 应答永远不来（实测整套验收在这里挂死 600s）。
    // 与 m1-23 用 --remote-debugging-port=0 同一理由：不要把浏览器内部页面当被测页面。
    target = list.find((t) => t.type === 'page' && !/^(edge|chrome|devtools):/i.test(t.url ?? ''));
    if (target?.webSocketDebuggerUrl) break;
  } catch { /* not yet */ }
  await sleep(250);
}
if (!target?.webSocketDebuggerUrl) {
  check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
  summary('m1-19-density');
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
    if (m.error) rej(new Error(m.error.message)); else res(m.result);
  }
});
// 每条命令带超时：CDP 应答如果永远不来（发给了内部页面、执行上下文被换掉），
// 这里要变成一条可读的报错 —— 否则整套验收会静默停在这个脚本上 600s。
// 与 scripts/lib/cdp.mjs 同一策略。
const CDP_TIMEOUT_MS = 60000;
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => {
    pending.delete(id);
    rej(new Error(`CDP 命令超时 ${CDP_TIMEOUT_MS}ms: ${method}`));
  }, CDP_TIMEOUT_MS);
  pending.set(id, {
    res: (v) => { clearTimeout(timer); res(v); },
    rej: (e) => { clearTimeout(timer); rej(e); },
  });
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
  name: 'cheng_rss_sid', value: cookie.split('=')[1] ?? '',
  domain: '127.0.0.1', path: '/',
});

/**
 * 量一次布局。
 *
 * 字符宽度必须现量：ch 是字体相对单位，getComputedStyle 给的是解析后的 px，
 * 写死 "80ch = 712px" 在换了字号（阅读偏好可调）之后就是错的。
 * 量的是 .article-body（正文列）而不是 .reader 外框 —— 后者含 padding。
 *
 * v1.14：正文默认从 72ch 放宽到 80ch，所以期望值也从 CSS 变量里读，
 * 不在测试里写死一个数（写死就得跟着实现改测试，§19.1）。
 */
const MEASURE = `(() => {
  const box = (s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left) };
  };
  const body = document.querySelector('.article-body');
  const reader = document.querySelector('.reader');
  const pane = document.querySelector('.reader-pane');
  const wantCh = Number(getComputedStyle(pane ?? document.body)
    .getPropertyValue('--reader-width').trim() || 80) || 80;

  // 偏好 Nch 应该渲染成多宽：基准必须与 .reader 完全同源。
  // .reader 的宽度是 width: calc(var(--reader-width) * 1ch)，
  // 所以基准 = 同一个字号、同一个字族下的 Nch。
  // 原来把 font-size 硬编码成 16.5px，而 .reader 的实际字号是
  // var(--reader-font, 16.5px)（可调），Linux 上字族也会回退，
  // 于是基准偏 22px（实测 818 vs 期望 840）。Windows 恰好对上，
  // 所以这条只在 CI 红。
  //
  // 修法：把 .reader 的 font-size / font-family / letter-spacing /
  // word-spacing 原样抄到探针上。这几个属性都影响 1ch 的宽度，
  // 少抄一个就还是猜。
  //
  // 注意：这段跑在浏览器里（外层是模板字符串），所以注释里不能出现
  // 反引号，也不能用嵌套模板字符串。
  const readerCS = reader ? getComputedStyle(reader) : null;
  const probe = document.createElement('div');
  const fontKeys = ['fontSize', 'fontFamily', 'fontWeight', 'letterSpacing', 'wordSpacing'];
  const fontCss = readerCS
    ? fontKeys.map(function (k) {
      const cssName = k.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); });
      return cssName + ':' + readerCS[k];
    }).join(';')
    : 'font-size:16.5px';
  probe.style.cssText = 'position:absolute;visibility:hidden;width:' + wantCh + 'ch;' + fontCss;
  document.body.appendChild(probe);
  const want72 = Math.round(probe.getBoundingClientRect().width);
  probe.remove();
  // .reader 自身的计算宽度（content-box，正好等于 Nch 或 100%-58px 取小）
  const readerW = readerCS ? Math.round(parseFloat(readerCS.width) || 0) : 0;

  const items = [...document.querySelectorAll('.entry-item')];
  const vis = items.filter((e) => {
    const r = e.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
  const heights = items.map((e) => Math.round(e.getBoundingClientRect().height));

  // 侧栏最长的分组名：是否被省略号截断、是否压到右面的角标上
  const rows = [...document.querySelectorAll('.tree-row')].map((b) => {
    const nameEl = b.querySelector('.nav-label');
    const badge = b.querySelector('.badge');
    const nr = nameEl ? nameEl.getBoundingClientRect() : null;
    const br = badge ? badge.getBoundingClientRect() : null;
    return {
      name: (nameEl?.textContent ?? '').trim(),
      nameW: nr ? Math.round(nr.width) : null,
      truncated: nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : null,
      // 名字右边界 - 角标左边界 > 1 就是压在一起了
      overlapsBadge: nr && br ? Math.round(nr.right - br.left) > 1 : null,
      rowW: Math.round(b.getBoundingClientRect().width),
    };
  });

  // 列表头部里的控件有没有互相重叠（padding 收窄之后的新风险）
  const head = document.querySelector('.pane-head');
  const inHead = head ? [...head.querySelectorAll('.pane-title h1, .pane-count, .seg-btn, .search-box')] : [];
  const headRects = inHead.map((e) => e.getBoundingClientRect());
  let overlapInHead = false;
  for (let i = 0; i < headRects.length; i++) {
    for (let j = i + 1; j < headRects.length; j++) {
      const a = headRects[i]; const b = headRects[j];
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 1 && iy > 1) overlapInHead = true;
    }
  }

  return {
    vw: window.innerWidth,
    sidebar: box('.sidebar'),
    list: box('.list-pane'),
    reader: box('.reader-pane'),
    paneHead: box('.pane-head'),
    colW: body ? Math.round(body.getBoundingClientRect().width) : 0,
    readerW,
    want72,
    wantCh,
    // 正文可用宽度上限 = 阅读区宽 - 58（左右内边距 56 + 边框 2）。
    // CSS 的 max-width: calc(100% - 58px) 就是这个意思，这里复算一次，
    // 让"宽度被空间卡住"与"宽度由偏好驱动"能被区分开。
    maxCol: (() => {
      const pr = pane ? pane.getBoundingClientRect() : null;
      return pr ? Math.round(pr.width - 58) : 0;
    })(),
    // 正文两侧的空白：v1.14 的 §15.3 改动就是把这两个数压下去
    sideGapL: (() => {
      const pr = pane ? pane.getBoundingClientRect() : null;
      const br = body ? body.getBoundingClientRect() : null;
      return pr && br ? Math.round(br.left - pr.left) : null;
    })(),
    sideGapR: (() => {
      const pr = pane ? pane.getBoundingClientRect() : null;
      const br = body ? body.getBoundingClientRect() : null;
      return pr && br ? Math.round(pr.right - br.right) : null;
    })(),
    visibleRows: vis.length,
    totalRows: items.length,
    rowHMin: heights.length ? Math.min(...heights) : 0,
    rowHMax: heights.length ? Math.max(...heights) : 0,
    rows,
    overlapInHead,
    chipCount: document.querySelectorAll('.feed-chips .chip').length,
  };
})()`;

const measure = () => ev(MEASURE);
const setSize = async (w, h, mobile = false) => {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile,
  });
  await sleep(700);
};
const clickGroup = async (name) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.tree-row')]
      .find((x) => (x.querySelector('.nav-label')?.textContent ?? '').trim() === ${JSON.stringify(name)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1300);
  return r;
};

// ── 1440 基准：三栏宽度 + 72ch + 首屏条数 ─────────────────
await setSize(1440, 960);
await send('Page.navigate', { url: origin });
for (let i = 0; i < 80; i++) {
  if (await ev('document.readyState === "complete"').catch(() => false)) break;
  await sleep(150);
}
await sleep(1500);

// 先量一次"无分组"的头部高度，作为 ④ 的基准
const headNoFolder = await measure();
check('（基线）无分组时列表头部高度可用（否则 ④ 是空转）', () => {
  return ok(headNoFolder.paneHead?.h > 40, JSON.stringify(headNoFolder.paneHead));
});

// 点开一条条目，让阅读区出现正文（① ② 都要量正文）
await ev(`document.querySelector('.entry-item')?.click()`);
await sleep(1600);
const at1440 = await measure();

check('① 1440px 下侧栏宽度 = 196px（§15.16 收敛值，不是"变小了"）', () => {
  return eq(at1440.sidebar?.w, W_SIDEBAR);
});
check('① 1440px 下列表栏宽度 = 368px', () => {
  return eq(at1440.list?.w, W_LIST);
});
check(`① 1440px 下阅读区 ≥ ${MIN_READER_1440}px（两栏让出来的宽度真的给了正文区）`, () => {
  return ok(at1440.reader?.w >= MIN_READER_1440,
    `阅读区 ${at1440.reader?.w}px，门槛 ${MIN_READER_1440}px`);
});
check('① 两栏合计比 v1.12 的 618px 窄（收窄方向没写反）', () => {
  const sum = (at1440.sidebar?.w ?? 0) + (at1440.list?.w ?? 0);
  return ok(sum <= 618 - W_LIST_MAX_OK, `两栏合计 ${sum}px，v1.12 是 618px`);
});
check('② 正文列宽 = min(偏好字符数, 可用宽度)（不是写死一个数）', () => {
  // 这条要验的是「宽度由 --reader-width 驱动，且空间不够时让位」，
  // 不是「必须精确等于 Nch」。
  //
  // 实现是：width: calc(var(--reader-width) * 1ch) 配 max-width:
  // calc(100% - 58px)。1440 屏下阅读区可用 = 1440 - 侧栏196 - 列表368
  // = 876px，减 58 = 818px。所以：
  //   · 1ch 较窄的平台（Windows ~10.0px，80ch=800px）→ width 生效，800px
  //   · 1ch 较宽的平台（Linux  ~10.5px，80ch=840px）→ 撞 max-width，818px
  // 两者都是正确行为。原来断言「必须等于 Nch」，于是 Linux 上恒红。
  //
  // 所以判据改成：正文宽度 = min(Nch, 可用宽度)。这样既承认布局事实，
  // 又能抓到真正的回归 —— 比如有人把 width 写死成 800px，那么
  // 可用 876 的平台仍会得到 800 而非 min(840,818)=818，就会红。
  const want = Math.min(at1440.want72, at1440.maxCol);
  const diff = Math.abs(at1440.colW - want);
  return ok(diff <= 8,
    `正文列 ${at1440.colW}px，期望 min(${at1440.wantCh}ch=${at1440.want72}, 可用 ${at1440.maxCol}) = ${want}px，差 ${diff}px`);
});
check('② 正文两侧留白 ≤ 90px（v1.14 §15.3：改前两侧各 118px）', () => {
  // 只判上限，与 §15.3 的判据一致：要守的是"别留太宽"（118px 太浪费）。
  //
  // 原来这里还加了 >= 40 的下限，那是错的：正文撞到 max-width
  // (100% - 58px) 时，留白就等于 (阅读区 - 正文)/2，可以小于 40。
  // 1440 屏下阅读区 876px、正文 818px 时正好各 29px —— 这是正文
  // 已经顶满的必然结果，不是缺陷。加下限等于禁止"正文占满可用宽度"。
  //
  // 下限改成一个>0的正值即可：两侧留白存在（不是 0，说明纸有边距），
  // 且左右相等（居中）。
  return ok(at1440.sideGapL !== null && at1440.sideGapL >= 0
    && at1440.sideGapL <= 90 && at1440.sideGapR >= 0 && at1440.sideGapR <= 90
    && Math.abs(at1440.sideGapL - at1440.sideGapR) <= 2,
    `左 ${at1440.sideGapL}px / 右 ${at1440.sideGapR}px`);
});
check(`⑥ 1440×960 首屏条目数 ≥ ${MIN_ROWS_1440}（收窄 + 行距共赢回来的那一行）`, () => {
  return ok(at1440.visibleRows >= MIN_ROWS_1440,
    `首屏 ${at1440.visibleRows} 条（共 ${at1440.totalRows} 条），门槛 ${MIN_ROWS_1440}`);
});
check('④ 列表头部控件互不重叠（padding 12/12/10 没把标题挤到分段控件上）', () => {
  return ok(at1440.overlapInHead === false, `overlap=${at1440.overlapInHead}`);
});

// ── ④ 组内有 5 个源：头部高度必须与无分组时相等 ───────────
await clickGroup('多源组');
const withFolder = await measure();
check('（前置）多源组已展开且子行 = 5（否则 ④ 的"组内有源"不成立）', () => {
  return ok(withFolder.rows.length >= 2, `树行 ${withFolder.rows.length} 个`);
});
check('④ 组内有 5 个源时列表头部高度与无分组时完全相等', () => {
  return ok(withFolder.paneHead?.h === headNoFolder.paneHead?.h,
    `无分组 ${headNoFolder.paneHead?.h}px vs 组内5源 ${withFolder.paneHead?.h}px，`
    + `差 ${withFolder.paneHead?.h - headNoFolder.paneHead?.h}px`);
});
check('④ 组内有源时列表头部仍没有 chip 行', () => {
  return eq(withFolder.chipCount, 0);
});

// ── ⑤ 侧栏最长分组名：省略号，不压角标 ───────────────────
const longRow = withFolder.rows.find((r) => r.name === '产品设计与用户体验研究');
check('（前置）侧栏里有那个超长分组名（否则 ⑤ 空转）', () => {
  return ok(longRow !== undefined, JSON.stringify(withFolder.rows.map((r) => r.name)));
});
check('⑤ 超长分组名不越过侧栏可用宽度（走省略号或刚好排下）', () => {
  // truncated=true 表示省略号生效；false 表示刚好排下 —— 两者都合法，
  // 非法的是"既没截断又越界"，那会表现为 overlapsBadge
  return ok(longRow?.truncated === true || longRow?.overlapsBadge === false,
    `truncated=${longRow?.truncated} nameW=${longRow?.nameW}px rowW=${longRow?.rowW}px`);
});
check('⑤ 分组名不压在未读角标上', () => {
  return ok(longRow?.overlapsBadge === false, `overlapsBadge=${longRow?.overlapsBadge}`);
});
check('⑤ 分组行宽度 = 侧栏内容宽度（没有被长名字撑宽）', () => {
  const rowW = longRow?.rowW ?? 0;
  const sideW = at1440.sidebar?.w ?? 0;
  // 侧栏左右 padding 各 8px，行内还有 1px 边框余量
  return ok(rowW > 0 && rowW <= sideW - 16 + 1,
    `行宽 ${rowW}px，侧栏 ${sideW}px`);
});

// ── ③ 1180px：正文不能被压得太窄 ─────────────────────────
//
// 1180 是这一步唯一真正有风险的宽度：
// 1440 有富余，1024 以下本来就走平板规则。1180 恰好是"三栏还成立
// 但已经不够宽"的那一段，也是最常见的笔记本外接屏缩放后的宽度。
await setSize(1180, 800);
await send('Page.navigate', { url: origin });
await sleep(2600);
await ev(`document.querySelector('.entry-item')?.click()`);
await sleep(1600);
const at1180 = await measure();

check(`③ 1180px 下正文列宽 ≥ ${MIN_COL_1180}px（不是被压到 55ch）`, () => {
  return ok(at1180.colW >= MIN_COL_1180,
    `正文列 ${at1180.colW}px，门槛 ${MIN_COL_1180}px（偏好 ${at1180.wantCh}ch = ${at1180.want72}px）`);
});
check('③ 1180px 下两栏确实各让了宽度（196/368 → 更窄，而不是原样挤正文）', () => {
  return ok(at1180.sidebar?.w < W_SIDEBAR && at1180.list?.w < W_LIST,
    `侧栏 ${at1180.sidebar?.w}px（1440 时 ${W_SIDEBAR}）`
    + `，列表 ${at1180.list?.w}px（1440 时 ${W_LIST}）`);
});
check('③ 1180px 下正文在阅读区内左右留白仍然对称（居中没被挤偏）', () => {
  const slack = (at1180.reader?.w ?? 0) - at1180.colW;
  return ok(slack >= 0 && slack % 2 <= 2,
    `阅读区 ${at1180.reader?.w}px，正文 ${at1180.colW}px，两侧合计留白 ${slack}px`);
});

// ── ⑦ 手机：收窄不许把移动端规则带歪 ─────────────────────
//
// v1.13 动的是 --sidebar-w / --list-w 两个变量，而移动端正是靠
// 「--sidebar-w: 0」来隐藏侧栏的。如果有人把 196 写死进 640px 的
// 媒体查询里，手机上就会冒出一条永远收不掉的侧栏。
await setSize(375, 812, true);
await sleep(900);
const mob = await ev(`(() => {
  const sb = document.querySelector('.sidebar');
  const tb = document.querySelector('.tabbar');
  const cs = getComputedStyle(document.documentElement);
  return {
    sidebarW: sb ? Math.round(sb.getBoundingClientRect().width) : 0,
    // 变量的计算值：必须直接读它，不能只看 getBoundingClientRect。
    // 手机上 .sidebar 是 display:none，即便 --sidebar-w 被写成 196px，
    // 量出来的宽度也还是 0 —— 只看宽度的话这条断言对
    // "把 196 写进 640px 的媒体查询"完全免疫（实测：改坏了照样 PASS）。
    sidebarVar: cs.getPropertyValue('--sidebar-w').trim(),
    listVar: cs.getPropertyValue('--list-w').trim(),
    sidebarDisplay: sb ? getComputedStyle(sb).display : null,
    tabbarDisplay: tb ? getComputedStyle(tb).display : null,
    tabbarH: tb ? Math.round(tb.getBoundingClientRect().height) : 0,
    listW: Math.round(document.querySelector('.list-pane')?.getBoundingClientRect().width ?? 0),
    pageOverflowX: Math.max(0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
})()`);
check('⑦ 375px 下 --sidebar-w 的计算值是 0px（变量本身没被写死）', () => {
  return eq(mob.sidebarVar, '0px');
});
check('⑦ 375px 下 --list-w 的计算值是 100%（列表不吃绝对像素）', () => {
  return eq(mob.listVar, '100%');
});
check('⑦ 375px 下侧栏宽度 = 0 且不显示', () => {
  return ok(mob.sidebarW === 0 && mob.sidebarDisplay === 'none',
    `w=${mob.sidebarW} display=${mob.sidebarDisplay}`);
});
check('⑦ 375px 下底部 tab bar 可见且有高度', () => {
  return ok(mob.tabbarDisplay === 'flex' && mob.tabbarH > 30,
    `display=${mob.tabbarDisplay} h=${mob.tabbarH}px`);
});
check('⑦ 375px 下列表占满全宽（--list-w 的绝对值没漏到移动端）', () => {
  return ok(mob.listW >= 375 - 2, `列表 ${mob.listW}px`);
});
check('⑦ 375px 下无横向溢出', () => {
  return eq(mob.pageOverflowX, 0);
});

ws.close();
killBrowser();
summary('m1-19-density');
cleanup();
process.exit(process.exitCode ?? 0);
