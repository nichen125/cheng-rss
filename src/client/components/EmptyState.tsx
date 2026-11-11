// 列表空态（§15.20 / §15.24）。
//
// 从 App.tsx 原样搬出来，分支顺序与文案未改：这里的顺序本身就是语义
// （「真空范围」排在「未读清零」前面），搬的时候一个字都不能动。

import { IconCircle, IconClock, IconFolder, IconInbox, IconSearch, IconStar } from '../icons.tsx';
import type { View } from '../lib/view.ts';

export function EmptyState(props: {
  hasQuery: boolean;
  view: View;
  /** 当前是否在按分组/源筛选；有值时空态文案要说明"是这个范围里没有" */
  scopeLabel?: string | null;
  /** 库里到底有没有订阅源。没有源时的空态是"去添加"，不是"看全部" */
  hasFeeds?: boolean;
  /**
   * 当前范围里有没有条目（不区分读没读过）。
   *
   * v1.18 之前不需要这个输入：0 未读会被自动切到「全部」，于是"真空范围"
   * 自然落到「还没有条目」那一档。现在分段控件恒为「未读」，空态必须自己
   * 区分"都读过了"和"一条都没有"—— 两者下一步动作不同（看读过的 vs
   * 去添加/离开）。判据见主组件里的 `scopeHasEntries`。
   */
  scopeHasEntries?: boolean;
  onGoFeeds?: () => void;
  /** 清掉分组与源筛选（回到全库） */
  onClearScope?: () => void;
  /**
   * 看**当前范围**的全部（保留分组/源，只把「未读」切成「全部」）。
   *
   * 与 onClearScope 是两个不同的动作，v1.17 之前只有一个按钮包办了
   * 前者：在某个源里读完了最后一条，空态上写着「看全部条目」，点下去
   * 却跳到了全库 —— 用户想看的是"这个源里都读过什么"。见 §15.20。
   */
  onShowAll?: () => void;
}) {
  if (props.hasQuery) {
    return (
      <div className="empty">
        <div className="ph-art"><IconSearch size={26} /></div>
        <h2>没有匹配的条目</h2>
        <p>试试更短的关键词，或换个词。</p>
      </div>
    );
  }
  if (props.view === 'starred') {
    return (
      <div className="empty">
        <div className="ph-art"><IconStar size={26} /></div>
        <h2>还没有收藏</h2>
        <p>阅读时点右上角的星标，重要的文章会留在这里。</p>
      </div>
    );
  }
  if (props.view === 'history') {
    return (
      <div className="empty">
        <div className="ph-art"><IconClock size={26} /></div>
        <h2>还没有阅读记录</h2>
        <p>读过的文章会按时间出现在这里。</p>
      </div>
    );
  }

  // 「真空范围」排在「未读清零」**前面**（§15.24，v1.18 调整）。
  //
  // 顺序在这里是有语义的：v1.17 按 view 分档，"0 未读"一律说成「未读已经
  // 清零」。那在自动切「全部」的年代成立 —— 真空范围根本走不到未读空态。
  // v1.18 取消自动切换之后，一个刚添加、还没抓到的源也会停在「未读」，
  // 于是它会被告知"这个范围里的文章都读过了"，而它一条都没有。
  //
  // 判据是 `scopeHasEntries`（已读尾段的 total），不是 items.length ——
  // items 此刻一定是空的（未读为 0 才进空态），用它判断恒为"没有条目"。
  if (props.scopeLabel && props.scopeHasEntries === false) {
    return (
      <div className="empty">
        <div className="ph-art"><IconFolder size={26} /></div>
        <h2>「{props.scopeLabel}」里还没有条目</h2>
        <p>
          这个范围下的源暂时没有新内容，或者刚添加还没抓到。
        </p>
        <div className="empty-actions">
          {props.onClearScope && (
            <button className="btn" onClick={props.onClearScope}>看全库条目</button>
          )}
          {props.onGoFeeds && (
            <button className="btn" onClick={props.onGoFeeds}>管理订阅</button>
          )}
        </div>
      </div>
    );
  }

  // 「未读」清零 ≠ 收件箱里什么都没有（§15.20，v1.17）。
  //
  // 改之前这里落到最后一个 return，文案是「收件箱是空的 / 还没有订阅任何源」——
  // 一个已经把 300 篇都读完的用户会被告知"你还没有订阅"，而他明明有 12 个源。
  // 空态必须区分"这个范围没有未读"和"这个范围没有条目"，因为下一步动作不同：
  // 前者是"去看读过的"，后者才是"去添加订阅"。
  //
  // 库里真的一条源都没有时不能走这里：新装用户要的是「去添加订阅」。
  if (props.view === 'unread' && props.hasFeeds !== false) {
    return (
      <div className="empty">
        <div className="ph-art"><IconCircle size={26} /></div>
        <h2>{props.scopeLabel ? `「${props.scopeLabel}」里没有未读` : '未读已经清零'}</h2>
        <p>
          {props.scopeLabel
            ? '这个范围里的文章都读过了，或者刚添加还没抓到。'
            : '所有订阅里的文章都读过了。新的内容会自动出现在这里。'}
        </p>
        <div className="empty-actions">
          {props.onShowAll && (
            <button
              className="btn"
              onClick={props.onShowAll}
              title="只切换读/全部，不改当前的分组与源筛选"
            >
              看全部
            </button>
          )}
          {props.onGoFeeds && (
            <button className="btn" onClick={props.onGoFeeds}>管理订阅</button>
          )}
        </div>
      </div>
    );
  }

  // 分组内为空 ≠ 没有订阅。这两种情况的引导动作完全不同：
  // 前者应该"看全部"，后者应该"去添加订阅"。
  // 走到这里只剩最后一种：库里有源，但全库一条条目都没有。
  // 原来的「分组内为空」分支已经被上面的真空范围档接走了 —— 有 scopeLabel
  // 就一定进那一档（scopeHasEntries 在空列表时必为 false），留着会是一段
  // 永远执行不到的代码。
  return (
    <div className="empty">
      <div className="ph-art"><IconInbox size={26} /></div>
      <h2>收件箱是空的</h2>
      <p>还没有订阅任何源。添加一个 RSS 源后，新文章会自动出现在这里。</p>
      {props.onGoFeeds && (
        <div className="empty-actions">
          <button className="btn primary" onClick={props.onGoFeeds}>去添加订阅</button>
        </div>
      )}
    </div>
  );
}
