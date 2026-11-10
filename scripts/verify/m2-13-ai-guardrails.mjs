#!/usr/bin/env node
// 2.13 AI 配置与日志抑制的护栏验收。
//
// 覆盖三组容易在重构中悄悄退化的行为：
//   ① PATCH /settings/ai 拒绝 timeoutMs <= 0（0 会让 AbortSignal.timeout
//      在下一个 tick 立即中止，所有 AI 调用瞬间不可用）
//   ② embed 的「模型不存在」判定只看真凭据（model_not_found / 404），
//      timeout / network / 普通 5xx / 额度用尽不能拿来凑死亡阈值
//   ③ upstream-quota 是全局失败，第一次记录、之后只计数不刷屏
//
// 全部本地 mock，不需要真实 AI key。
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
void root;

const { openDb } = await import('../../src/server/db/client.ts');
const { migrate } = await import('../../src/server/db/migrate.ts');
const { packText } = await import('../../src/server/db/text-blob.ts');
const { createApp } = await import('../../src/server/app.ts');
const { createSession } = await import('../../src/server/auth/session.ts');
const { buildHandlers } = await import('../../src/server/jobs/handlers.ts');
const { resolveAiConfig, DEFAULT_AI_CONFIG } = await import('../../src/server/ai/client.ts');
const { resetAiCache } = await import('../../src/server/ai/service.ts');
const {
  isModelMissingFailure, shouldLog, noticeCount, suppressedSummary,
  resetNotices, isDeadModel, modelFailureCount,
} = await import('../../src/server/ai/notice.ts');

const EMBED_MODEL = 'text-embedding-3-small';

// ── mock 上游：只处理 /embeddings，按 embedMode 决定失败形态 ──
let embedMode = 'model_not_found';
const srv = createServer((req, res) => {
  if (!String(req.url).endsWith('/embeddings')) {
    res.writeHead(404);
    return res.end('no');
  }
  if (embedMode === 'model_not_found') {
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'model_not_found: no such model' } }));
  }
  if (embedMode === 'plain_503') {
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'upstream connect error' } }));
  }
  if (embedMode === 'quota') {
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'no available accounts' } }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    data: [{ embedding: Array.from({ length: 8 }, (_, i) => (i + 1) / 8) }],
    usage: { prompt_tokens: 10, total_tokens: 10 },
  }));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const AI_PORT = srv.address().port;
process.env.M213_KEY = 'sk-x';
resetAiCache();

// ── 库与上下文 ──────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m213-'));
const h = openDb({ dataDir: tmp });
migrate(h.db);
const now = Date.now();
h.db.prepare('INSERT INTO users (id,email,name,role,created_at) VALUES (?,?,?,?,?)')
  .run('u1', 'u1@t.local', 'u1', 'owner', now);
h.db.prepare(`INSERT INTO entries
    (id,user_id,guid,url,url_norm,title,published_at,fetched_at,stage)
    VALUES (?,?,?,?,?,?,?,?,'extracted')`)
  .run('e1', 'u1', 'g1', 'https://example.com/a', 'https://example.com/a', '标题', now, now);
h.db.prepare('INSERT INTO entry_contents (entry_id, html, extracted_by) VALUES (?,?,?)')
  .run('e1', packText('<p>正文：' + '存储芯片量产内容。'.repeat(40) + '</p>'), 'test');

const ctx = {
  cfg: {
    dataDir: tmp, port: 0, host: '127.0.0.1', adminEmail: 'a@t.local',
    ai: {
      baseURL: `http://127.0.0.1:${AI_PORT}/v1`, apiKeyEnv: 'M213_KEY',
      models: { fast: 'f', strong: 's', embed: EMBED_MODEL },
      budget: { dailyUsd: 0, monthlyUsd: 0 },
    },
    logLevel: 'error', sessionDays: 30,
  },
  dbh: h, version: 'test', startedAt: Date.now(),
};
const app = createApp(ctx);
const s = createSession(h.db, 'u1', 30);
const hdr = { cookie: `cheng_rss_sid=${s.token}`, 'content-type': 'application/json' };

// ── ① timeoutMs 校验 ────────────────────────────────────────
group('2.13 AI 护栏 · timeoutMs');
{
  const bad = async (v) => app.request('/api/v1/settings/ai', {
    method: 'PATCH', headers: hdr, body: JSON.stringify({ timeoutMs: v }),
  });
  const r0 = await bad(0);
  const rNeg = await bad(-1);
  const rAbc = await bad('abc');
  check('timeoutMs=0 被拒绝（400）', () => eq(r0.status, 400));
  check('timeoutMs=-1 被拒绝（400）', () => eq(rNeg.status, 400));
  check('timeoutMs="abc" 被拒绝（400）', () => eq(rAbc.status, 400));

  const good = await app.request('/api/v1/settings/ai', {
    method: 'PATCH', headers: hdr, body: JSON.stringify({ timeoutMs: 15000 }),
  });
  const rawRow = h.db.prepare('SELECT ai_config FROM settings WHERE user_id=?').get('u1');
  const saved = rawRow ? JSON.parse(String(rawRow.ai_config)) : {};
  check('合法 timeoutMs 落库', () => ok(
    good.status === 200 && Number(saved.timeoutMs) === 15000,
    JSON.stringify({ status: good.status, saved }),
  ));
  check('手改库里的 timeoutMs=0 会被解析层回落默认值', () =>
    eq(resolveAiConfig({ timeoutMs: 0 }).timeoutMs, DEFAULT_AI_CONFIG.timeoutMs));
  check('负数同样回落默认值', () =>
    eq(resolveAiConfig({ timeoutMs: -5 }).timeoutMs, DEFAULT_AI_CONFIG.timeoutMs));
}

// ── ② 模型不存在判定 ────────────────────────────────────────
group('2.13 AI 护栏 · 模型不存在判定');
{
  const f = (kind, message) => ({ kind, message });
  check('model_not_found 算模型缺失', () =>
    ok(isModelMissingFailure(f('http-503', 'HTTP 503: {"error":{"message":"model_not_found"}}'))));
  check('404 算模型缺失', () =>
    ok(isModelMissingFailure(f('http-404', 'HTTP 404: not found'))));
  check('普通 503 不算模型缺失', () =>
    ok(!isModelMissingFailure(f('http-503', 'upstream connect error'))));
  check('timeout 不算模型缺失', () =>
    ok(!isModelMissingFailure(f('timeout', '请求超过 60000ms 未返回'))));
  check('network 不算模型缺失', () =>
    ok(!isModelMissingFailure(f('network', 'fetch failed'))));
}

// ── ③ embed handler：只有真凭据才累计死亡阈值 ─────────────
group('2.13 AI 护栏 · embed 日志抑制');
{
  const logs = [];
  const handlers = buildHandlers({
    dataDir: tmp,
    log: (msg, extra) => logs.push({ msg, extra }),
    app: ctx,
  });
  const job = { payload: JSON.stringify({ entryId: 'e1' }) };
  const fails = () => logs.filter((l) => l.msg === 'embed 失败').length;

  resetNotices();
  embedMode = 'model_not_found';
  for (let i = 0; i < 4; i++) await handlers.embed(job, h.db);

  check('连续 4 次 model_not_found 后模型被判死', () => ok(
    modelFailureCount(EMBED_MODEL) === 4 && isDeadModel(EMBED_MODEL),
    JSON.stringify({ count: modelFailureCount(EMBED_MODEL), dead: isDeadModel(EMBED_MODEL) }),
  ));
  check('判定死亡后不再逐条刷日志（前两条照记）', () =>
    eq(fails(), 2));

  // 模型已经“死亡”，但真实故障不能因此静默。
  const before = fails();
  embedMode = 'plain_503';
  await handlers.embed(job, h.db);
  check('模型被判死后，普通 503 仍然逐条记录（真实故障不被静默）', () =>
    ok(fails() === before + 1, JSON.stringify({ before, after: fails() })));
}

// ── ④ upstream-quota 全局抑制 ──────────────────────────────
group('2.13 AI 护栏 · upstream-quota 抑制');
{
  resetNotices();
  check('upstream-quota 第一次该记录', () => ok(shouldLog('upstream-quota')));
  check('第二次起抑制', () => ok(!shouldLog('upstream-quota')));
  check('但次数继续累计', () => eq(noticeCount('upstream-quota'), 2));
  check('收尾摘要能说出"另有 N 次"', () =>
    ok(/upstream-quota 另有 1 次/.test(suppressedSummary()), suppressedSummary()));

  // handler 层：连续两次额度失败只应产生一行 embed 失败日志
  resetNotices();
  const logs = [];
  const handlers = buildHandlers({
    dataDir: tmp,
    log: (msg) => logs.push(msg),
    app: ctx,
  });
  const job = { payload: JSON.stringify({ entryId: 'e1' }) };
  embedMode = 'quota';
  await handlers.embed(job, h.db);
  await handlers.embed(job, h.db);
  check('额度失败只记录一次（不按每条条目刷屏）', () =>
    eq(logs.filter((m) => m === 'embed 失败').length, 1));
}

h.close();
await new Promise((r) => srv.close(r));
rmSync(tmp, { recursive: true, force: true });
summary('2.13 AI 护栏');
