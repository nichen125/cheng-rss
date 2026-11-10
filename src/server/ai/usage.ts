import type { DatabaseSync } from 'node:sqlite';
import type { AiUsageRecord } from './client.ts';

// ai_usage 落库（PLAN §8.1 / §19.4 2.5 的①）。
//
// 为什么从 2.1 就写：预算闸门（2.5）的判据是"今天已经花了多少"，
// 而那个数字只能从这张表来。等到 2.5 再补写入，前面积压的历史调用就
// 永远不进账 —— 闸门一上线就对着一个偏低的基线，第一次放行就超支。
//
// 记的是**调用**不是条目：一次分析如果因为 schema 不合规重试了一次，
// 这里就是两行。这一点在 §8.6 里解释了为什么必须这样。

export interface InsertUsageInput extends AiUsageRecord {
  userId: string;
}

export function recordUsage(db: DatabaseSync, u: InsertUsageInput, now = Date.now()): void {
  db.prepare(`
    INSERT INTO ai_usage (user_id, purpose, model, in_tokens, out_tokens, cost_usd,
                          latency_ms, ok, error, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    u.userId, u.purpose, u.model,
    u.inTokens ?? null, u.outTokens ?? null, u.costUsd ?? 0,
    u.latencyMs ?? null, u.ok ? 1 : 0, u.error ?? null, now,
  );
}

/**
 * 某用户从 `since` 起的花费与调用数。预算闸门读它。
 *
 * 第 4 个参数用于「只统计某一类调用」——简报的单次花费上限必须排除并发
 * 的 analyze/embed，否则别人花的钱会让本次生成提前取消。不传则维持原口径
 * （预算日/月门需要的是用户总花费）。
 */
export function usageSince(
  db: DatabaseSync,
  userId: string,
  since: number,
  purpose?: string | readonly string[],
): { usd: number; calls: number; failures: number } {
  const purposes = purpose === undefined
    ? null
    : (typeof purpose === 'string' ? [purpose] : purpose);
  // 空数组的语义是「没有任何一类」——直接返回 0，不拼出非法的 IN ()。
  if (purposes !== null && purposes.length === 0) {
    return { usd: 0, calls: 0, failures: 0 };
  }
  const filter = purposes ? ` AND purpose IN (${purposes.map(() => '?').join(',')})` : '';
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS usd,
           COUNT(*) AS calls,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
      FROM ai_usage WHERE user_id = ? AND created_at >= ?${filter}
  `).get(userId, since, ...(purposes ?? [])) as
    { usd: number; calls: number; failures: number | null } | undefined;
  return {
    usd: Number(row?.usd ?? 0),
    calls: Number(row?.calls ?? 0),
    failures: Number(row?.failures ?? 0),
  };
}

/** 今天（本地日历日）0 点的时间戳 */
export function startOfLocalDay(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本月（本地日历月）1 号 0 点 */
export function startOfLocalMonth(now = Date.now()): number {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
