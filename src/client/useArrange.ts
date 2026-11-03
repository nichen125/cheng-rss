// 长按 + 拖拽的指针状态机（PLAN §15.28）。
//
// 抽成 hook 而不是塞进 App.tsx：它要管三层东西 —— 一个会互相取消的
// 定时器、一组全局 pointer 监听、以及"这次松手到底是点击还是落位"。
// 混在渲染代码里时，这些分支很难看清，而它们的错法都是"偶尔才复现"。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LONG_PRESS_MS, MOVE_TOLERANCE, findDropTarget,
  type ArrangeRow, type DragState, type DropTarget,
} from './arrange.ts';

export interface ArrangeApi {
  /** 是否处于排列模式。排列模式下点击行不再选中范围 */
  arranging: boolean;
  setArranging: (v: boolean) => void;
  /** 正在拖的行（含浮起卡片的位置），null = 没在拖 */
  drag: DragState | null;
  /** 当前落点，供渲染落点线与高亮 */
  target: DropTarget | null;
  /** 松手时回调：把这次落位的意图交给业务层 */
  onDrop: (
    row: ArrangeRow,
    target: DropTarget | null,
  ) => void;
  /** 传给每一行的 onPointerDown */
  press: (row: ArrangeRow, e: React.PointerEvent<HTMLElement>) => void;
}

/**
 * @param opts.inArrange    当前是否已在排列模式
 * @param opts.enterArrange 长按触发时进入排列模式
 * @param opts.onDrop       落位回调
 */
export function useArrange(opts: {
  inArrange: boolean;
  enterArrange: () => void;
  onDrop: (row: ArrangeRow, target: DropTarget | null) => void;
}): ArrangeApi {
  const { inArrange, enterArrange, onDrop } = opts;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);

  // 定时器与指针起点放 ref：它们每秒要改几十次，进 state 会让整棵树重渲染
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number; row: ArrangeRow } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  // 最近一次落点用 ref 存一份：pointerup 里读 state 会拿到闭包里的旧值
  const targetRef = useRef<DropTarget | null>(null);
  targetRef.current = target;
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  const enterRef = useRef(enterArrange);
  enterRef.current = enterArrange;

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  /** 进入拖动：把这一行抬起来 */
  const lift = useCallback((row: ArrangeRow, clientX: number, clientY: number) => {
    const el = document.querySelector<HTMLElement>(
      `[data-arrange-kind="${row.kind}"][data-arrange-id="${CSS.escape(row.id)}"]`,
    );
    const r = el?.getBoundingClientRect();
    const next: DragState = {
      row,
      x: clientX,
      y: clientY,
      // 抓取点相对行左上角的偏移：浮起卡片保持"指针还在原来按的那个位置"，
      // 否则卡片会以指针为中心弹出来，视觉上跳一下
      grabX: r ? clientX - r.left : 12,
      grabY: r ? clientY - r.top : 12,
      target: null,
    };
    dragRef.current = next;
    setDrag(next);
  }, []);

  const press = useCallback((row: ArrangeRow, e: React.PointerEvent<HTMLElement>) => {
    // 只认左键。右键和触控笔的"笔杆按钮"不该进排列模式
    if (e.button !== 0) return;
    // 排列模式里已经是"可拖"的语境，按下即可拖，不再等 500ms
    if (inArrange) {
      startRef.current = { x: e.clientX, y: e.clientY, row };
      lift(row, e.clientX, e.clientY);
      return;
    }

    startRef.current = { x: e.clientX, y: e.clientY, row };
    clearTimer();
    const { clientX, clientY } = e;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // 到点了：进模式 + 抬起这一行 + 一次轻微触觉反馈（手机上才有）
      navigator.vibrate?.(10);
      enterRef.current();
      lift(row, clientX, clientY);
    }, LONG_PRESS_MS);
  }, [inArrange, lift]);

  useEffect(() => {
    if (!drag) return;

    const onMove = (e: PointerEvent) => {
      const start = startRef.current;
      // 还没到长按时长就被判定为"在移动"：取消长按，但**不**开始拖动 ——
      // 用户是在滚动或拖选，不是想排序
      if (start && !dragRef.current) {
        if (Math.abs(e.clientX - start.x) > MOVE_TOLERANCE
          || Math.abs(e.clientY - start.y) > MOVE_TOLERANCE) {
          clearTimer();
          startRef.current = null;
        }
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      const t = findDropTarget(e.clientX, e.clientY, d.row);
      const next = { ...d, x: e.clientX, y: e.clientY, target: t };
      dragRef.current = next;
      setDrag(next);
      setTarget(t);
    };

    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      const t = targetRef.current;
      targetRef.current = null;
      setTarget(null);
      startRef.current = null;
      if (d) dropRef.current(d.row, t);
    };

    const onCancel = () => {
      // 指针被系统抢走（来电、手势返回）＝放弃这次调整，顺序不变
      dragRef.current = null;
      setDrag(null);
      targetRef.current = null;
      setTarget(null);
      startRef.current = null;
    };

    // 长按期间只监听移动，用于判定"这不是长按"
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // 长按期间（还没抬起）也要能取消：上面的 effect 只在 drag 存在时才挂监听，
  // 而取消长按必须发生在 drag 之前。所以这里单独挂一组轻量监听。
  useEffect(() => {
    if (drag || inArrange) return;
    const onMove = (e: PointerEvent) => {
      const s = startRef.current;
      if (!s) return;
      if (Math.abs(e.clientX - s.x) > MOVE_TOLERANCE
        || Math.abs(e.clientY - s.y) > MOVE_TOLERANCE) {
        clearTimer();
        startRef.current = null;
      }
    };
    const onUp = () => {
      // 没等到 500ms 就松手 = 普通点击，什么都不做（点击事件照常派发）
      clearTimer();
      startRef.current = null;
    };
    const onCtx = () => { clearTimer(); startRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('contextmenu', onCtx);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('contextmenu', onCtx);
    };
  }, [drag, inArrange]);

  // Esc 的两层语义（§15.28）。
  //
  // 拖动进行中按 Esc = **取消这次拖动**（松手不落位），仍留在排列模式；
  // 没在拖的时候按 Esc = 退出排列模式。
  //
  // 优先取消拖动是因为：用户按 Esc 的那一刻正在拖，他的意图几乎一定是
  // "这次拖错了，别落"。直接退出模式的话，他还在排的那一半也一起没了。
  // 两件事用一个键，靠"当前有没有在拖"这个状态区分，不需要第二个键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragRef.current) return;
      // 输入框里的 Esc 有自己的用处（比如取消编辑），别抢
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      dragRef.current = null;
      setDrag(null);
      targetRef.current = null;
      setTarget(null);
      startRef.current = null;
      clearTimer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => () => clearTimer(), []);

  return {
    arranging: inArrange,
    setArranging: enterArrange,
    drag,
    target,
    onDrop,
    press,
  };
}
