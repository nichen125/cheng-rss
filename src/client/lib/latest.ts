// 列表请求的「最新一次」判定（P0 竞态修复，见 docs/plans/refactor-p0.md §1）。
//
// 为什么单独成模块：这条逻辑的正确性不取决于 React 渲染，只取决于
// 「谁最后发起」。抽成不依赖 DOM 的纯逻辑，才能用 node --test 直接覆盖
// 「旧响应后到」这种只能靠时序复现的错法 —— 在浏览器里稳定造出
// 「先发的请求后返回」，比写一条断言贵得多。

export interface LatestGuard {
  /** 领取本次请求的序号；返回之后，之前所有未落地的序号都过期 */
  begin(): number;
  /** 该序号是否仍是最新一次请求。false 的响应不许再写 state */
  isLatest(seq: number): boolean;
  /** 让所有在途序号作废（切视图/卸载时用，不必等下一个请求发起） */
  invalidate(): void;
}

/**
 * 序号守卫。
 *
 * 单调自增而不是时间戳：同一毫秒内连发两次请求时时间戳会相等，
 * 而序号永远能分出先后。
 */
export function createLatest(): LatestGuard {
  let latest = 0;
  return {
    begin() {
      latest += 1;
      return latest;
    },
    isLatest(seq) {
      return seq === latest;
    },
    invalidate() {
      latest += 1;
    },
  };
}

/**
 * 取消请求时 fetch 抛出的拒绝。
 *
 * 按 name 而不是 instanceof 判断：DOMException 在 iframe、Node 的
 * undici 里可能不是同一个构造函数，跨 realm 时 instanceof 会漏判，
 * 而漏判的后果是「用户切走视图后弹一条 'This operation was aborted'」。
 */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null
    && (e as { name?: unknown }).name === 'AbortError';
}
