#!/usr/bin/env node
// 3.4 定时生成 + 推送 —— 验收
//
// 判据（PLAN §19.5 3.4）：
//   ① 改时间到 08:00 触发一次
//   ② 失败重试且不重复推
//   ③ 无新内容不发空简报
//
// 这三条的字面意思都容易被写成"能跑就行"。真正要守住的是**三种否决条件
// 必须各自留下持久痕迹**，否则：
//   · 只看"有没有 digests 行"→ 无内容时每分钟重试一次（1440 次/天，每次都聚类+调模型）
//   · 只记"跑过"→ 一次网络抖动就当天永久放弃
// 所以本文件的重点是状态机：none / generated / skipped / failed / pending，
// 以及每次转移都要能解释。
//
// 另有一条容易被漏掉的：period_start 同时承担"窗口起点"和"哪一天"两个职责时，
// 用户把生成时间从 08:00 改到 09:00 会让同一天多出第二份简报。m3-04 专门盯这个。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, gt, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const {
  digestDue, digestStatus, parseDigestConfig, recordAttempt, recordSkip,
  localDayStart, dueAt, DEFAULT_DIGEST_CONFIG,
  MAX_DELIVER_ATTEMPTS, RETRY_BACKOFF_MIN,
} = await import('../../src/server/digest/schedule.ts');
const { openDb } = await import('../../src/server/db/client.ts');
const { migrate } = await import('../../src/server/db/migrate.ts');

const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m304-'));
const h = openDb({ dataDir: tmp });
migrate(h.db);
const DB = h.db;
const UID = 'u_sc';
DB.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
  .run(UID, 'sc@t.local', 'SC', 'owner', Date.now());

const CFG = { ...DEFAULT_DIGEST_CONFIG };

/** 造一个"今天 08:05"的时间点（本地） */
function todayAt(hh, mm) {
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

function addDigest(dayKey, id = 'dg_t') {
  DB.prepare(`INSERT INTO digests (id, user_id, kind, title, intro, body_md, period_start,
      period_end, entry_count, cluster_count, model, cost_usd, created_at, day_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, UID, 'daily', 't', 'i', 'b', dayKey, dayKey + 86400_000, 3, 2, 'm', 0.01, Date.now(), dayKey);
}

function reset() {
  DB.prepare('DELETE FROM digests WHERE user_id = ?').run(UID);
  DB.prepare('DELETE FROM digest_skips WHERE user_id = ?').run(UID);
  DB.prepare('DELETE FROM digest_attempts WHERE user_id = ?').run(UID);
}

// ── 配置解析 ────────────────────────────────────────────────
group('3.4 调度 · 配置');

check('默认 08:00 且启用（§9.1）', () => ok(
  DEFAULT_DIGEST_CONFIG.at === '08:00' && DEFAULT_DIGEST_CONFIG.enabled === true,
  JSON.stringify(DEFAULT_DIGEST_CONFIG),
));
check('坏配置退回默认（不是抛，也不是变成关闭）', () => {
  const c = parseDigestConfig({ at: '25:99', enabled: 'x' });
  return ok(c.at === '08:00' && c.enabled === true, JSON.stringify(c));
});
check('合法时间被接受', () => eq(parseDigestConfig({ at: '06:30' }).at, '06:30'));
check('边界时间 00:00 与 23:59 都合法', () => ok(
  parseDigestConfig({ at: '00:00' }).at === '00:00'
  && parseDigestConfig({ at: '23:59' }).at === '23:59',
  `${parseDigestConfig({ at: '00:00' }).at} / ${parseDigestConfig({ at: '23:59' }).at}`,
));
check('enabled=false 被保留（用户关掉简报是明确意图，不能被默认值盖掉）', () =>
  eq(parseDigestConfig({ enabled: false }).enabled, false));
check('null / 非对象退回默认', () => ok(
  parseDigestConfig(null).at === '08:00' && parseDigestConfig('x').at === '08:00',
));

// ── ① 时间判断 ──────────────────────────────────────────────
group('3.4 调度 · 时间');

check('dueAt 落在本地 HH:MM:00.000', () => {
  const t = dueAt(todayAt(12, 0), '08:00');
  const d = new Date(t);
  return ok(d.getHours() === 8 && d.getMinutes() === 0 && d.getSeconds() === 0
    && d.getMilliseconds() === 0, d.toString());
});
check('同一本地日里不同时刻算出的触发点相同', () => {
  const a = dueAt(todayAt(0, 30), '08:00');
  const b = dueAt(todayAt(23, 30), '08:00');
  return eq(a, b);
});
check('localDayStart 是本地 00:00:00.000', () => {
  const d = new Date(localDayStart(todayAt(13, 0)));
  return ok(d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0
    && d.getMilliseconds() === 0, d.toString());
});

{
  reset();
  const before = digestDue(DB, UID, CFG, todayAt(7, 59));
  check('07:59 还没到 08:00 → 不跑', () => ok(!before.due && /未到/.test(before.reason), before.reason));
  const after = digestDue(DB, UID, CFG, todayAt(8, 0));
  check('恰好 08:00 → 该跑（左闭，不是 08:01 才开始）', () => ok(after.due, after.reason));
  const later = digestDue(DB, UID, CFG, todayAt(8, 5));
  check('08:05 仍该跑（错过整点也要补，不是只有那一分钟）', () => ok(later.due, later.reason));
}

// ── ① 触发一次 ──────────────────────────────────────────────
group('3.4 调度 · 触发一次');

{
  reset();
  addDigest(localDayStart(Date.now()), 'dg_once');
  const d = digestDue(DB, UID, CFG, todayAt(8, 5));
  check('今天已生成 → 不再跑', () => ok(!d.due && /今天已生成/.test(d.reason), d.reason));
  // 但第二天同一时刻要跑
  const tomorrow = todayAt(8, 5) + 86400_000;
  const d2 = digestDue(DB, UID, CFG, tomorrow);
  check('第二天同一时刻又能跑（不是"生成过一次就永久停"）', () => ok(d2.due, d2.reason));
}

{
  reset();
  const d = digestDue(DB, UID, CFG, todayAt(8, 5));
  check('今天没生成过 → 该跑', () => ok(d.due, d.reason));
}

// ── ③ 无内容不发空简报 ──────────────────────────────────────
group('3.4 调度 · 无内容');

{
  reset();
  const day = localDayStart(Date.now());
  recordSkip(DB, UID, CFG, day, '最近 24 小时没有新条目');
  const d = digestDue(DB, UID, CFG, todayAt(8, 1));
  check('已判定"无内容" → 当天不再跑', () =>
    ok(!d.due && /已跳过/.test(d.reason), d.reason));
  check('跳过原因带出来（用户问"为什么没简报"要有答案）', () =>
    ok(/没有新条目/.test(d.reason), d.reason));

  // 关键：跳过不能挡住第二天
  const d2 = digestDue(DB, UID, CFG, todayAt(8, 1) + 86400_000);
  check('跳过只影响当天，第二天照跑', () => ok(d2.due, d2.reason));

  // status 要如实反映
  const st = digestStatus(DB, UID, CFG, todayAt(9, 0));
  check('状态是 skipped 且带原因', () => ok(
    st.state === 'skipped' && /没有新条目/.test(String(st.skipReason)),
    JSON.stringify(st),
  ));
  check('skipped 时 digestId 为空（不是伪造一个空简报）', () => eq(st.digestId, null));
}

// ── ② 失败重试 ──────────────────────────────────────────────
group('3.4 调度 · 失败重试');

{
  reset();
  const day = localDayStart(Date.now());

  check(`退避表长度与最大尝试次数一致（${MAX_DELIVER_ATTEMPTS} 次）`, () =>
    ok(RETRY_BACKOFF_MIN.length >= 1 && MAX_DELIVER_ATTEMPTS >= 2,
      `backoff=${JSON.stringify(RETRY_BACKOFF_MIN)} max=${MAX_DELIVER_ATTEMPTS}`));

  // 第一次失败 → 立刻不该重试（要退避）
  recordAttempt(DB, UID, CFG, day, false, 'timeout', todayAt(8, 0));
  const d1 = digestDue(DB, UID, CFG, todayAt(8, 1));
  check('第一次失败后 1 分钟不重试（退避 10 分钟）', () =>
    ok(!d1.due && /退避/.test(d1.reason), d1.reason));

  // 等过退避窗口 → 该重试
  const d2 = digestDue(DB, UID, CFG, todayAt(8, 15));
  check('过了退避窗口 → 重试', () => ok(d2.due, d2.reason));

  // 三次失败 → 当天放弃
  DB.prepare('DELETE FROM digest_attempts WHERE user_id = ?').run(UID);
  for (let i = 0; i < MAX_DELIVER_ATTEMPTS; i++) {
    recordAttempt(DB, UID, CFG, day, false, 'boom', todayAt(8, i * 30));
  }
  const d3 = digestDue(DB, UID, CFG, todayAt(23, 0));
  check(`尝试 ${MAX_DELIVER_ATTEMPTS} 次后当天放弃`, () =>
    ok(!d3.due && new RegExp(`已尝试 ${MAX_DELIVER_ATTEMPTS} 次`).test(d3.reason), d3.reason));
  const st = digestStatus(DB, UID, CFG, todayAt(23, 0));
  check('状态是 failed 且带最后一次错误', () =>
    ok(st.state === 'failed' && st.lastError === 'boom', JSON.stringify(st)));
  check('failed 时把尝试次数报出来（排障要知道试了几次）', () =>
    eq(st.attempts, MAX_DELIVER_ATTEMPTS));

  // 第二天重置
  const d4 = digestDue(DB, UID, CFG, todayAt(8, 0) + 86400_000);
  check('失败的放弃只影响当天，第二天重新开始', () => ok(d4.due, d4.reason));
}

// ── ② 不重复推 ──────────────────────────────────────────────
group('3.4 调度 · 不重复');

{
  reset();
  const day = localDayStart(Date.now());
  const first = digestDue(DB, UID, CFG, todayAt(8, 0));
  check('首轮该跑', () => ok(first.due, first.reason));

  addDigest(day, 'dg_dup');
  recordAttempt(DB, UID, CFG, day, true, null, todayAt(8, 0));

  const again = digestDue(DB, UID, CFG, todayAt(8, 30));
  check('生成成功后同一天不再跑（不重复推）', () =>
    ok(!again.due && /今天已生成/.test(again.reason), again.reason));

  const st = digestStatus(DB, UID, CFG, todayAt(9, 0));
  check('状态是 generated 且带 digestId', () =>
    ok(st.state === 'generated' && st.digestId === 'dg_dup', JSON.stringify(st)));
  check('generated 状态下 nextAt 指向明天（UI 显示"下次 明天 08:00"）', () =>
    ok(st.nextAt > todayAt(9, 0), new Date(st.nextAt).toString()));
}

// ── 唯一索引兜底 ────────────────────────────────────────────
group('3.4 调度 · 库层幂等');

{
  reset();
  const day = localDayStart(Date.now());
  addDigest(day, 'dg_first');
  let threw = false;
  try {
    // 绕过应用层的判断，直接插第二条同一天的行 —— 库层必须挡住
    addDigest(day, 'dg_second');
  } catch {
    threw = true;
  }
  check('(user_id, kind, day_key) 唯一索引挡住同一天的第二份简报', () => {
    const n = DB.prepare('SELECT COUNT(*) c FROM digests WHERE user_id = ? AND day_key = ?')
      .get(UID, day);
    return ok(threw && Number(n.c) === 1, `抛错=${threw} 行数=${n.c}`);
  });
}

// ── 改时间不产生第二份 ──────────────────────────────────────
//
// 这是 3.4 里最容易漏的一个：period_start 若同时当"窗口起点"用，
// 改时间会移动窗口起点 → 唯一索引不再命中 → 同一天两份简报。
{
  reset();
  const day = localDayStart(Date.now());
  addDigest(day, 'dg_0800');

  // 用户把时间从 08:00 改到 09:00，然后 09:05 扫一遍
  const cfg9 = { ...CFG, at: '09:00' };
  const d = digestDue(DB, UID, cfg9, todayAt(9, 5));
  check('改生成时间后同一天不会生成第二份', () =>
    ok(!d.due && /今天已生成/.test(d.reason), d.reason));
  check('库里仍然只有一份', () =>
    eq(Number(DB.prepare('SELECT COUNT(*) c FROM digests WHERE day_key = ?').get(day).c), 1));
}

// ── enabled=false ───────────────────────────────────────────
group('3.4 调度 · 关闭');

{
  reset();
  const off = { ...CFG, enabled: false };
  const d = digestDue(DB, UID, off, todayAt(8, 5));
  check('关闭简报后不跑', () => ok(!d.due && /已关闭/.test(d.reason), d.reason));
  const st = digestStatus(DB, UID, off, todayAt(8, 5));
  check('状态里 enabled=false 且 state 不是 pending', () =>
    ok(st.enabled === false && st.state !== 'pending', JSON.stringify(st)));
}

// ── 日界与状态补全 ──────────────────────────────────────────
group('3.4 调度 · 日界与状态');

{
  reset();
  // 昨天已生成，今天还没到点
  const day = localDayStart(Date.now());
  addDigest(day - 86400_000, 'dg_yesterday');
  const st = digestStatus(DB, UID, CFG, todayAt(7, 0));
  check('昨天的简报不算今天已生成', () => ok(
    st.state === 'none' && st.digestId === null, JSON.stringify(st),
  ));
  const st2 = digestStatus(DB, UID, CFG, todayAt(8, 5));
  check('过了触发点但还没跑 → state=pending（UI 显示"正在准备"）', () =>
    eq(st2.state, 'pending'));
  check('pending 时 nextAt 就是今天的触发点（而不是明天）', () =>
    eq(st2.nextAt, dueAt(todayAt(8, 5), CFG.at)));
}

check('记录的尝试按 day_key 隔离（昨天的失败不影响今天）', () => {
  reset();
  const day = localDayStart(Date.now());
  for (let i = 0; i < MAX_DELIVER_ATTEMPTS; i++) {
    recordAttempt(DB, UID, CFG, day - 86400_000, false, 'old', todayAt(8, i));
  }
  const d = digestDue(DB, UID, CFG, todayAt(9, 0));
  return ok(d.due, d.reason);
});

check('recordSkip 是 upsert（同一天重复跳过不报错）', () => {
  reset();
  const day = localDayStart(Date.now());
  recordSkip(DB, UID, CFG, day, '理由 A');
  let threw = false;
  try { recordSkip(DB, UID, CFG, day, '理由 B'); } catch { threw = true; }
  const row = DB.prepare('SELECT reason FROM digest_skips WHERE user_id=? AND day_key=?')
    .get(UID, day);
  return ok(!threw && row.reason === '理由 B', `抛错=${threw} reason=${row?.reason}`);
});

check('尝试记录保留完整轨迹（不是只留最后一条）', () => {
  reset();
  const day = localDayStart(Date.now());
  recordAttempt(DB, UID, CFG, day, false, 'e1', todayAt(8, 0));
  recordAttempt(DB, UID, CFG, day, false, 'e2', todayAt(9, 0));
  recordAttempt(DB, UID, CFG, day, true, null, todayAt(10, 0));
  const n = DB.prepare('SELECT COUNT(*) c FROM digest_attempts WHERE day_key=?').get(day);
  return eq(Number(n.c), 3);
});

// ── 调度查询的性能 ──────────────────────────────────────────
group('3.4 调度 · 性能');

{
  reset();
  const day = localDayStart(Date.now());
  // 造 200 个用户的量级：只看单用户成本，但要确认不会被历史拖慢
  for (let i = 0; i < 200; i++) addDigest(day - (i + 1) * 86400_000, `dg_h${i}`);
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) digestDue(DB, UID, CFG, todayAt(8, 5));
  const ms = (performance.now() - t0) / 200;
  check(`单用户判断 < 2ms（实测 ${ms.toFixed(2)}ms；每分钟扫一遍的全部用户成本）`, () =>
    ok(ms < 2, `${ms.toFixed(2)}ms`));
}

// ── 端到端：runDigest 的三条否决路径 ────────────────────────
//
// 上面测的都是 schedule.ts 的纯函数。这一节跑真正的 runDigest —— 否则
// "无内容不发空简报"只验证了判定函数，没验证调用方真的按判定结果行事。
// 这是最容易出现"两半都对但接不上"的地方。
group('3.4 调度 · 端到端');

const { listUsersForDigest } = await import('../../src/server/digest/users.ts');
const { runDigest } = await import('../../src/server/digest/run.ts');

check('listUsersForDigest 只列出开启简报的用户', () => {
  reset();
  DB.prepare('INSERT OR REPLACE INTO settings (user_id, digest_config) VALUES (?, ?)')
    .run(UID, JSON.stringify({ enabled: true, at: '08:00' }));
  const on = listUsersForDigest(DB);
  const hasOn = on.some((u) => u.userId === UID);

  DB.prepare('UPDATE settings SET digest_config = ? WHERE user_id = ?')
    .run(JSON.stringify({ enabled: false }), UID);
  const off = listUsersForDigest(DB);
  const hasOff = off.some((u) => u.userId === UID);

  return ok(hasOn && !hasOff, `开启时在列表=${hasOn}，关闭时在列表=${hasOff}`);
});

check('没配 settings 行时按默认（开启）处理', () => {
  DB.prepare('DELETE FROM settings WHERE user_id = ?').run(UID);
  const rows = listUsersForDigest(DB);
  return ok(rows.some((u) => u.userId === UID), JSON.stringify(rows.map((u) => u.userId)));
});

check('坏 digest_config 不让整个扫描崩（退回默认）', () => {
  DB.prepare('INSERT OR REPLACE INTO settings (user_id, digest_config) VALUES (?, ?)')
    .run(UID, '{不是 JSON');
  const rows = listUsersForDigest(DB);
  const row = rows.find((u) => u.userId === UID);
  return ok(row !== undefined && row.config === null, JSON.stringify(row));
});

// runDigest 需要 AppContext。这里只测它在"没 key"与"无内容"两条路上的行为，
// 两条都在调模型之前返回，所以不需要 mock 上游。
const ctx = {
  cfg: {
    dataDir: tmp, port: 0, host: '127.0.0.1',
    ai: {
      baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'M304_NO_KEY',
      models: { fast: 'f', strong: 's', embed: 'e' },
      budget: { dailyUsd: 0, monthlyUsd: 0 },
    },
  },
  dbh: h,
  version: 'test',
  startedAt: Date.now(),
};

reset();
DB.prepare('INSERT OR REPLACE INTO settings (user_id, digest_config) VALUES (?, ?)')
  .run(UID, JSON.stringify({ enabled: true, at: '00:00' }));

delete process.env.M304_NO_KEY;
{
  const noKey = await runDigest(ctx, { userId: UID, manual: true });
  check('没配 key → 明确说"无法生成"而不是产出空简报', () =>
    ok(!noKey.ok && /API key/.test(String(noKey.reason)) && /无法生成/.test(String(noKey.reason)),
      String(noKey.reason)));
  check('没配 key → 记了一次失败尝试（不是静默返回）', () =>
    eq(Number(DB.prepare('SELECT COUNT(*) c FROM digest_attempts WHERE user_id = ?').get(UID).c), 1));
  check('没配 key → 没有 digest 行', () =>
    eq(Number(DB.prepare('SELECT COUNT(*) c FROM digests WHERE user_id = ?').get(UID).c), 0));
}

// 有 key 但窗口内没条目 → 跳过，且不产生 digest
process.env.M304_NO_KEY = 'sk-test';
// 必须清缓存：aiForUser 的缓存 key 是「userId + 配置内容」，而配置里
// 存的是**环境变量名**（apiKeyEnv），不含它的值。上面那个"没 key"的客户端
// 在构造时把 apiKey 读成了 null，配置没变 → 缓存命中 → 这里还会拿到 null。
// 生产里环境变量不会在进程存活期间变，所以这不是 bug；测试要模拟"改完
// 环境变量重启"，就得显式清一次（等价于重启）。
const { resetAiCache } = await import('../../src/server/ai/service.ts');
resetAiCache();
reset();
{
  const empty = await runDigest(ctx, { userId: UID, manual: true, now: todayAt(8, 5) });
  check('窗口内没有条目 → 不生成简报', () =>
    ok(!empty.ok && /没有新条目/.test(String(empty.reason)), String(empty.reason)));
  check('无内容 → 落了 digest_skips 记录（否则每分钟重试）', () =>
    eq(Number(DB.prepare('SELECT COUNT(*) c FROM digest_skips WHERE user_id = ?').get(UID).c), 1));
  check('无内容 → 仍然没有 digest 行（不发空简报）', () =>
    eq(Number(DB.prepare('SELECT COUNT(*) c FROM digests WHERE user_id = ?').get(UID).c), 0));

  // 落过 skip 之后同一天不该再跑（自动路径）
  const again = await runDigest(ctx, { userId: UID, now: todayAt(9, 0) });
  check('已跳过 → 后续自动调度不再跑（不只是手动时才看 skip）', () =>
    ok(!again.ok && /已跳过/.test(String(again.reason)), String(again.reason)));

  // 手动触发不受 skip 限制（用户点了按钮就该试一次）
  const manual = await runDigest(ctx, { userId: UID, manual: true, now: todayAt(9, 30) });
  check('手动触发无视 skip（用户点按钮时不该被"今天已跳过"挡住）', () =>
    ok(/没有新条目/.test(String(manual.reason)), String(manual.reason)));
}

delete process.env.M304_NO_KEY;

// ── 路由顺序（真机回归）────────────────────────────────────
//
// `/digests/status` 若注册在 `/digests/:id` 之后，"status" 会被当成一个 id
// 去查库 → 404「简报不存在」。而这个 404 的措辞恰好与"今天还没有简报"
// 极为相似，所以它看起来不像 bug，像一个正常状态 —— 正是这种错误最容易
// 一路带到线上。§7.5 在 /entries 上踩过同一个坑。
group('3.4 调度 · 路由顺序');

{
  const { spawn } = await import('node:child_process');
  const { mkdtempSync: mkd, existsSync: ex } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const { join: jn, resolve: rs, dirname: dn } = await import('node:path');
  const { fileURLToPath: fu } = await import('node:url');
  const { killTree: kt } = await import('../lib/proc.mjs');

  const ROOT = rs(dn(fu(import.meta.url)), '../..');
  const BIN = jn(ROOT, 'dist', process.platform === 'win32'
    ? `ai-rss-${process.platform}-${process.arch}.exe`
    : `ai-rss-${process.platform}-${process.arch}`);

  if (!ex(BIN)) {
    console.log('  \u001b[33mSKIP\u001b[0m  没有构建产物，跳过路由断言');
  } else {
    const dir = mkd(jn(td(), 'ai-rss-m304r-'));
    const port = 45100 + Math.floor(Math.random() * 400);
    const base = `http://127.0.0.1:${port}`;
    const proc = spawn(BIN, ['serve', '--data', jn(dir, 'data'), '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AI_API_KEY: '' },
    });
    const cleanup2 = () => {
      kt(proc.pid);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    process.on('exit', cleanup2);

    let up2 = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) { up2 = true; break; } } catch { /* 起 */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    check('路由测试用的服务就绪', () => ok(up2, '二进制没起来'));

    if (up2) {
      await fetch(`${base}/api/v1/auth/setup`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'r@t.local', password: 'rpass1234567' }),
      });
      const lr = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'r@t.local', password: 'rpass1234567' }),
      });
      const ck = { cookie: (lr.headers.get('set-cookie') ?? '').split(';')[0] };

      const st = await fetch(`${base}/api/v1/digests/status`, { headers: ck });
      const stBody = await st.json();
      check('GET /digests/status 返回 200（没有被 :id 抢走）', () =>
        ok(st.status === 200, `status=${st.status} body=${JSON.stringify(stBody).slice(0, 120)}`));
      check('status 的结构里有 state 而不是 error', () =>
        ok(typeof stBody.state === 'string' && !stBody.error,
          JSON.stringify(stBody).slice(0, 160)));

      const list = await (await fetch(`${base}/api/v1/digests`, { headers: ck })).json();
      check('GET /digests 返回 items 数组（没有简报时是空数组不是 404）', () =>
        ok(Array.isArray(list.items) && list.items.length === 0, JSON.stringify(list)));

      const miss = await fetch(`${base}/api/v1/digests/dg_nope`, { headers: ck });
      check('不存在的 id 仍然是 404（别把 :id 也一起放过去）', () =>
        eq(miss.status, 404));
    }
    cleanup2();
  }
}

h.close();
rmSync(tmp, { recursive: true, force: true });

summary('m3-04-schedule');
process.exitCode = process.exitCode ?? 0;
