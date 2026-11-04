#!/usr/bin/env node
// 校验 Markdown 表格是否按显示宽度对齐。
//
// 判据是「重建一遍再逐字比对」，而不是「看起来齐」——
// Markdown 渲染只认源文本，差一个空格就是歪的。
//
// 用法:
//   node scripts/check-tables.mjs              # 默认 README.md + docs/*.md
//   node scripts/check-tables.mjs FILE...      # 指定文件
//
// 退出码：全部对齐 0，有偏差 1（可挂进 CI 或提交前检查）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rebuildTable, width } from './align-tables.mjs';

const DOCS_DIR = 'docs';

function checkFile(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const problems = [];
  let tables = 0;
  let i = 0;

  while (i < lines.length) {
    if (!/^\|.*\|\s*$/.test(lines[i])) { i++; continue; }
    const startLine = i + 1;
    const block = [];
    while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { block.push(lines[i]); i++; }
    tables++;

    const rebuilt = rebuildTable(block);
    for (let k = 0; k < block.length; k++) {
      if (rebuilt[k] !== block[k]) {
        problems.push({ line: startLine + k, want: rebuilt[k], got: block[k] });
      }
    }
  }
  return { tables, problems };
}

const args = process.argv.slice(2);
let files = args;
if (files.length === 0) {
  files = ['README.md'];
  try {
    for (const f of readdirSync(DOCS_DIR)) {
      if (f.endsWith('.md')) files.push(join(DOCS_DIR, f));
    }
  } catch { /* 没有 docs 目录就算了 */ }
}

let bad = 0;
for (const f of files) {
  const { tables, problems } = checkFile(f);
  if (problems.length === 0) {
    console.log(`✅ ${f}  ${tables} 个表格全部对齐`);
    continue;
  }
  bad += problems.length;
  console.log(`❌ ${f}  ${problems.length} 行未对齐`);
  for (const p of problems.slice(0, 3)) {
    console.log(`   行 ${p.line}`);
    console.log(`     现: ${p.got}`);
    console.log(`     应: ${p.want}`);
  }
  if (problems.length > 3) console.log(`   …另有 ${problems.length - 3} 行`);
}

if (bad > 0) {
  console.log(`\n${bad} 行未对齐。跑 \`node scripts/align-tables.mjs\` 自动修。`);
  process.exit(1);
}
console.log(`\n共 ${files.length} 个文件，全部对齐`);
void width;
