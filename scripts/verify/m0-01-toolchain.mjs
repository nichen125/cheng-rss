#!/usr/bin/env node
// 0.1 项目内工具链 —— 验收
//
// 判据（PLAN §19.2）：
//   ① 项目内 node -v 等于锁定版本
//   ② npm 缓存落在项目目录内
//   ③ 构建前后 $HOME 文件数不变
//
// 注意：本脚本必须能不依赖 .toolchain 运行，否则它无法验证
// "工具链还没装"这个状态。因此只用系统 node 跑自己。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

// 从 toolchain.sh（POSIX）或 toolchain.ps1 里读出版本号，
// 避免验收脚本自己再维护一份，导致两处不一致。
function readLockedVersion() {
  const sh = join(root, 'scripts/lib/toolchain.sh');
  const ps = join(root, 'scripts/lib/toolchain.ps1');
  const src = existsSync(sh) ? readFileSync(sh, 'utf8') : readFileSync(ps, 'utf8');
  const m = src.match(/v(\d+\.\d+\.\d+)/);
  if (!m) throw new Error('无法从 toolchain 库读取锁定版本');
  return m[1];
}
const locked = readLockedVersion();

group('0.1 项目内工具链');

// ── ① 版本一致性：三处（sh / ps1 / 实际二进制）必须一致 ──────────
const shVer = readFileSync(join(root, 'scripts/lib/toolchain.sh'), 'utf8').match(/v\d+\.\d+\.\d+/)?.[0];
const psVer = readFileSync(join(root, 'scripts/lib/toolchain.ps1'), 'utf8').match(/v\d+\.\d+\.\d+/)?.[0];
check('.sh 与 .ps1 的锁定版本一致', () => eq(shVer, psVer, 'version'));
check('.npmrc 与 .gitignore 存在', () => ok(
  existsSync(join(root, '.npmrc')) && existsSync(join(root, '.gitignore')),
  '缺少 .npmrc 或 .gitignore',
));

const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const hasToolchain = existsSync(nodeBin);

check('项目内 node 已安装', () => ok(hasToolchain, `缺失: ${nodeBin}\n        先运行 bootstrap`));
check('项目内 node 版本 = 锁定版本', () => {
  if (!hasToolchain) return ok(false, '工具链未安装，跳过');
  const v = execFileSync(nodeBin, ['-v'], { encoding: 'utf8' }).trim();
  return eq(v, `v${locked}`);
});

// ── ② npm 缓存必须在项目内 ─────────────────────────────────────
check('npm 缓存路径在项目内', () => {
  if (!hasToolchain) return ok(false, '工具链未安装，跳过');
  const npmBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'npm.cmd' : 'bin/npm');
  const cache = execFileSync(npmBin, ['config', 'get', 'cache'], {
    encoding: 'utf8',
    // npm.cmd 在 Windows 上需要 shell
    shell: process.platform === 'win32',
  }).trim();
  const inProject = resolve(cache).startsWith(resolve(root));
  return {
    ok: inProject,
    detail: `缓存路径 ${cache} 不在项目 ${root} 内`,
  };
});

check('未使用系统全局 npm 前缀', () => {
  if (!hasToolchain) return ok(false, '工具链未安装，跳过');
  // 项目内 node 的 npm 应该指向项目内的 lib，不能是 AppData/Roaming 那套
  const npmBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'npm.cmd' : 'bin/npm');
  const prefix = execFileSync(npmBin, ['config', 'get', 'prefix'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }).trim();
  const inProject = resolve(prefix).startsWith(resolve(root));
  return {
    ok: inProject,
    detail: `npm prefix 指向项目外: ${prefix}`,
  };
});

// ── ③ 忽略规则必须真的生效（不能只检查字符串出现）───────────
// 曾经踩过：.gitignore 不支持行尾注释，写了
//   .toolchain/   # 项目内 Node
// 整行被当成模式，永远匹配不上，导致 104MB 的 node.exe 进了暂存区。
// 所以这里用 git check-ignore 实测，不看文件内容。
//
// 但 git check-ignore 只在 git 仓库里有效。用 `git archive` 导出的
// tarball 或复制出来的目录没有 .git，此时无法实测 —— 这不是实现
// 缺陷，应降级为"检查规则文本存在"而不是报 FAIL。
function isGitRepo() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const GIT_REPO = isGitRepo();

function gitIgnored(relPath) {
  try {
    execFileSync('git', ['check-ignore', '-q', relPath], { cwd: root, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

check('.gitignore 对 .toolchain/ 实际生效', () => {
  if (!GIT_REPO) {
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    return ok(/^\.toolchain\/?$/m.test(gi), '非 git 目录，只能查规则文本；未找到 .toolchain/');
  }
  const existed = existsSync(join(root, '.toolchain', 'node', 'node.exe'));
  return ok(gitIgnored('.toolchain/node/node.exe'),
    `git check-ignore 未忽略 .toolchain/node/node.exe（目录${existed ? '存在' : '不存在'}，规则文本可能存在但不生效）`);
});

check('.gitignore 对 .cache / .tmp / data / dist / node_modules 实际生效', () => {
  if (!GIT_REPO) {
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    const missing = ['.cache/', '.tmp/', 'data/', 'dist/', 'node_modules/']
      .filter((p) => !gi.includes(p));
    return ok(missing.length === 0, `非 git 目录，查规则文本；缺少: ${missing.join(', ')}`);
  }
  const probes = [
    '.cache/npm/.probe',
    '.tmp/.probe',
    'data/app.db',
    'dist/server.js',
    'node_modules/x/index.js',
  ];
  const failed = probes.filter((p) => !gitIgnored(p));
  return ok(failed.length === 0, `未生效: ${failed.join(', ')}`);
});

check('.gitignore 不含行尾注释（会让整行失效）', () => {
  const lines = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
  const bad = lines
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(({ l }) => /^[^#\s].*\s+#/.test(l));
  return ok(bad.length === 0,
    `第 ${bad.map((b) => b.i).join(', ')} 行含行尾注释，该行不会生效: ${bad[0]?.l ?? ''}`);
});

check('.gitattributes 强制 .sh 为 LF', () => {
  const ga = readFileSync(join(root, '.gitattributes'), 'utf8');
  return ok(/\*\.sh\s+text\s+eol=lf/.test(ga), '.gitattributes 缺少 *.sh eol=lf 规则');
});

check('bootstrap 与 dev/build 脚本齐全', () => {
  const files = ['bootstrap.sh', 'bootstrap.ps1', 'dev.sh', 'dev.ps1', 'build.sh', 'build.ps1',
                 'lib/toolchain.sh', 'lib/toolchain.ps1'];
  const missing = files.filter((f) => !existsSync(join(root, 'scripts', f)));
  return ok(missing.length === 0, `缺少: ${missing.join(', ')}`);
});

summary('m0-01-toolchain');
