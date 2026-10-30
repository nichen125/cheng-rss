import { useMemo } from 'react';
import { parseMarkdown, renderInline, type CiteInfo } from '../digest/markdown.tsx';

// 单篇总结的 Markdown 渲染（PLAN §8.9 / §15.27，v2.0）。
//
// **直接复用简报页的解析器**（`digest/markdown.tsx`），不新写一个。
// 理由只有一条但足够：那份解析器的核心约束是"产出 React 节点，永不生成
// HTML 字符串"，而这条约束守两遍就会有一遍漏 —— 漏掉的那一遍就是注入面。
//
// 与简报页唯一的差别是**没有脚注**：总结里不存在 `[n]` 引用（模型没有被
// 要求标引用，也不该有）。所以传一张空 Map 与一个空回调，`[1]` 这种文本
// 会渲染成灰色的「无对应引用」小字 —— 那正是它应有的样子：让模型偶尔写出的
// 数字方括号看起来就是普通的数字方括号，而不是可点的东西。
const NO_CITES = new Map<number, CiteInfo>();
const noop = () => { /* 总结里没有可点的脚注 */ };

export function SummaryMarkdown({ md }: { md: string }) {
  const blocks = useMemo(() => parseMarkdown(md), [md]);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'h2') return <h2 key={i}>{renderInline(b.text, NO_CITES, noop, null)}</h2>;
        if (b.kind === 'h3') return <h3 key={i}>{renderInline(b.text, NO_CITES, noop, null)}</h3>;
        if (b.kind === 'hr') return <hr key={i} />;
        if (b.kind === 'ul') {
          return (
            <ul key={i}>
              {b.items.map((it, k) => <li key={k}>{renderInline(it, NO_CITES, noop, null)}</li>)}
            </ul>
          );
        }
        return <p key={i}>{renderInline(b.text, NO_CITES, noop, null)}</p>;
      })}
    </>
  );
}

/**
 * 失败 kind → 一句话。
 *
 * 为什么按 kind 而不是直接把 message 丢给用户：`http-401` 与 `network`
 * 的处置完全不同（一个去改 key，一个去检查网络），而 message 都是
 * "HTTP 401: …" 这种原始报文。kind 是"该怎么办"的依据，message 是细节。
 */
export function sumFailHint(kind: string): string {
  if (kind === 'no-key') return '还没配置 API key —— 去「配置 → AI 分析 → API Key」填一个。';
  if (kind === 'http-401' || kind === 'http-403') return 'API key 无效或没有权限。';
  if (kind === 'http-429') return '触发了服务商限流，稍后再试。';
  if (kind === 'budget') return '已达到预算上限，今天的额度用完了。';
  if (kind === 'network' || kind === 'timeout') return '连不上模型接口，检查网络与接口地址。';
  if (kind === 'empty') return '这篇没有可总结的正文。';
  if (kind === 'schema' || kind === 'bad-json') return '模型这次没按格式输出，再点一次通常就好。';
  return '生成失败。';
}
