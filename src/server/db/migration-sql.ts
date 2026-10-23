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
// esbuild 会在 bundle 时替换：
//   0001_init.sql  →  const __SQL_0001__ = "CREATE TABLE ...";
declare const __SQL_0001__: string | undefined;

const IS_BUNDLED = typeof __SQL_0001__ === 'string';

// 源码模式下定位 migrations 目录。本文件位于 src/server/db/，
// 所以 migrations 就在同级。
const HERE = dirname(fileURLToPath(import.meta.url));

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
    case '0001_init.sql':
      return IS_BUNDLED ? (__SQL_0001__ as string) : loadFromFs(name);
    default:
      throw new Error(`未登记的迁移文件: ${name}`);
  }
}
