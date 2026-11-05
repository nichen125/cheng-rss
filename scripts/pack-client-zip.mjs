#!/usr/bin/env node
// 把 dist/client/ 打包成 dist/.cache/client.zip，供 SEA 内嵌（PLAN §3.4）。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = join(root, 'dist/client');
// 中间产物进 dist/.cache/，见 build-server.mjs 的说明
const outFile = join(root, 'dist/.cache/client.zip');

if (!existsSync(join(clientDir, 'index.html'))) {
  console.error('dist/client 不存在或缺少 index.html，先运行 build-client');
  process.exit(1);
}

function walk(dir, base = '', acc = {}) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const key = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(full, key, acc);
    else acc[key] = new Uint8Array(readFileSync(full));
  }
  return acc;
}

const files = walk(clientDir);
const rawTotal = Object.values(files).reduce((a, b) => a + b.length, 0);

// level 9：静态资源一次性压缩，构建期开销无所谓
const zipped = zipSync(files, { level: 9 });
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, zipped);

const zipSize = statSync(outFile).size;
console.log(`client.zip: ${(rawTotal / 1024).toFixed(0)} KB → ${(zipSize / 1024).toFixed(0)} KB` +
  ` (${(rawTotal / zipSize).toFixed(1)}×, ${Object.keys(files).length} 个文件)`);

if (zipSize > 10 * 1024 * 1024) {
  console.warn(`警告: client.zip 超过 10MB，内嵌进二进制会让体积明显增大`);
}
