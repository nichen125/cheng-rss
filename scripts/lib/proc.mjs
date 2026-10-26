// 子进程收尾。
//
// 曾经这里有三层清理（pid 登记 / 启动扫残留 / 按 --user-data-dir 兜底），
// 起因是验证脚本连跑多轮后攒下 115 个 msedge / 6.9GB，把后续的 SEA 打包
// 逼成 `Fatal process out of memory: Zone`。
//
// 现在浏览器自动化交给 DSH 的浏览器插件（bsk_*），只有 3 个布局验收脚本
// 还会短暂起一次无头浏览器，收尾就两件事：正常路径显式调 cleanup，
// 异常路径靠 onExit。够用了，不需要再维护那套基础设施。

import { execFileSync } from 'node:child_process';

/** 杀掉 pid 及其子进程。已退出、无权限都静默忽略。 */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      // Windows 必须 /T，否则子进程会活下来
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch { /* 已退出 */ }
}

/**
 * 注册收尾函数，覆盖正常退出 / Ctrl+C / 未捕获异常。
 *
 * 注意：Windows 上 `kill('SIGTERM')` 走 TerminateProcess，被外部硬杀时
 * 收尾函数**一次都不会执行**——这是平台限制，不是这段代码的问题。
 * 真要跑长跑验证，就让 verify-all 串行、每轮结束后自己看一眼进程数。
 */
export function onExit(fn) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    try { fn(); } catch { /* 收尾失败不影响退出码 */ }
  };
  process.on('exit', run);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { run(); process.exit(0); });
  }
  process.on('uncaughtException', (e) => { console.error(e); run(); process.exit(1); });
}
