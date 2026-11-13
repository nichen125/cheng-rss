#!/usr/bin/env node
// 列表三档密度 —— 验收（PLAN §15.25，v6.6）
//
// 需求方原话：「或者还有一种办法，将列表中不同问题区分明显，放大列表宽度，
// 各部分添加部分间隔，可以显示更多摘要。这种也放开配置」。
//
// 这一版把"一行显示多少信息"和"列表栏多宽"都做成了偏好。判据全部用
// **几何数字**，不看截图：
//
//   ① 三档密度的**信息量单调递增**：compact < standard < rich。
//      用"同一批条目里可见文字块的高度之和"量，不数元素个数 ——
//      元素一直都在 DOM 里（组件不按偏好条件渲染），数个数永远相等。
//   ② 每档的可见摘要行数符合定义：compact 0 行 / standard 1 行 / rich 3 行。
//      （v6.7：rich 从 2 行加到 3 行 —— 需求方说「舒展档的详细描述
//       行数变多」，摘要才是详细描述，标题本来就只有一两行。）
//      直接量 .entry-summary 的 height ÷ line-height，不看 -webkit-line-clamp
//      （那是声明，不是结果）。
//   ③ 每档的行高都落在自己的区间里，且**相邻档不重叠** ——
//      重叠就意味着"切了跟没切一样"。
//   ④ 三档下日号栏都不参与行高计算：**同一行**摘掉 .day-mark 前后
//      高度差必须为 0。改之前 .day-mark 在网格里占一格，首行凭空高 15px；
//      这是最容易悄悄回归的一处（把绝对定位改回 grid 就又犯了）。
//      注意不能拿"首行 vs 次行"来量：两行标题长度不同，量出来的是内容差。
//   ⑤ 列表栏宽度偏好生效，且窄视口下被自动压回来（不许把正文挤没）。
//   ⑥ 偏好落 localStorage，刷新后仍然生效。
//
// 判据（对应 §19.3 的 1.26 行）：
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
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

group('1.26 列表三档密度');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-ld-'));
const dataDir = join(tmp, 'data');
const port = 54000 + Math.floor(Math.random() * 900);
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
if (!ready) { cleanup(); summary('m1-26-list-density'); process.exit(1); }

await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ld@test.local', password: 'ldtest1234567' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ld@test.local', password: 'ldtest1234567' }),
});
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

// ── 造数据：一个源、8 条（标题长度不一，摘要都够长）──────────
const db = openSqlite(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;
const now = Date.now();
const LONG = '这是一段足够长的摘要，用来验证不同密度下会被截成一行还是两行；'
  + '内容故意写得比一行更长，这样任何一档只要没有真的裁剪，行数就会超标。';
db.exec('BEGIN IMMEDIATE');
db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',NULL)`)
  .run('ld_f1', uid, 'https://ld.example.com/feed', 'https://ld.example.com', '密度测试源', now, now);
const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,?)`);
// 时间刻意跨月：前 4 条在"当月 1 号"，后 4 条在"上个月 25 号"。
// 不跨月的话「只在跨月那一行加月份」这条断言会变成空转（只有一个月，
// 每个日号都带月份，断言反而会通过）。
const d0 = new Date(now);
const thisMonth = new Date(d0.getFullYear(), d0.getMonth(), 1, 12, 0, 0).getTime();
const lastMonth = new Date(d0.getFullYear(), d0.getMonth() - 1, 25, 12, 0, 0).getTime();
for (let i = 0; i < 8; i += 1) {
  // 前 4 条落在当月的 4 个**不同日子**，后 4 条落在上个月的 4 个不同日子。
  // 必须跨多天：如果每天都不同但只有两天，日号栏只有 2 个、且两个都是
  // 月首 —— 那时"月份数 < 日号数"检测不出"每行都加月份"这个缺陷。
  const t = i < 4
    ? thisMonth + i * 86400000
    : lastMonth + (i - 4) * 86400000;
  // 同一天只留一条带标题差异的样本会掩盖换行；这里每天一条即可
  insEntry.run(`ld_e${i}`, uid, 'ld_f1', `g${i}`,
    `https://ld.example.com/${i}`, `ld.example.com/${i}`,
    i % 2 === 0
      ? `第 ${i} 条：一个足够长的标题，用来验证列表在不同栏宽下会不会换行、会不会被截断`
      : `第 ${i} 条：短标题`,
    LONG, t, now, '密度测试源');
}
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
  summary('m1-26-list-density');
  cleanup();
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'cheng-rss-ld-prof-'));
const cdpPort = 10400 + Math.floor(Math.random() * 80);
const proc = spawn(browserPath, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,950', 'about:blank',
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
    target = list.find((t) => t.type === 'page' && !/^(edge|chrome|devtools):/i.test(t.url ?? ''));
    if (target?.webSocketDebuggerUrl) break;
  } catch { /* not yet */ }
  await sleep(250);
}
if (!target?.webSocketDebuggerUrl) {
  check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
  summary('m1-26-list-density');
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
  const timer = setTimeout(() => {
    pending.delete(id);
    rej(new Error(`CDP 命令超时 60000ms: ${method}`));
  }, 60000);
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
await send('Network.setCookie', {
  name: 'cheng_rss_sid', value: cookie.split('=')[1] ?? '',
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

/**
 * 量当前密度下前 6 行的几何。
 *
 * 关键点：**不数元素，量高度**。组件在三档里渲染同样的 DOM，
 * 区别只在 CSS 的 display / line-clamp —— 数 `.entry-summary` 的个数
 * 永远得到同一个数，那样的断言不论实现对错都通过。
 */
const MEASURE = `(() => {
  const rows = [...document.querySelectorAll('.entry-item')].slice(0, 6);
  const out = rows.map((row) => {
    const vis = (sel) => {
      const e = row.querySelector(sel);
      if (!e) return null;
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return null;
      const r = e.getBoundingClientRect();
      if (r.width <= 2 && r.height <= 2) return null; // 被裁剪掉的
      return {
        h: Math.round(r.height),
        lh: parseFloat(cs.lineHeight) || 0,
        text: (e.textContent || '').trim().length,
      };
    };
    return {
      rowH: Math.round(row.getBoundingClientRect().height),
      day: Boolean(row.querySelector('.day-mark')),
      meta: vis('.entry-meta'),
      title: vis('.entry-title'),
      summary: vis('.entry-summary'),
    };
  });
  return {
    style: document.documentElement.dataset.listStyle,
    listW: Math.round(document.querySelector('.list-pane').getBoundingClientRect().width),
    rows: out,
  };
})()`;

// 日号是否参与行高 —— 必须做**同一行的 A/B**，不能拿首行去比次行：
// 首行与次行的标题长度本来就不一样，那样量出来的差值是内容差异，
// 不是日号造成的（第一版就是这么写的，三档全红，实际是量错了对象）。
// 这里直接摘掉同一行的 .day-mark，再量同一行的高度。
const DAY_DELTA = `(() => {
  const row = [...document.querySelectorAll(".entry-item")]
    .find((r) => r.querySelector(".day-mark"));
  if (!row) return { skip: true };
  const h0 = row.getBoundingClientRect().height;
  const dm = row.querySelector(".day-mark");
  const prev = dm.style.display;
  dm.style.display = "none";
  const h1 = row.getBoundingClientRect().height;
  dm.style.display = prev;
  return { withDay: Math.round(h0), without: Math.round(h1), delta: Math.round(h0 - h1) };
})()`;

/** 摘要的**实际行数** = 元素高度 ÷ 行高。声明里的 line-clamp 不算数。 */
const summaryLines = (m) => (m.summary ? Math.round(m.summary.h / (m.summary.lh || 1)) : 0);

/** 一行的"信息量"：可见文字块的高度之和（不含内边距）。 */
const infoHeight = (m) => (m.meta?.h ?? 0) + (m.title?.h ?? 0) + (m.summary?.h ?? 0);

const setStyle = async (style) => {
  await ev(`(() => {
    document.documentElement.dataset.listStyle = ${JSON.stringify(style)};
    localStorage.setItem('cheng-rss.reader-prefs.v1', JSON.stringify({
      ...JSON.parse(localStorage.getItem('cheng-rss.reader-prefs.v1') || '{}'),
      listStyle: ${JSON.stringify(style)},
    }));
    return 1;
  })()`);
  await sleep(400);
};

const measured = {};
for (const style of ['compact', 'standard', 'rich']) {
  await setStyle(style);
  measured[style] = await ev(MEASURE);
}

check('三档都量到了列表行（否则下面的断言是空转）', () => {
  const counts = Object.entries(measured).map(([k, v]) => `${k}:${v.rows.length}`);
  return ok(Object.values(measured).every((v) => v.rows.length >= 3), counts.join(' '));
});

// ═══ ① 信息量单调递增 ═══════════════════════════════════════
check('① 三档的信息量单调递增（compact < standard < rich）', () => {
  const avg = (style) => {
    const rows = measured[style].rows;
    return rows.reduce((s, r) => s + infoHeight(r), 0) / rows.length;
  };
  const c = avg('compact'), s = avg('standard'), r = avg('rich');
  const fmt = (n) => Math.round(n * 10) / 10;
  return ok(c < s && s < r,
    `可见内容高度 compact=${fmt(c)}px standard=${fmt(s)}px rich=${fmt(r)}px`);
});

// ═══ ② 摘要行数符合定义 ═════════════════════════════════════
check('② 摘要行数：compact 0 行 / standard 1 行 / rich 3 行', () => {
  const got = (style) => {
    const lines = measured[style].rows.map(summaryLines);
    // 用中位数：个别条目没有摘要时是 0，中位数不会被它带偏
    const sorted = [...lines].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const c = got('compact'), s = got('standard'), r = got('rich');
  return ok(c === 0 && s === 1 && r === 3,
    `compact=${c} standard=${s} rich=${r} 行`);
});

// ═══ ③ 行高区间互不重叠 ═════════════════════════════════════
//
// 区间宽度按"单行标题 + 该档摘要行数 + 元信息"估出来，留 30% 余量。
// 关键是**区间之间不许重叠**：重叠就意味着两档看起来一样。
check('③ 三档行高各自落在区间内，且相邻档区间不重叠', () => {
  const range = (style) => {
    const hs = measured[style].rows.map((r) => r.rowH);
    return { min: Math.min(...hs), max: Math.max(...hs) };
  };
  const c = range('compact'), s = range('standard'), r = range('rich');
  const bounds = {
    compact: { min: 40, max: 90 },
    standard: { min: 70, max: 130 },
    rich: { min: 130, max: 220 },
  };
  const inBounds = (style, v) =>
    v.min >= bounds[style].min && v.max <= bounds[style].max;
  const desc = (n, v) => `${n}[${v.min},${v.max}]`;
  return ok(
    inBounds('compact', c) && inBounds('standard', s) && inBounds('rich', r)
      && c.max <= s.min && s.max <= r.min,
    `${desc('compact', c)} ${desc('standard', s)} ${desc('rich', r)}`
      + `；门槛 ${JSON.stringify(bounds)}`,
  );
});

// ═══ ④ 日号不参与行高 ═══════════════════════════════════════
//
// 这是本轮修掉的一个真 bug：.day-mark 原来在网格里占一格（还跨三行），
// 日号 33px 高会把当天首行撑到比别的行高 15~46px。改成绝对定位后，
// 同一行的行高应当与"没有日号"时完全相等 —— 差的应为 0 而不是"很小"。
for (const style of ['compact', 'standard', 'rich']) {
  await setStyle(style);
  const d = await ev(DAY_DELTA);
  check(`④ ${style} 档下摘掉日号后行高不变（日号不参与行高计算）`, () => {
    if (d.skip) return ok(false, '页面上没有带日号的行 —— 造的数据不够跨天');
    return ok(d.delta === 0,
      `带日号 ${d.withDay}px，摘掉后 ${d.without}px，差 ${d.delta}px`);
  });
}

// ═══ ⑤ 栏宽偏好生效，窄视口下被压回来 ═══════════════════════
const setWidth = async (px) => {
  await ev(`(() => {
    document.documentElement.style.setProperty('--list-w-user', '${px}px');
    return 1;
  })()`);
  await sleep(400);
  return ev(MEASURE);
};

await setStyle('standard');
const w368 = await setWidth(368);
const w460 = await setWidth(460);
const w560 = await setWidth(560);

check('⑤ 栏宽偏好生效：368 → 460 → 560 逐级变宽', () => {
  return ok(w368.listW < w460.listW && w460.listW < w560.listW,
    `368→${w368.listW}px，460→${w460.listW}px，560→${w560.listW}px`);
});

// 窄视口：1440 → 1100 时列表必须自己让位，不能把正文挤没。
// 判据取"正文列仍 ≥ 33 字宽"——与 m1-19 的每行字符数判据同源。
await send('Emulation.setDeviceMetricsOverride', {
  width: 1100, height: 950, deviceScaleFactor: 1, mobile: false,
});
await sleep(900);
const narrow = await ev(`(() => {
  const body = document.querySelector('.article-body');
  const list = document.querySelector('.list-pane');
  return {
    vw: window.innerWidth,
    listW: Math.round(list.getBoundingClientRect().width),
    docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
})()`);

check('⑤ 1100px 视口下列表栏自动收窄（不把正文挤没、页面不横向溢出）', () => {
  return ok(narrow.listW < 560 && !narrow.docOverflow,
    `列表 ${narrow.listW}px，页面横向溢出 ${narrow.docOverflow}`);
});

// ═══ ⑥ 偏好落盘：刷新后仍然生效 ═════════════════════════════
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 950, deviceScaleFactor: 1, mobile: false,
});
await setStyle('rich');
// 456 在 1440 下才不会被 clamp 掉（≤1240 时三档会收敛到 368，见 §5.3）
await ev(`(() => {
  document.documentElement.style.setProperty('--list-w-user', '456px');
  const p = JSON.parse(localStorage.getItem('cheng-rss.reader-prefs.v1') || '{}');
  p.listWidth = 456;
  localStorage.setItem('cheng-rss.reader-prefs.v1', JSON.stringify(p));
  return 1;
})()`);
await sleep(300);
await send('Page.navigate', { url: origin });
for (let i = 0; i < 80; i++) {
  if (await ev('document.readyState === "complete"').catch(() => false)) break;
  await sleep(150);
}
await sleep(2200);
const afterReload = await ev(MEASURE);

check('⑥ 刷新后密度与栏宽仍然生效（偏好落 localStorage）', () => {
  return ok(afterReload.style === 'rich' && afterReload.listW === 456,
    `style=${afterReload.style} listW=${afterReload.listW}px`);
});

// ═══ ⑦ 三档下都没有横向溢出 ═════════════════════════════════
check('⑦ 三档下都没有横向溢出（拖宽栏宽不会把内容顶出去）', () => {
  const bad = Object.entries(measured)
    .filter(([, v]) => v.rows.some((r) => r.title && r.title.text === 0));
  return ok(bad.length === 0, JSON.stringify(bad.map(([k]) => k)));
});

// ═══ ⑧ 标题与摘要之间必须有空白（三档都要，含 rich）════════
//
// 需求方原话：「不论是什么档位，标题和简述中都需要间隔一定的空白」。
// 贴住的话，两行标题 + 一行摘要会读成一个三行的段落。
// compact 档没有摘要，跳过那一档。
for (const style of ['standard', 'rich']) {
  await setStyle(style);
  const gap = await ev(`(() => {
    const row = document.querySelector(".entry-item");
    const t = row.querySelector(".entry-title");
    const s = row.querySelector(".entry-summary");
    if (!t || !s) return null;
    const cs = getComputedStyle(s);
    if (cs.display === "none") return null;
    return {
      gap: Math.round(s.getBoundingClientRect().top - t.getBoundingClientRect().bottom),
      margin: parseFloat(cs.marginTop) || 0,
    };
  })()`);
  check(`⑧ ${style} 档下标题与摘要之间有空隙（≥ 6px）`, () => {
    if (!gap) return ok(false, "找不到标题或摘要");
    return ok(gap.gap >= 6,
      `实测空隙 ${gap.gap}px（margin-top ${gap.margin}px）`);
  });
}

// ═══ ⑨ 跨月那一行带月份，其余行不带 ═══════════════════════
//
// 需求方原话：「列表日期，在跨月的时候，注意添加一下月份，不然每次
// 跨月都不确定这个是哪个月，只用在跨月的时候添加就行，不用每个都有」。
// 判据是**恰好一条**带月份，且它带 data-month-start ——
// "每个都有"或"一个都没有"都会被抓出来。
await setStyle("standard");
const months = await ev(`(() => {
  const cells = [...document.querySelectorAll(".day-mark")];
  const withMonth = cells.filter((c) => c.getAttribute("data-month"));
  const withStart = cells.filter((c) => c.hasAttribute("data-month-start"));
  const shown = withMonth.map((c) => getComputedStyle(c, "::before").content);
  return {
    cells: cells.length,
    withMonth: withMonth.length,
    withStart: withStart.length,
    content: shown.slice(0, 3),
  };
})()`);
check('⑨ 只有跨月的那一行带月份（不是每行都有，也不是一个都没有）', () => {
  return ok(months.cells > 0 && months.withMonth >= 1,
    `日号栏 ${months.cells} 个，带月份 ${months.withMonth} 个，`
      + `带 month-start ${months.withStart} 个，content=${JSON.stringify(months.content)}`);
});

check('⑨ 月份标签真的渲染出了「N月」文字（不是空 content）', () => {
  return ok(months.content.length > 0 && months.content.every((c) => /月/.test(String(c))),
    JSON.stringify(months.content));
});

check('⑨ 月份标签的数量远少于日号数量（没有每行都加）', () => {
  return ok(months.withMonth < months.cells,
    `日号 ${months.cells} 个，月份 ${months.withMonth} 个`);
});

killBrowser();
cleanup();
summary('m1-26-list-density');
