import { parseFeed, htmlToText, type ParsedFeed } from './parse.ts';

// Feed 拉取与订阅地址发现。
//
// 三件事必须一起做，否则会给用户"订阅了但没内容"的困惑：
//   1. 用户贴的往往是网站首页或文章页，不是 feed 地址 → 自动发现
//   2. 条件请求（ETag / Last-Modified）→ 304 时不重复入库，省流量
//   3. 抓取失败要区分"暂时失败"与"永久失效"，前者退避、后者置 broken

/** 抓取上限：单次 8MB。真实 feed 极少超过 1MB，超过基本是错误页面 */
const MAX_BYTES = 8 * 1024 * 1024;

/** 单次请求超时。NAS 上网络慢，30s 比常见的 10s 更合适 */
const TIMEOUT_MS = 30_000;

/**
 * 很多站点按 UA 返不同内容，甚至直接 403 无 UA 请求。
 * 带上产品名与版本，便于对方站长在日志里认出流量来源。
 */
const UA = 'ai-rss/0.1 (+https://github.com/ai-rss; self-hosted RSS reader)';

export interface FetchResult {
  status: number;
  notModified: boolean;
  body: string | null;
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
  contentType: string | null;
}

export class FetchError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(message: string, opts: { retryable?: boolean; status?: number | null } = {}) {
    super(message);
    this.name = 'FetchError';
    this.retryable = opts.retryable ?? true;
    this.status = opts.status ?? null;
  }
}

/**
 * 带条件请求的拉取。
 *
 * 不跟随无限重定向：fetch 默认跟随并最多 20 次，但我们要知道最终 URL
 * （feed 里的相对链接要按最终 URL 补全），所以显式读 response.url。
 */
export async function fetchFeed(
  url: string,
  cond: { etag?: string | null; lastModified?: string | null } = {},
): Promise<FetchResult> {
  const headers: Record<string, string> = {
    'user-agent': UA,
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
  };
  if (cond.etag) headers['if-none-match'] = cond.etag;
  if (cond.lastModified) headers['if-modified-since'] = cond.lastModified;

  let res: Response;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
  } catch (e) {
    const msg = (e as Error).name === 'AbortError'
      ? `请求超时（${TIMEOUT_MS / 1000}s）`
      : `网络错误: ${(e as Error).message}`;
    throw new FetchError(msg, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304) {
    return {
      status: 304,
      notModified: true,
      body: null,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      finalUrl: res.url || url,
      contentType: res.headers.get('content-type'),
    };
  }

  if (!res.ok) {
    // 4xx 里 404/410 是永久失效；408/429 是暂时
    const permanent = res.status === 404 || res.status === 410;
    throw new FetchError(
      `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
      { retryable: !permanent, status: res.status },
    );
  }

  const buf = await readCapped(res);
  const text = decodeBody(buf, res.headers.get('content-type'));

  return {
    status: res.status,
    notModified: false,
    body: text,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    finalUrl: res.url || url,
    contentType: res.headers.get('content-type'),
  };
}

/** 流式读取并限制上限，避免一个异常大的响应把内存撑爆 */
async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new FetchError(`响应超过 ${MAX_BYTES / 1024 / 1024}MB 上限`, { retryable: false });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/**
 * 编码判定。
 *
 * 中文 feed 里 GBK 仍不少见（老站点、部分香港/台湾媒体）。从
 * content-type 里读 charset；没有就试 UTF-8，出现替换字符再退 GB18030。
 */
function decodeBody(buf: Uint8Array, contentType: string | null): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType ?? '');
  const declared = m?.[1]?.toLowerCase();

  if (declared && declared !== 'utf-8' && declared !== 'utf8') {
    try {
      return new TextDecoder(declared).decode(buf);
    } catch { /* 不认识的编码，走下面的探测 */ }
  }

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('\uFFFD')) return utf8;

  // UTF-8 解出替换字符 → 大概率是 GBK 系
  try {
    const gb = new TextDecoder('gb18030').decode(buf);
    if (!gb.includes('\uFFFD')) return gb;
  } catch { /* 运行时不含该编码表 */ }

  return utf8;
}

// ── 订阅地址发现 ───────────────────────────────────────────

export interface DiscoveryResult {
  /** 直接可用的 feed 地址（已按可靠性排序） */
  candidates: string[];
  /** 探测过程说明，给 UI 展示"为什么没找到" */
  notes: string[];
}

/**
 * 从用户给的地址找出真正的 feed。
 *
 * 顺序（每一步都实测有效才保留）：
 *   1. 该地址本身能解析成 feed                          → 就是它
 *   2. HTML 里的 <link rel="alternate" type="application/rss+xml|atom+xml">
 *   3. 常见路径探测（/feed, /rss, /atom.xml, /rss.xml, /index.xml …）
 *
 * 不做的一件事：猜测 RSSHub 路由。那属于 §10 的专门能力，
 * 塞进这里会让"找不到 feed"变成"猜出一堆乱七八糟的地址"。
 */
export async function discoverFeed(inputUrl: string): Promise<DiscoveryResult> {
  const notes: string[] = [];
  const candidates: string[] = [];
  const seen = new Set<string>();

  const add = (u: string | null | undefined) => {
    if (!u) return;
    const abs = absolutize(u, inputUrl);
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    candidates.push(abs);
  };

  // ── 1. 直接当 feed 试 ──
  let html: string | null = null;
  try {
    const r = await fetchFeed(inputUrl);
    if (r.body) {
      const probe = tryParse(r.body, r.finalUrl);
      if (probe) {
        add(r.finalUrl);
        notes.push('该地址本身就是可用的 feed');
        return { candidates, notes };
      }
      // 不是 feed，留着当 HTML 继续挖 <link>
      html = r.body;
      notes.push('该地址返回的不是 feed，尝试从页面里找订阅链接');
    }
  } catch (e) {
    notes.push(`直接访问失败：${(e as Error).message}`);
  }

  // ── 2. HTML 的 <link rel=alternate> ──
  if (html) {
    const found = extractLinkTags(html, inputUrl);
    for (const f of found) {
      if (await worksAsFeed(f)) { add(f); }
    }
    if (found.length > 0 && candidates.length === 0) {
      notes.push(`页面里声明了 ${found.length} 个订阅地址，但都拉不到有效 feed`);
    }
    if (found.length === 0) notes.push('页面里没有 <link rel="alternate"> 声明');
  }

  if (candidates.length > 0) return { candidates, notes };

  // ── 3. 常见路径探测 ──
  const guesses = commonPaths(inputUrl);
  for (const g of guesses) {
    if (await worksAsFeed(g)) add(g);
  }
  if (candidates.length === 0) {
    notes.push(`试过 ${guesses.length} 个常见路径（/feed、/rss、/atom.xml 等）都没成功`);
  }

  return { candidates, notes };
}

/**
 * 只做「便宜」的有效性判断：能不能解析出至少 1 条条目。
 *
 * 为什么要求 >=1 条而不是「格式对就行」：很多站点对不存在路径返回
 * 自定义 200 页面或空 feed，格式判定会误报，条目数不会。
 */
async function worksAsFeed(url: string): Promise<boolean> {
  try {
    const r = await fetchFeed(url);
    if (!r.body) return false;
    const f = tryParse(r.body, r.finalUrl);
    return Boolean(f && f.items.length > 0);
  } catch {
    return false;
  }
}

function tryParse(text: string, base: string): ParsedFeed | null {
  try {
    const f = parseFeed(text, base);
    return f.items.length > 0 ? f : null;
  } catch {
    return null;
  }
}

function extractLinkTags(html: string, base: string): string[] {
  const out: string[] = [];
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    if (rel !== 'alternate') continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    if (!/application\/(rss|atom)\+xml/.test(type)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) out.push(absolutize(href, base) ?? href);
  }
  return out;
}

const COMMON_PATHS = [
  '/feed', '/feed/', '/rss', '/rss/', '/rss.xml', '/feed.xml', '/atom.xml',
  '/index.xml', '/feeds/posts/default', '/feed/rss', '/?feed=rss2',
  '/blog/feed', '/news/feed', '/rss/feed',
];

function commonPaths(base: string): string[] {
  try {
    const u = new URL(base);
    return COMMON_PATHS.map((p) => `${u.origin}${p}`);
  } catch {
    return [];
  }
}

function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    return null;
  }
}

// ── 合并到条目 ─────────────────────────────────────────────

export interface UpsertStats {
  inserted: number;
  /** guid/url 已存在而跳过 */
  skipped: number;
  /** 没有可用 URL，无法入库 */
  invalid: number;
}

/**
 * URL 规范化，用于判重。
 *
 * 去掉的：utm_* / fbclid / gclid 等追踪参数、fragment、
 *        末尾多余的斜杠、http/https 差异（不统一，因为有些站两者内容不同）
 * 保留的：其余 query（很多站点用 ?p=123 区分文章）
 */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.trim();
  }
  u.hash = '';
  const junk = [
    /^utm_/, /^fbclid$/, /^gclid$/, /^mc_cid$/, /^mc_eid$/, /^ref$/, /^ref_src$/,
    /^spm$/, /^from$/, /^share_/, /^_hs/, /^igshid$/, /^yclid$/,
  ];
  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    if (junk.some((re) => re.test(k))) continue;
    keep.push([k, v]);
  }
  // 保持顺序重建，避免 searchParams.sort() 改变语义
  const qs = new URLSearchParams();
  for (const [k, v] of keep) qs.append(k, v);
  u.search = qs.toString();

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
  return u.toString();
}

/** 内容指纹：标题 + 正文前 2KB 的 sha1，用于跨源同文判重 */
export function contentHash(title: string, html: string | null): string {
  const norm = `${title}\u0000${htmlToText(html).slice(0, 2048)}`
    .toLowerCase()
    .replace(/\s+/g, ' ');
  // 用 Node 内建，不引 crypto-js
  return require$sha1(norm);
}

// 单独抽出来便于测试替换；node:crypto 在 CJS bundle 里可用
import { createHash } from 'node:crypto';
function require$sha1(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}
