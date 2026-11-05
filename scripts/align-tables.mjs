#!/usr/bin/env node
// 按**显示宽度**重新对齐 Markdown 表格。
//
// 为什么需要它：中文在等宽字体下占 2 格，而 string.length 算 1。
// 用 length 补齐的表格在编辑器里看着齐，渲染出来是歪的 —— 这是
// README「看起来随意」的根源。
//
// 用法:
//   node scripts/align-tables.mjs              # 默认 README.md + docs/**/*.md
//   node scripts/align-tables.mjs FILE...      # 指定文件
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_DIR = 'docs';

/** docs/ 及其子目录（方案/）下的全部 .md，按路径排序。 */
export function docsMarkdown() {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = readdirSync(rel, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(rel, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(DOCS_DIR);
  return out.sort();
}

/** 显示宽度：CJK / 全角标点算 2 */
export function width(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)
    ) w += 2;
    else w += 1;
  }
  return w;
}

/**
 * 把表格块重建成对齐后的行。
 *
 * 目标列宽取「内容行」的最大显示宽度（分隔行不参与 —— 它本来就是横线，
 * 参与会把列撑宽）。分隔行的横线数跟随目标宽度，这样视觉上是一整块。
 */
export function rebuildTable(block) {
  const rows = block.map((r) => r.trim().slice(1, -1).split('|').map((c) => c.trim()));
  const sepIdx = rows.findIndex((r) => r.every((c) => /^:?-{3,}:?$/.test(c)));
  const colCount = Math.max(...rows.map((r) => r.length));

  const widths = [];
  for (let c = 0; c < colCount; c++) {
    const cells = rows.filter((_, ri) => ri !== sepIdx).map((r) => r[c] ?? '');
    widths.push(Math.max(3, ...cells.map(width)));
  }

  const out = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const cells = [];
    for (let c = 0; c < colCount; c++) {
      const v = rows[ri][c] ?? '';
      if (ri === sepIdx) {
        const left = v.startsWith(':');
        const right = v.endsWith(':');
        const dashes = '-'.repeat(Math.max(3, widths[c] - (left ? 1 : 0) - (right ? 1 : 0)));
        cells.push(`${left ? ':' : ''}${dashes}${right ? ':' : ''}`);
      } else {
        cells.push(v + ' '.repeat(Math.max(0, widths[c] - width(v))));
      }
    }
    out.push('| ' + cells.join(' | ') + ' |');
  }
  return out;
}

function alignFile(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out = [];
  let changed = 0;
  let i = 0;

  while (i < lines.length) {
    if (!/^\|.*\|\s*$/.test(lines[i])) { out.push(lines[i]); i++; continue; }
    const block = [];
    while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { block.push(lines[i]); i++; }
    const rebuilt = rebuildTable(block);
    for (let k = 0; k < rebuilt.length; k++) {
      if (rebuilt[k] !== block[k]) changed++;
      out.push(rebuilt[k]);
    }
  }

  writeFileSync(file, out.join('\n'));
  return changed;
}

// 只在被直接执行时跑主流程。check-tables.mjs 要借这里的 rebuildTable/docsMarkdown，
// 而 ES 模块的顶层代码 import 时会执行 —— 没有这道守卫，"检查"会顺手改写文件。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args.length === 0 ? ['README.md', ...docsMarkdown()] : args;
  let total = 0;
  for (const f of files) {
    const n = alignFile(f);
    total += n;
    console.log(`${n === 0 ? '  ' : '✓ '}${f}  ${n} 行调整`);
  }
  console.log(`\n共 ${files.length} 个文件，${total} 行调整`);
}
