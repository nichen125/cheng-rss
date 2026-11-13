// 列表行（§15.24）。
//
// 从 App.tsx 原样搬出来，逻辑与注释未改：它是纯展示组件，只吃 props
// 与 lib/format.ts 里的纯函数，搬出去之后列表页与拆分都少读 100 行。

import type { EntrySummary, HistoryEntry } from '../api.ts';
import { IconExternal, IconStar } from '../icons.tsx';
import { hostOf, timeAgo, tierLabel, type DayMark } from '../lib/format.ts';

/**
 * 一行的渲染（§15.24 顺手抽出来，v1.18）。
 *
 * 抽出来的唯一理由是**分割线要求同一行在两处长得一样**：主列表（未读）和
 * 尾段（已读）用的是同一个组件，所以不存在"分割线上下行距差 2px"这种
 * 只有肉眼能发现的问题。历史视图也用同一份 `meta` 插槽换掉时间语义。
 *
 * 行是纯容器，不再挂 `role=button` + `tabIndex`：行内本来就嵌着收藏按钮
 * 和外链，再给整行一个按钮角色，读屏会把一行念成"按钮里套按钮"，星标
 * 反而读不出来。键盘入口收口到标题那个真链接 —— 它才是"打开这篇"的动作。
 * 也不能改成 `<button>`：`<a>` 不能嵌在 `<button>` 里，而"标题可中键/
 * Ctrl+点击在新标签打开"必须是一个真 `<a>`。
 *
 * ── 三种列表密度（v6.6）──────────────────────────────────────
 *
 * 组件**始终渲染全部信息**（元信息 / 标题 / 摘要），显示多少由
 * `<html data-list-style>` 决定：
 *
 *   compact     只显示标题（v6.5 的形态）
 *   standard    标题 + 一行摘要 + 元信息行（默认）
 *   rich        标题 + 两行摘要 + 元信息行 + 更大间隔、更强分节
 *
 * 为什么用 CSS 而不是在这里 `if` 掉：密度是**显示偏好**，不是数据差异。
 * 在组件里按偏好条件渲染，会让"切一下密度"变成一次完整重渲染（列表
 * 30 条会闪一下）；而且 `.entry-site` / `.entry-time` 这些节点时有时无，
 * 验收脚本与读屏都得跟着改。CSS 只改可见性，DOM 恒定。
 *
 * 摘要本来就在数据里（`it.summary || it.excerpt`），不额外请求。
 */
export function EntryRow(props: {
  it: EntrySummary | HistoryEntry;
  active: boolean;
  onOpen: () => void;
  onStar: () => void;
  /** 元信息行里的时间部分。默认是"发布多久以前"，历史页换成"读多久以前" */
  meta?: React.ReactNode;
  /** 日号栏（设计方案 §2.2）：只有当天的第一行带日期，其余为 undefined */
  day?: DayMark;
}) {
  const { it } = props;
  // 历史条目没有 highlightCount（服务端的历史接口不返回它）——历史页按
  // "什么时候读的"组织，不显示高亮数。用 `in` 收窄而不是给 HistoryEntry
  // 加一个恒为 0 的字段：后者会让类型说谎。
  const highlights = 'highlightCount' in it ? it.highlightCount : 0;
  const summary = it.summary || it.excerpt || '';
  return (
    <li>
      {/* 纯展示容器：onClick 只是鼠标便利（点标题、点空白仍然打开），
          不再声明 role/tabIndex —— 一行里已经有真按钮和真链接，再给整行
          一个按钮角色就是交互元素嵌套。 */}
      <div
        className={`entry-item ${it.isRead ? 'read' : ''} ${props.active ? 'active' : ''}`}
        data-tier={it.tier ?? 'normal'}
        onClick={props.onOpen}
      >
        {props.day && (
          <span
            className="day-mark"
            data-month-start={props.day.monthStart ? '' : undefined}
            /* 月份走 CSS 的 attr()：只在换月那一行有值，其余行把属性
               一起省掉 —— 用 CSS 变量或额外元素都会让没换月的行也占位。 */
            data-month={props.day.monthStart ? props.day.month : undefined}
            title={props.day.monthStart ? `${props.day.month}${props.day.day}日` : undefined}
          >
            <b>{props.day.day}</b>
            <i>{props.day.week}</i>
          </span>
        )}
        {/* 元信息行：站名 · 时间 · 分级。compact 下由 CSS 收成 1px 裁剪容器
            （仍在 DOM 里：读屏要念、历史视图 meta 插槽要用、脚本要取）。 */}
        <div className="entry-meta">
          <span className="entry-site">{it.siteName ?? hostOf(it.url)}</span>
          <span className="dot">·</span>
          {props.meta ?? <span className="entry-time">{timeAgo(it.publishedAt)}</span>}
          {it.tier && it.tier !== 'normal' && (
            <span className={`tier tier-${it.tier}`}>{tierLabel(it.tier)}</span>
          )}
          {highlights > 0 && <span className="meta">{highlights} 高亮</span>}
        </div>
        {/* 标题是这行唯一合理的键盘入口：整行不再是可聚焦按钮之后，读屏和
            Tab 都只停在标题这个真链接上，Enter 必须仍然打开这一条。

            所以这里显式接住 Enter（并 stopPropagation）：全局快捷键里还有
            一条「Enter 打开一条」，它只认 items[0]，焦点在第 3 行时会开错
            条目，而且它 preventDefault 会掐掉链接自己的原生激活。先接住就
            只开一次、开对一条。

            click 仍要 stopPropagation：行本身也有 onClick，不拦就会调用两次
            open()（第一次标已读减角标，第二次拿到"已读过"再减一次 —— 实测
            2 → 0）。中键与 Ctrl/Shift+点击不拦，交给浏览器开新标签。 */}
        <a
          className="entry-title"
          href={it.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
              e.preventDefault();
              e.stopPropagation();
              props.onOpen();
            }
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
            e.preventDefault();
            e.stopPropagation();
            props.onOpen();
          }}
        >
          {it.title}
        </a>
        {/* 摘要：compact 下 display:none，standard 一行，rich 两行。
            没有摘要的条目（历史条目通常没有）整段不渲染 —— 空 <p> 会
            在 standard/rich 里留下一截空白。 */}
        {summary && <p className="entry-summary">{summary}</p>}
        {/* hover 才出现：收藏 / 新标签打开原文。
            常驻会让每行多两个图标的视觉噪声，而列表页的任务是"扫过去"（§15.2）。

            收藏状态**只由这颗星表达**（`filled` 就是它的状态）。
            v1.9 之前这里还额外渲染了一个 `star-mark` 装饰星，
            结果是"点完收藏出现两颗星"（§15.14）。同一个信息
            说两遍不是冗余，是让人怀疑自己点错了。 */}
        <span className="entry-ops">
          <button
            type="button"
            className={`icon-btn tiny ${it.isStarred ? 'on' : ''}`}
            title={it.isStarred ? '取消收藏' : '收藏'}
            aria-pressed={it.isStarred}
            onClick={(e) => { e.stopPropagation(); props.onStar(); }}
          >
            <IconStar size={13} filled={it.isStarred} />
          </button>
          <a
            className="icon-btn tiny"
            href={it.url}
            target="_blank"
            rel="noopener noreferrer"
            title="在新标签打开原文"
            onClick={(e) => e.stopPropagation()}
          >
            <IconExternal size={13} />
          </a>
        </span>
      </div>
    </li>
  );
}
