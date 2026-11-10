import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 迁移 SQL 的加载策略（PLAN §4.1 要求内嵌）：
//
//   源码模式  → 运行时从 src/server/db/migrations/ 读文件
//   打包模式  → esbuild 的 text loader 把内容变成字符串常量注入
//
// 用「是否被 esbuild 定义过」来区分，而不是靠 NODE_ENV 之类的运行时标志 ——
// 后者在二进制里容易配错，前者是编译期事实。
//
// esbuild 会在 bundle 时替换为字符串常量（见 scripts/build-server.mjs）。
// 声明可选类型：源码模式下这两个标识符不存在，typeof 检查为 'undefined'。
declare const __SQL_0001_INIT__: string | undefined;
declare const __SQL_0002_DEDUPE_VECTORS__: string | undefined;
declare const __SQL_0003_ANALYSIS_FINGERPRINT__: string | undefined;
declare const __SQL_0004_DIGEST_DAY_KEY__: string | undefined;
declare const __SQL_0005_DIGEST_CITES__: string | undefined;
declare const __SQL_0006_SUMMARIES__: string | undefined;
declare const __SQL_0007_FEED_SORT__: string | undefined;
declare const __SQL_0008_DIGEST_DAY_KEY_BACKFILL__: string | undefined;
declare const __SQL_0009_AI_SELFTEST__: string | undefined;
declare const __SQL_0010_DIGEST_RUNS__: string | undefined;

/**
 * 按文件名查内嵌 SQL。
 *
 * 每加一个迁移都要在这里登记 —— 漏登记的症状是"源码模式正常、二进制里报找不到"，
 * 而那条错误只在发布产物上出现。m0-08 的产物验证会跑到真实迁移，能挡住。
 */
function bundledSqlFor(name: string): string | null {
  switch (name) {
    case '0001_init.sql':
      return typeof __SQL_0001_INIT__ === 'string' ? __SQL_0001_INIT__ : null;
    case '0002_dedupe_vectors.sql':
      return typeof __SQL_0002_DEDUPE_VECTORS__ === 'string' ? __SQL_0002_DEDUPE_VECTORS__ : null;
    case '0004_digest_day_key.sql':
      return typeof __SQL_0004_DIGEST_DAY_KEY__ === 'string' ? __SQL_0004_DIGEST_DAY_KEY__ : null;
    case '0005_digest_cites.sql':
      return typeof __SQL_0005_DIGEST_CITES__ === 'string' ? __SQL_0005_DIGEST_CITES__ : null;
    case '0003_analysis_fingerprint.sql':
      return typeof __SQL_0003_ANALYSIS_FINGERPRINT__ === 'string' ? __SQL_0003_ANALYSIS_FINGERPRINT__ : null;
    case '0006_summaries.sql':
      return typeof __SQL_0006_SUMMARIES__ === 'string' ? __SQL_0006_SUMMARIES__ : null;
    case '0007_feed_sort.sql':
      return typeof __SQL_0007_FEED_SORT__ === 'string' ? __SQL_0007_FEED_SORT__ : null;
    case '0008_digest_day_key_backfill.sql':
      return typeof __SQL_0008_DIGEST_DAY_KEY_BACKFILL__ === 'string'
        ? __SQL_0008_DIGEST_DAY_KEY_BACKFILL__ : null;
    case '0009_ai_selftest.sql':
      return typeof __SQL_0009_AI_SELFTEST__ === 'string' ? __SQL_0009_AI_SELFTEST__ : null;
    case '0010_digest_runs.sql':
      return typeof __SQL_0010_DIGEST_RUNS__ === 'string' ? __SQL_0010_DIGEST_RUNS__ : null;
    default:
      return null;
  }
}

// 源码模式下定位 migrations 目录。
// 本文件位于 src/server/db/，所以 migrations 就在同级。
// 打包后 import.meta.url 会被注入的 shim 替代成 bundle 所在位置，
// 但我们不用它找文件 —— 打包时 SQL 已通过 define 变成常量。
function currentDir(): string {
  try {
    // 打包成 CJS 时 import.meta 不存在，用 __dirname（esbuild 会保留）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyGlobal = globalThis as any;
    if (typeof anyGlobal.__dirname === 'string') return anyGlobal.__dirname;
  } catch { /* ignore */ }
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}
const HERE = currentDir();

function loadFromFs(name: string): string {
  const candidates = [
    join(HERE, 'migrations', name),
    // 编译到 dist/ 后路径会变，多试几处
    join(HERE, '..', '..', '..', 'src/server/db/migrations', name),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error(
    `找不到迁移文件 ${name}。已尝试:\n  ${candidates.join('\n  ')}\n` +
    `若这是打包产物，说明 esbuild 未注入 __SQL_*__ 常量。`,
  );
}

export function loadMigrationSql(name: string): string {
  const bundled = bundledSqlFor(name);
  if (bundled !== null) return bundled;

  // 源码模式：__SQL_*__ 常量不存在，直接读文件。
  //
  // 这里**不再维护一份文件名白名单**。早先写的是
  //   if (name === '0001_init.sql' || name === '0002_...') return loadFromFs(name);
  // 于是每加一个迁移都要同时改两处（这里的白名单 + migration-sql 顶部的
  // switch），漏改哪一处都只在某个运行模式下炸。加 0003 时就是漏了这一处，
  // 症状是源码模式报"未登记的迁移文件"，而文件明明在那儿。
  //
  // 判据改成"bundled 里没有就去磁盘上找"：打包模式下磁盘上没有 migrations
  // 目录，loadFromFs 会带着完整的尝试路径抛错，那正是需要的诊断信息。
  try {
    return loadFromFs(name);
  } catch (e) {
    throw new Error(
      `迁移文件 ${name} 既没有内嵌进 bundle，也不在磁盘上。\n` +
      `打包模式下要检查 scripts/build-server.mjs 是否把它注入了；\n` +
      `${(e as Error).message}`,
    );
  }
}
