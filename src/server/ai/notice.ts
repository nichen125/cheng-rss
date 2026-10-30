import { log } from '../logger.ts';

// 全局性 AI 失败的"只报一次"闸门（PLAN §8.8，2.6）。
//
// 起因是实测（2026-10-30）：用真库快照起二进制、塞 20 条 analyze 任务、
// 不设 AI_API_KEY，30 秒内 stderr 出现 **20 行** `INFO analyze 失败`。
// 真实库里有 745 篇待分析 —— 那会是 745 行，而且每轮 backfill 重排时
// 再来一遍。日志里 745 行同一句"没配置 API key"，把真正的错误全埋掉了。
//
// 分类是关键：`no-key` / `budget` / `http-429` 冷却 是**全局配置状态**，
// 不是某篇文章的属性 —— 报 745 次不会多出任何信息，只报 1 次也不会少。
// 而 `schema` / `empty` / `bad-json` 是**这一篇的问题**，删掉它们就丢信息，
// 所以那几类仍然逐条记。
//
// 不变量：这个模块只在进程内生效。重启后第一条会重新报出来 —— 那是正确的，
// 因为"重启之后还是没 key"本身是需要知道的事。

/** 进程生命周期内只应报一次的全局失败种类 */
const GLOBAL_KINDS = new Set(['no-key', 'budget']);

const seen = new Map<string, number>();

/** 供验收脚本复位（不在业务路径里调用） */
export function resetNotices(): void {
  seen.clear();
}

export function isGlobalKind(kind: string): boolean {
  return GLOBAL_KINDS.has(kind) || kind.startsWith('http-429');
}

/**
 * 这个失败该不该进日志。返回 true 时调用方照常记，false 时静默。
 *
 * 计数的意义：`seen` 里存的是"这个 kind 已经出现过几次"。第二次起返回
 * false，但计数继续累加 —— 退出时（或状态页）能说出"另有 N 次同类失败"，
 * 这句话比 745 行重复日志有用得多。
 */
export function shouldLog(kind: string): boolean {
  const n = (seen.get(kind) ?? 0) + 1;
  seen.set(kind, n);
  if (!isGlobalKind(kind)) return true;
  return n === 1;
}

/** 某类全局失败累计出现过几次（状态页与收尾汇总用） */
export function noticeCount(kind: string): number {
  return seen.get(kind) ?? 0;
}

/** 所有被抑制过的次数，拼成一句话供启动/收尾日志使用 */
export function suppressedSummary(): string {
  const parts: string[] = [];
  for (const [kind, n] of seen) {
    if (isGlobalKind(kind) && n > 1) parts.push(`${kind} 另有 ${n - 1} 次`);
  }
  return parts.join('，');
}

/**
 * 启动横幅：一次说清"没配 key + 有多少待办"。
 *
 * 这一条替代了原本 745 行逐条日志想表达的东西。而它表达得更好：
 * 有数量、有去哪里改、只出现一次。
 */
export function logMissingKeyBanner(pending: number): void {
  log.warn(
    `未配置 AI API key：${pending} 篇待分析，摘要与分类不会产出。`
    + ' 去「配置 → AI 分析 → 模型连接」填写，或设环境变量 AI_API_KEY。',
    { pending },
  );
}
