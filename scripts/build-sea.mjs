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

// 允许用 --target 指定，但只能等于本机平台。
// SEA 的注入底本必须是目标平台的 node 可执行体，跨平台构建需要一份
// 目标平台的 node —— 这个脚本做不到，也不假装能做到。
// CI 里造 Windows 产物时，由 workflow 先把 node.exe 下载到 vendor/，
// 再用环境变量 AI_RSS_SEA_BASE 指过来。
const wantTarget = (() => {
  const i = process.argv.indexOf('--target');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const baseBin = process.env.AI_RSS_SEA_BASE || nodeBin;

function fail(msg) {
  console.error(`\u001b[31m✗\u001b[0m ${msg}`);
  process.exit(1);
}

// SEA 的硬限制（PLAN §3.2）
if (platform === 'darwin' && arch === 'x64') {
  fail('SEA 官方未测试 macOS x64。请用源码模式运行，或改用 arm64 机器构建。');
}
if (platform === 'linux' && existsSync('/etc/alpine-release')) {
  fail('Alpine (musl) 不受 SEA 支持。请用 Docker 的 debian 基础镜像构建。');
}

if (wantTarget) {
  const hostTarget = `${platform}-${arch}`;
  // 目标与宿主不一致时，必须有外部提供的目标平台 node
  if (wantTarget !== hostTarget && !process.env.AI_RSS_SEA_BASE) {
    fail(
      `不能从 ${hostTarget} 造 ${wantTarget} 的二进制。\n` +
      `SEA 的注入底本必须是目标平台的 node 可执行体。\n` +
      `要么在目标平台机器上构建，要么用 AI_RSS_SEA_BASE 指定对应的 node。`,
    );
  }
  if (!existsSync(baseBin)) {
    fail(`AI_RSS_SEA_BASE 指向的文件不存在: ${baseBin}`);
  }
}

const targetName = wantTarget ?? `${platform}-${arch}`;
// 产物名按目标平台决定，不是按宿主
const outName = targetName.startsWith('win')
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
// 必须每次重打。曾经这里是"存在就跳过"，结果改了前端、构建成功、
// 二进制里嵌的还是旧 zip —— 浏览器看到的是几天前的 UI，而所有
// 构建日志都是绿的。zip 只有 77KB，重打比判断依赖关系便宜。
if (!existsSync(join(dist, 'client/index.html'))) {
  fail('前端未构建。先运行 scripts/build-client.mjs');
}
console.log('打包前端 zip');
execFileSync(nodeBin, [join(root, 'scripts/pack-client-zip.mjs')], {
  cwd: root, stdio: 'inherit',
});

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
try {
  rmSync(outPath, { force: true });
} catch (e) {
  if (e.code === 'EPERM' || e.code === 'EBUSY') {
    fail(
      `${outName} 正被占用，无法覆盖。\n` +
      `你可能有正在运行的 ai-rss 进程（Windows 上尤其常见）。\n` +
      `先停掉它：taskkill /F /IM ${outName}   （或关闭正在跑的服务）`,
    );
  }
  throw e;
}
// 注入底本是目标平台的 node（默认就是本机的）
copyFileSync(baseBin, outPath);
// 只有非 Windows 目标才需要可执行位
if (!targetName.startsWith('win')) chmodSync(outPath, 0o755);

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

// ── 6. 冒烟：只有目标平台 == 宿主平台才能直接运行 ───────────
// 跨平台产出的二进制在本机跑不了（ELF 在 Windows 上会 ENOENT），
// 这不是失败，而是需要到目标平台验证。
const hostTarget = `${platform}-${arch}`;
if (targetName !== hostTarget) {
  console.log(
    `\u001b[33m!\u001b[0m 跳过冒烟测试：产物是 ${targetName}，当前宿主是 ${hostTarget}。\n` +
    `  请到 ${targetName} 机器上运行：./${outName} version`,
  );
} else {
  try {
    const out = execFileSync(outPath, ['version'], { encoding: 'utf8', timeout: 20000 });
    console.log(out.trim().split('\n').map((l) => `  ${l}`).join('\n'));
  } catch (e) {
    fail(`二进制无法运行:\n${e.stderr ?? e.message}`);
  }
}

rmSync(seaConfig, { force: true });
rmSync(blobPath, { force: true });
