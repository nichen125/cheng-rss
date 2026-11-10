#!/usr/bin/env node
// 跑 tests/ 下的全部单元测试。
//
// 为什么要这个外壳，而不是直接 `node --test tests/**/*.test.ts`：
//   1. glob 由 shell 展开，Windows 上 cmd/npm 不展开，测试一个都跑不到却"成功"；
//   2. `node --test` 收到空 glob 时按默认规则扫描，可能跑到别处的 file；
//   3. 没有测试文件时必须失败——"0 个测试也算通过"会让 CI 空转。
//
// 因此这里自己递归枚举、显式把文件列表传给 node，并原样透传它的退出码。
//
// 用法:
//   node scripts/run-tests.mjs
//   node scripts/run-tests.mjs --test-reporter=spec   # 其余参数原样透传
//
// 退出码：有测试文件时为 node --test 的退出码；一个测试文件都没有时为 1。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const TESTS_DIR = 'tests';
const SUFFIX = '.test.ts';

// 只认 .test.ts：.test.js、.spec.ts 与 fixtures 里的普通 .ts 都不是测试入口。
function collectTests(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found; // 目录不存在等同于没有测试
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectTests(full));
    else if (entry.isFile() && entry.name.endsWith(SUFFIX)) found.push(full);
  }
  return found;
}

const files = collectTests(TESTS_DIR).sort();
const args = process.argv.slice(2);

if (files.length === 0) {
  console.error(`run-tests: ${TESTS_DIR}/ 下没有 *${SUFFIX} 文件，按失败处理`);
  process.exit(1);
}

// 用当前解释器而不是裸 `node`，保证与调用方同一个 Node 版本。
const result = spawnSync(
  process.execPath,
  ['--test', '--experimental-strip-types', ...args, ...files],
  { stdio: 'inherit' },
);

// result.error 说明根本没启动起来（如 ENOENT），此时 status 为 null，
// 不能当成 0；统一折成 1，避免"进程没跑"被误读成通过。
if (result.error) {
  console.error(`run-tests: 无法启动 node --test: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
