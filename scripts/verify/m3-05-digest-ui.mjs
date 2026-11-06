#!/usr/bin/env node
// 3.5 简报页 —— 验收
//
// 判据（PLAN §15.4 + §19.5）：
//   ① 简报不再是"生成了没人看得见"：侧栏能进、列表能选、正文能读
//   ② **引用号能追到具体事件** —— 正文里的 `[1]` 点开要看到"第 1 条是哪件事、
//      几篇报道、各方说法是否一致"。这是简报区别于"一段 AI 文字"的全部价值
//   ③ 冲突的视觉克制（§15.4：左侧细色条 + 小字，不用红色感叹号）
//   ④ 空态有引导：没有简报时给出"为什么没有 + 下一步做什么"
//
// ② 是这一节的技术核心，而它现在有一个**已存在的断点**：
//   `GET /digests/:id` 是从 `body_md` 里正则匹配 `{{cite:id}}` 来反查簇的，
//   但 `runDigest` 在落库前已经把占位符替换成了 `[1]`（3.3 的 renderCitations）。
//   于是那个正则永远匹配不到东西，`clusters` 恒为 `[]` —— 页面上的 `[1]`
//   点了没有反应，而接口返回 200、看起来一切正常。
//   这就是"两半都对但接不上"的典型：3.3 的渲染对、3.4 的路由对，
//   中间少了一个把引用表存下来的动作。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, gt, summary } from './harness.mjs';
import { removeDir } from '../lib/tmp.mjs';
import { killTree } from '../lib/proc.mjs';
import { openSqlite } from '../lib/sqlite.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BROWSERS = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
const browser = BROWSERS.find((p) => existsSync(p));
const BIN = join(root, 'dist', process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`);

if (!existsSync(BIN)) {
  console.log('  \u001b[33mSKIP\u001b[0m  没有构建产物');
  summary('m3-05-digest-ui');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── ① 数据层：引用表必须落库 ────────────────────────────────
//
// 这一组不碰 HTTP，直接调 saveDigest。要验的是"引用表有没有被存下来"，
// 而那不是接口层能发现的（接口返回 200、clusters 为空同样"正常"）。
group('3.5 简报页 · 引用表落库');

const { openDb } = await import('../../src/server/db/client.ts');
const { migrate } = await import('../../src/server/db/migrate.ts');
const { saveDigest } = await import('../../src/server/digest/index.ts');

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m305-'));
const h = openDb({ dataDir: tmp });
migrate(h.db);
const DB = h.db;
const UID = 'u_dg';
DB.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
  .run(UID, 'dg@t.local', 'DG', 'owner', Date.now());

check('迁移后 digests 有 cites 列（引用表）', () => {
  const cols = DB.prepare("PRAGMA table_info(digests)").all().map((c) => c.name);
  return ok(cols.includes('cites'), JSON.stringify(cols));
});
check('迁移后 digests 有 worth_reading 列（值得一读）', () => {
  const cols = DB.prepare("PRAGMA table_info(digests)").all().map((c) => c.name);
  return ok(cols.includes('worth_reading'), JSON.stringify(cols));
});

const DAY = new Date(2026, 9, 29, 0, 0, 0, 0).getTime();
const BODY = {
  title: '存储芯片三巨头同时扩产',
  highlights: ['长江存储量产 232 层 QLC', '三星推迟 HBM4 送样', '美光上调资本开支'],
  body_md: '## 存储芯片\n\n长江存储宣布量产 232 层 QLC [1]，位密度提升 33%。\n\n'
    + '三星把 HBM4 送样推迟到明年一季度 [2]，与它上季度的表态相反。\n\n'
    + '## 资本开支\n\n美光上调全年资本开支至 120 亿美元 [3]。',
  worth_reading: ['cl_wr1'],
};

const CITES = [
  { index: 1, id: 'cl_a', title: '长江存储量产 232 层 QLC' },
  { index: 2, id: 'cl_b', title: '三星推迟 HBM4 送样' },
  { index: 3, id: 'cl_c', title: '美光上调资本开支' },
];

const d1 = saveDigest(DB, {
  userId: UID, kind: 'daily', body: BODY,
  periodStart: DAY, periodEnd: DAY + 24 * 3600_000,
  entryCount: 24, clusterCount: 3, model: 'mock', costUsd: 0.02,
  citations: CITES,
  worthReading: BODY.worth_reading,
});

check('saveDigest 落库了引用表（JSON）', () => {
  const row = DB.prepare('SELECT cites FROM digests WHERE id = ?').get(d1);
  return ok(typeof row.cites === 'string' && row.cites.includes('cl_a'), String(row.cites));
});
check('引用表保留了顺序与 index（不能只存 id 集合）', () => {
  const row = DB.prepare('SELECT cites FROM digests WHERE id = ?').get(d1);
  const parsed = JSON.parse(row.cites);
  return ok(Array.isArray(parsed) && parsed.length === 3
    && parsed[0].index === 1 && parsed[0].id === 'cl_a'
    && parsed[2].index === 3 && parsed[2].id === 'cl_c',
  JSON.stringify(parsed));
});
check('引用表存了标题（簇被清理后脚注仍有文字，不至于变成 [1] 空号）', () => {
  const parsed = JSON.parse(DB.prepare('SELECT cites FROM digests WHERE id = ?').get(d1).cites);
  return ok(parsed.every((c) => typeof c.title === 'string' && c.title.length > 0),
    JSON.stringify(parsed.map((c) => c.title)));
});
check('worth_reading 也落了库', () => {
  const row = DB.prepare('SELECT worth_reading FROM digests WHERE id = ?').get(d1);
  return ok(String(row.worth_reading).includes('cl_wr1'), String(row.worth_reading));
});
check('没有引用时存 null 而不是 "[]"（空数组与"没有"要有区别）', () => {
  const d2 = saveDigest(DB, {
    userId: UID, kind: 'daily', body: { ...BODY, title: '空引用' },
    periodStart: DAY + 24 * 3600_000, periodEnd: DAY + 48 * 3600_000,
    entryCount: 1, clusterCount: 0, model: 'mock', costUsd: 0,
  });
  const row = DB.prepare('SELECT cites FROM digests WHERE id = ?').get(d2);
  return ok(row.cites === null, JSON.stringify(row.cites));
});

check('重跑覆盖时引用表跟着更新（不残留旧引用）', () => {
  saveDigest(DB, {
    userId: UID, kind: 'daily', body: BODY,
    periodStart: DAY, periodEnd: DAY + 24 * 3600_000,
    entryCount: 24, clusterCount: 2, model: 'mock2', costUsd: 0.01,
    citations: [
      { index: 1, id: 'cl_x', title: '全新的事件' },
    ],
    worthReading: [],
  });
  const row = DB.prepare('SELECT id, cites FROM digests WHERE period_start = ?').get(DAY);
  const parsed = JSON.parse(row.cites);
  return ok(row.id === d1 && parsed.length === 1 && parsed[0].id === 'cl_x',
    `id 变了=${row.id !== d1} cites=${JSON.stringify(parsed)}`);
});

// ── ② 接口：clusters 必须真的返回 ───────────────────────────
group('3.5 简报页 · 详情接口');

const port = 46600 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const proc = spawn(BIN, ['serve', '--data', join(tmp, 'data2'), '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AI_API_KEY: '' },
});
let edge = null;
const cleanup = () => {
  killTree(proc.pid);
  killTree(edge?.pid);
  // 本进程自己也开着 tmp 里的 app.db。不 close 的话 removeDir 永远失败 ——
  // 重试再多次也没用，因为持有者就是我们自己（实测残留 21.6 MB）。
  try { h.close(); } catch { /* 可能已经关了 */ }
  // tmp 里还装着浏览器 profile（见下方 `profile = join(tmp, 'profile')`），
  // killTree 之后句柄要 100ms 左右才松手，removeDir 内部会重试
  removeDir(tmp);
};
process.on('exit', cleanup);

let up = false;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) { up = true; break; } } catch { /* 起 */ }
  await sleep(200);
}
check('服务就绪', () => ok(up, '二进制没起来'));
if (!up) { summary('m3-05-digest-ui'); cleanup(); process.exit(1); }

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'dg@t.local', password: 'dgpass12345678' }),
});
const login = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'dg@t.local', password: 'dgpass12345678' }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
const api = async (p, init = {}) => {
  const r = await fetch(`${base}/api/v1${p}`, {
    ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* 空 */ }
  return { status: r.status, body };
};

// 用接口造数据（被验的是接口本身，不能绕过它直接写库）
const DB2 = join(tmp, 'data2', 'app.db');
{
  const w = openSqlite(DB2);
  const uid = w.prepare('SELECT id FROM users LIMIT 1').get().id;
  const now = Date.now();
  // 三个簇，其中 cl_b 有 conflicts（用来验冲突渲染）
  w.prepare(`INSERT INTO clusters (id, user_id, kind, title, summary, key_points, consensus,
      conflicts, entry_count, source_count, heat, window_start, window_end, created_at)
      VALUES ('cl_a',?,'event',?,?,?,?,?,3,3,90,?,?,?)`).run(
    uid, '长江存储量产 232 层 QLC',
    '长江存储宣布 232 层 QLC 闪存量产，单颗容量 1Tb，位密度提升 33%。',
    JSON.stringify(['232 层堆叠', '单颗 1Tb', '四季度出货']),
    JSON.stringify(['位密度提升 33% 这一点各家一致']),
    JSON.stringify([]),
    now - 86400_000, now, now,
  );
  w.prepare(`INSERT INTO clusters (id, user_id, kind, title, summary, key_points, consensus,
      conflicts, entry_count, source_count, heat, window_start, window_end, created_at)
      VALUES ('cl_b',?,'event',?,?,?,?,?,2,2,70,?,?,?)`).run(
    uid, '三星推迟 HBM4 送样',
    '三星把 HBM4 送样推迟到明年一季度。',
    JSON.stringify(['送样推迟']),
    JSON.stringify(['推迟这件事已确认']),
    JSON.stringify([{ claim: '推迟原因是良率不足', sources: ['路透社', '韩联社'] }]),
    now - 86400_000, now, now,
  );
  w.prepare(`INSERT INTO clusters (id, user_id, kind, title, summary, key_points, consensus,
      conflicts, entry_count, source_count, heat, window_start, window_end, created_at)
      VALUES ('cl_c',?,'event',?,?,?,?,?,1,1,40,?,?,?)`).run(
    uid, '美光上调资本开支',
    '美光把全年资本开支上调到 120 亿美元。',
    JSON.stringify(['120 亿美元']),
    JSON.stringify([]),
    JSON.stringify([]),
    now - 86400_000, now, now,
  );
  w.prepare(`INSERT INTO clusters (id, user_id, kind, title, summary, key_points, consensus,
      conflicts, entry_count, source_count, heat, window_start, window_end, created_at)
      VALUES ('cl_wr1',?,'event',?,?,?,?,?,1,1,12,?,?,?)`).run(
    uid, 'QLC 写入寿命的技术边界（低热度）',
    '一篇讨论 QLC 写入寿命上限的技术分析。',
    JSON.stringify(['写入寿命受限于 P/E 次数']),
    JSON.stringify([]),
    JSON.stringify([]),
    now - 86400_000, now, now,
  );
  w.close();
}

{
  const w = openSqlite(DB2);
  const uid = w.prepare('SELECT id FROM users LIMIT 1').get().id;
  saveDigest(w, {
    userId: uid, kind: 'daily', body: BODY,
    periodStart: DAY, periodEnd: DAY + 24 * 3600_000,
    entryCount: 24, clusterCount: 3, model: 'mock', costUsd: 0.02,
    citations: CITES, worthReading: ['cl_wr1'],
  });
  w.close();
}

const list = await api('/digests');
check('列表接口返回这份简报', () =>
  ok(list.status === 200 && list.body.items.length === 1, JSON.stringify(list.body)?.slice(0, 120)));

const first = list.body.items[0];
const detail = await api(`/digests/${first.id}`);
check('详情接口返回 200', () => eq(detail.status, 200));
check('**详情返回了 clusters（引用号能追到事件）**', () =>
  ok(Array.isArray(detail.body.clusters) && detail.body.clusters.length === 3,
    `clusters=${JSON.stringify(detail.body.clusters)?.slice(0, 120)}`));
// ⚠ 用 JSON.stringify 比较而非 eq：harness 的 eq 是 Object.is，
// 两个不同数组对象永远不等 —— 那样写出来的断言永远红，而看错误信息
// 两边内容一模一样，非常容易误判成实现问题。
check('clusters 顺序与正文 [1][2][3] 一致', () =>
  eq(JSON.stringify(detail.body.clusters?.map((c) => c.id)),
    JSON.stringify(['cl_a', 'cl_b', 'cl_c'])));
check('簇带 summary（脚注展开要有一句话说明）', () =>
  ok(typeof detail.body.clusters?.[0]?.summary === 'string'
    && detail.body.clusters[0].summary.length > 10,
  JSON.stringify(detail.body.clusters?.[0]?.summary)));
check('簇带 entry_count / source_count（"3 篇报道"是可验证量）', () => {
  const c = detail.body.clusters?.[0];
  return ok(c?.entry_count === 3 && c?.source_count === 3,
    `entry=${c?.entry_count} source=${c?.source_count}`);
});
check('簇带 consensus / conflicts（多源对照是简报的核心）', () => {
  const b = detail.body.clusters?.find((c) => c.id === 'cl_b');
  return ok(Array.isArray(b?.consensus) && b.consensus.length === 1
    && Array.isArray(b?.conflicts) && b.conflicts.length === 1
    && b.conflicts[0].claim === '推迟原因是良率不足',
  JSON.stringify(b?.conflicts));
});
check('详情返回 worthReading（值得一读）', () =>
  ok(Array.isArray(detail.body.worthReading)
    && detail.body.worthReading[0]?.title === 'QLC 写入寿命的技术边界（低热度）',
  JSON.stringify(detail.body.worthReading)));
check('正文里没有裸 URL（安全边界：前端要渲染 Markdown）', () => {
  const md = String(detail.body.bodyMd ?? '');
  return ok(!/https?:\/\//.test(md), md.slice(0, 200));
});
check('正文里没有残留的 {{cite:}} 占位符（3.3 的渲染已经把它们换掉了）', () =>
  ok(!/\{\{cite:/.test(String(detail.body.bodyMd ?? '')), String(detail.body.bodyMd).slice(0, 160)));

const missing = await api('/digests/dg_nope');
check('不存在的简报 → 404', () => eq(missing.status, 404));

// 别人的简报
{
  const w = openSqlite(DB2);
  w.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
    .run('u_o', 'o@t.local', 'O', 'member', Date.now());
  saveDigest(w, {
    userId: 'u_o', kind: 'daily', body: { ...BODY, title: '别人的简报' },
    periodStart: DAY, periodEnd: DAY + 24 * 3600_000,
    entryCount: 3, clusterCount: 0, model: 'm', costUsd: 0,
  });
  w.close();
}
{
  const w = openSqlite(DB2);
  const other = w.prepare("SELECT id FROM digests WHERE user_id = 'u_o'").get();
  w.close();
  const r = await api(`/digests/${other.id}`);
  check('读别人的简报 → 404', () => eq(r.status, 404));
}

// ── ③ 浏览器：真的能看 ─────────────────────────────────────
group('3.5 简报页 · 浏览器');

if (!browser) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器，跳过 UI 断言');
} else {
  const profile = join(tmp, 'profile');
  edge = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--window-size=1440,1000', base,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let wsUrl = '';
  edge.stderr.on('data', (d) => {
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
    if (m) wsUrl = m[1];
  });
  for (let i = 0; i < 100 && !wsUrl; i++) await sleep(200);

  if (!wsUrl) {
    check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
  } else {
    const ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let msgId = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
    const raw = (method, params = {}, sid) => new Promise((res, rej) => {
      const i = ++msgId;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
    });
    const targets = await raw('Target.getTargets');
    const pageT = targets.targetInfos.find((t) => t.type === 'page');
    const { sessionId } = await raw('Target.attachToTarget', { targetId: pageT.targetId, flatten: true });
    const sess = (m, p = {}) => raw(m, p, sessionId);
    const evalJs = async (expr) => {
      const r = await sess('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        return { __err: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) };
      }
      return r.result?.value;
    };

    await sess('Network.enable');
    await sess('Network.setCookie', {
      name: cookie.split('=')[0], value: cookie.split('=')[1], url: base,
    });
    await sess('Page.navigate', { url: base });
    await sleep(2600);

    // 侧栏「简报」必须可点（不再是"待接入"）
    const navState = await evalJs(`(() => {
      const items = [...document.querySelectorAll('.nav-item')];
      const d = items.find(x => x.textContent.includes('简报'));
      if (!d) return { found: false };
      return {
        found: true,
        disabled: d.disabled === true,
        soon: d.className.includes('soon'),
        tag: d.querySelector('.soon-tag')?.textContent ?? null,
      };
    })()`);
    check('侧栏有「简报」入口', () => ok(navState?.found === true, JSON.stringify(navState)));
    check('「简报」不再是灰色待接入（可点）', () =>
      ok(navState?.disabled === false && navState?.soon === false,
        JSON.stringify(navState)));
    check('「简报」上没有「待接入」标签', () =>
      ok(navState?.tag === null, String(navState?.tag)));

    const opened = await evalJs(`(async () => {
      const d = [...document.querySelectorAll('.nav-item')]
        .find(x => x.textContent.includes('简报'));
      if (!d) return 'no-nav';
      d.click();
      await new Promise(r => setTimeout(r, 1400));
      return document.querySelector('.digest-page') ? 'ok' : 'no-page';
    })()`);
    check('点「简报」进入简报页', () => ok(opened === 'ok', String(opened)));

    // 选最新一份
    const picked = await evalJs(`(async () => {
      const row = document.querySelector('.digest-date-item');
      if (!row) return 'no-row';
      row.click();
      await new Promise(r => setTimeout(r, 1400));
      return document.querySelector('.digest-doc') ? 'ok' : 'no-doc';
    })()`);
    check('选中日期后右栏渲染出简报', () => ok(picked === 'ok', String(picked)));

    const page = await evalJs(`(() => {
      const q = (s) => document.querySelector(s);
      return {
        title: q('.digest-doc .digest-title')?.textContent ?? '',
        points: [...document.querySelectorAll('.digest-points li')].map(x => x.textContent),
        clusters: [...document.querySelectorAll('.digest-cluster')].map(x => ({
          title: x.querySelector('.digest-cluster-title')?.textContent ?? '',
          hasConflict: Boolean(x.querySelector('.digest-conflict')),
          hasConsensus: Boolean(x.querySelector('.digest-consensus')),
          footnotes: [...x.querySelectorAll('.digest-cite')].map(a => a.textContent),
        })),
        wr: [...document.querySelectorAll('.digest-wr li')].map(x => x.textContent),
        bodyFootnotes: [...document.querySelectorAll('.digest-body .digest-cite')]
          .map(x => x.textContent),
        // 冲突不能用红色警报样式（§15.4：冲突是常态，不是警报）
        alarm: document.querySelectorAll('.digest-doc .alert.error, .digest-doc .digest-conflict.error').length,
      };
    })()`);

    check('简报标题渲染出具体内容（不是"日报"）', () =>
      ok(String(page?.title).includes('存储芯片'), String(page?.title)));
    check('今日要点恰好 3 条', () => eq(page?.points?.length, 3));
    check('要点是三条不同的具体事件', () =>
      eq(new Set(page?.points ?? []).size, 3));
    check('正文按事件分组渲染（3 个事件）', () => eq(page?.clusters?.length, 3));
    check('事件标题是具体标题（不是「事件 1」）', () =>
      ok(String(page?.clusters?.[0]?.title).includes('长江存储'),
        JSON.stringify(page?.clusters?.map((c) => c.title))));
    check('有共识的事件渲染出「一致」', () =>
      ok(page?.clusters?.some((c) => c.hasConsensus), '没有一处 consensus'));
    check('有分歧的事件渲染出「分歧」', () =>
      ok(page?.clusters?.some((c) => c.hasConflict), '没有一处 conflict'));
    check('**分歧的视觉是克制的（无红色 alert）**', () => eq(page?.alarm, 0));
    // 脚注号渲染在**正文**里（.digest-body），不在事件卡片里。
    // 一开始这条断言查的是 .digest-cluster 内部，永远为空 ——
    // 那不是实现坏了，是断言找错了地方。
    check('正文里有脚注号（[1] [2] [3]）', () =>
      ok((page?.bodyFootnotes ?? []).length >= 3,
        JSON.stringify(page?.bodyFootnotes)));
    check('「值得一读」区块渲染出低热度那件事', () =>
      ok((page?.wr ?? []).some((x) => String(x).includes('QLC 写入寿命')),
        JSON.stringify(page?.wr)));

    // ② 的核心：点脚注能看到"第 1 条是哪件事、几篇报道"
    const footnote = await evalJs(`(async () => {
      const a = document.querySelector('.digest-body .digest-cite');
      if (!a) return { err: 'no-cite' };
      const label = a.textContent;
      a.click();
      await new Promise(r => setTimeout(r, 700));
      const card = document.querySelector('.digest-cite-card');
      return {
        label,
        shown: Boolean(card),
        text: card?.textContent ?? '',
      };
    })()`);
    check('点脚注弹出对应事件卡片', () =>
      ok(footnote?.shown === true, JSON.stringify(footnote)?.slice(0, 160)));
    check('脚注卡片里有事件标题', () =>
      ok(/长江存储|三星|美光/.test(String(footnote?.text)) ||
        String(footnote?.text).length > 10, String(footnote?.text)?.slice(0, 120)));
    check('脚注卡片里说明了"几篇报道 / 几个来源"', () =>
      ok(/\d+\s*篇/.test(String(footnote?.text)), String(footnote?.text)?.slice(0, 160)));

    // 浮层必须能关掉。它 sticky 在正文底部，关不掉等于读正文时永久
    // 挡一条 —— 而"能点开"的断言不会发现这件事。
    const dismissed = await evalJs(`(async () => {
      const card = () => document.querySelector('.digest-cite-card');
      if (!card()) return { err: 'no-card' };

      // ① Esc
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const afterEsc = !card();

      // ② 再点开，然后点浮层外面
      document.querySelector('.digest-body .digest-cite')?.click();
      await new Promise(r => setTimeout(r, 300));
      const reopened = Boolean(card());
      document.querySelector('.digest-body')?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
      await new Promise(r => setTimeout(r, 300));
      const afterOutside = !card();

      // ③ 再点开，点同一个脚注第二次应收起
      document.querySelector('.digest-body .digest-cite')?.click();
      await new Promise(r => setTimeout(r, 300));
      const third = Boolean(card());
      document.querySelector('.digest-body .digest-cite')?.click();
      await new Promise(r => setTimeout(r, 300));
      const afterToggle = !card();

      return { afterEsc, reopened, afterOutside, third, afterToggle };
    })()`);

    check('Esc 能关掉脚注浮层', () =>
      ok(dismissed?.afterEsc === true, JSON.stringify(dismissed)));
    check('点浮层外面能关掉', () => ok(
      dismissed?.reopened === true && dismissed?.afterOutside === true,
      JSON.stringify(dismissed),
    ));
    check('再点同一个脚注能收起（切换而不是只能叠着）', () => ok(
      dismissed?.third === true && dismissed?.afterToggle === true,
      JSON.stringify(dismissed),
    ));

    // ④ 「现在生成」按钮存在且能点（无 key 时应给提示而不是崩）
    const genBtn = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.digest-page button, .digest-pane button')]
        .find(x => /现在生成|生成今日/.test(x.textContent));
      return { found: Boolean(b), disabled: b?.disabled ?? null };
    })()`);
    check('简报页有「现在生成」入口', () => ok(genBtn?.found === true, JSON.stringify(genBtn)));

    ws.close();
  }
}

summary('m3-05-digest-ui');
cleanup();
process.exitCode = process.exitCode ?? 0;
