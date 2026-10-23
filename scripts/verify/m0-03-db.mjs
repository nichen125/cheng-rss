#!/usr/bin/env node
// 0.3 数据库访问层 —— 验收
//
// 判据（PLAN §19.2）：
//   ① WAL 生效
//   ② busy_timeout = 5000
//   ③ 写 1 万条 < 3s
//   ④ 两进程并发写不报 SQLITE_BUSY
//   ⑤（补充）正文 gzip 往返正确、短文本走未压缩分支
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, lt, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');

if (!existsSync(nodeBin)) {
  console.error('项目内 node 缺失，先运行 bootstrap');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m003-'));
const dataDir = tmp;
const dbPath = join(dataDir, 'app.db');

const probe = String.raw`
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from './src/server/db/migrate.ts';
import { openDb, readPragmas } from './src/server/db/client.ts';
import { packText, unpackText } from './src/server/db/text-blob.ts';

const dataDir = process.env.AI_RSS_DATA_DIR;
const mode = process.env.AI_RSS_MODE;

const h = openDb({ dataDir });

// Drizzle 传实例必须用 { client }。位置参数会被静默忽略并新建一个
// :memory: 连接 —— 表现为"写入成功但查不到"，是极难定位的坑。
// 这里断言 openDb 返回的 orm 确实绑在同一个连接上。
function ormBoundToSameConnection() {
  return h.orm.$client === h.db;
}

if (mode === 'single') {
  migrate(h.db);
  const pragmas = readPragmas(h.db);

  // 先建一个 user 满足外键
  h.db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run('u1', Date.now());

  const ins = h.db.prepare(
    'INSERT INTO entries (id,user_id,guid,url,url_norm,title,published_at,fetched_at) VALUES (?,?,?,?,?,?,?,?)'
  );
  const N = 10000;
  const now = Date.now();
  const t0 = performance.now();
  h.db.exec('BEGIN');
  for (let i = 0; i < N; i++) {
    ins.run('e' + i, 'u1', 'g' + i, 'https://e.com/' + i, 'e.com/' + i, 'T' + i, now - i * 1000, now);
  }
  h.db.exec('COMMIT');
  const insertMs = performance.now() - t0;
  const count = h.db.prepare('SELECT COUNT(*) c FROM entries').get().c;

  // 正文 gzip 往返
  const long = '台积电今日公布第三季度财报，营收同比增长百分之十二。'.repeat(60);
  const short = '短文';
  const longBack = unpackText(packText(long));
  const shortBack = unpackText(packText(short));
  const longRaw = Buffer.byteLength(long, 'utf8');
  const longPacked = packText(long).length;

  // 空值
  const nullBack = unpackText(packText(null));

  h.close();
  console.log(JSON.stringify({
    pragmas, count, insertMs, N,
    longOk: longBack === long,
    shortOk: shortBack === short,
    nullOk: nullBack === null,
    ratio: longRaw / longPacked,
    longRaw, longPacked,
    ormBound: ormBoundToSameConnection(),
  }));
} else {
  // 并发模式：两个进程交替写，看会不会 SQLITE_BUSY
  migrate(h.db);
  h.db.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run('u1', Date.now());
  const ins = h.db.prepare(
    'INSERT INTO entries (id,user_id,guid,url,url_norm,title,published_at,fetched_at) VALUES (?,?,?,?,?,?,?,?)'
  );
  const tag = process.env.AI_RSS_TAG;
  let errors = 0;
  const now = Date.now();
  for (let i = 0; i < 200; i++) {
    try {
      h.db.exec('BEGIN IMMEDIATE');
      ins.run(tag + i, 'u1', tag + i, 'https://e.com/' + tag + i, 'e/' + tag + i, 'T', now, now);
      h.db.exec('COMMIT');
    } catch (e) {
      errors++;
      try { h.db.exec('ROLLBACK'); } catch {}
      if (!/SQLITE_BUSY|locked/i.test(e.message)) throw e;
      // BUSY 重试由 busy_timeout 负责，走到这里说明超时了
      if (errors > 3) break;
    }
  }
  const count = h.db.prepare('SELECT COUNT(*) c FROM entries').get().c;
  h.close();
  console.log(JSON.stringify({ errors, count, tag }));
}
`;

function runProbe(mode, tag = '') {
  const out = execFileSync(nodeBin, [
    '--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', probe,
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AI_RSS_DATA_DIR: dataDir, AI_RSS_MODE: mode, AI_RSS_TAG: tag },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

group('0.3 数据库访问层');

let single;
try {
  single = runProbe('single');
} catch (e) {
  console.error('探测失败:\n' + (e.stderr || e.message));
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

check('journal_mode = wal', () => eq(single.pragmas.journal_mode, 'wal'));
check('busy_timeout = 5000', () => eq(Number(single.pragmas.busy_timeout), 5000));
check('foreign_keys = on', () => eq(Number(single.pragmas.foreign_keys), 1));
check('cache_size = -16000（16MB）', () => eq(Number(single.pragmas.cache_size), -16000));
check('mmap_size = 256MB', () => eq(Number(single.pragmas.mmap_size), 268435456));

check('插入 1 万条 < 3000ms', () => lt(single.insertMs, 3000, `${Math.round(single.insertMs)}ms`));
check('1 万条全部落库', () => eq(single.count, 10000));

check('正文 gzip 往返一致', () => ok(single.longOk, '解压结果与原文不符'));
check('短文本走未压缩分支且往返一致', () => ok(single.shortOk));
check('null 输入返回 null', () => ok(single.nullOk));
check('正文压缩比 > 2.0×', () => {
  return ok(single.ratio > 2.0,
    `压缩比 ${single.ratio.toFixed(2)}×（${single.longRaw}B → ${single.longPacked}B）`);
});

// 这条防的是一个静默 bug：drizzle(db) 传实例会被忽略并新建 :memory:，
// 表现为"写入成功但查不到"，不会报任何错。
check('Drizzle 绑定在同一连接上（不是隐式新建 :memory:）', () => {
  return ok(single.ormBound,
    'orm.$client !== db —— 极可能用了 drizzle(db) 而非 drizzle({client: db})，写入会进内存库');
});

// ── 并发写：两个进程同时跑 ──────────────────────────────────
// 用同一线程起两个子进程，模拟 CLI 与服务同时写
let concurrentOk = false;
let concurrentDetail = '';
try {
  const { spawn } = await import('node:child_process');
  const run = (tag) => new Promise((res) => {
    const p = spawn(nodeBin, [
      '--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', probe,
    ], {
      cwd: root,
      env: { ...process.env, AI_RSS_DATA_DIR: dataDir, AI_RSS_MODE: 'concurrent', AI_RSS_TAG: tag },
    });
    let sout = '', serr = '';
    p.stdout.on('data', (d) => { sout += d; });
    p.stderr.on('data', (d) => { serr += d; });
    p.on('close', (code) => res({ code, sout, serr }));
  });
  const [a, b] = await Promise.all([run('a'), run('b')]);
  const ra = a.code === 0 ? JSON.parse(a.sout.trim().split('\n').pop()) : null;
  const rb = b.code === 0 ? JSON.parse(b.sout.trim().split('\n').pop()) : null;
  if (!ra || !rb) {
    concurrentDetail = `子进程失败: a=${a.code} b=${b.code}\n${a.serr.slice(0, 300)}\n${b.serr.slice(0, 300)}`;
  } else {
    concurrentOk = ra.errors === 0 && rb.errors === 0;
    concurrentDetail = `BUSY 次数 a=${ra.errors} b=${rb.errors}；合计落库 ${(ra.count ?? 0) + (rb.count ?? 0)} 条`;
  }
} catch (e) {
  concurrentDetail = e.message;
}

check('两进程并发写无 SQLITE_BUSY（busy_timeout 生效）', () => ok(concurrentOk, concurrentDetail));

rmSync(tmp, { recursive: true, force: true });
summary('m0-03-db');
