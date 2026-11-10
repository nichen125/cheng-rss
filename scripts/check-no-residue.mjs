#!/usr/bin/env node
// 检查构建/安装过程是否向项目目录之外写入。
//
// 用法:
//   node scripts/check-no-residue.mjs            # 以当前时刻为基准，之后手动操作
//   node scripts/check-no-residue.mjs --run "bash scripts/bootstrap.sh"
//
// 原理：在 $HOME 下放一个标记文件，执行命令，再看 $HOME 里有没有
// 比标记更新的文件（排除少数 git/编辑器必然写的位置）。
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { fileURLToPath } from 'node:url';

// 本文件位于 <root>/scripts/，因此项目根是它的上一级
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

// 这些目录是系统/工具必然写入的，不代表项目污染
const ALLOW = [
  '.gitconfig', '.git-credentials', '.npmrc',
  'AppData/Local/Temp', 'AppData/Local/Microsoft',
  'AppData/Roaming/npm-cache', 'AppData/Local/npm-cache',
  '.cache/pip', '.local/share/Trash',
  '.vscode', '.config/Code', 'AppData/Roaming/Code',
  '.claude', '.cursor',
  '.dsh',              // harness 自身的会话存储，与被测项目无关
  '.local/state/billion-context', // 同一个 harness 的上下文压缩插件日志，同上
];

function isAllowed(rel) {
  const p = rel.replace(/\\/g, '/');
  return ALLOW.some((a) => p === a || p.startsWith(a + '/'));
}

function snapshot(dir, base = dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = full.slice(base.length + 1);
    if (isAllowed(rel)) continue;
    if (e.isDirectory()) {
      // 跳过明显的巨型目录，避免遍历过慢
      if (['node_modules', '.git', 'AppData'].includes(e.name) && rel.split(/[\\/]/).length === 1) continue;
      snapshot(full, base, out);
    } else {
      try {
        out.push({ rel: rel.replace(/\\/g, '/'), mtime: statSync(full).mtimeMs });
      } catch { /* 忽略不可读文件 */ }
    }
  }
  return out;
}

const home = homedir();
const args = process.argv.slice(2);
const runIdx = args.indexOf('--run');
const cmd = runIdx >= 0 ? args[runIdx + 1] : null;

console.log(`HOME: ${home}`);
console.log(`项目: ${root}`);

const before = snapshot(home);
const beforeSet = new Set(before.map((f) => f.rel));
const t0 = Date.now();

if (cmd) {
  console.log(`\n执行: ${cmd}\n`);
  try {
    execSync(cmd, { cwd: root, stdio: 'inherit', shell: true });
  } catch (e) {
    console.log(`\n命令失败: ${e.message}`);
    process.exitCode = 1;
  }
}

const after = snapshot(home);
const created = after.filter((f) => !beforeSet.has(f.rel));
const modified = after.filter((f) => beforeSet.has(f.rel) && f.mtime > t0);

console.log('');
if (created.length === 0 && modified.length === 0) {
  console.log('\u001b[32mPASS  项目目录之外零写入\u001b[0m');
} else {
  console.log('\u001b[31mFAIL  发现项目外写入\u001b[0m');
  for (const f of created.slice(0, 20)) console.log(`  新增 ${f.rel}`);
  for (const f of modified.slice(0, 20)) console.log(`  修改 ${f.rel}`);
  if (created.length + modified.length > 40) console.log(`  ...另有 ${created.length + modified.length - 40} 项`);
  process.exitCode = 1;
}
