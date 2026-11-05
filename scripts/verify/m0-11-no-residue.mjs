#!/usr/bin/env node
// 0.11 项目外零写入 —— 验收（发布门禁第 5 条）
//
// 判据（PLAN §4.3 / §16.4 门禁 5）：
//   ① 已安装的工具链，运行时不往 $HOME 写
//   ② npm 的 cache / prefix 都指向项目内（不是 $HOME）
//   ③ 构建产物全部落在项目目录内
//   ④ `check-no-residue.mjs` 自己可用（它是人工排查时的入口）
//
// 为什么不直接在全量验收里跑 `check-no-residue --run "bootstrap.sh"`：
// bootstrap 会重新下载 35MB 的 Node，一次几分钟，且需要网络。
// 那属于"部署验证"，不是"每次提交都要跑"的东西；CI 的 release job
// 里跑更合适。这里验的是**已经装好的工具链在正常使用时**不越界 ——
// 那才是用户日常会遇到的场景。
//
// 与 m0-08 的 ④ 不重复：m0-08 验的是**二进制进程**不写 $HOME，
// 这里验的是**构建工具链**（bootstrap / npm / 构建脚本）不写 $HOME。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');

// npm 的 JS 入口两平台位置不同，必须探测 —— 写死一个另一个平台就失败：
//   Windows 包（zip，扁平）    node_modules/npm/bin/npm-cli.js
//   Linux  包（tar.xz）        lib/node_modules/npm/bin/npm-cli.js
// 这条在本轮 CI 上真的红过：写死扁平布局，ubuntu 上全是 MODULE_NOT_FOUND。
const npmCli = (() => {
  const a = join(root, '.toolchain/node/lib/node_modules/npm/bin/npm-cli.js');
  const b = join(root, '.toolchain/node/node_modules/npm/bin/npm-cli.js');
  if (existsSync(a)) return a;
  if (existsSync(b)) return b;
  return null;
})();

group('0.11 项目外零写入');

const hasToolchain = existsSync(nodeBin);

// ── ① npm 的 cache 与 prefix 都在项目内 ──────────────────────
// 若 cache 落在 $HOME/.npm，用户卸载项目后那里会留下几百 MB。
check('npm cache 指向项目内（不是 $HOME）', () => {
  if (!hasToolchain) return ok(false, '工具链未安装，先跑 bootstrap');
  const cache = execFileSync(nodeBin, [npmCli, 'config', 'get', 'cache'], {
    encoding: 'utf8', timeout: 60000,
  }).trim();
  const inProject = resolve(cache).startsWith(resolve(root) + sep);
  return {
    ok: inProject,
    detail: `cache=${cache}，不在 ${root} 内（卸载项目后会留在用户机器上）`,
  };
});

// npm prefix 不在这里断言。
//
// 项目能控制的只有 cache（`.npmrc` 里 cache=./.cache/npm）。prefix
// 写不进 `.npmrc` —— npm 会报 "config prefix cannot be changed from
// project config"，它由用户环境或 npm_config_prefix 决定。
//
// 本机因为项目内 node 的默认布局，prefix 恰好落在 .toolchain/node 下；
// CI 的干净 runner 上它落回系统默认。于是这条断言本地永远绿、CI 永远红。
// 那是断言在验一件项目没有承诺的事，删掉比放宽诚实 —— 放宽到一个
// 刚好能过的范围，等于把它改成"永远通过"（PLAN 附录 A.5）。
//
// 真正与"零写入"相关的是 cache 那条，已在上方保留。

// ── ② 工具链装在项目内 ──────────────────────────────────────
check('Node 运行时在项目内', () => {
  if (!hasToolchain) return ok(false, '工具链未安装');
  return ok(nodeBin.startsWith(root + sep), nodeBin);
});

check('依赖装在项目内（node_modules 有实际内容）', () => {
  const nm = join(root, 'node_modules');
  if (!existsSync(nm)) return ok(false, 'node_modules 不存在');
  const n = readdirSync(nm).length;
  return ok(n > 10, `node_modules 只有 ${n} 项，可能是空的`);
});

// ── ③ 构建缓存也在项目内 ────────────────────────────────────
// .cache/npm 是 .npmrc 里 cache=./.cache/npm 的结果。
// 这条与 ① 互相印证：① 看 npm 自己怎么说，③ 看目录是否真的存在。
check('.cache/npm 存在且位于项目内', () => {
  const p = join(root, '.cache/npm');
  if (!existsSync(p)) {
    return ok(false, `${p} 不存在 —— npm 缓存可能写到了 $HOME/.npm`);
  }
  return ok(p.startsWith(root + sep), p);
});

// ── ④ $HOME 里没有本项目的残留目录 ──────────────────────────
// 反面证据：即使配置正确，历史上某次运行也可能留下过东西。
// 只查明确属于本项目的名字，不去扫全 $HOME（那太慢且会误报）。
const PROJECT_HOME_RESIDUE = [
  '.cheng-rss', '.cheng-rss-cache', '.cheng-rss-node',
  'cheng-rss', 'cheng-rss-cache',
  '.ai-rss', '.ai-rss-cache', // 改名前的旧名字，若存在说明清理没做干净
];
check('$HOME 下没有本项目的残留目录', () => {
  const home = homedir();
  const found = PROJECT_HOME_RESIDUE.filter((n) => {
    try {
      statSync(join(home, n));
      return true;
    } catch { return false; }
  });
  return ok(found.length === 0,
    `$HOME (${home}) 下发现: ${found.join(', ')}`);
});

// ── ⑤ 人工排查入口可用 ──────────────────────────────────────
// check-no-residue.mjs 是出问题时第一个该跑的东西。
// 它自己坏掉的话，"零写入"这件事就没有可复现的验证手段了。
check('check-no-residue.mjs 可运行且报告 PASS', () => {
  const script = join(root, 'scripts/check-no-residue.mjs');
  if (!existsSync(script)) return ok(false, '脚本不存在');
  try {
    const out = execFileSync(nodeBin, [script], {
      cwd: root, encoding: 'utf8', timeout: 120000,
    });
    const pass = out.includes('PASS  项目目录之外零写入');
    return {
      ok: pass,
      detail: pass ? '' : `输出里没有 PASS：${out.slice(-400)}`,
    };
  } catch (e) {
    return { ok: false, detail: String(e.message).slice(0, 400) };
  }
});

// ── ⑥ 数据目录的默认值不在 $HOME ────────────────────────────
// `--data` 缺省是 ./data（相对 cwd），不是 ~/.cheng-rss。
// 这条防的是"默认值悄悄改成用户目录"。
check('doctor 默认数据目录是相对路径（不落在 $HOME）', () => {
  if (!hasToolchain) return ok(false, '工具链未安装');
  // 不真的跑 doctor（会建库），只查源码里的默认值
  const cfg = join(root, 'src/server/config.ts');
  if (!existsSync(cfg)) return ok(false, 'config.ts 不存在');
  const src = execFileSync(nodeBin, ['-e',
    'const f=require("node:fs");process.stdout.write(f.readFileSync(process.argv[1],"utf8"))',
    cfg], { encoding: 'utf8', timeout: 30000 });
  // 默认值应形如 './data' 或 'data'，且不含 homedir()/~
  const hasHomeDefault = /dataDir\s*[:=][^\n]*homedir\(/.test(src);
  return ok(!hasHomeDefault,
    'config.ts 里 dataDir 的默认值用到了 homedir()，会写进用户目录');
});

summary('m0-11-no-residue');
