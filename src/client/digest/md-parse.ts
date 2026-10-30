// 简报/总结正文的极简 Markdown **解析**（PLAN §15.4 / §8.9）。
//
// 与渲染分开成两个文件（`md-parse.ts` 与 `markdown.tsx`）的理由只有一条：
// 解析是纯函数、能在 Node 里直接 import 做验收（`m2-07` 的 ⑨）；
// 渲染返回 React 节点，必须有 .tsx。合在一起时那段解析逻辑就只能靠
// 真实浏览器验，而浏览器断言比纯函数断言慢两个数量级、还更脆。
//
// 为什么自己写而不是引 marked / markdown-it：
//   · 简报与总结只用得到 6 种语法（标题、段落、粗体、列表、分隔线、脚注号）
//   · 引一个 30KB 的解析器再配一遍 sanitize 白名单，比这 80 行更难保证安全
//   · **直接产出 React 节点而不是 HTML 字符串** —— React 自动转义，
//     模型输出的 `<script>` 只会显示成字面文字，不存在注入面

/** 一行内联片段：普通文字或粗体或脚注号 */
export type Inline = { kind: 'text'; text: string } | { kind: 'bold'; text: string }
  | { kind: 'cite'; n: number };

/** 一条引用（脚注号 → 事件标题），渲染层用来把 `[n]` 做成可点的 chip */
export interface CiteInfo {
  index: number;
  title: string;
}

export type MdBlock =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'hr' };

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

/**
 * 按行把 Markdown 拆成块。
 *
 * 不追求完整 Markdown 语义 —— 只保证"模型写出来的正文能读"，以及
 * **任何输入都不会抛错**（模型偶尔会输出半截列表或空行，解析器崩了
 * 整个页面就白了，而正文其实有一半是可用的）。
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
