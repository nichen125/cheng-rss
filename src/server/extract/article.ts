import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { htmlToText } from '../feeds/parse.ts';
import { fetchPage } from '../feeds/fetch.ts';
import { sanitizeHtml } from '../feeds/sanitize.ts';

// 正文提取（PLAN §7.5）。
//
// 为什么需要这一层：feed 只给摘要的源非常多（导语型 feed、图床型 feed、
// 付费墙前 3 段）。不抓原文，用户会以为"这个源质量差"，实际是我们没去拿。
//
// 为什么不是每篇都抓：50 源 × 每天 500 条 = 每天 500 次额外请求，
// 而其中大多数 feed 本来就带全文（实测占多数）。抓了只是把网页抄一遍。
// 所以先量 feed 正文长度，短了才抓 —— 这条判断是本节的主要收益。

/** feed 正文去标签后短于这个长度，才值得去抓原文 */
export const MIN_FEED_CHARS = 500;

/**
 * 提取结果至少要比 feed 正文长这么多倍才算"提出了更多内容"。
 *
 * 不是 1.0：Readability 会剥掉导航、作者栏、相关阅读，因此它的字符数
 * 略少于页面容器是正常的；但若比 feed 正文还短，说明它抓错了节点
 * （典型：页面里有多个 <article>，它选中了评论那条）。
 * 那种情况保留 feed 原文，比塞一段错内容好。
 */
export const MIN_IMPROVEMENT = 1.2;

/** 提取失败原因。落进 entries.stage_error，供 doctor 与排查使用。 */
export type ExtractFailure =
  | 'feed-enough'      // feed 正文本来就够长，不需要抓
  | 'fetch-failed'     // 网络/HTTP 失败
  | 'not-html'         // content-type 不是 HTML（PDF、图片、JSON）
  | 'empty'            // 抓到了，但正文为空
  | 'readability'      // Readability 抛异常（页面结构异常，如无 <body>）
  | 'no-improvement';  // 抓到了也提了，但没有比 feed 正文更长

export interface ExtractOutcome {
  /** 最终应采用的正文字符数（用于比较与落库） */
  feedChars: number;
  /** Readability 提出的字符数；未提取为 0 */
  articleChars: number;
  /** 建议落库的 HTML；null 表示保持 feed 原文不变 */
  html: string | null;
  /** 是否成功替换 */
  replaced: boolean;
  /** 失败原因；成功时 null */
  failure: ExtractFailure | null;
  /** 人类可读的补充说明（HTTP 状态、异常消息、标题） */
  note: string;
}

/** feed 正文是否需要抓原文（PLAN §7.5 的触发条件） */
export function needsExtract(feedHtml: string | null | undefined): boolean {
  return htmlToText(feedHtml).length < MIN_FEED_CHARS;
}

/**
 * 从完整 HTML 里提正文。
 *
 * 两处防御都不是"理论上可能"：
 *   1. 没有 <body>：真实页面存在（danluu.com 就是把内容直接挂在 <html> 下），
 *      Readability 在 _grabArticle 里 `parentOfTopCandidate.tagName` 直接崩。
 *      这里把裸元素搬进一个 body，让它可以继续。
 *   2. Readability 仍可能抛别的：一律收成 'readability' 失败，不让它冒到
 *      job runner —— 正文提取失败不该让条目进入重试退避。
 */
export function extractArticle(html: string, url: string): {
  html: string | null;
  text: string;
  title: string | null;
  failure: ExtractFailure | null;
  note: string;
} {
  let document: ReturnType<typeof parseHTML>['document'];
  try {
    ({ document } = parseHTML(html));
    normalizeBody(document);
  } catch (e) {
    return { html: null, text: '', title: null, failure: 'readability', note: `解析失败: ${(e as Error).message}` };
  }

  let parsed: { content: string | null; textContent: string; title: string | null } | null = null;
  try {
    const r = new Readability(document as unknown as Document).parse();
    if (r) parsed = { content: r.content, textContent: r.textContent, title: r.title };
  } catch (e) {
    return {
      html: null, text: '', title: null, failure: 'readability',
      note: `Readability 抛异常: ${(e as Error).message}`,
    };
  }

  if (!parsed?.content || !parsed.textContent?.trim()) {
    return { html: null, text: '', title: null, failure: 'empty', note: '没有提取到正文' };
  }

  // 提取出的 HTML 里相对链接仍是相对的，用页面 URL 当 base 补全（§15.11）
  const clean = sanitizeHtml(parsed.content, { baseUrl: url });
  if (!clean.html) {
    return { html: null, text: '', title: parsed.title, failure: 'empty', note: '清洗后正文为空' };
  }

  return {
    html: clean.html,
    text: parsed.textContent,
    title: parsed.title,
    failure: null,
    note: '',
  };
}

/**
 * 一步到位：判断 → 抓取 → 提取 → 比较。
 *
 * 返回"建议落库的 HTML"。调用方（job handler）只负责写库，
 * 这样比较规则与写入规则各只有一处，验收脚本也能直接调它。
 */
export async function extractForEntry(opts: {
  url: string;
  feedHtml: string | null | undefined;
  /** 注入点：验收脚本用它替掉真实网络 */
  fetchPageImpl?: typeof fetchPage;
}): Promise<ExtractOutcome> {
  const feedChars = htmlToText(opts.feedHtml).length;
  const base: ExtractOutcome = {
    feedChars, articleChars: 0, html: null, replaced: false, failure: null, note: '',
  };

  if (!needsExtract(opts.feedHtml)) {
    return { ...base, failure: 'feed-enough', note: `feed 正文 ${feedChars} 字，已够长` };
  }

  const doFetch = opts.fetchPageImpl ?? fetchPage;
  let page;
  try {
    page = await doFetch(opts.url);
  } catch (e) {
    return { ...base, failure: 'fetch-failed', note: (e as Error).message };
  }

  const type = (page.contentType ?? '').toLowerCase();
  if (type && !type.includes('html') && !type.includes('xml')) {
    return { ...base, failure: 'not-html', note: `content-type: ${type}` };
  }

  const art = extractArticle(page.body, page.finalUrl || opts.url);
  if (!art.html) {
    return { ...base, articleChars: htmlToText(art.text).length, failure: art.failure, note: art.note };
  }

  const articleChars = htmlToText(art.text).length;
  if (articleChars < Math.max(MIN_FEED_CHARS, feedChars * MIN_IMPROVEMENT)) {
    return {
      ...base, articleChars, failure: 'no-improvement',
      note: `提出 ${articleChars} 字，未超过阈值 max(${MIN_FEED_CHARS}, ${feedChars}×${MIN_IMPROVEMENT})`,
    };
  }

  return {
    feedChars, articleChars, html: art.html, replaced: true, failure: null,
    note: art.title ?? '',
  };
}

/**
 * 修掉"内容没有 body 包裹"的页面。
 *
 * linkedom 遇到 `<html><meta><title>…<main>…</main>` 这种（HTML5 允许省略
 * body 标签，danluu.com 就是这么写的）会造出一个空 body，把元素留在
 * <html> 下。Readability 只沿 body 向上找，于是崩在 null 上。
 *
 * 只搬"内容元素"：head 与 body 自己必须排除 —— 把 body append 进它自己
 * 会直接抛 `unable to append a node to itself`（第一次实现就踩了）。
 */
function normalizeBody(document: Document): void {
  const body = document.body;
  if (!body) return;
  if (body.childNodes.length > 0) return;

  const html = document.documentElement;
  if (!html) return;

  const movable: ChildNode[] = [];
  for (let i = 0; i < html.childNodes.length; i++) {
    const n = html.childNodes[i] as ChildNode;
    if (n === (body as unknown as ChildNode)) continue;
    const name = (n as unknown as Element).nodeName;
    if (name === 'BODY' || name === 'HEAD') continue;
    // 纯空白文本对正文没意义，搬过去只会干扰 Readability 的文本密度计算
    if (n.nodeType === 3 && !(n.textContent ?? '').trim()) continue;
    movable.push(n);
  }
  if (!movable.some((n) => n.nodeType === 1)) return;

  for (const n of movable) body.appendChild(n);
}

/** 中文按 2 字符/词，英文按空格切；与写入侧 upsertItems 的口径一致 */
export function estimateWordCount(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  const cjk = (t.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const latin = t.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
    .split(/\s+/).filter(Boolean).length;
  return Math.round(cjk / 2) + latin;
}
