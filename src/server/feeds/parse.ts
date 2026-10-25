import { DOMParser } from 'linkedom';

// Feed 解析：RSS 2.0 / RSS 1.0 (RDF) / Atom。
//
// 为什么用 linkedom 而不是专门的 RSS 解析库：
//   1. linkedom 已在依赖里（正文提取要用它的 DOM），加一个 feed 库
//      等于为同一件事引入第二套 XML 解析器；
//   2. 主流 feed 库（rss-parser 等）对命名空间扩展（content:encoded、
//      dc:creator、media:*）的支持各有取舍，而「取不到 content:encoded
//      就退回 description」恰好是本项目最关键的降级链，自己写更可控。
//
// 不做的：RSS 0.91/0.92 的严格校验、XML Schema 验证、实体扩展攻击防护
// 之外的 DTD 处理。linkedom 不展开外部实体，天然免疫 XXE。

export type FeedFormat = 'rss2' | 'rdf' | 'atom';

export interface ParsedItem {
  guid: string;
  url: string;
  title: string;
  author: string | null;
  publishedAt: number;
  /** 内容 HTML：优先 content:encoded / atom content，退回 description */
  html: string | null;
  /** 纯文本摘要，用于列表展示与检索 */
  excerpt: string | null;
  /** 图片（enclosure 或 media:content 或正文首图） */
  imageUrl: string | null;
  categories: string[];
}

export interface ParsedFeed {
  format: FeedFormat;
  title: string | null;
  siteUrl: string | null;
  description: string | null;
  iconUrl: string | null;
  items: ParsedItem[];
}

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedParseError';
  }
}

const TXT = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/**
 * 属性值里的实体需要自己解。
 *
 * 实测 linkedom 在 XML 模式下：textContent 会解实体，但 getAttribute
 * 返回的是原文（`A &amp; B`）。Atom 的 href 里带 `&amp;` 很常见，
 * 不解就会拼出 `?a=1&amp;b=2` 这种失效 URL。
 */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // &amp; 必须最后处理，否则 "&amp;lt;" 会被先解成 "<"
    .replace(/&amp;/g, '&');
}

const ATTR = (el: Element | null | undefined, name: string): string =>
  decodeXmlEntities((el?.getAttribute(name) ?? '').trim());

/**
 * 按「前缀名 + 本地名」两种写法取子元素。
 *
 * 不能用 CSS 选择器：`content:encoded` 里的冒号会被 css-select 当成
 * 伪类，直接抛 "Unknown pseudo-class :encoded"。所以这里手动遍历子元素，
 * 按 tagName / localName / nodeName 三种写法匹配。
 */
function byName(root: Element | Document, names: string[]): Element | null {
  const kids = childElements(root);
  for (const n of names) {
    const hit = kids.find((c) => tagIs(c, n));
    if (hit) return hit;
  }
  return null;
}

function childElements(root: Element | Document): Element[] {
  const out: Element[] = [];
  const node = (root as Element).children;
  if (node) {
    const n = node.length;
    for (let i = 0; i < n; i++) out.push(node[i] as Element);
    return out;
  }
  // Document：取根元素
  const de = (root as Document).documentElement;
  if (de) out.push(de);
  return out;
}

/** 元素名是否匹配（忽略大小写；同时比 tagName / localName） */
function tagIs(el: Element, name: string): boolean {
  const want = name.toLowerCase();
  const a = (el.tagName ?? '').toLowerCase();
  const b = ((el as unknown as { localName?: string }).localName ?? '').toLowerCase();
  return a === want || b === want;
}

function allByName(root: Element | Document, names: string[]): Element[] {
  for (const n of names) {
    const list = (root as Document).getElementsByTagName(n);
    if (list.length > 0) {
      const out: Element[] = [];
      for (let i = 0; i < list.length; i++) out.push(list[i] as Element);
      return out;
    }
    // getElementsByTagName 按 tagName 精确匹配；再退一步用 localName 扫一遍
    const kids = childElements(root).flatMap((c) => [c, ...descendants(c)]);
    const hit = kids.filter((c) => tagIs(c, n));
    if (hit.length > 0) return hit;
  }
  return [];
}

function descendants(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (node: Element) => {
    const kids = node.children;
    const n = kids.length;
    for (let i = 0; i < n; i++) {
      const c = kids[i] as Element;
      out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

/**
 * 日期解析。
 *
 * feed 里的日期质量很差：RFC822、ISO、只有日期、甚至 "2026-10-23 10:00"
 * 混着来。Date.parse 能覆盖其中大部分；解析不出来时用 fallback（抓取时间），
 * **绝不能返回 NaN** —— 那会让条目排到时间线最底部或直接崩 SQL。
 */
export function parseDate(raw: string | null | undefined, fallback: number): number {
  const s = (raw ?? '').trim();
  if (!s) return fallback;
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    // 明显错误的未来时间（> 1 天）会让条目永远置顶，钳到今天
    const maxAhead = Date.now() + 86400_000;
    if (t > maxAhead) return fallback;
    // 1970 年附近的垃圾值
    if (t < 946684800000) return fallback;
    return t;
  }
  return fallback;
}

/** 去掉 HTML 标签，得到一行纯文本。用于 excerpt。 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从 HTML 里取第一张可用图片 */
function firstImage(html: string | null): string | null {
  if (!html) return null;
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return m?.[1] ? resolveUrl(m[1], null) : null;
}

/** 相对 URL 补全；本身是绝对 URL 或 data: 则原样返回 */
function resolveUrl(href: string, base: string | null): string {
  const h = href.trim();
  if (!h) return '';
  if (/^(https?:|data:)/i.test(h)) return h;
  if (!base) return h;
  try {
    return new URL(h, base).toString();
  } catch {
    return h;
  }
}

/**
 * 解析 feed 文本。
 *
 * @param xml   feed 原文
 * @param base  该 feed 的 URL，用于补全相对链接
 */
export function parseFeed(xml: string, base: string): ParsedFeed {
  const src = xml.trim();
  if (!src) throw new FeedParseError('feed 内容为空');

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(src, 'text/xml') as unknown as Document;
  } catch (e) {
    throw new FeedParseError(`XML 解析失败: ${(e as Error).message}`);
  }

  const root = doc.documentElement;
  if (!root) throw new FeedParseError('XML 没有根节点');

  // linkedom 保留命名空间前缀，RDF 的根节点是 <rdf:RDF> 而不是 <RDF>。
  // 因此比较前必须去掉前缀，否则 RSS 1.0 会被当成"不认识的格式"。
  const rootName = (root.localName ?? root.tagName ?? '').toLowerCase().replace(/^[a-z0-9]+:/, '');

  if (rootName === 'feed') return parseAtom(doc, root, base);
  if (rootName === 'rdf') return parseRdf(doc, root, base);
  if (rootName === 'rss') return parseRss2(doc, root, base);

  // 常见误判：用户把网页地址当 feed 提交。给出可读原因而不是"格式未知"。
  const htmlish = /<html|<body|<!doctype html/i.test(src);
  throw new FeedParseError(
    htmlish
      ? '这个地址返回的是 HTML 网页，不是 feed。请检查是不是漏了具体订阅路径'
      : `不认识的 feed 格式（根节点 <${rootName}>）`,
  );
}

// ── RSS 2.0 ────────────────────────────────────────────────

function parseRss2(doc: Document, root: Element, base: string): ParsedFeed {
  const ch = byName(root, ['channel']);
  if (!ch) throw new FeedParseError('RSS 缺少 <channel>');

  const siteUrl = resolveUrl(TXT(byName(ch, ['link'])), base) || null;

  const items = allByName(ch, ['item']).map((it) => rssItem(it, base, siteUrl));

  return {
    format: 'rss2',
    title: TXT(byName(ch, ['title'])) || null,
    siteUrl,
    description: htmlToText(TXT(byName(ch, ['description']))) || null,
    iconUrl: feedIcon(ch, siteUrl),
    items,
  };
}

function rssItem(it: Element, base: string, siteUrl: string | null): ParsedItem {
  const link = resolveUrl(
    TXT(byName(it, ['link'])) || ATTR(byName(it, ['link']), 'href'),
    base,
  );

  // content:encoded 优先 —— 它是全文，description 往往只有摘要
  const encoded = byName(it, ['content:encoded', 'encoded']);
  const desc = byName(it, ['description']);
  const html = (encoded?.textContent?.trim() || desc?.textContent?.trim() || null);

  const guidEl = byName(it, ['guid']);
  const guidText = TXT(guidEl);
  // guid 可能是 URL 也可能是不透明字符串；为空的退到 link
  const guid = guidText || link;

  const author =
    TXT(byName(it, ['dc:creator', 'creator', 'author'])) || null;

  const enclosure = byName(it, ['enclosure']);
  const media = byName(it, ['media:content', 'media:thumbnail', 'content', 'thumbnail']);

  const imageUrl =
    ATTR(enclosure, 'url')
    || ATTR(media, 'url')
    || firstImage(html);

  const published = parseDate(
    TXT(byName(it, ['pubDate', 'dc:date', 'date'])),
    Date.now(),
  );

  const text = htmlToText(html);

  return {
    guid,
    url: link || guid,
    title: TXT(byName(it, ['title'])) || '(无标题)',
    author,
    publishedAt: published,
    html,
    excerpt: text ? text.slice(0, 300) : null,
    imageUrl: imageUrl || null,
    categories: allByName(it, ['category']).map((c) => TXT(c)).filter(Boolean),
  };
}

// ── Atom ───────────────────────────────────────────────────

function parseAtom(doc: Document, root: Element, base: string): ParsedFeed {
  const siteUrl = atomLink(root, 'alternate') || null;

  const entries = allByName(root, ['entry']).map((en) => atomEntry(en, base));

  return {
    format: 'atom',
    title: TXT(byName(root, ['title'])) || null,
    siteUrl,
    description: htmlToText(TXT(byName(root, ['subtitle', 'tagline']))) || null,
    iconUrl: resolveUrl(TXT(byName(root, ['icon', 'logo'])), base) || null,
    items: entries,
  };
}

/** Atom 的 link 是属性化的：<link rel="alternate" href="..."/> */
function atomLink(el: Element, rel: string): string {
  const links = allByName(el, ['link']);
  // 优先精确匹配 rel；没有 rel 的按 Atom 规范等于 alternate
  const exact = links.find((l) => (ATTR(l, 'rel') || 'alternate') === rel);
  return exact ? ATTR(exact, 'href') : '';
}

function atomEntry(en: Element, base: string): ParsedItem {
  const link = resolveUrl(atomLink(en, 'alternate') || TXT(byName(en, ['id'])), base);

  // Atom content 可能带 type="html" 或 type="xhtml"（后者是嵌套 DOM）
  const contentEl = byName(en, ['content']);
  const summaryEl = byName(en, ['summary']);
  const html = contentEl?.textContent?.trim() || summaryEl?.textContent?.trim() || null;

  const guid = TXT(byName(en, ['id'])) || link;

  const authorEl = byName(en, ['author']);
  const author = authorEl
    ? (TXT(byName(authorEl, ['name'])) || TXT(authorEl) || null)
    : null;

  const published = parseDate(
    TXT(byName(en, ['published', 'updated', 'issued', 'modified'])),
    Date.now(),
  );

  const text = htmlToText(html);

  return {
    guid,
    url: link,
    title: TXT(byName(en, ['title'])) || '(无标题)',
    author,
    publishedAt: published,
    html,
    excerpt: text ? text.slice(0, 300) : null,
    imageUrl: firstImage(html),
    categories: allByName(en, ['category']).map((c) => ATTR(c, 'term') || TXT(c)).filter(Boolean),
  };
}

// ── RSS 1.0 / RDF ──────────────────────────────────────────

function parseRdf(doc: Document, root: Element, base: string): ParsedFeed {
  const ch = byName(root, ['channel']);
  const siteUrl = ch ? resolveUrl(TXT(byName(ch, ['link'])), base) || null : null;

  const items = allByName(doc, ['item']).map((it) => {
    const link = resolveUrl(TXT(byName(it, ['link'])), base);
    const encoded = byName(it, ['content:encoded', 'encoded']);
    const desc = byName(it, ['description']);
    const html = encoded?.textContent?.trim() || desc?.textContent?.trim() || null;
    const guid = TXT(byName(it, ['rdf:about', 'about'])) || link;
    const text = htmlToText(html);
    return {
      guid,
      url: link || guid,
      title: TXT(byName(it, ['title'])) || '(无标题)',
      author: TXT(byName(it, ['dc:creator', 'creator'])) || null,
      publishedAt: parseDate(TXT(byName(it, ['dc:date', 'date', 'pubDate'])), Date.now()),
      html,
      excerpt: text ? text.slice(0, 300) : null,
      imageUrl: firstImage(html),
      categories: allByName(it, ['dc:subject', 'subject', 'category']).map((c) => TXT(c)).filter(Boolean),
    };
  });

  return {
    format: 'rdf',
    title: ch ? (TXT(byName(ch, ['title'])) || null) : null,
    siteUrl,
    description: ch ? (htmlToText(TXT(byName(ch, ['description']))) || null) : null,
    iconUrl: ch ? feedIcon(ch, siteUrl) : null,
    items,
  };
}

// ── 站点图标 ───────────────────────────────────────────────

/**
 * feed 里很少直接给 icon。退化顺序：
 *   channel > image > url   →  站点 favicon.ico
 * 用 Google 的图标服务会把请求发给第三方（隐私问题），
 * 所以只拼站点自己的 /favicon.ico —— 有没有由浏览器决定。
 */
function feedIcon(ch: Element, siteUrl: string | null): string | null {
  const img = byName(ch, ['image']);
  const icon = img ? TXT(byName(img, ['url'])) : '';
  if (icon) return icon;
  if (!siteUrl) return null;
  try {
    const u = new URL(siteUrl);
    return `${u.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/** 供验收脚本使用：解析但不抛错 */
export function tryParseFeed(xml: string, base: string): { ok: true; feed: ParsedFeed } | { ok: false; error: string } {
  try {
    return { ok: true, feed: parseFeed(xml, base) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
