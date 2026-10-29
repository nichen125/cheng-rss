import type { DatabaseSync } from 'node:sqlite';
import { FALLBACK_SLUG } from './taxonomy.ts';
import type { Tier } from './analyze-types.ts';

// 受控分类与分级（PLAN §8.4 / §19.4 2.3）。
//
// 三件事都放在这个文件里，因为它们共享同一个前提：**模型的输出不可信**。
//   · normalizeCategorySlug  模型给的 slug 可能自造
//   · tierForImportance      分级必须是确定的，不能交给模型自己说
//   · applyClassification    两者的落库版本
// 分开写会让"受控"这条约束散在三处，任何一处漏掉都会让分类法慢慢长歪 ——
// 而它歪掉之后是不可逆的（历史数据要一条条洗）。

/** importance 0~100 → tier 四级。边界左闭右开（90 是 must_read，89 是 worth） */
export const TIER_BOUNDS = {
  normal: 40,
  worth: 70,
  mustRead: 90,
} as const;

/**
 * importance → tier。
 *
 * 为什么不用模型直接给 tier：提示词里给的是分数基准（90+/70~89/…），
 * 让模型同时输出分数和档位，两者不一致时没有裁决依据。分数是唯一事实，
 * 档位是它的函数 —— 这样"把阈值从 70 调到 75"是一次改代码，而不是
 * 重新跑一遍全库。
 */
export function tierForImportance(importance: number): Tier {
  // NaN / Infinity / null 一律当 0 处理：坏数据不能因为比较运算的
  // 怪异行为（NaN >= x 恒为 false）意外落到 must_read。
  const v = Number.isFinite(Number(importance)) ? Number(importance) : 0;
  if (v >= TIER_BOUNDS.mustRead) return 'must_read';
  if (v >= TIER_BOUNDS.worth) return 'worth';
  if (v >= TIER_BOUNDS.normal) return 'normal';
  return 'noise';
}

/**
 * 把模型给的分类归一到受控 slug 列表。
 *
 * 只做「去空白 + 转小写 + 精确匹配」，**不做**模糊/近义/包含匹配。
 *
 * 这条克制是刻意的。加一层"technology → tech"看起来省事，代价是
 * 一旦有 tech-news 这样的 slug，technology 到底该归 tech 还是
 * tech-news 就没有依据了；而猜错的条目用户看不出来（分类本来就常错），
 * 只会表现为"分类越用越乱"。归 other 是可观测的 —— 用户能看到
 * "其他"变多，进而去补 hint 或改分类法。
 */
export function normalizeCategorySlug(
  raw: unknown,
  validSlugs: readonly string[],
): string {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === '') return FALLBACK_SLUG;
  return validSlugs.includes(s) ? s : FALLBACK_SLUG;
}

/**
 * 重算一批条目的分类与 tier（迁移期/改了分类法之后用）。
 *
 * 2.3 只提供函数不留接口 —— 批量重分类属于 M8 的分类 UI，
 * 现在开一个没人调用的 HTTP 端点等于把未验证的写路径提前上线。
 */
export function recountTiersForUser(db: DatabaseSync, userId: string): number {
  const rows = db.prepare(`
    SELECT a.entry_id AS id, a.importance AS importance
      FROM entry_analysis a JOIN entries e ON e.id = a.entry_id
     WHERE e.user_id = ?
  `).all(userId) as { id: string; importance: number }[];
  const upd = db.prepare('UPDATE entry_analysis SET tier = ? WHERE entry_id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) upd.run(tierForImportance(Number(r.importance)), r.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}
