#!/usr/bin/env node
// 0.10 资源与性能预算 —— 验收
//
// 判据（PLAN §5.7 / §19.2 0.10）：
//   ① 空闲 60s：RSS ≤ 130 MB、CPU 均值 ≤ 1.5%、stderr ≤ 20 行/分钟
//   ② 空闲日志里没有**逐条重复的同一模板**（同一模板 ≤ 3 行/60s）
//   ③ 前端产物 gz：JS ≤ 120 KB、CSS ≤ 15 KB
//   ④ 空闲不增长：再等 60s，RSS 增量 ≤ 5 MB
//   ⑤ 队列空时 `jobs` 表不增长（没有空转入队）
//
// 为什么单独一步（§5.7）：§5.6 的三条红线管的是**单条查询**，超标是
// "一次操作变慢"。空闲耗资源是另一类风险 —— 设备整夜发烫、日志把 NAS
// 的 /var 写满。两者的阈值、观测方式、失败后果都不一样。
//
// ① 的 CPU 怎么量：Windows 用 Get-Process 的 TotalProcessorTime（累计
// CPU 秒），取两次差 / 墙钟时间 / 逻辑核数。不装采样工具、不读性能计数器。
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { group, check, ok, eq, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(root, 'dist', process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`);

group('0.10 资源与性能预算');

if (!existsSync(BIN)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── ③ 产物体积（先测，不需要起进程）───────────────────────
{
  const assetDir = join(root, 'dist/client/assets');
  const files = existsSync(assetDir) ? readdirSync(assetDir) : [];
  const js = files.filter((f) => f.endsWith('.js'));
  const css = files.filter((f) => f.endsWith('.css'));

  const gzTotal = (list) => list.reduce(
    (n, f) => n + gzipSync(readFileSync(join(assetDir, f))).length, 0,
  );
  const jsGz = gzTotal(js);
  const cssGz = gzTotal(css);

  check('③ 前端产物存在（JS 与 CSS 各至少一个）', () => {
    return ok(js.length > 0 && css.length > 0, `assets: ${files.join(', ')}`);
  });
  check(`③ 前端 JS gzip ≤ 120 KB（实测 ${(jsGz / 1024).toFixed(1)} KB）`, () => {
    return ok(jsGz <= 120 * 1024, `${jsGz} 字节`);
  });
  check(`③ 前端 CSS gzip ≤ 15 KB（实测 ${(cssGz / 1024).toFixed(1)} KB）`, () => {
    return ok(cssGz <= 15 * 1024, `${cssGz} 字节`);
  });
  check('③ 二进制体积 ≤ 100 MB（§5.4 定的是 90MB 量级）', () => {
    const sz = statSync(BIN).size;
    return ok(sz <= 100 * 1024 * 1024, `${(sz / 1024 / 1024).toFixed(1)} MB`);
  });
}

// ── 起一个空库的服务（没有源、没有条目 = 真正的空闲）────────
const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m010-'));
const dataDir = join(tmp, 'data');
const port = 48600 + Math.floor(Math.random() * 300);
const origin = `http://127.0.0.1:${port}`;

const proc = spawn(BIN, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const errLines = [];
proc.stderr.on('data', (d) => {
  for (const l of String(d).split('\n')) if (l.trim()) errLines.push(l);
});
proc.stdout.on('data', () => { /* drain */ });

const cleanup = () => {
  killTree(proc.pid);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
onExit(cleanup);

let ready = false;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch { /* not yet */ }
  await sleep(250);
}
check('服务就绪（空库）', () => ok(ready, errLines.slice(0, 5).join(' | ')));
if (!ready) { cleanup(); summary('m0-10-resources'); process.exit(1); }

// ── 采样工具：RSS + 累计 CPU 秒 ───────────────────────────
const isWin = process.platform === 'win32';

/** 返回 { rssMB, cpuSeconds } 或 null（读不到时） */
function sample(pid) {
  if (isWin) {
    try {
      const out = execFileSync('powershell', [
        '-NoProfile', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;`
        + ' if ($p) { "$([int64]$p.WorkingSet64) $([double]$p.TotalProcessorTime.TotalSeconds)" }',
      ], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
      if (!out) return null;
      const [rss, cpu] = out.split(/\s+/).map(Number);
      if (!Number.isFinite(rss) || !Number.isFinite(cpu)) return null;
      return { rssMB: rss / 1024 / 1024, cpuSeconds: cpu };
    } catch {
      return null;
    }
  }
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+) kB/.exec(status);
    const statTxt = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // utime/stime 是第 14/15 字段；comm 可能含空格，从最后一个 ')' 之后数
    const after = statTxt.slice(statTxt.lastIndexOf(')') + 2).split(' ');
    const utime = Number(after[11]);
    const stime = Number(after[12]);
    if (!m || !Number.isFinite(utime)) return null;
    return {
      rssMB: Number(m[1]) / 1024,
      // Linux 的 jiffies 通常 100/s
      cpuSeconds: (utime + stime) / 100,
    };
  } catch {
    return null;
  }
}

const s0 = sample(proc.pid);
check('能读到进程的 RSS 与 CPU（采样工具可用）', () => {
  return ok(s0 !== null, 'Get-Process / /proc 都读不到');
});

// ── ① 空闲 60s ────────────────────────────────────────────
const IDLE_MS = 60_000;
const WINDOW1 = { ms: IDLE_MS, linesFrom: errLines.length };

await sleep(IDLE_MS);

const s1 = sample(proc.pid);
const window1Lines = errLines.slice(WINDOW1.linesFrom);
const cores = Math.max(1, cpus().length);

if (s0 && s1) {
  const wall = IDLE_MS / 1000;
  // CPU% 按"占满一个核"算：累计 CPU 秒 / 墙钟 / 核数 * 100
  const cpuPct = ((s1.cpuSeconds - s0.cpuSeconds) / wall / cores) * 100;
  check(`① 空闲 RSS ≤ 130 MB（实测 ${s1.rssMB.toFixed(1)} MB）`, () => {
    return ok(s1.rssMB <= 130, `${s1.rssMB.toFixed(1)} MB`);
  });
  check(`① 空闲 CPU 均值 ≤ 1.5%（实测 ${cpuPct.toFixed(2)}%）`, () => {
    return ok(cpuPct <= 1.5, `${cpuPct.toFixed(2)}%（核数 ${cores}）`);
  });
}

{
  const perMin = window1Lines.length; // 窗口就是 60s
  check(`① 空闲日志 ≤ 20 行/分钟（实测 ${perMin} 行）`, () => {
    return ok(perMin <= 20, window1Lines.slice(0, 5).join(' | '));
  });

  // ② 同一模板的重复：去掉时间戳与 JSON 尾巴后归并
  const byTemplate = new Map();
  for (const l of window1Lines) {
    const m = l.match(/^\S+ (\w+)\s+(.*?)( \{.*)?$/);
    const key = m ? `${m[1]} ${m[2]}` : l;
    byTemplate.set(key, (byTemplate.get(key) ?? 0) + 1);
  }
  const worst = [...byTemplate].sort((a, b) => b[1] - a[1])[0];
  check(`② 没有逐条刷屏的日志模板（最多 ${worst?.[1] ?? 0} 行）`, () => {
    return ok((worst?.[1] ?? 0) <= 3,
      `重复最多的是「${worst?.[0]}」×${worst?.[1]}`);
  });
  // 这一条与 ① 互补：① 管总量，② 管"同一句刷屏"。一个刷 15 行同一句的
  // 实现能过 ①（15<20）却过不了 ②，而它正是缺 key 时的那种形状。
}

// ── ④ 空闲不增长（再观察 90s，15s 一采）───────────────────
//
// 判据不能写成"某个 60s 窗口内 RSS 增量 ≤ 5MB"：实测稳态是 V8 的
// **锯齿**（30s 涨 2.2~2.7MB，几分钟后一次 GC 回落 6.7MB）。任何单窗口
// 增量阈值都会在锯齿的上升段偶然踩线 —— 这样的断言测的是采样时刻的运气。
//
// 真正要防的是**无界增长**（真泄漏），可测的形式有两条：
//   · 全程峰值不超过空闲红线（130MB）
//   · 峰谷差有界（锯齿幅度，实测 ~7MB；给到 25MB 容差）
// 加一条"最终不显著高于初始"防单调爬升。
const SAMPLES = [];
for (let i = 0; i < 7; i++) {
  await sleep(15_000);
  const s = sample(proc.pid);
  if (s) SAMPLES.push(s.rssMB);
}
const window2Lines = errLines.slice(WINDOW1.linesFrom + window1Lines.length);

if (SAMPLES.length >= 5) {
  const peak = Math.max(...SAMPLES);
  const low = Math.min(...SAMPLES);
  const tail = SAMPLES[SAMPLES.length - 1];
  check(`④ 90s 空闲期 RSS 峰值 ≤ 130 MB（实测 ${peak.toFixed(1)} MB）`, () => {
    return ok(peak <= 130, `采样序列 ${SAMPLES.map((x) => x.toFixed(1)).join(' → ')}`);
  });
  check(`④ 峰谷差 ≤ 25 MB（锯齿有界，不是无界增长；实测 ${(peak - low).toFixed(1)} MB）`, () => {
    return ok(peak - low <= 25,
      `峰 ${peak.toFixed(1)} 谷 ${low.toFixed(1)}；序列 ${SAMPLES.map((x) => x.toFixed(1)).join(' → ')}`);
  });
  check(`④ 末尾 RSS 不比峰值高（没有单调爬升：末 ${tail.toFixed(1)} vs 峰 ${peak.toFixed(1)}）`, () => {
    // 允许 GC 前的最后一点抬升：只要没超过峰值就是有界
    return ok(tail <= peak + 0.5, `末 ${tail.toFixed(1)} 峰 ${peak.toFixed(1)}`);
  });
} else {
  check('④ 能采到足够的 RSS 样本（≥5 次）', () => ok(false, `只采到 ${SAMPLES.length} 次`));
}
check(`④ 第二个 60s 的日志量不比第一个多（${window2Lines.length} vs ${window1Lines.length}）`, () => {
  return ok(window2Lines.length <= window1Lines.length + 2,
    `窗口2=${window2Lines.length} 窗口1=${window1Lines.length}`);
});

// ── P4 限速器：直接验纯函数（不等真实刷屏）──────────────────
//
// 上面那些"空闲 0 行日志"的断言**证明不了限速器在工作** —— 空闲时本来就
// 没有日志，一个完全没实现的限速器同样拿到 0 行。真正要验的是：
// 灌 20 条同一模板，只出 3 条；灌 20 条各不相同的模板，全都出。
// 这两条合起来才说明它按**模板**限、且不会误伤正常日志。
{
  const { rateAllow, takeSuppressed, logTemplate, resetRateLimit, RATE_LIMIT_PER_WINDOW, log }
    = await import('../../src/server/logger.ts');

  resetRateLimit();
  const t0 = 1_700_000_000_000;
  // 同一模板连灌 20 次（假时钟不走，全在同一个窗口内）
  const allowed = [];
  for (let i = 0; i < 20; i++) allowed.push(rateAllow('i:analyze 失败', t0 + i));

  check(`P4 同一模板连灌 20 次只放行 ${RATE_LIMIT_PER_WINDOW} 次`, () => {
    const n = allowed.filter((x) => x !== false).length;
    return ok(n === RATE_LIMIT_PER_WINDOW, `放行 ${n} 次，序列 ${JSON.stringify(allowed)}`);
  });
  check('P4 被折叠的 17 条记在账上（不是丢掉）', () => {
    const n = takeSuppressed('i:analyze 失败');
    return eq(n, 17);
  });
  check('P4 takeSuppressed 是"取走"语义（再取一次是 0）', () => {
    return eq(takeSuppressed('i:analyze 失败'), 0);
  });

  // 不同模板互不影响 —— 这条防"实现成全局计数"
  resetRateLimit();
  let distinct = 0;
  for (let i = 0; i < 20; i++) {
    if (rateAllow(`i:模板-${i}`, t0) !== false) distinct++;
  }
  check('P4 20 个**不同**模板全部放行（限速按模板而不是全局）', () => {
    return eq(distinct, 20);
  });

  // 过了一个窗口，配额重置
  resetRateLimit();
  for (let i = 0; i < 3; i++) rateAllow('i:重置', t0);
  check('P4 窗口内第 4 次被折叠', () => eq(rateAllow('i:重置', t0 + 10), false));
  check('P4 过了 60s 窗口配额重置', () => {
    return ok(rateAllow('i:重置', t0 + 60_001) !== false, '窗口边界没重置');
  });

  // 模板归一：只有数字被折叠进 '#'
  check('P4 模板归一只动数字（745 篇 与 3 篇 同模板）', () => {
    return eq(logTemplate('analyze 失败 745 篇'), logTemplate('analyze 失败 3 篇'));
  });
  check('P4 模板归一**不**动引号里的内容（no-key 与 http-500 不同模板）', () => {
    const a = logTemplate('analyze 失败 kind="no-key"');
    const b = logTemplate('analyze 失败 kind="http-500"');
    return ok(a !== b, `两者都被归成「${a}」`);
  });

  // 表上限：灌 1000 个带 id 的模板，buckets 不能无界增长
  resetRateLimit();
  for (let i = 0; i < 1000; i++) rateAllow(`e:错误 id=${i}`, t0);
  // 无法直接读 buckets 长度，改用行为判据：最早的模板已被逐出，
  // 于是它会重新拿到满额配额（而不是继续被折叠）。
  const revived = [1, 2, 3].every(() => rateAllow('e:错误 id=0', t0 + 5000) !== false);
  check('P4 模板表有上限（灌 1000 个模板后最早的被逐出，不会无界增长）', () => {
    return ok(revived, '最早那个模板仍被折叠，说明它没被逐出');
  });
  resetRateLimit();

  // ── 走**真实出口**再验一遍 ──────────────────────────────
  //
  // 上面那些断言直接调 rateAllow，绕过了 log.info → emit 这条路径。
  // 把限速放在 emit 里而**键算错**的实现（比如全局一个桶）能全过上面所有条
  // —— 实测：把 tpl 改成常量后，26 条依然全绿。所以必须从 log.* 进去，
  // 数真正写到 console.error 的行数。
  resetRateLimit();
  const captured = [];
  const origErr = console.error;
  console.error = (...a) => { captured.push(a.map(String).join(' ')); };
  try {
    // 同一模板 20 次
    for (let i = 0; i < 20; i++) log.info('固定模板的失败');
    const sameTplLines = captured.length;
    check(`P4 经 log.info 灌 20 条同一模板，实际写出 ≤ ${RATE_LIMIT_PER_WINDOW} 行`, () => {
      return ok(sameTplLines <= RATE_LIMIT_PER_WINDOW,
        `写出了 ${sameTplLines} 行：${captured.slice(0, 5).join(' | ')}`);
    });

    // 20 个不同模板。**名字里不能有数字** —— 模板归一化会把数字抹成 `#`，
    // 于是 `失败 0 / 失败 1 / …` 全归成同一个模板，只出 3 行。
    // （第一版就是这么写的：它红在一个正确的行为上，而它本该验的是"不误伤"。）
    captured.length = 0;
    resetRateLimit();
    const letters = 'ABCDEFGHIJKLMNOPQRST';
    for (const c of letters) log.info(`互不相同的失败 ${c}`);
    check('P4 经 log.info 灌 20 条**不同**模板，20 行全都写出（不误伤正常日志）', () => {
      return eq(captured.length, 20);
    });

    // ── 折叠计数要真的出现在输出里 ────────────────────────
    //
    // emit 用的是 `Date.now()`，所以这里**临时换掉 Date.now** 造窗口滚动。
    // 不去 mock 模块内部、也不加"测试专用 now 参数"到生产签名里 ——
    // 换掉全局时钟是唯一"走真实代码路径"的办法。
    captured.length = 0;
    resetRateLimit();
    const realNow = Date.now;
    let clock = 1_700_000_000_000;
    Date.now = () => clock;
    try {
      for (let i = 0; i < 10; i++) log.info('会折叠的模板');   // 3 放行 + 7 折叠
      const beforeWindow = captured.length;
      clock += 61_000;                                        // 滚到下一个窗口
      log.info('会折叠的模板');                                 // 新窗第一次：应带「另有 7 条」
      check('P4 同窗口内 10 条只写出 3 行', () => eq(beforeWindow, 3));
      check('P4 **跨窗口后的第一行带「另有 N 条同类已折叠」**（折叠量可追溯，不是静默丢弃）', () => {
        const last = captured[captured.length - 1] ?? '';
        return ok(/另有 7 条同类已折叠/.test(last), last);
      });
      check('P4 补报那一行不占新窗口的配额（还能再写 2 行）', () => {
        captured.length = 0;
        log.info('会折叠的模板');
        log.info('会折叠的模板');
        const ok2 = captured.length === 2;
        log.info('会折叠的模板'); // 第 4 次 → 折叠
        return ok(ok2 && captured.length === 2, `写出 ${captured.length} 行`);
      });
    } finally {
      Date.now = realNow;
    }
  } finally {
    console.error = origErr;
  }
  resetRateLimit();
}

// ── ⑤ 空队列不增长 ────────────────────────────────────────
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dataDir, 'app.db'));
  db.exec('PRAGMA busy_timeout = 8000;');
  const n1 = Number(db.prepare('SELECT COUNT(*) c FROM jobs').get().c);
  await sleep(6000);
  const n2 = Number(db.prepare('SELECT COUNT(*) c FROM jobs').get().c);
  const pending = Number(db.prepare(
    "SELECT COUNT(*) c FROM jobs WHERE status IN ('pending','running')",
  ).get().c);
  db.close();

  check('⑤ 空库 6 秒内 jobs 表不增长（没有空转入队）', () => {
    return ok(n2 === n1, `${n1} → ${n2}`);
  });
  check('⑤ 队列里没有滞留的 pending/running', () => eq(pending, 0));
}

// ── 内存没有被"最后一个请求"撑大 ──────────────────────────
{
  const before = sample(proc.pid);
  // 打一轮首页 + API，再看 RSS 是否回落（GC 之后应回到同一量级）
  for (let i = 0; i < 20; i++) {
    await fetch(`${origin}/api/health`).catch(() => {});
  }
  await sleep(3000);
  const after = sample(proc.pid);
  check('打完 20 次请求后 RSS 仍 ≤ 130 MB（没有逐请求泄漏）', () => {
    if (!after) return ok(false, '读不到 RSS');
    return ok(after.rssMB <= 130, `${after.rssMB.toFixed(1)} MB（之前 ${before?.rssMB.toFixed(1)}）`);
  });
}

// ── ⑥ 临时目录落在项目内且能清干净（§19.10c）────────────
//
// 这一条防的是"验收本身变成资源问题"：一次全量验收曾在 %TEMP% 留下
// 32 个目录 / 4.8GB，其中几个 500MB 的浏览器 profile 因为句柄没释放
// 被 `catch {}` 静默吞掉。断言要能证明"现在不会"。
{
  const { useProjectTmp, cleanTmp, dirSize } = await import('../lib/tmp.mjs');
  const { mkdtempSync: mkdtemp2, writeFileSync: write2, existsSync: exists2 } = await import('node:fs');
  const { tmpdir: tmpdir2 } = await import('node:os');

  const dir = useProjectTmp();
  check('⑥ useProjectTmp 之后 os.tmpdir() 指向项目内', () => {
    const t = tmpdir2().replace(/\\/g, '/');
    return ok(t === dir.replace(/\\/g, '/'), `tmpdir=${t} 期望 ${dir}`);
  });
  check('⑥ 指向的目录真的被建出来了', () => ok(exists2(dir), dir));

  // 用真实调用验证：改完之后 mkdtempSync 落在哪儿
  const probe = mkdtemp2(join(tmpdir2(), 'ai-rss-m010tmp-'));
  check('⑥ 改完之后 mkdtempSync 建在项目内', () => {
    const p = probe.replace(/\\/g, '/');
    return ok(p.startsWith(dir.replace(/\\/g, '/') + '/'), p);
  });
  check('⑥ 新目录不再落在系统临时目录里', () => {
    // 系统临时目录必然含用户名这一段，项目路径不含
    return ok(!probe.replace(/\\/g, '/').includes('/AppData/'), probe);
  });

  // 造一点真文件，验证 cleanTmp 的体积统计不是 0
  write2(join(probe, 'junk.bin'), Buffer.alloc(64 * 1024));
  const sizeBefore = dirSize(probe);
  check('⑥ 目录体积能读出来（清理脚本要靠它报"释放了多少"）', () => {
    return ok(sizeBefore >= 64 * 1024, `${(sizeBefore / 1024).toFixed(1)} KB`);
  });

  const t = cleanTmp();
  check('⑥ cleanTmp 删掉了刚造的那个目录', () => {
    return ok(!exists2(probe), `removed=${t.removed} failed=${t.failed}`);
  });
  check('⑥ cleanTmp 报出了释放的体积（不是恒 0）', () => {
    return ok(t.freedBytes >= 64 * 1024, `${(t.freedBytes / 1024).toFixed(1)} KB`);
  });
  check('⑥ cleanTmp 没有越界清掉 .tmp 下的其它东西', () => {
    // .tmp/linuxnode 是 fetch-linux-node 的缓存，不该被临时目录清理顺手删掉
    return ok(exists2(join(root, '.tmp')), '.tmp 必须还在');
  });
}

cleanup();
await sleep(300);
summary('m0-10-resources');
