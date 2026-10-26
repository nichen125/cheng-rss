#!/usr/bin/env node
// 订阅页界面 —— 验收
//
// 为什么单独一节：m1-04 验的是订阅的**行为**（能不能订阅、304、broken），
// 但"30 个源长什么样"完全没验。实际交付前发现的四个显示问题全部
// 能在行为断言全绿的情况下存在：
//
//   ① 操作按钮用错图标（刷新用了星形、暂停用了星形、删除用了 ✕）
//   ② 吸顶头部没分隔线，滚动的行从头部下方穿过像"渲染错位"
//   ③ 手机上 .feed-ops .icon-btn:not(.danger) 全藏，刷新/暂停点不到
//   ④ 长标题会换成两行，把行高从 66px 撑到 89px，整列节奏乱掉
//
// 判据：
//   ① 30 个源时行高一致（不因标题长短变化）
//   ② 长标题单行截断，失效徽标不被截掉
//   ③ 操作按钮全部在可视区内，不被挤出屏幕
//   ④ 吸顶头部滚动后仍可见，且不盖住内容
//   ⑤ 手机上行内操作至少 3 个可用（刷新/暂停/删除）
//   ⑥ 桌面 + 手机都无横向溢出
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const binName = process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.6 订阅页界面');

const CANDIDATES = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium'];

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器');
  console.log('        订阅页布局断言需要真实浏览器；本机没有则跳过（不算失败）');
  summary('m1-06-feeds-ui');
  process.exit(0);
}
if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 起服务 ─────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-fui-'));
const dataDir = join(tmp, 'data');
const port = 39000 + Math.floor(Math.random() * 900);
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

if (!ready) { cleanup(); summary('m1-06-feeds-ui'); process.exit(1); }

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'fui@test.local', password: 'fuitest12345' }),
});
const loginRes = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'fui@test.local', password: 'fuitest12345' }),
});
const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

// ── 直接灌数据：30 个正常源 + 边界情况 ─────────────────────
//
// 不走 API 是因为要造的正是"接不到的源"：API 订阅前会先抓一次，
// 这些 example.com 全都失败。这里直接写库，只关心渲染。
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

const NAMES = ['少数派', '晚点LatePost', 'Reuters', 'The Verge', 'Ars Technica',
  'Hacker News', '阮一峰的网络日志', '量子位', '机器之心', 'InfoQ 中文',
  'Solidot', 'cnBeta', '爱范儿', '36氪', '虎嗅', '钛媒体', '品玩', '极客公园',
  'ifanr', 'Engadget', 'TechCrunch', 'Wired', 'VentureBeat', 'MIT Tech Review',
  'Nature', 'Science', 'IEEE Spectrum', 'ACM Queue', 'LWN', 'Phoronix'];

// 必须明确超出容器宽度，否则"被截断"这条断言测不到东西。
// 第一版用的标题刚好塞进桌面宽度（540px / 622px），断言恒假才暴露。
const LONG_TITLE = '一个非常非常长的订阅源标题用来测试它会不会撑破布局或者把右侧操作按钮挤出屏幕外面'
  + '而且还要更长一些才能真的超出容器宽度从而触发省略号截断逻辑验证';

db.exec('BEGIN IMMEDIATE');
const ins = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind)
  VALUES (?,?,?,?,?,?,1800,?,?,?,?,'rss')`);

for (let i = 0; i < NAMES.length; i++) {
  ins.run(`f_${i}`, uid, `https://example${i}.com/feed`, `https://example${i}.com`,
    NAMES[i], null, Date.now() - i * 3600_000, Date.now() + 1800_000,
    i % 5 === 0 ? 2 : 0,
    i % 11 === 0 ? 'broken' : (i % 7 === 0 ? 'paused' : 'active'));
}
// 边界：超长标题 + 失效徽标（验证徽标不被标题截断吃掉）
ins.run('f_long', uid, 'https://long.example.com/feed', 'https://long.example.com',
  LONG_TITLE, null, Date.now(), Date.now(), 0, 'broken');
// 边界：无标题（URL 兜底）
ins.run('f_notitle', uid, `https://b.example.com/${'very-long-path/'.repeat(8)}feed.xml`,
  'https://b.example.com', null, null, Date.now(), Date.now(), 0, 'active');
// 边界：图标地址拉不到（验证降级成占位图标，不留空方块）
ins.run('f_badicon', uid, 'https://badicon.example.com/feed', 'https://badicon.example.com',
  '图标加载失败', 'http://127.0.0.1:1/nope.png', Date.now(), Date.now(), 0, 'active');
// 边界：图标能加载（data URI，离线可用）。
// 没有它的话，"有 favicon 的格数"恒为 0，降级断言的对照样本缺失。
// 1x1 透明 GIF
const OK_ICON = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
ins.run('f_goodicon', uid, 'https://goodicon.example.com/feed', 'https://goodicon.example.com',
  '图标正常', OK_ICON, Date.now(), Date.now(), 0, 'active');
db.exec('COMMIT');
db.close();

// ── 浏览器 ─────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'ai-rss-fuiprof-'));
const cdpPort = 9800 + Math.floor(Math.random() * 200);
const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  'about:blank',
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
  summary('m1-06-feeds-ui');
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
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval 失败');
  return r.result?.value;
};

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

/** 打开订阅页 */
const openFeeds = async (width, height, mobile) => {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: mobile ? 2 : 1, mobile,
  });
  await send('Page.navigate', { url: `${base}/` });
  for (let i = 0; i < 80; i++) {
    if (await evaluate('document.readyState === "complete"').catch(() => false)) break;
    await sleep(150);
  }
  await sleep(900);
  const sel = mobile ? '.tab' : '.nav-item';
  const clicked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('${sel}')].find((x) => x.textContent.includes('订阅'));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await sleep(900);
  return clicked;
};

// ═══ 桌面 ═════════════════════════════════════════════════
const deskOk = await openFeeds(1440, 960, false);
check('桌面可进入订阅页', () => ok(deskOk));

const desk = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.feed-row')];
  const heights = rows.map((r) => Math.round(r.getBoundingClientRect().height));
  const vw = window.innerWidth;
  const overflow = [];
  const opsOut = [];
  for (const r of rows) {
    const ops = r.querySelector('.feed-ops');
    if (!ops) { overflow.push('no-ops'); continue; }
    const or = ops.getBoundingClientRect();
    if (or.right > vw + 1 || or.left < 0) opsOut.push(Math.round(or.right));
  }
  const longRow = rows.find((r) => r.querySelector('.feed-title-text')?.textContent?.includes('非常非常长'));
  const longTitle = longRow?.querySelector('.feed-title-text');
  const longBox = longTitle?.getBoundingClientRect();
  // 徽标是否还在可视区（不能被标题挤出去）
  const longTag = longRow?.querySelector('.tag');
  const tagBox = longTag?.getBoundingClientRect();
  const opsIcons = rows[0] ? [...rows[0].querySelectorAll('.feed-ops .icon-btn, .feed-ops a.icon-btn')]
    .map((b) => ({ tag: b.tagName, title: b.getAttribute('title') ?? '', visible: getComputedStyle(b).display !== 'none' })) : [];
  return {
    count: rows.length,
    minH: Math.min(...heights), maxH: Math.max(...heights),
    heights: [...new Set(heights)],
    overflowX: document.documentElement.scrollWidth - vw,
    opsOut,
    longTitleOneLine: longBox ? longBox.height < 30 : null,
    longTitleTruncated: longTitle ? longTitle.scrollWidth > longTitle.clientWidth : null,
    longTitleSW: longTitle?.scrollWidth ?? null,
    longTitleCW: longTitle?.clientWidth ?? null,
    tagVisible: tagBox ? tagBox.width > 0 && tagBox.right <= vw : null,
    tagText: longTag?.textContent ?? null,
    opsIcons,
    headSticky: (() => {
      const h = document.querySelector('.feeds-head');
      return h ? getComputedStyle(h).position : null;
    })(),
  };
})()`);

// ① 行高一致
// 30 个正常源 + 3 个边界（超长标题 / 无标题 / 图标拉不到）
check('34 个源全部渲染', () => ok(desk.count === 34, `实际 ${desk.count}`));
check('所有行高一致（长标题不撑高）', () => {
  return ok(desk.minH === desk.maxH,
    `高度分布 ${JSON.stringify(desk.heights)}（min ${desk.minH} / max ${desk.maxH}）`);
});
check('行高在合理区间 60~80px', () => {
  return ok(desk.minH >= 60 && desk.maxH <= 80, `${desk.minH}~${desk.maxH}px`);
});

// ② 长标题截断但徽标保留
check('超长标题单行显示（不换行）', () => {
  return ok(desk.longTitleOneLine === true, `标题高度 ${desk.longTitleOneLine}`);
});
check('超长标题被省略号截断', () => {
  return ok(desk.longTitleTruncated === true,
    `scrollWidth=${desk.longTitleSW} clientWidth=${desk.longTitleCW}（相等说明文字还没超出容器）`);
});
check('长标题那行的「失效」徽标仍可见（状态不能被截掉）', () => {
  return ok(desk.tagVisible === true && desk.tagText === '失效',
    `tag=${desk.tagText} visible=${desk.tagVisible}`);
});

// ③ 操作按钮不被挤出
check('所有行的操作按钮都在可视区内', () => {
  return ok(desk.opsOut.length === 0, `越界行数 ${desk.opsOut.length}`);
});
check('每行都有编辑/刷新/暂停/访问/删除五个操作', () => {
  const titles = desk.opsIcons.map((o) => o.title);
  const want = ['编辑', '立即刷新', '暂停抓取', '访问网站', '取消订阅'];
  const missing = want.filter((w) => !titles.includes(w));
  return ok(missing.length === 0,
    `缺 ${JSON.stringify(missing)}，实际 ${JSON.stringify(titles)}`);
});
check('操作按钮的 title 语义正确（不是星形冒充暂停）', () => {
  const titles = desk.opsIcons.map((o) => o.title);
  const want = ['立即刷新', '暂停抓取', '访问网站', '取消订阅'];
  const missing = want.filter((w) => !titles.includes(w));
  return ok(missing.length === 0, `缺 ${JSON.stringify(missing)}，实际 ${JSON.stringify(titles)}`);
});
check('桌面无横向溢出', () => ok(desk.overflowX <= 1, `溢出 ${desk.overflowX}px`));

// ③.5 图标加载失败的降级
//
// 反例：onError 里只 display:none 会留一个 30px 的空方块，
// 截图上看着像"渲染坏了"。必须回退到占位图标。
const iconFallback = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.feed-row')];
  const bad = [];
  for (const r of rows) {
    const box = r.querySelector('.feed-icon');
    if (!box) { bad.push('no-icon-box'); continue; }
    const br = box.getBoundingClientRect();
    if (br.width < 20 || br.height < 20) { bad.push('tiny-box'); continue; }
    // 每一格都必须有占位图标在底层 —— 这是"永远不出现空方块"的核心
    const svg = box.querySelector('svg');
    if (!svg) bad.push('no-fallback-icon');
    const img = box.querySelector('img');
    if (img) {
      const shown = getComputedStyle(img).display !== 'none';
      // 图片显示了但实际没加载出来（0 宽度）就是坏图
      if (shown && img.complete && img.naturalWidth === 0) bad.push('broken-img-shown');
      // 图片被撤掉后仍然要靠底层占位图标，不能是空盒子
      if (!shown && !svg) bad.push('img-hidden-no-fallback');
    }
  }
  return {
    total: rows.length,
    bad: bad.slice(0, 6),
    fallbackCount: rows.filter((r) => r.querySelector('.feed-icon svg')).length,
    // 有多少格真的挂了 favicon（不管加载成功与否）
    faviconAttempts: rows.filter((r) => r.querySelector('.feed-icon img')).length,
  };
})()`);

check('图标加载失败时回退到占位图标（不留空方块）', () => {
  return ok(iconFallback.bad.length === 0,
    `${iconFallback.bad.length}/${iconFallback.total} 行有问题: ${JSON.stringify(iconFallback.bad)}`);
});
check('每一格都有底层占位图标（加载中也不会是空方块）', () => {
  return ok(iconFallback.fallbackCount === iconFallback.total,
    `${iconFallback.fallbackCount}/${iconFallback.total} 有占位图标`);
});
check('测试数据里真的存在待加载的 favicon（否则降级路径是空转）', () => {
  return ok(iconFallback.faviconAttempts > 0,
    `有 favicon 的格数 ${iconFallback.faviconAttempts}`);
});

// ④ 吸顶头部
check('订阅页头部是 sticky', () => ok(desk.headSticky === 'sticky', String(desk.headSticky)));

// 滚动容器在 v1.9 变了（§15.15）：订阅页从独立整页搬进了配置弹窗，
// 现在的滚动者是 .settings-body，不再是 .feeds-page。
// 断言因此不能写死 `.feeds-page.scrollTop = 400` —— 那在 overflow:visible
// 的元素上是个静默的空操作，头部当然"一直可见"，等于断言恒绿。
// 改成"自己往上找第一个真正能滚的祖先"，这样无论页面怎么搬家都有效。
await evaluate(`(() => {
  let el = document.querySelector('.feeds-page');
  while (el) {
    if (el.scrollHeight > el.clientHeight + 8) { el.scrollTop = 400; return el.className; }
    el = el.parentElement;
  }
  return null;
})()`);
await sleep(500);
const afterScroll = await evaluate(`(() => {
  const head = document.querySelector('.feeds-head');
  const hr = head?.getBoundingClientRect();
  // 滚动容器 = 头部所在的最近可滚动祖先
  let sc = head?.parentElement;
  while (sc) {
    if (sc.scrollHeight > sc.clientHeight + 8) break;
    sc = sc.parentElement;
  }
  const scTop = sc ? sc.getBoundingClientRect().top : 0;
  const addBtn = [...document.querySelectorAll('.feeds-actions button')]
    .find((b) => b.textContent.includes('添加订阅'));
  const ab = addBtn?.getBoundingClientRect();
  return {
    scrolled: sc ? Math.round(sc.scrollTop) : 0,
    scClass: sc?.className ?? null,
    headTop: hr ? Math.round(hr.top) : null,
    scTop: Math.round(scTop),
    headVisible: hr ? hr.bottom > scTop : false,
    addClickable: ab ? (ab.top >= scTop - 1 && ab.bottom <= window.innerHeight + 1) : false,
  };
})()`);
check('（前置）列表确实滚动了 400px（否则下面两条是空转）', () => {
  return ok(afterScroll.scrolled >= 380,
    `scrollTop=${afterScroll.scrolled}（滚动容器 ${afterScroll.scClass}）`);
});
check('滚动 400px 后头部仍可见', () => {
  return ok(afterScroll.headVisible === true,
    `headTop=${afterScroll.headTop} scTop=${afterScroll.scTop}`);
});
check('滚动后「添加订阅」按钮仍在可视区（不被滚走）', () => {
  return ok(afterScroll.addClickable === true, JSON.stringify(afterScroll));
});

// ═══ 手机 ═════════════════════════════════════════════════
const mobOk = await openFeeds(393, 852, true);
check('手机可进入订阅页', () => ok(mobOk));

const mob = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.feed-row')];
  const heights = rows.map((r) => Math.round(r.getBoundingClientRect().height));
  const vw = window.innerWidth;
  const first = rows[0];
  const ops = first ? [...first.querySelectorAll('.feed-ops .icon-btn, .feed-ops a.icon-btn')]
    .map((b) => ({
      title: b.getAttribute('title') ?? '',
      visible: getComputedStyle(b).display !== 'none',
      w: Math.round(b.getBoundingClientRect().width),
      inView: b.getBoundingClientRect().right <= vw + 1,
    })) : [];
  const visibleOps = ops.filter((o) => o.visible);
  return {
    count: rows.length,
    minH: Math.min(...heights), maxH: Math.max(...heights),
    heights: [...new Set(heights)],
    overflowX: document.documentElement.scrollWidth - vw,
    ops,
    visibleOpTitles: visibleOps.map((o) => o.title),
    visibleOpMinW: visibleOps.length ? Math.min(...visibleOps.map((o) => o.w)) : 0,
    allInView: visibleOps.every((o) => o.inView),
  };
})()`);

check('手机上所有行高一致', () => {
  return ok(mob.minH === mob.maxH, `高度分布 ${JSON.stringify(mob.heights)}`);
});
check('手机上无横向溢出', () => ok(mob.overflowX <= 1, `溢出 ${mob.overflowX}px`));

// ⑤ 行内操作可用性——这是最容易写错的一条
check('手机上每行仍有 4 个可用操作（编辑/刷新/暂停/删除）', () => {
  const want = ['编辑', '立即刷新', '取消订阅'];
  const missing = want.filter((w) => !mob.visibleOpTitles.includes(w));
  const hasPause = mob.visibleOpTitles.some((t) => t.includes('暂停') || t.includes('恢复'));
  return ok(missing.length === 0 && hasPause,
    `缺 ${JSON.stringify(missing)}，暂停=${hasPause}，可见 ${JSON.stringify(mob.visibleOpTitles)}`);
});
check('手机上「立即刷新」可点（不是被 CSS 藏掉）', () => {
  return ok(mob.visibleOpTitles.includes('立即刷新'),
    `可见: ${JSON.stringify(mob.visibleOpTitles)}`);
});
check('手机上「暂停抓取」可点', () => {
  return ok(mob.visibleOpTitles.some((t) => t.includes('暂停') || t.includes('恢复')),
    `可见: ${JSON.stringify(mob.visibleOpTitles)}`);
});
check('手机上「取消订阅」可点', () => {
  return ok(mob.visibleOpTitles.includes('取消订阅'),
    `可见: ${JSON.stringify(mob.visibleOpTitles)}`);
});
check('手机上可见操作按钮宽度 ≥ 36px', () => {
  return ok(mob.visibleOpMinW >= 36, `最小 ${mob.visibleOpMinW}px`);
});
check('手机上操作按钮不越出屏幕右边', () => {
  return ok(mob.allInView === true, JSON.stringify(mob.ops.filter((o) => o.visible)));
});

// ⑦ 手机上行内元信息不能被压没
//
// 这一条来自一张截图：操作按钮收到 4 个 40px 之后，365px 的行里
// 留给文字的只有 91px，于是每一行都渲染成「共… · 28 分钟前抓取」——
// 「共 24 条」被 flex 压成 22px 宽，等于没显示。
//
// 为什么只能量不能看：字符串确实在 DOM 里，`textContent.includes('共')`
// 恒真；但它被 overflow:hidden + 22px 宽裁成了一串省略号。
// 判据用 scrollWidth <= clientWidth + 1 —— 这才是"完整可见"。
const metaFit = await evaluate(`(() => {
  const out = [...document.querySelectorAll('.feed-row')].map((r) => {
    const total = r.querySelector('.feed-total');
    const title = r.querySelector('.feed-title-text');
    return {
      total: total ? {
        text: (total.textContent || '').trim(),
        w: Math.round(total.getBoundingClientRect().width),
        need: total.scrollWidth,
        fits: total.scrollWidth <= total.clientWidth + 1,
      } : null,
      titleW: title ? Math.round(title.getBoundingClientRect().width) : null,
    };
  }).filter((x) => x.total);
  return {
    count: out.length,
    truncated: out.filter((x) => !x.total.fits),
    minTotalW: out.length ? Math.min(...out.map((x) => x.total.w)) : 0,
    sample: out[0],
  };
})()`);
check('手机上每条源的「共 N 条」都完整显示（没被压成省略号）', () => {
  if (metaFit.count === 0) return ok(false, '没有一行带 .feed-total，断言空转');
  return ok(metaFit.truncated.length === 0,
    `${metaFit.truncated.length}/${metaFit.count} 行被截断：`
    + JSON.stringify(metaFit.truncated.slice(0, 3)));
});
check('手机上「共 N 条」的宽度够放下文字（≥ 28px）', () => {
  return ok(metaFit.minTotalW >= 28, `最窄 ${metaFit.minTotalW}px，样例 ${JSON.stringify(metaFit.sample)}`);
});

ws.close();
summary('m1-06-feeds-ui');
killBrowser();
cleanup();
process.exit(process.exitCode ?? 0);
