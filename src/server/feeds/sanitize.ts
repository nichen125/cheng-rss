import { parseHTML } from 'linkedom';

// HTML 清洗（白名单）。
//
// 为什么必须有：正文 HTML 最终会进 `dangerouslySetInnerHTML`。
// feed 是外部输入 —— 里面可以有 <script>、onerror=、javascript: 伪协议。
// 不清洗就是一个存储型 XSS，而且是在自己家里。
//
// 为什么用白名单而不是黑名单：黑名单永远漏。这里只保留排版必需的标签与
// 属性，其余一律脱掉标签保留文字。
//
// 与 M4 高亮的关系：清洗后的 HTML 才是高亮定位的基准，所以清洗规则
// 一旦变化，旧高亮的字符偏移就失效（PLAN §11.2 的降级链就是为此设计的）。

/** 允许保留的标签（小写） */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'div', 'span', 'section', 'article',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup', 'small',
  'a', 'img', 'figure', 'figcaption', 'picture', 'source',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'video', 'audio',
]);

/** 允许保留的属性（按标签） */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'rel', 'target']),
  img: new Set(['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading']),
  source: new Set(['src', 'srcset', 'type', 'media']),
  video: new Set(['src', 'poster', 'controls', 'width', 'height']),
  audio: new Set(['src', 'controls']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span']),
  ol: new Set(['start', 'type']),
};

/** 连同内容一起丢掉的标签 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'noscript', 'iframe', 'object', 'embed', 'form',
  'input', 'button', 'select', 'textarea', 'svg', 'canvas', 'template',
  'link', 'meta', 'base',
]);

export interface SanitizeOptions {
  /** 正文 HTML 的来源页面 URL，用于补全相对路径 */
  baseUrl?: string | null;
  /** 图片代理前缀（M6 可用来绕过防盗链）。默认不改写 */
  imageProxy?: string | null;
}

export interface SanitizeResult {
  html: string;
  /** 清洗掉的危险项计数，用于 doctor 与日志观察攻击面 */
  removed: { tags: number; attrs: number; urls: number };
}

/**
 * 清洗正文 HTML。
 *
 * 用 DOM 遍历而不是正则替换 —— 正则处理嵌套标签必然出错，
 * 而「某个嵌套让 </script> 逃逸」就是真实的 XSS 路径。
 */
export function sanitizeHtml(input: string | null | undefined, opts: SanitizeOptions = {}): SanitizeResult {
  const removed = { tags: 0, attrs: 0, urls: 0 };
  if (!input || !input.trim()) return { html: '', removed };

  // linkedom 的 parseHTML 需要包裹成完整文档；片段也能处理
  const { document } = parseHTML(`<html><body>${input}</body></html>`);
  const body = document.querySelector('body');
  if (!body) return { html: '', removed };

  const base = opts.baseUrl ?? null;

  const walk = (node: Element): void => {
    // 先收集子节点再遍历，遍历中改 DOM 会跳过节点
    const kids = [...childNodes(node)];
    for (const child of kids) {
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = (el.localName ?? el.tagName ?? '').toLowerCase();

      if (DROP_WITH_CONTENT.has(tag)) {
        removed.tags++;
        el.remove();
        continue;
      }

      if (!ALLOWED_TAGS.has(tag)) {
        // 不认识的标签：脱掉标签保留文字（比整段丢弃更安全 —— 丢内容会失真）
        removed.tags++;
        unwrap(el);
        continue;
      }

      // 属性过滤
      const allowed = ALLOWED_ATTRS[tag];
      const attrs: Attr[] = [];
      if (el.attributes) {
        const an = el.attributes.length;
        for (let i = 0; i < an; i++) attrs.push(el.attributes[i] as Attr);
      }
      for (const a of attrs) {
        const name = (a.name ?? '').toLowerCase();
        if (!allowed || !allowed.has(name)) {
          el.removeAttribute(a.name);
          removed.attrs++;
          continue;
        }
        // URL 类属性校验协议
        if (name === 'href' || name === 'src' || name === 'poster') {
          const v = a.value ?? '';
          if (!isSafeUrl(v)) {
            el.removeAttribute(a.name);
            removed.urls++;
          }
        }
      }

      // 正文链接一律新标签打开（PLAN §15.11）。
      //
      // 为什么必须在清洗层做，而不是靠 feed 自带：实测 3176 个正文链接里
      // 只有 980 个（31%）自带 target，其余 2196 个点击后会在主框架导航 ——
      // 单页应用的状态（当前筛选/已加载的列表/滚动位置）全部丢失，
      // 用户得按浏览器后退才回得来。点一次就丢上下文，等于"链接不可点"。
      //
      // 两种例外：
      //   - 页内锚点：同一文档内定位，新开标签等于把用户丢进一个只有
      //     片段的新页（那个页面上没这个锚点，会直接跳顶部）。
      //   - mailto:/tel:：交给系统处理，浏览器本来就不导航。
      const rawHref = tag === 'a' ? (el.getAttribute('href') ?? '').trim() : '';
      const sameDocAnchor = isSameDocAnchor(rawHref, base);

      // 链接与图片补全相对路径
      if (tag === 'a' && base) {
        if (rawHref) el.setAttribute('href', absolutize(rawHref, base));
        // 站外链接加 rel，防 tabnabbing
        el.setAttribute('rel', 'noopener noreferrer');
      }
      if (tag === 'a' && rawHref) {
        const lower = rawHref.toLowerCase();
        const isSystem = lower.startsWith('mailto:') || lower.startsWith('tel:');
        if (sameDocAnchor || isSystem) {
          // 幂等：上一轮已经给它加过 target 的话要撤掉。
          // 不清的话"读时再洗一次"会把第一次的判断结果固化下来 ——
          // 首次 `#sec` 正确跳过，第二次它已经是绝对 URL，就会被误加。
          el.removeAttribute('target');
        } else {
          el.setAttribute('target', '_blank');
          // rel 已在上面的 base 分支设过；无 base 时（插件导入路径）也要有
          if (!el.getAttribute('rel')) el.setAttribute('rel', 'noopener noreferrer');
        }
      }
      if ((tag === 'img' || tag === 'source') && base) {
        const src = el.getAttribute(tag === 'img' ? 'src' : 'src');
        if (src) el.setAttribute('src', proxy(absolutize(src, base), opts.imageProxy));
      }
      if (tag === 'img' && !el.getAttribute('loading')) {
        el.setAttribute('loading', 'lazy');
      }

      walk(el);
    }
  };

  walk(body);

  return { html: body.innerHTML, removed };
}

/** 允许的 URL 协议：http(s)、mailto、锚点、协议相对。data: 只放行图片。 */
function isSafeUrl(raw: string): boolean {
  const v = raw.trim();
  if (!v) return false;
  if (v.startsWith('#')) return true;
  if (v.startsWith('//')) return true;
  // eslint-disable-next-line no-control-regex
  const compact = v.replace(/[\u0000-\u0020]/g, '').toLowerCase();
  if (compact.startsWith('data:')) return /^data:image\//.test(compact);
  if (/^(https?:|mailto:|tel:)/.test(compact)) return true;
  // 相对路径
  if (/^[./]/.test(compact)) return true;
  // 其他都当危险（javascript:、vbscript:、file:、blob: ……）
  return false;
}

function absolutize(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/**
 * 判断这个 href 是不是"指向同一篇文档内部的锚点"。
 *
 * 三条都要认，否则会把锚点误判成外链、给它加 target：
 *   1. `#sec`        —— 原始写法
 *   2. `post.html#x` —— 同路径（相对）
 *   3. `https://site/post#x` —— 已经是绝对 URL（**第二次清洗时必然长这样**）
 *
 * 第 3 条是最容易漏的：`/entries/:id` 每次请求都会把库里存的 HTML 再洗一次
 * （entries.ts 的注释写了原因：历史数据可能来自早期版本）。第一次洗把
 * `#sec` 补全成 `https://site/post#sec` 存回库里之后，第二次洗看到的就
 * 不再是 `#` 开头 —— 只判 startsWith('#') 的实现会在这里翻车。
 *
 * 整个函数不用 `new URL` 解析 base：linkedom 的 href 可能带不可见字符，
 * 解析失败时静默退回"不是锚点"更安全（宁可新开标签，也不要错误地把外链
 * 当成锚点、让它把阅读器整个跳走）。
 */
function isSameDocAnchor(rawHref: string, base: string | null): boolean {
  if (!rawHref) return false;
  if (rawHref.startsWith('#')) return true;

  const hashAt = rawHref.indexOf('#');
  // 没有 # 就一定不是锚点；`#` 出现在最前面已由上面处理
  if (hashAt <= 0) return false;

  const docPart = rawHref.slice(0, hashAt);
  // 纯查询串（`?a=1#x`）在清洗后会被补成绝对 URL，走下面的比较
  if (!/^[a-z][a-z0-9+.-]*:/i.test(docPart) && !docPart.startsWith('/')) {
    // 相对路径 + 锚点：只要 base 存在，补全后仍是同一文档
    return Boolean(base);
  }
  if (!base) {
    // 无 base 时无法判断，绝对 URL 只能按"不是锚点"处理
    return false;
  }
  try {
    const u = new URL(rawHref, base);
    const b = new URL(base);
    // 只去掉 hash 后比较：路径 + 查询串完全一致才算同一篇文档
    return u.origin === b.origin && u.pathname === b.pathname && u.search === b.search;
  } catch {
    return false;
  }
}

function proxy(url: string, prefix: string | null | undefined): string {
  if (!prefix || !/^https?:\/\//i.test(url)) return url;
  return `${prefix.replace(/\/$/, '')}/${encodeURIComponent(url)}`;
}

/**
 * 脱掉标签但保留子内容与文字。
 *
 * 实现上不能直接 replaceWith(...children)：linkedom 在遍历中移动节点
 * 容易丢节点。这里逐个 child 前插，再删除自己。
 */
function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) { el.remove(); return; }
  const kids = [...childNodes(el)];
  const ref = el.nextSibling;
  for (const k of kids) {
    parent.insertBefore(k, ref);
  }
  el.remove();
}

function childNodes(el: Element | Document): Node[] {
  const out: Node[] = [];
  const kids = el.childNodes;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) out.push(kids[i] as Node);
  return out;
}

/**
 * 从正文里挑「纯文字长度」。
 *
 * 用途：判断 feed 里的 HTML 是不是只有标题没有正文，
 * 是则触发原文抓取（PLAN §7.1 L1）。
 */
export function textLength(html: string | null | undefined): number {
  if (!html) return 0;
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}
