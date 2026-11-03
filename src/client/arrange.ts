// 侧栏排列（PLAN §15.28）的几何与顺序计算。
//
// 为什么把这些抽出来而不是全写在 App.tsx 里：这里的每个函数都是纯函数
// （输入 DOM 矩形 / 数组 + 指针坐标，输出"该怎么排"），可以脱离浏览器
// 单独推。而"我松手之后顺序到底变成什么样"正是这个功能最容易错、
// 也最难靠肉眼确认的地方。
import type { FeedItem, FolderItem } from './api.ts';

/** 长按判定时长。低于 400ms 会和"点一下选中"抢手势，点得稍慢就误进模式 */
export const LONG_PRESS_MS = 500;
/** 按住期间允许的抖动。超过它就认为用户是在滚动或拖选，不是长按 */
export const MOVE_TOLERANCE = 8;

export type ArrangeKind = 'folder' | 'feed' | 'loose';

/** 一行在排列模式里的身份。`folderId` 只对 feed 有意义（loose 恒为 null） */
export interface ArrangeRow {
  key: string;
  kind: ArrangeKind;
  id: string;
  folderId: string | null;
  label: string;
}

export const rowKey = (kind: ArrangeKind, id: string): string => `${kind}:${id}`;

/**
 * 落点。
 *
 * `into` 与 `line` 是两种不同的语义，不能合并：
 *   · `into`  = 把这个源放进这一组（改变归属）
 *   · `line`  = 插到这一行的前面/后面（只改顺序）
 * 合并成一种的话，"拖到分组行上"到底是放进组里还是插到组这一行旁边
 * 就说不清了，而这两种结果在界面上差别很大。
 */
export type DropTarget =
  | { kind: 'line'; key: string; pos: 'before' | 'after' }
  | { kind: 'into'; folderId: string | null };

/** 拖动中的行要渲染成浮起卡片，需要一个位置 */
export interface DragState {
  row: ArrangeRow;
  /** 指针在视口里的位置，用于放置浮起卡片 */
  x: number;
  y: number;
  /** 卡片相对指针的偏移，让指针落在卡片上的同一处，不会"跳一下" */
  grabX: number;
  grabY: number;
  /** 当前落点，null = 松手就取消 */
  target: DropTarget | null;
}

/** 把 `from` 位置的元素移到 `to` 位置。越界时夹取，不抛错 */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= arr.length) return arr.slice();
  const dst = Math.max(0, Math.min(arr.length - 1, to));
  const out = arr.slice();
  const [item] = out.splice(from, 1);
  out.splice(dst, 0, item as T);
  return out;
}

/**
 * 源在**同一组内**的显示顺序。侧栏与配置页共用这一份，两处给不出不同顺序。
 *
 * 三个键，缺一不可（SQL 侧同序，见 store.ts 的 ORDER BY）：
 *   1. 失效源排最后（§15.23）
 *   2. `sort`（用户排的）
 *   3. 标题，`zh-CN` 拼音序；**空标题也排最后**
 *
 * 第 1、3 条不是可选的：迁移后老数据的 `sort` 全是 0，第 2 个键完全并列，
 * 顺序就由第 1、3 个键决定 —— 少了第 1 条，一个刚被判失效的源会跑到组内第一个；
 * 少了第 3 条，刚订阅还没抓到标题的源（title 为 null）也会跑到最前，
 * 因为把 null 转成 `''` 比任何中文都小。
 *
 * 这两个坑都不报错，只是清单看着不对；而且它们只在 `sort` 并列时出现，
 * 数据一旦被用户排过就再也复现不了 —— 属于"上线一个月后才有人来报"的那类。
 */
function compareFeedInGroup(a: FeedItem, b: FeedItem): number {
  const aBroken = a.status === 'broken' ? 1 : 0;
  const bBroken = b.status === 'broken' ? 1 : 0;
  if (aBroken !== bBroken) return aBroken - bBroken;

  if (a.sort !== b.sort) return a.sort - b.sort;

  // 空标题排最后。用 flag 而不是 `title ?? url`：url 是 f 开头的英文，
  // 比中文小，会把它排到最前 —— 那是"看起来随机"的另一种写法
  const aNull = a.title ? 0 : 1;
  const bNull = b.title ? 0 : 1;
  if (aNull !== bNull) return aNull - bNull;

  return (a.title ?? '').localeCompare(b.title ?? '', 'zh-CN');
}

/** 某个组内的源，按当前显示顺序 */
export function feedsOfFolder(feeds: readonly FeedItem[], folderId: string): FeedItem[] {
  return feeds.filter((f) => f.folderId === folderId).slice().sort(compareFeedInGroup);
}

/**
 * 未分组源的显示顺序（§15.26、§15.28）。
 *
 * 与组内源**同一套比较器** —— 这是这一版修掉的一个真 bug：原来这里只按
 * 标题拼音排，于是「失效源排最后」在未分组块里不成立，空标题源也会跑到最前。
 * 同一个列表里规则不一致，比规则不好更糟。
 */
export function looseFeedsOf(feeds: readonly FeedItem[]): FeedItem[] {
  return feeds.filter((f) => !f.folderId).slice().sort(compareFeedInGroup);
}

/**
 * 从指针位置找落点。
 *
 * 用 `elementsFromPoint` 而不是自己遍历所有行算距离：前者拿到的就是
 * **指针下面真正看到的东西**，浮起卡片、toast 之类的遮挡自然被算进去。
 * 自己算距离的话，浮起卡片盖住的那几行仍会被判定为"最近"，
 * 于是落点会在指针还没离开原位置时就开始乱跳。
 */
export function findDropTarget(
  x: number,
  y: number,
  dragging: ArrangeRow,
): DropTarget | null {
  const els = document.elementsFromPoint(x, y)
    .filter((e): e is HTMLElement => e instanceof HTMLElement)
    .map((e) => e.closest('[data-arrange-kind]') as HTMLElement | null)
    .filter((e): e is HTMLElement => !!e);

  if (els.length === 0) return null;
  const el = els[0]!;
  const kind = el.dataset.arrangeKind as ArrangeKind;
  const id = el.dataset.arrangeId!;
  // 落到了自己身上：不产生任何提示。否则浮起的那一刻指针一定在自己
  // 原来的位置，会立刻画出一条"可以放这里"的线，看起来像已经生效了
  if (kind === dragging.kind && id === dragging.id) return null;

  const rect = el.getBoundingClientRect();

  if (dragging.kind === 'folder') {
    // 分组只和分组排。拖到源行上没有意义 —— 分组不能放进分组（§15.28 非目标）
    if (kind !== 'folder') return null;
    return { kind: 'line', key: rowKey(kind, id), pos: y < rect.top + rect.height / 2 ? 'before' : 'after' };
  }

  // 源：拖到分组行上 = 放进这一组
  if (kind === 'folder') return { kind: 'into', folderId: id };

  // 源拖到另一个源上：同组画线，跨组变成"放进对方所在的组"
  const targetFolder = kind === 'loose' ? null : (el.dataset.arrangeFolder ?? null);
  if (targetFolder !== dragging.folderId) return { kind: 'into', folderId: targetFolder };
  return { kind: 'line', key: rowKey(kind, id), pos: y < rect.top + rect.height / 2 ? 'before' : 'after' };
}

/**
 * 落点 → 新的 id 顺序。
 *
 * `siblings` 是目标组当前的显示顺序（含被拖动的那个）。返回 null 表示
 * "这一步什么都不会改"，调用方据此跳过请求 —— 松手在原位不该发一次
 * 空请求再弹一条"已移动"。
 */
export function orderAfterDrop(
  siblings: readonly string[],
  draggingId: string,
  target: DropTarget | null,
): string[] | null {
  if (!target || target.kind !== 'line') return null;
  const toKey = target.key.split(':')[1] ?? '';
  const toIndex = siblings.indexOf(toKey);
  const fromIndex = siblings.indexOf(draggingId);
  if (toIndex < 0 || fromIndex < 0) return null;
  // 插到目标"之后"时，若被拖动的在目标前面，目标索引会因为移除而前移一格
  let dst = toIndex + (target.pos === 'after' ? 1 : 0);
  if (fromIndex < dst) dst -= 1;
  if (dst === fromIndex) return null;
  return moveItem(siblings, fromIndex, dst);
}

/** 分组列表按落点算出新顺序 */
export function foldersAfterDrop(
  folders: readonly FolderItem[],
  draggingId: string,
  target: DropTarget | null,
): string[] | null {
  if (!target || target.kind !== 'line') return null;
  return orderAfterDrop(folders.map((f) => f.id), draggingId, target);
}
