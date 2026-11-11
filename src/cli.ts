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
import { scheduleTask } from './server/util/timers.ts';
import { JobRunner } from './server/jobs/runner.ts';
import { buildHandlers } from './server/jobs/handlers.ts';
import { sweepDueFeeds } from './server/routes/feeds.ts';
import { ensureOwnerUser, countUsers, purgeExpiredSessions } from './server/auth/session.ts';
import { pruneOldVectors } from './server/dedupe/index.ts';
import { countOrphanPending, enqueueOrphanExtracts } from './server/extract/backfill.ts';
import { countOrphanAnalyze, enqueueOrphanAnalyze } from './server/ai/backfill.ts';
import { logMissingKeyBanner } from './server/ai/notice.ts';
import { resolveKey } from './server/ai/secrets.ts';
import { digestDue, parseDigestConfig } from './server/digest/schedule.ts';
import { enqueue } from './server/jobs/queue.ts';
import { listUsersForDigest } from './server/digest/users.ts';

// esbuild 打包时注入（scripts/build-server.mjs）；源码模式走 package.json
declare const __CHENG_RSS_VERSION__: string | undefined;

const VERSION = readVersion();

function readVersion(): string {
  if (typeof __CHENG_RSS_VERSION__ === 'string') return __CHENG_RSS_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const USAGE = `澄 (cheng) —— 自托管的私人知识库：订阅进来，AI 沉淀，剩下的留给你

用法: cheng-rss <命令> [选项]

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

doctor 专用:
  --url <addr>    额外探测一次 HTTP（如 http://127.0.0.1:3000），
                  供 Docker HEALTHCHECK 判断"现在能不能服务"
`;

interface Args {
  _: string[];
  data?: string;
  port?: number;
  host?: string;
  // doctor --url：额外探测一次 HTTP，供 Docker HEALTHCHECK 用（§16.3）
  url?: string;
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
      case '--url': out.url = argv[++i]; break;
      case '--quiet': out.quiet = true; break;
      case '-h': case '--help': out._.push('--help'); break;
      default:
        if (a.startsWith('--data=')) out.data = a.slice(7);
        else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
        else if (a.startsWith('--host=')) out.host = a.slice(7);
        else if (a.startsWith('--url=')) out.url = a.slice(6);
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
  process.stdout.write(`cheng-rss ${VERSION}\n`);
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

function cmdDoctor(args: Args): Promise<void> {
  return runDoctor(args);
}

async function runDoctor(args: Args): Promise<void> {
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
  //
  // fatal: 没有库就不能服务。此前这里是 false，于是 `doctor` 对一个空目录
  // 返回 0，而 Dockerfile 的 HEALTHCHECK 正是以它的退出码判定健康 ——
  // 一个没有数据库的容器会被报成 healthy。
  //
  // 注意区分两种状态：`migrate` 之前本来就没有库（首次部署的正常路径），
  // 但那时也不该有容器在跑；`serve` 自己会迁移。所以这里判 fatal 是对的：
  // 健康检查问的是"现在能不能服务"，不是"将来能不能"。
  const dbPath = `${cfg.dataDir}/app.db`;
  const dbExists = existsSync(dbPath);
  items.push({
    name: '数据库存在',
    ok: dbExists,
    detail: dbExists ? dbPath : '尚未创建，运行 migrate',
    fatal: true,
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

  // 7. HTTP 探测（可选，`--url` 给出时）
  //
  // 为什么需要它：上面每一项查的都是**磁盘**。进程活着但 HTTP 已经不应答
  // （事件循环卡死、端口被占、路由装配坏了）时，上面全部通过、退出码 0，
  // 而 HEALTHCHECK 的语义恰恰是"这个容器现在能不能提供服务"。
  //
  // 用内置 fetch 而不是装 curl：这个二进制本身就是 Node SEA，为一个 GET
  // 多背一个包不值得。超时必须显式给 —— 不加的话探测挂住时 healthcheck
  // 永远不返回，比不检查更糟（Docker 会一直等，而不是报 unhealthy）。
  if (args.url) {
    const url = `${args.url.replace(/\/+$/, '')}/api/health`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body = await r.json().catch(() => null) as
        { ok?: boolean; db?: string; version?: string } | null;
      const healthy = r.ok && body?.ok === true && body?.db === 'ok';
      items.push({
        name: 'HTTP /api/health',
        ok: healthy,
        detail: healthy
          ? `db=${body!.db} ${body!.version ?? ''}`.trim()
          : (r.ok ? `应答异常: ${JSON.stringify(body)}` : `HTTP ${r.status}`),
        fatal: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      items.push({
        name: 'HTTP /api/health',
        ok: false,
        detail: `连不上 ${url}（${msg}）`,
        fatal: true,
      });
    }
  }

  // 致命判定必须在**所有** items 都 push 完之后算。
  //
  // 这里踩过一次：fatalFail 原本算在 HTTP 探测之前，于是 `--url` 连不上
  // 时列表里明明有 `[✗]`，退出码却是 0 —— 而 Docker 只看退出码。
  // 断言「有 ✗」和断言「exit 1」是两件事，后者才是 HEALTHCHECK 判据。
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
  // WORKER_INLINE=false 时改由独立的 `cheng-rss worker` 进程跑。
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
  const stopSweep = scheduleTask({
    name: 'sweep',
    everyMs: 60_000,
    run: () => {
      const n = sweepDueFeeds(appCtx);
      if (n > 0) log.debug(`sweep: ${n} 个订阅已入队`);
    },
  });

  // 补录孤儿提取任务（PLAN §7.5，v1.17）。
  //
  // 为什么必须有一条兜底，而不是"上游入队写对了就够"：pending 状态的
  // 唯一含义是"等提取"，而队列里有没有它的任务是**另一张表**的事。
  // 两者脱钩过一次（1.14 之前 stage 硬编码 pending，那时还没有提取任务），
  // 结果是 514 条条目永远停在 pending、正文只有 feed 给的几十个字。
  // 修上游只能保证以后不再新增，存量要有人认领。
  //
  // 频率是 5 分钟而不是 1 小时：实测本机库积压 514 条，每轮 200 条的话
  // 每小时一轮要 3 小时才收敛完，用户在这个窗口里看到的仍是"旧文章没正文"。
  // 5 分钟一轮 → 15 分钟吃完，而排队中的任务本身还能被并发上限（4）
  // 压住，不会一次往网络上打几百个请求。
  //
  // 稳态成本：正常运行时这个查询 0 命中，0.16ms。它比一次抓取便宜三个
  // 数量级，所以"跑得勤"不构成性能问题 —— 真正的成本是命中时的抓取，
  // 而命中意味着确实有活没干。
  //
  // 启动 30 秒后先跑一轮：积压不该等一个周期
  const stopBackfill = scheduleTask({
    name: '补录待提取条目',
    failMessage: '补录待提取条目失败',
    everyMs: 5 * 60_000,
    firstRunDelayMs: 30_000,
    run: () => {
      const n = enqueueOrphanExtracts(h.db);
      const left = countOrphanPending(h.db);
      if (n > 0 || left > 0) {
        log.info(`补录 ${n} 条待提取条目`, { remaining: left });
      }
    },
  });

  // 补录孤儿**分析**任务（PLAN §5.7 P2，v2.0）。
  //
  // 与上面的提取补录同构，但修的是另一种脱钩：没配 key 的那段时间里，
  // 每篇的 analyze 都拿到 `no-key`，而 `runAnalyze` **刻意不改 stage**
  // （§8.6：全局配置问题不该把整库打成 failed），handler 又把它当 terminal
  // 吃掉 —— 于是任务 done、库里没有分析行、条目停在 extracted，
  // **再也没有任何东西会把它重新排队**。
  //
  // 实测本机库：745 条 extracted、4 条有分析（且是 seed 造的老数据）。
  // 「填上 key 之后什么都不发生」就是这条缺陷的用户可见形态。
  //
  // **没 key 时整个跳过，这不只是省事，是省资源**：每篇 analyze 在拿到
  // no-key 之前已经 loadAnalyzeInput 解包了正文 BLOB。745 条 × 每 5 分钟
  // 一次 = 每天 21 万次无意义的解包，而结果必然还是 no-key。
  // 跳过之后稳态成本只剩一条 key 检查；key 一出现，下一轮立刻开始补录。
  const hasUsableKey = (): boolean => {
    try {
      return resolveKey(cfg.dataDir, cfg.ai.apiKeyEnv).key !== null;
    } catch {
      // 读不出就让补录继续：宁可多花点资源，也不要因为一次 IO 异常
      // 让积压永远不收敛（那是用户看得见的"没有摘要"）。
      return true;
    }
  };

  const stopAnalyzeBackfill = scheduleTask({
    name: '补录待分析条目',
    failMessage: '补录待分析条目失败',
    everyMs: 5 * 60_000,
    firstRunDelayMs: 20_000,
    run: () => {
      if (!hasUsableKey()) return;
      const n = enqueueOrphanAnalyze(h.db);
      const left = countOrphanAnalyze(h.db);
      if (n > 0) log.info(`补录 ${n} 条待分析条目`, { remaining: left });
    },
  });

  // 启动横幅（§8.8）：没配 key 时说**一次**「N 篇待分析 + 去哪儿填」。
  //
  // 这一条替代了原本 745 行逐条 `analyze 失败`。它的信息量更大：
  // 有数量、有出口、而且不会把别的错误埋掉。
  if (!hasUsableKey()) {
    const pending = (() => {
      try { return countOrphanAnalyze(h.db); } catch { return 0; }
    })();
    if (pending > 0) {
      setTimeout(() => logMissingKeyBanner(pending), 2_000).unref?.();
    }
  }

  // 每日维护：清掉过期的去重向量（PLAN §7.1 L2）。
  //
  // 判重只看近 14 天的候选，更早的向量永远读不到，但一条 1KB × 10 万条
  // = 100MB。放在启动后 5 分钟跑一次再每 24h 一次：不在启动关键路径上，
  // 也不依赖外部 cron（NAS 用户不会配）。
  const stopPruneVectors = scheduleTask({
    name: '清理去重向量',
    failMessage: '清理去重向量失败',
    everyMs: 24 * 3600_000,
    firstRunDelayMs: 5 * 60_000,
    run: () => {
      const n = pruneOldVectors(h.db);
      if (n > 0) log.info(`清理了 ${n} 条过期的去重向量`);
    },
  });

  // 简报调度（PLAN §9.1 / §19.5 3.4）。
  //
  // 与 sweepDueFeeds 同一个套路：每分钟查一遍"谁该出简报"，把任务丢进队列，
  // 真正的生成由 job handler 跑。**不在这个定时器里直接跑**：生成要调十几次
  // 模型（每簇一次 + 简报一次），几十秒起步，塞进 setInterval 会把主循环卡住。
  //
  // 三种否决状态都由 digestDue 判定（未到点 / 今天已做 / 今天已跳过 /
  // 失败退避中 / 今天失败次数用完），它们各自有持久痕迹，所以这个查询
  // 每分钟跑一次不会重复触发任何工作 —— 稳态成本就是三条索引查询。
  const stopSweepDigests = scheduleTask({
    name: '简报调度',
    failMessage: '简报调度失败',
    everyMs: 60_000,
    firstRunDelayMs: 20_000,
    run: () => {
      const users = listUsersForDigest(h.db);
      let queued = 0;
      for (const u of users) {
        // manual=false：走完整的时间/幂等判断
        const due = digestDue(h.db, u.userId, parseDigestConfig(u.config), Date.now());
        if (!due.due) continue;
        const id = enqueue(h.db, {
          kind: 'digest',
          payload: { userId: u.userId },
          // dedupeKey 带日期：同一天里前一个还在队列/运行中时不会堆第二个，
          // 而第二天自然是另一条 key（否则"生成过一次"会让后续永不入队）
          dedupeKey: `digest:${u.userId}:${due.dayKey}`,
          priority: 1,
          maxAttempts: 1,     // 重试由 digest_attempts 的退避管，不走队列的 attempts
        });
        if (id !== null) queued++;
      }
      if (queued > 0) log.debug(`简报调度: ${queued} 个用户已入队`);
    },
  });

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
    log.info(`cheng-rss ${VERSION} 已启动`, {
      url: `http://${cfg.host}:${info.port}`,
      data: cfg.dataDir,
      worker: inlineWorker ? 'inline' : 'external',
    });
    // 给 verify 脚本一个可机读的就绪信号
    if (process.env.CHENG_RSS_PRINT_READY) {
      process.stdout.write(`READY ${info.port}\n`);
    }
  });

  const shutdown = async (sig: string) => {
    log.info(`收到 ${sig}，正在关闭`);
    stopSweep();
    stopBackfill();
    stopAnalyzeBackfill();
    stopPruneVectors();
    stopSweepDigests();
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
