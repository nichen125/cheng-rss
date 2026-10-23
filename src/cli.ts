import { existsSync, readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './server/app.ts';
import { openDb, readPragmas } from './server/db/client.ts';
import { migrate, MIGRATIONS, CURRENT_SCHEMA_VERSION, assertSchemaCompatible } from './server/db/migrate.ts';
import {
  loadConfig, ensureDataDirs, writeDefaultConfigIfAbsent, resolveDataDir,
  type RuntimeConfig,
} from './server/config.ts';
import { log, setLogLevel } from './server/logger.ts';

const VERSION = readVersion();

function readVersion(): string {
  try {
    // 源码模式下从 package.json 读；打包后 esbuild 会把这里 define 成常量
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const USAGE = `AI RSS —— 自托管 AI RSS 阅读分析器

用法: ai-rss <命令> [选项]

命令:
  serve     启动 HTTP 服务（含内联 job runner）
  worker    仅运行 job runner（配合 serve 时的 WORKER_INLINE=false）
  migrate   创建/升级数据库
  doctor    环境自检
  version   显示版本
  mcp       以 stdio 启动 MCP 服务器
  export    导出数据（tar.zst / jsonl / opml）
  import    导入数据

通用选项:
  --data <dir>    数据目录（默认 ./data）
  --port <n>      监听端口（默认 3000）
  --host <addr>   监听地址（默认 127.0.0.1）
  --quiet         只输出错误
  -h, --help      显示帮助
`;

interface Args {
  _: string[];
  data?: string;
  port?: number;
  host?: string;
  quiet: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], quiet: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--data': out.data = argv[++i]; break;
      case '--port': out.port = Number(argv[++i]); break;
      case '--host': out.host = argv[++i]; break;
      case '--quiet': out.quiet = true; break;
      case '-h': case '--help': out._.push('--help'); break;
      default:
        if (a.startsWith('--data=')) out.data = a.slice(7);
        else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
        else if (a.startsWith('--host=')) out.host = a.slice(7);
        else if (a.startsWith('-')) out.rest.push(a);
        else out._.push(a);
    }
  }
  return out;
}

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (!cmd || args._.includes('--help') || cmd === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  switch (cmd) {
    case 'version': return cmdVersion(args);
    case 'migrate': return cmdMigrate(args);
    case 'doctor': return cmdDoctor(args);
    case 'serve': return cmdServe(args);
    case 'worker': return cmdWorker(args);
    case 'mcp': return cmdMcp(args);
    case 'export': return cmdExport(args);
    case 'import': return cmdImport(args);
    default:
      console.error(`未知命令: ${cmd}\n`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

function cmdVersion(args: Args): void {
  if (args.quiet) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  process.stdout.write(`ai-rss ${VERSION}\n`);
  process.stdout.write(`node ${process.version}  ${process.platform}-${process.arch}\n`);
  process.stdout.write(`schema ${CURRENT_SCHEMA_VERSION}\n`);
}

function cmdMigrate(args: Args): void {
  const cfg = loadConfig({ dataDir: args.data });
  ensureDataDirs(cfg.dataDir);

  const h = openDb({ dataDir: cfg.dataDir });
  try {
    const r = migrate(h.db);
    const created = writeDefaultConfigIfAbsent(cfg);

    if (!args.quiet) {
      if (r.applied.length) {
        process.stdout.write(`已应用迁移: ${r.applied.join(', ')}\n`);
        for (const m of MIGRATIONS.filter((x) => r.applied.includes(x.version))) {
          process.stdout.write(`  v${m.version} ${m.name}\n`);
        }
      } else {
        process.stdout.write(`数据库已是最新（schema v${CURRENT_SCHEMA_VERSION}）\n`);
      }
      if (created) process.stdout.write(`已创建 ${cfg.dataDir}/config.json\n`);
      process.stdout.write(`数据目录: ${cfg.dataDir}\n`);
    }
  } finally {
    h.close();
  }
}

function cmdDoctor(args: Args): void {
  const cfg = loadConfig({ dataDir: args.data });
  type Item = { name: string; ok: boolean; detail: string; fatal?: boolean };
  const items: Item[] = [];

  // 1. 数据目录
  const writable = (() => {
    try {
      ensureDataDirs(cfg.dataDir);
      return true;
    } catch { return false; }
  })();
  items.push({
    name: '数据目录可写', ok: writable, detail: cfg.dataDir, fatal: !writable,
  });

  // 2. 库存在且可打开
  const dbPath = `${cfg.dataDir}/app.db`;
  const dbExists = existsSync(dbPath);
  items.push({
    name: '数据库存在',
    ok: dbExists,
    detail: dbExists ? dbPath : '尚未创建，运行 migrate',
    fatal: false,
  });

  if (dbExists) {
    let pragmas: Record<string, string | number> = {};
    let schemaOk = true;
    let schemaDetail = '';
    let integrity = 'not-run';
    let dbVersion = 0;

    try {
      const h = openDb({ dataDir: cfg.dataDir, readonly: true });
      try {
        pragmas = readPragmas(h.db);
        const row = h.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
          { v: number | null } | undefined;
        dbVersion = row?.v ?? 0;
        const compat = assertSchemaCompatible(h.db);
        schemaOk = compat.ok;
        schemaDetail = compat.ok ? `schema v${dbVersion}` : compat.reason;
        const ic = h.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
        integrity = ic.integrity_check;
      } finally {
        h.close();
      }
    } catch (e) {
      schemaOk = false;
      schemaDetail = (e as Error).message;
    }

    items.push({ name: 'schema 版本可接受', ok: schemaOk, detail: schemaDetail, fatal: true });
    items.push({
      name: 'journal_mode = WAL', ok: String(pragmas.journal_mode) === 'wal',
      detail: String(pragmas.journal_mode ?? '?'),
    });
    items.push({
      name: 'integrity_check', ok: integrity === 'ok', detail: integrity,
    });

    // 3. 备份新鲜度
    let lastBackup = 0;
    try {
      const h = openDb({ dataDir: cfg.dataDir, readonly: true });
      try {
        const r = h.db.prepare('SELECT MAX(created_at) AS t FROM backup_log WHERE ok = 1')
          .get() as { t: number | null } | undefined;
        lastBackup = Number(r?.t ?? 0);
      } finally { h.close(); }
    } catch { /* 表可能不存在 */ }
    const ageH = lastBackup ? (Date.now() - lastBackup) / 3600000 : Infinity;
    items.push({
      name: '最近备份 < 48h',
      ok: ageH < 48,
      detail: lastBackup ? `${ageH.toFixed(1)} 小时前` : '从未备份',
      // 首次使用时还没备份是正常的，不判致命
    });

    // 4. 正文占比（体积治理告警）
    try {
      const h = openDb({ dataDir: cfg.dataDir, readonly: true });
      try {
        const total = h.db.prepare(
          "SELECT SUM(pgsize) AS s FROM dbstat"
        ).get() as { s: number | null } | undefined;
        const contents = h.db.prepare(
          "SELECT SUM(pgsize) AS s FROM dbstat WHERE name = 'entry_contents'"
        ).get() as { s: number | null } | undefined;
        const t = Number(total?.s ?? 0);
        const c = Number(contents?.s ?? 0);
        const pct = t > 0 ? (c / t) * 100 : 0;
        items.push({
          name: '正文占比 < 90%',
          ok: pct < 90 || t === 0,
          detail: t > 0 ? `${pct.toFixed(0)}%（${(c / 1e6).toFixed(0)}MB / ${(t / 1e6).toFixed(0)}MB）` : '空库',
        });
      } finally { h.close(); }
    } catch {
      items.push({ name: '正文占比', ok: true, detail: 'dbstat 不可用' });
    }
  }

  // 5. 项目目录内（不写系统目录）
  const inProject = cfg.dataDir.startsWith(process.cwd()) ||
    !cfg.dataDir.includes('AppData') && !cfg.dataDir.startsWith('/etc');
  items.push({
    name: '数据目录不在系统区', ok: inProject, detail: cfg.dataDir,
  });

  // 6. AI key
  const hasKey = Boolean(process.env[cfg.ai.apiKeyEnv]);
  items.push({
    name: `AI key 环境变量 (${cfg.ai.apiKeyEnv})`,
    ok: hasKey,
    detail: hasKey ? '已设置' : '未设置，AI 功能不可用',
  });

  const fatalFail = items.some((i) => i.fatal && !i.ok);
  const anyFail = items.some((i) => !i.ok);

  if (!args.quiet) {
    for (const it of items) {
      const mark = it.ok ? '\u001b[32m[✓]\u001b[0m' : (it.fatal ? '\u001b[31m[✗]\u001b[0m' : '\u001b[33m[!]\u001b[0m');
      process.stdout.write(`${mark} ${it.name.padEnd(28)} ${it.detail}\n`);
    }
    process.stdout.write('\n');
  }

  process.exitCode = fatalFail ? 1 : 0;
  if (!args.quiet) {
    if (fatalFail) process.stdout.write('\u001b[31m存在致命问题，服务无法正常启动\u001b[0m\n');
    else if (anyFail) process.stdout.write('\u001b[33m有需要关注的项目，但可以运行\u001b[0m\n');
    else process.stdout.write('\u001b[32m自检全部通过\u001b[0m\n');
  }
}

async function cmdServe(args: Args): Promise<void> {
  const cfg: RuntimeConfig = loadConfig({ dataDir: args.data, port: args.port, host: args.host });
  setLogLevel(cfg.logLevel);
  ensureDataDirs(cfg.dataDir);
  writeDefaultConfigIfAbsent(cfg);

  const h = openDb({ dataDir: cfg.dataDir });

  // 顺序很重要：先 migrate 再 assertSchemaCompatible。
  // 反过来的话，全新库还没有 schema_migrations 表，断言会直接抛
  // "no such table"，表现为服务起不来 —— 而这恰好是首次启动的常态。
  migrate(h.db);

  const compat = assertSchemaCompatible(h.db);
  if (!compat.ok) {
    h.close();
    throw new Error(compat.reason);
  }

  const app = createApp({
    cfg, dbh: h, version: VERSION, startedAt: Date.now(),
  });

  const server = serve({
    fetch: app.fetch,
    port: cfg.port,
    hostname: cfg.host,
  }, (info) => {
    log.info(`ai-rss ${VERSION} 已启动`, {
      url: `http://${cfg.host}:${info.port}`,
      data: cfg.dataDir,
    });
    // 给 verify 脚本一个可机读的就绪信号
    if (process.env.AI_RSS_PRINT_READY) {
      process.stdout.write(`READY ${info.port}\n`);
    }
  });

  const shutdown = (sig: string) => {
    log.info(`收到 ${sig}，正在关闭`);
    server.close(() => {
      h.close();
      process.exit(0);
    });
    // 兜底：5 秒内没关完就强退
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function cmdWorker(_args: Args): Promise<void> {
  throw new Error('worker 子命令在 0.6 落地');
}

async function cmdMcp(_args: Args): Promise<void> {
  throw new Error('mcp 子命令在 M5 落地');
}

async function cmdExport(_args: Args): Promise<void> {
  throw new Error('export 子命令在 M6 落地');
}

async function cmdImport(_args: Args): Promise<void> {
  throw new Error('import 子命令在 M6 落地');
}
