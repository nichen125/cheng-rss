import type { ReactNode } from 'react';

// 简报正文的极简 Markdown 渲染（PLAN §15.4 / 3.5）。
//
// 为什么自己写而不是引 marked / markdown-it：
//   · 简报正文只用得到 6 种语法（标题、段落、粗体、列表、分隔线、脚注号）
//   · 引一个 30KB 的解析器再配一遍 sanitize 白名单，比这 80 行更难保证安全
//   · **直接产出 React 节点而不是 HTML 字符串** —— React 自动转义，
//     模型输出的 `<script>` 只会显示成字面文字，不存在注入面
//
// 最后一条是主要的：用 dangerouslySetInnerHTML 渲染模型输出，要么依赖
// 一个清洗器（它自己也要被验证），要么就在赌模型不会写恶意 HTML。
// 两条路都不如"根本不生成 HTML"。

/** 一行内联片段：普通文字或粗体或脚注号 */
type Inline = { kind: 'text'; text: string } | { kind: 'bold'; text: string }
  | { kind: 'cite'; n: number };

/**
 * 拆行内标记。
 *
 * 只认 `**粗体**` 与 `[n]` 脚注号（n 为 1~99）。刻意不认 `[文字](url)`：
 * 服务端已经把 Markdown 链接抹成纯文字了，这里再支持只会让"模型偷偷写链接"
 * 有一条漏网的路。
 */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|\[(\d{1,2})\]/g;
  let last = 0;
  for (;;) {
    const m = re.exec(s);
    if (!m) break;
    if (m.index > last) out.push({ kind: 'text', text: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'bold', text: m[1] });
    else out.push({ kind: 'cite', n: Number(m[2]) });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last) });
  return out;
}

export interface CiteInfo {
  index: number;
  title: string;
}

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

export type MdBlock =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'hr' };

/**
 * 按行把 Markdown 拆成块。
 *
 * 不追求完整 Markdown 语义 —— 只保证"模型写出来的简报能读"，以及
 * **任何输入都不会抛错**（模型偶尔会输出半截列表或空行，解析器崩了
 * 整个简报页就白了，而正文其实有一半是可用的）。
 */
export function parseMarkdown(md: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = String(md ?? '').split(/\r?\n/);
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ kind: 'p', text: para.join(' ') });
      para = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push({ kind: 'ul', items: list });
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') { flushPara(); flushList(); continue; }

    const h = /^(#{2,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      blocks.push({ kind: h[1]!.length === 2 ? 'h2' : 'h3', text: h[2]!.trim() });
      continue;
    }
    if (/^---+\s*$/.test(line)) { flushPara(); flushList(); blocks.push({ kind: 'hr' }); continue; }

    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      list.push(li[1]!);
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}
