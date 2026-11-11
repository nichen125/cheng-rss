import { log } from '../logger.ts';

// 为什么要有这一层：cmdServe 里的五套定时任务完全同构，彼此只差「间隔」
// 和「跑什么」。每一套都必须自己 .unref?.()，否则空转的 interval 会一直
// 挂住事件循环，进程永远退不出去；每一套也都必须自己吞掉异常，否则一次
// 上游失败会从回调里冒成未捕获异常。这两步在复制粘贴时最容易漏掉，所以
// 收成一处，漏不掉。

export interface ScheduleTaskOpts {
  /** 任务名。失败日志默认是 `${name} 失败`，所以它得能看懂是谁挂了 */
  readonly name: string;
  /** 周期，毫秒。不做换算、不给默认值 —— 传进来的数字就是实际间隔 */
  readonly everyMs: number;
  /** 单次执行体。同步抛出与 Promise reject 都被吞掉并记一条 warn */
  readonly run: () => unknown | Promise<unknown>;
  /**
   * 首次执行的延迟，毫秒。省略 = 不额外先跑一次，只按 `everyMs` 周期跑。
   *
   * 一定是 setTimeout 而不是同步调用：启动路径上不许有阻塞工作，
   * 也让「首跑」与「周期跑」走同一个 tick。
   */
  readonly firstRunDelayMs?: number;
  /**
   * 失败日志的原文，省略时为 `${name} 失败`。
   *
   * 中英文断句不同：`补录待提取条目失败` 与拼出来的 `补录待提取条目 失败`
   * 差一个空格，而 logger 的限速键就是日志原文，差一个字符就是两个键。
   */
  readonly failMessage?: string;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof (v as PromiseLike<unknown> | null)?.then === 'function';
}

/**
 * 按周期跑一个任务，返回停止它的函数。
 *
 * 两个 handle 都 unref：定时任务不该把进程钉在事件循环里。
 * `run` 抛错只记一条 warn，不向外传播 —— 一个坏掉的周期任务
 * 不该带走整个服务。
 */
export function scheduleTask(opts: ScheduleTaskOpts): () => void {
  const reportError = (e: unknown): void => {
    log.warn(opts.failMessage ?? `${opts.name} 失败`, {
      err: e instanceof Error ? e.message : String(e),
    });
  };

  const tick = (): void => {
    try {
      const r = opts.run();
      // try/catch 抓不到 Promise 里的抛出，异步任务要单独挂一次 rejection
      if (isThenable(r)) void r.then(undefined, reportError);
    } catch (e) {
      reportError(e);
    }
  };

  const first = opts.firstRunDelayMs === undefined
    ? null
    : setTimeout(tick, opts.firstRunDelayMs);
  first?.unref?.();
  const every = setInterval(tick, opts.everyMs);
  every.unref?.();

  return () => {
    if (first) clearTimeout(first);
    clearInterval(every);
  };
}
