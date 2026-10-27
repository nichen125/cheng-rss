// 阅读历史的时间分桶（PLAN §7.4）。
//
// 为什么按"桶"而不是按"天"：一个月的阅读记录按天分能有 30 个标题，
// 滚动条全是日期，等于没有分组。四个桶（今天/昨天/本周/更早）是
// Huntly 与各家阅读器的共同答案 —— 用户真正要区分的是"刚才读的"
// 与"很久以前读的"，不是"10 月 23 日 与 10 月 24 日"。
//
// 为什么"本周"是"最近 7 天"而不是"本自然周"：周一时按自然周算，
// 周日读的东西会掉进"更早"，而它其实才过了一天。滚动窗口更符合直觉。

export type HistoryBucket = 'today' | 'yesterday' | 'week' | 'earlier';

/** 桶的顺序即渲染顺序。测试会断言这个字符串。 */
export const HISTORY_BUCKETS: HistoryBucket[] = ['today', 'yesterday', 'week', 'earlier'];

const DAY = 86400_000;

/**
 * 某时刻属于哪个桶。
 *
 * **必须用本地日历日**，不能拿 `(now - at) / DAY` 取整：
 *   · 拿毫秒差算 —— 凌晨 1 点读的、和 23 小时前读的，都会被算成同一天，
 *     而它们其实跨了两个日历日
 *   · 用 UTC 算 —— 东八区凌晨 1 点读的东西（UTC 还是前一天 17 点）
 *     会被算成"昨天"，用户看着昨晚读的文章出现在"昨天"以外的地方
 *
 * 所以这里把两个时间都归零到各自的本地 00:00 再算天数差。
 */
export function bucketOf(at: number, now = Date.now()): HistoryBucket {
  // 非法输入（NaN / 负数 / 0）归入 earlier：历史接口拿到脏数据时
  // 宁可把它排到最后，也不该抛错让整个历史页 500。
  if (!Number.isFinite(at) || at <= 0) return 'earlier';
  if (!Number.isFinite(now) || now <= 0) return 'earlier';

  const a = new Date(at);
  const n = new Date(now);
  // 未来时间（客户端时钟比服务器快）算今天 —— 归 earlier 会让刚读的
  // 文章掉到列表最底部，比"日期算错"更让人困惑。
  const aDay = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const nDay = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();

  const days = Math.round((nDay - aDay) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return 'week';
  return 'earlier';
}

export interface HistoryGroup<T> {
  key: HistoryBucket;
  title: string;
  count: number;
  items: T[];
}

const TITLES: Record<HistoryBucket, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '本周',
  earlier: '更早',
};

/**
 * 把已按时间倒序排好的条目分进四个桶。
 *
 * 输入必须已经有序（SQL 里 ORDER BY 过）—— 这里刻意**不排序**：
 * 分桶函数一旦也负责排序，就会有人以为"传乱序也能对"，而它的
 * 排序键到底用哪个字段（last_read_at 还是 published_at）恰恰是调用方
 * 才知道的事。调用方排序、这里只分组，职责不重叠。
 */
export function groupByDay<T>(
  items: T[],
  getTime: (item: T) => number,
  now = Date.now(),
): HistoryGroup<T>[] {
  const buckets = new Map<HistoryBucket, T[]>();
  for (const it of items) {
    const k = bucketOf(getTime(it), now);
    const arr = buckets.get(k);
    if (arr) arr.push(it);
    else buckets.set(k, [it]);
  }
  // 只输出有内容的桶：渲染 4 个空分组会让用户以为加载失败
  return HISTORY_BUCKETS
    .filter((k) => buckets.has(k))
    .map((k) => {
      const arr = buckets.get(k) as T[];
      return { key: k, title: TITLES[k], count: arr.length, items: arr };
    });
}
