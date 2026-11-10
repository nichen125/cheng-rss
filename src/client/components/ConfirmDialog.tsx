// 应用级确认弹窗（替代浏览器原生 confirm）。
//
// 为什么不用浏览器原生的同步确认框：样式不跟主题、说不清"这一步会删掉
// 什么"，手机上还会整屏冻结。改成自绘弹窗后，调用方式几乎一样 ——
// Promise 化的 `confirm(options)`：
//
//     const yes = await confirm({ title: '取消订阅…', danger: true });
//     if (!yes) return;
//
// 契约：
//   · confirm 只会在用户按下按钮、按 Esc、点遮罩后 resolve，永不 reject；
//   · 取消 / Esc / 点遮罩一律 resolve(false) —— 没点确认就是没做；
//   · 同一时刻只显示一个弹窗，后来的请求排队等前一个结束，不会互相覆盖
//     导致其中某个 await 永远挂着；
//   · 打开期间锁 body 滚动，关闭后焦点还给触发它的那个元素。
import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type ReactNode,
} from 'react';

export interface ConfirmOptions {
  /** 一句话说清"你要做什么" —— 也是 aria-labelledby 的文本 */
  title: string;
  /** 后果说明：会删掉什么、什么会保留、能不能撤销 */
  message?: string;
  /** 确认按钮文案，默认「确定」 */
  confirmText?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string;
  /** 破坏性操作（删除/清空）传 true，按钮转成警示色 */
  danger?: boolean;
}

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

interface ConfirmRequest extends ConfirmOptions {
  /** 每次请求唯一；用作 Dialog 的 key，让排队中的下一个重新挂载 */
  id: number;
  resolve: (v: boolean) => void;
}

const Ctx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider(props: { children: ReactNode }) {
  const [current, setCurrent] = useState<ConfirmRequest | null>(null);
  // 正在显示的请求与排队中的请求都放 ref：它们只在事件回调里读写，
  // 进 state 只会多一轮渲染，而且 settle 里读到的可能还是旧值。
  const currentRef = useRef<ConfirmRequest | null>(null);
  const queueRef = useRef<ConfirmRequest[]>([]);
  const seqRef = useRef(0);

  const show = useCallback((req: ConfirmRequest) => {
    currentRef.current = req;
    setCurrent(req);
  }, []);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      const req: ConfirmRequest = { ...opts, id: ++seqRef.current, resolve };
      if (currentRef.current) queueRef.current.push(req);
      else show(req);
    });
  }, [show]);

  /** 关闭当前弹窗并唤醒它的 await；有排队的就立刻显示下一个 */
  const settle = useCallback((result: boolean) => {
    const cur = currentRef.current;
    if (!cur) return;
    currentRef.current = null;
    const next = queueRef.current.shift() ?? null;
    if (next) show(next);
    else setCurrent(null);
    cur.resolve(result);
  }, [show]);

  return (
    <Ctx.Provider value={confirm}>
      {props.children}
      {/* 弹窗排在 children 之后：与配置弹窗同为 z-index 60 时，
          后面的元素才画在上面 */}
      {current && <Dialog key={current.id} req={current} settle={settle} />}
    </Ctx.Provider>
  );
}

/** 取到 confirm。必须在 ConfirmProvider 之内调用，否则直接报错 */
export function useConfirm(): ConfirmFn {
  const fn = useContext(Ctx);
  if (!fn) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用');
  return fn;
}

function Dialog(props: { req: ConfirmRequest; settle: (v: boolean) => void }) {
  const { req, settle } = props;
  const id = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  // 打开前的焦点位置。关闭后要还回去，否则键盘/读屏用户会被扔回页面顶部
  const returnToRef = useRef<Element | null>(null);
  // settle 在 effect 里被调用，放进 ref 避免把 effect 绑到它的身份上
  const settleRef = useRef(settle);
  settleRef.current = settle;

  useEffect(() => {
    returnToRef.current = document.activeElement;
    confirmRef.current?.focus();

    // 锁 body 滚动。记下原值而不是写死 ''：外层可能已经因别的原因锁过
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Esc 取消。用捕获阶段 + stopPropagation：配置弹窗也在 window 上监听
    // Esc 关闭自己（冒泡阶段），不拦住的话按一次 Esc 会把两层一起关掉
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      settleRef.current(false);
    };
    document.addEventListener('keydown', onKey, true);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      const back = returnToRef.current;
      // isConnected：触发按钮可能已经随着这次操作（如删掉那一行）一起消失
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  const titleId = `${id}-title`;
  const descId = `${id}-desc`;

  return (
    <div className="modal-backdrop" onClick={() => settle(false)}>
      <div
        className="modal confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={req.message ? descId : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId}>{req.title}</h2>
        {req.message && (
          <p className="hint confirm-message" id={descId}>{req.message}</p>
        )}
        <div className="modal-actions">
          {/* 初始焦点落在确认按钮上（见上面的 effect）。Esc 是取消，
              所以焦点不需要先落在「取消」上 —— 误触 Enter 才更危险 */}
          <button type="button" className="btn" onClick={() => settle(false)}>
            {req.cancelText ?? '取消'}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={req.danger ? 'btn danger' : 'btn primary'}
            onClick={() => settle(true)}
          >
            {req.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
