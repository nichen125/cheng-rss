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

function bundledSql(): string | null {
  // typeof 对未声明标识符不会抛 ReferenceError
  return typeof __SQL_0001_INIT__ === 'string' ? __SQL_0001_INIT__ : null;
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
  switch (name) {
    case '0001_init.sql': {
      const bundled = bundledSql();
      return bundled ?? loadFromFs(name);
    }
    default:
      throw new Error(`未登记的迁移文件: ${name}`);
  }
}
