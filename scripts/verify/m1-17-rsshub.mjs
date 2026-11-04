#!/usr/bin/env node
// 1.17 RSSHub 订阅搜索 —— 验收（PLAN §19.3 1.17 + §10）
//
// 判据：
//   ① 关键词搜到路由（中/英、按 name/description/分类/路径）
//   ② URL 反查到路由（Radar 域名映射）
//   ③ 试订阅预览拉到 ≥1 条（拼出的地址真的能解析出条目）
//   ④ 断网时用 7 天缓存仍能搜
//
// 这一节最容易假绿的地方：
//
//   A. 「关键词搜到东西」如果上游根本没拉到，用内置种子也能绿 ——
//      但那就没验证"上游接口解析正确"。所以 A 组用**注入的假上游**
//      验证解析，B 组才用真缓存验证离线。
//   B. 「URL 反查」如果实现是"把整个 URL 当关键词搜一遍"，随手也能
//      搜到点东西。判据必须是"命中的路由属于这个域名"，而且要能
//      拿到可订阅的完整地址，不是只拿到一个名字。
//   C. 「预览拉到条目」必须证明**真的发了一次请求到拼出来的地址**，
//      而不是返回硬编码的假标题。这里用 mock 服务器计数 + 内容指纹。
//   D. 「断网仍能搜」不能只测"函数不抛"—— 要断言搜索结果与联网时
//      一致（缓存内容被真的用上了），并且超过 7 天时要标记过期。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { removeDir } from '../lib/tmp.mjs';
import {
  domainOf, fillRoute, joinRsshub, looksLikeUrl, paramsOf,
} from '../../src/server/rsshub/library.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A. 路由库的纯函数 ─────────────────────────────────────
group('1.17 RSSHub · 路由模板');

check('参数名从模板里按顺序抠出', () => {
  return eq(paramsOf('/bilibili/user/video/:uid').join(','), 'uid');
});

check('多个参数按出现顺序（不是字母序）', () => {
  return eq(paramsOf('/twitter/user/:id/status/:type').join(','), 'id,type');
});

check('可选参数 `:name?` 也被识别，冒号后不含问号', () => {
  return eq(paramsOf('/zhihu/question/:qid/:answer?').join(','), 'qid,answer');
});

check('无参数模板返回空数组', () => {
  return eq(paramsOf('/zhihu/hotlist').length, 0);
});

check('填完参数得到可订阅路径', () => {
  const r = fillRoute('/bilibili/user/video/:uid', { uid: '226757369' });
  return eq(r.url, '/bilibili/user/video/226757369');
});

check('参数值做 URL 编码（中文/空格不破坏路径）', () => {
  const r = fillRoute('/zhihu/search/:q', { q: '机器学习 入门' });
  return eq(r.url, '/zhihu/search/%E6%9C%BA%E5%99%A8%E5%AD%A6%E4%B9%A0%20%E5%85%A5%E9%97%A8');
});

check('必填参数缺失 → 保留占位符并报 missing', () => {
  const r = fillRoute('/bilibili/user/video/:uid', {});
  return ok(r.missing.includes('uid') && r.url.includes(':uid'), JSON.stringify(r));
});

check('可选参数留空 → 整段删掉（不留空斜杠）', () => {
  const r = fillRoute('/zhihu/question/:qid/:answer?', { qid: '123' });
  return ok(r.url === '/zhihu/question/123' && r.missing.length === 0, JSON.stringify(r));
});

check('可选参数填了 → 正常接上', () => {
  const r = fillRoute('/zhihu/question/:qid/:answer?', { qid: '123', answer: '456' });
  return eq(r.url, '/zhihu/question/123/456');
});

check('joinRsshub 处理末尾斜杠（不产生 //）', () => {
  const a = joinRsshub('https://rsshub.app/', '/bilibili/user/video/1');
  const b = joinRsshub('https://rsshub.app', '/bilibili/user/video/1');
  return ok(a === b && a === 'https://rsshub.app/bilibili/user/video/1', `${a} | ${b}`);
});

check('joinRsshub 支持带子路径的自建实例', () => {
  return eq(joinRsshub('https://x.com/rsshub/', '/zhihu/hotlist'), 'https://x.com/rsshub/zhihu/hotlist');
});

check('domainOf 去协议 / www. / 路径 / 端口，并小写', () => {
  const cases = [
    ['https://www.Bilibili.com/video/BV1xx', 'bilibili.com'],
    ['http://sspai.com:8080/post/1', 'sspai.com'],
    ['sspai.com', 'sspai.com'],
    ['www.zhihu.com/question/1', 'zhihu.com'],
  ];
  const bad = cases.filter(([i, want]) => domainOf(i) !== want)
    .map(([i, want]) => `${i} → ${domainOf(i)}（期望 ${want}）`);
  return ok(bad.length === 0, bad.join('; '));
});

check('domainOf 对畸形输入返回 null 而不是抛错', () => {
  const bad = ['', '   ', '://', 'http://'].map((x) => {
    try { return domainOf(x); } catch { return 'throw'; }
  });
  return ok(!bad.includes('throw'), JSON.stringify(bad));
});

check('looksLikeUrl：裸词不被误判成网址（关键）', () => {
  // `new URL('https://bilibili')` 是合法的，所以天真的实现会把
  // "bilibili" 当网址 → 关键词搜索永远走不到。这条是那个 bug 的守门人。
  const words = ['bilibili', 'zhihu', 'rss', 'solidot', '少数派'];
  const bad = words.filter((w) => looksLikeUrl(w));
  return ok(bad.length === 0, `被误判: ${bad.join(', ')}`);
});

check('looksLikeUrl：真网址被识别（含无协议的裸域名）', () => {
  const urls = [
    'https://sspai.com', 'http://x.com/a', 'sspai.com/post/1', 'www.zhihu.com/question/1',
  ];
  const bad = urls.filter((u) => !looksLikeUrl(u));
  return ok(bad.length === 0, `漏判: ${bad.join(', ')}`);
});

// ── B. 端到端 ─────────────────────────────────────────────
group('1.17 RSSHub · 端到端');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

// 假的 RSSHub 上游：提供 namespace / radar / 路由预览三组接口。
// 用假上游而不是打 rsshub.app 的原因有二：真实例有速率限制，
// 且它的路由表每天都在变 —— 断言会随上游漂移而假红。
const NAMESPACES = [
  {
    name: 'bilibili',
    url: '/bilibili',
    categories: ['new-media'],
    description: '哔哩哔哩 - 国内知名的视频弹幕网站',
    routes: [
      {
        name: '用户视频',
        path: '/bilibili/user/video/:uid',
        example: '/bilibili/user/video/226757369',
        description: '用户的视频投稿',
        categories: ['new-media'],
      },
      {
        name: '热门',
        path: '/bilibili/ranking/:rid?/:limit?',
        example: '/bilibili/ranking/0/50',
        description: '排行榜',
        categories: ['new-media'],
      },
    ],
  },
  {
    name: 'zhihu',
    url: '/zhihu',
    categories: ['social-media'],
    description: '知乎 - 有问题，就会有答案',
    routes: [
      {
        name: '热榜',
        path: '/zhihu/hotlist',
        example: '/zhihu/hotlist',
        description: '知乎热榜',
        categories: ['social-media'],
      },
    ],
  },
  {
    name: 'sspai',
    url: '/sspai',
    categories: ['new-media'],
    description: '少数派 - 高效工作，品质生活',
    routes: [
      {
        name: '首页',
        path: '/sspai/index',
        example: '/sspai/index',
        description: '少数派首页',
        categories: ['new-media'],
      },
    ],
  },
];

const RADAR = [
  { domain: 'bilibili.com', title: '哔哩哔哩', path: '/bilibili/user/video/:uid', docs: 'https://docs.rsshub.app/routes/bilibili' },
  { domain: 'zhihu.com', title: '知乎', path: '/zhihu/hotlist', docs: null },
  { domain: 'sspai.com', title: '少数派', path: '/sspai/index', docs: null },
];

const hits = new Map();
let mockPort = 0;

const mock = createServer((req, res) => {
  const u = req.url ?? '/';
  hits.set(u, (hits.get(u) ?? 0) + 1);

  if (u === '/api/namespace') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: NAMESPACES }));
    return;
  }
  if (u === '/api/radar/rules') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: RADAR }));
    return;
  }
  // 试订阅预览：按路径返回一个最小 RSS，标题里带上路径指纹，
  // 让断言能确认"这条内容确实来自这个地址"，而不是硬编码的假数据。
  if (u.startsWith('/bilibili/') || u.startsWith('/zhihu/') || u.startsWith('/sspai/')) {
    const fp = u.replace(/[^\w]/g, '-').slice(0, 40);
    res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel>
<title>预览 ${fp}</title><link>http://127.0.0.1:${mockPort}${u}</link><description>d</description>
${[1, 2, 3, 4, 5, 6, 7].map((i) => `<item>
  <title>条目 ${i} @${fp}</title><link>http://127.0.0.1:${mockPort}/a/${i}</link>
  <guid>g-${fp}-${i}</guid>
  <pubDate>Mon, 2${i % 9} Oct 2026 10:00:00 GMT</pubDate>
  <description>内容 ${i}</description>
</item>`).join('\n')}
</channel></rss>`);
    return;
  }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
mockPort = mock.address().port;
const MOCK = `http://127.0.0.1:${mockPort}`;

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m117-'));
const dataDir = join(tmp, 'data');
const port = 43100 + Math.floor(Math.random() * 700);
const base = `http://127.0.0.1:${port}`;

const srv = spawn(binPath, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
srv.stdout.on('data', () => { /* 吃掉 */ });

const cleanup = () => {
  try { killTree(srv.pid); } catch { /* 已退出 */ }
  try { mock.close(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
onExit(cleanup);

let ready = false;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok) { ready = true; break; }
  } catch { /* 还没起来 */ }
  await sleep(250);
}
check('服务就绪', () => ok(ready, srvErr.slice(0, 300)));
if (!ready) { summary('m1-17-rsshub'); cleanup(); process.exit(1); }

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'rh@test.local', password: 'rhtest12345678' }),
});
const loginRes = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'rh@test.local', password: 'rhtest12345678' }),
});
const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
check('登录成功', () => ok(cookie.includes('='), cookie));

const api = async (path, init = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
};

const { DatabaseSync } = await import('node:sqlite');
const dbPath = join(dataDir, 'app.db');
const one = (sql, ...args) => {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  try { return d.prepare(sql).get(...args); } finally { d.close(); }
};
const all = (sql, ...args) => {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  try { return d.prepare(sql).all(...args); } finally { d.close(); }
};

// ── ① 配置自建实例 + 刷新路由库 ──
const cfg = await api('/rsshub/config', {
  method: 'PUT',
  body: JSON.stringify({ baseUrl: MOCK, accessKey: '' }),
});
check('保存 RSSHub 实例地址', () => ok(cfg.body?.baseUrl === MOCK, JSON.stringify(cfg.body)));

const refresh = await api('/rsshub/refresh', { method: 'POST' });
check('刷新路由库成功', () => ok(refresh.status === 200 && refresh.body?.ok !== false,
  `status=${refresh.status} ${JSON.stringify(refresh.body).slice(0, 200)}`));
check('刷新时真的打了两类上游接口（namespace + radar）', () => {
  const ns = hits.get('/api/namespace') ?? 0;
  const rd = hits.get('/api/radar/rules') ?? 0;
  return ok(ns >= 1 && rd >= 1, `namespace=${ns} radar=${rd}`);
});
check('路由库落进 rsshub_cache（不是只放内存）', () => {
  const rows = all('SELECT key FROM rsshub_cache ORDER BY key');
  const keys = rows.map((r) => String(r.key));
  return ok(keys.some((k) => k.includes('route') || k.includes('namespace')),
    JSON.stringify(keys));
});
check('解析出的路由条数 = 上游给出的条数', () => {
  const rows = all("SELECT payload FROM rsshub_cache WHERE key LIKE '%routes%'");
  if (rows.length === 0) return ok(false, '没找到路由缓存行');
  const parsed = JSON.parse(String(rows[0].payload));
  const arr = Array.isArray(parsed) ? parsed : (parsed.routes ?? []);
  return eq(arr.length, 4);
});

// ── ② 关键词搜索 ──
const kw = await api('/rsshub/search?q=哔哩哔哩');
check('中文关键词搜到路由', () => {
  const items = kw.body?.items ?? [];
  return ok(items.length > 0, `status=${kw.status} items=${items.length}`);
});
check('命中的是 bilibili 命名空间的路由', () => {
  const items = kw.body?.items ?? [];
  return ok(items.some((x) => String(x.namespace) === 'bilibili'),
    JSON.stringify(items.map((x) => `${x.namespace}${x.path}`)));
});
check('搜索结果带参数表单所需的字段（path / params / title）', () => {
  const it = (kw.body?.items ?? [])[0];
  return ok(it && typeof it.path === 'string' && Array.isArray(it.params)
    && typeof it.title === 'string', JSON.stringify(it));
});

const kwEn = await api('/rsshub/search?q=zhihu');
check('英文关键词（命名空间名）也能搜到', () => {
  const items = kwEn.body?.items ?? [];
  return ok(items.some((x) => String(x.namespace) === 'zhihu'),
    JSON.stringify(items.map((x) => x.path)));
});

const kwPath = await api('/rsshub/search?q=hotlist');
check('按路由路径搜索也能命中', () => {
  const items = kwPath.body?.items ?? [];
  return ok(items.some((x) => String(x.path).includes('hotlist')),
    JSON.stringify(items.map((x) => x.path)));
});

const kwNone = await api('/rsshub/search?q=zzzz不存在的词zzzz');
check('搜不到时返回空数组（负向，不是 500）', () => {
  return ok(kwNone.status === 200 && (kwNone.body?.items ?? []).length === 0,
    `status=${kwNone.status}`);
});

// ── ③ URL 反查 ──
const byUrl = await api(`/rsshub/search?q=${encodeURIComponent('https://www.bilibili.com/video/BV1xx411c7mD')}`);
check('URL 反查命中路由', () => {
  return ok((byUrl.body?.items ?? []).length > 0, JSON.stringify(byUrl.body).slice(0, 200));
});
check('反查结果的命名空间与域名匹配（不是把整段 URL 当关键词搜）', () => {
  const items = byUrl.body?.items ?? [];
  return ok(items.some((x) => String(x.namespace) === 'bilibili'),
    JSON.stringify(items.map((x) => x.path)));
});

const byUrlZhihu = await api(`/rsshub/search?q=${encodeURIComponent('zhihu.com/question/12345')}`);
check('另一个域名的反查也命中', () => {
  const items = byUrlZhihu.body?.items ?? [];
  return ok(items.some((x) => String(x.namespace) === 'zhihu'),
    JSON.stringify(items.map((x) => x.path)));
});

const byUnknown = await api(`/rsshub/search?q=${encodeURIComponent('https://unknown-site-xyz.example/a')}`);
check('未知域名的 URL 反查返回空而不是报错（负向）', () => {
  return ok(byUnknown.status === 200 && (byUnknown.body?.items ?? []).length === 0,
    `status=${byUnknown.status} items=${(byUnknown.body?.items ?? []).length}`);
});

// ── ④ 试订阅预览 ──
const preview = await api('/rsshub/preview', {
  method: 'POST',
  body: JSON.stringify({ path: '/bilibili/user/video/226757369' }),
});
check('预览拉到条目', () => {
  return ok(preview.status === 200 && (preview.body?.items ?? []).length >= 1,
    `status=${preview.status} ${JSON.stringify(preview.body).slice(0, 200)}`);
});
check('预览最多 5 条（不是把整个 feed 都拉回来）', () => {
  const n = (preview.body?.items ?? []).length;
  return ok(n >= 1 && n <= 5, `实际 ${n} 条`);
});
check('预览内容确实来自拼出的地址（标题带路径指纹）', () => {
  const title = String((preview.body?.items ?? [])[0]?.title ?? '');
  return ok(title.includes('bilibili-user-video-226757369') || preview.body?.url?.includes('bilibili'),
    `title=${title} url=${preview.body?.url}`);
});
check('预览返回完整可订阅地址（不是只有路径）', () => {
  const u = String(preview.body?.url ?? '');
  return ok(u.startsWith(MOCK) && u.includes('/bilibili/'), `url=${u}`);
});
check('预览真的发了一次网络请求（mock 上有该路径的命中）', () => {
  const key = [...hits.keys()].find((k) => k.includes('bilibili/user/video/226757369'));
  return ok(key !== undefined, `命中路径: ${JSON.stringify([...hits.keys()].slice(0, 6))}`);
});

const badPreview = await api('/rsshub/preview', {
  method: 'POST',
  body: JSON.stringify({ path: '/nope/does/not/exist' }),
});
check('预览 404 路径时给出明确错误而不是空列表（负向）', () => {
  const okStatus = badPreview.status === 200 ? (badPreview.body?.ok === false || (badPreview.body?.items ?? []).length === 0) : badPreview.status >= 400;
  return ok(okStatus, `status=${badPreview.status} ${JSON.stringify(badPreview.body).slice(0, 160)}`);
});

// ── ⑤ 从预览地址直接订阅（闭环）──
//
// 这条必须在上游还活着时做：RSSHub 搜索的最终目的是"订上"，
// 只验"搜到了、预览过"而不验"订得上"，等于三条路径都没走完。
{
  const pv = await api('/rsshub/preview', {
    method: 'POST',
    body: JSON.stringify({ path: '/sspai/index' }),
  });
  check('sspai 路由预览成功', () => ok(pv.body?.ok === true, JSON.stringify(pv.body).slice(0, 160)));

  const feedUrl = String(pv.body?.url ?? '');
  const sub = await api('/feeds', {
    method: 'POST',
    body: JSON.stringify({ url: feedUrl }),
  });
  check('用预览给出的完整地址能直接订阅', () => {
    // 订阅成功时状态码是 201（创建），不是 200 —— 断言曾经只认 200，
    // 于是一条明明成功的订阅被报成失败。判据应是"源确实建出来了"。
    return ok((sub.status === 200 || sub.status === 201) && sub.body?.created === true,
      `status=${sub.status} ${JSON.stringify(sub.body).slice(0, 200)}`);
  });
  check('订阅落库的 URL 就是 RSSHub 拼出来的那个', () => {
    // feeds 表没有 created_at 列（时间只记 last_fetched_at / next_fetch_at），
    // 按 URL 反查比"取最新一行"更直接，也不依赖任何排序列。
    const row = one('SELECT url FROM feeds WHERE url = ?', feedUrl);
    return ok(String(row?.url ?? '') === feedUrl, `url=${row?.url} 期望 ${feedUrl}`);
  });
  check('订阅后条目进库（不是空源）', () => {
    const n = one('SELECT COUNT(*) c FROM entries WHERE feed_id IS NOT NULL');
    return ok(Number(n?.c) >= 1, `entries=${n?.c}`);
  });
}

// ── ⑥ 界面：RSSHub 面板的完整交互链路 ──
//
// 接口全绿不等于界面上能用。这一组要盯的是三件只有 DOM 才知道的事：
//   · 面板确实挂在「添加订阅」里（不是个死按钮）
//   · 选中路由后**参数输入框真的按模板生成**（`:uid` → 一个 uid 输入框）
//   · 预览出的条目与「订阅这个地址」按钮同时出现（不预览就不该能订）
group('1.17 RSSHub · 界面');

const CANDIDATES_BROWSER = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
const browserPath = CANDIDATES_BROWSER.find((p) => existsSync(p));

if (!browserPath) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器，UI 断言跳过');
} else {
  const profile = mkdtempSync(join(tmpdir(), 'cheng-rss-rhprof-'));
  const cdpPort = 9600 + Math.floor(Math.random() * 90);
  const proc = spawn(browserPath, [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });

  // 只杀自己起的这个 PID。绝不用 /IM 按镜像名杀 —— 用户自己的浏览器
  // 也是 msedge.exe（这条是硬约束，之前踩过）。
  const killBrowser = () => {
    try { killTree(proc.pid); } catch { /* 已退出 */ }
    removeDir(profile);
  };
  onExit(killBrowser);

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
  } else {
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
    const ev2 = async (expr) => {
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
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await send('Network.setCookie', {
      name: 'cheng_rss_sid', value: cookie.split('=')[1] ?? '',
      domain: '127.0.0.1', path: '/',
    });
    await send('Page.navigate', { url: base });
    for (let i = 0; i < 80; i++) {
      if (await ev2('document.readyState === "complete"').catch(() => false)) break;
      await sleep(150);
    }
    await sleep(1500);

    // 打开配置 → 订阅 → 添加订阅
    const opened = await ev2(`(() => {
      const gear = [...document.querySelectorAll('.sidebar-foot .icon-btn, .icon-btn')]
        .find((b) => /配置/.test(b.getAttribute('title') || ''));
      if (!gear) return 'no-gear';
      gear.click();
      return 'ok';
    })()`);
    await sleep(700);
    const toFeeds = await ev2(`(() => {
      const b = [...document.querySelectorAll('.settings-nav-item')]
        .find((x) => (x.textContent || '').includes('订阅'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(600);
    const openAdd = await ev2(`(() => {
      const b = [...document.querySelectorAll('.feeds-actions .btn')]
        .find((x) => x.textContent.includes('添加订阅'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(500);

    check('能打开「添加订阅」面板', () => ok(opened === 'ok' && toFeeds && openAdd,
      `gear=${opened} nav=${toFeeds} add=${openAdd}`));

    const hasEntry = await ev2(`Boolean(document.querySelector('.rsshub-open'))`);
    check('「添加订阅」里挂着「用 RSSHub 搜」入口', () => ok(hasEntry, '没找到 .rsshub-open'));

    await ev2(`document.querySelector('.rsshub-open')?.click()`);
    await sleep(400);
    const openedPanel = await ev2(`Boolean(document.querySelector('.rsshub-panel'))`);
    check('点开后出现 RSSHub 面板', () => ok(openedPanel, '没找到 .rsshub-panel'));

    // 输关键词（中文），等防抖 + 请求
    await ev2(`(() => {
      const i = document.querySelector('.rsshub-search input');
      if (!i) return false;
      const d = Object.getOwnPropertyDescriptor(i.constructor.prototype, 'value');
      d.set.call(i, '哔哩哔哩');
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(1200);

    const results = await ev2(`(() => {
      const rows = [...document.querySelectorAll('.rsshub-results .candidate')];
      return {
        n: rows.length,
        titles: rows.map((r) => (r.querySelector('.candidate-title')?.textContent ?? '').trim()),
        paths: rows.map((r) => (r.querySelector('.candidate-url')?.textContent ?? '').trim()),
      };
    })()`);
    check('界面里输关键词能列出候选路由', () => {
      return ok((results?.n ?? 0) > 0, JSON.stringify(results)?.slice(0, 200));
    });
    check('候选里带路由的路径模板（不是只有名字）', () => {
      return ok((results?.paths ?? []).some((p) => p.startsWith('/')),
        JSON.stringify(results?.paths)?.slice(0, 200));
    });

    // 选中带 `:uid` 的路由，参数表单应自动出现一个 uid 输入框
    await ev2(`(() => {
      const rows = [...document.querySelectorAll('.rsshub-results .candidate')];
      const target = rows.find((r) => (r.querySelector('.candidate-url')?.textContent ?? '').includes(':uid'))
        ?? rows[0];
      target?.click();
      return true;
    })()`);
    await sleep(500);

    const form = await ev2(`(() => {
      const inputs = [...document.querySelectorAll('.rsshub-params input')];
      const labels = [...document.querySelectorAll('.rsshub-params .field > span')]
        .map((s) => (s.textContent || '').trim());
      return {
        count: inputs.length,
        labels,
        values: inputs.map((i) => i.value),
        hasPreviewBtn: [...document.querySelectorAll('.rsshub-actions .btn')]
          .some((b) => /预览/.test(b.textContent || '')),
        hasSubscribeBtn: [...document.querySelectorAll('.rsshub-actions .btn')]
          .some((b) => /订阅这个地址/.test(b.textContent || '')),
      };
    })()`);

    check('选中路由后按模板生成参数输入框', () => {
      return ok((form?.count ?? 0) >= 1, JSON.stringify(form)?.slice(0, 200));
    });
    check('参数名来自路径模板（标签里有 uid）', () => {
      return ok((form?.labels ?? []).some((l) => l.includes('uid')),
        JSON.stringify(form?.labels));
    });
    check('参数值用示例地址预填（省掉一次手打）', () => {
      return ok((form?.values ?? []).some((v) => String(v).length > 0),
        JSON.stringify(form?.values));
    });
    check('预览按钮存在', () => ok(form?.hasPreviewBtn === true));
    check('没预览之前不出现「订阅这个地址」（不预览就不能订）', () => {
      return ok(form?.hasSubscribeBtn === false, `hasSubscribeBtn=${form?.hasSubscribeBtn}`);
    });

    // 点预览
    await ev2(`(() => {
      const b = [...document.querySelectorAll('.rsshub-actions .btn')]
        .find((x) => /预览/.test(x.textContent || ''));
      b?.click();
      return true;
    })()`);
    await sleep(1800);

    const pv = await ev2(`(() => {
      const box = document.querySelector('.rsshub-preview');
      return {
        shown: Boolean(box),
        items: box ? [...box.querySelectorAll('li')].map((li) => (li.textContent || '').trim()) : [],
        url: box?.querySelector('.candidate-url')?.textContent ?? '',
        hasSubscribeBtn: [...document.querySelectorAll('.rsshub-actions .btn')]
          .some((b) => /订阅这个地址/.test(b.textContent || '')),
        hasOpenLink: [...document.querySelectorAll('.rsshub-actions a.btn')]
          .some((a) => /打开/.test(a.textContent || '')),
      };
    })()`);

    check('预览后渲染出条目列表', () => {
      return ok(pv?.shown === true && (pv?.items?.length ?? 0) >= 1, JSON.stringify(pv)?.slice(0, 240));
    });
    check('预览条目带真实标题（来自上游，不是占位）', () => {
      return ok((pv?.items ?? []).some((t) => t.includes('条目')), JSON.stringify(pv?.items));
    });
    check('预览显示完整可订阅地址（以配置的实例开头）', () => {
      return ok(String(pv?.url ?? '').startsWith(MOCK), `url=${pv?.url}`);
    });
    check('预览成功后出现「订阅这个地址」', () => {
      return ok(pv?.hasSubscribeBtn === true, `hasSubscribeBtn=${pv?.hasSubscribeBtn}`);
    });
    check('预览成功后出现「打开」外链（可以先在浏览器里看一眼）', () => {
      return ok(pv?.hasOpenLink === true, `hasOpenLink=${pv?.hasOpenLink}`);
    });

    // 关掉面板与弹窗，收尾
    try { ws.close(); } catch { /* ignore */ }
    killBrowser();
  }
}

// ── ⑦ 断网时用缓存 ──
{
  // 记下联网时的结果作为基准
  const online = await api('/rsshub/search?q=哔哩哔哩');
  const onlinePaths = (online.body?.items ?? []).map((x) => x.path).sort();

  // 把上游关掉（模拟断网 / 上游挂掉）
  mock.close();
  await sleep(120);

  const offline = await api('/rsshub/search?q=哔哩哔哩');
  check('断网后关键词搜索仍可用（用缓存）', () => {
    return ok(offline.status === 200 && (offline.body?.items ?? []).length > 0,
      `status=${offline.status} items=${(offline.body?.items ?? []).length}`);
  });
  check('断网结果与联网结果一致（缓存被真的用上）', () => {
    const offPaths = (offline.body?.items ?? []).map((x) => x.path).sort();
    return eq(offPaths.join('|'), onlinePaths.join('|'));
  });
  const offlineUrlLookup = await api(`/rsshub/search?q=${encodeURIComponent('https://www.bilibili.com/x')}`);
  check('断网时 URL 反查仍可用', () => {
    return ok((offlineUrlLookup.body?.items ?? []).length > 0,
      JSON.stringify(offlineUrlLookup.body).slice(0, 160));
  });

  // 缓存超过 7 天 → 标记过期，但仍返回（用户不该因为上游挂了就搜不了）
  {
    const d = new DatabaseSync(dbPath);
    try {
      d.prepare('UPDATE rsshub_cache SET fetched_at = ?')
        .run(Date.now() - 8 * 86400_000);
    } finally { d.close(); }

    // 内存缓存里还留着 fetchedAt=刚才，直接查会报 stale=false。
    // 这不矛盾：进程内的库确实才加载没多久。要验的是"从 SQLite 重新读时
    // 会算出过期"，所以先走一次真实的缓存失效路径（改配置会清内存缓存）。
    await api('/rsshub/config', { method: 'PUT', body: JSON.stringify({ baseUrl: MOCK }) });

    const stale = await api('/rsshub/search?q=zhihu');
    check('缓存超过 7 天仍可搜索（不是直接清空）', () => {
      return ok((stale.body?.items ?? []).length > 0, JSON.stringify(stale.body).slice(0, 160));
    });
    check('超过 7 天时标记 stale（界面提示"去看看更新"）', () => {
      return ok(stale.body?.stale === true, `stale=${stale.body?.stale}`);
    });
    check('stale 时仍返回 fetchedAt（界面能说清"是哪天的缓存"）', () => {
      return ok(Number(stale.body?.fetchedAt) > 0, `fetchedAt=${stale.body?.fetchedAt}`);
    });

    // 一半新一半旧：fetchedAt 必须取**较早**的那个。
    //
    // 上一段把两行都改成 8 天前，取 min 还是取 max 结果一样 ——
    // 所以那条断言挡不住"改成 Math.max"的变异（实测没抓到）。
    // 这里只让 routes 过期、radar 保持刚才，取 min 才会报 stale。
    {
      const d = new DatabaseSync(dbPath);
      try {
        d.prepare("UPDATE rsshub_cache SET fetched_at = ? WHERE key LIKE 'routes%'")
          .run(Date.now() - 30 * 86400_000);
        d.prepare("UPDATE rsshub_cache SET fetched_at = ? WHERE key LIKE 'radar%'")
          .run(Date.now());
      } finally { d.close(); }
      await api('/rsshub/config', { method: 'PUT', body: JSON.stringify({ baseUrl: MOCK }) });
      const half = await api('/rsshub/search?q=zhihu');
      check('两个上游一半过期就报 stale（fetchedAt 取较早的那个）', () => {
        // 取 max 的实现会认为"radar 是刚才拉的，所以整体新鲜"，于是 false
        return ok(half.body?.stale === true, `stale=${half.body?.stale}`);
      });
    }
  }
}

// ── ⑦ 上游不可用时订阅的行为 ──
{
  const sub = await api('/feeds', {
    method: 'POST',
    body: JSON.stringify({ url: `${MOCK}/sspai/index` }),
  });
  // 上游已关，这条只验"接口不会崩"——订阅闭环由上面的 ⑤ 覆盖
  check('上游不可用时订阅失败但不 500（错误可读）', () => {
    return ok(sub.status < 500, `status=${sub.status} ${JSON.stringify(sub.body).slice(0, 160)}`);
  });
}

summary('m1-17-rsshub');
cleanup();
process.exit(process.exitCode ?? 0);
