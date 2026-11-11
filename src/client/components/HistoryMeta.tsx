// 历史视图的行元信息（§7.4）。
//
// 从 App.tsx 原样搬出来：它和 EntryRow 是一组（EntryRow 的 meta 插槽），
// 拆开放在两个文件里反而不好找。

import type { HistoryEntry } from '../api.ts';
import { timeAgo } from '../lib/format.ts';

/** 历史视图的元信息：读的时间在前，发布时间降级为 title（§7.4） */
export function HistoryMeta(props: { it: HistoryEntry }) {
  const it = props.it;
  return (
    <>
      <span className="entry-time" title={`发布于 ${timeAgo(it.publishedAt)}`}>
        {timeAgo(it.readAt)}
      </span>
      {/* 读过多次：回看过的文章值得一个角标，它说明
          "这篇我后来又翻过一次"，是收藏之外的另一个信号 */}
      {it.readCount > 1 && (
        <span className="meta read-count" title={`读过 ${it.readCount} 次`}>
          ×{it.readCount}
        </span>
      )}
      {it.readProgress !== null && it.readProgress > 0 && it.readProgress < 0.95 && (
        <span className="meta read-progress" title={`读到 ${Math.round(it.readProgress * 100)}%`}>
          {Math.round(it.readProgress * 100)}%
        </span>
      )}
    </>
  );
}
