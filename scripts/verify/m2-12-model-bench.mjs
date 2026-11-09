#!/usr/bin/env node
// 模型测速 —— 验收（PLAN §8.11，v2.7 / 步骤 2.11）
//
// 判据（§19.4 的 2.11）：
//   ① mock 发 SSE 且首块延迟可注入 → ttftMs 落在注入值 ±50ms
//   ② 正文首块迟于思考首块 → firstReasoningMs <= firstContentMs
//   ③ mock 忽略 stream 只回 JSON → streamed:false、ttftMs:null、totalMs > 0
//   ④ 同一模型 3 次、其中 1 次 500 → 3 条 run、runs[1].ok===false、中位数由另两次算
//   ⑤ tokensPerSec 只用 usage.completion_tokens 与时间差算，不从 content 长度推
//
// ## 为什么要断言"首字"这么细
//
// 首字速度是这个功能唯一的新信息量。总耗时用户在浏览器里掐表也能得到个大概，
// 而"打字机什么时候开始动"给不了 —— 它要 SSE 才有。所以：
//
//   ① 用可注入的延迟验"量到的是真时间"，而不是"有个数字就叫 TTFT"；
//   ③ 验"不支持流式时如实说 null"，**不许拿总耗时冒充** —— 那会让唯一的
//      判据变成假的，而假数据的危害远大于没有数据；
//   ⑤ 验"输出速度不从 content 长度推" —— 实测这台网关会把推理文本混进
//      content，按字符数算会得出一个偏高的假速度。
import { createServer } from 'node:http';
import { group, check, eq, ok, gt, lt, summary } from './harness.mjs';

const { AiClient } = await import('../../src/server/ai/client.ts');
const { benchModels } = await import('../../src/server/ai/bench.ts');

const CFG = (baseURL) => ({
  baseURL,
  apiKeyEnv: 'X',
  models: { fast: 'm', strong: 'm', embed: 'e' },
  limits: { rpm: 0, concurrency: 1 },
  budget: { dailyUsd: 0, monthlyUsd: 0 },
  fallback: { onBudgetExceeded: 'fast_only' },
  pricing: { default: { in: 0, out: 0 } },
  timeoutMs: 20_000,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起一个 SSE 上游。
 *
 * `plan` 决定行为：
 *   chunks: [{ delay, kind: 'reasoning'|'content', text }]
 *   sse:    false 时忽略 stream、只回普通 JSON
 *   fail:   第 n 次请求（1 起）回 500
 *   usage:  completion_tokens，用于验 tokensPerSec 的来源
 */
async function withUpstream(plan, fn) {
  const calls = [];
  let n = 0;
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += String(d); });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      calls.push(body);
      n++;

      if (plan.fail === n) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'boom' } }));
        return;
      }

      const wantsStream = Boolean(body.stream) && plan.sse !== false;
      if (!wantsStream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: '这是正文。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: plan.usage ?? 40 },
        }));
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const c of plan.chunks) {
        await sleep(c.delay);
        const delta = c.kind === 'reasoning'
          ? { reasoning_content: c.text }
          : { content: c.text };
        res.write(`data: ${JSON.stringify({
          id: 'x', model: body.model,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`);
      }
      if (plan.usage) {
        res.write(`data: ${JSON.stringify({
          id: 'x', model: body.model, choices: [], usage: { prompt_tokens: 20, completion_tokens: plan.usage },
        })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}/v1`, calls);
  } finally {
    srv.close();
  }
}

const mkClient = (baseURL) => new AiClient({ config: CFG(baseURL), apiKey: 'sk-t', sleepImpl: async () => {} });

group('2.11 模型测速');

// ── ①② 首块延迟可注入，思考先于正文 ──
{
  const r = await withUpstream({
    sse: true,
    usage: 50,
    chunks: [
      { delay: 300, kind: 'reasoning', text: '思考…' },
      { delay: 200, kind: 'content', text: '正文开头' },
      { delay: 100, kind: 'content', text: '正文续' },
    ],
  }, async (baseURL) => {
    const c = mkClient(baseURL);
    return c.probeSpeed({ model: 'm', prompt: 'ping' });
  });

  check('① 首字（TTFT）落在注入的 300ms ±50ms 内', () => ok(
    r.streamed === true && r.ttftMs >= 250 && r.ttftMs <= 400,
    `streamed=${r.streamed} ttftMs=${r.ttftMs}`,
  ));

  check('② 思考首字早于正文首字，且正文首字 ≈ 300+200', () => ok(
    r.firstReasoningMs !== null && r.firstContentMs !== null
    && r.firstReasoningMs <= r.firstContentMs
    && r.firstContentMs >= 450 && r.firstContentMs <= 620,
    `reasoning=${r.firstReasoningMs} content=${r.firstContentMs}`,
  ));
}

// ── ③ 不支持流式时如实说 null，不拿总耗时冒充 ──
{
  const r = await withUpstream({ sse: false, usage: 30 }, async (baseURL) => {
    const c = mkClient(baseURL);
    return c.probeSpeed({ model: 'm', prompt: 'ping' });
  });

  check('③ 网关不认 stream 时 streamed=false、ttft=null、total>0', () => ok(
    r.ok === true && r.streamed === false && r.ttftMs === null && r.totalMs > 0,
    JSON.stringify(r),
  ));
}

// ── ④ 三跑取中位数，中间那次失败不影响其余 ──
{
  const r = await withUpstream({
    sse: true,
    usage: 60,
    // 只有第一次请求会带 chunks（后续请求次数由 fail 控制）
    chunks: [
      { delay: 60, kind: 'content', text: '正文' },
    ],
    fail: 2,
  }, async (baseURL) => {
    const c = mkClient(baseURL);
    return benchModels({ client: c, models: ['m'], runs: 3 });
  });

  const row = r[0];
  check('④ 三次里一次失败：仍返回 3 条 run 且中位数由成功的两次算出', () => ok(
    row.runs.length === 3
    && row.runs[1].ok === false
    && row.median.ok === true
    && row.median.totalMs > 0,
    JSON.stringify({ runs: row.runs.map((x) => x.ok), median: row.median }),
  ));
}

// ── ⑤ 输出速度只用 usage.completion_tokens，不从 content 长度推 ──
{
  const r = await withUpstream({
    sse: true,
    // 关键：内容只有 6 个字，但 usage=600。按字符数算会得出一个假的高速度。
    // 生成阶段要给足时间（正文首块之后再来 400ms），否则 total-firstContent
    // 会接近 0，速度在数学上不可算 —— 那是正确行为，不该被断言误伤。
    usage: 600,
    chunks: [
      { delay: 50, kind: 'reasoning', text: '这是一段很长的思考文本，但它不该被算成正文字数。' },
      { delay: 50, kind: 'content', text: '短短六字' },
      { delay: 400, kind: 'content', text: '' },
    ],
  }, async (baseURL) => {
    const c = mkClient(baseURL);
    return c.probeSpeed({ model: 'm', prompt: 'ping' });
  });

  check('⑤ tokensPerSec 由 usage.completion_tokens 算出，不从 content 长度推', () => {
    const span = r.totalMs - (r.firstContentMs ?? 0);
    const fromUsage = span > 5 ? 600 / (span / 1000) : null;
    const ratio = (r.tokensPerSec !== null && fromUsage) ? r.tokensPerSec / fromUsage : null;
    return ok(
      r.outTokens === 600 && r.tokensPerSec !== null && ratio !== null && ratio > 0.5 && ratio < 2,
      `outTokens=${r.outTokens} tokensPerSec=${r.tokensPerSec} 由 usage 反推=${fromUsage?.toFixed(1)} span=${span}ms`,
    );
  });
}

// ── ⑥ 正文攒成一波送达时不报假速度（实测 ty19217.top 就是这样）──
//
// 真实现象：首字 2193ms、总耗时 2208ms，167 tok 除出 6466 tok/s。
// 那个数不是模型速度，是上游缓冲区的速度。窗口短到不足以是一次逐字生成时，
// 契约是返回 null（= 没测到），而不是给一个会被读成"这个模型超快"的数。
{
  const r = await withUpstream({
    sse: true,
    usage: 167,
    chunks: [
      { delay: 80, kind: 'content', text: '一整段正文' },
      { delay: 5, kind: 'content', text: '立刻补上' },
      { delay: 5, kind: 'content', text: '又一段' },
    ],
  }, async (baseURL) => {
    const c = mkClient(baseURL);
    return c.probeSpeed({ model: 'm', prompt: 'ping' });
  });

  const span = r.totalMs - (r.firstContentMs ?? 0);
  check('⑥ 生成窗口太短（<200ms）时 tokensPerSec=null，不拿缓冲速度冒充', () => ok(
    r.outTokens === 167 && span < 200 && r.tokensPerSec === null,
    `outTokens=${r.outTokens} tokensPerSec=${r.tokensPerSec} span=${span}ms`,
  ));
}

summary('m2-12-model-bench');
