#!/usr/bin/env node
// 构建单文件二进制（SEA）。
//
// 流程（PLAN §3.4 / §16.2）：
//   1. esbuild 打包服务端 → dist/server.cjs（--sea，minify）
//   2. 打包前端 → dist/client.zip
//   3. 生成 sea-config.json（assets 里放 client.zip）
//   4. node --experimental-sea-config 产出 blob
//   5. 复制 node 可执行体 → postject 注入 blob
//
// 关键：Node 24 的 SEA 没有 vfsArchive/useVfs（那是 Node 26 的能力，
// 写进配置会被静默忽略）。所以静态资源只能走 assets + 运行时
// fflate 内存解压。
import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const nodeBin = process.execPath;

const platform = process.platform;
const arch = process.arch;

function fail(msg) {
  console.error(`\u001b[31m✗\u001b[0m ${msg}`);
  process.exit(1);
}

// SEA 的硬限制（PLAN §3.2）
if (platform === 'darwin' && arch === 'x64') {
  fail('SEA 官方未测试 macOS x64。请用源码模式运行，或改用 arm64 机器构建。');
}
if (process.platform === 'linux' && existsSync('/etc/alpine-release')) {
  fail('Alpine (musl) 不受 SEA 支持。请用 Docker 的 debian 基础镜像构建。');
}

const targetName = `${platform}-${arch}`;
const outName = platform === 'win32'
  ? `ai-rss-${targetName}.exe`
  : `ai-rss-${targetName}`;
const outPath = join(dist, outName);

mkdirSync(dist, { recursive: true });

// ── 1. 服务端 bundle ────────────────────────────────────────
console.log('打包服务端（--sea）');
execFileSync(nodeBin, [join(root, 'scripts/build-server.mjs'), '--sea'], {
  cwd: root, stdio: 'inherit',
});

// ── 2. 前端 zip ─────────────────────────────────────────────
if (!existsSync(join(dist, 'client.zip'))) {
  if (!existsSync(join(dist, 'client/index.html'))) {
    fail('前端未构建。先运行 scripts/build-client.mjs');
  }
  console.log('打包前端 zip');
  execFileSync(nodeBin, [join(root, 'scripts/pack-client-zip.mjs')], {
    cwd: root, stdio: 'inherit',
  });
}

// ── 3. sea-config ───────────────────────────────────────────
const seaConfig = join(dist, 'sea-config.json');
const blobPath = join(dist, 'sea-prep.blob');

writeFileSync(seaConfig, JSON.stringify({
  main: join(dist, 'server.cjs').replace(/\\/g, '/'),
  output: blobPath.replace(/\\/g, '/'),
  disableExperimentalSEAWarning: true,
  // 静态资源以 assets 形式内嵌；运行时用 getAsset('client.zip') 取出
  assets: {
    'client.zip': join(dist, 'client.zip').replace(/\\/g, '/'),
  },
}, null, 2), 'utf8');

// ── 4. 生成 blob ────────────────────────────────────────────
console.log('生成 SEA blob');
execFileSync(nodeBin, ['--experimental-sea-config', seaConfig], {
  cwd: root, stdio: 'inherit',
});

const blobSize = statSync(blobPath).size;
if (blobSize < 10_000) {
  fail(`blob 只有 ${blobSize} 字节，明显不对（assets 可能没打进去）`);
}

// ── 5. 注入 ─────────────────────────────────────────────────
console.log(`生成二进制 ${outName}`);
rmSync(outPath, { force: true });
copyFileSync(nodeBin, outPath);
if (platform !== 'win32') chmodSync(outPath, 0o755);

const postject = join(root, 'node_modules', '.bin', platform === 'win32' ? 'postject.cmd' : 'postject');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

if (existsSync(postject)) {
  // 优先用本地 postject（项目内依赖，不联网）
  const args = [outPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', FUSE];
  try {
    execFileSync(postject, args, { cwd: root, stdio: 'pipe' });
  } catch (e) {
    // Windows 上 postject.cmd 需要 shell
    execFileSync(postject, args, { cwd: root, stdio: 'pipe', shell: platform === 'win32' });
  }
} else {
  console.log('未找到本地 postject，尝试 npx');
  execFileSync('npx', ['--yes', 'postject', outPath, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', FUSE], { cwd: root, stdio: 'inherit', shell: platform === 'win32' });
}

if (!existsSync(outPath)) fail('二进制未生成');

const size = statSync(outPath).size;
console.log(`\n\u001b[32m✓\u001b[0m ${outName}  ${(size / 1024 / 1024).toFixed(0)} MB`);

// ── 6. 冒烟：直接问版本 ─────────────────────────────────────
try {
  const out = execFileSync(outPath, ['version'], { encoding: 'utf8', timeout: 20000 });
  console.log(out.trim().split('\n').map((l) => `  ${l}`).join('\n'));
} catch (e) {
  fail(`二进制无法运行:\n${e.stderr ?? e.message}`);
}

rmSync(seaConfig, { force: true });
rmSync(blobPath, { force: true });
