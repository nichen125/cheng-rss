#!/usr/bin/env node
// 下载 linux-x64 的 node 可执行体，用于验证 Docker 构建路径。
//
// 为什么需要它：
//   SEA 的注入底本必须是目标平台的 node。本机是 Windows 时，
//   要验证"能否产出 linux-x64 二进制"（Dockerfile 里 build-sea 那一步），
//   就需要一份 linux 的 node 当底本。
//
// 只需跑一次，之后缓存在 .tmp/linuxnode/，verify-all 会自动找到。
// 离线环境可跳过 —— docker-path 会把"产物验证"标记为未执行而非通过。
//
// 用法:
//   node scripts/fetch-linux-node.mjs
//   node scripts/fetch-linux-node.mjs --force    # 重新下载
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VER = process.env.AI_RSS_NODE_VERSION ?? 'v24.13.0';
const dir = join(root, '.tmp/linuxnode');
const tarball = join(dir, `node-${VER}-linux-x64.tar.xz`);
const target = join(dir, `node-${VER}-linux-x64/bin/node`);
const url = `https://nodejs.org/dist/${VER}/node-${VER}-linux-x64.tar.xz`;

const force = process.argv.includes('--force');

if (existsSync(target) && !force) {
  console.log(`✓ 已存在：${target}`);
  console.log(`  ${(statSync(target).size / 1024 / 1024).toFixed(0)} MB，跳过下载`);
  process.exit(0);
}

mkdirSync(dir, { recursive: true });

console.log(`下载 ${url}`);
console.log('约 25MB。本机网络慢的话可能要十几分钟 —— 只需一次。');

const t0 = Date.now();
try {
  execFileSync('curl', ['-fL', '--progress-bar', '--retry', '3', '--retry-delay', '2',
    '--connect-timeout', '20', '--max-time', '1800', '-o', tarball, url], {
    stdio: 'inherit',
    timeout: 1900000,
  });
} catch (e) {
  console.error(`下载失败：${e.message}`);
  console.error('离线环境可以跳过这一步 —— docker-path 会把产物验证标为未执行。');
  process.exit(1);
}

const size = statSync(tarball).size;
if (size < 5_000_000) {
  console.error(`下载文件过小（${size}B），疑似失败`);
  process.exit(1);
}
console.log(`已下载 ${(size / 1024 / 1024).toFixed(0)} MB，解压…`);

execFileSync('tar', ['-xJf', tarball, '-C', dir], { stdio: 'inherit', timeout: 300000 });
rmSync(tarball, { force: true });

if (!existsSync(target)) {
  console.error(`解压后找不到 ${target}`);
  process.exit(1);
}
chmodSync(target, 0o755);

console.log(`✓ 完成：${target}`);
console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log('');
console.log('现在完整验收会包含 Docker 产物验证：');
console.log('  node scripts/verify-all.mjs');
void writeFileSync;
