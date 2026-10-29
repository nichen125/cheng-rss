import type { DatabaseSync } from 'node:sqlite';
import type { AiConfig } from './client.ts';
import { startOfLocalDay, startOfLocalMonth, usageSince } from './usage.ts';

// 预算闸门（PLAN §8.5 / §19.4 2.5）。
//
// 三档，两个门：
//   累计日花费 < dailyUsd            → ok
//   累计日花费 ≥ dailyUsd            → fast_only（降级到快模型，继续分析）
//   累计月花费 ≥ monthlyUsd          → stop（不再发请求）
//
// 为什么日门降级而月门停止：
//   · 日预算的作用是"今天别把额度烧光"，而完全停掉会让用户当天再也拿不到
//     任何摘要。降到 fast 模型能继续产出，成本约 1/5。
//   · 月预算的作用是"这个月就这么多钱"，越过它再降级也还是花钱，
//     所以必须停。
//
// 为什么不用「日均 × 剩余天数」之类的动态额度：那会让闸门的行为随时间
// 漂移（月初很宽松、月末很紧），用户完全无法预期。固定两档可预期得多。

export type BudgetLevel = 'ok' | 'fast_only' | 'stop';

export interface BudgetState {
  level: BudgetLevel;
  /** 今日（本地日历日）已花 */
  todayUsd: number;
  /** 本月已花 */
  monthUsd: number;
  /** 今日额度与月额度，供 UI 显示进度 */
  dailyLimit: number;
  monthlyLimit: number;
  /** 今日调用数与失败数 */
  todayCalls: number;
  todayFailures: number;
  /** 人话解释当前档位（UI 直接显示它，不再自己拼句子） */
  reason: string;
}

/**
 * 读当前预算状态。每次调用一次 SUM，索引是 (user_id, created_at)。
 *
 * 刻意不缓存：闸门的意义是"花超了就立刻停"，缓存 60 秒意味着可以超支
 * 60 秒的量。而这条查询在 1 万行量级上是 0.1ms 级，比一次模型调用便宜
 * 五个数量级。
 */
export function budgetState(
  db: DatabaseSync,
  userId: string,
  cfg: AiConfig,
  now = Date.now(),
): BudgetState {
  const day = usageSince(db, userId, startOfLocalDay(now));
  const month = usageSince(db, userId, startOfLocalMonth(now));

  const dailyLimit = cfg.budget.dailyUsd;
  const monthlyLimit = cfg.budget.monthlyUsd;
  const fallback = cfg.fallback.onBudgetExceeded;

  let level: BudgetLevel = 'ok';
  let reason = '';

  if (monthlyLimit > 0 && month.usd >= monthlyLimit) {
    level = 'stop';
    reason = `本月已花 $${month.usd.toFixed(3)}，达到上限 $${monthlyLimit.toFixed(2)}，已暂停 AI 调用`;
  } else if (dailyLimit > 0 && day.usd >= dailyLimit) {
    // 用户把 fallback 设成 stop 时，日门也直接停 —— 有人就是不想降级
    level = fallback === 'stop' ? 'stop' : 'fast_only';
    reason = fallback === 'stop'
      ? `今日已花 $${day.usd.toFixed(3)}，达到上限 $${dailyLimit.toFixed(2)}，已暂停 AI 调用`
      : `今日已花 $${day.usd.toFixed(3)}，达到上限 $${dailyLimit.toFixed(2)}，已降级到快模型继续分析`;
  }

  return {
    level,
    todayUsd: round6(day.usd),
    monthUsd: round6(month.usd),
    dailyLimit,
    monthlyLimit,
    todayCalls: day.calls,
    todayFailures: day.failures,
    reason,
  };
}

/** 浮点累加会给出 0.30000000000000004 这种数，显示前收一下 */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * 闸门交给 AiClient 的形态。
 *
 * 把"能不能调"做成一个回调而不是在 AiClient 里直接读库：
 *   · AiClient 因此不需要知道数据库（它现在只有 config 与 key）
 *   · 验收脚本可以注入一个固定返回 stop 的 guard 来测"不发请求"
 *   · 将来加"单次请求上限"之类的策略，只改 guard 的实现
 */
export type CallGuard = (req: { purpose: string; model: string }) =>
  | { action: 'allow' }
  | { action: 'downgrade'; model: string; reason: string }
  | { action: 'block'; reason: string };

/** 由预算状态构造 guard。downgrade 时把 strong 换成 fast */
export function budgetGuard(
  db: DatabaseSync,
  userId: string,
  cfg: AiConfig,
): CallGuard {
  return (req) => {
    const st = budgetState(db, userId, cfg);
    if (st.level === 'stop') return { action: 'block', reason: st.reason };
    if (st.level === 'fast_only') {
      // embedding 不降级：快模型那份是 chat 模型，向量模型没有"更便宜的同族"
      if (req.purpose === 'embed') return { action: 'allow' };
      const fast = cfg.models.fast;
      if (req.model === fast) return { action: 'allow' };
      return { action: 'downgrade', model: fast, reason: st.reason };
    }
    return { action: 'allow' };
  };
}
