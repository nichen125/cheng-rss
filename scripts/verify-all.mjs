#!/usr/bin/env node
// 全部验收脚本的统一入口。
//
// 用法:
//   node scripts/verify-all.mjs            # 跑全部
//   node scripts/verify-all.mjs m0-0[5-8]  # 只跑匹配的
//   node scripts/verify-all.mjs --no-docker-path
//
// 退出码：全部通过为 0，任一失败为 1。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');

if (!existsSync(nodeBin)) {
  console.error('项目内 node 缺失，先运行 scripts/bootstrap');
  process.exit(1);
}

const args = process.argv.slice(2);
const pattern = args.find((a) => !a.startsWith('--'));
const skipDocker = args.includes('--no-docker-path');

const verifyDir = join(root, 'scripts/verify');
let files = readdirSync(verifyDir)
  .filter((f) => f.endsWith('.mjs') && f !== 'harness.mjs')
  .sort();

if (pattern) {
  const re = new RegExp(pattern.replace(/[.+]/g, (c) => '\\' + c).replace(/\*/g, '.*'));
  files = files.filter((f) => re.test(f));
}
if (skipDocker) files = files.filter((f) => !f.startsWith('docker-'));

// 让 docker-path 能找到 linux node。
//
// 默认**不自动下载**：这份 node 约 25MB，实测本机网络要十几分钟，
// 离线环境更会卡死。自动下载会让"跑一次验收"变得不可用。
//
// 策略：
//   · 已有 .tmp/linuxnode 或 AI_RSS_TEST_LINUX_NODE → 跑产物验证
//   · 没有 → docker-path 报 FAIL（"未执行"不等于"通过"），
//     除非加 --allow-skip-docker-artifact 明确接受
//   · 想完整验证：node scripts/fetch-linux-node.mjs 一次，之后走缓存
const LINUX_NODE = join(root, '.tmp/linuxnode/node-v24.13.0-linux-x64/bin/node');
const linuxNode = process.env.AI_RSS_TEST_LINUX_NODE
  || (existsSync(LINUX_NODE) ? LINUX_NODE : null);

const allowSkipArtifact = args.includes('--allow-skip-docker-artifact');
if (!linuxNode && !skipDocker) {
  if (allowSkipArtifact) {
    // 用户明确接受跳过：把产物验证从列表里去掉，避免无意义的 FAIL
    files = files.filter((f) => !f.startsWith('docker-'));
    process.stdout.write(
      '\u001b[33m!\u001b[0m 按 --allow-skip-docker-artifact 跳过 Docker 产物验证。\n' +
      '  注意：这不等于构建路径已验证。要完整验证：node scripts/fetch-linux-node.mjs\n',
    );
  } else {
    process.stdout.write(
      '\u001b[33m!\u001b[0m 未找到 linux node，Docker 产物验证将报未执行（这是有意的）。\n' +
      '  完整验证：node scripts/fetch-linux-node.mjs   （约 25MB，只需一次）\n' +
      '  临时接受跳过：加 --allow-skip-docker-artifact\n',
    );
  }
}

const results = [];
const t0 = Date.now();

// 单个脚本的硬超时。
//
// 起因是一次实测的挂死：m1-26 在 `Page.reload` 之后紧接 `Runtime.evaluate`，
// 那条应答因为执行上下文被换掉而**永远不来**，Promise 一直 pending ——
// 于是整个串行验收停在那个脚本上，「跑了 20 分钟没有输出」看起来像机器卡了。
// 根因已在 `scripts/lib/cdp.mjs` 里修掉（每条 CDP 命令带超时），
// 但这里还要一道兜底：**任何**脚本将来以别的方式挂住，都不该让整套验收
// 变成静默的不返回。10 分钟够最慢的 m0-08（三路部署）跑完。
const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;

for (const f of files) {
  process.stdout.write(`\n\u001b[1m▶ ${f}\u001b[0m\n`);
  const started = Date.now();
  let ok = false;
  let attempts = 0;
  // 串行执行，且对"子进程类"脚本允许一次重试。
  //
  // 为什么允许重试：m0-03 的并发写、m0-04/08 的服务启停都依赖真实
  // 进程与端口。开发机上偶有残留句柄导致端口占用或 SQLITE_BUSY，
  // 这是环境抖动而非实现缺陷。重试一次仍失败才算失败 —— 但如果
  // 每次都失败，说明是真问题。
  const maxAttempts = 2;
  while (attempts < maxAttempts && !ok) {
    attempts++;
    try {
      execFileSync(nodeBin, [join(verifyDir, f)], {
        cwd: root,
        stdio: attempts === 1 ? 'inherit' : 'pipe',
        timeout: SCRIPT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        env: { ...process.env, ...(linuxNode ? { AI_RSS_TEST_LINUX_NODE: linuxNode } : {}) },
      });
      ok = true;
    } catch (e) {
      ok = false;
      // 超时要说出来。静默地把"挂死"记成一个普通 FAIL，
      // 下一个人会去翻断言，而那里什么都没有。
      if (e && (e.killed === true || e.signal === 'SIGKILL')) {
        process.stdout.write(
          `  \u001b[33m超时 ${(SCRIPT_TIMEOUT_MS / 1000).toFixed(0)}s 被强杀`
          + '（检查这个脚本是否卡在某个永不返回的调用上）\u001b[0m\n',
        );
      } else if (attempts < maxAttempts) {
        process.stdout.write(`  \u001b[33m重试一次（可能是环境抖动）\u001b[0m\n`);
      }
    }
  }
  results.push({ file: f, ok, ms: Date.now() - started, attempts });
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;

process.stdout.write('\n' + '─'.repeat(56) + '\n');
process.stdout.write(`\u001b[1m验收汇总\u001b[0m  ${results.length} 个脚本，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s\n\n`);
for (const r of results) {
  const mark = r.ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
  const retry = r.attempts > 1 ? `  \u001b[33m(第 ${r.attempts} 次)\u001b[0m` : '';
  process.stdout.write(`  ${mark}  ${r.file.padEnd(26)} ${(r.ms / 1000).toFixed(1)}s${retry}\n`);
}
process.stdout.write('\n');
if (fail === 0) {
  process.stdout.write(`\u001b[32m全部通过 ${pass}/${results.length}\u001b[0m\n`);
} else {
  process.stdout.write(`\u001b[31m${fail} 个脚本失败\u001b[0m\n`);
  process.exitCode = 1;
}
