import { DOMParser } from 'linkedom';

// OPML 导入导出（PLAN §18 `POST /feeds/import`、`GET /feeds/export`）。
//
// OPML 是 RSS 阅读器之间唯一通用的搬家格式，所以它必须能：
//   · 保留文件夹层级（<outline> 嵌套）
//   · 容忍别的阅读器导出的怪格式（attribute 大小写、缺 xmlUrl、多余属性）
//   · 导出后被主流阅读器（Feedly / Inoreader / NetNewsWire）读进去
//
// 不做：OPML 2.0 的全部规范（head/dateModified 等仅作参考信息）。

export interface OpmlFeed {
  url: string;
  title: string | null;
  siteUrl: string | null;
  /** 所属文件夹名（取最内层 <outline> 的 text/title） */
  folder: string | null;
}

export interface OpmlImportResult {
  feeds: OpmlFeed[];
  /** 被跳过的条目及原因 */
  skipped: { title: string; reason: string }[];
}

/**
 * 解析 OPML。
 *
 * 关键容错：有些阅读器把 xmlUrl 写成 XMLURL / XmlUrl。
 * XML 属性名在规范上区分大小写，但实际导出里三种都见过，
 * 所以匹配时统一转小写。
 */
export function parseOpml(xml: string): OpmlImportResult {
  const out: OpmlImportResult = { feeds: [], skipped: [] };
  if (!xml.trim()) return out;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  } catch {
    return out;
  }

  const root = doc.documentElement;
  if (!root) return out;

  const rootName = (root.localName ?? root.tagName ?? '').toLowerCase().replace(/^[a-z0-9]+:/, '');
  if (rootName !== 'opml') {
    // 不是 OPML 就整体拒绝 —— 静默返回空列表会让用户以为"导入成功但源没了"
    throw new Error(`不是 OPML 文件（根节点 <${rootName}>）`);
  }

  const body = findFirst(root, 'body') ?? root;
  const seen = new Set<string>();

  const walk = (el: Element, folder: string | null) => {
    const kids = childEls(el);
    for (const outline of kids) {
      if (!tagIs(outline, 'outline')) continue;

      const xmlUrl = attrCI(outline, 'xmlurl');
      const text = attrCI(outline, 'text') || attrCI(outline, 'title') || null;

      if (xmlUrl) {
        const url = xmlUrl.trim();
        if (!/^https?:\/\//i.test(url)) {
          out.skipped.push({ title: text ?? url, reason: '订阅地址不是 http(s)' });
          continue;
        }
        if (seen.has(url)) {
          out.skipped.push({ title: text ?? url, reason: '文件内重复' });
          continue;
        }
        seen.add(url);
        out.feeds.push({
          url,
          title: text,
          siteUrl: attrCI(outline, 'htmlurl') || null,
          folder,
        });
        // 有 xmlUrl 的 outline 通常不再嵌套，但有些工具会把条目塞在里面
        continue;
      }

      // 没有 xmlUrl → 当成文件夹，递归；用它的 text 作为下一级 folder
      const nextFolder = text ?? folder;
      walk(outline, nextFolder);
    }
  };

  walk(body, null);
  return out;
}

const childEls = (el: Element | Document): Element[] => {
  const out: Element[] = [];
  const kids = el.children;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) out.push(kids[i] as Element);
  return out;
};

const tagIs = (el: Element, name: string): boolean => {
  const want = name.toLowerCase();
  const a = (el.tagName ?? '').toLowerCase();
  const b = ((el as unknown as { localName?: string }).localName ?? '').toLowerCase();
  return a === want || b === want;
};

function findFirst(root: Element, name: string): Element | null {
  const stack = [root, ...childEls(root)];
  for (const el of stack) if (tagIs(el, name)) return el;
  // 深一层
  for (const el of childEls(root)) {
    if (tagIs(el, name)) return el;
  }
  return null;
}

function attrCI(el: Element, name: string): string {
  const direct = el.getAttribute(name);
  if (direct) return decodeEntities(direct);
  // 属性名大小写不敏感匹配
  const attrs = el.attributes;
  if (!attrs) return '';
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i] as Attr;
    if ((a.name ?? '').toLowerCase() === name.toLowerCase()) return decodeEntities(a.value ?? '');
  }
  return '';
}

/**
 * 属性值里的实体要自己解。
 *
 * 实测 linkedom 在 XML 模式下 getAttribute 返回原文（`A &amp; B`），
 * 而 textContent 已解码。不解的话 OPML 往返会把 `&` 变成 `&amp;` 再攒一层。
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// ── 导出 ───────────────────────────────────────────────────

export interface OpmlExportFeed {
  url: string;
  title: string | null;
  siteUrl: string | null;
  folder: string | null;
}

export function buildOpml(feeds: OpmlExportFeed[], title = 'AI RSS 订阅'): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  // 按文件夹分组；无文件夹的平铺在 body 顶层
  const groups = new Map<string, OpmlExportFeed[]>();
  const loose: OpmlExportFeed[] = [];
  for (const f of feeds) {
    if (f.folder) {
      const arr = groups.get(f.folder) ?? [];
      arr.push(f);
      groups.set(f.folder, arr);
    } else {
      loose.push(f);
    }
  }

  const feedLine = (f: OpmlExportFeed, indent: string): string => {
    const attrs = [
      `type="rss"`,
      `text="${esc(f.title ?? f.url)}"`,
      `title="${esc(f.title ?? f.url)}"`,
      `xmlUrl="${esc(f.url)}"`,
    ];
    if (f.siteUrl) attrs.push(`htmlUrl="${esc(f.siteUrl)}"`);
    return `${indent}<outline ${attrs.join(' ')} />`;
  };

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${esc(title)}</title>`,
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
  ];

  for (const f of loose) lines.push(feedLine(f, '    '));

  for (const [folder, arr] of groups) {
    lines.push(`    <outline text="${esc(folder)}" title="${esc(folder)}">`);
    for (const f of arr) lines.push(feedLine(f, '      '));
    lines.push('    </outline>');
  }

  lines.push('  </body>', '</opml>', '');
  return lines.join('\n');
}

/** 供测试：把 HTML 页面当 OPML 解析应当报错而不是返回空 */
export function looksLikeHtml(text: string): boolean {
  return /<html|<body|<!doctype html/i.test(text.slice(0, 2000));
}
