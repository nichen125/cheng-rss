#!/usr/bin/env node
// AI 自检八步 —— 验收（PLAN §8.10 / §15.30，v2.7 / 步骤 2.10）
//
// 判据（§19.4 的 2.10）：
//   ① POST /settings/ai/selftest 返回 8 步，id 依次是 spec 的那八个
//   ② 每步都有 status 与非空 detail
//   ③ "丢 system" 的 mock 下 system 步 fail 且带 hint、format 步 warn、verdict 提得到根因
//   ④ GET .../latest 取回同一份（id 相同）
//   ⑤ 没 key 时 key 步 fail、其余 skip，且**上一次的 dropped 画像不被抹掉**
//   ⑥ 库里没有可用条目时 analyze/summary 两步 skip 并说明原因
//   ⑦ 自检产生 purpose 含 selftest 的 ai_usage 行
//
// ## 这个脚本守的是什么
//
// ①③ 守的是"自检真的在测东西"，不是把八个标题打印一遍。判据 ③ 特意用
// **丢 system 的 mock**：那是线上 649 次失败的真根因，自检若对这种网关
// 报全绿，它就没有存在价值。
//
// ⑤ 守的是"失败的运行不许破坏上一次的结论"。自检会因为没 key 只跑完第一步，
// 若那次把画像写成 unknown，用户会看到"昨天还好好的，今天怎么又不行了"，
// 而实际上什么都没变。
//
// ## 为什么不用 SEA 二进制起服务
//
// 项目里端点级脚本多数 spawn 打包好的二进制，但二进制要先跑四分钟构建，
// 而这一步验的是"端点 + 落库 + 自检编排"，与打包无关（打包由 m0-08 守）。
// 直接 spawn `node src/index.ts serve` 走同一份源码，省掉构建等待。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { group, check, eq, ok, gt, summary } from './harness.mjs';
import { killTree } from '../lib/proc.mjs';
import { openSqlite } from '../lib/sqlite.mjs';
import { launchBrowser, connectCdp, findBrowser } from '../lib/cdp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

group('2.10 AI 自检八步');

// ── 一个"丢 system、忽略 response_format"的上游（线上故障的组合）──
// 只转发 role==='user'；**完全不理 response_format**，只按提示词说话。
//
// 这个 mock 的"只按提示词说话"是关键：它会照做「只输出一个 JSON 对象」，
// 也会照做「用一句自然语言描述天气」。于是"要不要相信模型吐了 JSON 就等于
// 支持 json_schema"这件事有了解法 —— 探针必须反过来要求散文（见
// FORMAT_ANTI_PROMPT）：要求散文却仍回 JSON 才说明解码被约束了。
// 用旧探针（要求 JSON）时，这个 mock 会回 JSON，档位被误记成 json_schema，
// 所以下面 ③ 的断言同时守着这两件事。
async function startUpstream() {
  const calls = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += String(d); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      calls.push(body);

      if (req.url?.includes('/embeddings')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'no available accounts' } }));
        return;
      }

      const userText = (body.messages ?? [])
        .filter((m) => m.role === 'user')
        .map((m) => m.content).join('\n');
      // 指令有没有到手：合并投递后，user 里会带指令原文
      const instructed = /情报卡片|你是一只猫|只回复|输出要求/.test(userText);
      // 提示词在要散文（自检的反提示词）—— 这个上游照做，因为它是"只读提示词"的模型
      const asksProse = /不要输出 ?JSON|不要出现花括号|描述今天的天气/.test(userText);
      const asksJson = !asksProse && /JSON/.test(userText);

      let content;
      if (/猫/.test(userText) && /喵/.test(userText)) {
        content = instructed ? '喵' : '2';
      } else if (asksProse) {
        content = '今天多云转晴，气温适中，微风拂面，适合外出。';
      } else if (asksJson || instructed) {
        content = JSON.stringify({
          summary: 'AMD 以 32 亿美元收购 World Labs，补齐推理训练栈。',
          key_points: ['32 亿美元', '2027 年一季度完成'],
          category: 'industry',
          topics: ['AMD', '并购'],
          entities: { people: [], orgs: ['AMD'], products: [], tech: ['训练框架'] },
          importance: 78, novelty: 66, sentiment: 'neutral',
          a: 'ok', b: 1,
        });
      } else {
        content = '2';
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', model: body.model ?? 'm',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}/v1`, calls, close: () => srv.close() };
}

// ── 起一个服务（源码直起）+ 登录，返回请求辅助 ──
async function startApp({ dataDir, port, aiBase }) {
  const proc = spawn(NODE, ['--experimental-strip-types', join(root, 'src/index.ts'), 'serve',
    '--data', dataDir, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AI_BASE_URL: aiBase, AI_API_KEY: '', LOG_LEVEL: 'error' },
  });
  let err = '';
  proc.stderr.on('data', (d) => { err += String(d); });
  proc.stdout.on('data', () => {});

  const apiBase = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${apiBase}/api/health`)).ok) { up = true; break; } } catch { /* 起 */ }
    await sleep(250);
  }
  if (!up) return { proc, up: false, err, apiBase, req: null };

  await fetch(`${apiBase}/api/v1/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ai@test.local', password: 'aipass12345678' }),
  });
  const lr = await fetch(`${apiBase}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ai@test.local', password: 'aipass12345678' }),
  });
  const cookie = (lr.headers.get('set-cookie') ?? '').split(';')[0];

  const req = async (path, init = {}) => {
    const r = await fetch(`${apiBase}/api/v1${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { status: r.status, json, text };
  };
  return { proc, up: true, err, apiBase, req };
}

/** 造一篇有正文的条目（正文是 gzip BLOB，必须用项目自己的 packText） */
async function seedEntry(dataDir, userId) {
  const { packText } = await import('../../src/server/db/text-blob.ts');
  const db = openSqlite(join(dataDir, 'app.db'));
  const now = Date.now();
  const body = '<p>AMD 今日宣布以 32 亿美元现金加股票收购 World Labs，'
    + '交易预计在 2027 年第一季度完成。World Labs 成立于 2022 年，'
    + '此前累计融资 11 亿美元，主要产品是面向长上下文推理的训练框架。</p>';
  db.prepare(`
    INSERT INTO entries (id, user_id, guid, url, url_norm, title, published_at, fetched_at, stage)
    VALUES (?,?,?,?,?,?,?,?,'extracted')
  `).run('e_selftest_1', userId, 'g1', 'https://example.com/a', 'https://example.com/a',
    'AMD 收购 World Labs', now, now);
  db.prepare('INSERT INTO entry_contents (entry_id, html) VALUES (?, ?)')
    .run('e_selftest_1', packText(body));
  db.close();
}

const dirA = mkdtempSync(join(tmpdir(), 'cheng-rss-m211a-'));
const dirB = mkdtempSync(join(tmpdir(), 'cheng-rss-m211b-'));
const dirC = mkdtempSync(join(tmpdir(), 'cheng-rss-m211c-'));
const up1 = await startUpstream();
const appA = await startApp({ dataDir: join(dirA, 'data'), port: 43600, aiBase: up1.base });
const appB = await startApp({ dataDir: join(dirB, 'data'), port: 43601, aiBase: up1.base });
// 第三个实例专门测预算闸门：需要"这一次自检之内就已经超月额度"的库，
// 和前两个实例的状态互不干扰
const appC = await startApp({ dataDir: join(dirC, 'data'), port: 43602, aiBase: up1.base });

// 清理必须**在 summary 之前主动调用**，不能只挂在 process.on('exit')：
// mock 上游与两个被 spawn 的服务自己会让事件循环保持存活，于是进程永不退出、
// exit 钩子永不执行 —— 表现为"断言全跑完了但脚本挂在那儿"（实测踩过）。
function teardown() {
  killTree(appA.proc.pid);
  killTree(appB.proc.pid);
  killTree(appC.proc.pid);
  up1.close();
  for (const d of [dirA, dirB, dirC]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

check('服务就绪（A：造了条目的库 / B：空库 / C：超预算）', () => ok(
  appA.up && appB.up && appC.up,
  `A=${appA.up} B=${appB.up} C=${appC.up} ${appA.err.slice(0, 200)} ${appC.err.slice(0, 200)}`,
));

if (appA.up && appB.up && appC.up) {
  // 先写入 key（自检要用），再造条目
  await appA.req('/settings/ai/key', { method: 'PATCH', body: JSON.stringify({ apiKey: 'sk-selftest-123456' }) });

  const me = await appA.req('/stats');
  void me;
  // 取 userId：从库里的 users 表拿（只有一个用户）
  const dbA = openSqlite(join(dirA, 'data', 'app.db'));
  const uid = dbA.prepare('SELECT id FROM users LIMIT 1').get().id;
  dbA.close();
  await seedEntry(join(dirA, 'data'), uid);

  const first = await appA.req('/settings/ai/selftest', { method: 'POST' });
  const report = first.json ?? {};

  check('① 返回 8 步，id 依次为 key/models/chat/system/format/embed/analyze/summary', () => {
    const want = ['key', 'models', 'chat', 'system', 'format', 'embed', 'analyze', 'summary'];
    const got = (report.steps ?? []).map((s) => s.id);
    return ok(JSON.stringify(got) === JSON.stringify(want),
      `status=${first.status} got=${JSON.stringify(got)} err=${first.text.slice(0, 200)}`);
  });

  check('② 每步都有 status 与非空 detail', () => {
    const bad = (report.steps ?? []).filter((s) => !s.status || !String(s.detail ?? '').trim());
    return ok((report.steps ?? []).length === 8 && bad.length === 0,
      bad.map((s) => `${s.id}:${s.status}:${s.detail}`).join(' | '));
  });

  check('③ 丢 system 的 mock 下 system 步 fail 且带 hint、format 步 warn、verdict 提根因', () => {
    const byId = Object.fromEntries((report.steps ?? []).map((s) => [s.id, s]));
    const sys = byId.system ?? {};
    const fmt = byId.format ?? {};
    // 这个上游**完全不看 response_format**，只按提示词说话。所以档位必须是
    // text —— 记成 json_schema 就是"模型吐了 JSON 就算支持严格模式"那个假阳性
    // 回来了（探针会退化成"提示词自己要 JSON"，必然通过）。
    const cap = report.capabilities?.models?.['deepseek-flash']?.responseFormat
      ?? Object.values(report.capabilities?.models ?? {})[0]?.responseFormat;
    return ok(
      sys.status === 'fail' && Boolean(String(sys.hint ?? '').trim())
      && fmt.status === 'warn'
      && cap === 'text'
      && /system/i.test(String(report.verdict ?? '')),
      `system=${sys.status} hint=${JSON.stringify(sys.hint)} format=${fmt.status} cap=${cap} verdict=${report.verdict}`,
    );
  });

  const latest = await appA.req('/settings/ai/selftest/latest');
  check('④ GET /settings/ai/selftest/latest 取回同一份', () => ok(
    latest.json?.id === report.id && (latest.json?.steps ?? []).length === 8,
    `id=${latest.json?.id} vs ${report.id} steps=${(latest.json?.steps ?? []).length}`,
  ));

  check('⑨ 自检产生 purpose 含 selftest 的 ai_usage 行', () => {
    const db = openSqlite(join(dirA, 'data', 'app.db'));
    const row = db.prepare(
      "SELECT COUNT(*) AS c FROM ai_usage WHERE purpose LIKE 'selftest%'",
    ).get();
    db.close();
    return ok(Number(row.c) > 0, `rows=${row.c}`);
  });

  // ── ⑤ 自检把能力画像落库（走生产读取路径）──
  const { readCapabilities } = await import('../../src/server/ai/capabilities.ts');
  const capsNow = (() => {
    const db = openSqlite(join(dirA, 'data', 'app.db'));
    const c = readCapabilities(db, uid);
    db.close();
    return c;
  })();

  check('⑤ 自检把能力画像落库（capabilities 含 dropped）', () => {
    const anyDropped = Object.values(capsNow?.models ?? {}).some((m) => m.systemRole === 'dropped');
    return ok(Boolean(capsNow?.baseURL) && anyDropped, JSON.stringify(capsNow)?.slice(0, 300));
  });

  // ── ⑥ 没 key 时不抹掉上次的画像 ──
  await appA.req('/settings/ai/key', { method: 'PATCH', body: JSON.stringify({ apiKey: '' }) });
  const second = await appA.req('/settings/ai/selftest', { method: 'POST' });
  const rep2 = second.json ?? {};

  check('⑥ 没 key 时 key 步 fail、其余 skip', () => {
    const byId = Object.fromEntries((rep2.steps ?? []).map((s) => [s.id, s]));
    const others = (rep2.steps ?? []).filter((s) => s.id !== 'key');
    return ok(
      byId.key?.status === 'fail' && others.every((s) => s.status === 'skip'),
      (rep2.steps ?? []).map((s) => `${s.id}:${s.status}`).join(' '),
    );
  });

  // 注意：**必须走生产的读取路径**（readCapabilities），不能用自己写的 SQL。
  // 判据的价值全在"客户端启动时读到的画像没变"这件事上 —— 自己写一份
  // `ORDER BY started_at DESC LIMIT 1` 只会读到那次没 key 的 NULL 行，
  // 于是断言红的原因变成"我的查询写错了"，而不是实现有问题（第一次就踩了）。
  const capsAfter = (() => {
    const db = openSqlite(join(dirA, 'data', 'app.db'));
    const c = readCapabilities(db, uid);
    db.close();
    return c;
  })();

  check('⑦ 上一次的 dropped 画像没有被抹成 unknown', () => {
    const dropped = (c) => Object.values(c?.models ?? {})
      .filter((m) => m.systemRole === 'dropped').map((m) => m.responseFormat).sort().join(',');
    return ok(dropped(capsNow) === dropped(capsAfter) && dropped(capsAfter) !== '',
      `before=${dropped(capsNow)} after=${dropped(capsAfter)}`);
  });

  // ── ⑥ 空库：analyze / summary 两步 skip ──
  await appB.req('/settings/ai/key', { method: 'PATCH', body: JSON.stringify({ apiKey: 'sk-selftest-123456' }) });
  const empty = await appB.req('/settings/ai/selftest', { method: 'POST' });
  check('⑧ 库里没有可用条目时 analyze/summary 两步 skip 并说明原因', () => {
    const byId = Object.fromEntries((empty.json?.steps ?? []).map((s) => [s.id, s]));
    const a = byId.analyze ?? {};
    const s = byId.summary ?? {};
    return ok(
      a.status === 'skip' && s.status === 'skip'
      && /没有可用于测试的条目/.test(String(a.detail ?? '')),
      `analyze=${a.status}:${a.detail} summary=${s.status}:${s.detail}`,
    );
  });

  // ── ⑥b 预算已停：一步都不许发（判据 §5.5）──
  //
  // 第 2~6 步是裸 fetch（自检要测量、不能借道客户端的降级），于是它们
  // 天然绕过 AiClient 的预算闸门。用户点一次自检就能在"已经停止"的账户上
  // 再花五个请求的钱 —— 这条断言守的就是那个洞。
  //
  // 判据是"上游一个请求都没收到"，不是"结果是 skip"：后者可以被实现成
  // "先发完再标 skip"，那跟没做闸门是一样的。
  {
    const db = openSqlite(join(dirC, 'data', 'app.db'));
    const uidC = db.prepare('SELECT id FROM users LIMIT 1').get().id;
    db.prepare(`
      INSERT INTO ai_usage (user_id, purpose, model, in_tokens, out_tokens, cost_usd,
                            latency_ms, ok, error, created_at)
      VALUES (?, 'analyze', 'deepseek-flash', 100, 50, 0.01, 800, 1, NULL, ?)
    `).run(uidC, Date.now());
    db.close();

    await appC.req('/settings/ai/key', { method: 'PATCH', body: JSON.stringify({ apiKey: 'sk-selftest-123456' }) });
    // 月上限压到 0.001，而上一步刚花了 0.01 → level 必然是 stop
    await appC.req('/settings/ai', {
      method: 'PATCH',
      body: JSON.stringify({ budget: { dailyUsd: 100, monthlyUsd: 0.001 } }),
    });

    const before = up1.calls.length;
    const gated = await appC.req('/settings/ai/selftest', { method: 'POST' });
    const sent = up1.calls.length - before;
    const gs = gated.json?.steps ?? [];
    const rest = gs.filter((s) => s.id !== 'key');

    check('⑨ 预算已停时自检一步都不发：key 之外的七步全 skip 且上游零请求', () => ok(
      gs.length === 8
      && rest.length === 7
      && rest.every((s) => s.status === 'skip' && /预算已停/.test(String(s.detail ?? '')))
      && sent === 0,
      `sent=${sent} steps=${gs.map((s) => `${s.id}:${s.status}`).join(' ')}`,
    ));
  }

  // ── ⑨ 积压重跑：只复位 AI 侧失败 + 清 dead 任务（判据 10/11）──
  //
  // 造四条：三条 AI 侧失败（其中一条带 dead 的 analyze 任务）+ 一条抓取失败。
  // 复位后应当只动前三条，且带 dead 任务那条**真的能被入队** ——
  // 不清 dead 的话 ORPHAN_ANALYZE_WHERE 会把它排除，按钮说 N 条而实际入队 0 条。
  {
    const db = openSqlite(join(dirA, 'data', 'app.db'));
    const now = Date.now();
    const mk = (id, err, guid) => {
      db.prepare(`
        INSERT INTO entries (id, user_id, guid, url, url_norm, title, published_at, fetched_at, stage, stage_error)
        VALUES (?,?,?,?,?,?,?,?, 'failed', ?)
      `).run(id, uid, guid, `https://e.com/${guid}`, `https://e.com/${guid}`, `T ${guid}`, now, now, err);
    };
    mk('e_rf_schema', 'schema: 字段不合规 —— entities: Required', 'r1');
    mk('e_rf_empty', 'empty: 模型返回空内容', 'r2');
    mk('e_rf_dead', 'http-503: all accounts are temporarily unavailable', 'r3');
    mk('e_rf_fetch', 'fetch-failed: 原文网络错误: fetch failed', 'r4');
    // v2.7 补上的两类前缀。它们是评审指出来的漏项：timeout / network 同样是
    // "这个网关当时不行"，upstream-quota 是"额度用尽了" —— 三者都该重跑。
    // 不写这两条夹具，前缀表少写了也测不出来。
    mk('e_rf_quota', 'upstream-quota: HTTP 503: no available accounts', 'r5');
    mk('e_rf_timeout', 'timeout: 请求超过 60000ms 未返回', 'r6');

    // 给第三条造一条 dead 的 analyze 任务（模拟"重试到上限"）。
    // jobs 没有 user_id 列 —— 归属由 payload.entryId 表达
    db.prepare(`
      INSERT INTO jobs (kind, payload, status, dedupe_key, attempts, max_attempts, created_at, updated_at)
      VALUES ('analyze', ?, 'dead', ?, 3, 3, ?, ?)
    `).run(JSON.stringify({ entryId: 'e_rf_dead' }), 'analyze:e_rf_dead', now, now);
    db.close();

    const r = await appA.req('/settings/ai/retry-failed', { method: 'POST' });
    const res = r.json ?? {};

    const after = (() => {
      const d = openSqlite(join(dirA, 'data', 'app.db'));
      const rows = d.prepare(
        "SELECT id, stage, stage_error FROM entries WHERE id LIKE 'e_rf_%'",
      ).all();
      const jobs = d.prepare("SELECT status FROM jobs WHERE dedupe_key = 'analyze:e_rf_dead'").all();
      d.close();
      return {
        byId: Object.fromEntries(rows.map((x) => [x.id, x])),
        deadJobLeft: jobs.length,
      };
    })();

    check('⑨ 复位只动 AI 侧失败：AI 侧全部变 extracted，fetch-failed 不动', () => ok(
      after.byId.e_rf_schema?.stage === 'extracted' && after.byId.e_rf_schema?.stage_error === null
      && after.byId.e_rf_empty?.stage === 'extracted'
      && after.byId.e_rf_dead?.stage === 'extracted'
      && after.byId.e_rf_quota?.stage === 'extracted'
      && after.byId.e_rf_timeout?.stage === 'extracted'
      && after.byId.e_rf_fetch?.stage === 'failed',
      JSON.stringify(after.byId),
    ));

    // 判据是"清掉了那条 dead + 它真的被重新入队"，**不是**"跑完之后库里没有 dead"。
    // 后者不成立也不该成立：服务端的 job runner 会立刻把复位后的条目跑起来，
    // 而这个夹具条目没有正文，于是它又失败、又重试到 dead —— 那是正确行为。
    // 第一版断言写成 `deadJobLeft === 0` 就红在这里，而实现是对的（实测 cleared=1）。
    check('⑨ 清掉了 dead 的 analyze 任务，于是那一条真的能入队', () => ok(
      Number(res.clearedDeadJobs) === 1 && Number(res.reset) >= 3 && Number(res.queued) > 0,
      `reset=${res.reset} cleared=${res.clearedDeadJobs} queued=${res.queued} `
      + `remaining=${res.remaining} body=${r.text.slice(0, 200)}`,
    ));
  }

  // ── ⑩ 面板真的渲染了（浏览器断言，无 Chromium 则 SKIP）──
  //
  // 前面九条验的是"后端说得出八步"，这一条验的是"用户看得见"。两者缺一不可：
  // 断言 /settings/ai/selftest 返回八步，挡不住"面板根本没挂上去"。
  const browser = findBrowser();
  if (!browser) {
    console.log('  \u001b[33mSKIP\u001b[0m  本机没有 Chromium 系浏览器，跳过面板断言');
  } else {
    // 用 A 实例（它有完整画像与条目）起浏览器，注入 cookie 后看面板
    const cookie = await (async () => {
      const lr = await fetch(`${appA.apiBase}/api/v1/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ai@test.local', password: 'aipass12345678' }),
      });
      return (lr.headers.get('set-cookie') ?? '').split(';')[0];
    })();

    const br = await launchBrowser({
      profile: join(dirA, 'profile'), width: 1440, height: 900, url: appA.apiBase,
    });
    try {
      if (!br.wsUrl) {
        check('⑩ 浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
      } else {
        const cdp = await connectCdp(br.wsUrl);
        await cdp.send('Network.enable');
        await cdp.send('Network.setCookie', {
          name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: appA.apiBase,
        });
        await cdp.send('Page.navigate', { url: appA.apiBase });
        await sleep(2500);

        const opened = await cdp.evaluate(`(async () => {
          const btn = document.querySelector('.side-settings, button[title*="配置"], button[aria-label*="配置"]');
          if (!btn) return 'no-btn';
          btn.click();
          await new Promise(r => setTimeout(r, 700));
          const nav = [...document.querySelectorAll('.settings-nav-item')]
            .find(x => x.textContent.includes('AI 分析'));
          if (!nav) return 'no-nav';
          nav.click();
          await new Promise(r => setTimeout(r, 1200));
          return 'ok';
        })()`);
        check('⑩ 能打开配置并切到「AI 分析」', () => ok(opened === 'ok', String(opened)));

        if (opened === 'ok') {
          // 刷新后仍在：这一步**先重新导航再读**，否则测的是内存状态而不是 latest。
          //
          // 用 `Page.navigate` 而不是在 evaluate 里 `location.reload()`：
          // 后者会在求值过程中销毁执行上下文，CDP 随即报
          // "Inspected target navigated or closed"，断言连跑都跑不到（实测踩过）。
          await cdp.send('Page.navigate', { url: appA.apiBase });
          await sleep(2500);
          const persisted = await cdp.evaluate(`(async () => {
            const btn = document.querySelector('.side-settings, button[title*="配置"], button[aria-label*="配置"]');
            if (!btn) return { ok: false, why: 'no-btn' };
            btn.click();
            await new Promise(r => setTimeout(r, 700));
            const nav = [...document.querySelectorAll('.settings-nav-item')]
              .find(x => x.textContent.includes('AI 分析'));
            if (!nav) return { ok: false, why: 'no-nav' };
            nav.click();
            await new Promise(r => setTimeout(r, 1200));
            const card = document.getElementById('ai-selftest-card');
            const rows = [...(card?.querySelectorAll('tr[data-step]') ?? [])];
            return {
              ok: Boolean(card),
              visible: card ? card.checkVisibility() : false,
              rows: rows.length,
              statuses: rows.map(r => r.getAttribute('data-status')),
              verdict: card?.querySelector('[data-testid="selftest-verdict"]')?.textContent ?? '',
            };
          })()`);

          check('⑩ 自检卡片默认可见（不在折叠里）', () => ok(
            persisted.ok === true && persisted.visible === true,
            JSON.stringify(persisted),
          ));

          check('⑩ 刷新后仍有 8 行（读的是 latest 而不是内存）', () => ok(
            persisted.rows === 8, `rows=${persisted.rows} statuses=${JSON.stringify(persisted.statuses)}`,
          ));

          check('⑩ 状态点随 status 变（至少一行 fail）', () => ok(
            (persisted.statuses ?? []).includes('fail')
            && new Set(persisted.statuses ?? []).size >= 2,
            JSON.stringify(persisted.statuses),
          ));

          // 结论条的颜色必须与步骤状态**一致**：只要有降级就涂绿，
          // 用户会以为"没问题" —— 而他来跑自检就是为了看见降级。
          // 这里不硬编码某一个颜色，而是按 DOM 里的 data-status 推期望值，
          // 否则换一组夹具就会假红。
          const levelUi = await cdp.evaluate(`(() => {
            const card = document.getElementById('ai-selftest-card');
            const lv = card?.querySelector('.ai-level');
            const sts = [...(card?.querySelectorAll('tr[data-step]') ?? [])]
              .map(r => r.getAttribute('data-status'));
            return { cls: lv ? lv.className : '', statuses: sts };
          })()`);
          check('⑩ 结论条配色与步骤状态一致（有 fail 红 / 只有降级黄 / 全绿才绿）', () => {
            const sts = levelUi?.statuses ?? [];
            const want = sts.includes('fail') ? 'ai-level-stop'
              : sts.some((s) => s === 'warn' || s === 'skip') ? 'ai-level-warn'
                : 'ai-level-ok';
            return ok(String(levelUi?.cls ?? '').includes(want), `cls=${levelUi?.cls} 期望含 ${want}`);
          });

          const copy = await cdp.evaluate(`(async () => {
            window.__copied = null;
            try {
              Object.defineProperty(navigator, 'clipboard', {
                value: { writeText: async (t) => { window.__copied = t; } }, configurable: true,
              });
            } catch { /* ignore */ }
            const btns = [...document.querySelectorAll('#ai-selftest-card button')];
            const b = btns.find(x => x.textContent.includes('复制报告'));
            if (!b) return { ok: false, why: 'no-btn' };
            b.click();
            await new Promise(r => setTimeout(r, 500));
            return { ok: true, text: window.__copied ?? '' };
          })()`);

          check('⑩ 复制报告产出非空 Markdown（含 ##）', () => ok(
            copy.ok === true && typeof copy.text === 'string' && copy.text.includes('##') && copy.text.length > 40,
            JSON.stringify(copy).slice(0, 200),
          ));

          // 测速表：没有上游 SSE 的话至少验"按钮在、点了不崩"
          const benchUi = await cdp.evaluate(`(() => {
            const btns = [...document.querySelectorAll('#ai-selftest-card button')];
            return btns.map(b => b.textContent.trim());
          })()`);
          check('⑩ 三颗按钮都在（开始自检 / 测试模型速度 / 复制报告）', () => ok(
            (benchUi ?? []).some((t) => t.includes('开始自检'))
            && (benchUi ?? []).some((t) => t.includes('测试模型速度'))
            && (benchUi ?? []).some((t) => t.includes('复制报告')),
            JSON.stringify(benchUi),
          ));

          // 测速表：只验"按钮在"是假的 —— 需求原话的一半是"测速结果便于查看"，
          // 而路由回的是 { results }、UI 若读成 { rows } 会静默渲染出空表，
          // 看起来就像"没有数据"。所以真点一次，验表格有行。
          // 这个 mock 不认 stream（回普通 JSON），正好顺带验
          // "网关不支持流式时首字列显示 —、而不是拿总耗时冒充"。
          const benchFlow = await cdp.evaluate(`(async () => {
            const card = document.getElementById('ai-selftest-card');
            const b = [...card.querySelectorAll('button')]
              .find(x => x.textContent.includes('测试模型速度'));
            if (!b) return { ok: false, why: 'no-btn' };
            b.click();
            for (let i = 0; i < 150; i++) {
              const t = card.querySelector('[data-testid="bench-table"]');
              if (t) {
                const rows = [...t.querySelectorAll('tbody tr')];
                return {
                  ok: true,
                  rows: rows.length,
                  cells: rows[0] ? [...rows[0].querySelectorAll('td')].map(td => td.textContent.trim()) : [],
                  text: t.textContent,
                };
              }
              await new Promise(r => setTimeout(r, 200));
            }
            return { ok: false, why: 'timeout' };
          })()`);

          check('⑪ 点「测试模型速度」后表格真的出现行（不是空表）', () => ok(
            benchFlow.ok === true && benchFlow.rows >= 1,
            JSON.stringify(benchFlow).slice(0, 300),
          ));

          check('⑪ 上游不认 stream 时首字列写 —（不拿总耗时冒充 TTFT）', () => ok(
            benchFlow.ok === true && String(benchFlow.text ?? '').includes('—'),
            JSON.stringify(benchFlow.cells ?? []),
          ));

          // 成功率列：1/3 成功与 3/3 成功都会出中位数，不显示就是骗人。
          // 同时验"总耗时没被测到时写 —"——全失败时 median.totalMs 是 0，
          // 渲染成「0 ms」会看起来像"快得不可思议"。
          check('⑪ 测速表带成功率列，且没测到的总耗时写 —（不写 0 ms）', () => {
            const cells = benchFlow.cells ?? [];
            const rate = cells.find((c) => /\d+\/\d+ 次成功/.test(String(c)));
            const dashCells = cells.filter((c) => String(c).trim() === '—').length;
            return ok(
              Boolean(rate) && dashCells >= 1,
              `cells=${JSON.stringify(cells)}`,
            );
          });
        }
      }
    } finally {
      try { br.close(); } catch { /* ignore */ }
    }
  }
}

// 先清理再总结：理由见 teardown 的定义处
teardown();
summary('m2-11-selftest');
