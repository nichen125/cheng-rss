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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

group('2.10 AI 自检八步');

// ── 一个"丢 system、忽略 response_format"的上游（线上故障的组合）──
// 只转发 role==='user'，且只要请求带了 response_format 就回散文。
// 这两条同时成立时，客户端必须靠自己把指令送到模型手上并降到纯文本档。
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
      // 有要求在 user 里让它输出 JSON —— 模拟"听得懂提示词，但不认 response_format"
      const askedJson = /JSON/.test(userText);
      const wantsFormat = Boolean(body.response_format);

      let content;
      if (wantsFormat) {
        content = '分类：industry（产业）\n\n标签：AMD、并购\n\n理由：事件核心是并购。';
      } else if (/猫/.test(userText) && /喵/.test(userText)) {
        content = instructed ? '喵' : '2';
      } else if (askedJson || instructed) {
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
const up1 = await startUpstream();
const appA = await startApp({ dataDir: join(dirA, 'data'), port: 43600, aiBase: up1.base });
const appB = await startApp({ dataDir: join(dirB, 'data'), port: 43601, aiBase: up1.base });

// 清理必须**在 summary 之前主动调用**，不能只挂在 process.on('exit')：
// mock 上游与两个被 spawn 的服务自己会让事件循环保持存活，于是进程永不退出、
// exit 钩子永不执行 —— 表现为"断言全跑完了但脚本挂在那儿"（实测踩过）。
function teardown() {
  killTree(appA.proc.pid);
  killTree(appB.proc.pid);
  up1.close();
  for (const d of [dirA, dirB]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

check('服务就绪（A：造了条目的库 / B：空库）', () => ok(
  appA.up && appB.up, `A=${appA.up} B=${appB.up} ${appA.err.slice(0, 200)} ${appB.err.slice(0, 200)}`,
));

if (appA.up && appB.up) {
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
    return ok(
      sys.status === 'fail' && Boolean(String(sys.hint ?? '').trim())
      && fmt.status === 'warn'
      && /system/i.test(String(report.verdict ?? '')),
      `system=${sys.status} hint=${JSON.stringify(sys.hint)} format=${fmt.status} verdict=${report.verdict}`,
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
}

// 先清理再总结：理由见 teardown 的定义处
teardown();
summary('m2-11-selftest');
