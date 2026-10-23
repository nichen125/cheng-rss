// 中文分词：bigram 预切分。
//
// 为什么必须自己做（PLAN §7.3 实测）：
//   · FTS5 trigram 要求查询 ≥3 字符 → 「芯片」「裁员」查不到，返回空
//   · FTS5 unicode61 把整句中文当一个 token → 同样查不到
//   · LIKE 全表扫描在没有命中时要 180~360ms（10 万条）
//
// 做法：写入时把中文切成相邻两字（「台积电」→「台积 积电」），
// 查询时也切成 bigram 并用短语查询（引号）保证相邻。
// 这样 3 字词能查到，且「半导X体」不会被「半导体」误命中。

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const WORD_RUN = /[A-Za-z0-9_]+/g;

/** 把一段文本切成 bigram token 数组（保持原文顺序） */
export function bigrams(text: string): string[] {
  const out: string[] = [];
  // 同时扫描中文块与英文/数字块，按出现顺序处理
  const re = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = m[0];
    if (CJK.test(t)) {
      if (t.length === 1) {
        out.push(t);
      } else {
        for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
      }
    } else {
      out.push(t.toLowerCase());
    }
  }
  return out;
}

/** 写入侧：token 用空格连接，交给 FTS5 索引 */
export function toIndexText(...parts: (string | null | undefined)[]): string {
  const toks: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    toks.push(...bigrams(p));
  }
  return toks.join(' ');
}

/**
 * 查询侧：把用户输入转成 FTS5 MATCH 表达式。
 *
 * 每个词切成 bigram 后用双引号包成短语（相邻约束），词间 AND。
 * 必须用短语查询，否则「半导体」会变成匹配「半导」或「导体」任一，
 * 把「半导X体」这类不连续文本也命中。
 */
export function toMatchQuery(query: string): string {
  const parts: string[] = [];
  const re = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    const word = m[0];
    const bg = bigrams(word);
    if (bg.length === 0) continue;
    // FTS5 短语：双引号内的 token 按顺序相邻匹配
    parts.push(`"${bg.join(' ')}"`);
  }
  return parts.join(' AND ');
}

/**
 * 把用户输入拆成独立的检索词（用于高亮结果、构建摘要）。
 * 与 toMatchQuery 不同，这里返回原始词而非 bigram。
 */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  const re = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) out.push(m[0]);
  return out;
}

/** 供调试与验收：判断一段文本是否包含某个中文词（按 bigram 语义） */
export function bigramContains(haystack: string, needle: string): boolean {
  const target = bigrams(needle);
  if (target.length === 0) return false;
  const hay = bigrams(haystack);
  if (target.length > hay.length) return false;
  for (let i = 0; i + target.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (hay[i + j] !== target[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}
