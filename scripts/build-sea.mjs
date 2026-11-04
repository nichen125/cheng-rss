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
// 再用环境变量 CHENG_RSS_SEA_BASE 指过来。
const wantTarget = (() => {
  const i = process.argv.indexOf('--target');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const baseBin = process.env.CHENG_RSS_SEA_BASE || nodeBin;

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
  if (wantTarget !== hostTarget && !process.env.CHENG_RSS_SEA_BASE) {
    fail(
      `不能从 ${hostTarget} 造 ${wantTarget} 的二进制。\n` +
      `SEA 的注入底本必须是目标平台的 node 可执行体。\n` +
      `要么在目标平台机器上构建，要么用 CHENG_RSS_SEA_BASE 指定对应的 node。`,
    );
  }
  if (!existsSync(baseBin)) {
    fail(`CHENG_RSS_SEA_BASE 指向的文件不存在: ${baseBin}`);
  }
}

const targetName = wantTarget ?? `${platform}-${arch}`;
// 产物名按目标平台决定，不是按宿主
const outName = targetName.startsWith('win')
  ? `cheng-rss-${targetName}.exe`
  : `cheng-rss-${targetName}`;
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
      `你可能有正在运行的 cheng-rss 进程（Windows 上尤其常见）。\n` +
      `先停掉它：taskkill /F /IM ${outName}   （或关闭正在跑的服务）`,
    );
  }
  throw e;
}
// 注入底本是目标平台的 node（默认就是本机的）。
// 复制放在下面的重试循环里做 —— 每次尝试都从干净的基础 node 开始，
// 免得把上一次写了一半的文件再叠一次。
const postject = join(root, 'node_modules', '.bin', platform === 'win32' ? 'postject.cmd' : 'postject');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// 为什么要在 postject 前加 --liftoff-only：
//
// postject 的注入器是 Emscripten 编译成 wasm 的（`node_modules/postject/dist/api.js`
// 里有一个 4.8MB 的 wasm 模块）。Windows 上它有两个失败模式：
//
//   1. `Fatal process out of memory: Zone` —— V8 的 TurboFan 在给这个巨型
//      函数做类型推导时把 Zone 撑爆了。这是**编译期**内存耗尽，跟物理内存
//      还剩多少无关（本机空闲 2.4GB 照样炸），所以调 --max-old-space-size
//      完全无效，只有关掉 tier-up 才绕过。
//   2. `Aborted()` —— 同一个 wasm 在 tier-up 里二次编译时的断言失败。
//
// `--liftoff-only` 让它只用 Liftoff 基线编译器，不尝试优化编译。
// 注入一次要跑 3~5 秒，慢一点无所谓；不能生成二进制才是问题。
// 这个标记非 Windows 上加了也无害，所以统一加，不给平台分叉。
const NODE_FLAGS = ['--liftoff-only'];

// 不走 postject.cmd：那个 .cmd 会按 PATH 找 node，于是实际用的是系统 node
// 而不是项目内工具链（§1.2 要求全局零依赖）。这里直接用项目内的 node
// 跑 cli.js，解释器是确定的。
const postjectCli = join(root, 'node_modules', 'postject', 'dist', 'cli.js');
const args = [postjectCli, outPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', FUSE];

/**
 * 注入，并**验证结果**。
 *
 * 为什么不能只看退出码 / 文件存在（这是踩过的真坑）：
 * postject 的失败模式有三种，其中两种不会让脚本察觉 ——
 *
 *   · `Aborted()`      —— wasm 内部断言，退出码非 0（这个能察觉）
 *   · `Array buffer allocation failed` —— 同上
 *   · **注入到一半没写进去，进程却正常退出** —— outPath 存在（它是 copy
 *     过来的基础 node），于是 `existsSync(outPath)` 为真，脚本报成功，
 *     产出一个**没有 bundle 的裸 node**。它跑起来像 node，`version`
 *     子命令直接报 "Cannot find module"。
 *
 * 根因是这台机器上 V8 拿不到连续地址空间（wasm 要 ~256MB 起，Emscripten
 * 还会 grow）。所以这里做两件事：
 *   1. 重试若干次（内存压力是波动的，同一命令隔几秒常常就能过）
 *   2. **用 blob 内容做物理校验** —— 注入成功 = 文件里出现了 blob 的字节
 *
 * 校验取 blob 末尾的一段：SEA blob 是 JSON + payload，末尾必然存在且
 * 不会被 postject 改写（它只插进文件，不改 blob 内容）。
 */
function injectedOk() {
  if (!existsSync(outPath)) return false;
  const blob = readFileSync(blobPath);
  if (blob.length < 64) return false;
  const probe = blob.subarray(blob.length - 48);
  const out = readFileSync(outPath);
  return out.includes(probe);
}

const INJECT_ATTEMPTS = 6;
let lastErr = null;
let injected = false;
for (let i = 1; i <= INJECT_ATTEMPTS; i++) {
  // 每次重试都从干净的基础 node 开始：上一次可能写了一半
  copyFileSync(baseBin, outPath);
  if (!targetName.startsWith('win')) chmodSync(outPath, 0o755);

  try {
    if (existsSync(postjectCli)) {
      execFileSync(nodeBin, [...NODE_FLAGS, ...args], { cwd: root, stdio: 'pipe' });
    } else if (existsSync(postject)) {
      execFileSync(postject, args.slice(1), {
        cwd: root, stdio: 'pipe', shell: platform === 'win32',
      });
    } else {
      console.log('未找到本地 postject，尝试 npx');
      execFileSync('npx', ['--yes', 'postject', outPath, 'NODE_SEA_BLOB', blobPath,
        '--sentinel-fuse', FUSE], { cwd: root, stdio: 'inherit', shell: platform === 'win32' });
    }
  } catch (e) {
    lastErr = e;
  }

  if (injectedOk()) { injected = true; break; }

  if (i < INJECT_ATTEMPTS) {
    console.log(`\u001b[33m!\u001b[0m 注入第 ${i} 次未成功，重试…`);
    // 等一小会儿：失败多是内存压力，进程退出后会有短暂的喘息窗口
    execFileSync(nodeBin, ['-e', 'setTimeout(()=>{}, 1500)'], { cwd: root, stdio: 'ignore' });
  }
}

if (!injected) {
  const detail = lastErr
    ? (String(lastErr.stdout ?? '') + String(lastErr.stderr ?? '') + String(lastErr.message ?? '')).trim()
    : '注入命令"成功"了，但产物里没有 blob 的字节';
  fail(
    `postject 注入失败（连试 ${INJECT_ATTEMPTS} 次）。\n` +
    `产物 ${outName} 是**没有 bundle 的裸 node**，不能用。\n\n` +
    `最常见的原因是这台机器可用内存/连续地址空间不足 —— postject 的 wasm\n` +
    `注入器要一次性拿到 ~256MB 连续内存。实测：关掉一些大程序（浏览器、\n` +
    `IDE）后重跑即可成功；重启后第一次构建几乎总能过。\n\n` +
    `最后一次错误：\n${detail.split('\n').slice(0, 8).join('\n')}`,
  );
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
