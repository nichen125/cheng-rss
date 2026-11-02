#!/usr/bin/env node
// 手动清理验收/调试留下的临时文件。
//
// 用法:
//   node scripts/clean-tmp.mjs            # 清 .tmp/verify 下的全部残留
//   node scripts/clean-tmp.mjs --dry-run  # 只报体积，不删
//
// 平时不需要跑：`verify-all` 收尾会自动清（PLAN §19.10c）。
// 这个脚本是给"上一次验收被 Ctrl+C 打断、或者某个进程卡着句柄"的情况用的。

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TMP_ROOT, cleanTmp, dirSize, human } from './lib/tmp.mjs';

const dryRun = process.argv.includes('--dry-run');

if (dryRun) {
  let entries;
  try { entries = readdirSync(TMP_ROOT, { withFileTypes: true }); } catch { entries = []; }
  if (entries.length === 0) {
    console.log(`干净：${TMP_ROOT} 下没有残留`);
  } else {
    let total = 0;
    for (const e of entries) {
      const p = join(TMP_ROOT, e.name);
      const size = e.isDirectory() ? dirSize(p) : (() => { try { return statSync(p).size; } catch { return 0; } })();
      total += size;
      console.log(`  ${human(size).padStart(9)}  ${e.name}`);
    }
    console.log(`\n合计 ${entries.length} 项 / ${human(total)}`);
  }
  process.exit(0);
}

const t = cleanTmp();
if (t.removed === 0 && t.failed === 0) {
  console.log(`干净：${TMP_ROOT} 下没有残留`);
} else {
  console.log(`删除 ${t.removed} 项 / ${human(t.freedBytes)}`);
  if (t.failed > 0) {
    // 不静默：删不掉通常意味着还有个浏览器进程攥着 profile，
    // 报出来比"清过了"有用。
    console.log(`${t.failed} 项仍被占用 —— 可能还有残留的无头浏览器进程，稍后重试`);
    process.exitCode = 1;
  }
}
