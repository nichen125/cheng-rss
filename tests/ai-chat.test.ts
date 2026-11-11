// AiClient.chat 的单测（fix/ai-chat-failures）。
//
// 这一层的两个错法都只在"重试走到边界"时才现形，靠手点界面复现不了：
//   1. 最后一次尝试才变空时，投递切换的 continue 会把控制流带出循环，
//      函数末尾报"请求未发出"——已经发了 3 次，最后明确是空内容；
//   2. 预算翻倍直接改写调用方传进来的 opts.maxTokens，同一个 opts 第二次
//      调用就带着上一次翻倍后的值起跳。
// 所以这里注入假 fetch，按"第几次请求返回什么"逐条断言请求体与失败类别。
import test from 'node:test';
import assert from 'node:assert/strict';
import { AiClient, DEFAULT_AI_CONFIG, type AiConfig, type ChatOptions } from '../src/server/ai/client.ts';

/** 一次假响应：HTTP 状态 + 正文（chat/completions 形状或错误文本） */
interface FakeReply {
  status: number;
  text: string;
}

/** 只声明本文件真正要断言的那几个字段 */
interface ChatBody {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens?: number;
}

const TEST_CONFIG: AiConfig = {
  ...DEFAULT_AI_CONFIG,
  // rpm 0 = 不限流：这里断言的是"发了几次"，限流等待只会把测试变成计时赛
  limits: { rpm: 0, concurrency: 1 },
  timeoutMs: 5_000,
};

function okReply(content: string, completionTokens: number | null, finishReason?: string): FakeReply {
  return {
    status: 200,
    text: JSON.stringify({
      choices: [{
        message: { content },
        ...(finishReason ? { finish_reason: finishReason } : {}),
      }],
      usage: {
        prompt_tokens: 10,
        ...(completionTokens == null ? {} : { completion_tokens: completionTokens }),
      },
    }),
  };
}

/**
 * 空内容且未被截断 —— 这就是 `empty`。
 *
 * completion_tokens 必须小于 max_tokens，否则会被判成 `reasoning-only`
 * （思考吃光预算），那是一条完全相反的结论：可重试、要翻倍。
 */
const emptyReply = (): FakeReply => okReply('', 1);

const serverErrorReply = (): FakeReply => ({ status: 500, text: 'upstream boom' });

function makeClient(replies: FakeReply[]): { client: AiClient; bodies: ChatBody[] } {
  const bodies: ChatBody[] = [];
  const fetchImpl = (async (_input: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as ChatBody);
    const reply = replies.shift();
    assert.ok(reply, `假 fetch 的响应序列用完了（第 ${bodies.length} 次请求）`);
    return new Response(reply.text, {
      status: reply.status,
      headers: { 'content-type': reply.status >= 400 ? 'text/plain' : 'application/json' },
    });
  }) as unknown as typeof fetch;

  const client = new AiClient({
    config: TEST_CONFIG,
    apiKey: 'test-key',
    // 不真睡：退避时长不属于这里要断言的行为
    sleepImpl: async () => {},
    fetchImpl,
    capabilities: null,
  });
  return { client, bodies };
}

const OPTS: ChatOptions = { system: '指令', user: '资料', model: 'deepseek-chat', purpose: 'test' };

test('全程空内容：split 换 merged 后共 2 次请求，报 empty 而不是"请求未发出"', async () => {
  const { client, bodies } = makeClient([emptyReply(), emptyReply()]);

  const r = await client.chat({ ...OPTS });

  // 换投递只准换一次：第 3 次同形状的请求救不了"模型无话可说"
  assert.equal(bodies.length, 2);
  // 第一次 split（system + user），第二次已经学到 merged（指令与资料合成一条 user）
  assert.deepEqual(bodies[0]!.messages.map((m) => m.role), ['system', 'user']);
  assert.deepEqual(bodies[1]!.messages.map((m) => m.role), ['user']);

  if (r.ok) assert.fail('全程空内容不该报成功');
  assert.equal(r.failure.kind, 'empty');
  // 空内容不是传输层失败：重跑一遍只会再花一次钱
  assert.equal(r.failure.retryable, false);
});

test('预算翻倍不外泄：同一个 opts 连调两次，第二次仍按原始 max_tokens 起跳', async () => {
  const { client, bodies } = makeClient([
    // 第一次：completion_tokens 正好等于请求的 100 → 判 reasoning-only，可重试
    okReply('', 100),
    okReply('第一次的正文', 5),
    okReply('第二次的正文', 5),
  ]);
  const opts: ChatOptions = { ...OPTS, maxTokens: 100 };

  const r1 = await client.chat(opts);
  assert.ok(r1.ok, '第一次应当重试成功后返回正文');
  assert.equal(bodies[0]!.max_tokens, 100);
  // 翻倍本身仍然生效（修复不改翻倍时机与行为）
  assert.equal(bodies[1]!.max_tokens, 200);

  const r2 = await client.chat(opts);
  assert.ok(r2.ok);
  // 修复前这里是 200 —— 第一次调用把调用方的 opts.maxTokens *= 2 了
  assert.equal(bodies[2]!.max_tokens, 100);
  assert.equal(opts.maxTokens, 100);
});

test('最后一次尝试才变空：报这次的空内容，而不是上一次的 HTTP 失败', async () => {
  const { client, bodies } = makeClient([serverErrorReply(), serverErrorReply(), emptyReply()]);

  const r = await client.chat({ ...OPTS });

  // 两次 5xx 用掉了重试额度，第 3 次确实发了
  assert.equal(bodies.length, 3);
  if (r.ok) assert.fail('最后返回空内容不该报成功');
  // 修复前这里会返回 last（上次的 http-500），把"最后明确是空内容"掩盖掉
  assert.equal(r.failure.kind, 'empty');
  assert.equal(r.failure.retryable, false);
});

test('正常成功：一次请求，正文按 trim 后返回', async () => {
  const { client, bodies } = makeClient([okReply('  正常正文  ', 12)]);

  const r = await client.chat({ ...OPTS });

  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]!.messages.map((m) => m.role), ['system', 'user']);
  if (!r.ok) assert.fail(`期望成功：${r.failure.kind} ${r.failure.message}`);
  assert.equal(r.text, '正常正文');
});
