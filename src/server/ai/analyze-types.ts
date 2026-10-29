// 分析的共享类型。
//
// 单独一个文件是为了打断循环依赖：classify.ts 需要 Tier，
// analyze.ts 需要 tierForImportance —— 两者互相 import 时，
// ESM 在类型层没事，但在运行时会拿到 undefined（取决于加载顺序）。
// 类型放这里，两边都只依赖它。

import type { AiFailure } from './client.ts';

/** importance 的四个档位（PLAN §8.4） */
export type Tier = 'must_read' | 'worth' | 'normal' | 'noise';

/** 分析一个条目的结果。字段与 analyze.ts 的返回值一致 */
export interface AnalyzedEntry {
  ok: boolean;
  skipped: boolean;
  called: boolean;
  failure: AiFailure | null;
  /** 归一后的分类 slug（已保证在受控列表里） */
  categorySlug: string | null;
  /** 模型原始给的 slug，用于排查"为什么这条进了 other" */
  rawCategory?: string | null;
}
