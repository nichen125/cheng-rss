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

// 调 npm 一律用「node 执行 npm-cli.js」，不用 bin/npm。
//
// bin/npm 是 `#!/usr/bin/env node`，要求 PATH 里有 node。本机开发时
// PATH 里通常有，所以这个 bug 平时完全看不出来；CI 的 step 里没有，
// 直接 127。**验收脚本自己也踩了这个坑** —— 在修 workflow 的时候漏了它，
// 于是 m0-01 / m0-11 在 ubuntu 上红，而在本机永远是绿的。
//
// 路径两平台不同（这正是本轮反复踩的同一件事）：
//   Windows 包（扁平）   node_modules/npm/bin/npm-cli.js
//   Linux  包（有 lib）  lib/node_modules/npm/bin/npm-cli.js
function findNpmCli() {
  const a = join(root, '.toolchain/node/lib/node_modules/npm/bin/npm-cli.js');
  const b = join(root, '.toolchain/node/node_modules/npm/bin/npm-cli.js');
  if (existsSync(a)) return a;
  if (existsSync(b)) return b;
  return null;
}
const npmCli = findNpmCli();

/** 用项目内 node 跑一次 npm 子命令，返回 stdout（已 trim）。 */
function npmGet(args) {
  return execFileSync(nodeBin, [npmCli, ...args], { encoding: 'utf8' }).trim();
}

check('项目内 node 已安装', () => ok(hasToolchain, `缺失: ${nodeBin}\n        先运行 bootstrap`));
check('项目内 node 版本 = 锁定版本', () => {
  if (!hasToolchain) return ok(false, '工具链未安装，跳过');
  const v = execFileSync(nodeBin, ['-v'], { encoding: 'utf8' }).trim();
  return eq(v, `v${locked}`);
});

check('能找到 npm-cli.js（两种布局都试过）', () => {
  if (!hasToolchain) return ok(false, '工具链未安装，跳过');
  return ok(Boolean(npmCli),
    '两种布局都没有：lib/node_modules/npm/bin/npm-cli.js 与 node_modules/npm/bin/npm-cli.js');
});

// ── ② npm 缓存必须在项目内 ─────────────────────────────────────
check('npm 缓存路径在项目内', () => {
  if (!hasToolchain) return ok(false, '工具链未安装，跳过');
  if (!npmCli) return ok(false, '找不到 npm-cli.js');
  const cache = npmGet(['config', 'get', 'cache']);
  const inProject = resolve(cache).startsWith(resolve(root));
  return {
    ok: inProject,
    detail: `缓存路径 ${cache} 不在项目 ${root} 内`,
  };
});

check('未使用系统全局 npm 前缀', () => {
  if (!hasToolchain) return ok(false, '工具链未安装，跳过');
  if (!npmCli) return ok(false, '找不到 npm-cli.js');
  // 项目内 node 的 npm 应该指向项目内的 lib，不能是 AppData/Roaming 那套
  const prefix = npmGet(['config', 'get', 'prefix']);
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
                 'lib/toolchain.sh', 'lib/toolchain.ps1', 'ci-env.sh'];
  const missing = files.filter((f) => !existsSync(join(root, 'scripts', f)));
  return ok(missing.length === 0, `缺少: ${missing.join(', ')}`);
});

// ── CI 用的 npm 入口必须两平台都能找到 ────────────────────────
//
// 这条是两次踩坑的固化。npm 的 JS 入口在官方包里位置不同：
//   Windows 包（zip，扁平）   node_modules/npm/bin/npm-cli.js
//   Linux  包（tar.xz）       lib/node_modules/npm/bin/npm-cli.js
//
// 第一版 CI 写死 Windows 那个路径，Linux 上必然 MODULE_NOT_FOUND；
// 而本机是 Windows，本地怎么测都是绿的 —— 这正是"一个平台绿、
// 另一个平台红"的标准形态。
//
// 断言的是**探测函数本身**，不是当前平台的结果：直接调用
// toolchain.sh 里的 npm_cli_path，喂两种布局的假目录，看它认不认。
check('toolchain.sh 能识别两种 npm 布局（扁平 / lib）', () => {
  const sh = join(root, 'scripts/lib/toolchain.sh');
  const src = readFileSync(sh, 'utf8');
  if (!/npm_cli_path\s*\(\)/.test(src)) {
    return ok(false, 'toolchain.sh 里没有 npm_cli_path()，CI 无从得知 npm 入口在哪');
  }
  // 两条路径都得在函数里出现，缺一个就意味着另一种平台会失败
  const hasFlat = src.includes('$NODE_DIR/node_modules/npm/bin/npm-cli.js');
  const hasLib = src.includes('$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js');
  return ok(hasFlat && hasLib,
    `缺 ${[!hasLib && 'lib/ 布局', !hasFlat && '扁平布局'].filter(Boolean).join(' 与 ')}`);
});

check('ci-env.sh 导出 NODE_BIN 与 NPM_CLI，且不依赖 PATH', () => {
  const p = join(root, 'scripts/ci-env.sh');
  if (!existsSync(p)) return ok(false, 'scripts/ci-env.sh 不存在');
  const src = readFileSync(p, 'utf8');
  const exportsBoth = src.includes('NODE_BIN=') && src.includes('NPM_CLI=');
  // 只查非注释行：文件头的注释里本来就会提到 $GITHUB_PATH 并解释为什么不用它，
  // 用全文匹配会把解释当成违规（第一版断言就红在这，红在一个正确行为上）。
  const code = src.split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  const touchesPath = /GITHUB_PATH/.test(code);
  return ok(exportsBoth && !touchesPath,
    !exportsBoth ? '没导出 NODE_BIN / NPM_CLI'
      : '写了 $GITHUB_PATH —— 应改为导出具体路径，避免路径形态差异');
});

check('workflow 里没有手写的 toolchain 相对路径', () => {
  const dir = join(root, '.github/workflows');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
  const bad = [];
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    // 这两类写法都是"猜路径"，两平台形态不同必然在一边失败
    if (/NODE=\.\/\.toolchain\/node\/bin\/node/.test(src)) {
      bad.push(`${f}: 手写 NODE=.../bin/node`);
    }
    if (/\.toolchain\/node\/node_modules\/npm\/bin\/npm-cli\.js/.test(src)) {
      bad.push(`${f}: 写死扁平 node_modules 布局`);
    }
  }
  return ok(bad.length === 0, bad.join('; '));
});

// 验收脚本自己也不许犯同样的错。
//
// 这条是补上来的：修 workflow 的时候漏了 scripts/verify/ 里的两处，
// 于是 m0-01 / m0-11 在 ubuntu 上红、在本机永远绿 —— 而这两个脚本
// 恰恰是"验证工具链正确"的那两个，它们自己错了最讽刺。
check('验收脚本里没有 bin/npm 或写死的扁平布局', () => {
  const dir = join(root, 'scripts/verify');
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  const bad = [];
  for (const f of files) {
    if (f === 'harness.mjs') continue;
    const src = readFileSync(join(dir, f), 'utf8');
    // 只看非注释行：注释里解释这个坑是好事，不该被罚
    const code = src.split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n');
    if (/'bin\/npm'|"bin\/npm"|'npm\.cmd'|"npm\.cmd"/.test(code)) {
      bad.push(`${f}: 调 bin/npm（Linux 上 127）`);
    }
    // 单写扁平布局且没有 lib/ 分支 → 探测缺失
    if (/\.toolchain\/node\/node_modules\/npm\/bin\/npm-cli\.js/.test(code)
        && !/lib\/node_modules\/npm\/bin\/npm-cli\.js/.test(code)) {
      bad.push(`${f}: 写死扁平布局（缺 lib/ 探测）`);
    }
  }
  return ok(bad.length === 0, bad.join('; '));
});

summary('m0-01-toolchain');
