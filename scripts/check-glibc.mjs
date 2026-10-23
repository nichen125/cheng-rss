#!/usr/bin/env node
// 检查 linux 二进制对 glibc 的最低版本要求。
//
// 为什么需要：Dockerfile 的运行阶段是 debian:bookworm-slim（glibc 2.36）。
// 如果二进制要求更高的 glibc，容器里会直接报
//   "version `GLIBC_2.38' not found"
// —— 而这个错误只有在容器里跑起来才会发现。
//
// 做法：ELF 的字符串表里含所需符号版本（GLIBC_2.2.5 之类），
// 直接扫字节取最大值，不需要 ldd（Windows 上也没有）。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? join(root, 'dist/ai-rss-linux-x64');

if (!existsSync(target)) {
  console.error(`找不到 ${target}`);
  process.exit(1);
}

const buf = readFileSync(target);

// ELF magic 检查
if (!(buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46)) {
  console.error('不是 ELF 文件');
  process.exit(1);
}

// 扫所有 GLIBC_x.y[.z] 字符串
const text = buf.toString('latin1');
const re = /GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g;
const found = new Map();
let m;
while ((m = re.exec(text))) {
  const [full, maj, min, patch] = m;
  const ver = [Number(maj), Number(min), Number(patch ?? 0)];
  if (!found.has(full)) found.set(full, ver);
}

if (found.size === 0) {
  console.log('未发现 GLIBC 版本符号（可能是静态链接）');
  process.exit(0);
}

// 版本比较
const versions = [...found.entries()].sort((a, b) => {
  for (let i = 0; i < 3; i++) {
    if (a[1][i] !== b[1][i]) return a[1][i] - b[1][i];
  }
  return 0;
});

// versions 是 [fullName, [maj, min, patch]] 的对，取最后一个的版本数组
const needed = versions[versions.length - 1][1];

// 各发行版的 glibc 版本（运行阶段的基础镜像）
const DISTROS = {
  'debian:bookworm-slim': [2, 36],
  'debian:trixie-slim': [2, 41],
  'debian:bullseye-slim': [2, 31],
  'ubuntu:24.04': [2, 39],
  'ubuntu:22.04': [2, 35],
};

console.log(`二进制: ${target}`);
console.log(`体积:   ${(buf.length / 1024 / 1024).toFixed(0)} MB`);
console.log(`需要 glibc >= ${needed[0]}.${needed[1]}${needed[2] ? '.' + needed[2] : ''}`);
console.log(`（共 ${found.size} 个 GLIBC 版本符号）`);
console.log('');

let allOk = true;
for (const [name, [maj, min]] of Object.entries(DISTROS)) {
  const have = maj > needed[0] || (maj === needed[0] && min >= needed[1]);
  const mark = have ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
  console.log(`  ${mark} ${name.padEnd(22)} glibc ${maj}.${min}`);
  if (!have) allOk = false;
}

console.log('');
if (allOk) {
  console.log('\u001b[32m基础镜像都能满足依赖\u001b[0m');
} else {
  console.log('\u001b[33m部分基础镜像版本过低，容器里会报 GLIBC not found\u001b[0m');
  process.exitCode = 1;
}
