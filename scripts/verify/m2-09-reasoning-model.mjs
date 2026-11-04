#!/usr/bin/env node
// 推理模型的两个陷阱 —— 验收（PLAN §8.6b，v2.4）
//
// 判据：
//   ① 测试连接对**推理模型**不再误报「模型返回空」
//   ② 测试连接真的用足够的 max_tokens（≥32）
//   ③ 推理被截断时判 `reasoning-only` 而不是 `empty`（两者处置相反）
//   ④ `reasoning-only` 是 retryable:true，`empty` 是 retryable:false
//   ⑤ 重试时 max_tokens **翻倍**（原样重发只会再截断一次）
//   ⑥ 非推理模型的正常返回仍然成功（别把正常路径改坏）
//   ⑦ `reasoning` 别名也认（OpenRouter / 部分网关用这个字段名）
//   ⑧ 思考内容**不得**被当成正文返回（它是过程不是结论）
//   ⑨ chatJson 路径与 chat 路径判定一致
//
// ## 这个脚本守的是什么
//
// 修复前「测试连接」对推理模型**永远**失败：max_tokens=1，而那 1 个 token
// 花在 reasoning_content 上，content 是空串。而空内容被判 `empty` 且
// retryable:false，所以它必然失败、必然只失败一次、且看不出原因。
//
// 更要紧的是同一机制会让**所有分析调用**间歇失败：max_tokens 被思考吃掉后
// JSON 被截断，表现为随机的 schema / bad-json 失败。所以这里的断言不只测
// "测试连接那一行"，还测客户端的分类与重试策略。
import { createServer } from 'node:http';
import { group, check, eq, ok, gt, summary } from './harness.mjs';

const { AiClient } = await import('../../src/server/ai/client.ts');
const { EntryAnalysisSchema } = await import('../../src/server/ai/schema.ts');

group('推理模型（§8.6b）');

const CFG = (baseURL) => ({
  baseURL,
  apiKeyEnv: 'X',
  models: { fast: 'm', strong: 'm', embed: 'e' },
  limits: { rpm: 0, concurrency: 1 },
  budget: { dailyUsd: 0, monthlyUsd: 0 },
  fallback: { onBudgetExceeded: 'fast_only' },
  pricing: { default: { in: 0, out: 0 } },
  timeoutMs: 10_000,
});

/**
 * 起一个 mock，按请求里的 max_tokens 决定返回什么。
 *
 * `behave(mode, body)` 返回 { content, reasoning, finish }。
 * 这比"固定返回一个 payload"更接近真实：真实模型的行为**取决于预算**。
 */
async function withMock(behave, fn) {
  const calls = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += String(d); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      calls.push({ max_tokens: body.max_tokens, model: body.model, body });
      const r = behave(body, calls.length);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', model: body.model ?? 'm',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: r.content ?? '',
            ...(r.reasoning !== undefined ? { reasoning_content: r.reasoning } : {}),
            ...(r.reasoningAlias !== undefined ? { reasoning: r.reasoningAlias } : {}),
          },
          finish_reason: r.finish ?? 'stop',
        }],
        usage: {
          prompt_tokens: 40,
          completion_tokens: r.outTokens ?? 1,
          completion_tokens_details: { reasoning_tokens: r.reasoningTokens ?? 0 },
        },
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}/v1`, calls);
  } finally {
    srv.close();
  }
}

const mkClient = (baseURL) => new AiClient({
  config: CFG(baseURL), apiKey: 'sk-t', sleepImpl: async () => {},
});

// ── ③④ 分类：截断 vs 无话可说 ──────────────────────────────
{
  // mock 永远返回"只思考不答"，所以客户端会走满 3 次重试（预算翻倍两次）。
  // 失败信息里报的应该是**最后一次实际用的**预算（64 → 128 → 256 的 256），
  // 而不是最初的 64 —— 因为用户要判断的是"这次失败时用的是什么"。
  const sent = [];
  const r = await withMock(
    (body) => {
      sent.push(body.max_tokens);
      return { content: '', reasoning: 'The user says ping', finish: 'length', reasoningTokens: 1 };
    },
    (base) => mkClient(base).chat({
      system: '只回复 OK。', user: 'ping', model: 'm', purpose: 'test',
      userId: 'u', maxTokens: 64, temperature: 0,
    }),
  );
  check('③ 思考占满预算、正文为空 → 判 reasoning-only（不是 empty）', () =>
    eq(r.failure?.kind, 'reasoning-only'), r.failure?.kind);
  check('④ reasoning-only 是 retryable:true（加预算就有救）', () =>
    eq(r.failure?.retryable, true));
  check('④ 错误信息带 reasoning_tokens，且报的是最后一次实际用的 max_tokens', () => {
    const m = String(r.failure?.message ?? '');
    const lastSent = sent[sent.length - 1];
    // 报最后一次而不是第一次：用户据此判断"再加多少"，报最初始的值会误导
    return ok(/reasoning_tokens=1/.test(m) && m.includes(`max_tokens=${lastSent}`),
      `message=${m} | 实际发送序列=${JSON.stringify(sent)}`);
  });
}

{
  const r = await withMock(
    () => ({ content: '', finish: 'stop' }),
    (base) => mkClient(base).chat({
      system: '总结一篇只有标题的文章。', user: '标题：空', model: 'm',
      purpose: 'test', userId: 'u', maxTokens: 64, temperature: 0,
    }),
  );
  check('④ 模型真的无话可说（无思考、finish=stop）→ 仍是 empty', () =>
    eq(r.failure?.kind, 'empty'), r.failure?.kind);
  check('④ empty 保持 retryable:false（原样重发还是空）', () =>
    eq(r.failure?.retryable, false));
}

// ── ⑤ 重试时翻倍预算 ───────────────────────────────────────
{
  const seen = [];
  const r = await withMock(
    (body) => {
      seen.push(body.max_tokens);
      // 前两次思考吃满，第三次（预算翻倍后）终于能答
      if (body.max_tokens < 200) {
        return { content: '', reasoning: 'thinking...', finish: 'length', reasoningTokens: body.max_tokens };
      }
      return { content: 'OK', finish: 'stop' };
    },
    (base) => mkClient(base).chat({
      system: '只回复 OK。', user: 'ping', model: 'm', purpose: 'test',
      userId: 'u', maxTokens: 64, temperature: 0,
    }),
  );
  check('⑤ 重试时 max_tokens 翻倍（64 → 128 → 256）', () =>
    ok(seen.length >= 2 && seen[1] === seen[0] * 2,
      `实际序列 ${JSON.stringify(seen)}`));
  check('⑤ 翻倍之后真的拿到了正文（重试是有意义的，不是空转）', () =>
    ok(r.ok === true && r.text === 'OK', JSON.stringify({ ok: r.ok, text: r.text })));
}

// ── ⑦ 别名 reasoning ───────────────────────────────────────
{
  const r = await withMock(
    () => ({ content: '', reasoningAlias: 'let me think', finish: 'length', reasoningTokens: 3 }),
    (base) => mkClient(base).chat({
      system: 'x', user: 'y', model: 'm', purpose: 'test', userId: 'u',
      maxTokens: 64, temperature: 0,
    }),
  );
  check('⑦ 网关用 reasoning 字段名时也判得出 reasoning-only', () =>
    eq(r.failure?.kind, 'reasoning-only'), r.failure?.kind);
}

// ── ⑥⑧ 正常路径不受影响 ───────────────────────────────────
{
  const r = await withMock(
    () => ({ content: 'OK', finish: 'stop' }),
    (base) => mkClient(base).chat({
      system: '只回复 OK。', user: 'ping', model: 'm', purpose: 'test',
      userId: 'u', maxTokens: 64, temperature: 0,
    }),
  );
  check('⑥ 非推理模型的正常返回仍然成功', () => ok(r.ok === true && r.text === 'OK'));
}

{
  // 推理内容与正文同时存在时，**只能返回正文**
  const r = await withMock(
    () => ({ content: '{"a":1}', reasoning: '我先想想……答案是 {"a":1}', finish: 'stop' }),
    (base) => mkClient(base).chat({
      system: 'x', user: 'y', model: 'm', purpose: 'test', userId: 'u',
      maxTokens: 64, temperature: 0,
    }),
  );
  check('⑧ 思考内容不得混进返回的正文（它是过程不是结论）', () =>
    ok(r.text === '{"a":1}', JSON.stringify(r.text)));
}

// ── ⑨ chatJson 与 chat 判定一致 ────────────────────────────
{
  const r = await withMock(
    () => ({ content: '', reasoning: 'thinking', finish: 'length', reasoningTokens: 5 }),
    (base) => mkClient(base).chatJson({
      schema: EntryAnalysisSchema,
      system: 'x', user: 'y', model: 'm', purpose: 'analyze',
      userId: 'u', maxTokens: 1200, temperature: 0,
    }),
  );
  check('⑨ chatJson 路径同样把"思考截断"判成 reasoning-only（不是 empty）', () =>
    eq(r.failure?.kind, 'reasoning-only'), r.failure?.kind);
  check('⑨ chatJson 的 reasoning-only 也可重试', () =>
    eq(r.failure?.retryable, true));
}

// ── ①② 测试连接端点本身 ───────────────────────────────────
//
// 这里**不能**自己传 maxTokens 再断言它等于 64 —— 那测的是我自己的参数，
// 不是端点行为（写断言时最容易犯的自问自答）。
//
// 正确做法：起一个真实服务，从 HTTP 打 /settings/ai/test，在 mock 上游里
// 记录端点**实际发出**的 max_tokens。它同时验证两件事：
//   · 端点的预算足够推理模型用
//   · 端点在推理模型上真的返回 ok:true 而不是"模型返回空"
{
  const { spawn } = await import('node:child_process');
  const { existsSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname, join, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { killTree } = await import('../lib/proc.mjs');

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const BIN = join(root, 'dist', process.platform === 'win32'
    ? `cheng-rss-${process.platform}-${process.arch}.exe`
    : `cheng-rss-${process.platform}-${process.arch}`);

  if (!existsSync(BIN)) {
    // 没构建过二进制就跳过这两条，而不是假装通过
    console.log('  \u001b[33mSKIP\u001b[0m  二进制不存在，跳过端点级断言（先跑 build.sh --sea）');
  } else {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const seen = [];
    // 推理模型行为：预算 < 32 只思考不出正文
    const upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += String(d); });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* ignore */ }
        if (String(req.url).endsWith('/chat/completions')) {
          seen.push(body.max_tokens);
          const mt = body.max_tokens ?? 0;
          const thinkOnly = mt < 32;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'x', object: 'chat.completion', model: body.model ?? 'm',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: thinkOnly ? '' : 'OK',
                reasoning_content: thinkOnly ? 'The' : 'think briefly then answer',
              },
              finish_reason: thinkOnly ? 'length' : 'stop',
            }],
            usage: {
              prompt_tokens: 40, completion_tokens: thinkOnly ? 1 : 12,
              completion_tokens_details: { reasoning_tokens: thinkOnly ? 1 : 10 },
            },
          }));
          return;
        }
        res.writeHead(404); res.end();
      });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = upstream.address().port;

    const dir = mkdtempSync(join(tmpdir(), 'cheng-rss-m209-'));
    const port = 45400 + Math.floor(Math.random() * 300);
    const uiBase = `http://127.0.0.1:${port}`;
    const proc = spawn(BIN, ['serve', '--data', join(dir, 'data'), '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AI_API_KEY: 'sk-mock',
        AI_BASE_URL: `http://127.0.0.1:${upPort}/v1`,
      },
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.stdout.on('data', () => {});

    let up = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${uiBase}/api/health`)).ok) { up = true; break; } } catch { /* */ }
      await sleep(250);
    }
    check('（前置）被测服务就绪', () => ok(up, stderr.slice(0, 200)));

    if (up) {
      await fetch(`${uiBase}/api/v1/auth/setup`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'r@t.local', password: 'rpass12345678' }),
      });
      const lr = await fetch(`${uiBase}/api/v1/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'r@t.local', password: 'rpass12345678' }),
      });
      const cookie = (lr.headers.get('set-cookie') ?? '').split(';')[0];

      const tr = await fetch(`${uiBase}/api/v1/settings/ai/test`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
      });
      const body = await tr.json().catch(() => ({}));

      check('② 测试连接实际发出的 max_tokens ≥32（推理模型需要思考空间）', () =>
        ok(seen.length > 0 && seen[0] >= 32, `实际 max_tokens=${JSON.stringify(seen)}`));
      check('① 对推理模型不再误报「模型返回空」，而是 ok:true', () =>
        ok(body?.ok === true, JSON.stringify(body)));
      check('① 返回的 text 里带得上模型答的正文', () =>
        ok(String(body?.text ?? '').includes('OK'), JSON.stringify(body)));
    }

    killTree(proc.pid);
    upstream.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
}

summary('m2-09-reasoning-model');
