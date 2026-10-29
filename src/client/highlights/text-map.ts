/**
 * 阅读区的划词高亮（PLAN §11.3，M4）。
 *
 * 这一层的难点全在**坐标换算**：浏览器给的是 DOM Range（某个文本节点里
 * 的第几个字符），而库里存的是「整篇纯文本里从第几到第几」。中间差着
 * 一整套标签结构、空白折叠与块级元素换行。
 *
 * 三种可选做法，选了第三种：
 *   1. 直接存 DOM 偏移 + XPath —— 正文重新提取后 XPath 全失效（§11.1 已论证）
 *   2. 存 HTML 里的字符偏移 —— 与做法 1 同类问题，只是把 XPath 换成标签序列
 *   3. **存纯文本偏移**，浏览器侧按同一份纯文本再换算回来
 *
 * 代价是要在客户端复刻一份"HTML → 纯文本"的映射（每个文本节点在全文里的
 * 起止）。这份映射只在渲染后算一次，且与 service 端 htmlToText 的规则
 * 必须**等价** —— 不等价的话，服务端算出来的位置在浏览器里落不到同一处。
 * 所以下面 walkText 的规则要与 feeds/parse.ts 的 htmlToText 逐条对齐：
 *   · 块级元素之间插一个空格（不是换行）
 *   · 连续空白压成一个空格
 */

/** 块级标签：进入/离开时补一个空格（与 htmlToText 对齐） */
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE',
  'PRE', 'TABLE', 'TR', 'TD', 'TH', 'FIGURE', 'FIGCAPTION', 'HR',
  'BR', 'ADDRESS', 'DL', 'DT', 'DD',
]);

export interface TextSegment {
  node: Text;
  /** 在整篇纯文本里的起点（含） */
  start: number;
  /** 终点（不含） */
  end: number;
}

export interface TextMap {
  text: string;
  segments: TextSegment[];
}

/**
 * 把容器的 DOM 展平成「纯文本 + 每个文本节点的区间」。
 *
 * 规则（必须与 htmlToText 一致）：
 *   · 块级元素前后各一个空格
 *   · 文本里的连续空白压成一个空格
 *   · 元素间不额外加换行（只用空格）—— 这条最容易写错：浏览器渲染时块级
 *     元素各占一行，但**纯文本**里它们是空格分隔。如果这里用换行，
 *     所有跨段位置都会错位。
 */
export function buildTextMap(root: HTMLElement): TextMap {
  const segments: TextSegment[] = [];
  const parts: string[] = [];
  let pos = 0;

  /** 补一个空格（若末尾还不是空格且非空） */
  const pushSpace = () => {
    if (pos > 0 && parts.length > 0 && parts[parts.length - 1] !== ' ') {
      parts.push(' ');
      pos += 1;
    }
  };

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      const raw = t.data;
      // 空白折叠：逐字符扫，连续空白只保留一个
      let out = '';
      let lastWasSpace = parts.length > 0 && parts[parts.length - 1] === ' ';
      const start = pos;
      for (const ch of raw) {
        const isSpace = /\s/.test(ch);
        if (isSpace) {
          if (!lastWasSpace && pos > 0) { out += ' '; lastWasSpace = true; }
        } else {
          out += ch;
          lastWasSpace = false;
        }
      }
      if (out.length > 0) {
        parts.push(out);
        pos += out.length;
        segments.push({ node: t, start, end: pos });
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();
    // 脚本/样式/注释的内容不参与正文
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) pushSpace();
    for (const child of Array.from(el.childNodes)) walk(child);
    if (isBlock) pushSpace();
  };

  for (const child of Array.from(root.childNodes)) walk(child);

  // 首尾空格去掉 —— 与 htmlToText 的 trim 对齐
  let text = parts.join('');
  const lead = text.length - text.trimStart().length;
  if (lead > 0) {
    text = text.slice(lead);
    for (const s of segments) { s.start = Math.max(0, s.start - lead); s.end = Math.max(0, s.end - lead); }
  }
  const trimmedLen = text.trimEnd().length;
  if (trimmedLen < text.length) {
    text = text.slice(0, trimmedLen);
    for (const s of segments) { s.end = Math.min(s.end, trimmedLen); }
  }

  // 丢掉被 trim 削空的段（它们再也定位不到任何字符）
  return { text, segments: segments.filter((s) => s.end > s.start) };
}

/**
 * 把 DOM Range 换成纯文本区间。
 *
 * 选区两端可能落在元素节点上（用户从段首拖到段尾时，anchorNode 常常是
 * 父元素而不是文本节点），这时要取"该元素内第一个/最后一个文本节点"
 * 的边界。不做这个处理的话，跨段选区会算出 null，而它恰恰是最常见的
 * 划词方式。
 */
export function rangeToOffsets(
  map: TextMap, range: Range,
): { start: number; end: number; exact: string } | null {
  const start = pointToOffset(map, range.startContainer, range.startOffset, 'start');
  const end = pointToOffset(map, range.endContainer, range.endOffset, 'end');
  if (start === null || end === null || end <= start) return null;
  return { start, end, exact: map.text.slice(start, end) };
}

function pointToOffset(
  map: TextMap, container: Node, offset: number, side: 'start' | 'end',
): number | null {
  // 情况 1：容器是文本节点 —— 直接查表
  if (container.nodeType === Node.TEXT_NODE) {
    const seg = map.segments.find((s) => s.node === container);
    if (!seg) return null;
    // offset 是**原始文本**里的位置，而段内是折叠后的位置。
    // 折叠发生在段内，所以这里按比例换算不可行 —— 直接在原始文本上
    // 重算一次折叠前缀长度。
    const raw = (container as Text).data;
    const prefix = collapsePrefix(raw.slice(0, offset));
    return clamp(seg.start + prefix.length, seg.start, seg.end);
  }

  // 情况 2：容器是元素 —— 取它内部第一个/最后一个文本节点的边界
  if (container.nodeType === Node.ELEMENT_NODE) {
    const el = container as Element;
    const kids = Array.from(el.childNodes).slice(0, offset);
    const last = kids[kids.length - 1];
    if (last && side === 'end') {
      const seg = lastTextSegment(map, last);
      if (seg) return seg.end;
    }
    const next = Array.from(el.childNodes)[offset];
    if (next) {
      const seg = firstTextSegment(map, next);
      if (seg) return side === 'start' ? seg.start : seg.end;
    }
    // 退一步：容器内所有文本段
    const inside = map.segments.filter((s) => el.contains(s.node));
    if (inside.length === 0) return null;
    return side === 'start' ? inside[0]!.start : inside[inside.length - 1]!.end;
  }

  return null;
}

function firstTextSegment(map: TextMap, node: Node): TextSegment | null {
  const inside = map.segments.filter((s) => s.node === node || (node as Element).contains?.(s.node));
  return inside[0] ?? null;
}

function lastTextSegment(map: TextMap, node: Node): TextSegment | null {
  const inside = map.segments.filter((s) => s.node === node || (node as Element).contains?.(s.node));
  return inside[inside.length - 1] ?? null;
}

function collapsePrefix(raw: string): string {
  let out = '';
  let lastSpace = false;
  for (const ch of raw) {
    if (/\s/.test(ch)) {
      if (!lastSpace && out.length > 0) { out += ' '; lastSpace = true; }
    } else { out += ch; lastSpace = false; }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 把纯文本区间换算回 DOM Range（用于渲染已有高亮的背景色、滚动定位）。
 *
 * 返回 null 表示这段文字在当前 DOM 里找不到 —— 服务端已经判过 orphaned，
 * 但客户端也可能因为**渲染差异**找不到（比如图片懒加载后正文结构变了）。
 * 这种情况不该抛错，只是这条高亮不显示背景色而已。
 */
export function offsetsToRange(map: TextMap, start: number, end: number): Range | null {
  const s = locate(map, start, 'start');
  const e = locate(map, end, 'end');
  if (!s || !e) return null;
  const r = document.createRange();
  try {
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
  } catch {
    return null;
  }
  return r;
}

function locate(
  map: TextMap, pos: number, side: 'start' | 'end',
): { node: Text; offset: number } | null {
  if (pos < 0 || pos > map.text.length) return null;

  // 边界处理：pos 恰好落在段尾时，向"正确的方向"找那个段。
  //   · 作为 start：应取**下一个**段的开头（否则 start==end 内容为空）
  //   · 作为 end：应取**当前**段的末尾
  for (const seg of map.segments) {
    if (pos >= seg.start && pos < seg.end) {
      const folded = pos - seg.start;
      return { node: seg.node, offset: unCollapse(seg.node.data, folded) };
    }
    if (pos === seg.end && side === 'end') {
      const folded = seg.end - seg.start;
      return { node: seg.node, offset: unCollapse(seg.node.data, folded) };
    }
  }
  // start 落在最后一段之后：没有可取的字符
  if (side === 'start') {
    const last = map.segments[map.segments.length - 1];
    if (last && pos >= last.end) return null;
  }
  return null;
}

/**
 * 折叠位置 → 原始文本位置。
 *
 * 因为折叠只会**删除**字符（不替换），所以原始位置 ≥ 折叠位置。逐个
 * 字符走一遍，数到第 folded 个非折叠字符为止。
 */
function unCollapse(raw: string, folded: number): number {
  if (folded <= 0) return 0;
  let count = 0;
  let lastSpace = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const isSpace = /\s/.test(ch);
    if (isSpace) {
      if (!lastSpace && count > 0) {
        count++;
        if (count === folded) return i + 1;
        lastSpace = true;
      }
    } else {
      count++;
      if (count === folded) return i + 1;
      lastSpace = false;
    }
  }
  return raw.length;
}

/**
 * 拆掉所有上一轮画上去的 `<mark>`，把里面的文本节点放回父元素。
 *
 * 为什么必须有这一步：重画的前提是 DOM 回到"没有 mark"的原始状态。
 * 直接在带 mark 的 DOM 上再画一次会把同一个字包两层，外层 class 还是
 * 旧颜色 —— 用户看到"改色没生效"，而代码里一切正常。
 */
export function unwrapHighlights(root: HTMLElement): void {
  const marks = [...root.querySelectorAll('mark.hl')];
  // 从里往外拆：嵌套的 mark 先拆内层，否则拆外层时内层会被一起带走
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i]!;
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    // 相邻的文本节点合并回去 —— 不合并的话，一段被切过的文字会变成
    // 好几个 Text 节点，buildTextMap 的段数与偏移都会与"干净 DOM"不同，
    // 于是重算出来的位置和用户当初选的就不一样了。
    parent.normalize();
  }
}

/** 三种颜色（§11.3：不做调色盘） */
export const COLORS = ['yellow', 'green', 'blue'] as const;
export type HighlightColor = typeof COLORS[number];

export const COLOR_LABEL: Record<HighlightColor, string> = {
  yellow: '黄',
  green: '绿',
  blue: '蓝',
};

/**
 * 把一条高亮包进 `<mark>`。
 *
 * 为什么不直接 setRange + document.execCommand('hiliteColor')：那个 API
 * 已废弃，而且是**改 DOM**（插入 <font style>），会把正文结构改掉 ——
 * 下一次重渲染时 dangerouslySetInnerHTML 会把它们全冲掉，且期间计算
 * 的 offsets 也不再对应。用 Range.surroundContents 也不行：跨节点的选区
 * 会抛异常。
 *
 * 所以：把每个命中区间**按文本节点切开**，逐节点包 mark。一个跨三段的
 * 高亮会得到三个 <mark>，但它们共享同一个 data-highlight-id —— 视觉上是
 * 一条，点击时也能一起处理。
 */
export function wrapRange(map: TextMap, start: number, end: number, id: string, color: string): void {
  const hits = map.segments.filter((s) => s.end > start && s.start < end);
  // 从后往前切：每切一次都会改变 DOM 结构，前面的段位置不受影响
  for (let i = hits.length - 1; i >= 0; i--) {
    const seg = hits[i]!;
    const from = unCollapse(seg.node.data, Math.max(0, start - seg.start));
    const to = unCollapse(seg.node.data, Math.min(seg.end - seg.start, end - seg.start));
    if (to <= from) continue;
    const r = document.createRange();
    try {
      r.setStart(seg.node, from);
      r.setEnd(seg.node, to);
    } catch {
      continue;
    }
    const mark = document.createElement('mark');
    mark.className = `hl hl-${color}`;
    mark.dataset.highlightId = id;
    try {
      r.surroundContents(mark);
    } catch {
      // 跨节点时 surroundContents 抛异常 —— 上面的 from/to 已经保证在
      // 单个文本节点内，所以这里只可能是极端边界情况。跳过而不是中断
      // 整个渲染：一条高亮画不出来不该让其余的全丢。
    }
  }
}
