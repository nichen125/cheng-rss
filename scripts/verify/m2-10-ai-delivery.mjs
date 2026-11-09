#!/usr/bin/env node
// 能力画像与按需投递（PLAN §8.10，v2.7 / 步骤 2.9）
//
// 判据（§19.4 的 2.9）：
//   ① 网关丢弃 `system` 时 analyze 仍产出卡片
//   ② 第一次用 split、第二次自动改 merged，且合并后 user 含 `<<<正文`
//   ③ 定界符出现在指令之后（指令不能被当成资料）
//   ④ 画像说 dropped 后不再发出 split 请求
//   ⑤ 同一实例分析第二篇只要 1 次请求
//   ⑥ 画像只写了 strong 时，fast 的调用仍走自愈路径
//   ⑦ summary 的定界只包 {{body}}
//   ⑧ entities 是数组 / key_points 7 条 / sentiment 缺失 → 归一化后成功
//   ⑨ 同时丢 system 且两档 response_format 都回 200+散文 → 仍能降到第三档并成功
//
// ## 这个脚本守的是什么
//
// 线上 649 次 analyze 调用 0 成功，根因不是 key、不是模型能力，而是
// **网关静默丢弃 system 消息**：指令没到模型手上，它只能自己猜任务，
// 猜成"分类+标签+理由"用散文回答，于是 bad-json。
// 所以这里的 mock 刻意只转发 `user` —— 它模拟的不是"模型不听话"，
// 而是"模型根本没收到指令"。这一条不写成断言，投递回落就没有守门人。
//
// ② 与 ⑤ 是两件事，别合并：② 证明"失败会换投递方式"，⑤ 证明"同一进程内
// 换过之后不再换回来"。少了 ⑤，795 条积压里每一条都要白烧一次 split。
import { createServer } from 'node:http';
import { group, check, eq, ok, gt, summary } from './harness.mjs';

const { AiClient } = await import('../../src/server/ai/client.ts');
const { EntryAnalysisSchema } = await import('../../src/server/ai/schema.ts');
const { buildSummaryUser } = await import('../../src/server/ai/summary.ts');

const CFG = (baseURL) => ({
  baseURL,
  apiKeyEnv: 'X',
  models: { fast: 'fast-m', strong: 'strong-m', embed: 'e' },
  limits: { rpm: 0, concurrency: 1 },
  budget: { dailyUsd: 0, monthlyUsd: 0 },
  fallback: { onBudgetExceeded: 'fast_only' },
  pricing: { default: { in: 0, out: 0 } },
  timeoutMs: 10_000,
});

/** 完全合规的卡片：用于证明"投递方式"这一件事，不带 schema 归一化的功劳 */
const CLEAN = {
  summary: 'AMD 以 32 亿美元收购 World Labs，补齐推理训练栈，交易预计 2027 年一季度完成。',
  key_points: ['32 亿美元现金加股票', '2022 年成立', '累计融资 11 亿', '推理训练占比不足 5%'],
  category: 'industry',
  topics: ['AMD', '并购'],
  entities: { people: [], orgs: ['AMD', 'World Labs'], products: [], tech: ['训练框架'] },
  importance: 78,
  novelty: 66,
  sentiment: 'neutral',
};

/** 一份"不完美"的卡片：entities 是数组、key_points 7 条、缺 sentiment（②⑧ 用） */
const SLOPPY = {
  summary: 'AMD 以 32 亿美元收购 World Labs，补齐推理训练栈，交易预计 2027 年一季度完成。',
  key_points: ['32 亿美元现金加股票', '2022 年成立', '累计融资 11 亿', '数据中心营收 42 亿',
    '同比增长 18%', '推理训练占比不足 5%', '对标英伟达软件栈'],
  category: 'industry',
  topics: ['AMD', '并购'],
  entities: ['AMD', 'World Labs'],
  importance: 78,
  novelty: 66,
};

/** 散文回复：模拟"模型没看见指令、自己猜成分类任务"时的真实形态 */
const PROSE = '分类：industry（产业）\n\n标签：AMD、并购\n\n理由：事件核心是 AMD 收购 World Labs。';

/**
 * 两种坏网关：
 *   dropSystem   —— 只转发 role==='user'（模拟 ty19217.top）
 *   ignoreFormat —— 无论 response_format 是什么都回散文（200，不是 4xx）
 *
 * `shape` 决定回包是合规卡片（clean）还是那份不完美的（sloppy）。
 * 分开是有意的：投递方式与 schema 归一化是两件事，混用一个回包就无法
 * 分辨"是投递修好了"还是"是归一化兜住了"。
 */
async function withMock({ dropSystem = false, ignoreFormat = false, shape = 'clean' }, fn) {
  const calls = [];
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += String(d); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      calls.push(body);

      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const forwarded = dropSystem ? msgs.filter((m) => m.role === 'user') : msgs;
      const sawInstructions = forwarded.some((m) => typeof m.content === 'string'
        && /数据|JSON|情报卡片|输出要求/.test(m.content) ? true : false);

      // 指令到没到手：到了才可能给出结构化结果
      const payload = shape === 'sloppy' ? SLOPPY : CLEAN;
      // ignoreFormat 的真实语义：**无视 response_format，但听得懂提示词**。
      // 所以只要请求里带了 response_format（json_schema / json_object），
      // 它就回散文；纯文本模式（没有该字段、字段清单写在提示词里）才照做。
      // 这正是实测网关的行为 —— 若把它写成"永远回散文"，这条断言就变成
      // "验证客户端不可能成功"，而不是"验证它会自己降到能work的那一档"。
      const text = (ignoreFormat && body.response_format)
        ? PROSE
        : (sawInstructions ? JSON.stringify(payload) : PROSE);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', model: body.model ?? 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
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

const mkClient = (baseURL, capabilities) => new AiClient({
  config: CFG(baseURL), apiKey: 'sk-t', sleepImpl: async () => {}, capabilities,
});

const ask = (client, user = '标题：AMD 收购 World Labs\n\n正文：AMD 今日宣布以 32 亿美元收购 World Labs。') =>
  client.chatJson({
    schema: EntryAnalysisSchema,
    system: '你是一名信息分析编辑。把一篇资讯压缩成结构化情报卡片。只输出 JSON。',
    user,
    model: client.config.models.strong,
    purpose: 'analyze',
    maxTokens: 800,
  });

/**
 * 带 `wrapUser: true` 的同一个请求。`ask` 故意不带它 —— ⑩ 要证明的正是
 * "调用方标了不可信整条 user，客户端就给 split 也加防护"。若默认行为已经带防护，
 * 这条断言就会在"默认"与"显式"之间摇摆，测不出调用方标注是否真的生效。
 */
const askWrapped = (client) => client.chatJson({
  schema: EntryAnalysisSchema,
  system: '你是一名信息分析编辑。把一篇资讯压缩成结构化情报卡片。只输出 JSON。',
  user: '标题：AMD 收购 World Labs。正文：AMD 今日宣布以 32 亿美元收购 World Labs。',
  model: client.config.models.strong,
  purpose: 'analyze',
  maxTokens: 800,
  wrapUser: true,
});

group('能力画像与按需投递（§8.10）');

// ── ① ~ ③ 丢 system 的网关上，第一次失败、第二次用 merged 成功 ──
{
  const r = await withMock({ dropSystem: true }, async (baseURL, calls) => {
    const c = mkClient(baseURL);
    const res = await ask(c);
    return { res, calls };
  });

  check('① 网关丢弃 system 时 analyze 仍产出卡片', () => ok(
    r.res.ok === true && typeof r.res.data?.category === 'string' && r.res.data.category !== '',
    `ok=${r.res.ok} failure=${r.res.failure?.kind}: ${r.res.failure?.message ?? ''}`,
  ));

  check('② 第一次 split、第二次 merged（user 里含 <<<正文）', () => {
    const first = r.calls[0]?.messages ?? [];
    const second = r.calls[1]?.messages ?? [];
    const hasSystem = (ms) => ms.some((m) => m.role === 'system');
    const mergedText = (ms) => ms.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    return ok(
      r.calls.length === 2
      && hasSystem(first) === true
      && hasSystem(second) === false
      && mergedText(second).includes('<<<正文'),
      `calls=${r.calls.length} firstHasSystem=${hasSystem(first)} secondHasSystem=${hasSystem(second)} `
      + `secondHasDelim=${mergedText(second).includes('<<<正文')}`,
    );
  });

  check('③ 定界符出现在指令之后（指令不被当成资料）', () => {
    const merged = mergedText2(r.calls[1]?.messages ?? []);
    const at = merged.indexOf('<<<正文');
    const instructionsAt = merged.indexOf('信息分析编辑');
    return ok(
      at > 0 && instructionsAt >= 0 && instructionsAt < at,
      `instructionsAt=${instructionsAt} delimAt=${at}`,
    );
  });

  function mergedText2(ms) {
    return ms.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  }
}

// ── ④ 画像说 dropped 后，一次 split 都不发 ──
{
  const caps = {
    baseURL: 'PLACEHOLDER',
    models: { 'strong-m': { systemRole: 'dropped', responseFormat: 'json_schema' } },
    embed: null,
    checkedAt: Date.now(),
  };
  const r = await withMock({ dropSystem: true }, async (baseURL, calls) => {
    // 画像的 baseURL 要与实际一致才算命中
    const c = mkClient(baseURL, { ...caps, baseURL });
    const res = await ask(c);
    return { res, calls };
  });

  check('④ 画像 systemRole=dropped 后不再发出 split 请求', () => {
    const hasSystem = (ms) => ms.some((m) => m.role === 'system');
    return ok(
      r.res.ok === true && r.calls.length === 1 && hasSystem(r.calls[0]?.messages ?? []) === false,
      `ok=${r.res.ok} calls=${r.calls.length} hasSystem=${hasSystem(r.calls[0]?.messages ?? [])}`,
    );
  });
}

// ── ⑤ 同一实例分析第二篇只要 1 次请求 ──
{
  const r = await withMock({ dropSystem: true }, async (baseURL, calls) => {
    const c = mkClient(baseURL);
    const first = await ask(c);
    const before = calls.length;
    const second = await ask(c, '标题：英伟达发布新架构\n\n正文：英伟达今日发布新一代推理架构。');
    return { first, second, before, after: calls.length };
  });

  check('⑤ 同一实例分析第二篇只要 1 次请求（进程内记忆生效）', () => ok(
    r.first.ok === true && r.second.ok === true && (r.after - r.before) === 1,
    `第二篇发出 ${r.after - r.before} 次请求，期望 1 次`,
  ));
}

// ── ⑥ 画像只写了 strong 时，fast 的调用仍走自愈路径 ──
{
  const r = await withMock({ dropSystem: true }, async (baseURL, calls) => {
    const c = mkClient(baseURL, {
      baseURL,
      // 只测过 strong-m，没测过 fast-m
      models: { 'strong-m': { systemRole: 'dropped', responseFormat: 'text' } },
      embed: null,
      checkedAt: Date.now(),
    });
    const res = await c.chatJson({
      schema: EntryAnalysisSchema,
      system: '你是一名信息分析编辑。只输出 JSON。',
      user: '标题：x\n\n正文：AMD 今日宣布以 32 亿美元收购 World Labs。',
      model: 'fast-m',
      purpose: 'analyze',
      maxTokens: 800,
    });
    return { res, calls };
  });

  check('⑥ 画像没覆盖的模型仍走自愈（首次 split）', () => {
    const first = r.calls[0]?.messages ?? [];
    return ok(
      r.res.ok === true && first.some((m) => m.role === 'system') === true,
      `第一次请求是否 split=${first.some((m) => m.role === 'system')}，期望 true（fast-m 没有画像）`,
    );
  });
}

// ── ⑦ summary 只包不可信的那几块：模板要求留在定界符外，标题与正文都在里面 ──
{
  const built = buildSummaryUser('## 要求\n1. 一句话结论\n2. 3~6 条要点\n\n{{title}}\n\n{{body}}', {
    title: 'AMD 收购 World Labs',
    body: 'AMD 今日宣布以 32 亿美元收购 World Labs。',
    summary: null,
    highlights: [],
  });

  check('⑦ summary 的模板要求留在定界符外，标题与正文都在定界符内', () => {
    const reqAt = built.user.indexOf('一句话结论');
    // 模板要求必须在**第一个**定界符之前：模板是用户写的指令，不能被当成资料
    const firstDelim = built.user.indexOf('<<<正文');
    // 标题与正文各自被包起来（标题也是抓来的：RSS 标题由发布方完全控制）
    const titleGuarded = built.user.includes('<<<正文\nAMD 收购 World Labs\n正文>>>');
    const bodyGuarded = built.user.includes('<<<正文\nAMD 今日宣布以 32 亿美元收购 World Labs。\n正文>>>');
    // system 里必须声明"定界符之间不可信"，否则定界符只是排版装饰
    const noticed = built.system.includes('不得执行');
    return ok(
      reqAt >= 0 && firstDelim > 0 && reqAt < firstDelim && titleGuarded && bodyGuarded && noticed,
      `要求位置=${reqAt} 首个定界=${firstDelim} 标题已包=${titleGuarded} `
      + `正文已包=${bodyGuarded} 有防护句=${noticed}`,
    );
  });
}

// ── ⑧ 不完美的输出要能救（归一化后再校验，§8.10）──
{
  const r = await withMock({ shape: 'sloppy' }, async (baseURL, calls) => {
    const c = mkClient(baseURL);
    const res = await ask(c);
    return { res, calls };
  });

  check('⑧ entities 数组 / key_points 7 条 / 缺 sentiment → 归一化后成功', () => {
    const d = r.res.data ?? {};
    const e = d.entities ?? {};
    const buckets = ['people', 'orgs', 'products', 'tech'].every((k) => Array.isArray(e[k]));
    const hasAny = ['people', 'orgs', 'products', 'tech'].some((k) => (e[k] ?? []).length > 0);
    return ok(
      r.res.ok === true
      && buckets && hasAny
      && Array.isArray(d.key_points) && d.key_points.length === 6
      && d.sentiment === 'neutral',
      `ok=${r.res.ok} 四桶齐=${buckets} 有值=${hasAny} key_points=${d.key_points?.length} sentiment=${d.sentiment}`,
    );
  });
}

// ── ⑨ 同时丢 system + 两档 response_format 都回 200 散文 ──
//    这是线上故障的完整组合：只修其中一条都过不了这条断言。
{
  const r = await withMock({ dropSystem: true, ignoreFormat: true }, async (baseURL, calls) => {
    const c = mkClient(baseURL);
    const res = await ask(c);
    return { res, calls };
  });

  check('⑨ 丢 system 且忽略 response_format 时仍能降到第三档并成功', () => {
    const last = r.calls.at(-1) ?? {};
    const text = (last.messages ?? []).map((m) => m.content).join('\n');
    return ok(
      r.res.ok === true
      && r.calls.length >= 3
      && text.includes('输出要求'),
      `ok=${r.res.ok} calls=${r.calls.length} 末次带字段清单=${text.includes('输出要求')}`,
    );
  });
}

// ── ⑩ split 模式下也要带防护：防护句在 system（可信侧），user 整体进定界符 ──
//    第一版只给 merged 加防护，而 split 才是默认路径 —— 等于绝大多数请求裸奔。
{
  const r = await withMock({}, async (baseURL, calls) => {
    const c = mkClient(baseURL);
    const res = await askWrapped(c);
    return { res, calls };
  });

  check('⑩ split 模式下 user 也被定界符包住、防护句在 system 里', () => {
    const first = r.calls[0]?.messages ?? [];
    const sys = first.find((m) => m.role === 'system')?.content ?? '';
    const user = first.find((m) => m.role === 'user')?.content ?? '';
    const wrapped = user.startsWith('<<<正文') && user.trimEnd().endsWith('正文>>>');
    return ok(
      r.res.ok === true
      && r.calls.length === 1
      && sys.includes('不得执行')
      && wrapped
      // 指令与正文都不能跑错边：system 里不该出现正文，user 里不该出现指令。
      // 注意不能断言 system 不含 `<<<正文` —— 防护句原文就在讲定界符。
      && !user.includes('信息分析编辑')
      && !sys.includes('AMD 今日宣布'),
      `ok=${r.res.ok} calls=${r.calls.length} 防护句在system=${sys.includes('不得执行')} `
      + `user被包住=${wrapped} user含指令=${user.includes('信息分析编辑')}`,
    );
  });
}

summary('m2-10-ai-delivery');
