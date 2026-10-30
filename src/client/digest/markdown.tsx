import type { ReactNode } from 'react';
import { parseInline, type CiteInfo } from './md-parse.ts';

// 简报正文的渲染（PLAN §15.4 / 3.5）。
//
// 解析与渲染分在两个文件：解析（`md-parse.ts`）是纯函数，能在 Node 里
// 直接 import 做验收；渲染返回 React 节点，必须有 .tsx。合在一起时
// 解析逻辑就只能靠真实浏览器验，慢两个数量级还更脆。
//
// **直接产出 React 节点而不是 HTML 字符串** —— React 自动转义，模型输出
// 的 `<script>` 只会显示成字面文字，不存在注入面。用 dangerouslySetInnerHTML
// 渲染模型输出，要么依赖一个清洗器（它自己也要被验证），要么就在赌模型
// 不会写恶意 HTML。两条路都不如"根本不生成 HTML"。

export { parseInline, parseMarkdown } from './md-parse.ts';
export type { Inline, MdBlock, CiteInfo } from './md-parse.ts';

/**
 * 把一行的内联片段渲染成 React 节点。
 *
 * `[n]` 变成可点的脚注 chip。找不到对应引用时渲染成灰色的 `[n]` 而不是
 * 也做成按钮 —— 点开一个空卡片比点不动更让人困惑。
 */
export function renderInline(
  s: string,
  byIndex: Map<number, CiteInfo>,
  onCite: (index: number) => void,
  activeIndex: number | null,
): ReactNode[] {
  return parseInline(s).map((seg, i) => {
    if (seg.kind === 'bold') return <strong key={i}>{seg.text}</strong>;
    if (seg.kind === 'text') return <span key={i}>{seg.text}</span>;
    const info = byIndex.get(seg.n);
    if (!info) {
      return (
        <span key={i} className="digest-cite digest-cite-missing" title="这条引用没有对应的事件">
          [{seg.n}]
        </span>
      );
    }
    return (
      <button
        key={i}
        className={`digest-cite${activeIndex === seg.n ? ' active' : ''}`}
        title={info.title}
        onClick={() => onCite(seg.n)}
      >
        [{seg.n}]
      </button>
    );
  });
}
