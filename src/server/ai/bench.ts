import type { AiClient, BenchRun } from './client.ts';

// 模型测速的聚合（PLAN §8.11，v2.7 / 步骤 2.11）。
//
// 为什么跑 3 次取中位数而不是跑 1 次：同一个请求在同一网关上实测 2.5~5.8s，
// 一次测量报出来的就是随机数。中位数比均值抗离群（一次网络抖动不会把结论带偏），
// 而 3 次 × 两个模型 ≈ $0.001，比"用户按错误结论换掉一个好模型"便宜得多。

/** 固定探针：30 字以内就能答，又必须真的读一遍才能答对 */
export const BENCH_PROMPT = '用一句话说明什么是 RSS 阅读器，不要超过 30 字。';

/** 默认跑几次。奇数才有确切的中位数 */
export const BENCH_RUNS = 3;

export interface BenchRow {
  model: string;
  runs: BenchRun[];
  /** 中位数。`ok` 的判据是"至少大半成功"，不是"全成功" */
  median: {
    ok: boolean;
    ttftMs: number | null;
    firstReasoningMs: number | null;
    firstContentMs: number | null;
    totalMs: number;
    outTokens: number | null;
    tokensPerSec: number | null;
    /** 逐项的范围，UI 用 `中位数（min~max）` 展示 */
    range: { ttftMs: [number, number] | null; totalMs: [number, number] | null };
  };
  /** 成功的次数 / 总次数 */
  okCount: number;
}

export async function benchModels(deps: {
  client: AiClient;
  models: string[];
  runs?: number;
}): Promise<BenchRow[]> {
  const runs = Math.max(1, deps.runs ?? BENCH_RUNS);
  const out: BenchRow[] = [];

  for (const model of deps.models) {
    const results: BenchRun[] = [];
    for (let i = 0; i < runs; i++) {
      // 串行而不是并发：并发会互相抢带宽与上游队列，测出来的 TTFT 是彼此的干扰。
      // 代价是总耗时 ×runs，但两个模型 × 3 次仍在 20 秒内。
      results.push(await deps.client.probeSpeed({ model, prompt: BENCH_PROMPT }));
    }
    out.push(summarize(model, results));
  }
  return out;
}

function summarize(model: string, results: BenchRun[]): BenchRow {
  const okRuns = results.filter((r) => r.ok);
  const nums = (pick: (r: BenchRun) => number | null): number[] => okRuns
    .map(pick)
    .filter((v): v is number => v !== null);

  const med = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
  };
  const range = (xs: number[]): [number, number] | null =>
    (xs.length === 0 ? null : [Math.min(...xs), Math.max(...xs)]);

  const ttfts = nums((r) => r.ttftMs);
  const totals = nums((r) => r.totalMs);

  return {
    model,
    runs: results,
    okCount: okRuns.length,
    median: {
      // "至少过半成功"：3 次里坏 1 次仍算可用（网关偶发 5xx 是常态），
      // 坏 2 次就说明这个模型现在真的不行了
      ok: okRuns.length > 0 && okRuns.length * 2 > results.length,
      ttftMs: med(ttfts),
      firstReasoningMs: med(nums((r) => r.firstReasoningMs)),
      firstContentMs: med(nums((r) => r.firstContentMs)),
      totalMs: med(totals) ?? 0,
      outTokens: med(nums((r) => r.outTokens)),
      tokensPerSec: med(nums((r) => r.tokensPerSec)),
      range: { ttftMs: range(ttfts), totalMs: range(totals) },
    },
  };
}
