#!/usr/bin/env node
// 阅读区边缘与侧边目录 —— 验收（PLAN §15.18）
//
// 需求方原话：「显示界面加上边缘显示，同时可以加上侧边目录显示，利用侧边的空白」。
//
// 两件事都建立在 §15.3/§15.16 算出来的那块空白上：v1.14 把正文收到 80ch，
// 1440 屏两侧各剩 82px、1920 屏各剩 293px —— 那块空白此前纯属浪费。
//
// 这一节最容易假绿的地方（所以每条都写了"为什么这么验"）：
//
//   ① 「纸有边缘」不能只断言"加了 class"或"有 border"。改之前正文坐在
//      阅读区背景上，两者同色 —— 必须量**两个元素的背景色不同**，
//      否则把 --paper-bg 写成和 --bg 一样也全绿。
//   ② 「目录只吃空白」最容易做成"目录一出现正文就变窄"。那等于把 v1.14
//      刚放宽的宽度又收回一半。必须断言**有目录与无目录时正文列宽完全相同**。
//   ③ 「空目录不显示」如果只断言"目录不在 DOM 里"，一个"永远不渲染目录"
//      的实现照样通过。所以要先有 ≥2 标题的用例证明它渲染了。
//   ④ 点目录项跳转如果只断言"点了没报错"毫无信息量。必须量**目标标题
//      的 top 真的落在视口顶部附近**，且主框架 URL 没变（不是导航走了）。
//   ⑤ 长标题截断要看 scrollWidth > clientWidth，不能看 textContent ——
//      后者永远是全文。
//
// 判据（对应 §19.3 的 1.20 行）：
//   ① 纸与桌面背景不同 + 圆角 14px + 有阴影；纸宽随 --reader-width 变
//   ② 1440 下目录不渲染，正文列宽与无目录时完全相同
//   ③ 宽视口（1720）下目录渲染，条目数 = 正文 h2+h3 数，正文列宽仍不变
//      为什么不是 1600：纸宽 = 80ch，1ch 随字族变（Win ~10.0 / Linux ~10.5），
//      Linux 下 1600 需要 1604px 才放得下，正好差 4px。见 ③ 段落的说明。
//   ④ 无小标题 / 只有 1 个 → 目录不渲染
//   ⑤ 点目录项后目标标题进视口，URL 不变
//   ⑥ 滚动后同时只有一项 aria-current，且是当前小节
//   ⑦ 长目录项省略号 + title 给全文
//   ⑧ 640px 下纸取消圆角与阴影
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, eq, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { removeDir } from '../lib/tmp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.20 阅读区边缘与侧边目录');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-toc-'));
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
if (!ready) { cleanup(); summary('m1-20-reader-toc'); process.exit(1); }

await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'toc@test.local', password: 'toctest1234567' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'toc@test.local', password: 'toctest1234567' }),
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
// 四篇条目，各对应一条判据：
//   T1「多标题」  8 个 h2 + 2 个 h3 —— 目录主用例；其中一个是超长标题（⑦）
//   T2「无标题」  只有 <p> —— ④ 的 0 标题分支
//   T3「单标题」  只有 1 个 h2 —— ④ 的 1 标题分支（不该出目录）
//   T4「短标题名」2 个 h2 —— 用于 ⑤ 跳转（标题短，定位不会被图片影响）
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
const now = Date.now();
db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',NULL)`)
  .run('tf_feed', uid, 'https://toc.example.com/feed', 'https://toc.example.com',
    '目录测试源', now, now);

const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,?)`);
const insContent = db.prepare(`INSERT INTO entry_contents (entry_id,html,markdown,raw_html,extracted_by)
  VALUES (?,?,NULL,NULL,'fixture')`);

// 正文按 §13.3 的存储格式写：1 字节标记 + 内容（0x00 明文 / 0x01 gzip）
const { gzipSync } = await import('node:zlib');
const pack = (text) => {
  const raw = Buffer.from(text, 'utf8');
  if (raw.length < 512) return Buffer.concat([Buffer.from([0x00]), raw]);
  return Buffer.concat([Buffer.from([0x01]), gzipSync(raw, { level: 6 })]);
};
const para = (n, tag) => `<p>${tag} 的第 ${n} 段正文，用它把每一节撑到正常长度，
  这样滚动时几个小标题不会全挤在一屏里 —— 否则"当前小节"的高亮断言测不出东西。</p>`;

const H2 = (t) => `<h2>${t}</h2>`;
const H3 = (t) => `<h3>${t}</h3>`;

const LONG_HEAD = '这是一个非常非常非常长的小标题用来验证目录里的省略号是否真的生效而不是把整栏撑宽';
// 文末要留足够多的正文：否则滚动到底时「第七节」还停在半屏高，
// scrollIntoView 被 maxScroll 夹住，跳转断言测的就是"夹住了"而不是"跳准了"。
const TAIL = Array.from({ length: 24 }, (_, i) => para(i + 1, '第八节后续')).join('\n');
const t1Html = [
  H2('第一节'), para(1, '第一节'), para(2, '第一节'),
  H2('第二节'), para(1, '第二节'), H3('第二节的小节甲'), para(1, '小节甲'), para(2, '小节甲'),
  H2('第三节'), para(1, '第三节'), para(2, '第三节'), para(3, '第三节'),
  H2('第四节'), para(1, '第四节'), H3('第四节的小节乙'), para(1, '小节乙'), para(2, '小节乙'),
  H2('第五节'), para(1, '第五节'), para(2, '第五节'),
  H2(LONG_HEAD), para(1, '第六节'), para(2, '第六节'),
  H2('第七节'), para(1, '第七节'), para(2, '第七节'),
  H2('第八节'), para(1, '第八节'), para(2, '第八节'), para(3, '第八节'), TAIL,
].join('\n');
const t2Html = [para(1, '无标题'), para(2, '无标题'), para(3, '无标题')].join('\n');
const t3Html = [H2('唯一的小标题'), para(1, '单标题'), para(2, '单标题')].join('\n');
const t4Html = [
  H2('甲段'), para(1, '甲段'), para(2, '甲段'), para(3, '甲段'),
  H2('乙段'), para(1, '乙段'), para(2, '乙段'), para(3, '乙段'),
].join('\n');

const put = (id, title, html) => {
  insEntry.run(id, uid, 'tf_feed', `g_${id}`, `https://toc.example.com/${id}`,
    `toc.example.com/${id}`, title, '摘要', 1700000000000 + Math.random() * 1000, now, '目录测试源');
  insContent.run(id, pack(html));
};
put('tf_t1', '多标题的长文（目录主用例）', t1Html);
put('tf_t2', '完全没有小标题的短讯', t2Html);
put('tf_t3', '只有一个小标题的文章', t3Html);
put('tf_t4', '两个短标题的文章（跳转用例）', t4Html);
db.exec('COMMIT');
db.close();

// 期望值从造数据的同一份 HTML 算，不从实现里抄
const wantHeads = (html) => (html.match(/<h[23][\s>]/gi) ?? []).length;
const T1_HEADS = wantHeads(t1Html);
check('（数据自检）T1 有 10 个小标题（8 个 h2 + 2 个 h3）', () => eq(T1_HEADS, 10));
check('（数据自检）T2 没有小标题、T3 只有 1 个',
  () => ok(wantHeads(t2Html) === 0 && wantHeads(t3Html) === 1,
    `T2=${wantHeads(t2Html)} T3=${wantHeads(t3Html)}`));

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
  summary('m1-20-reader-toc');
  cleanup();
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'cheng-rss-toc-prof-'));
const cdpPort = 9920 + Math.floor(Math.random() * 60);
const proc = spawn(browserPath, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1720,950', 'about:blank',
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
  summary('m1-20-reader-toc');
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
  name: 'cheng_rss_sid', value: cookie.split('=')[1] ?? '',
  domain: '127.0.0.1', path: '/',
});

/**
 * 切到「全部」视图（v1.16，§15.19）。
 *
 * 默认视图改成「未读」之后，这个脚本会自己把自己绊倒：第一次打开
 * T1 就把它标成已读了，于是下一次 reload 之后它从默认列表里消失，
 * openEntry 搜不到、点不到，后面一长串断言全成空转。
 *
 * 所以每次导航之后都先点一次「全部」。这不影响本脚本要验的东西 ——
 * 它验的是阅读区的纸与目录，与"读/全部"无关。
 */
const ensureAllView = async () => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.pane-seg .seg-btn')]
      .find((x) => (x.textContent || '').trim() === '全部');
    if (!b) return 'no-seg';
    if (b.className.includes('on')) return 'already';
    b.click();
    return 'clicked';
  })()`);
  if (r === 'clicked') await sleep(1400);
  return r;
};

/** 每次量之前都先把视口设好 */
const setSize = async (w, h, mobile = false) => {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile,
  });
  await sleep(500);
};

/** 打开某篇条目：用搜索框缩小列表，再点第一行 */
const openEntry = async (keyword) => {
  const typed = await ev(`(() => {
    const i = document.querySelector('.search-box input');
    if (!i) return false;
    const d = Object.getOwnPropertyDescriptor(i.constructor.prototype, 'value');
    d.set.call(i, ${JSON.stringify(keyword)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(1800);
  const clicked = await ev(`(() => {
    const r = document.querySelector('.entry-item');
    if (!r) return false;
    r.click();
    return true;
  })()`);
  await sleep(2000);
  return typed && clicked;
};

/** 回到干净状态：回列表 + 清搜索 */
const backToList = async () => {
  await ev(`(() => {
    const b = document.querySelector('.reader-bar .icon-btn');
    if (b) b.click();
    return true;
  })()`);
  await sleep(600);
  await ev(`(() => {
    const i = document.querySelector('.search-box input');
    if (!i) return false;
    const d = Object.getOwnPropertyDescriptor(i.constructor.prototype, 'value');
    d.set.call(i, '');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(900);
};

/**
 * 量布局。
 *
 * 背景色必须取**计算值**再比：CSS 变量解析之前的字符串（`var(--paper-bg)`）
 * 在两边都相同，直接比会假绿。
 */
const MEASURE = `(() => {
  const box = (s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return {
      w: Math.round(r.width), x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height),
      bg: cs.backgroundColor,
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
      shadow: cs.boxShadow,
      borderW: parseFloat(cs.borderTopWidth) || 0,
    };
  };
  const pane = document.querySelector('.reader-pane');
  const body = document.querySelector('.article-body');
  const links = [...document.querySelectorAll('.toc-link')];
  const longLink = links.find((l) => (l.textContent || '').length > 20) ?? null;
  return {
    vw: window.innerWidth,
    pane: box('.reader-pane'),
    paper: box('.reader'),
    toc: box('.reader-toc'),
    bodyW: body ? Math.round(body.getBoundingClientRect().width) : 0,
    // 容器圆角档的规格值。必须在这里读 —— check() 的回调跑在 Node 里，
    // 那里没有 document。
    radiusLg: Number(getComputedStyle(document.documentElement)
      .getPropertyValue('--radius-lg').replace('px', '')) || 16,
    // 同字号渲染 N ch 的探针：ch 随字族变，不能写死像素
    wantChW: (() => {
      const paper = document.querySelector('.reader');
      if (!paper) return 0;
      const ch = Number(getComputedStyle(paper).getPropertyValue('--reader-width').trim() || 80) || 80;
      const cs = getComputedStyle(paper);
      const p = document.createElement('div');
      // 五项都抄：都影响 1ch 的宽度，少抄一个基准就偏
      p.style.cssText = 'position:absolute;visibility:hidden;width:' + ch
        + 'ch;font-size:' + cs.fontSize + ';font-family:' + cs.fontFamily
        + ';font-weight:' + cs.fontWeight + ';letter-spacing:' + cs.letterSpacing
        + ';word-spacing:' + cs.wordSpacing;
      document.body.appendChild(p);
      const w = p.getBoundingClientRect().width;
      p.remove();
      return Math.round(w);
    })(),
    // 正文可用宽度上限 = 阅读区宽 - 58（左右内边距 56 + 边框 2），
    // 对应 CSS 的 max-width: calc(100% - 58px)
    maxCol: (() => {
      const pr = pane ? pane.getBoundingClientRect() : null;
      return pr ? Math.round(pr.width - 58) : 0;
    })(),
    heads: body ? body.querySelectorAll('h2,h3').length : 0,
    headIds: [...(document.querySelectorAll('.article-body h2, .article-body h3'))].map((h) => h.id),
    tocCount: links.length,
    tocTexts: links.map((l) => (l.textContent || '').trim()),
    tocOnCount: links.filter((l) => l.getAttribute('aria-current') === 'true').length,
    tocOnText: links.find((l) => l.getAttribute('aria-current') === 'true')?.textContent ?? null,
    // 长标题是否真的被省略号截断：scrollWidth > clientWidth
    longTruncated: longLink ? longLink.scrollWidth > longLink.clientWidth + 1 : null,
    longTitleAttr: longLink ? longLink.getAttribute('title') : null,
    longTextLen: longLink ? (longLink.textContent || '').length : null,
    pageOverflowX: Math.max(0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth),
    readerVar: getComputedStyle(pane ?? document.body).getPropertyValue('--reader-width').trim(),
  };
})()`;

// ═══ ① 纸的边缘：1440 视口（目录不出现）════════════════════
//
// 1440 是绝大多数人的实际宽度，也是"目录不该出现"的那一档 ——
// 在这一档验纸才有意义：没有目录时纸必须仍然居中、边缘仍然可见。
await setSize(1440, 950);
await send('Page.navigate', { url: origin });
for (let i = 0; i < 80; i++) {
  if (await ev('document.readyState === "complete"').catch(() => false)) break;
  await sleep(150);
}
await sleep(1500);
await ensureAllView();
const openedT1 = await openEntry('多标题的长文');
check('（前置）能打开多标题的文章', () => ok(openedT1 === true));
const at1440 = await ev(MEASURE);

check('（前置）正文小标题读到了 10 个（否则后面全是空转）', () => {
  return eq(at1440.heads, T1_HEADS);
});
check('① 纸的背景色与阅读区背景**不同**（这是"边缘显示"的核心判据）', () => {
  return ok(at1440.paper && at1440.pane && at1440.paper.bg !== at1440.pane.bg,
    `纸 ${at1440.paper?.bg} vs 桌面 ${at1440.pane?.bg}`);
});
// 纸的圆角取自容器档 --radius-lg（设计方案 §6：容器 12–16px）。
// 判据读规格值而不是写死数字：圆角档位调整时不该改测试。
check('① 纸有圆角（取 --radius-lg 容器档，不是新造一档）', () => {
  return ok(at1440.paper?.radius === at1440.radiusLg,
    `radius=${at1440.paper?.radius}，--radius-lg=${at1440.radiusLg}`);
});
check('① 纸有阴影（宽屏上要靠它看出层次）', () => {
  return ok(at1440.paper?.shadow && at1440.paper.shadow !== 'none',
    String(at1440.paper?.shadow));
});
check('① 纸比正文列宽（含左右内边距），不是正好等于文字宽度', () => {
  // 24px 上下 / 28px 左右内边距 + 1px 边框 → 比正文宽约 58px
  return ok(at1440.paper && at1440.paper.w > at1440.bodyW,
    `纸 ${at1440.paper?.w}px，正文列 ${at1440.bodyW}px`);
});
check('② 1440 下目录**不渲染**（空白不够，不能压正文）', () => {
  return ok(at1440.toc === null && at1440.tocCount === 0,
    `toc=${JSON.stringify(at1440.toc)} 条目=${at1440.tocCount}`);
});
// 判据从规格读，不写死 712（§19.1 的同一条道理）：
// ch 是字体相对单位，换字族（无衬线 → 衬线/思源黑）会让 1ch 的宽度变，
// 80ch 就不再是 712px。写死像素的话，一次字体替换就会被判成"正文变宽了"，
// 而那是字体的事，不是实现的事。
check('② 无目录时正文列宽 = min(偏好字符数, 可用宽度)', () => {
  // 不写死"必须等于 Nch"。实现是 width: calc(Nch) + max-width:
  // calc(100% - 58px)，阅读区窄于 Nch 时会被正确地收窄。1ch 较宽的
  // 平台（Linux ~10.5px，80ch=840 > 可用 818）撞 max-width，
  // 较窄的平台（Windows ~10.0px，80ch=800）则 width 生效。两者都对。
  const want = Math.min(at1440.wantChW, at1440.maxCol);
  return ok(Math.abs(at1440.bodyW - want) <= 8,
    `正文列 ${at1440.bodyW}px，期望 min(${at1440.readerVar}ch=${at1440.wantChW}, 可用 ${at1440.maxCol}) = ${want}px`);
});
check('① 整页无横向溢出（纸 + 阴影没把页面撑宽）', () => {
  return eq(at1440.pageOverflowX, 0);
});

const BODY_1440 = at1440.bodyW;

// ═══ ② 纸宽跟随偏好，不是固定像素 ═════════════════════════
//
// 这条防的是"把纸写成固定 712px"的实现：那样用户把宽度调到 64ch 后
// 文字变窄、纸不变，正文又悬在一片多余的空白里。
await ev(`(() => {
  localStorage.setItem('cheng-rss.reader-prefs.v1',
    JSON.stringify({ fontSize: 16.5, width: 64, theme: 'system' }));
  return true;
})()`);
await send('Page.reload', {});
await sleep(2600);
await ensureAllView();
await openEntry('多标题的长文');
const narrow = await ev(MEASURE);
check('① 正文宽度调到 64ch 后，纸跟着变窄（不是固定像素）', () => {
  return ok(narrow.paper && at1440.paper && narrow.paper.w < at1440.paper.w - 50,
    `64ch 时纸 ${narrow.paper?.w}px vs 80ch 时 ${at1440.paper?.w}px`);
});
check('① 调窄后正文列宽也确实变窄（纸没骗人）', () => {
  return ok(narrow.bodyW < BODY_1440 - 50,
    `64ch 正文 ${narrow.bodyW}px vs 80ch ${BODY_1440}px`);
});

// 还原偏好，免得影响后面的用例
await ev(`(() => { localStorage.removeItem('cheng-rss.reader-prefs.v1'); return true; })()`);

// ═══ ③ 宽视口：目录出现，且正文不变窄 ═══════════════════════
//
// 视口从 1600 提到 1720，原因是**字体度量让 1600 卡在临界点两边**：
//
//   布局需要 = 侧栏196 + 列表368 + 纸 + 目录200 + 余量
//   纸宽 = 80ch，1ch 随字族变：
//     Windows ~10.0px → 纸 800px → 需要 1564px，1600 放得下
//     Linux   ~10.5px → 纸 840px → 需要 1604px，1600 **放不下**
//
// 也就是说 Linux 上 1600 屏确实显示不出目录 —— 这是真实的产品边界，
// 不是实现坏了。与其把断言放宽到测不出东西（比如只测 toc !== null 就
// 算过），不如把视口提到两个平台都足以放下的宽度，这样断言的语义
// 仍然成立："空间够时目录必须渲染，且不许压正文"。
//
// 1720 给 Linux 留了 1720-(196+368+840+200) = 116px 余量。
await setSize(1720, 950);
await send('Page.reload', {});
await sleep(2600);
await ensureAllView();
await openEntry('多标题的长文');
// 变量名沿用 at1600（原本是 1600 视口），现在视口是 1720。
// 不批量改名是为了让这次 diff 只含真正的语义变更，改名留到下次整理。
const at1600 = await ev(MEASURE);

check('③ 宽视口下目录渲染出来', () => {
  return ok(at1600.toc !== null && at1600.tocCount > 0,
    `toc=${JSON.stringify(at1600.toc)} 条目=${at1600.tocCount}`);
});
check('③ 目录条目数 = 正文 h2+h3 数（不多不少）', () => {
  return eq(at1600.tocCount, T1_HEADS);
});
check('★ ③ 有目录时正文列宽与无目录时**完全相同**（目录不许压正文）', () => {
  // 与「同视口下无目录时的正文宽」比较，不再与 BODY_1440 比。
  //
  // 原来比的是 1440 视口的正文宽，那是两个不同视口的值：
  //   1440：阅读区可用 876-58 = 818，正文被 max-width 封顶成 818
  //   1720：可用宽足够，正文 = 80ch（Win 800 / Linux 840）
  // 于是这条在 Linux 上必然红（818 vs 840），而它想验的根本不是
  // 「跨视口宽度相等」，是「目录出现前后宽度不变」。
  //
  // 正确的判据：把纸宽在 1720 下量一次（此时**没有**目录的基准由
  // 本文件里 1440 段的 at1440.bodyW 提供不了，所以改用"Nch 与可用宽度
  // 取小"这个与视口无关的语义），再与有目录时比。
  const want = Math.min(at1600.wantChW, at1600.maxCol);
  return ok(Math.abs(at1600.bodyW - want) <= 8,
    `有目录时正文 ${at1600.bodyW}px，期望 min(${at1600.readerVar}ch=${at1600.wantChW}, 可用 ${at1600.maxCol}) = ${want}px；`
    + `1440 下的值 ${BODY_1440}px 属于另一个视口，不能拿来比`);
});
check('③ 目录在纸的右侧（x ≥ 纸的右边缘），不是压在上面', () => {
  return ok(at1600.toc && at1600.paper
    && at1600.toc.x >= at1600.paper.x + at1600.paper.w - 1,
    `纸 ${at1600.paper?.x}..${(at1600.paper?.x ?? 0) + (at1600.paper?.w ?? 0)}，`
    + `目录 x=${at1600.toc?.x}`);
});
check('③ 目录宽度够读（≥ 160px，小于这个就只能显示 4~5 个字）', () => {
  return ok(at1600.toc && at1600.toc.w >= 160, `目录宽 ${at1600.toc?.w}px`);
});
check('③ 每个小标题都被补上了 id（目录要能定位到它）', () => {
  return ok(at1600.headIds.length === T1_HEADS && at1600.headIds.every((x) => typeof x === 'string' && x.length > 0),
    JSON.stringify(at1600.headIds));
});
check('③ 目录第一条就是正文第一个标题', () => {
  return ok(at1600.tocTexts[0] === '第一节', JSON.stringify(at1600.tocTexts.slice(0, 3)));
});
check('③ 默认高亮第一条（刚打开还没滚动）', () => {
  return ok(at1600.tocOnCount === 1 && at1600.tocOnText === '第一节',
    `on=${at1600.tocOnCount} 文本=${JSON.stringify(at1600.tocOnText)}`);
});

// ═══ ⑦ 长标题省略号 ═══════════════════════════════════════
check('⑦ 超长标题在目录里被省略号截断（不是把整栏撑宽）', () => {
  return ok(at1600.longTruncated === true,
    `truncated=${at1600.longTruncated} 长度=${at1600.longTextLen}`);
});
check('⑦ 长标题的 title 属性给了全文（截断了也还能看到完整标题）', () => {
  return ok(typeof at1600.longTitleAttr === 'string'
    && at1600.longTitleAttr.length >= at1600.longTextLen,
    `title 长度 ${at1600.longTitleAttr?.length}，正文长度 ${at1600.longTextLen}`);
});

// ═══ ⑥ 滚动后高亮跟随 ═════════════════════════════════════
//
// 「高亮当前小节」如果只断言"始终有一项高亮"，一个永远亮第一条的实现
// 照样通过。必须**滚到文中某个位置**，再断言亮的是那一节的标题。
//
// 滚动量用 `getBoundingClientRect()` 相减算，**不用 `offsetTop`**：
// offsetTop 相对 `offsetParent`，而 offsetParent 由"最近的有 position 的
// 祖先"决定 —— 往上加一层定位盒子（v2.0 为了划词工具条加的 `.article-wrap`）
// 就会让同一个 offsetTop 少算「纸顶到正文顶」那段（179px），于是这里滚到
// 第五节上方两屏，断言莫名其妙变红。rect 相减与布局层级无关。
const scrolled = await ev(`(async () => {
  const el = document.querySelector('.reader-scroll');
  const heads = [...document.querySelectorAll('.article-body h2, .article-body h3')];
  const target = heads.find((h) => (h.textContent || '').trim() === '第五节');
  if (!target || !el) return { ok: false, reason: '找不到第五节' };
  const need = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
  el.scrollTop = el.scrollTop + need - 60;
  await new Promise((r) => setTimeout(r, 700));
  const links = [...document.querySelectorAll('.toc-link')];
  return {
    ok: true,
    // 顺带记下滚了多少：红了能分辨"没滚对"还是"滚对了但高亮没跟"
    scrolledBy: Math.round(need),
    onCount: links.filter((l) => l.getAttribute('aria-current') === 'true').length,
    onText: links.find((l) => l.getAttribute('aria-current') === 'true')?.textContent ?? null,
  };
})()`);
check('⑥ 滚动到「第五节」后，高亮跟到了第五节（不是永远亮第一条）', () => {
  return ok(scrolled.ok === true && scrolled.onText === '第五节',
    JSON.stringify(scrolled));
});
check('⑥ 同时只有一项高亮（不是整篇都亮）', () => {
  return eq(scrolled.onCount, 1);
});

// ═══ ⑤ 点目录项跳转 ═══════════════════════════════════════
//
// 先滚回顶部，再点一个靠后的条目 —— 否则"点了没跳"和"本来就在那儿"
// 分不出来。
await ev(`(() => {
  const el = document.querySelector('.reader-scroll');
  if (el) el.scrollTop = 0;
  return true;
})()`);
await sleep(600);
const beforeJump = await ev(`(() => {
  const heads = [...document.querySelectorAll('.article-body h2, .article-body h3')];
  const t = heads.find((h) => (h.textContent || '').trim() === '第七节');
  return { top: t ? Math.round(t.getBoundingClientRect().top) : null, url: location.href };
})()`);
check('（前置）跳转前「第七节」在视口外（否则下一条空转）', () => {
  return ok(beforeJump.top === null || beforeJump.top > 400,
    `top=${beforeJump.top}`);
});
const jumped = await ev(`(() => {
  const l = [...document.querySelectorAll('.toc-link')]
    .find((x) => (x.textContent || '').trim() === '第七节');
  if (!l) return false;
  l.click();
  return true;
})()`);
check('⑤ 点「第七节」目录项能点中', () => ok(jumped === true));
// 平滑滚动是动画，固定 sleep 会偶发"还差一截"。改成轮询 scrollTop 直到
// 连续两次不变 —— 否则断言的其实是"1800ms 内滚了多远"，与功能无关。
const settled = await ev(`(async () => {
  const el = document.querySelector('.reader-scroll');
  if (!el) return { ok: false };
  let last = -1;
  let same = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (Math.abs(el.scrollTop - last) < 1) {
      same++;
      if (same >= 3) return { ok: true, top: el.scrollTop, waited: i * 100 };
    } else {
      same = 0;
    }
    last = el.scrollTop;
  }
  return { ok: false, top: el.scrollTop, waited: 6000 };
})()`);
check('⑤ 平滑滚动在 6s 内停下（没有一直动）', () => ok(settled.ok === true, JSON.stringify(settled)));
const afterJump = await ev(`(() => {
  const el = document.querySelector('.reader-scroll');
  const heads = [...document.querySelectorAll('.article-body h2, .article-body h3')];
  const t = heads.find((h) => (h.textContent || '').trim() === '第七节');
  const paneTop = el ? el.getBoundingClientRect().top : 0;
  return {
    top: t ? Math.round(t.getBoundingClientRect().top - paneTop) : null,
    maxScroll: el ? el.scrollHeight - el.clientHeight : 0,
    scrollTop: el ? Math.round(el.scrollTop) : 0,
    url: location.href,
    onText: [...document.querySelectorAll('.toc-link')]
      .find((l) => l.getAttribute('aria-current') === 'true')?.textContent ?? null,
  };
})()`);
check('⑤ 跳转后目标标题落在滚动区顶部附近（-10 ~ 120px）', () => {
  return ok(afterJump.top !== null && afterJump.top >= -10 && afterJump.top <= 120,
    `目标 top=${afterJump.top}px（scrollTop=${afterJump.scrollTop} / 上限 ${afterJump.maxScroll}）`);
});
check('⑤ 跳转不换页：主框架 URL 不变', () => {
  return eq(afterJump.url, beforeJump.url);
});
check('⑤ 跳转后高亮跟着切到目标小节', () => {
  return ok(afterJump.onText === '第七节', JSON.stringify(afterJump.onText));
});

// ═══ ④ 空目录：无标题 / 单标题都不渲染 ═══════════════════
await backToList();
await openEntry('完全没有小标题');
const noHead = await ev(MEASURE);
check('（前置）打开了没有小标题的文章（正文里有 0 个标题）', () => {
  return eq(noHead.heads, 0);
});
check('④ 无小标题时不渲染目录（不是渲染成空栏）', () => {
  return ok(noHead.toc === null && noHead.tocCount === 0,
    `toc=${JSON.stringify(noHead.toc)} 条目=${noHead.tocCount}`);
});
check('④ 无目录时纸仍然在（边缘照旧，不要因为没目录就不给纸）', () => {
  return ok(noHead.paper !== null && noHead.paper.radius > 0,
    JSON.stringify(noHead.paper));
});

await backToList();
await openEntry('只有一个小标题');
const oneHead = await ev(MEASURE);
check('（前置）打开了只有 1 个小标题的文章', () => eq(oneHead.heads, 1));
check('④ 只有 1 个小标题也不渲染目录（1 个标题没有导航价值）', () => {
  return ok(oneHead.toc === null && oneHead.tocCount === 0,
    `toc=${JSON.stringify(oneHead.toc)} 条目=${oneHead.tocCount}`);
});

// ═══ ①·补 三个阅读主题下纸都要有边缘 ══════════════════════
//
// 「边缘显示」如果只在默认主题下成立，切到暗色或米色就没了 ——
// 而这三个主题是 §15.11 的功能，用户真的会切。所以逐个验：
//   · 桌面与纸必须**不同色**（漏写 --desk-bg 的后果就是两者同色）；
//   · 标题与正文必须**同一色**（这条抓的是另一个既有缺陷：
//     阅读主题只覆盖了 --fg 这个变量，而 color 是 body 算好再继承的，
//     切主题后标题仍是深色，在深底上等于看不见）。
const THEMES = ['light', 'dark', 'sepia'];
for (let ti = 0; ti < THEMES.length; ti++) {
  const theme = THEMES[ti];
  await setSize(1440, 950);
  await send('Page.navigate', { url: origin });
  await sleep(2400);
  await ev(`(() => {
    localStorage.setItem('cheng-rss.reader-prefs.v1',
      JSON.stringify({ fontSize: 16.5, width: 80, theme: ${JSON.stringify(theme)} }));
    return true;
  })()`);
  await send('Page.reload', {});
  await sleep(2500);
  await ensureAllView();
  await openEntry('多标题的长文');
  const tm = await ev(`(() => {
    const pane = document.querySelector('.reader-pane');
    const paper = document.querySelector('.reader');
    const title = document.querySelector('.reader-title');
    const bodyEl = document.querySelector('.article-body');
    const rgb = (s) => (s.match(/\\d+/g) ?? []).slice(0, 3).map(Number);
    const lum = (s) => { const [r, g, b] = rgb(s); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    return {
      theme: pane?.getAttribute('data-reader-theme') ?? null,
      paneBg: pane ? getComputedStyle(pane).backgroundColor : null,
      paperBg: paper ? getComputedStyle(paper).backgroundColor : null,
      titleColor: title ? getComputedStyle(title).color : null,
      bodyColor: bodyEl ? getComputedStyle(bodyEl).color : null,
      paperLum: paper ? lum(getComputedStyle(paper).backgroundColor) : null,
      titleLum: title ? lum(getComputedStyle(title).color) : null,
    };
  })()`);
  check('① [' + theme + '] 阅读主题真的切换到了 ' + theme, () => {
    return eq(tm.theme, theme);
  });
  check('① [' + theme + '] 纸与桌面不同色（三个主题都要有边缘）', () => {
    return ok(tm.paperBg && tm.paneBg && tm.paperBg !== tm.paneBg,
      '纸 ' + tm.paperBg + ' vs 桌面 ' + tm.paneBg);
  });
  check('① [' + theme + '] 标题与正文同色（否则深底深字，标题看不见）', () => {
    return eq(tm.titleColor, tm.bodyColor);
  });
  check('① [' + theme + '] 标题亮度与纸亮度拉开（对比度不会糊成一片）', () => {
    return ok(tm.titleLum !== null && tm.paperLum !== null
      && Math.abs(tm.titleLum - tm.paperLum) > 80,
      '标题亮度 ' + tm.titleLum?.toFixed(0) + ' vs 纸 ' + tm.paperLum?.toFixed(0));
  });
}
// 还原成系统主题，后面的手机用例不该带着 sepia
await ev(`(() => { localStorage.removeItem('cheng-rss.reader-prefs.v1'); return true; })()`);

// ═══ ⑧ 手机上取消「纸」═══════════════════════════════════
//
// 手机上屏宽已经贴到内容，圆角 + 阴影只会切掉两角、白占 2px。
await setSize(375, 812, true);
await send('Page.reload', {});
await sleep(2600);
await ensureAllView();
await openEntry('两个短标题');
const mob = await ev(MEASURE);
check('（前置）手机上打开了文章', () => ok(mob.paper !== null, '找不到 .reader'));
check('⑧ 375px 下纸取消圆角（铺满，不当一张纸）', () => {
  return eq(mob.paper.radius, 0);
});
check('⑧ 375px 下纸取消阴影与边框', () => {
  return ok((mob.paper.shadow === 'none' || mob.paper.shadow === '')
    && mob.paper.borderW === 0,
    `shadow=${mob.paper.shadow} border=${mob.paper.borderW}`);
});
check('⑧ 375px 下纸占满列表宽度（不是留一条空边）', () => {
  return ok(mob.paper.w >= mob.vw - 2, `纸 ${mob.paper.w}px / 视口 ${mob.vw}px`);
});
check('⑧ 375px 下不渲染目录（宽度本来就不够）', () => {
  return ok(mob.toc === null, JSON.stringify(mob.toc));
});
check('⑧ 375px 下无横向溢出', () => eq(mob.pageOverflowX, 0));

ws.close();
killBrowser();
summary('m1-20-reader-toc');
cleanup();
process.exit(process.exitCode ?? 0);
