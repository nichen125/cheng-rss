// 纯展示工具：不依赖组件状态、不读组件内闭包。
//
// 从 App.tsx 原样搬出来（拆分 App，逻辑一行未改）：它们原本只有展示
// 组件在用，留在 3000 行的文件里既看不见也测不着。

export function tierLabel(tier: string): string {
  // normal 也要有中文：漏掉它会直接显示英文 "normal"，
  // 而 .ai-label 带 text-transform: uppercase，屏幕上就是 "NORMAL"。
  return ({ must_read: '必读', worth: '值得', normal: '一般', noise: '噪音' } as Record<string, string>)[tier] ?? tier;
}

export function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}

/** 日号栏的标记：日号、星期，以及这是否当月的第一行 */
export interface DayMark {
  /** 当日两位数，如 "02" */
  day: string;
  /** 星期，如 "周六" */
  week: string;
  /** 这是当月的第一行 —— 上方要多留出月界的位置 */
  monthStart: boolean;
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 给按时间倒序的条目算出日号栏标记（设计方案 §2.2）。
 *
 * 只在"日期变了"的那一行返回标记，其余返回 undefined —— 由调用方
 * 逐项取用。**不改变 items 顺序**：列表的顺序由服务端的游标决定，
 * 这里只读不写。
 *
 * 日期按**本地时区**归一化（不是 UTC）：用户看到的"今天"是他所在时区的
 * 今天。用 UTC 归一化的话，东八区上午 8 点之前的条目会被算到前一天。
 */
export function markDays(times: number[]): (DayMark | undefined)[] {
  const out: (DayMark | undefined)[] = [];
  let lastDay = '';
  let lastMonth = '';
  for (const ms of times) {
    const d = new Date(ms);
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
    if (dayKey === lastDay) { out.push(undefined); continue; }
    const monthStart = monthKey !== lastMonth;
    lastDay = dayKey;
    lastMonth = monthKey;
    out.push({
      day: String(d.getDate()).padStart(2, '0'),
      week: WEEK[d.getDay()] ?? '',
      monthStart,
    });
  }
  return out;
}
