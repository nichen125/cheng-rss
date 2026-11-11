// 主界面 = 三栏（PLAN §15.1/§15.2/§15.3）
//
//   侧栏（导航 + 筛选）│ 列表（扫描）│ 阅读区（内容优先）
//
// 三栏而非两栏的理由：点开一条时列表不能消失——阅读时反复回看列表
// 挑下一篇是 RSS 阅读器最常见的动作，跳页式导航会把它变成两次点击。
//
// M0 的数据能力只有「条目读取 + 已读/收藏」，所以导航里除收件箱外的
// 入口都标了"待接入"，不让用户点了没反应。

import { IconCircle, IconClock, IconInbox, IconSparkle, IconStar } from '../icons.tsx';
import type { View } from './view.ts';

export interface NavItem {
  key: View;
  label: string;
  icon: React.ReactNode;
  /** 角标取哪个计数 */
  count?: 'unread' | 'starred';
}

/** 默认视图。单独抽出来，避免 NAV[0] 在 noUncheckedIndexedAccess 下是 undefined */
export const INBOX_NAV: NavItem = {
  key: 'inbox', label: '收件箱', icon: <IconInbox />, count: 'unread',
};

/**
 * 打开应用时的视图（§15.19，v1.16）。
 *
 * 从 'inbox' 改成 'unread'：用户打开应用最常见的目的是看新内容，
 * 而不是"再读一遍读过的"。默认值等于最常见的那次操作 —— 否则每次
 * 都要先手动筛掉已读。
 *
 * 抽成常量而不是在 useState 里写字面量：这个值在 `pickFolder` /
 * `pickFeed` 里也要用（切分组时不能把「未读」悄悄改成「全部」），
 * 写两处迟早会不一致。
 */
export const DEFAULT_VIEW: View = 'unread';

/**
 * 分割线下面先补多少条已读（§15.24，v1.18）。
 *
 * 与主列表的 30 不同，这里用 40：分割线之后的内容是"上下去看"，用户
 * 通常在翻两下之内就决定要不要继续；40 条足够覆盖一个中等源的全部存量
 * （独库实测：21 个源里 17 个源的存量都不到 40 条），一次就把界面上
 * "看完了"的错觉消掉，不用先看到一条分割线再点加载更多。
 */
export const READ_TAIL_LIMIT = 40;

export const NAV: NavItem[] = [
  INBOX_NAV,
  { key: 'unread', label: '未读', icon: <IconCircle />, count: 'unread' },
  { key: 'starred', label: '已收藏', icon: <IconStar />, count: 'starred' },
  { key: 'history', label: '历史', icon: <IconClock /> },
  // 简报（§15.4 / 3.5）。它是一等入口而不是"即将支持"：
  // 每天生成的简报如果只能在设置页里看到，等于没做。
  { key: 'digest', label: '简报', icon: <IconSparkle /> },
];

/**
 * 未接入的导航项。
 *
 * 现在是**空的** —— M0~M4 的需求项已全部落地。保留这个数组而不是删掉
 * 整块渲染逻辑：M5（检索）与 M6（备份）会再来加，而"待接入"这个标签
 * 本身是有价值的（点了没反应 vs 明确标注未实现，后者更诚实）。
 */
export const SOON: { label: string; icon: React.ReactNode }[] = [];

/**
 * 条目的额外过滤（与 view 正交）。
 *
 * 为什么不把「某分组」做成新的 View 值：分组数量是用户数据，
 * View 是代码常量。混在一起会让 View 的类型退化成 string，
 * 也就失去了 switch 的穷尽性检查。
 */
export interface Scope {
  feedId?: string;
  folderId?: string;
}
