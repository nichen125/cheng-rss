import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api, type HighlightItem, type HighlightColor } from '../api.ts';
import {
  buildTextMap, rangeToOffsets, wrapRange, unwrapHighlights, type TextMap,
} from './text-map.ts';

// 划词高亮（PLAN §11.3，M4）。
//
// 交互的全部难点在"什么时候该出工具条、什么时候该收起"：
//   · 划完松手 → 出
//   · 点工具条 → 不能因为选区消失而收起（点击本身会让 selection 变化）
//   · 点到正文别处 → 收
//   · 滚动 → 跟着动（工具条定位是相对正文容器的坐标）
//
// 还有一个不做就会踩的坑：正文是 dangerouslySetInnerHTML 渲染的，
// 每次 detail 变化都会**重建 DOM**，所以已经包好的 <mark> 会消失。
// 因此渲染高亮必须跟着 contentHtml 一起重跑，而不是"创建时包一次"。

export interface SelectionState {
  /** 选区在纯文本里的区间 */
  start: number;
  end: number;
  /** 选中的原文 */
  exact: string;
  /** 工具条应出现的位置（相对 .article-body 的 left/top） */
  x: number;
  y: number;
}

export function useHighlights(
  entryId: string | null,
  contentHtml: string | null,
  /** 正文容器的 ref 由调用方持有（阅读区已经有一个 bodyRef，不要再造一个） */
  externalRootRef?: RefObject<HTMLDivElement | null>,
) {
  const [items, setItems] = useState<HighlightItem[]>([]);
  const [sel, setSel] = useState<SelectionState | null>(null);
  const [err, setErr] = useState('');
  const mapRef = useRef<TextMap | null>(null);
  const ownRef = useRef<HTMLDivElement | null>(null);
  const rootRef = externalRootRef ?? ownRef;

  // ── 读列表 ────────────────────────────────────────────────
  const reload = useCallback(async () => {
    if (!entryId) { setItems([]); return; }
    try {
      const r = await api.listHighlights(entryId);
      setItems(r.items);
    } catch {
      // 列表读不出来不该打断阅读 —— 只是这段不显示背景色
      setItems([]);
    }
  }, [entryId]);

  useEffect(() => { void reload(); }, [reload]);

  // ── 渲染已有高亮 ──────────────────────────────────────────
  //
  // 依赖 contentHtml：DOM 重建后 mapRef 与 <mark> 全部失效，必须重算重画。
  // 只依赖 entryId 的话，重新提取正文（同一篇）后高亮就静默消失了。
  //
  // 每一轮都必须**先拆掉上一轮的 <mark> 再重画**。不拆的话有两个后果：
  //   · 改颜色时 mark 会被再包一层，外层 class 还是旧颜色 —— 看起来"改色没生效"
  //   · 文本节点被切成碎片，buildTextMap 算出的偏移与上一轮不再对应
  // 这两个后果都不会报错，只是画面不对。
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !contentHtml) { mapRef.current = null; return; }

    unwrapHighlights(root);

    const map = buildTextMap(root);
    mapRef.current = map;

    for (const h of items) {
      if (h.isOrphaned || h.posStart === null || h.posEnd === null) continue;
      wrapRange(map, h.posStart, h.posEnd, h.id, h.color ?? 'yellow');
    }
  }, [contentHtml, items]);

  // ── 选区变化 ──────────────────────────────────────────────
  //
  // 用**声明式事件**（div 的 onMouseUp）而不是 useEffect 里 addEventListener。
  //
  // 这不是风格偏好，是踩过的坑：addEventListener 版本在真实浏览器里
  // 一个监听都没挂上（DOMDebugger.getEventListeners 返回空），表现是
  // "划词没反应"，而 page 上一切正常、没有任何报错。原因是那层 effect
  // 依赖 ref 在某个渲染时序上为 null，直接 early return，之后再没有机会
  // 重挂 —— 而这种失败是**静默**的。
  //
  // 声明式事件由 React 在每个渲染里保证绑定，不存在"某次渲染漏了"。
  // 代价只是把 onUp 从闭包里挪出来变成返回值。
  const onSelectionEnd = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;

    const s = window.getSelection();
    if (!s || s.isCollapsed || s.rangeCount === 0) { setSel(null); return; }
    const range = s.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) { setSel(null); return; }

    const map = mapRef.current;
    if (!map) { setSel(null); return; }

    const off = rangeToOffsets(map, range);
    if (!off) { setSel(null); return; }
    // 太短的选区不弹工具条：单击一下会选到 1~2 个字符，弹出来反而碍事
    if (off.exact.trim().length < 2) { setSel(null); return; }

    const rect = range.getBoundingClientRect();
    const base = root.getBoundingClientRect();
    setSel({
      ...off,
      x: rect.left - base.left + rect.width / 2,
      y: rect.top - base.top - 8,
    });
  }, [rootRef]);

  // 点正文别处时收起工具条。用 mousedown 而不是 click：click 在工具条
  // 自己身上也会触发，会给"点工具条"带来一次多余的开关。
  useEffect(() => {
    if (!sel) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.hl-toolbar')) return;   // 点在工具条上：不收起
      setSel(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [sel]);

  // ── 写操作 ────────────────────────────────────────────────
  const create = useCallback(async (color: HighlightColor, note?: string) => {
    if (!entryId || !sel) return;
    setErr('');
    try {
      const h = await api.createHighlight({
        entryId, start: sel.start, end: sel.end, quote: sel.exact, color, note,
      });
      setItems((xs) => [...xs, h]);
      setSel(null);
      window.getSelection()?.removeAllRanges();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '高亮失败');
    }
  }, [entryId, sel]);

  const annotate = useCallback(async (note: string) => {
    if (!entryId || !sel) return;
    setErr('');
    try {
      const h = await api.createHighlight({
        entryId, start: sel.start, end: sel.end, quote: sel.exact, note,
      });
      setItems((xs) => [...xs, h]);
      setSel(null);
      window.getSelection()?.removeAllRanges();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '批注失败');
    }
  }, [entryId, sel]);

  const recolor = useCallback(async (id: string, color: HighlightColor) => {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, color } : x)));
    try { await api.patchHighlight(id, { color }); } catch { void reload(); }
  }, [reload]);

  const updateNote = useCallback(async (id: string, note: string) => {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, note: note || null } : x)));
    try { await api.patchHighlight(id, { note }); } catch { void reload(); }
  }, [reload]);

  const remove = useCallback(async (id: string) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    try { await api.deleteHighlight(id); } catch { void reload(); }
  }, [reload]);

  /** 正在解读哪一条；null = 空闲 */
  const [insightBusy, setInsightBusy] = useState<string | null>(null);

  /**
   * 请求单条 AI 解读（§11.4）。
   *
   * 失败时只设置 err，不清空已有的 aiInsight —— 用户重算时如果失败，
   * 上一次的解读还在，比整块消失要好。
   */
  const insight = useCallback(async (id: string) => {
    setErr('');
    setInsightBusy(id);
    try {
      const r = await api.highlightInsight(id);
      if (r.ok && r.insight) {
        setItems((xs) => xs.map((x) => (x.id === id ? { ...x, aiInsight: r.insight } : x)));
      } else {
        // 没配 key 不该显示成红色错误，它是个提示
        setErr(r.message || 'AI 解读失败');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'AI 解读失败');
    } finally {
      setInsightBusy(null);
    }
  }, []);

  /** 滚动到某条高亮。orphaned 的没有位置，滚不动 */
  const scrollTo = useCallback((id: string) => {
    const el = rootRef.current?.querySelector(`[data-highlight-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  return {
    items, sel, err, rootRef, setErr, onSelectionEnd, insight, insightBusy,
    create, annotate, recolor, updateNote, remove, scrollTo, reload,
  };
}
