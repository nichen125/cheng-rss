#!/usr/bin/env node
// 2.1 AI 客户端 + 结构化输出 —— 验收
//
// 判据（PLAN §19.4 2.1 + §8.2 + §8.6）：
//   ① mock 返回裸文本 / 围栏 JSON / 合法 JSON 三种都能解析
//   ② zod 校验失败自动重试一次（并把 issues 回灌）
//   ③ 二次失败给出可读失败、不抛异常（由调用方决定入死信）
//   ④ 降级链：服务端拒收 json_schema → 降 json_object → 再降纯文本，且只降一次
//   ⑤ 传输层重试：429/5xx/超时 重试 2 次后放弃；401/404 一次都不重试
//   ⑥ 每次调用（含重试的那次）各写一条 ai_usage —— 回灌重试是真实计费
//   ⑦ 没有 key 时不发任何请求，返回 kind=no-key
//   ⑧ 计费：未知模型按 pricing.default 计，不记 0
//
// 为什么全部用本地 mock 服务而不是连真模型：与 m1-14 用离线夹具同理 ——
// 验收必须离线可重复，而且「模型这次多吐了一行说明」这种输入不可能靠真实
// 服务稳定复现。真实模型只在 M2 门禁的黄金测试集里跑一次。
import { createServer } from 'node:http';
import { group, check, eq, ok, gt, summary } from './harness.mjs';
import { z } from 'zod';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock 上游 ────────────────────────────────────────────────
//
// 每个用例通过 /_script 设置「这次该回什么」。用可变状态而不是 URL 分支，
// 是因为被测代码的 URL 是客户端自己拼的，不该为了测试去适配它。
const state = {
  /** 依次消费的响应；空则回 500 */
  queue: [],
  requests: [],
};

const srv = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += String(d); });
  req.on('end', () => {
    if (req.url === '/_script') {
      state.queue = JSON.parse(body).queue;
      state.requests = [];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (req.url === '/_requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(state.requests));
    }

    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* 非 JSON */ }
    state.requests.push({ url: req.url, body: parsed, raw: body, headers: req.headers });

    const next = state.queue.shift() ?? { status: 500, body: 'unscripted' };
    if (next.delayMs) {
      setTimeout(() => respond(res, next), next.delayMs);
      return;
    }
    respond(res, next);
  });
});

function respond(res, spec) {
  if (spec.status === 0) { req_abort(res); return; }
  const ct = spec.contentType ?? 'application/json';
  res.writeHead(spec.status, { 'content-type': ct, ...(spec.headers ?? {}) });
  res.end(typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body));
}
function req_abort(res) {
  try { res.socket.destroy(); } catch { /* ignore */ }
}

await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const BASE = `http://127.0.0.1:${port}/v1`;

const cleanup = () => { try { srv.close(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const script = async (queue) => {
  await fetch(`http://127.0.0.1:${port}/_script`, {
    method: 'POST', body: JSON.stringify({ queue }),
  });
};
const reqs = async () => (await fetch(`http://127.0.0.1:${port}/_requests`)).json();

// ── 被测模块 ─────────────────────────────────────────────────
const {
  AiClient, DEFAULT_AI_CONFIG, resolveAiConfig, estimateCost,
} = await import('../../src/server/ai/client.ts');
const { EntryAnalysisSchema } = await import('../../src/server/ai/schema.ts');

/** 构造一个指向 mock 的客户端；退避不真等 */
function mkClient(over = {}) {
  const usage = [];
  const client = new AiClient({
    config: {
      ...DEFAULT_AI_CONFIG,
      baseURL: BASE,
      limits: { ...DEFAULT_AI_CONFIG.limits, rpm: 0 },
      ...(over.patch ?? {}),
    },
    apiKey: over.apiKey === undefined ? 'sk-test' : over.apiKey,
    sleepImpl: async () => {},          // 退避不真等，否则一条用例 4 秒
    onUsage: (u) => usage.push(u),
  });
  return { client, usage };
}

const TOY = z.object({ answer: z.string(), n: z.number().int() });
const CHAT_OPTS = {
  schema: TOY, system: '你是助手', user: '数字 42 的答案', model: 'toy-model',
  purpose: 'test', userId: 'u_test',
};

/** OpenAI 形状的成功响应 */
const okBody = (content) => ({
  status: 200,
  body: {
    id: 'chatcmpl-1', object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  },
});

// ── ① 三种返回形态都能解析 ──────────────────────────────────
group('2.1 AI 客户端 · 解析');

for (const [label, content] of [
  ['裸 JSON', '{"answer":"四十二","n":42}'],
  ['```json 围栏', '```json\n{"answer":"四十二","n":42}\n```'],
  ['``` 无语言标记围栏', '```\n{"answer":"四十二","n":42}\n```'],
  ['前后带客套话', '好的，结果如下：\n{"answer":"四十二","n":42}\n希望有帮助。'],
]) {
  await script([okBody(content)]);
  const { client } = mkClient();
  const r = await client.chatJson(CHAT_OPTS);
  check(`${label} 能解析`, () => ok(
    r.ok === true && r.data.answer === '四十二' && r.data.n === 42,
    JSON.stringify(r.ok ? r.data : r.failure),
  ));
}

// 反面：真的不是 JSON 时必须失败，不能"猜"。
// 两条脚本：bad-json 会触发一次结构重试（回灌提示），所以第二次也得给定。
await script([okBody('抱歉，我无法回答这个问题。'), okBody('仍然不是 JSON')]);
{
  const { client } = mkClient();
  const r = await client.chatJson(CHAT_OPTS);
  check('纯文字（无 JSON）判 bad-json 而不是当成空对象', () => ok(
    r.ok === false && r.failure.kind === 'bad-json',
    JSON.stringify(r.failure),
  ));
}

// ── ② zod 失败自动重试一次，且把 issues 回灌 ────────────────
group('2.1 AI 客户端 · 结构校验与重试');

await script([
  okBody('{"answer":"四十二"}'),                       // 缺 n
  okBody('{"answer":"四十二","n":42}'),                // 重试后合规
]);
{
  const { client, usage } = mkClient();
  const r = await client.chatJson(CHAT_OPTS);
  const sent = await reqs();
  check('缺字段 → 自动重试一次后成功', () => ok(
    r.ok === true && r.data.n === 42,
    JSON.stringify(r.ok ? r.data : r.failure),
  ));
  check('重试请求里带上了校验错误（回灌 issues）', () => {
    const last = sent[sent.length - 1];
    const text = JSON.stringify(last?.body ?? {});
    // 必须提到 n 这个字段名 —— 只说"格式不对"模型无从修正
    return ok(sent.length === 2 && /\bn\b/.test(text) && /(Expected|expected|number|类型|字段)/.test(text),
      `请求数=${sent.length}，是否提到 n=${/\bn\b/.test(text)}`);
  });
  check('两次调用各记一条 usage（回灌重试是真实计费）', () => eq(usage.length, 2));
  check('usage 里带 token 数与成本', () => ok(
    usage.every((u) => u.inTokens === 11 && u.outTokens === 7 && typeof u.costUsd === 'number' && u.costUsd > 0),
    JSON.stringify(usage),
  ));
}

// ── ③ 二次失败：可读失败、不抛 ──────────────────────────────
await script([
  okBody('{"answer":"四十二"}'),
  okBody('{"answer":"四十二"}'),      // 还是不合规
  okBody('{"answer":"四十二","n":42}'), // 第三次不该被用掉
]);
{
  const { client, usage } = mkClient();
  let threw = null;
  let r = null;
  try { r = await client.chatJson(CHAT_OPTS); } catch (e) { threw = e.message; }
  const sent = await reqs();
  check('两次都不合规 → 返回失败而不是抛异常', () => ok(
    threw === null && r?.ok === false && r.failure.kind === 'schema',
    `threw=${threw} failure=${JSON.stringify(r?.failure)}`,
  ));
  check('只重试一次（总共 2 个请求，不吃第三次）', () => eq(sent.length, 2));
  check('失败文案能读到缺了哪个字段', () => ok(
    /n/.test(String(r?.failure?.message ?? '')),
    `message=${r?.failure?.message}`,
  ));
  check('失败的两次也都记了 usage', () => ok(
    usage.length === 2 && usage.every((u) => u.ok === false && u.error),
    JSON.stringify(usage),
  ));
  check('失败标记为不可在队列层重试（已是 schema 错）', () => ok(
    r?.failure?.retryable === false,
    `retryable=${r?.failure?.retryable}`,
  ));
}

// ── ④ 降级链 ────────────────────────────────────────────────
group('2.1 AI 客户端 · response_format 降级链');

await script([
  { status: 400, body: { error: { message: 'response_format is not supported by this endpoint' } } },
  okBody('{"answer":"四十二","n":42}'),
]);
{
  const { client } = mkClient();
  const r = await client.chatJson(CHAT_OPTS);
  const sent = await reqs();
  check('服务端拒收 json_schema → 降级后成功', () => ok(r.ok === true, JSON.stringify(r.failure)));
  check('第一次请求带 json_schema', () => eq(
    sent[0]?.body?.response_format?.type, 'json_schema'));
  check('第二次请求降为 json_object', () => eq(
    sent[1]?.body?.response_format?.type, 'json_object'));
}

// 记忆：同一模型第二次调用直接走 json_object，不再先撞一次 400
await script([
  okBody('{"answer":"四十二","n":42}'),
]);
{
  const { client } = mkClient();
  // 同一实例先让它学会"不支持"
  await script([
    { status: 400, body: { error: { message: 'response_format unsupported' } } },
    okBody('{"answer":"四十二","n":42}'),
  ]);
  await client.chatJson(CHAT_OPTS);
  // 再调一次
  await script([okBody('{"answer":"四十二","n":42}')]);
  const before = (await reqs()).length;
  await client.chatJson(CHAT_OPTS);
  const sent = await reqs();
  check('已学会不支持后，下一个请求直接是 json_object（不重复撞墙）', () => ok(
    before === 0 && sent.length === 1 && sent[0]?.body?.response_format?.type === 'json_object',
    `调用前请求数=${before} 本次请求数=${sent.length} response_format=${sent[0]?.body?.response_format?.type}`,
  ));
}

// 两级都不支持 → 纯文本（不带 response_format）
await script([
  { status: 400, body: { error: { message: 'response_format json_schema not supported' } } },
  { status: 400, body: { error: { message: 'response_format json_object not supported' } } },
  okBody('{"answer":"四十二","n":42}'),
]);
{
  const { client } = mkClient();
  const r = await client.chatJson(CHAT_OPTS);
  const sent = await reqs();
  check('两级都不支持 → 纯文本也能拿到结果', () => ok(
    r.ok === true && sent.length === 3,
    `ok=${r.ok} 请求数=${sent.length} failure=${JSON.stringify(r.failure)}`,
  ));
  check('纯文本那一次不带 response_format 字段', () => ok(
    sent[2]?.body?.response_format === undefined,
    JSON.stringify(sent[2]?.body?.response_format),
  ));
  check('纯文本模式提示词内嵌了 schema 说明', () => {
    const msgs = sent[2]?.body?.messages ?? [];
    const text = JSON.stringify(msgs);
    return ok(/JSON/.test(text) && /answer/.test(text), text.slice(0, 200));
  });
}

// 关键反面：400 但报文里没提 response_format → 是别的错，不许当降级
await script([
  { status: 400, body: { error: { message: 'model `no-such-model` does not exist' } } },
]);
{
  const { client } = mkClient();
  const r = await client.chatJson(CHAT_OPTS);
  const sent = await reqs();
  check('400 与 response_format 无关时不降级，直接判 http-400', () => ok(
    r.ok === false && r.failure.kind === 'http-400' && sent.length === 1,
    `kind=${r.failure?.kind} 请求数=${sent.length}`,
  ));
}

// ── ⑤ 传输层重试边界 ────────────────────────────────────────
group('2.1 AI 客户端 · 传输层重试');

for (const status of [429, 500, 503]) {
  await script([{ status, body: 'x' }, { status, body: 'x' }, { status, body: 'x' }, { status, body: 'x' }]);
  const { client } = mkClient();
  const r = await client.chatJson(CHAT_OPTS);
  const sent = await reqs();
  check(`${status} 重试 2 次后放弃（共 3 个请求）`, () => ok(
    r.ok === false && r.failure.kind === `http-${status}` && sent.length === 3,
    `kind=${r.failure?.kind} 请求数=${sent.length}`,
  ));
  check(`${status} 的失败标记为可重试`, () => ok(r.failure.retryable === true, `retryable=${r.failure?.retryable}`));
}

// 429 带 Retry-After：退避时长要听它的
await script([
  { status: 429, body: 'slow down', headers: { 'retry-after': '2' } },
  okBody('{"answer":"四十二","n":42}'),
]);
{
  const delays = [];
  const { client } = mkClient();
  const client2 = new AiClient({
    config: { ...DEFAULT_AI_CONFIG, baseURL: BASE, limits: { ...DEFAULT_AI_CONFIG.limits, rpm: 0 } },
    apiKey: 'sk-test',
    sleepImpl: async (ms) => { delays.push(ms); },
    onUsage: () => {},
  });
  void client;
  const r = await client2.chatJson(CHAT_OPTS);
  check('429 + Retry-After: 2 → 退避 2000ms（不是默认的 1s）', () => ok(
    r.ok === true && delays[0] === 2000,
    `delays=${JSON.stringify(delays)}`,
  ));
}

// 401/404 一次都不重试
for (const [status, kind] of [[401, 'http-401'], [404, 'http-404'], [422, 'http-422']]) {
  await script([{ status, body: { error: { message: 'nope' } } }]);
  const { client } = mkClient();
  const r = await client.chatJson(CHAT_OPTS);
  const sent = await reqs();
  check(`${status} 不重试（1 个请求）且 kind=${kind}`, () => ok(
    r.ok === false && r.failure.kind === kind && sent.length === 1,
    `kind=${r.failure?.kind} 请求数=${sent.length}`,
  ));
  check(`${status} 标记为不可重试`, () => ok(r.failure.retryable === false, `retryable=${r.failure?.retryable}`));
}

// 连接层失败 + 超时
await script([{ status: 0 }, okBody('{"answer":"x","n":1}')]);
{
  const { client } = mkClient();
  const r = await client.chatJson(CHAT_OPTS);
  check('连接被断开 → 重试后成功', () => ok(r.ok === true, JSON.stringify(r.failure)));
}

// 三次都给慢响应：超时是可重试的，最终失败必须是 timeout 而不是
// 被后面某个别的响应覆盖成别的 kind（否则这条断言测的就不是超时了）
await script([
  { status: 200, body: okBody('{"answer":"慢","n":1}').body, delayMs: 400 },
  { status: 200, body: okBody('{"answer":"慢","n":1}').body, delayMs: 400 },
  { status: 200, body: okBody('{"answer":"慢","n":1}').body, delayMs: 400 },
]);
{
  const { client, usage } = mkClient({ patch: { timeoutMs: 150 } });
  const t0 = Date.now();
  const r = await client.chatJson(CHAT_OPTS);
  const ms = Date.now() - t0;
  check('三次都超时 → 判 timeout 且不无限等', () => ok(
    r.ok === false && r.failure.kind === 'timeout' && ms < 3000,
    `kind=${r.failure?.kind} 耗时=${ms}ms message=${r.failure?.message}`,
  ));
  check('超时也重试了 2 次（共 3 条 usage 记录）', () => eq(usage.length, 3));
}

// ── ⑦ 没有 key ─────────────────────────────────────────────
group('2.1 AI 客户端 · 没配 key');

await script([]);
{
  const { client, usage } = mkClient({ apiKey: null });
  const r = await client.chatJson(CHAT_OPTS);
  const sent = await reqs();
  check('没有 key → kind=no-key，且一次请求都不发', () => ok(
    r.ok === false && r.failure.kind === 'no-key' && sent.length === 0,
    `kind=${r.failure?.kind} 请求数=${sent.length}`,
  ));
  check('没配 key 不算"调用失败"，不写 usage（没花任何钱）', () => eq(usage.length, 0));
  check('no-key 不可重试（重试也变不出 key）', () => ok(r.failure.retryable === false));
}

// ── ⑧ 计费 ─────────────────────────────────────────────────
group('2.1 AI 客户端 · 计费');

check('已知模型按表计费：0.27/M 入 + 1.1/M 出', () => {
  const c = estimateCost(DEFAULT_AI_CONFIG.pricing, 'deepseek-chat', 1_000_000, 1_000_000);
  return ok(Math.abs(c - 1.37) < 1e-9, `算得 ${c}`);
});
check('未知模型按 pricing.default，不记 0', () => {
  const c = estimateCost(DEFAULT_AI_CONFIG.pricing, '某不认识的模型', 1_000_000, 0);
  return ok(c > 0, `算得 ${c}`);
});
check('token 数缺失时不抛，按 0 计但仍记一条', () => {
  const c = estimateCost(DEFAULT_AI_CONFIG.pricing, 'deepseek-chat', null, undefined);
  return eq(c, 0);
});

// ── ⑨ 配置合并 ─────────────────────────────────────────────
group('2.1 AI 客户端 · 配置');

check('DEFAULT_AI_CONFIG 里 embed 模型与 fast/strong 分开', () => {
  const m = DEFAULT_AI_CONFIG.models;
  return ok(typeof m.fast === 'string' && typeof m.strong === 'string'
    && typeof m.embed === 'string' && m.embed !== m.fast,
    JSON.stringify(m));
});
check('settings.ai_config 覆盖默认值，未写的字段保留默认', () => {
  const merged = resolveAiConfig({ baseURL: 'https://x/v1', models: { fast: 'a' } });
  return ok(
    merged.baseURL === 'https://x/v1'
    && merged.models.fast === 'a'
    && merged.models.strong === DEFAULT_AI_CONFIG.models.strong
    && merged.models.embed === DEFAULT_AI_CONFIG.models.embed
    && merged.budget.dailyUsd === DEFAULT_AI_CONFIG.budget.dailyUsd,
    JSON.stringify(merged),
  );
});
check('apiKey 只从环境变量名读，不从 settings 里读明文', () => {
  const merged = resolveAiConfig({ apiKey: 'sk-should-be-ignored' });
  return ok(merged.apiKeyEnv === DEFAULT_AI_CONFIG.apiKeyEnv,
    `apiKeyEnv=${merged.apiKeyEnv}`);
});

// ── ⑩ EntryAnalysisSchema 本身 ─────────────────────────────
group('2.1 AI 客户端 · 分析 schema');

const goodAnalysis = {
  summary: '某公司发布新品，售价 999 元，10 月上市。',
  key_points: ['售价 999 元', '10 月上市'],
  category: 'tech',
  topics: ['新品'],
  entities: { people: [], orgs: ['某公司'], products: ['新品'], tech: [] },
  importance: 75,
  novelty: 60,
  sentiment: 'neutral',
};
check('完整对象通过校验', () => ok(EntryAnalysisSchema.safeParse(goodAnalysis).success));
check('缺 summary → 拒绝', () => {
  const { summary, ...rest } = goodAnalysis;
  void summary;
  return ok(!EntryAnalysisSchema.safeParse(rest).success);
});
check('key_points 少于 2 条 → 拒绝（§8.2 要求 2~6）', () => ok(
  !EntryAnalysisSchema.safeParse({ ...goodAnalysis, key_points: ['只有一条'] }).success,
));
check('importance 越界（101）→ 拒绝', () => ok(
  !EntryAnalysisSchema.safeParse({ ...goodAnalysis, importance: 101 }).success,
));
check('sentiment 不在枚举里 → 拒绝', () => ok(
  !EntryAnalysisSchema.safeParse({ ...goodAnalysis, sentiment: '开心' }).success,
));
check('多余字段被剥掉而不是报错（模型常多吐一个 confidence）', () => {
  const r = EntryAnalysisSchema.safeParse({ ...goodAnalysis, confidence: 0.9 });
  return ok(r.success && !('confidence' in r.data), JSON.stringify(r.success ? Object.keys(r.data) : r.error.issues));
});

// 校验失败还有额外一点：字段路径要能被拼成可读文案
check('校验错误能拼出「字段 + 原因」的可读句子', () => {
  const r = EntryAnalysisSchema.safeParse({ ...goodAnalysis, importance: '高' });
  const msg = r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return ok(r.success === false && /importance/.test(msg), msg);
});

// ── 汇总 ───────────────────────────────────────────────────
summary('m2-01-ai-client');
cleanup();
await sleep(10);
process.exit(process.exitCode ?? 0);
