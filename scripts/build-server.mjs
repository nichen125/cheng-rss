#!/usr/bin/env node
// 服务端打包：esbuild 把 TS 打成单个 bundle。
//
// 格式必须是 CJS，原因（实测）：SEA 的 main 由 embedderRunCjs 执行，
// 产出 ESM bundle 会直接报 "Cannot use import statement outside a module"。
// 这是 Node 24 的 SEA 实现限制，不是配置问题。
//
// 代价：CJS 下没有 import.meta，需要 banner 注入 shim。
//
// 关键点（PLAN §4.1）：
//   · 迁移 SQL 内嵌：define 注入字符串常量
//   · node:* 全部 external —— 运行时自带
//   · __CHENG_RSS_SEA__ 告诉 static.ts 自己是否在二进制里
import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'dist/server.cjs');

const isSea = process.argv.includes('--sea');

// 迁移 SQL → 字符串常量
const migrationsDir = join(root, 'src/server/db/migrations');
const defines = {};
if (existsSync(migrationsDir)) {
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql'))) {
    const key = `__SQL_${f.replace(/\.sql$/, '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}__`;
    defines[key] = JSON.stringify(readFileSync(join(migrationsDir, f), 'utf8'));
  }
}
defines['__CHENG_RSS_SEA__'] = isSea ? 'true' : 'false';

// 版本号也内嵌，二进制运行时读不到 package.json
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
defines['__CHENG_RSS_VERSION__'] = JSON.stringify(String(pkg.version ?? '0.0.0'));

await build({
  entryPoints: [join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: outFile,
  minify: isSea,
  sourcemap: isSea ? false : 'inline',
  external: ['node:*'],
  define: defines,
  banner: {
    // CJS 下 import.meta 不存在。注入一个 shim，让源码里
    // import.meta.url 的引用在打包后仍能工作。
    js: [
      '// cheng-rss bundled server',
      'const __metaUrl = require("node:url").pathToFileURL(__filename).href;',
    ].join('\n'),
  },
  // 把裸 import.meta 替换掉：esbuild 不支持直接改 import.meta.url，
  // 但源码里只在 migration-sql.ts 用过，那里已用 try/__dirname 兜底，
  // 所以这里只需让 esbuild 不报错（保持 warning 而不是 error）。
  logLevel: 'warning',
});

const size = statSync(outFile).size;
console.log(`服务端 bundle: dist/server.cjs ${(size / 1024).toFixed(0)} KB` + (isSea ? ' (minified)' : ''));

const zip = join(root, 'dist/client.zip');
if (existsSync(zip)) {
  console.log(`前端 zip: dist/client.zip ${(statSync(zip).size / 1024).toFixed(0)} KB`);
}

