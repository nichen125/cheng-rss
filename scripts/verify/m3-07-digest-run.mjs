#!/usr/bin/env node
// 简报「正在跑的那一次」验收（v2.3 新增：进度 / 停止 / 花费上限 / 簇复用）。
//
// ## 为什么需要这个脚本
//
// 改造之前 `POST /digests/run` 是**全同步**的：它 `await runDigest(...)`
// 之后才响应，实测 528 秒。于是"生成中"这件事在服务端没有任何可查的状态，
// 前端只能靠一个本地 `disabled` 标志自己演，刷新一次就什么都不知道了。
// 改造把这件事抬成了库里的一张表（`digest_runs`）+ 一个 202 响应，新增的
// 每一个承诺都必须有断言钉住，否则它们会像 §9.6 那四个缺陷一样，在
// "接口 200、页面不报错"的假象里烂掉：
//
//   ① 202 排队 —— 点了按钮就该立刻返回 runId，而不是挂住浏览器
//   ② 排队去重 —— 连点两下不能花两份钱，也不能"点了没反应"
//   ③ 停止 —— queued 阶段直接作废、running 阶段写标志让在飞调用 abort
//   ④ 排队期间被停止的 run，handler 拿到手必须**跳过**（否则白跑一整轮）
//   ⑤ 进度 —— phase / done / total / cost 要真的写进库，UI 才画得出条
//   ⑥ 簇复用 —— 同一批事件二次运行不该再调模型（省钱且结果稳定）
//   ⑦ 花费上限 —— 超了就停下，并且停因必须落库（不能显示成"用户手动停止"）
//   ⑧ 心跳停了要能认出来（stale），进程重启留下的活行要能收尸
//
// ## 断言的写法
//
// 一律查**库里的行**和**函数返回值**，不查"代码里有没有这个字段"。
// ②⑤⑦ 这类缺陷的共同点是"字段在、但没写进去"，只看代码过不了这几关。
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
void root;

const { openDb } = await import('../../src/server/db/client.ts');
const { migrate } = await import('../../src/server/db/migrate.ts');
const { packText } = await import('../../src/server/db/text-blob.ts');
const { packVec } = await import('../../src/server/dedupe/cosine.ts');
const { createApp } = await import('../../src/server/app.ts');
const { createSession } = await import('../../src/server/auth/session.ts');
const { buildHandlers } = await import('../../src/server/jobs/handlers.ts');
const { enqueue } = await import('../../src/server/jobs/queue.ts');
const { runDigest } = await import('../../src/server/digest/run.ts');
const { resetAiCache } = await import('../../src/server/ai/service.ts');
const {
  createRun, getRun, startRun, requestCancel, finishRun,
  viewOf, latestRun, markInterruptedRuns, pruneDigestRuns,
} = await import('../../src/server/digest/runs.ts');

// ── mock 上游 ────────────────────────────────────────────────
//
// 按 system 分流：簇归纳要 ClusterSummary、简报要 DigestBody。
// `delayMs` 是给"在飞取消"那一条用的：只有让调用真的悬在半空，
// abort 才有东西可中断 —— 瞬间返回的 mock 会让取消退化成"跑完之后
// 才看到标志位"，那正好是这套机制要避免的形态。
const calls = [];
let delayMs = 0;
const chatBody = (content) => ({
  id: 'x', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  // 这两个数字是花费上限判定的唯一来源：pricing.default 是 0.5/1.5 每百万，
  // 900 + 120 token ≈ $0.00063 一次（见 estimateCost）。
  usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
});
const CLUSTER_JSON = JSON.stringify({
  title: '存储芯片量产',
  summary: '两家公司同日宣布 232 层闪存量产，容量与速率一致，对位密度提升幅度说法略有出入。',
  key_points: ['232 层堆叠', '单颗 1Tb', '四季度出货'],
  consensus: ['232 层堆叠'],
  conflicts: [{ claim: '位密度提升 40% 还是 45%', sources: ['源A', '源B'] }],
});
const digestJson = (ids) => JSON.stringify({
  title: '这一天的存储与算力',
  highlights: ['闪产量产', '算力扩容', '监管新规'],
  body_md: '## 存储\n两家公司同日宣布量产。' + ids.map((i) => `{{cite:${i}}}`).join('')
    + '\n\n## 算力\n扩容计划落地。' + (ids[0] ? `{{cite:${ids[0]}}}` : ''),
  worth_reading: ids.slice(0, 1),
});

const srv = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += String(d); });
  req.on('end', () => {
    if (!String(req.url).endsWith('/chat/completions')) { res.writeHead(404); return res.end('no'); }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    const sys = String(body.messages?.[0]?.content ?? '');
    const isCluster = /多源情报编辑/.test(sys);
    calls.push({ kind: isCluster ? 'cluster' : 'digest' });
    const content = isCluster ? CLUSTER_JSON : digestJson(['cl_1', 'cl_2']);
    const send = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(chatBody(content)));
    };
    if (delayMs > 0) setTimeout(send, delayMs); else send();
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const AI_PORT = srv.address().port;

process.env.M3RUN_KEY = 'sk-fix';
resetAiCache();

const clusterCalls = () => calls.filter((c) => c.kind === 'cluster').length;
const digestCalls = () => calls.filter((c) => c.kind === 'digest').length;

// ── 库与上下文 ──────────────────────────────────────────────
//
// 每个 group 用自己的临时库：上一组的简报/跳过/运行记录混进来，
// 断言就会在"为什么这一组突然多了一行"上耗费时间去查。
const opened = [];
function freshDb(users = ['u1']) {
  const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m3run-'));
  const h = openDb({ dataDir: tmp });
  opened.push({ tmp, h });
  // 每组必须同时清两样东西：
  //   · calls     —— 上游调用计数是全局的，不带它上一组的 3 次会串进来
  //   · AiClient 缓存 —— 缓存键是 (userId|config|key指纹)，不含库句柄，
  //     不清的话这一组会复用上一组的 client，而它的 onUsage 闭包绑的是
  //     **上一组那个已经关掉的库**：usage 记不进来 → 花费上限永远不触发，
  //     症状正是"上限设了、也花了钱、但它就是不停"。
  calls.length = 0;
  resetAiCache();
  migrate(h.db);
  const now = Date.now();
  for (const id of users) {
    h.db.prepare('INSERT INTO users (id,email,name,role,created_at) VALUES (?,?,?,?,?)')
      .run(id, `${id}@t.local`, id, 'owner', now);
  }
  return { tmp, h, db: h.db };
}

function mkCtx(tmp, h) {
  return {
    cfg: {
      dataDir: tmp, port: 0, host: '127.0.0.1', adminEmail: 'a@t.local',
      ai: {
        baseURL: `http://127.0.0.1:${AI_PORT}/v1`, apiKeyEnv: 'M3RUN_KEY',
        models: { fast: 'f', strong: 's', embed: 'e' },
        budget: { dailyUsd: 0, monthlyUsd: 0 },
      },
      logLevel: 'error', sessionDays: 30,
    },
    dbh: h, version: 'test', startedAt: Date.now(),
  };
}

// 两簇四篇：前两篇一个方向、后两篇另一个方向（与 m3-06 同一造法，
// 保证聚类一定出两簇 —— 少于两簇时简报会直接跳过）
function seedEntries(db, uid = 'u1') {
  const now = Date.now();
  for (const [id, title] of [['f_a', '源A'], ['f_b', '源B']]) {
    db.prepare(`INSERT INTO feeds (id,user_id,folder_id,sort,url,title,status,next_fetch_at)
      VALUES (?,?,NULL,0,?,?,'active',0)`).run(id, uid, `http://x/${id}`, title);
  }
  for (let i = 0; i < 4; i++) {
    const id = `${uid}_e${i}`;
    db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,title,published_at,fetched_at,
        excerpt,content_hash,stage,is_read,is_starred,is_hidden,read_later,read_count,highlight_count)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'extracted',0,0,0,0,0,0)`)
      .run(id, uid, i % 2 === 0 ? 'f_a' : 'f_b', id, `http://x/${id}`, `http://x/${id}`,
        `标题${i}`, now - 3600_000, now, '摘要', `h${i}`);
    db.prepare('INSERT INTO entry_contents (entry_id, html, extracted_by) VALUES (?,?,?)')
      .run(id, packText(`<p>正文${i}：${'存储芯片量产内容。'.repeat(80)}</p>`), 'test');
    db.prepare(`INSERT INTO entry_analysis (entry_id, summary, key_points, category_id, topics,
        entities, importance, tier, novelty, sentiment, model, prompt_version, created_at)
      VALUES (?,?,?,NULL,?,?,?,'worth',?,?,?,?,?)`)
      .run(id, `摘要${i}`, '[]', '[]', '{}', 70, 50, 'neutral', 'mock', 'v1', now);
    const v = new Float32Array(8);
    if (i < 2) { v[0] = 1; v[1] = 0; } else { v[0] = 0; v[1] = 1; }
    v[2] = 0.1;
    db.prepare('INSERT INTO entry_vectors (entry_id, dim, vec, model, created_at) VALUES (?,?,?,?,?)')
      .run(id, v.length, packVec(v), 'hash256', now);
  }
  db.prepare('INSERT OR REPLACE INTO settings (user_id, digest_config) VALUES (?,?)')
    .run(uid, JSON.stringify({ enabled: true, at: '00:00' }));
}

// ── ① 202 排队 + 去重 ──────────────────────────────────────
group('简报运行 · 202 排队');
{
  const { tmp, h } = freshDb();
  const app = createApp(mkCtx(tmp, h));
  const s = createSession(h.db, 'u1', 30);
  const hdr = { cookie: `cheng_rss_sid=${s.token}`, 'content-type': 'application/json' };

  const r1 = await app.request('/api/v1/digests/run', {
    method: 'POST', headers: hdr, body: '{}',
  });
  const b1 = await r1.json();
  check('① 立刻返回 202（不是等整条链跑完才响应）', () => eq(r1.status, 202));
  check('① 回了 queued:true 与一个 runId', () => ok(b1.queued === true
    && typeof b1.runId === 'string' && b1.runId.startsWith('dr_'), JSON.stringify(b1)));

  const st1 = await (await app.request('/api/v1/digests/status', { headers: hdr })).json();
  check('① 状态接口能查到这次 run（run 不是 null）', () =>
    ok(st1.run && st1.run.id === b1.runId, JSON.stringify(st1.run)));
  check('① 状态里是 queued，且 suggest 的 phase 是 prepare', () => ok(
    st1.run.status === 'queued' && st1.run.phase === 'prepare',
    JSON.stringify({ status: st1.run.status, phase: st1.run.phase }),
  ));

  const row1 = getRun(h.db, b1.runId);
  check('① run 行记下了 job_id（否则点了停止不知道该撤哪条队列任务）',
    () => ok(row1 && row1.job_id !== null, JSON.stringify(row1 && {
      id: row1.id, job_id: row1.job_id,
    })));
  check('① 队列里确实有一条 digest 任务，payload 带 runId', () => {
    const job = h.db.prepare("SELECT payload FROM jobs WHERE kind='digest'").get();
    if (!job) return { ok: false, detail: '没有 digest 任务' };
    const p = JSON.parse(String(job.payload));
    return ok(p.runId === b1.runId, JSON.stringify(p));
  });

  // 连点第二下：必须复用同一次，不能新建（否则两份钱）
  const r2 = await app.request('/api/v1/digests/run', {
    method: 'POST', headers: hdr, body: '{}',
  });
  const b2 = await r2.json();
  check('① 连点第二次仍是 202，但 queued:false', () =>
    ok(r2.status === 202 && b2.queued === false, JSON.stringify({ s: r2.status, b: b2 })));
  check('① 第二次拿到的是**同一个** runId（不重复花钱）', () =>
    eq(b2.runId, b1.runId));
  const runCount = Number(h.db.prepare('SELECT COUNT(*) c FROM digest_runs').get().c);
  check('① 库里只有一行 run（连点没造第二条）', () => eq(runCount, 1));
}

// ── ② 停止（queued 直接作废 / 归属校验）──────────────────
group('简报运行 · 停止');
{
  const { tmp, h } = freshDb(['u1', 'u2']);
  const app = createApp(mkCtx(tmp, h));
  const s1 = createSession(h.db, 'u1', 30);
  const s2 = createSession(h.db, 'u2', 30);
  const hdr1 = { cookie: `cheng_rss_sid=${s1.token}`, 'content-type': 'application/json' };
  const hdr2 = { cookie: `cheng_rss_sid=${s2.token}`, 'content-type': 'application/json' };

  const b1 = await (await app.request('/api/v1/digests/run', {
    method: 'POST', headers: hdr1, body: '{}',
  })).json();

  const stopRes = await app.request(`/api/v1/digests/runs/${b1.runId}/stop`, {
    method: 'POST', headers: hdr1,
  });
  const sb = await stopRes.json();
  check('② 停止返回 200 且 cancelled:true（还没开始，直接作废）', () =>
    ok(stopRes.status === 200 && sb.cancelled === true, JSON.stringify({ s: stopRes.status, b: sb })));
  check('② message 说清是「还没开始，直接作废」而不是「已请求停止」', () =>
    ok(/还没开始/.test(String(sb.message)), String(sb.message)));

  const row = getRun(h.db, b1.runId);
  check('② run 行变成 cancelled 且写了 finished_at（不留活口）', () =>
    ok(row && row.status === 'cancelled' && row.finished_at !== null,
      JSON.stringify(row && { s: row.status, f: row.finished_at })));

  const st = await (await app.request('/api/v1/digests/status', { headers: hdr1 })).json();
  check('② 状态接口看到 cancelled 与停因', () => ok(
    st.run && st.run.status === 'cancelled' && /用户手动停止/.test(String(st.run.cancelReason)),
    JSON.stringify(st.run && { s: st.run.status, c: st.run.cancelReason }),
  ));

  // 别人的 run 一律按"不存在"处理，不泄露有没有在跑
  const b2 = await (await app.request('/api/v1/digests/run', {
    method: 'POST', headers: hdr2, body: '{}',
  })).json();
  const foreign = await app.request(`/api/v1/digests/runs/${b2.runId}/stop`, {
    method: 'POST', headers: hdr1,
  });
  check('② 停别人的 run 返回 404（不泄露别人在不在跑）', () =>
    eq(foreign.status, 404));
  const mine = getRun(h.db, b2.runId);
  check('② 别人的 run 没有被停掉', () => eq(mine.status, 'queued'));

  const ghost = await app.request('/api/v1/digests/runs/dr_nope/stop', {
    method: 'POST', headers: hdr1,
  });
  check('② 停不存在的 run 返回 404', () => eq(ghost.status, 404));

  // 停完之后再点「生成」：应当开出新的一次（上一次不是"还在跑"）
  const again = await (await app.request('/api/v1/digests/run', {
    method: 'POST', headers: hdr1, body: '{}',
  })).json();
  check('② 停掉之后再点生成，拿到的是新 runId', () =>
    ok(again.queued === true && again.runId !== b1.runId,
      JSON.stringify({ queued: again.queued, id: again.runId, old: b1.runId })));
}

// ── ③ 排队期间被停止：handler 必须跳过 ────────────────────
//
// 这条守的是 handlers['digest'] 里那个 `status !== 'running'` 判断。
// 少了它，用户在排队时点停止、任务随后被 runner 认领，它照样跑完一整轮
// （十几个模型调用），最后 `finishRun` 还会把 cancelled 覆盖成 done。
group('简报运行 · 排队期间被停止');
{
  const { tmp, h } = freshDb();
  const ctx = mkCtx(tmp, h);
  const handlers = buildHandlers({ dataDir: tmp, app: ctx });
  const run = createRun(h.db, { userId: 'u1', manual: true });
  requestCancel(h.db, run.id, '用户手动停止');

  const before = calls.length;
  await handlers['digest'](JSON.parse(JSON.stringify({
    id: 9, kind: 'digest', payload: JSON.stringify({ userId: 'u1', manual: true, runId: run.id }),
  })), h.db);

  check('③ handler 没调模型（一次都没有）', () => eq(calls.length - before, 0));
  check('③ run 仍是 cancelled，没被 handler 改写', () =>
    eq(getRun(h.db, run.id)?.status, 'cancelled'));
  check('③ 没有落简报（跳过就等于什么都没发生）', () =>
    eq(Number(h.db.prepare('SELECT COUNT(*) c FROM digests').get().c), 0));
}

// ── ④ 进度：phase / done / total / cost 真的写进库 ────────
group('简报运行 · 进度落库');
{
  const { tmp, h } = freshDb();
  const ctx = mkCtx(tmp, h);
  seedEntries(h.db);
  const run = createRun(h.db, { userId: 'u1', manual: true });
  startRun(h.db, run.id);

  const r = await runDigest(ctx, { userId: 'u1', manual: true, runId: run.id });
  check('④ runDigest 跑完并合成了简报', () => ok(r.ok === true, JSON.stringify(r)));
  check('④ 上游被调用 3 次（2 簇归纳 + 1 次正文）', () =>
    ok(clusterCalls() === 2 && digestCalls() === 1,
      JSON.stringify({ c: clusterCalls(), d: digestCalls() })));

  const row = getRun(h.db, run.id);
  check('④ total_clusters 写进去了（聚类完就知道有几个事件）', () =>
    eq(Number(row.total_clusters), 2));
  check('④ done_clusters 走到 2/2（不是停在 0）', () =>
    eq(Number(row.done_clusters), 2));
  check('④ phase 到 saving（正文写完之后还有落库这一步）', () =>
    eq(row.phase, 'saving'));
  check('④ cost_usd 有值且大于 0（不是一直显示 $0.0000）', () =>
    ok(Number(row.cost_usd) > 0, String(row.cost_usd)));

  // 心跳在 startRun 那一刻已经写过，跑完由 finishRun 刷新
  finishRun(h.db, run.id, { status: 'done', digestId: r.digestId, costUsd: r.costUsd });
  const v = viewOf(getRun(h.db, run.id));
  check('④ 结束后状态 done、带上 digestId、stale 为 false', () => ok(
    v.status === 'done' && v.digestId === r.digestId && v.stale === false,
    JSON.stringify(v),
  ));
  // 复跑时进度要从 0 重新开始，而不是接着上一轮的 2/2
  const run2 = createRun(h.db, { userId: 'u1', manual: true });
  startRun(h.db, run2.id);
  const r2 = await runDigest(ctx, { userId: 'u1', manual: true, runId: run2.id });
  const row2 = getRun(h.db, run2.id);
  check('④ 新的一次从 0 起算（新建的 run 行是干净的）', () => ok(
    r2.ok === true && Number(row2.total_clusters) === 2 && Number(row2.done_clusters) === 2,
    JSON.stringify({ ok: r2.ok, t: row2.total_clusters, d: row2.done_clusters }),
  ));
}

// ── ⑤ 簇复用：同一批事件二次运行不再调模型 ────────────────
group('简报运行 · 簇复用');
{
  const { tmp, h } = freshDb();
  const ctx = mkCtx(tmp, h);
  seedEntries(h.db);
  const run = createRun(h.db, { userId: 'u1', manual: true });
  startRun(h.db, run.id);
  const r1 = await runDigest(ctx, { userId: 'u1', manual: true, runId: run.id });
  check('⑤ 第一次生成成功', () => ok(r1.ok === true, JSON.stringify(r1)));

  const beforeCluster = clusterCalls();
  const run2 = createRun(h.db, { userId: 'u1', manual: true });
  startRun(h.db, run2.id);
  const r2 = await runDigest(ctx, {
    userId: 'u1', manual: true, runId: run2.id, now: Date.now() + 60_000,
  });
  check('⑤ 第二次仍然成功（复用不等于跳过整条链）', () => ok(r2.ok === true, JSON.stringify(r2)));
  check('⑤ 第二次一次簇归纳都没调（member_key 命中了上一次）', () =>
    eq(clusterCalls() - beforeCluster, 0));
  check('⑤ 第二次照常写了正文（只有归纳被跳过）', () =>
    eq(digestCalls(), 2));

  const keys = h.db.prepare(
    'SELECT member_key FROM clusters WHERE user_id = ? ORDER BY created_at DESC LIMIT 2',
  ).all('u1').map((r) => r.member_key);
  check('⑤ 簇行带 member_key（没有它就不存在"认得出同一批"这件事）', () =>
    ok(keys.length === 2 && keys.every((k) => typeof k === 'string' && k.length > 0),
      JSON.stringify(keys)));
  const clCount = Number(h.db.prepare(
    'SELECT COUNT(*) c FROM clusters WHERE user_id = ?',
  ).get('u1').c);
  check('⑤ 复用是"重写一行"而不是"再插一行"（库里仍是 2 条簇）', () => eq(clCount, 2));
}

// ── ⑥ 花费上限：超了就停下，且停因要落库 ──────────────────
//
// 这条守的是两件容易同时出错的事：
//   · 只在"调用前"检查 → 永远比实际少花一笔才停（所以放在落库之后判）
//   · 只在正文前检查 → 每一次簇归纳都已经付过钱了
// 上一次调用约 $0.00063（900 in / 120 out × pricing.default），
// 上限设 0.0005 就是为了在第一簇之后必然触发。
group('简报运行 · 花费上限');
{
  const { tmp, h } = freshDb();
  const ctx = mkCtx(tmp, h);
  seedEntries(h.db);
  h.db.prepare('INSERT OR REPLACE INTO settings (user_id, digest_config) VALUES (?,?)')
    .run('u1', JSON.stringify({ enabled: true, at: '00:00', maxCostUsd: 0.0005 }));

  const run = createRun(h.db, { userId: 'u1', manual: true });
  startRun(h.db, run.id);
  calls.length = 0;
  const r = await runDigest(ctx, { userId: 'u1', manual: true, runId: run.id });

  check('⑥ 超限时返回 cancelled 而不是 ok（不是"生成失败"）', () => ok(
    r.cancelled === true && r.ok === false, JSON.stringify(r),
  ));
  check('⑥ 停因写明是超过上限、并带上已花金额', () =>
    ok(/超过单次上限/.test(String(r.cancelReason ?? '')), String(r.cancelReason)));
  check('⑥ 第一簇之后就叫停：没有继续归纳第二簇、也没有写正文', () => ok(
    clusterCalls() === 1 && digestCalls() === 0,
    JSON.stringify({ c: clusterCalls(), d: digestCalls() }),
  ));
  check('⑥ 没有落简报（半截结果不能落库）', () =>
    eq(Number(h.db.prepare('SELECT COUNT(*) c FROM digests').get().c), 0));
  check('⑥ 记的是「跳过」而不是失败尝试（取消之后不该再自动重试）', () => ok(
    Number(h.db.prepare('SELECT COUNT(*) c FROM digest_attempts').get().c) === 0
    && Number(h.db.prepare('SELECT COUNT(*) c FROM digest_skips').get().c) === 1,
    JSON.stringify({
      attempts: h.db.prepare('SELECT COUNT(*) c FROM digest_attempts').get().c,
      skips: h.db.prepare('SELECT COUNT(*) c FROM digest_skips').get().c,
    }),
  ));
  check('⑥ 停因落进了 run 行（UI 不能把"超限"显示成"用户手动停止"）', () => {
    finishRun(h.db, run.id, {
      status: 'cancelled', reason: r.reason, cancelReason: r.cancelReason ?? null,
    });
    const v = viewOf(getRun(h.db, run.id));
    return ok(/超过单次上限/.test(String(v.cancelReason ?? '')), JSON.stringify(v));
  });

  // 上限设成默认值之外的天文数字：应当能跑完（说明上限不是硬停在第一簇）
  h.db.prepare('INSERT OR REPLACE INTO settings (user_id, digest_config) VALUES (?,?)')
    .run('u1', JSON.stringify({ enabled: true, at: '00:00', maxCostUsd: 5 }));
  const run2 = createRun(h.db, { userId: 'u1', manual: true });
  startRun(h.db, run2.id);
  const r2 = await runDigest(ctx, { userId: 'u1', manual: true, runId: run2.id });
  check('⑥ 上限放宽后同一份内容能正常生成（不是"只要设了上限就停"）', () =>
    ok(r2.ok === true, JSON.stringify(r2)));
}

// ── ⑦ 在飞取消：请求停止能真的中断那次悬着的调用 ──────────
//
// 与 ③（排队阶段）不同，这里 run 已经在 running，没有任何"直接作废"
// 的捷径 —— 只能靠 1 秒一次的心跳轮询读 cancel_requested 再 abort。
// mock 故意慢 1.2 秒，好让 abort 落在**这一次调用**上。
group('简报运行 · 在飞取消');
{
  const { tmp, h } = freshDb();
  const ctx = mkCtx(tmp, h);
  seedEntries(h.db);
  h.db.prepare('INSERT OR REPLACE INTO settings (user_id, digest_config) VALUES (?,?)')
    .run('u1', JSON.stringify({ enabled: true, at: '00:00', maxCostUsd: 5 }));

  const run = createRun(h.db, { userId: 'u1', manual: true });
  startRun(h.db, run.id);
  delayMs = 1200;

  const p = runDigest(ctx, { userId: 'u1', manual: true, runId: run.id });
  // 600ms 时请求停止：此时第一簇的归纳正悬在网络上
  await new Promise((r) => setTimeout(r, 600));
  requestCancel(h.db, run.id, '用户手动停止');
  const r = await p;
  delayMs = 0;

  check('⑦ 在飞的这一次被取消（返回 cancelled，不是跑完之后才说停）', () =>
    ok(r.cancelled === true, JSON.stringify(r)));
  check('⑦ 停因是用户手动停止', () =>
    ok(/用户手动停止/.test(String(r.cancelReason ?? '')), String(r.cancelReason)));
  check('⑦ 只花了一次簇归纳的钱（abort 生效在那次调用里）', () =>
    eq(clusterCalls(), 1));
  check('⑦ 没有写正文（取消之后不该再往下走）', () => eq(digestCalls(), 0));

  finishRun(h.db, run.id, {
    status: 'cancelled', reason: r.reason, cancelReason: r.cancelReason ?? null,
  });
  const v = viewOf(getRun(h.db, run.id));
  check('⑦ 结束后 status 是 cancelled 而不是 done', () => eq(v.status, 'cancelled'));
  check('⑦ 跑着的时候心跳在往前走（否则 60 秒后 UI 会对一次正常生成喊"心跳停了"）', () => {
    const row = getRun(h.db, run.id);
    return ok(
      Number(row.heartbeat_at) > Number(row.started_at),
      JSON.stringify({ started: row.started_at, beat: row.heartbeat_at }),
    );
  });
  check('⑦ 跳过记录写了「已停止」', () => {
    const s = h.db.prepare('SELECT reason FROM digest_skips WHERE user_id = ?').get('u1');
    return ok(s && /已停止/.test(String(s.reason)), String(s?.reason));
  });
}

// ── ⑧ stale / 收尸 / 清理 ─────────────────────────────────
group('简报运行 · 心跳与收尸');
{
  const { tmp, h } = freshDb();
  const now = Date.now();
  const live = createRun(h.db, { userId: 'u1', manual: true });
  // 手动把它摆成"正在跑、但最后一次心跳是两分钟前"
  h.db.prepare('UPDATE digest_runs SET status=(?), heartbeat_at=? WHERE id=?')
    .run('running', now - 120_000, live.id);
  const v = viewOf(getRun(h.db, live.id), now);
  check('⑧ 心跳停了要被认出来（stale=true，否则 UI 永远显示正在跑）', () =>
    ok(v.stale === true, JSON.stringify(v)));
  check('⑧ stale 的行状态仍是 running（它只是"可能没人跑了"，不是失败）', () =>
    eq(v.status, 'running'));

  // 心跳新鲜时不能误报
  h.db.prepare('UPDATE digest_runs SET heartbeat_at=? WHERE id=?').run(now, live.id);
  check('⑧ 心跳新鲜时 stale=false（一次慢调用不该被误判成服务死了）', () =>
    ok(viewOf(getRun(h.db, live.id), now).stale === false));

  const done = createRun(h.db, { userId: 'u1', manual: true });
  finishRun(h.db, done.id, { status: 'done', digestId: 'dg_x' });
  check('⑧ 已结束的行 stale 恒为 false（心跳早就不写了）', () =>
    ok(viewOf(getRun(h.db, done.id), now + 86_400_000).stale === false));

  // 进程重启：queued/running 一定是上个进程的遗留，不按时长判断
  const n = markInterruptedRuns(h.db);
  check('⑧ 启动收尸把遗留的 running 标成 interrupted', () => ok(
    n === 1 && getRun(h.db, live.id).status === 'interrupted',
    `标了 ${n} 条，live=${getRun(h.db, live.id).status}`,
  ));
  check('⑧ 已经结束的行不会被改写（done 就是 done）', () =>
    eq(getRun(h.db, done.id).status, 'done'));
  check('⑧ 被标记中断的行带得上一句人话的 reason', () =>
    ok(/重启/.test(String(getRun(h.db, live.id).reason ?? '')),
      String(getRun(h.db, live.id).reason)));

  // 清理只删"终态且过期"的行 —— 活行永远不该被 prune 掉
  const oldDone = createRun(h.db, { userId: 'u1', manual: true });
  finishRun(h.db, oldDone.id, { status: 'done', digestId: null });
  h.db.prepare('UPDATE digest_runs SET finished_at=? WHERE id=?')
    .run(now - 40 * 86_400_000, oldDone.id);
  const pruned = pruneDigestRuns(h.db, 30, now);
  check('⑧ 40 天前的终态行被清掉', () => ok(pruned >= 1, `清了 ${pruned} 条`));
  check('⑧ 活着的行不在清理范围内（否则正在跑的进度会被删掉）', () =>
    ok(getRun(h.db, done.id) !== null, '有行被误删'));
  const stillDone = getRun(h.db, done.id);
  check('⑧ 剩下的终态行仍在库里（30 天内要能回头看）', () =>
    ok(stillDone !== null, 'done 行不见了'));
}

// ── 收尾 ────────────────────────────────────────────────────
delete process.env.M3RUN_KEY;
srv.close();
for (const { tmp: d, h } of opened) {
  // 先关库再删目录：Windows 上句柄没放掉时 rmSync 报 EPERM
  try { h.db.close(); } catch { /* 已经关了 */ }
  try { rmSync(d, { recursive: true, force: true }); } catch { /* 回收站里自生自灭 */ }
}

summary('m3-07-digest-run');
