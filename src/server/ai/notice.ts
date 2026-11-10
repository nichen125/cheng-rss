import { log } from '../logger.ts';
import type { AiFailure } from './client.ts';

// 全局性 AI 失败的"只报一次"闸门（PLAN §8.8，2.6）。
//
// 起因是实测（2026-10-30）：用真库快照起二进制、塞 20 条 analyze 任务、
// 不设 AI_API_KEY，30 秒内 stderr 出现 **20 行** `INFO analyze 失败`。
// 真实库里有 745 篇待分析 —— 那会是 745 行，而且每轮 backfill 重排时
// 再来一遍。日志里 745 行同一句"没配置 API key"，把真正的错误全埋掉了。
//
// 分类是关键：`no-key` / `budget` / `upstream-quota`（额度用尽） / `http-429`
// 冷却 是**全局配置状态**，不是某篇文章的属性 —— 报 745 次不会多出任何信息，
// 只报 1 次也不会少。而 `schema` / `empty` / `bad-json` 是**这一篇的问题**，
// 删掉它们就丢信息，所以那几类仍然逐条记。
//
// 不变量：这个模块只在进程内生效。重启后第一条会重新报出来 —— 那是正确的，
// 因为"重启之后还是没 key"本身是需要知道的事。

/** 进程生命周期内只应报一次的全局失败种类 */
const GLOBAL_KINDS = new Set(['no-key', 'budget', 'upstream-quota']);

/**
 * 「这个失败是配置问题，不是这一篇的问题」——按**模型**判定，不是按 kind。
 *
 * 起因是实测：配置里写着 `text-embedding-3-small`，而网关没有这个模型，
 * 于是每条 analyze 之后的那条 embed 都是 503 `model_not_found`。
 * 按 kind 归类的话那是 `http-503`，而 `http-503` 也可能是"上游真的坏了"，
 * 不能一律抑制 —— 抑制真实 5xx 会让"网关炸了"变成静默。
 *
 * 判据换成模型维度就精确了：同一个模型反复报 404/503/model_not_found，
 * 说明这个模型名在网关上根本不存在，跟具体哪篇文章无关。
 * 换模型或改配置后这个 key 自然会变，所以抑制不会跟着用户走。
 */
const modelDead = new Map<string, number>();

/**
 * 这个模型连续失败到可以认定"网关上没有它"的门槛。
 *
 * 3 次而不是 1 次：一次 503 可能只是网关抖了一下，而"模型不存在"是
 * 每次必现的。用 1 次会把一次偶发故障记成配置错误，用户照提示去改配置
 * 反而把能用的模型改掉。
 */
export const DEAD_MODEL_THRESHOLD = 3;

/** 这个模型是否已被认定为"网关上没有它" */
export function isDeadModel(model: string): boolean {
  return (modelDead.get(model) ?? 0) >= DEAD_MODEL_THRESHOLD;
}

/**
 * 记一次该模型失败。返回 true 表示**这一次**该进日志。
 *
 * 前两次照常记（那两次还可能是偶发），到阈值那一次记一条"这个模型
 * 不存在"的警告，之后静默 —— 之后的每一次都已经被那条警告解释了。
 */
export function noteModelFailure(model: string): boolean {
  const n = (modelDead.get(model) ?? 0) + 1;
  modelDead.set(model, n);
  if (n < DEAD_MODEL_THRESHOLD) return true;
  if (n === DEAD_MODEL_THRESHOLD) {
    log.warn(
      `模型 ${model} 连续 ${n} 次失败，网关上很可能没有这个模型。`
      + ' 去「配置 → AI 分析 → 模型名称」改成网关确实提供的模型；'
      + '在此之前它不会再逐条记日志。',
      { model, count: n },
    );
    return true;
  }
  return false;
}

/** 某模型失败过几次（状态页用） */
export function modelFailureCount(model: string): number {
  return modelDead.get(model) ?? 0;
}

/**
 * 「这个失败能指向『模型不存在』」的判据。
 *
 * `noteModelFailure` 的阈值和警告文案只在“模型名在网关上根本不存在”时
 * 才成立。timeout / network / 普通 5xx / upstream-quota 都是网关或账号的
 * 瞬时状态，拿去凑 3 次会把一次抖动记成配置错误，并让后续真实故障被
 * `isDeadModel` 静默掉。
 */
const MODEL_MISSING_RE =
  /model_not_found|no such model|unknown model|invalid model|model[^\n]{0,40}(?:not found|not exist|does not exist)|模型[^\n]{0,20}不存在/i;

export function isModelMissingFailure(f: Pick<AiFailure, 'kind' | 'message'>): boolean {
  // 404 在这个 API 上基本只有“路径或模型名不对”，按模型缺失处理；
  // baseURL 写错时提示会指向模型，是已知取舍。
  return f.kind === 'http-404' || MODEL_MISSING_RE.test(f.message);
}

const seen = new Map<string, number>();

/** 供验收脚本复位（不在业务路径里调用） */
export function resetNotices(): void {
  seen.clear();
  modelDead.clear();
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
