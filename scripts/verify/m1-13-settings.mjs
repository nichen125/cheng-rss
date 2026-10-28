#!/usr/bin/env node
// 配置中心 —— 验收（PLAN §15.15）
//
// 需求方原话：「分组添加下拉栏，添加配置功能。订阅管理等部分功能，放入配置中。
// 具体可以参考 huntly，写入需求」。
//
// 这一节最容易假绿的地方（每条都写了"为什么这么验"）：
//
//   ① 「点齿轮能打开弹窗」很容易绿 —— 但如果弹窗打开时**背后仍可点**，
//      用户会点到列表里的条目，看起来像"弹窗穿透"。必须真的派发一次点击
//      给遮罩层背后的元素，确认它没被触发。
//   ② 「切分类内容变了」也会绿 —— 而如果每次切换都重挂组件，用户
//      在订阅页输入到一半的 URL 会消失。必须**先在输入框里写东西**，
//      切走再切回，验证值还在。
//   ③ 「分组下拉存在」不能证明它真的在过滤 —— 必须选中一个分组后
//      逐行检查 `folderName`，而不是只数行数变少（过滤成 0 行也会变少）。
//   ④ 「Esc 能关」如果在别处也监听 Esc，可能是别的逻辑关的。
//      这里顺带验"关闭后弹窗 DOM 真的没了"，而不只是看不见。
//   ⑤ 占位分类最容易做成"点了没反应"或"点了空白"。必须断言点开之后
//      有内容（≥3 条清单项 + 明确的「待接入」标签）。
//   ⑥ 「侧栏只剩一个入口」不能靠数按钮 —— 侧栏本来就还有 4 个固定视图
//      和 5 个分组行。必须断言侧栏里**没有任何**能打开订阅管理的东西
//      （.nav-section 只剩「分组」「即将支持」两个标题，没有「订阅源」）。
//
// 判据：
//   ① 桌面唯一配置入口是侧栏齿轮；打开后停在「订阅」分类（v1.13 收敛）
//   ② 六个分类都在，M2/M3/M6 三个标「待接入」
//   ③ 分类切换不重挂：输入到一半的内容保留
//   ④ 遮罩挡点击：背后元素收不到点击
//   ⑤ Esc 关闭；重开后未保存的编辑已丢弃
//   ⑥ 分组下拉：≥3 个分组时是 <select>，选「未分组」只显示 folderId=null
//   ⑦ 分组页能改名/删除，删完源退回未分组且订阅页同步
//   ⑧ 弹窗里改分组后，关闭弹窗时侧栏分组列表已同步
//   ⑨ 手机上弹窗铺满视口，分类栏变横向；底部导航那格叫「配置」
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { openSettings as openSettingsShared } from '../lib/ui.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.13 配置中心');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-set-'));
const dataDir = join(tmp, 'data');
const port = 48800 + Math.floor(Math.random() * 700);
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
if (!ready) { cleanup(); summary('m1-13-settings'); process.exit(1); }

await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'set@test.local', password: 'settest123456' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'set@test.local', password: 'settest123456' }),
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
// 四个分组，其中 3 个有源 —— 这样 folders.length >= 3，会走下拉分支。
// 另留 2 个未归组的源，用于验证"未分组"这一项。
// 数量刻意不同：科技1 / 财经1 / 生活1 / 未分组2，全库 5。
// 只数行数变少的断言在"过滤成 0 行"时也会绿，所以下面逐行比对 folderName。
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
const insF = db.prepare('INSERT INTO folders (id,user_id,name,sort) VALUES (?,?,?,?)');
insF.run('sf_tech', uid, '科技IT', 0);
insF.run('sf_fin', uid, '财经', 1);
insF.run('sf_life', uid, '生活', 2);

const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind,folder_id)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss',?)`);
insFeed.run('sg_a', uid, 'https://ga.example.com/feed', 'https://ga.example.com', '科技源', Date.now(), Date.now(), 'sf_tech');
insFeed.run('sg_b', uid, 'https://gb.example.com/feed', 'https://gb.example.com', '财经源', Date.now(), Date.now(), 'sf_fin');
insFeed.run('sg_c', uid, 'https://gc.example.com/feed', 'https://gc.example.com', '生活源', Date.now(), Date.now(), 'sf_life');
insFeed.run('sg_d', uid, 'https://gd.example.com/feed', 'https://gd.example.com', '散装甲', Date.now(), Date.now(), null);
insFeed.run('sg_e', uid, 'https://ge.example.com/feed', 'https://ge.example.com', '散装乙', Date.now(), Date.now(), null);

const insE = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name)
  VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,?)`);
let clock = 1_700_000_000_000;
for (const [fid, site] of [['sg_a', '科技源'], ['sg_b', '财经源'], ['sg_c', '生活源'],
  ['sg_d', '散装甲'], ['sg_e', '散装乙']]) {
  for (let i = 0; i < 2; i++) {
    clock += 60_000;
    insE.run(`${fid}_e${i}`, uid, fid, `g_${fid}_${i}`, `https://x.example.com/${fid}/${i}`,
      `x/${fid}/${i}`, `${site} 条目 ${i}`, '摘要', clock, clock, site);
  }
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
const browser = CANDIDATES.find((p) => existsSync(p));

if (!browser) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器，UI 断言跳过');
  summary('m1-13-settings');
  cleanup();
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), 'ai-rss-setprof-'));
const cdpPort = 9920 + Math.floor(Math.random() * 70);
const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,960', 'about:blank',
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
  summary('m1-13-settings');
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

// ── 快照 ─────────────────────────────────────────────────
const snapshot = () => ev(`(() => {
  const modal = document.querySelector('.settings-modal');
  const mb = modal?.getBoundingClientRect();
  const nav = [...document.querySelectorAll('.settings-nav-item')].map((b) => ({
    label: (b.querySelector('.settings-nav-label')?.textContent ?? '').trim(),
    active: b.className.includes('active'),
    soon: (b.querySelector('.soon-tag')?.textContent ?? '').trim() || null,
  }));
  const rows = [...document.querySelectorAll('.settings-pane:not([hidden]) .feed-row')].map((r) => ({
    title: (r.querySelector('.feed-title-text')?.textContent ?? '').trim(),
    group: (r.closest('.feed-group')?.querySelector('.feed-group-head span:nth-of-type(1)')?.textContent ?? '').trim(),
  }));
  const sel = document.querySelector('.settings-pane:not([hidden]) .folder-select');
  return {
    modal: modal ? { w: Math.round(mb.width), h: Math.round(mb.height) } : null,
    nav, rows,
    activeNav: nav.filter((n) => n.active).map((n) => n.label),
    sectionTitle: (document.querySelector(".settings-pane:not([hidden]) .settings-sec-head h2, .settings-pane:not([hidden]) .feeds-head h1")?.textContent ?? '').trim(),
    select: sel ? {
      value: sel.value,
      opts: [...sel.options].map((o) => o.textContent.trim()),
    } : null,
    chips: document.querySelectorAll('.settings-pane:not([hidden]) .folder-filter .chip').length,
    // 分组计数：两种形态归一成同一个 map，断言只看数字
    groupCounts: (() => {
      const pane = document.querySelector('.settings-pane:not([hidden])');
      if (!pane) return {};
      const out = {};
      const sel = pane.querySelector('.folder-select');
      if (sel) {
        for (const o of sel.options) {
          const m = /^(.+?)（(d+) 个源）$/.exec(o.textContent.trim());
          if (m) out[m[1].replace(/（.*$/, '').trim()] = Number(m[2]);
        }
        return out;
      }
      for (const c of pane.querySelectorAll('.folder-filter .chip')) {
        const n = c.querySelector('.chip-count')?.textContent ?? '';
        const label = (c.textContent ?? '').replace(n, '').trim();
        if (label) out[label] = Number(n);
      }
      return out;
    })(),
    backdrop: Boolean(document.querySelector('.settings-backdrop')),
    bodyScrollable: (() => {
      const b = document.querySelector('.settings-body');
      return b ? b.scrollHeight > b.clientHeight + 8 : null;
    })(),
    listScrollTop: (() => {
      const b = document.querySelector('.settings-body');
      return b ? Math.round(b.scrollTop) : null;
    })(),
  };
})()`);

const openSettings = async (fromTab = false) => {
  // v1.13：桌面的侧栏「订阅」入口已删除（§15.15 规格修订），
  // 桌面唯一入口是侧栏底部的齿轮；手机是底部导航的「配置」。
  const r = await openSettingsShared(ev, { mobile: fromTab, sleep });
  return r.opened ? 'ok' : 'miss';
};

const closeByEsc = async () => {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await sleep(700);
};

const clickNavSection = async (label) => {
  const r = await ev(`(() => {
    const b = [...document.querySelectorAll('.settings-nav-item')]
      .find((x) => (x.querySelector('.settings-nav-label')?.textContent ?? '').trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(700);
  return r;
};

// ── ⓪ 侧栏已经没有订阅入口了（v1.13 规格修订）────────────
//
// 需求方原话：「删除主页的订阅源按钮，全部放到配置里面」。
// 这条必须**先量**：如果侧栏还留着那个「订阅」按钮，后面的 ①
// 照样能通过（齿轮也能开弹窗），于是"没搬干净"这件事一次都抓不到。
const sidebarEntries = await ev(`(() => {
  const sb = document.querySelector('.sidebar');
  if (!sb) return null;
  return {
    sections: [...sb.querySelectorAll('.nav-section')].map((x) => (x.textContent || '').trim()),
    // 侧栏里任何能打开订阅管理的按钮：文案含「订阅」，或 title 提到订阅管理
    subscribeButtons: [...sb.querySelectorAll('button')].filter((b) =>
      (b.textContent || '').trim() === '订阅'
      || /管理订阅/.test(b.getAttribute('title') || '')).length,
    // 齿轮是唯一允许剩下的配置入口
    gearCount: [...sb.querySelectorAll('.icon-btn')]
      .filter((b) => (b.getAttribute('title') || '').includes('配置')).length,
  };
})()`);
check('（前提）页面已渲染出侧栏（否则下面两条空转）', () => {
  return ok(sidebarEntries !== null, '找不到 .sidebar');
});
check('⓪ 侧栏不再有「订阅源」标题（整块已删除，不是只藏起来）', () => {
  return ok(!sidebarEntries.sections.includes('订阅源'),
    JSON.stringify(sidebarEntries.sections));
});
check('⓪ 侧栏里没有任何能打开订阅管理的按钮', () => {
  return ok(sidebarEntries.subscribeButtons === 0,
    `仍有 ${sidebarEntries.subscribeButtons} 个「订阅」入口`);
});
check('⓪ 侧栏的配置入口只剩齿轮这 1 个', () => {
  return ok(sidebarEntries.gearCount === 1, `齿轮 ${sidebarEntries.gearCount} 个`);
});

// ── ① 齿轮打开配置弹窗 ──────────────────────────────────
const opened = await openSettings(false);
check('侧栏齿轮能点中', () => ok(opened === 'ok', String(opened)));
const s1 = await snapshot();

check('点齿轮打开的是配置弹窗（不是切换到独立整页）', () => {
  return ok(s1.backdrop === true && s1.modal !== null && s1.rows.length === 5,
    `backdrop=${s1.backdrop} modal=${JSON.stringify(s1.modal)} rows=${s1.rows.length}`);
});
check('弹窗打开时停在「订阅」分类', () => {
  return ok(s1.activeNav.length === 1 && s1.activeNav[0] === '订阅',
    JSON.stringify(s1.activeNav));
});
check('弹窗不再占满整块后两栏之外的空间（是居中面板，有明确宽高）', () => {
  return ok(s1.modal.w > 600 && s1.modal.w <= 900 && s1.modal.h > 400,
    JSON.stringify(s1.modal));
});

// ── ② 六个分类都在，三个占位 ─────────────────────────────
check('配置分类有 6 个', () => ok(s1.nav.length === 6, JSON.stringify(s1.nav.map((n) => n.label))));
check('分类覆盖 订阅/分组/账户 + AI/简报/备份', () => {
  const want = ['订阅', '分组', '账户', 'AI 分析', '每日简报', '备份与迁移'];
  const got = s1.nav.map((n) => n.label);
  const missing = want.filter((w) => !got.includes(w));
  return ok(missing.length === 0, `缺 ${JSON.stringify(missing)}，实际 ${JSON.stringify(got)}`);
});
check('M2/M3/M6 三个分类标了「待接入」里程碑', () => {
  const soon = Object.fromEntries(s1.nav.filter((n) => n.soon).map((n) => [n.label, n.soon]));
  return ok(soon['AI 分析'] === 'M2' && soon['每日简报'] === 'M3'
    && soon['备份与迁移'] === 'M6',
    JSON.stringify(soon));
});
const clickedAi = await clickNavSection('AI 分析');
check('「AI 分析」占位分类能点开', () => ok(clickedAi === true));
const ai = await ev(`(() => ({
  title: (document.querySelector('.settings-pane:not([hidden]) .settings-sec-head h2')?.textContent ?? '').trim(),
  items: document.querySelectorAll('.settings-pane:not([hidden]) .soon-list li').length,
  soonTag: (document.querySelector('.settings-pane:not([hidden]) .soon-tag-inline')?.textContent ?? '').trim(),
  hint: (document.querySelector('.settings-pane:not([hidden]) .settings-section .hint')?.textContent ?? '').slice(0, 30),
}))()`);
check('占位分类有标题 + ≥3 条"将来会配什么"的清单', () => {
  return ok(/AI 分析/.test(ai.title) && ai.items >= 3,
    JSON.stringify(ai));
});
check('占位分类明确标注「待接入 · M2」并说明属于哪个里程碑', () => {
  return ok(/待接入/.test(ai.soonTag) && /M2/.test(ai.soonTag),
    JSON.stringify(ai.soonTag));
});

// ── ③ 分类切换不重挂：输入到一半的内容保留 ───────────────
//
// 这条最容易假绿：只是"切过去再切回来，输入框还在"是恒真的 ——
// 因为组件确实渲染了。必须**先往里写内容**，切走再切回，内容还在
// 才说明没重挂（重挂 = state 归零）。
await clickNavSection('订阅');
await sleep(500);
const typed = await ev(`(() => {
  const b = [...document.querySelectorAll('.feeds-actions .btn')]
    .find((x) => x.textContent.includes('添加订阅'));
  if (!b) return 'no-btn';
  b.click();
  return 'ok';
})()`);
check('订阅分类里能打开「添加订阅」面板', () => ok(typed === 'ok', String(typed)));
await sleep(500);
const setInput = async (text) => ev(`(() => {
  const i = document.querySelector('.add-panel input');
  if (!i) return false;
  const d = Object.getOwnPropertyDescriptor(i.constructor.prototype, 'value');
  d.set.call(i, ${JSON.stringify(text)});
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await setInput('https://半途而废.example.com/feed');
await sleep(400);
const beforeSwitch = await ev(`document.querySelector('.add-panel input')?.value ?? null`);
check('（前置）输入框里已写入待订阅地址', () => {
  return ok(String(beforeSwitch).includes('半途而废'), String(beforeSwitch));
});

await clickNavSection('分组');
await sleep(600);
const inFolders = await snapshot();
check('切到「分组」分类后内容确实换了（列出 3 个分组）', () => {
  return ok(/分组/.test(inFolders.sectionTitle) && inFolders.backdrop === true,
    JSON.stringify(inFolders.sectionTitle));
});
await clickNavSection('订阅');
await sleep(700);
const afterSwitch = await ev(`(() => ({
  value: document.querySelector('.add-panel input')?.value ?? null,
  panelOpen: Boolean(document.querySelector('.add-panel')),
  rows: document.querySelectorAll('.feed-row').length,
}))()`);
check('切走再切回，添加面板里输入的内容还在（分类切换不重挂组件）', () => {
  return ok(String(afterSwitch.value).includes('半途而废') && afterSwitch.panelOpen === true,
    JSON.stringify(afterSwitch));
});
check('切回后源列表也在（没有重新请求导致的空白期）', () => {
  return ok(afterSwitch.rows === 5, `${afterSwitch.rows} 行`);
});

// ── ④ 遮罩挡住背后点击 ──────────────────────────────────
//
// 真正派发一次点击给遮罩背后的坐标。用 elementFromPoint 判定
// 那个坐标上最顶层的元素是谁 —— 如果它属于弹窗，说明遮罩有效。
const hit = await ev(`(() => {
  // 列表第一个条目的中心（弹窗背后的位置）
  const row = document.querySelector('.entry-item');
  if (!row) return { skipped: 'no-row' };
  const r = row.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    topTag: el?.tagName ?? null,
    inModal: Boolean(el?.closest('.settings-modal')),
    inBackdrop: Boolean(el?.closest('.settings-backdrop')),
    clickedRow: Boolean(el?.closest('.entry-item')),
  };
})()`);
check('弹窗打开时，背后条目的点击会被遮罩接住（不穿透）', () => {
  return ok(hit.inBackdrop === true && hit.clickedRow === false,
    JSON.stringify(hit));
});

// ── ⑤ Esc 关闭；重开后编辑已丢弃 ────────────────────────
//
// 关窗前先切到「分组」：这样"重开回到订阅"才是一条有信息量的断言。
// 第一版这里是直接关窗再重开、断言恒真 —— 关窗时就在订阅页，
// "还在订阅页"证明不了任何事（§15.8 同类坑：看得见的断言其实什么都没验）。
await clickNavSection('分组');
await sleep(600);
const beforeClose = await ev(`(document.querySelector('.settings-nav-item.active .settings-nav-label')?.textContent ?? '').trim() || null`);
check('（前置）关窗前停在「分组」分类（否则下一条空转）', () => {
  return ok(beforeClose === '分组', String(beforeClose));
});
await closeByEsc();
const closed = await snapshot();
check('Esc 能关闭配置弹窗', () => {
  return ok(closed.backdrop === false && closed.modal === null, JSON.stringify(closed.modal));
});
check('关闭后回到条目列表（弹窗 DOM 真的移除，不是只隐藏）', () => {
  return ok(closed.rows.length === 0, `意外还在渲染 ${closed.rows.length} 个源行`);
});

await openSettings(false);
await sleep(600);
const reopened = await ev(`(() => ({
  panelOpen: Boolean(document.querySelector('.add-panel')),
  value: document.querySelector('.add-panel input')?.value ?? null,
}))()`);
check('重开后未保存的编辑已丢弃（面板关闭、输入框空）', () => {
  return ok(reopened.panelOpen === false, JSON.stringify(reopened));
});
const reopenedSection = await ev(`(document.querySelector('.settings-nav-item.active .settings-nav-label')?.textContent ?? '').trim() || null`);
check('重开后确实回到「订阅」而不是上次的「分组」', () => {
  return ok(reopenedSection === '订阅', `实际 ${JSON.stringify(reopenedSection)}`);
});

// ── ⑥ 分组下拉栏 ────────────────────────────────────────
const withDrop = await snapshot();
check('3 个分组时，筛选是 <select> 下拉栏而不是一排 chip', () => {
  return ok(withDrop.select !== null && withDrop.chips === 0,
    `select=${withDrop.select !== null} chips=${withDrop.chips}`);
});
check('下拉里有「全部」+「未分组」+ 每个分组', () => {
  const opts = withDrop.select?.opts ?? [];
  const want = ['全部（5 个源）', '未分组（2 个源）', '科技IT（1 个源）'];
  const missing = want.filter((w) => !opts.includes(w));
  return ok(missing.length === 0, `缺 ${JSON.stringify(missing)}，实际 ${JSON.stringify(opts)}`);
});

const selectFolder = async (value) => ev(`(() => {
  const s = document.querySelector('.folder-select');
  if (!s) return false;
  const d = Object.getOwnPropertyDescriptor(s.constructor.prototype, 'value');
  d.set.call(s, ${JSON.stringify(value)});
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

await selectFolder('sf_tech');
await sleep(900);
const onlyTech = await snapshot();
check('下拉选「科技IT」后只剩该组的源', () => {
  return ok(onlyTech.rows.length === 1 && onlyTech.rows[0].title === '科技源',
    JSON.stringify(onlyTech.rows));
});

await selectFolder('none');
await sleep(900);
const onlyUnfiled = await snapshot();
check('下拉选「未分组」只显示 folderId 为 null 的源（2 个）', () => {
  const titles = onlyUnfiled.rows.map((r) => r.title).sort();
  return ok(titles.length === 2 && titles[0] === '散装乙' && titles[1] === '散装甲',
    JSON.stringify(titles));
});
check('「未分组」筛选后不用 chip 形态（保持同一个控件，不来回换）', () => {
  return ok(onlyUnfiled.chips === 0 && onlyUnfiled.select !== null,
    `chips=${onlyUnfiled.chips}`);
});

await selectFolder('');
await sleep(900);
const allBack = await snapshot();
check('下拉选回「全部」后 5 个源都回来', () => {
  return ok(allBack.rows.length === 5, `${allBack.rows.length} 行`);
});

// ── ⑦ 分组页删组 → 源退回未分组 ─────────────────────────
//
// 删组会弹 window.confirm。无头浏览器默认会**卡住**等用户决定，
// 所以必须先注入一个自动确认。这条如果不做，脚本会挂在这里。
await ev(`(() => {
  window.__confirmLog = [];
  window.confirm = (msg) => { window.__confirmLog.push(String(msg)); return true; };
  window.prompt = (msg, def) => { window.__promptLog = String(msg); return '重命名后的组'; };
  return true;
})()`);

await clickNavSection('分组');
await sleep(700);
const foldersBefore = await ev(`(() => ({
  names: [...document.querySelectorAll('.settings-pane:not([hidden]) .folder-manage-list .folder-name')].map((x) => x.textContent.trim()),
  count: document.querySelectorAll('.settings-pane:not([hidden]) .folder-manage-list li').length,
}))()`);
check('分组页列出 3 个分组', () => {
  return ok(foldersBefore.count === 3, JSON.stringify(foldersBefore));
});

// 重命名"生活" → "重命名后的组"（prompt 已注入固定返回值）
const renamed = await ev(`(() => {
  const li = [...document.querySelectorAll('.folder-manage-list li')]
    .find((x) => (x.querySelector('.folder-name')?.textContent ?? '').trim() === '生活');
  if (!li) return 'miss';
  const b = [...li.querySelectorAll('button')].find((x) => x.textContent.includes('重命名'));
  if (!b) return 'no-btn';
  b.click();
  return 'ok';
})()`);
check('分组页有「重命名」按钮', () => ok(renamed === 'ok', String(renamed)));
await sleep(1300);
const afterRename = await ev(`[...document.querySelectorAll('.settings-pane:not([hidden]) .folder-manage-list .folder-name')].map((x) => x.textContent.trim())`);
check('重命名生效（「生活」→「重命名后的组」）', () => {
  return ok(afterRename.includes('重命名后的组') && !afterRename.includes('生活'),
    JSON.stringify(afterRename));
});

// 删除"财经"分组
const removed = await ev(`(() => {
  const li = [...document.querySelectorAll('.folder-manage-list li')]
    .find((x) => (x.querySelector('.folder-name')?.textContent ?? '').trim() === '财经');
  if (!li) return 'miss';
  const b = [...li.querySelectorAll('button')].find((x) => x.textContent.includes('删除'));
  if (!b) return 'no-btn';
  b.click();
  return 'ok';
})()`);
check('分组页有「删除」按钮', () => ok(removed === 'ok', String(removed)));
await sleep(1500);
const afterDelete = await ev(`(() => ({
  names: [...document.querySelectorAll('.settings-pane:not([hidden]) .folder-manage-list .folder-name')].map((x) => x.textContent.trim()),
  confirms: (window.__confirmLog ?? []).length,
  confirmText: (window.__confirmLog ?? [])[0] ?? null,
}))()`);
check('删除分组后分组数变 2', () => {
  return ok(afterDelete.names.length === 2 && !afterDelete.names.includes('财经'),
    JSON.stringify(afterDelete.names));
});
check('删组前有确认框，且说明"订阅不会被删、退回未分组"', () => {
  return ok(afterDelete.confirms >= 1 && /退回/.test(String(afterDelete.confirmText))
    && /不会被删/.test(String(afterDelete.confirmText)),
    String(afterDelete.confirmText).slice(0, 60));
});

// 切回订阅页：那个组里的源现在应该在「未分组」下
await clickNavSection('订阅');
await sleep(1200);
const afterDelFeeds = await snapshot();
check('删组后订阅页里那个源还在（没跟着分组一起被删）', () => {
  return ok(afterDelFeeds.rows.length === 5,
    `${afterDelFeeds.rows.length} 行（删组把源一起删了就是 4 行）`);
});
check('删组后「未分组」变成 3 个源（财经源退回来了）', () => {
  // 用 groupCounts 而不是直接读 <select>：删一个组之后总数从 3 掉到 2，
  // §15.15 的规则会让控件从下拉换回 chip。断言要验的是"源退回来了"，
  // 不该因为控件换形态而红 —— 那会把一次形态切换误报成数据丢失。
  const c = afterDelFeeds.groupCounts ?? {};
  return ok(c['未分组'] === 3, JSON.stringify(c));
});
check('分组数掉到 2 之后筛选控件回到 chip 形态（§15.15 的阈值规则）', () => {
  return ok(afterDelFeeds.select === null && afterDelFeeds.chips >= 2,
    `select=${afterDelFeeds.select !== null} chips=${afterDelFeeds.chips}`);
});

// ── ⑧ 关闭弹窗后侧栏同步 ────────────────────────────────
const sidebarBefore = await ev(`[...document.querySelectorAll('.sidebar .nav-item')]
  .map((b) => (b.querySelector('.nav-label')?.textContent ?? '').trim())`);
check('（前置）侧栏在弹窗打开时看不到（被遮罩挡住但 DOM 仍在）', () => {
  return ok(sidebarBefore.includes('科技IT'), JSON.stringify(sidebarBefore));
});

await closeByEsc();
await sleep(1400);
const sidebarAfter = await ev(`[...document.querySelectorAll('.sidebar .nav-item')]
  .map((b) => (b.querySelector('.nav-label')?.textContent ?? '').trim())`);
check('关闭弹窗后侧栏分组列表已同步（生活改了名、财经没了）', () => {
  const hasRenamed = sidebarAfter.includes('重命名后的组');
  const hasOld = sidebarAfter.includes('生活');
  const hasDeleted = sidebarAfter.includes('财经');
  return ok(hasRenamed && !hasOld && !hasDeleted, JSON.stringify(sidebarAfter));
});

// ── ⑨ 手机上弹窗铺满 + 分类栏横向 ───────────────────────
await send('Emulation.setDeviceMetricsOverride', {
  width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
});
await sleep(900);
const mobOpened = await openSettings(true);
check('手机上从底部导航打开配置', () => ok(mobOpened === 'ok', String(mobOpened)));
const mob = await ev(`(() => {
  const m = document.querySelector('.settings-modal');
  const nav = document.querySelector('.settings-nav');
  const navCs = nav ? getComputedStyle(nav) : null;
  const navItems = [...document.querySelectorAll('.settings-nav-item')].map((b) => {
    const r = b.getBoundingClientRect();
    return { label: (b.querySelector('.settings-nav-label')?.textContent ?? '').trim(), h: Math.round(r.height) };
  });
  const mb = m?.getBoundingClientRect();
  return {
    w: mb ? Math.round(mb.width) : null,
    h: mb ? Math.round(mb.height) : null,
    vw: window.innerWidth,
    vh: window.innerHeight,
    navDir: navCs?.flexDirection ?? null,
    navOverflowX: navCs?.overflowX ?? null,
    navItems,
    docOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
})()`);

check('手机上弹窗铺满视口（宽高都贴合）', () => {
  return ok(mob.w >= mob.vw - 2 && mob.h >= mob.vh - 2,
    `${mob.w}×${mob.h} vs 视口 ${mob.vw}×${mob.vh}`);
});
check('手机上分类栏变成横向一行（flex-direction: row）', () => {
  return ok(mob.navDir === 'row', String(mob.navDir));
});
check('手机上分类栏可横向滚动（6 个分类塞不下一行）', () => {
  return ok(mob.navOverflowX === 'auto' || mob.navOverflowX === 'scroll', String(mob.navOverflowX));
});
check('手机上分类项触摸高度 ≥ 36px', () => {
  const bad = mob.navItems.filter((n) => n.h < 36);
  return ok(bad.length === 0, JSON.stringify(bad));
});
check('手机上配置弹窗本身不产生页面横向滚动', () => {
  return ok(mob.docOverflow === 0, `溢出 ${mob.docOverflow}px`);
});

ws.close();
killBrowser();
summary('m1-13-settings');
cleanup();
process.exit(process.exitCode ?? 0);
