#!/usr/bin/env node
// Docker 构建路径的本地验证。
//
// 本机没有 docker 时，无法真正 `docker build`。但 Dockerfile 的每一步
// 都是可独立验证的命令 —— 这个脚本逐条模拟，把"没装工具"和
// "Dockerfile 写错了"区分开。
//
// 判定：
//   · 每条前置条件成立 → Dockerfile 逻辑正确
//   · 任何一条不成立 → Dockerfile 有问题，即使有 docker 也会失败
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');

group('Docker 构建路径（本地模拟）');

const dfPath = join(root, 'Dockerfile');
if (!existsSync(dfPath)) {
  check('Dockerfile 存在', () => ok(false, '缺失'));
  summary('docker-path');
  process.exit(1);
}

const df = readFileSync(dfPath, 'utf8');

// ── ① 结构检查 ─────────────────────────────────────────────
check('Dockerfile 有两个阶段（build + runtime）', () => {
  const stages = [...df.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)];
  return ok(stages.length >= 2, `只有 ${stages.length} 个 FROM`);
});

check('运行阶段不是 alpine（SEA 不支持 musl）', () => {
  const stages = df.split(/^FROM /m);
  const runtime = stages[stages.length - 1] ?? '';
  const base = /^\s*(\S+)/.exec(runtime)?.[1] ?? '';
  return ok(!/alpine/i.test(base), `运行阶段基础镜像是 ${base}，alpine 上 SEA 二进制跑不起来`);
});

check('构建阶段用 Node 24', () => {
  return ok(/FROM\s+node:24/.test(df), '构建阶段不是 node:24');
});

check('npm ci 用了项目内缓存目录', () => {
  return ok(/npm ci[^\n]*--cache/.test(df), 'npm ci 未指定 --cache，缓存会落到镜像层里');
});

check('运行阶段只 COPY 二进制（不复制 node_modules）', () => {
  const runtime = df.split(/^FROM /m).pop() ?? '';
  return ok(
    /COPY --from=build[^\n]*cheng-rss-linux-x64/.test(runtime) && !/COPY --from=build[^\n]*node_modules/.test(runtime),
    '运行阶段可能把 node_modules 也复制了',
  );
});

check('HEALTHCHECK 指向 doctor（会真读库）', () => {
  return ok(/HEALTHCHECK[\s\S]{0,200}doctor/.test(df), 'HEALTHCHECK 未使用 doctor');
});

check('以非 root 运行', () => {
  return ok(/^USER\s+(?!root)/m.test(df), '没有 USER 指令，容器会以 root 运行');
});

// ── ② Dockerfile 里跑的那几条命令，在本机能成立吗 ───────────
// 这是关键：如果命令本身有问题，有 docker 也会失败。
const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-docker-'));
try {
  check('build-client.mjs 可执行', () => {
    return ok(existsSync(join(root, 'scripts/build-client.mjs')));
  });
  check('build-server.mjs 支持 --sea', () => {
    const src = readFileSync(join(root, 'scripts/build-server.mjs'), 'utf8');
    return ok(src.includes("'--sea'"), '不支持 --sea 参数');
  });
  check('pack-client-zip.mjs 可执行', () => {
    return ok(existsSync(join(root, 'scripts/pack-client-zip.mjs')));
  });
  check('build-sea.mjs 可执行且支持 --target', () => {
    const src = readFileSync(join(root, 'scripts/build-sea.mjs'), 'utf8');
    return ok(src.includes("'--target'"), '不支持 --target');
  });

  // 真正验证：用 linux node 当注入底本，在本机产出 linux ELF
  // 这正是 Dockerfile 里 build-sea 那一步做的事。
  //
  // 查找顺序：环境变量 → .tmp/linuxnode 缓存。
  // 自己找一遍是有必要的：用户常直接跑单个脚本调试，
  // 只靠 verify-all 传环境变量会让人误以为产物验证坏了。
  const cachePath = join(root, '.tmp/linuxnode/node-v24.13.0-linux-x64/bin/node');
  const linuxNode = process.env.CHENG_RSS_TEST_LINUX_NODE
    || (existsSync(cachePath) ? cachePath : null);
  if (linuxNode && existsSync(linuxNode)) {
    const out = execFileSync(nodeBin, [join(root, 'scripts/build-sea.mjs'), '--target', 'linux-x64'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CHENG_RSS_SEA_BASE: linuxNode },
      timeout: 300000,
    });
    const elf = join(root, 'dist/cheng-rss-linux-x64');
    check('能产出 linux-x64 ELF（Docker 构建的核心步骤）', () => {
      if (!existsSync(elf)) return ok(false, '未生成 dist/cheng-rss-linux-x64');
      const buf = readFileSync(elf).subarray(0, 4);
      // ELF magic: 0x7F 'E' 'L' 'F'
      const isElf = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
      return ok(isElf, `文件头不是 ELF: ${[...buf].map((b) => b.toString(16)).join(' ')}`);
    });
    check('ELF 内嵌了迁移 SQL', () => {
      const elf = join(root, 'dist/cheng-rss-linux-x64');
      if (!existsSync(elf)) return ok(false, '二进制不存在');
      const content = readFileSync(elf);
      return ok(content.includes(Buffer.from('CREATE TABLE entries')), '二进制里找不到迁移 SQL');
    });
    check('ELF 体积合理（node + ~1MB）', () => {
      const elf = join(root, 'dist/cheng-rss-linux-x64');
      const base = statSync(linuxNode).size;
      const size = statSync(elf).size;
      const delta = size - base;
      return ok(delta > 50_000 && delta < 5_000_000,
        `比基础 node 大 ${(delta / 1024).toFixed(0)} KB，预期 50KB~5MB（前端 zip + bundle）`);
    });
    void out;
  } else {
    // 不静默跳过：最核心的三条没验，必须让汇总能看出来。
    // 只打一行 SKIP 却让汇总显示 "11/11 PASS" 是误导 ——
    // 读者会以为 Docker 路径已被完整验证。
    process.stdout.write(
      '  \u001b[33mSKIP\u001b[0m  ELF 产出验证（未提供 CHENG_RSS_TEST_LINUX_NODE）\n' +
      '        → 产物验证未执行，以下断言未计入\n' +
      '          启用方式: CHENG_RSS_TEST_LINUX_NODE=/path/to/linux-node node scripts/verify/docker-path.mjs\n' +
      '          （scripts/verify-all.mjs 会自动在 .tmp/linuxnode 下查找）\n',
    );
    check('ELF 产物验证已执行（不允许静默跳过）', () => {
      return ok(false,
        '核心验证被跳过：无法确认 Dockerfile 的 build-sea 那一步真能产出 linux ELF。' +
        '当前只验证了 Dockerfile 结构，不等于构建路径可用。');
    });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

summary('docker-path');
