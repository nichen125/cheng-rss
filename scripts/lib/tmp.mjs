// 验收脚本的临时目录。
//
// 为什么不用 %TEMP%：一次全量验收（52 个脚本）在系统临时目录里留下
// **32 个目录、4.8GB**，其中最大的几个是 500MB 的无头浏览器 profile。
// 系统临时目录的垃圾没人负责清，项目内的有人负责 —— 这就是全部理由。
//
// 为什么不是"每个脚本自己删干净"就够了：`cleanup()` 挂在 onExit 上，
// 而 Windows 上进程被硬杀（verify-all 的超时 SIGKILL）时它一次都不执行。
// 所以真正的兜底是 verify-all 在整轮结束后删掉整个目录。
//
// 实现方式：**不逐个改 48 个脚本**，而是让它们照旧写
// `mkdtempSync(join(tmpdir(), 'x'))`，只把 `os.tmpdir()` 指向这里。
// Windows 上 tmpdir() 读 TEMP 且**每次调用都读**（实测：进程内改
// process.env.TEMP 后立刻生效，没有缓存），所以 harness 一 import 就生效。
//
// 路径也比 %TEMP% 短（实测 36 → 17 字符起），Windows 260 字符上限更安全。

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件在 <root>/scripts/lib/，项目根往上两级
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TMP_ROOT = join(PROJECT_ROOT, '.tmp/verify');

/** 建目录并把 os.tmpdir() 指过去。返回目标路径。 */
export function useProjectTmp() {
  const dir = process.env.AI_RSS_TMP_DIR || TMP_ROOT;
  mkdirSync(dir, { recursive: true });
  // 三个都设：Linux 读 TMPDIR，Windows 读 TEMP 再退 TMP，macOS 读 TMPDIR
  process.env.TMPDIR = dir;
  process.env.TEMP = dir;
  process.env.TMP = dir;
  return dir;
}

/** 同步睡。用在没法 await 的收尾路径上。 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 忽略 */ }
}

/**
 * 删目录，句柄没释放时重试。
 *
 * Windows 上 `taskkill /F /T` 返回后，msedge 的 crashpad handler 与 gpu
 * process 仍会短暂持有 profile 里的文件句柄。实测（278 文件 / 12MB）：
 * killTree 后**立刻** rmSync → `EPERM: Permission denied`；第 2 次（126ms 后）
 * 成功。原来写成 `try { rmSync(...) } catch {}`，把这个 EPERM 静默吞掉了，
 * 于是每跑一个 UI 脚本就留一个 13~500MB 的 profile。
 *
 * 边界：重试只解决"外部进程正松手"，解决不了"本进程自己还开着文件"。
 * m3-05 曾经留 21MB 残留，查下来是它 `openDb()` 之后从没 `h.close()` ——
 * 那种情况下重试多少次都没用，因为持有者就是这个进程。修的是漏掉的 close。
 *
 * @returns {boolean} 最终是否删掉
 */
export function removeDir(dir, tries = 6, gapMs = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      if (i === tries - 1) return false;
      sleepSync(gapMs);
    }
  }
  return false;
}

/** 目录占用（字节）。读不到的条目跳过。 */
export function dirSize(dir) {
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { bytes += statSync(p).size; } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return bytes;
}

/**
 * 删掉临时目录下的全部残留。
 *
 * 只删里面的条目，保留目录本身 —— `.tmp/linuxnode` 等缓存与这里无关，
 * 不能被顺手清掉。
 *
 * @returns {{removed: number, failed: number, freedBytes: number}}
 */
export function cleanTmp() {
  let entries;
  try { entries = readdirSync(TMP_ROOT, { withFileTypes: true }); } catch { return { removed: 0, failed: 0, freedBytes: 0 }; }
  let removed = 0;
  let failed = 0;
  let freedBytes = 0;
  for (const e of entries) {
    const p = join(TMP_ROOT, e.name);
    // 普通文件也要算体积：Edge 会直接往 TEMP 里写 cv_debug.log 之类
    const before = e.isDirectory() ? dirSize(p) : (() => { try { return statSync(p).size; } catch { return 0; } })();
    if (removeDir(p)) { removed++; freedBytes += before; } else { failed++; }
  }
  return { removed, failed, freedBytes };
}

/** 人读的体积。 */
export function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
