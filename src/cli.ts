import { existsSync, readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp, type AppContext } from './server/app.ts';
import { openDb, readPragmas } from './server/db/client.ts';
import { migrate, MIGRATIONS, CURRENT_SCHEMA_VERSION, assertSchemaCompatible } from './server/db/migrate.ts';
import {
  loadConfig, ensureDataDirs, writeDefaultConfigIfAbsent, resolveDataDir,
  type RuntimeConfig,
} from './server/config.ts';
import { log, setLogLevel } from './server/logger.ts';
import { JobRunner } from './server/jobs/runner.ts';
import { buildHandlers } from './server/jobs/handlers.ts';
import { sweepDueFeeds } from './server/routes/feeds.ts';
import { ensureOwnerUser, countUsers, purgeExpiredSessions } from './server/auth/session.ts';
import { pruneOldVectors } from './server/dedupe/index.ts';
import { countOrphanPending, enqueueOrphanExtracts } from './server/extract/backfill.ts';

// esbuild 打包时注入（scripts/build-server.mjs）；源码模式走 package.json
declare const __AI_RSS_VERSION__: string | undefined;

const VERSION = readVersion();

function readVersion(): string {
  if (typeof __AI_RSS_VERSION__ === 'string') return __AI_RSS_VERSION__;
  try {
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
  migrate(h.db);
  const compat = assertSchemaCompatible(h.db);
  if (!compat.ok) {
    h.close();
    throw new Error(compat.reason);
  }

  // 首次启动不自动建账号 —— 留给 /api/v1/auth/setup 由用户设定密码。
  //
  // 为什么不做"自动生成随机密码并打印"：那样用户必须从终端日志里
  // 抄一串随机串才能进 UI，体验很差，且一旦日志被清掉就进不去了。
  // 只提示一句"还没有账号，请先初始化"更直接。
  const userCount = countUsers(h.db);
  if (userCount === 0) {
    log.warn('数据库中还没有任何用户');
    process.stdout.write(
      `\n\u001b[33m首次启动：还没有管理员账号\u001b[0m\n` +
      `  在浏览器打开 http://${cfg.host}:${cfg.port} 完成初始化，\n` +
      `  或调用 POST /api/v1/auth/setup 传入 { email, password }。\n\n`,
    );
  }
  const purged = purgeExpiredSessions(h.db);
  if (purged > 0) log.debug(`清理了 ${purged} 个过期会话`);

  // job runner：默认与服务同进程（单进程部署最简单）。
  // WORKER_INLINE=false 时改由独立的 `ai-rss worker` 进程跑。
  const inlineWorker = process.env.WORKER_INLINE !== 'false';

  // 先建 app 再建 runner：fetch_feed handler 需要 AppContext（要读 feeds 表、
  // 要复用 routes/feeds.ts 的 runFetch），顺序反了只能把 ctx 拆开传两遍。
  const appCtx: AppContext = {
    cfg, dbh: h, version: VERSION, startedAt: Date.now(),
  };
  const app = createApp(appCtx);

  // 定时 sweep：每分钟把到期的订阅入队（PLAN §7.1 L0）。
  // 为什么不靠每个源自己的 setTimeout：源可能有几百个，
  // 定时器方案要么几百个 timer 要么一次全打出去；单表扫一遍更简单。
  const sweepTimer = setInterval(() => {
    try {
      const n = sweepDueFeeds(appCtx);
      if (n > 0) log.debug(`sweep: ${n} 个订阅已入队`);
    } catch (e) {
      log.warn('sweep 失败', { err: (e as Error).message });
    }
  }, 60_000);
  sweepTimer.unref?.();

  // 补录孤儿提取任务（PLAN §7.5，v1.17）。
  //
  // 为什么必须有一条兜底，而不是"上游入队写对了就够"：pending 状态的
  // 唯一含义是"等提取"，而队列里有没有它的任务是**另一张表**的事。
  // 两者脱钩过一次（1.14 之前 stage 硬编码 pending，那时还没有提取任务），
  // 结果是 514 条条目永远停在 pending、正文只有 feed 给的几十个字。
  // 修上游只能保证以后不再新增，存量要有人认领。
  //
  // 每小时一轮、每轮 200 条：一场升级留下的积压在一小时内收敛，
  // 而正常运行时这个查询是 0 命中（0.16ms，比一次抓取便宜得多）。
  const backfill = () => {
    try {
      const n = enqueueOrphanExtracts(h.db);
      const left = countOrphanPending(h.db);
      if (n > 0 || left > 0) {
        log.info(`补录 ${n} 条待提取条目`, { remaining: left });
      }
    } catch (e) {
      log.warn('补录待提取条目失败', { err: (e as Error).message });
    }
  };
  // 启动 30 秒后先跑一轮：积压不该等一个小时
  const firstBackfill = setTimeout(backfill, 30_000);
  firstBackfill.unref?.();
  const backfillTimer = setInterval(backfill, 3600_000);
  backfillTimer.unref?.();

  // 每日维护：清掉过期的去重向量（PLAN §7.1 L2）。
  //
  // 判重只看近 14 天的候选，更早的向量永远读不到，但一条 1KB × 10 万条
  // = 100MB。放在启动后 5 分钟跑一次再每 24h 一次：不在启动关键路径上，
  // 也不依赖外部 cron（NAS 用户不会配）。
  const pruneVectors = () => {
    try {
      const n = pruneOldVectors(h.db);
      if (n > 0) log.info(`清理了 ${n} 条过期的去重向量`);
    } catch (e) {
      log.warn('清理去重向量失败', { err: (e as Error).message });
    }
  };
  const firstPrune = setTimeout(pruneVectors, 5 * 60_000);
  firstPrune.unref?.();
  const pruneTimer = setInterval(pruneVectors, 24 * 3600_000);
  pruneTimer.unref?.();

  let runner: JobRunner | null = null;
  if (inlineWorker) {
    runner = new JobRunner({
      db: h.db,
      handlers: buildHandlers({ dataDir: cfg.dataDir, log: log.info, app: appCtx }),
    });
    runner.start();
  }

  const server = serve({
    fetch: app.fetch,
    port: cfg.port,
    hostname: cfg.host,
  }, (info) => {
    log.info(`ai-rss ${VERSION} 已启动`, {
      url: `http://${cfg.host}:${info.port}`,
      data: cfg.dataDir,
      worker: inlineWorker ? 'inline' : 'external',
    });
    // 给 verify 脚本一个可机读的就绪信号
    if (process.env.AI_RSS_PRINT_READY) {
      process.stdout.write(`READY ${info.port}\n`);
    }
  });

  const shutdown = async (sig: string) => {
    log.info(`收到 ${sig}，正在关闭`);
    clearInterval(sweepTimer);
    clearTimeout(firstPrune);
    clearInterval(pruneTimer);
    clearTimeout(firstBackfill);
    clearInterval(backfillTimer);
    try {
      if (runner) await runner.stop();
    } catch { /* runner 已停 */ }

    // 顺序很重要：先 close 停止接受新连接，再关库，最后才退出。
    // 之前直接在 close 回调里 process.exit()，Windows 上会触发
    // libuv 的 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" ——
    // 因为 SQLite 的异步句柄还在关闭途中就被强退了。
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 有长连接时 close 可能不回调，给 2 秒兜底
      setTimeout(resolve, 2000).unref();
    });

    try { h.close(); } catch { /* 已关 */ }

    // 让 libuv 完成一轮关闭再退出，避免句柄断言
    setImmediate(() => process.exit(0));
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

async function cmdWorker(args: Args): Promise<void> {
  const cfg = loadConfig({ dataDir: args.data });
  setLogLevel(cfg.logLevel);
  ensureDataDirs(cfg.dataDir);

  const h = openDb({ dataDir: cfg.dataDir });
  migrate(h.db);

  // 独立 worker 也要 AppContext —— fetch_feed 复用 runFetch，
  // 那条路径要读 feeds 表、要写条目，不能少于 serve 模式的那套依赖。
  const appCtx: AppContext = { cfg, dbh: h, version: VERSION, startedAt: Date.now() };

  const runner = new JobRunner({
    db: h.db,
    handlers: buildHandlers({ dataDir: cfg.dataDir, log: log.info, app: appCtx }),
  });
  runner.start();
  log.info('独立 worker 已启动');

  const shutdown = async () => {
    await runner.stop();
    h.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
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
