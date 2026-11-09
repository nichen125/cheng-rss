#!/usr/bin/env node
// 0.6 Job runner —— 验收
//
// 判据（PLAN §19.2）：
//   ① 入队 100 个 → 全部 done
//   ② 同一 dedupe_key 只留 1 条
//   ③ handler 抛错 → attempts=3 后置 dead
//   ④ 杀进程后重启，running 被重置为 pending
//   ⑤（补充）认领是原子的：两个并发 runner 不会领到同一任务
//   ⑥（补充）退避生效：失败后 run_after 被推后
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');

if (!existsSync(nodeBin)) {
  console.error('项目内 node 缺失，先运行 bootstrap');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m006-'));
const dataDir = join(tmp, 'data');

// 在项目内跑一段探测代码，复用真实模块
const probe = String.raw`
import { mkdirSync } from 'node:fs';
import { openDb } from './src/server/db/client.ts';
import { migrate } from './src/server/db/migrate.ts';
import { enqueue, claimBatch, completeJob, failJob, recoverStaleJobs, queueStats, STALE_LOCK_MS }
  from './src/server/jobs/queue.ts';
import { JobRunner } from './src/server/jobs/runner.ts';
import { buildHandlers } from './src/server/jobs/handlers.ts';

const dataDir = process.env.CHENG_RSS_DATA_DIR;
const mode = process.env.CHENG_RSS_MODE;
mkdirSync(dataDir, { recursive: true });
const h = openDb({ dataDir });
migrate(h.db);

if (mode === 'basics') {
  // ① 入队 100 个并跑完
  for (let i = 0; i < 100; i++) {
    enqueue(h.db, { kind: 'noop', payload: { echo: i } });
  }
  const runner = new JobRunner({
    db: h.db,
    handlers: buildHandlers({ dataDir }),
    pollMs: 20,
  });
  runner.start();

  // 等所有任务离开 pending/running
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const s = queueStats(h.db);
    if (s.pending === 0 && s.running === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await runner.stop();
  const stats = queueStats(h.db);

  // ② dedupe
  const firstId = enqueue(h.db, { kind: 'noop', payload: {}, dedupeKey: 'same-key' });
  const secondId = enqueue(h.db, { kind: 'noop', payload: {}, dedupeKey: 'same-key' });
  const thirdId = enqueue(h.db, { kind: 'noop', payload: {}, dedupeKey: 'same-key' });
  const dupCount = h.db.prepare(
    "SELECT COUNT(*) c FROM jobs WHERE dedupe_key='same-key' AND status IN ('pending','running')"
  ).get().c;

  // ③ 失败到 dead —— 需要模拟三次认领再失败
  // 注意：failJob 在 attempts < max_attempts 时退回 pending 并退避，
  // 所以必须先把 run_after 拉回现在，否则第二次认领抢不到。
  const failId = enqueue(h.db, {
    kind: 'noop', payload: { fail: true, failMessage: 'boom' }, maxAttempts: 3,
  });
  for (let i = 0; i < 3; i++) {
    // 把退避时间清掉，模拟时间已到
    h.db.prepare('UPDATE jobs SET run_after=0 WHERE id=?').run(failId);
    const claimed = claimBatch(h.db, 'test-worker', 50).filter((j) => j.id === failId);
    if (claimed.length) failJob(h.db, failId, 'boom');
    else break;
  }
  const failRow = h.db.prepare('SELECT status, attempts, last_error FROM jobs WHERE id=?').get(failId);

  // ⑥ 退避：失败一次后 run_after 应被推后
  const backoffId = enqueue(h.db, { kind: 'noop', payload: { fail: true }, maxAttempts: 5 });
  claimBatch(h.db, 'test-worker', 50);
  const beforeFail = Date.now();
  failJob(h.db, backoffId, 'boom');
  const backoffRow = h.db.prepare('SELECT status, run_after FROM jobs WHERE id=?').get(backoffId);

  // ⑤ 原子认领的跨进程验证放在父进程里做（见下方 concurrentClaim）。
  // 这里只把待抢的任务准备好，不再本进程内抢。
  for (let i = 0; i < 40; i++) enqueue(h.db, { kind: 'noop', payload: { batch: i } });

  h.close();
  console.log(JSON.stringify({
    stats, dupCount,
    dedupe: { firstId, secondId, thirdId },
    failRow,
    backoff: { status: backoffRow.status, pushedBy: Number(backoffRow.run_after) - beforeFail },
  }));
  process.exit(0);
} else if (mode === 'claim-only') {
  const { claimBatch } = await import('./src/server/jobs/queue.ts');
  const ids = claimBatch(h.db, process.env.CHENG_RSS_TAG ?? 'sub', 20).map((j) => j.id);
  h.close();
  console.log(JSON.stringify({ ids }));
} else if (mode === 'stale') {
  // ④ 造一个"卡住"的 running 任务，模拟进程被杀
  enqueue(h.db, { kind: 'noop', payload: {} });
  const claimed = claimBatch(h.db, 'dead-worker', 1);
  const jobId = claimed[0].id;
  // 把锁时间改到很久以前
  h.db.prepare('UPDATE jobs SET locked_at=? WHERE id=?')
    .run(Date.now() - 60 * 60 * 1000, jobId);
  const before = h.db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status;

  // 新进程启动时应恢复
  const recovered = recoverStaleJobs(h.db);
  const after = h.db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status;

  // 锁未超时的不能被误恢复
  enqueue(h.db, { kind: 'noop', payload: {} });
  const fresh = claimBatch(h.db, 'live-worker', 1);
  const freshId = fresh[0].id;
  recoverStaleJobs(h.db);
  const freshStatus = h.db.prepare('SELECT status FROM jobs WHERE id=?').get(freshId).status;

  h.close();
  console.log(JSON.stringify({ before, recovered, after, freshStatus, STALE_LOCK_MS }));
} else if (mode === 'unknown-kind') {
  enqueue(h.db, { kind: 'no_such_handler', payload: {} });
  const runner = new JobRunner({ db: h.db, handlers: {}, pollMs: 20 });
  runner.start();
  await new Promise((r) => setTimeout(r, 600));
  await runner.stop();
  const row = h.db.prepare("SELECT status, last_error FROM jobs WHERE kind='no_such_handler'").get();
  h.close();
  console.log(JSON.stringify(row));
} else if (mode === 'starvation') {
  // ⑦ 队头阻塞：一种慢任务堆在前面时，后面别的 kind 能不能被认领。
  //
  // 真实库的形态：384 条 analyze（并发 2、每条几秒）排在 id 4662~5045，
  // 21 条 fetch_feed 排在 5046 之后。claimBatch 是
  // "ORDER BY priority DESC, id LIMIT 20" —— 每轮固定取到 20 条 analyze，
  // fetch_feed 永远进不了这个窗口，于是订阅再也不抓、简报永远没有新条目。
  //
  // 这里用"慢 noop + 快 count"复现：noop 并发 1、每条 sleep 25ms，
  // 60 条要 1.5 秒才排完；count 只有 5 条但 id 更大。
  const baseNoop = Number(h.db.prepare(
    "SELECT COUNT(*) c FROM jobs WHERE kind='noop' AND status='done'",
  ).get().c);
  const baseCount = Number(h.db.prepare(
    "SELECT COUNT(*) c FROM jobs WHERE kind='count' AND status='done'",
  ).get().c);
  for (let i = 0; i < 60; i++) {
    enqueue(h.db, { kind: 'noop', payload: { sleepMs: 25, echo: i } });
  }
  for (let i = 0; i < 5; i++) {
    enqueue(h.db, { kind: 'count', payload: { key: 'starve-' + i } });
  }
  const runner = new JobRunner({ db: h.db, handlers: buildHandlers({ dataDir }), pollMs: 10 });
  runner.start();
  // 只等 1.2 秒：远不足以排完 60 条慢任务，所以"count 有没有跑过"
  // 只取决于它能不能被认领，而不取决于前面排完了没有。
  await new Promise((r) => setTimeout(r, 1200));
  await runner.stop();
  const done = (kind) => Number(h.db.prepare(
    "SELECT COUNT(*) c FROM jobs WHERE kind=? AND status='done'",
  ).get(kind).c);
  const res = {
    noopDone: done('noop') - baseNoop,
    countDone: done('count') - baseCount,
  };
  h.close();
  console.log(JSON.stringify(res));
}
`;

function runProbe(mode, extraEnv = {}) {
  return new Promise((res) => {
    const p = spawn(nodeBin, [
      '--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', probe,
    ], {
      cwd: root,
      env: { ...process.env, CHENG_RSS_DATA_DIR: dataDir, CHENG_RSS_MODE: mode, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      if (code !== 0) {
        console.error(`探测 ${mode} 失败 (code ${code}):\n${err.slice(0, 800)}`);
        res(null);
        return;
      }
      try {
        res(JSON.parse(out.trim().split('\n').pop()));
      } catch {
        console.error(`探测 ${mode} 输出无法解析:\n${out.slice(0, 500)}\n${err.slice(0, 500)}`);
        res(null);
      }
    });
  });
}

group('0.6 Job runner');

const basics = await runProbe('basics');

if (basics) {
  check('入队 100 个任务全部 done', () => {
    return ok(basics.stats.done >= 100 && basics.stats.pending === 0,
      `done=${basics.stats.done} pending=${basics.stats.pending} running=${basics.stats.running}`);
  });

  check('同 dedupe_key 只保留 1 条', () => eq(basics.dupCount, 1));
  check('重复入队返回 null（幂等）', () => {
    return ok(basics.dedupe.secondId === null && basics.dedupe.thirdId === null,
      `second=${basics.dedupe.secondId} third=${basics.dedupe.thirdId}`);
  });

  check('失败 3 次后置为 dead', () => eq(basics.failRow.status, 'dead'));
  check('dead 任务 attempts = max_attempts', () => eq(Number(basics.failRow.attempts), 3));
  check('dead 任务保留了 last_error', () => {
    return ok(String(basics.failRow.last_error ?? '').includes('boom'),
      `实际: ${basics.failRow.last_error}`);
  });

  check('失败后退避：run_after 被推后而非立即重试', () => {
    return ok(basics.backoff.pushedBy > 30_000,
      `仅推后 ${basics.backoff.pushedBy}ms，应立即重试会烧完尝试次数`);
  });
  check('失败未到上限时状态回到 pending', () => eq(basics.backoff.status, 'pending'));
}

// ── ⑤ 跨进程并发认领（必须真并发才测得出）──────────────────
// 单进程同步调用下 BEGIN 与 BEGIN IMMEDIATE 行为一致，
// 只有两个真实进程同时抢才能暴露"先读后写"的竞态。
//
// 注意：两个子进程不一定都能抢到 —— 先启动的可能一次拿完。
// 因此断言的核心是"交集为 0"，而不是"两边都有"。
const claimResults = await Promise.all([
  runProbe('claim-only', { CHENG_RSS_TAG: 'w-A' }),
  runProbe('claim-only', { CHENG_RSS_TAG: 'w-B' }),
]);
const aIds = claimResults[0]?.ids ?? [];
const bIds = claimResults[1]?.ids ?? [];
const overlap = aIds.filter((id) => bIds.includes(id));

check('两进程并发认领：至少一方抢到任务', () => {
  return ok(aIds.length + bIds.length > 0, `A=${aIds.length} B=${bIds.length}`);
});
check('两进程并发认领无交集（BEGIN IMMEDIATE 原子性）', () => {
  return ok(overlap.length === 0, `A=${aIds.length} B=${bIds.length} 交集=${overlap.length}`);
});
check('两进程认领总数不超过队列（无重复派发）', () => {
  return ok(new Set([...aIds, ...bIds]).size === aIds.length + bIds.length,
    `A+B=${aIds.length + bIds.length}，去重后 ${new Set([...aIds, ...bIds]).size}`);
});

// ── ④ 僵死任务恢复 ─────────────────────────────────────────
const stale = await runProbe('stale');
if (stale) {
  check('卡住的 running 任务被恢复为 pending', () => {
    return ok(stale.before === 'running' && stale.after === 'pending',
      `before=${stale.before} after=${stale.after} recovered=${stale.recovered}`);
  });
  check('锁未超时的 running 不被误恢复', () => {
    return eq(stale.freshStatus, 'running');
  });
}

// ── 未知 kind 进死信 ───────────────────────────────────────
const unknown = await runProbe('unknown-kind');
if (unknown) {
  check('未知 kind 的任务置为 dead 并记录原因', () => {
    return ok(unknown.status === 'dead' && String(unknown.last_error ?? '').includes('no_such_handler'),
      `status=${unknown.status} err=${unknown.last_error}`);
  });
}

// ── ⑦ 队头阻塞（真实库踩到的：简报一直生成不出来）────────────
const starve = await runProbe('starvation');
if (starve) {
  check('慢任务的队头不挡住后面的快任务', () => {
    return ok(starve.countDone > 0,
      `noop done=${starve.noopDone}/60（没排完是预期的），count done=${starve.countDone}/5`
        + ' —— count 一条都没跑到，说明认领窗口被前面的 kind 占满了');
  });
}

rmSync(tmp, { recursive: true, force: true });
summary('m0-06-jobs');
