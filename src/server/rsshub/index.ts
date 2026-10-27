import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseFeed, type ParsedFeed } from '../feeds/parse.ts';
import { fetchFeed } from '../feeds/fetch.ts';
import {
  domainOf, fillRoute, joinRsshub, looksLikeUrl, paramsOf,
  type RadarRule, type RouteLibrary, type RouteTemplate,
} from './library.ts';

// RSSHub 路由库：拉取、缓存、搜索（PLAN §10）。
//
// 三层缓存：
//   · 内存（进程内，Map）—— 一次搜索要扫上千条路由，每次去 SQLite 反序列化
//     一份 1MB 的 JSON 是纯浪费。热路径必须走内存。
//   · SQLite `rsshub_cache` —— 进程重启后不用重新拉上游（冷启动要几百 KB、
//     2~5 秒，而公共实例还有速率限制）。
//   · 内置种子 —— 连 SQLite 都是空的时候（首次启动且断网）仍要能搜出东西，
//     否则用户第一次打开这个功能看到的是空白。
//
// 为什么缓存 TTL 是 7 天而不是 1 天：路由表变动很慢（新增路由才需要更新），
// 而每次刷新要打两次上游、拉几百 KB。7 天是"足够新鲜 vs 不打扰上游"的折中。

/** 缓存有效期（PLAN §10.5 的 7 天） */
export const CACHE_TTL_MS = 7 * 86400_000;

/** 上游单次拉取超时。公共实例偶尔很慢，5s 之后放弃比让 UI 转圈好 */
const UPSTREAM_TIMEOUT_MS = 5000;

const CACHE_KEY_ROUTES = 'routes:v1';
const CACHE_KEY_RADAR = 'radar:v1';

export interface RsshubSettings {
  baseUrl: string;
  accessKey: string;
}

export const DEFAULT_BASE_URL = 'https://rsshub.app';

/**
 * 从 settings 行读出配置。
 *
 * 默认值必须给公共实例：用户第一次打开「RSSHub 搜索」时不该先被要求
 * 去填一个他自己也不确定的地址。填错或没填时的报错要能指回这里。
 */
export function readSettings(db: DatabaseSync, userId: string): RsshubSettings {
  const row = db.prepare('SELECT rsshub_config FROM settings WHERE user_id = ?')
    .get(userId) as { rsshub_config: string | null } | undefined;
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(row?.rsshub_config ?? '{}') as Record<string, unknown>; } catch { raw = {}; }
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim()
    ? raw.baseUrl.trim()
    : DEFAULT_BASE_URL;
  const accessKey = typeof raw.accessKey === 'string' ? raw.accessKey.trim() : '';
  return { baseUrl, accessKey };
}

export function writeSettings(db: DatabaseSync, userId: string, patch: Partial<RsshubSettings>): RsshubSettings {
  const cur = readSettings(db, userId);
  const next: RsshubSettings = {
    baseUrl: patch.baseUrl === undefined ? cur.baseUrl : (patch.baseUrl.trim() || DEFAULT_BASE_URL),
    accessKey: patch.accessKey === undefined ? cur.accessKey : patch.accessKey.trim(),
  };
  db.prepare(`
    INSERT INTO settings (user_id, rsshub_config) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET rsshub_config = excluded.rsshub_config
  `).run(userId, JSON.stringify(next));
  return next;
}

// ── 内存缓存 ──────────────────────────────────────────────
//
// 按 userId 分：多人模式下每人的实例地址不同，共用一份会把 A 的路由
// 当成 B 的。单用户时只是一个 size=1 的 Map，没有额外成本。
const memCache = new Map<string, RouteLibrary>();

/** 测试与「刷新路由库」共用：清掉内存缓存 */
export function clearMemoryCache(userId?: string): void {
  if (userId) memCache.delete(userId);
  else memCache.clear();
}

interface CacheRow { payload: string; fetched_at: number }

function readCacheRow(db: DatabaseSync, key: string): CacheRow | null {
  return (db.prepare('SELECT payload, fetched_at FROM rsshub_cache WHERE key = ?')
    .get(key) as CacheRow | undefined) ?? null;
}

function writeCacheRow(db: DatabaseSync, key: string, payload: string, now = Date.now()): void {
  db.prepare(`
    INSERT INTO rsshub_cache (key, payload, fetched_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
  `).run(key, payload, now);
}

// ── 内置种子 ──────────────────────────────────────────────
//
// 为什么需要：首次启动且断网时，路由库是空的 —— 那时用户搜任何东西都
// 得到空白，看起来像功能坏了。种子只放最常用的几条，作用是"有东西可搜、
// 同时提示去刷新"，不是"替代上游"。
const SEED_ROUTES: RouteTemplate[] = [
  {
    key: 'bilibili/user/video', title: 'Bilibili 用户视频', namespace: 'bilibili',
    path: '/bilibili/user/video/:uid', example: '/bilibili/user/video/226757369',
    categories: ['new-media'], description: '一个 UP 主的视频投稿',
    namespaceDescription: '哔哩哔哩 - 国内知名的视频弹幕网站',
    params: paramsOf('/bilibili/user/video/:uid'), paramDocs: [{ name: 'uid', description: '用户 ID' }],
  },
  {
    key: 'zhihu/hotlist', title: '知乎热榜', namespace: 'zhihu',
    path: '/zhihu/hotlist', example: '/zhihu/hotlist',
    categories: ['social-media'], description: '知乎热榜',
    namespaceDescription: '知乎 - 有问题，就会有答案',
    params: [], paramDocs: [],
  },
  {
    key: 'sspai/index', title: '少数派首页', namespace: 'sspai',
    path: '/sspai/index', example: '/sspai/index',
    categories: ['new-media'], description: '少数派首页文章',
    namespaceDescription: '少数派 - 高效工作，品质生活',
    params: [], paramDocs: [],
  },
  {
    key: 'github/issue', title: 'GitHub 仓库 Issue', namespace: 'github',
    path: '/github/issue/:user/:repo', example: '/github/issue/DIYgod/RSSHub',
    categories: ['programming'], description: '仓库的 Issue 列表',
    namespaceDescription: 'GitHub - 代码托管平台',
    params: paramsOf('/github/issue/:user/:repo'),
    paramDocs: [{ name: 'user', description: '用户名' }, { name: 'repo', description: '仓库名' }],
  },
  {
    key: 'youtube/channel', title: 'YouTube 频道', namespace: 'youtube',
    path: '/youtube/channel/:id', example: '/youtube/channel/UC1',
    categories: ['multimedia'], description: '频道的视频更新',
    namespaceDescription: 'YouTube - 视频分享平台',
    params: paramsOf('/youtube/channel/:id'), paramDocs: [{ name: 'id', description: '频道 ID' }],
  },
];

const SEED_RADAR: RadarRule[] = [
  { domain: 'bilibili.com', title: '哔哩哔哩', path: '/bilibili/user/video/:uid', docs: null },
  { domain: 'zhihu.com', title: '知乎', path: '/zhihu/hotlist', docs: null },
  { domain: 'sspai.com', title: '少数派', path: '/sspai/index', docs: null },
  { domain: 'github.com', title: 'GitHub', path: '/github/issue/:user/:repo', docs: null },
  { domain: 'youtube.com', title: 'YouTube', path: '/youtube/channel/:id', docs: null },
];

// ── 上游解析 ──────────────────────────────────────────────

/** 上游给的是一条路由还是一个命名空间，形状不确定 —— 两种都吃 */
function normalizeRoutes(raw: unknown): RouteTemplate[] {
  const out: RouteTemplate[] = [];
  const push = (title: string, path: string, example: string | null,
    ns: string, categories: string[], description: string, docs: unknown,
    nsDescription = ''): void => {
    if (!path || !path.startsWith('/')) return;
    const key = path.replace(/^\/+/, '').replace(/\/:[^/]+/g, '').replace(/\/+$/, '') || path;
    const paramDocs: { name: string; description: string }[] = [];
    if (docs && typeof docs === 'object') {
      for (const [name, d] of Object.entries(docs as Record<string, unknown>)) {
        const desc = typeof d === 'string' ? d
          : (d && typeof d === 'object' && typeof (d as { description?: unknown }).description === 'string')
            ? String((d as { description: string }).description) : '';
        paramDocs.push({ name, description: desc });
      }
    }
    out.push({
      key, title: title || path, namespace: ns, path,
      example: example || null, categories, description,
      namespaceDescription: nsDescription,
      params: paramsOf(path), paramDocs,
    });
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;

    // 命名空间节点：有 routes 数组
    if (Array.isArray(o.routes)) {
      const ns = String(o.name ?? '');
      const nsDesc = String(o.description ?? '');
      const nsCats = Array.isArray(o.categories) ? o.categories.map(String) : [];
      for (const r of o.routes) {
        if (!r || typeof r !== 'object') continue;
        const rr = r as Record<string, unknown>;
        push(String(rr.name ?? ''), String(rr.path ?? rr.url ?? ''),
          rr.example ? String(rr.example) : null,
          ns, Array.isArray(rr.categories) ? rr.categories.map(String) : nsCats,
          String(rr.description ?? nsDesc), rr.parameters ?? rr.params, nsDesc);
      }
      return;
    }
    // 单条路由节点
    if (typeof o.path === 'string' && o.path.startsWith('/')) {
      push(String(o.name ?? o.title ?? ''), o.path,
        o.example ? String(o.example) : null,
        String(o.namespace ?? (o.path.split('/')[1] ?? '')),
        Array.isArray(o.categories) ? o.categories.map(String) : [],
        String(o.description ?? ''), o.parameters ?? o.params,
        String(o.namespaceDescription ?? o.nsDescription ?? ''));
      return;
    }
    // 包装层（`{data:[...]}` / `{routes:{...}}` / 上游任意 envelope）：
    // 自己不是路由也不是命名空间，就往下挖。
    //
    // 少了这一句时整个函数对上 `{data:[...]}` 返回 0 条，而报错是
    // 「namespace 返回了 0 条路由」—— 看着像上游没数据，实际是没递归。
    for (const v of Object.values(o)) walk(v);
  };
  walk(raw);
  return out;
}

function normalizeRadar(raw: unknown): RadarRule[] {
  const out: RadarRule[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (typeof o.domain === 'string' && typeof o.path === 'string') {
      out.push({
        domain: o.domain.toLowerCase().replace(/^www\./, ''),
        title: String(o.title ?? o.domain),
        path: o.path,
        docs: o.docs ? String(o.docs) : null,
      });
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(raw);
  return out;
}

async function fetchJson(url: string, accessKey: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (accessKey) headers['x-access-key'] = accessKey;
    const res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class RsshubError extends Error {
  readonly code: 'UPSTREAM' | 'NOT_CONFIGURED' | 'BAD_PATH';
  constructor(code: 'UPSTREAM' | 'NOT_CONFIGURED' | 'BAD_PATH', message: string) {
    super(message);
    this.name = 'RsshubError';
    this.code = code;
  }
}

/**
 * 刷新路由库。
 *
 * 两个上游接口**各自独立成败**：namespace 成功、radar 失败时，前者照样
 * 落库 —— 整体回滚会让"关键词能搜但 URL 反查不行"变成"两个都不能用"，
 * 而前者占搜索量的绝大多数。
 */
export async function refreshLibrary(
  db: DatabaseSync,
  userId: string,
  settings: RsshubSettings,
): Promise<{ routes: number; radar: number; errors: string[] }> {
  const base = settings.baseUrl.replace(/\/+$/, '');
  const errors: string[] = [];
  let routes: RouteTemplate[] = [];
  let radar: RadarRule[] = [];

  try {
    const ns = await fetchJson(`${base}/api/namespace`, settings.accessKey);
    routes = normalizeRoutes(ns);
    if (routes.length === 0) errors.push('namespace 返回了 0 条路由');
  } catch (e) {
    errors.push(`拉取 namespace 失败: ${(e as Error).message}`);
  }

  try {
    const rd = await fetchJson(`${base}/api/radar/rules`, settings.accessKey);
    radar = normalizeRadar(rd);
  } catch (e) {
    errors.push(`拉取 radar 失败: ${(e as Error).message}`);
  }

  const now = Date.now();
  if (routes.length > 0) {
    writeCacheRow(db, CACHE_KEY_ROUTES, JSON.stringify(routes), now);
  }
  if (radar.length > 0) {
    writeCacheRow(db, CACHE_KEY_RADAR, JSON.stringify(radar), now);
  }
  clearMemoryCache(userId);
  return { routes: routes.length, radar: radar.length, errors };
}

/**
 * 取路由库（内存 → SQLite → 种子）。
 *
 * 返回 `stale` 让 UI 能提示"缓存已经 8 天了，去刷新一下"，
 * 而不是替用户决定"过期了就不给用" —— 上游挂掉时还能搜到东西，
 * 比一个干净的空白页有用得多。
 */
export function loadLibrary(db: DatabaseSync, userId: string): RouteLibrary & { stale: boolean } {
  const cached = memCache.get(userId);
  if (cached) {
    return { ...cached, stale: Date.now() - cached.fetchedAt > CACHE_TTL_MS };
  }

  const routesRow = readCacheRow(db, CACHE_KEY_ROUTES);
  const radarRow = readCacheRow(db, CACHE_KEY_RADAR);

  let routes: RouteTemplate[] = [];
  let radar: RadarRule[] = [];
  let fetchedAt = 0;

  // fetchedAt 取**两行里较早**的那个，不是较晚的。
  //
  // 为什么：两个上游接口可能只成功一个（namespace 成功、radar 失败）。
  // 取较晚的会让"radar 其实已经 8 天没更新"被掩盖成新鲜数据。
  // 取较早的意味着只要有一半过期，就整体提示去刷新 —— 对用户是更诚实的信号。
  //
  // 早先还有第三个 meta 行专门记 fetchedAt，它参与 Math.max 之后会把
  // 上面这条判断彻底盖掉（meta 刚写过就是"现在"）。删掉 meta 行之后，
  // 时间信息只有一处来源，不会有第二个数字和它打架。
  if (routesRow) {
    try { routes = JSON.parse(routesRow.payload) as RouteTemplate[]; } catch { routes = []; }
    fetchedAt = Number(routesRow.fetched_at) || 0;
  }
  if (radarRow) {
    try { radar = JSON.parse(radarRow.payload) as RadarRule[]; } catch { radar = []; }
    const t = Number(radarRow.fetched_at) || 0;
    fetchedAt = fetchedAt === 0 ? t : Math.min(fetchedAt, t);
  }

  // 完全没缓存过 → 用种子，并把 fetchedAt 记 0（不假装是新鲜数据）
  if (routes.length === 0 && radar.length === 0) {
    const seeded: RouteLibrary = { routes: SEED_ROUTES, radar: SEED_RADAR, fetchedAt: 0 };
    return { ...seeded, stale: true };
  }

  const lib: RouteLibrary = { routes, radar, fetchedAt };
  memCache.set(userId, lib);
  return { ...lib, stale: fetchedAt === 0 || Date.now() - fetchedAt > CACHE_TTL_MS };
}

export interface SearchHit extends RouteTemplate {
  /** 命中的原因，UI 可以据此解释"为什么给你看这条" */
  matchedBy: 'radar' | 'name' | 'description' | 'category' | 'path';
  /** radar 反查时的原始域名 */
  viaDomain?: string;
}

/**
 * 搜索。
 *
 * 输入分流（PLAN §10.3）：
 *   · 像 URL → Radar 反查域名，命中规则的 path 直接给出候选
 *   · 否则   → 在 name/description/categories/path 里做子串匹配
 *
 * 为什么用子串而不是分词：路由名里大量中英混排（"用户视频"、"Bilibili 用户"），
 * 分词器对这类短字符串反而不如直接子串命中稳定。规模是上千条，
 * 一次全扫也就 1ms 级别。
 */
export function searchRoutes(
  lib: RouteLibrary,
  query: string,
): { items: SearchHit[]; type: 'url' | 'keyword' } {
  const q = (query ?? '').trim();
  if (!q) return { items: [], type: 'keyword' };

  if (looksLikeUrl(q)) {
    const dom = domainOf(q);
    if (!dom) return { items: [], type: 'url' };
    const hits: SearchHit[] = [];
    for (const rule of lib.radar) {
      // 域名匹配要么完全相等，要么规则是父域（bilibili.com 匹配 live.bilibili.com）
      if (dom !== rule.domain && !dom.endsWith(`.${rule.domain}`)) continue;
      // radar 只给 path，找到对应的完整路由元数据（有的话）
      const full = lib.routes.find((r) => r.path === rule.path)
        ?? lib.routes.find((r) => r.path.startsWith(rule.path.replace(/\/:[^/]+/g, '')));
      hits.push(full
        ? { ...full, matchedBy: 'radar', viaDomain: rule.domain }
        : {
            key: rule.path.replace(/^\/+/, ''),
            title: rule.title, namespace: rule.path.split('/')[1] ?? '',
            path: rule.path, example: null, categories: [],
            description: rule.title, namespaceDescription: '',
            params: paramsOf(rule.path), paramDocs: [],
            matchedBy: 'radar', viaDomain: rule.domain,
          });
    }
    return { items: hits, type: 'url' };
  }

  const lower = q.toLowerCase();
  const items: SearchHit[] = [];
  for (const r of lib.routes) {
    let matchedBy: SearchHit['matchedBy'] | null = null;
    if (r.title.toLowerCase().includes(lower)) matchedBy = 'name';
    else if (r.path.toLowerCase().includes(lower)) matchedBy = 'path';
    // namespace 名与它的中文说明都要参与匹配：用户搜的是「哔哩哔哩」或
    // 「bilibili」，而路由自己的 name 往往是「用户视频」这种短语。
    // 少了这两个分支，「哔哩哔哩」搜出来 0 条 —— 而这正是最常见的用法。
    else if (r.namespace.toLowerCase().includes(lower)) matchedBy = 'name';
    else if (r.namespaceDescription.toLowerCase().includes(lower)) matchedBy = 'description';
    else if (r.description.toLowerCase().includes(lower)) matchedBy = 'description';
    else if (r.categories.some((c) => c.toLowerCase().includes(lower))) matchedBy = 'category';
    if (matchedBy) items.push({ ...r, matchedBy });
  }
  return { items, type: 'keyword' };
}

// ── 试订阅 ────────────────────────────────────────────────

export interface PreviewResult {
  ok: boolean;
  /** 完整可订阅地址 */
  url: string;
  title: string | null;
  items: { title: string; link: string | null; publishedAt: number | null }[];
  error?: string;
}

/**
 * 拼出地址并抓一次，确认真的能解析出条目。
 *
 * 为什么必须先抓：用户从搜索结果点「订阅」，如果那条路由在上游已经失效，
 * 落库之后就是一个永远 broken 的死源。先抓一次的代价是一次请求，
 * 而不抓的代价是"订阅了但永远没有内容"。
 *
 * `path` 既可以带完整参数（`/bilibili/user/video/123`），也可以带占位符
 * 加 `params`（`/bilibili/user/video/:uid` + `{uid:'123'}`）。两种都接受：
 * 前者是预览时前端已经拼好的，后者是"填表单"路径。
 */
export async function previewRoute(
  settings: RsshubSettings,
  path: string,
  params: Record<string, string> = {},
  limit = 5,
): Promise<PreviewResult> {
  const raw = (path ?? '').trim();
  if (!raw) throw new RsshubError('BAD_PATH', '缺少路由路径');
  if (!raw.startsWith('/')) throw new RsshubError('BAD_PATH', '路由路径必须以 / 开头');

  const filled = fillRoute(raw, params);
  if (filled.missing.length > 0) {
    throw new RsshubError('BAD_PATH', `缺少参数: ${filled.missing.join(', ')}`);
  }

  const url = joinRsshub(settings.baseUrl, filled.url);
  // 自定义实例带的 accessKey 通过 `?key=` 传（RSSHub 官方约定），
  // 不能塞进 header —— 上游只认 query。
  const finalUrl = settings.accessKey
    ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(settings.accessKey)}`
    : url;

  let parsed: ParsedFeed | null = null;
  let err = '';
  try {
    const r = await fetchFeed(finalUrl);
    if (r.status === 304 || !r.body) throw new Error('上游返回空内容');
    parsed = parseFeed(r.body, finalUrl);
  } catch (e) {
    err = (e as Error).message;
  }

  if (!parsed || parsed.items.length === 0) {
    return {
      ok: false, url, title: parsed?.title ?? null, items: [],
      error: err || '这个地址没有解析出任何条目',
    };
  }

  return {
    ok: true,
    url,
    title: parsed.title,
    items: parsed.items.slice(0, limit).map((it) => ({
      title: it.title,
      link: it.url || null,
      publishedAt: it.publishedAt || null,
    })),
  };
}

/** 供 doctor / 设置页显示：缓存体积与拉取时间 */
export function cacheInfo(db: DatabaseSync, userId: string): {
  routes: number; radar: number; fetchedAt: number; stale: boolean; bytes: number;
} {
  const lib = loadLibrary(db, userId);
  const rows = db.prepare('SELECT key, length(payload) AS n FROM rsshub_cache').all() as
    { key: string; n: number }[];
  return {
    routes: lib.routes.length,
    radar: lib.radar.length,
    fetchedAt: lib.fetchedAt,
    stale: lib.stale,
    bytes: rows.reduce((s, r) => s + Number(r.n ?? 0), 0),
  };
}

/** 给验收脚本用：真有一个文件系统上的缓存目录时不返回 null（保留接口） */
export function cacheDirHint(): string | null {
  const home = homedir();
  const p = join(home, '.cache', 'ai-rss', 'rsshub');
  return existsSync(p) ? p : null;
}
