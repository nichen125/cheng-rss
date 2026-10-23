#!/usr/bin/env node
// 前端构建：调用 Vite 产出 dist/client/
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeBin = process.execPath;
const viteBin = join(root, 'node_modules/vite/bin/vite.js');

if (!existsSync(viteBin)) {
  console.error('vite 未安装，先运行 npm ci');
  process.exit(1);
}

const r = spawnSync(nodeBin, [viteBin, 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
});

if (r.status !== 0) {
  console.error('vite build 失败');
  process.exit(r.status ?? 1);
}

// 报告产物体积
const outDir = join(root, 'dist/client');
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push({ path: p.slice(outDir.length + 1), size: statSync(p).size });
  }
  return acc;
}

const files = walk(outDir);
const total = files.reduce((a, f) => a + f.size, 0);
console.log(`\n前端产物: ${files.length} 个文件, ${(total / 1024).toFixed(0)} KB`);
for (const f of files.sort((a, b) => b.size - a.size).slice(0, 5)) {
  console.log(`  ${(f.size / 1024).toFixed(0).padStart(5)} KB  ${f.path}`);
}
