import type { DatabaseSync } from 'node:sqlite';

// 受控分类法（PLAN §8.4）。
//
// 「受控」的意思是：AI 只能从这张表里选 slug，不能自造。§21 的风险表把
// 「标签越用越乱」列为长期风险，受控分类法就是它的对策。
//
// 默认分类只是**起点**，用户可以在 settings 里改（M8 的分类 UI）。
// 但即使一行都不改，系统也必须能跑 —— 没有分类法的第一次分析不能让
// 模型自由发挥，那样第一批条目就会长出十几个同义标签。

export interface Category {
  slug: string;
  name: string;
  /** 给 LLM 的判定说明。§8.4：填好 hint 能显著提升一致率 */
  hint: string;
}

/**
 * 默认分类表。
 *
 * 选择依据是「按读者的决策方式分，不按行业分」：
 * 一个读者早上想知道的是"这事要不要现在看"，所以 tech/industry/business
 * 这种粗分比"半导体/消费电子/云计算"更有用 —— 后者是标签的职责
 * （topics 字段），不是分类的职责。
 *
 * `other` 必须存在：没有它，模型遇到归不进任何一类的东西只能硬塞，
 * 而硬塞的数据比 other 更难清理。
 */
export const DEFAULT_CATEGORIES: Category[] = [
  { slug: 'tech', name: '技术', hint: '软件、硬件、算法、工程实践的进展与解读' },
  { slug: 'industry', name: '产业', hint: '公司战略、并购、产能、供应链、市场格局变化' },
  { slug: 'product', name: '产品', hint: '具体产品与服务的发布、更新、定价、体验评测' },
  { slug: 'research', name: '研究', hint: '论文、实验结论、学术进展；不含产品化的工程实现' },
  { slug: 'policy', name: '政策', hint: '监管、立法、标准、处罚、合规要求' },
  { slug: 'business', name: '商业', hint: '融资、财报、商业模式、组织与人事变动' },
  { slug: 'opinion', name: '观点', hint: '评论、复盘、个人经验；核心价值在于判断而非事实' },
  { slug: 'life', name: '生活', hint: '与工作无直接关系的兴趣、健康、消费、文化' },
  { slug: 'other', name: '其他', hint: '确实无法归入上面任何一类时选它，不要硬塞' },
];

/** 归不进任何已知分类时落到这里 */
export const FALLBACK_SLUG = 'other';

/**
 * 确保该用户有分类法。幂等：按 (user_id, slug) 唯一索引插入或忽略。
 *
 * 为什么不放进迁移 SQL：迁移是全库一份的，而 categories.user_id 是
 * NOT NULL —— 迁移执行时用户可能还不存在（首次启动先 migrate 再 setup）。
 * 所以只能在用户出现之后补，而"每次分析前调一次"是最省心的时机。
 */
export function ensureDefaultCategories(db: DatabaseSync, userId: string): void {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO categories (id, user_id, parent_id, slug, name, hint, keywords, sort)
    VALUES (?,?,NULL,?,?,?,NULL,?)
  `);
  DEFAULT_CATEGORIES.forEach((c, i) => {
    ins.run(`c_${userId.slice(2)}_${c.slug}`, userId, c.slug, c.name, c.hint, i * 10);
  });
}

/** 该用户的分类（按 sort）。没有就返回默认表 —— 读路径不该依赖写入顺序 */
export function listCategories(db: DatabaseSync, userId: string): Category[] {
  const rows = db.prepare(
    'SELECT slug, name, hint FROM categories WHERE user_id = ? ORDER BY sort, slug',
  ).all(userId) as unknown as Category[];
  return rows.length > 0 ? rows : DEFAULT_CATEGORIES;
}

/**
 * 分类 → id 的映射。
 *
 * 分析要写 `entry_analysis.category_id`（外键），而模型给的是 slug。
 * 分开一次查表而不是每篇单独查：20 篇分析就是 20 次多余的查询。
 */
export function categoryIdMap(db: DatabaseSync, userId: string): Map<string, string> {
  const rows = db.prepare(
    'SELECT id, slug FROM categories WHERE user_id = ?',
  ).all(userId) as { id: string; slug: string }[];
  return new Map(rows.map((r) => [r.slug, r.id]));
}

/** 库里已有的主题标签（供提示词「优先复用」）。按使用频次取前 N */
export function knownTopics(db: DatabaseSync, userId: string, limit = 200): string[] {
  const rows = db.prepare(`
    SELECT a.topics AS topics
      FROM entry_analysis a
      JOIN entries e ON e.id = a.entry_id
     WHERE e.user_id = ? AND a.topics IS NOT NULL
     ORDER BY a.created_at DESC
     LIMIT 1000
  `).all(userId) as { topics: string }[];

  const freq = new Map<string, number>();
  for (const r of rows) {
    let arr: unknown;
    try { arr = JSON.parse(r.topics); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const t of arr) {
      const k = String(t).trim();
      if (k) freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([k]) => k);
}
