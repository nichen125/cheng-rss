#!/usr/bin/env node
// 单一入口（PLAN §4.1 第 5 点）。
//
// 子命令：serve | worker | migrate | doctor | version | mcp | export | import
//
// 注意：本文件是唯一的进程入口，三条部署路径（源码/二进制/Docker）
// 都从这里开始，保证行为同源（PLAN §4.5）。

import { runCli } from './cli.ts';

runCli(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
