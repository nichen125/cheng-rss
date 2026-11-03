// 底部提示条（PLAN §15.28）。
//
// 只有"跨组移动"会用到它 —— 把源拖进/拖出分组是一个**改变归属**的动作，
// 而归属在侧栏里只体现为一行换了位置。没有提示的话，用户松手后看到的
// 是"那一行不见了/跑到别处了"，很难确认自己做对了没有。
//
// 同组内纯调序**不提示**：那是原地微调，屏幕上那一行只是上下挪了一格，
// 弹一条比不弹更吵。
//
// 为什么自己写而不是装一个 toast 库：需要的能力只有三样 ——
// 底部居中、2.6 秒自动消失、一个「撤销」按钮。任何库都要 +8KB 起、
// 自带一套和本设计无关的圆角/阴影/动画，还会带来一条新的焦点管理规则。
import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconClose } from './icons.tsx';

export interface ToastAction {
  label: string;
  onRun: () => void | Promise<void>;
}

export interface ToastSpec {
  /** 每弹一次换一个 id，同一个 id 不重复入栈（React 重渲染不会重弹） */
  id: number;
  text: string;
  /** 错误 toast 不自动消失，要人点掉 —— 失败的原因必须真被看到 */
  tone?: 'ok' | 'error';
  action?: ToastAction;
}

/** 自动消失时长。2.6 秒是 Material 与 iOS 的常见区间，够读完一行中文 */
export const TOAST_MS = 2600;

export function ToastHost(props: { toast: ToastSpec | null; onDone: (id: number) => void }) {
  const { toast, onDone } = props;
  const [leaving, setLeaving] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLeaving(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!toast) return;
    // 错误不自动消失：一闪而过的失败信息等于没告诉用户
    if (toast.tone === 'error') return;
    timerRef.current = setTimeout(() => {
      // 先播淡出，等动画结束再真正移除，否则会"啪"地消失
      setLeaving(true);
      timerRef.current = setTimeout(() => onDone(toast.id), 180);
    }, TOAST_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [toast, onDone]);

  if (!toast) return null;
  const isErr = toast.tone === 'error';

  return (
    <div
      className={`toast ${isErr ? 'error' : ''} ${leaving ? 'leaving' : ''}`}
      role={isErr ? 'alert' : 'status'}
      aria-live={isErr ? 'assertive' : 'polite'}
      data-toast-id={toast.id}
    >
      <span className="toast-icon" aria-hidden="true">
        {isErr ? <IconClose size={13} /> : <IconCheck size={13} />}
      </span>
      <span className="toast-text">{toast.text}</span>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            if (timerRef.current) clearTimeout(timerRef.current);
            void toast.action!.onRun();
          }}
        >
          {toast.action.label}
        </button>
      )}
      {/* 错误 toast 没有撤销按钮时也要有出口，否则它永远盖在底部 */}
      {isErr && (
        <button
          className="toast-close"
          onClick={() => { if (timerRef.current) clearTimeout(timerRef.current); onDone(toast.id); }}
          aria-label="关闭提示"
        >
          <IconClose size={12} />
        </button>
      )}
    </div>
  );
}
