import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AiClient } from './client.ts';
import { mergeCapabilities, type AiCapabilities, type ModelCapability } from './capabilities.ts';
import { resolveKey } from './secrets.ts';
import { runAnalyze } from './analyze.ts';
import { runSummary, summaryPromptState } from './summary.ts';
import { unpackText } from '../db/text-blob.ts';
import { htmlToText } from '../feeds/parse.ts';
import { recordUsage } from './usage.ts';
import { budgetState } from './budget.ts';
import type { RuntimeAiBase } from './service.ts';

// AI 自检（PLAN §8.10 / §15.30，v2.7 / 步骤 2.10）。
//
// 存在理由不是"加个诊断页"，而是这台中转网关**静默丢弃 system 消息**这件事
// 没有任何报错路径能暴露：HTTP 200、`finish_reason: stop`、token 照烧。
// 线上 649 次 analyze 调用 0 成功，用户能看到的只有"分析失败 N 篇"。
// 所以这里要回答的是**每一步通不通、不通该怎么办**，而不是"key 能不能用"
// （那个由既有的 POST /settings/ai/test 回答，2 秒出结果）。
//
// ## 为什么第 3~6 步用裸 fetch 而不是走 AiClient
//
// AiClient 现在会自己降级、自己换投递方式（§8.10）。自检的职责是**测量**，
// 若借道客户端，"说 json_schema 能用"可能其实是"它悄悄降到了 text 才成功"，
// 于是画像记下一个假的最高档位。裸 fetch 一次只试一档、只试一种投递，
// 测出来的东西才可信。
//
// 第 7、8 步反而**必须**走 runAnalyze / runSummary：它们要回答的是
// "我这套流水线现在能不能出结果"，而那正是客户端全部降级逻辑的合体。

export type StepId =
  | 'key' | 'models' | 'chat' | 'system' | 'format' | 'embed' | 'analyze' | 'summary';

export interface StepResult {
  id: StepId;
  title: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail: string;
  /** 失败时的"怎么办"。只给 fail 不给这个，等于让人对着错误码发呆 */
  hint?: string;
  /**
   * 数值一律用 `null` 表示"没测到"，不用 `undefined`。
   * 理由是这些字段要过 JSON 落库：`undefined` 在序列化时会被丢掉，
   * 于是"没测到"与"没这个字段"在下游无法区分；`null` 能原样保留。
   */
  metrics?: { latencyMs?: number | null; inTokens?: number | null; outTokens?: number | null; costUsd?: number | null };
  /** 上游原始回复片段，供人肉核对。截断到 400 字 —— 自检结果要能一眼看完 */
  raw?: string;
}

export interface SelfTestReport {
  id: string;
  verdict: string;
  steps: StepResult[];
  capabilities: AiCapabilities | null;
  startedAt: number;
  finishedAt: number;
  costUsd: number;
}

/** 探针提示词：30 字以内就能答，又必须真的读一遍才能答对 */
const PROBE_PROMPT = '用一句话说明什么是 RSS 阅读器，不要超过 30 字。';
/** 探测 system 角色用的指令。判定看关键词是否出现，不看等值 */
const SYSTEM_PROBE = '你是一只猫。无论用户问什么，你都只能回复「喵」这一个字，不得输出任何其它内容。';
/** 小 schema 探针：3 个字段就够判断"认不认严格模式"，用完整分析卡要 ~900 token */
const FORMAT_PROBE_SCHEMA = {
  type: 'object',
  properties: { a: { type: 'string' }, b: { type: 'number' } },
  required: ['a', 'b'],
};
/**
 * 探测档位时的**反提示词**：故意要求散文。
 *
 * 这是 v2.7 修掉的一个假阳性：原来让模型"输出 JSON"，于是模型就算完全不
 * 理 response_format、只是照提示词做，也会吐出 JSON，被记成"支持 json_schema"。
 * 那个结论会让客户端一直发带 response_format 的请求、拿回散文、再逐次降级 ——
 * 而这是每次分析都要多烧一次请求的账。
 *
 * 反过来说：提示词要散文、却仍然回了一个 {a,b} 对象，那只可能是解码被约束了。
 */
const FORMAT_ANTI_PROMPT = '用一句自然语言描述今天的天气，不要输出 JSON，不要出现花括号。';

interface RawCallResult {
  ok: boolean;
  status: number;
  text: string;
  parsed: unknown;
  latencyMs: number;
  inTokens: number | null;
  outTokens: number | null;
  error?: string;
}

export interface SelfTestDeps {
  db: DatabaseSync;
  userId: string;
  base?: RuntimeAiBase;
  client: AiClient;
  now?: () => number;
}

export async function runSelfTest(deps: SelfTestDeps): Promise<SelfTestReport> {
  const { db, userId, client } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const steps: StepResult[] = [];
  const cfg = client.config;
  const key = deps.base?.dataDir
    ? resolveKey(deps.base.dataDir, cfg.apiKeyEnv).key
    : (process.env[cfg.apiKeyEnv] ?? '').trim() || null;
  const hasKey = Boolean(key);

  const measured: { models: Record<string, Partial<ModelCapability>>; embed?: AiCapabilities['embed'] } = {
    models: {},
  };

  // ── ① key ──────────────────────────────────────────────────
  steps.push({
    id: 'key',
    title: 'API Key',
    status: hasKey ? 'pass' : 'fail',
    detail: hasKey
      ? `已配置（来源：${deps.base?.dataDir ? 'data/secrets.json 或环境变量' : '环境变量'}）`
      : `没有可用的 key：环境变量 ${cfg.apiKeyEnv} 与 data/secrets.json 都为空`,
    hint: hasKey ? undefined : '在「API Key」卡里填一个，或部署时注入环境变量。不填不影响阅读，只是不出摘要与分类',
  });

  // 没 key 的话后面每一步都会以同一种方式失败，跑它们只是浪费 10 秒并刷屏。
  // 全部标 skip 并说明原因，比八行一模一样的 "no-key" 有用。
  if (!hasKey) {
    const rest: [StepId, string][] = [
      ['models', '模型清单'], ['chat', '对话连通性'], ['system', 'system 角色是否生效'],
      ['format', '结构化输出档位'], ['embed', '向量模型'], ['analyze', '真实分析一篇'],
      ['summary', '真实总结一篇'],
    ];
    for (const [id, title] of rest) {
      steps.push({ id, title, status: 'skip', detail: '没有 key，跳过', hint: '先填 key 再自检' });
    }
    return finish(deps, steps, null, startedAt, now);
  }

  const apiBase = cfg.baseURL.replace(/\/+$/, '');

  // 预算已经停了就一步都别发。
  //
  // 第 2~6 步是裸 fetch，绕过了 AiClient 的闸门（为什么必须绕过见文件头）——
  // 于是"预算已停"时它们仍会照发五个请求。这正是 §5.5 要堵的洞：
  // 用户点一次自检就能在已经停止的账户上继续花钱。第 7/8 步走 runAnalyze /
  // runSummary，闸门会拦住它们，但那会给出三条"失败"，看起来像链路坏了，
  // 而真实原因只是额度用完了 —— 所以这里统一标 skip 并说清楚。
  const budget = budgetState(db, userId, cfg);
  if (budget.level === 'stop') {
    const rest: [StepId, string][] = [
      ['models', '模型清单'], ['chat', '对话连通性'], ['system', 'system 角色是否生效'],
      ['format', '结构化输出档位'], ['embed', '向量模型'], ['analyze', '真实分析一篇'],
      ['summary', '真实总结一篇'],
    ];
    for (const [id, title] of rest) {
      steps.push({
        id, title, status: 'skip',
        detail: `预算已停：${budget.reason}`,
        hint: '提高预算上限、等额度恢复，或换一个 key 之后再自检',
      });
    }
    return finish(deps, steps, null, startedAt, now);
  }

  /** 一次裸请求。只翻译传输层，不做任何降级 —— 自检要的是测量 */
  const raw = async (opts: {
    path: string; body?: unknown; method?: string;
  }): Promise<RawCallResult> => {
    const t0 = now();
    try {
      const resp = await fetch(apiBase + opts.path, {
        method: opts.method ?? (opts.body ? 'POST' : 'GET'),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      const text = await resp.text();
      const latencyMs = now() - t0;
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* 非 JSON 也算测量结果 */ }
      const u = (parsed as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
      return {
        ok: resp.ok, status: resp.status, text, parsed, latencyMs,
        inTokens: u?.prompt_tokens ?? null, outTokens: u?.completion_tokens ?? null,
      };
    } catch (e) {
      return {
        ok: false, status: 0, text: '', parsed: null,
        latencyMs: now() - t0, inTokens: null, outTokens: null,
        error: (e as Error)?.message ?? '网络错误',
      };
    }
  };

  const contentOf = (r: RawCallResult): string => {
    const ch = (r.parsed as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0];
    const c = ch?.message?.content;
    return typeof c === 'string' ? c.trim() : '';
  };

  let cost = 0;

  /**
   * 记一次探针调用的账（§8.7）。
   *
   * 自检是真的花钱的：不记账的话"今日花费"会比账单少一截，而用户正是拿
   * 那个数字判断要不要继续用。purpose 用 `selftest-<步名>` 前缀，
   * 便于在 ai_usage 里单独统计"自检本身花了多少"。
   */
  const addCost = (r: RawCallResult, purpose: StepId | 'selftest') => {
    const c = estimate(cfg.pricing, cfg.models.fast, r.inTokens, r.outTokens);
    cost += c;
    try {
      recordUsage(db, {
        purpose: `selftest-${purpose}`,
        model: cfg.models.fast,
        inTokens: r.inTokens,
        outTokens: r.outTokens,
        costUsd: c,
        latencyMs: r.latencyMs,
        ok: r.ok && r.status !== 0,
        error: r.ok ? undefined : `http-${r.status}${r.error ? `: ${r.error}` : ''}`,
        userId,
      });
    } catch {
      // 记账失败不能连累自检：诊断结果已经拿到了，丢掉它更糟
    }
    return c;
  };

  // ── ② 模型清单 ──────────────────────────────────────────────
  {
    const r = await raw({ path: '/models' });
    const list = (r.parsed as { data?: { id?: string }[] })?.data?.map((m) => m.id).filter(Boolean) ?? [];
    const configured = [...new Set([cfg.models.fast, cfg.models.strong, cfg.models.embed])];
    const missing = configured.filter((m) => list.length > 0 && !list.includes(m));
    // 网关不实现 /models 是常见情况（只兼容 chat/completions），这不算故障
    let status: StepResult['status'] = 'pass';
    let detail = `${list.length} 个模型可用：${list.slice(0, 8).join(', ')}${list.length > 8 ? ' …' : ''}`;
    if (!r.ok) {
      status = 'warn';
      detail = `/models 不可用（HTTP ${r.status || r.error}），无法核对模型名是否拼错`;
    } else if (missing.length > 0) {
      status = 'warn';
      detail = `配置里有 ${missing.length} 个模型不在清单内：${missing.join(', ')}`;
    }
    steps.push({
      id: 'models', title: '模型清单', status, detail,
      hint: status === 'warn'
        ? `清单里只有 ${list.join(', ') || '（空）'}。模型名拼错时唯一的症状是第一次调用 404，所以这里先对一遍`
        : undefined,
      metrics: { latencyMs: r.latencyMs },
      raw: r.text.slice(0, 400),
    });
  }

  // ── ③ 对话连通性 ────────────────────────────────────────────
  {
    const r = await raw({
      path: '/chat/completions',
      body: {
        model: cfg.models.fast,
        messages: [{ role: 'user', content: '只回复 OK 两个字符，不要解释。' }],
        temperature: 0,
        // 64 而不是 1（§8.6b）：推理模型会把 1 个 token 花在思考上，content 为空，
        // 看起来像"模型返回空"，而实际是预算不够写完。
        max_tokens: 64,
      },
    });
    addCost(r, 'chat');
    const text = contentOf(r);
    steps.push({
      id: 'chat', title: '对话连通性',
      status: text !== '' ? 'pass' : 'fail',
      detail: text !== ''
        ? `模型 ${cfg.models.fast} 返回「${text.slice(0, 30)}」`
        : `HTTP ${r.status || r.error}，正文为空`,
      hint: text === ''
        ? (r.status === 401 || r.status === 403 ? 'key 无效或没有权限'
          : r.status === 0 ? '连不上接口地址，检查 baseURL 与网络'
            : '上游返回了 200 但没有正文，可能是推理模型把 token 花在了思考上')
        : undefined,
      metrics: { latencyMs: r.latencyMs, inTokens: r.inTokens, outTokens: r.outTokens },
      raw: r.text.slice(0, 400),
    });
  }

  // ── ④ system 角色是否生效（A/B 对照）────────────────────────
  //
  // 这是整个自检最重要的一步：线上 649 次失败就是这个原因，而它**不报错**。
  // 判定用"指令要求的关键词是否出现"，不看等值 —— 模型可能回"喵！"或"喵喵"。
  {
    const askBody = (messages: { role: string; content: string }[]) => ({
      model: cfg.models.fast,
      messages,
      temperature: 0,
      max_tokens: 64,
    });

    const withSys = await raw({
      path: '/chat/completions',
      body: askBody([
        { role: 'system', content: SYSTEM_PROBE },
        { role: 'user', content: '1+1=?' },
      ]),
    });
    const withUser = await raw({
      path: '/chat/completions',
      body: askBody([{ role: 'user', content: `${SYSTEM_PROBE}\n\n1+1=?` }]),
    });
    addCost(withSys, 'system');
    addCost(withUser, 'system');

    const sysText = contentOf(withSys);
    const userText = contentOf(withUser);
    const userObeyed = userText.includes('喵');

    let status: StepResult['status'];
    let detail: string;
    let hint: string | undefined;
    let cap: ModelCapability['systemRole'];

    if (!userObeyed) {
      // 连"把指令放进 user"都不照做，说明这个模型根本不听指令 ——
      // 那不是 system 的问题，是模型/网关把消息改写了
      status = 'fail';
      cap = 'unknown';
      detail = `把指令放进 user 也没生效（回复「${userText.slice(0, 20)}」），这个模型不跟随指令`;
      hint = '换一个模型。抽到的这个连"只回喵"都不听，它也不会遵守分析的 JSON 契约';
    } else if (sysText.includes('喵')) {
      status = 'pass';
      cap = 'honored';
      detail = 'system 角色生效（指令放 system 与放 user 都照做）';
    } else {
      status = 'fail';
      cap = 'dropped';
      detail = `system 角色被丢弃：同样指令放 system 时回复「${sysText.slice(0, 20)}」，放 user 才回「喵」`;
      hint = '已自动改为单条消息投递（指令与资料合并）。不必手动处理，但要知道这件事：'
        + '所有走 system 的提示词（分析、聚类、简报）在你这个网关上都不会生效';
    }
    if (cap !== 'unknown') measured.models[cfg.models.fast] = { systemRole: cap };

    steps.push({
      id: 'system', title: 'system 角色是否生效', status, detail, hint,
      metrics: { latencyMs: withSys.latencyMs + withUser.latencyMs },
      raw: `system→「${sysText.slice(0, 60)}」 / user→「${userText.slice(0, 60)}」`,
    });
  }

  // ── ⑤ 结构化输出最高可用档 ──────────────────────────────────
  //
  // 一次只试一档，且用裸 fetch：借道客户端的话"说能用"可能其实是它偷偷降级了。
  //
  // 判据是反提示词（见 FORMAT_ANTI_PROMPT 的注释）：
  //   · json_schema 档要求回出 {a,b} 且字段类型对 —— 提示词在要散文，只有
  //     解码被 schema 约束才可能这样，这是"真支持"的证据；
  //   · json_object 档只要求是个 JSON 对象（该档本来就不保证字段）；
  //   · text 档是兜底，不再发请求：前两档都没过，就说明 response_format
  //     确实被忽略，客户端改用"提示词描述字段 + 归一化"这条路。
  {
    const modes: { mode: 'json_schema' | 'json_object'; rf: unknown }[] = [
      {
        mode: 'json_schema',
        rf: { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema: FORMAT_PROBE_SCHEMA } },
      },
      { mode: 'json_object', rf: { type: 'json_object' } },
    ];
    let best: 'json_schema' | 'json_object' | 'text' | null = null;
    const timeline: string[] = [];
    // 两档探针都真的拿到了 2xx 正文，才允许下"两档都被忽略"的结论。
    // 少了这个判断，401/503/超时的空正文会被判成 cap='text' 并覆盖上次
    // 测出的 json_schema —— 那违反"只覆盖本次真测到的字段"（§5.1）。
    let usableProbes = 0;

    for (const m of modes) {
      const r = await raw({
        path: '/chat/completions',
        body: {
          model: cfg.models.fast,
          messages: [
            // 反提示词也放两份：system 被丢的网关上，只放 system 等于没要求，
            // 而这一档恰恰要靠"要求了散文"来反证 schema 被遵守。
            { role: 'system', content: FORMAT_ANTI_PROMPT },
            { role: 'user', content: FORMAT_ANTI_PROMPT },
          ],
          temperature: 0,
          max_tokens: 200,
          response_format: m.rf,
        },
      });
      addCost(r, 'format');
      const text = contentOf(r);
      // 探针本身失败（非 2xx / 没正文）说明"这一档没测到"，不是"这一档不行"。
      const measuredOk = r.ok && r.status !== 0 && text !== '';
      if (measuredOk) usableProbes++;
      let parsed: unknown = null;
      try {
        const t = text.trim();
        const body = t.startsWith('{') ? t : (t.match(/\{[\s\S]*\}/)?.[0] ?? '');
        parsed = JSON.parse(body);
      } catch { parsed = null; }

      const obj = parsed as Record<string, unknown> | null;
      const isObj = Boolean(obj) && typeof obj === 'object';
      // json_schema 档要比 json_object 档更严：字段名与类型都对上，才算
      // "解码被 schema 约束"；只对上"是个对象"可能只是模型顺着习惯吐了 JSON。
      const hit = measuredOk && (m.mode === 'json_schema'
        ? isObj && typeof obj?.a === 'string' && typeof obj?.b === 'number'
        : isObj);
      const why = !measuredOk
        ? `unmeasured(HTTP ${r.status || r.error || '?'})`
        : `no(${text.slice(0, 16).replace(/\n/g, ' ')})`;
      timeline.push(`${m.mode}=${hit ? 'ok' : why}`);
      if (hit) { best = m.mode; break; }
    }

    // 两档都没过**且都测到了** = response_format 被忽略，降纯文本兜底。
    // 兜底档不需要再发一次请求去证明"纯文本能用" —— 上面两次调用本身就是
    // 纯文本往返，正文已经看到了。
    const cap: ModelCapability['responseFormat'] | null = best
      ?? (usableProbes === modes.length ? 'text' : null);
    if (cap === 'text') timeline.push('text=fallback（两档 response_format 都被忽略）');
    if (cap === null) timeline.push('档位未测出（探针请求本身失败，不写画像）');

    // 只有严格档算 pass：另外两档都要靠提示词与归一化兜，属于"能用但不最可靠"，
    // 面板上给黄点比给绿点诚实（§8.10 的能力画像本来就是让用户知道降级了什么）。
    const status: StepResult['status'] = cap === 'json_schema' ? 'pass' : cap === null ? 'fail' : 'warn';
    const detail = cap === 'json_schema'
      ? '支持严格模式（json_schema），结构化输出最可靠'
      : cap === 'json_object'
        ? '只支持 json_object：能保证是 JSON，但不保证字段，靠归一化兜'
        : cap === 'text'
          ? '两档 response_format 都被忽略，已降级为纯文本 + 提示词描述字段'
          : '两档探针都没拿到 2xx 正文，无法判断档位（上一次的结论保持不变）';
    if (cap !== null) {
      measured.models[cfg.models.fast] = { ...(measured.models[cfg.models.fast] ?? {}), responseFormat: cap };
    }

    steps.push({
      id: 'format', title: '结构化输出档位', status, detail,
      hint: cap === null
        ? '先修连通性：探针请求没通，档位判断不出来。修好后重跑自检'
        : cap === 'text'
          ? '不需要手动处理：客户端已按纯文本档工作（提示词写清字段 + 归一化补全）。'
            + '代价是个别回答要点不齐时会多一次重试'
          : cap === 'json_object'
            ? '不需要处理：客户端已按这个档位工作。但要知道它会多一次校验重试的概率'
            : undefined,
      raw: timeline.join(' → '),
    });
  }

  // ── ⑥ 向量模型 ──────────────────────────────────────────────
  {
    const r = await raw({ path: '/embeddings', body: { model: cfg.models.embed, input: '你好' } });
    const vec = (r.parsed as { data?: { embedding?: number[] }[] })?.data?.[0]?.embedding;
    const dim = Array.isArray(vec) ? vec.length : null;
    measured.embed = { model: cfg.models.embed, ok: Boolean(dim), dim };
    steps.push({
      id: 'embed', title: '向量模型',
      status: dim ? 'pass' : 'warn',
      detail: dim
        ? `${cfg.models.embed} 返回 ${dim} 维向量`
        : `${cfg.models.embed} 不可用（HTTP ${r.status || r.error}）`,
      // 向量是可选增强（§8.6）：语义聚类与检索用它，缺了会退到字面指纹，
      // 所以是 warn 不是 fail —— 主链仍然可用。
      hint: dim ? undefined
        : '不影响分析与总结。语义聚类与相似检索会退化为字面指纹；'
          + '若网关没有 embedding 端点，把「向量模型」留空即可',
      metrics: { latencyMs: r.latencyMs, inTokens: r.inTokens },
      raw: r.text.slice(0, 200),
    });
  }

  // ── ⑦⑧ 真实分析 + 真实总结 ─────────────────────────────────
  //
  // 这两步必须走 runAnalyze / runSummary：它们要回答"我这套流水线现在能不能
  // 出结果"，而那是客户端全部降级逻辑的合体。
  //
  // 选条目优先挑**还没有分析结果**的（规格 §5.5）：这样即使失败也不会抹掉
  // 一份已有的好结果。
  //
  // 进门时查过一次预算，但那之后第 2~6 步又花了几百 token。刚好在这次自检里
  // 跨过月预算线的话，这条路会花掉最贵的一步（约 $0.002）—— 所以再查一次。
  const budgetNow = budgetState(db, userId, cfg);
  const entry = budgetNow.level === 'stop' ? null : pickProbeEntry(db, userId);
  if (budgetNow.level === 'stop') {
    const why = `预算已停：${budgetNow.reason}`;
    steps.push({
      id: 'analyze', title: '真实分析一篇', status: 'skip', detail: why,
      hint: '提高预算上限或等额度恢复后重跑',
    });
    steps.push({ id: 'summary', title: '真实总结一篇', status: 'skip', detail: why });
  } else if (!entry) {
    const why = '库里没有可用于测试的条目（正文非空、300~3000 字的条目为 0）';
    steps.push({ id: 'analyze', title: '真实分析一篇', status: 'skip', detail: why, hint: '先订阅一个源并抓几篇回来' });
    steps.push({ id: 'summary', title: '真实总结一篇', status: 'skip', detail: why });
  } else {
    const a = await runAnalyze(db, client, entry.id, { force: true, now: now() });
    const aOk = a.ok && !a.skipped;
    cost += a.usage?.costUsd ?? 0;
    steps.push({
      id: 'analyze', title: '真实分析一篇',
      status: aOk ? 'pass' : 'fail',
      detail: aOk
        ? `《${entry.title.slice(0, 30)}》产出分类 ${a.categorySlug ?? '（未识别）'}`
        : `失败：${a.failure?.kind ?? '未知'} —— ${a.failure?.message?.slice(0, 120) ?? ''}`,
      hint: aOk ? undefined
        : a.failure?.kind === 'budget' ? '今日预算已用完，明天恢复；或在「每日预算」里调高'
          : '这条失败与自检无关，是分析本身出不来。上面的 system / format 两步的结论通常就是原因',
      metrics: {
        latencyMs: a.usage?.latencyMs, inTokens: a.usage?.inTokens,
        outTokens: a.usage?.outTokens, costUsd: a.usage?.costUsd,
      },
    });

    const rawCfg = readPromptTemplate(db, userId);
    const s = await runSummary(db, client, entry.id, userId, rawCfg, { force: true, now: now() });
    const sOk = s.ok && Boolean(s.body);
    cost += s.usage?.costUsd ?? 0;
    steps.push({
      id: 'summary', title: '真实总结一篇',
      status: sOk ? 'pass' : 'fail',
      detail: sOk ? `产出 ${s.body!.length} 字 Markdown` : `失败：${s.failure?.kind} —— ${s.failure?.message?.slice(0, 120)}`,
      hint: sOk ? undefined : '总结走的是另一条提示词（可编辑），失败原因可能与分析不同，看 raw 里的上游回复',
      raw: s.body ? s.body.slice(0, 400) : undefined,
    });
  }

  return finish(deps, steps, measured, startedAt, now, cost);
}

/**
 * 挑一篇用于测试的条目。
 *
 * 三条筛选，每条都有代价意识：
 *   1. 正文非空且 300~3000 字 —— 太短测不出总结能力，太长白烧 token；
 *   2. **优先没有分析结果的** —— 失败也不抹掉已有的好结果；
 *   3. 同条件取最新。
 */
function pickProbeEntry(
  db: DatabaseSync,
  userId: string,
): { id: string; title: string } | null {
  const rows = db.prepare(`
    SELECT e.id, e.title, c.html
      FROM entries e
      JOIN entry_contents c ON c.entry_id = e.id
      LEFT JOIN entry_analysis a ON a.entry_id = e.id
     WHERE e.user_id = ? AND e.duplicate_of IS NULL
     ORDER BY (a.entry_id IS NULL) DESC, e.fetched_at DESC
     LIMIT 40
  `).all(userId) as { id: string; title: string; html: Uint8Array | null }[];

  for (const r of rows) {
    const text = htmlToText(unpackText(r.html));
    const n = text.trim().length;
    if (n >= 300 && n <= 3000) return { id: r.id, title: r.title };
  }
  return null;
}

/** 用户当前的总结提示词（自检要用用户真实的那一份，不是默认值） */
function readPromptTemplate(db: DatabaseSync, userId: string): string {
  const row = db.prepare('SELECT ai_config FROM settings WHERE user_id = ?')
    .get(userId) as { ai_config: string | null } | undefined;
  let raw: Record<string, unknown> = {};
  try { raw = row?.ai_config ? JSON.parse(row.ai_config) : {}; } catch { raw = {}; }
  return summaryPromptState(raw).effective;
}

function finish(
  deps: SelfTestDeps,
  steps: StepResult[],
  measured: { models: Record<string, Partial<ModelCapability>>; embed?: AiCapabilities['embed'] } | null,
  startedAt: number,
  now: () => number,
  cost = 0,
): SelfTestReport {
  const finishedAt = now();

  // 画像：只覆盖本次真正测到的字段（§8.10 约束 3）。
  //
  // 没 key 时 measured 为 null —— 那一次**什么都不写**（落库的 capabilities 为
  // NULL），于是上一次测好的 dropped 不会被抹成 unknown。"最近一条 capabilities
  // IS NOT NULL" 就是读画像的判据，见 capabilities.ts。
  let capabilities: AiCapabilities | null = null;
  if (measured) {
    const prev = readCapabilitiesSafe(deps.db, deps.userId);
    const hasAny = Object.keys(measured.models).length > 0 || measured.embed !== undefined;
    if (hasAny) {
      capabilities = mergeCapabilities(prev, deps.client.config.baseURL, measured, finishedAt);
    } else {
      capabilities = prev;
    }
  }

  const verdict = buildVerdict(steps, capabilities);
  const report: SelfTestReport = {
    id: randomUUID(),
    verdict,
    steps,
    capabilities,
    startedAt,
    finishedAt,
    costUsd: Math.round(cost * 1e6) / 1e6,
  };
  saveRun(deps.db, deps.userId, report);
  return report;
}

function buildVerdict(steps: StepResult[], caps: AiCapabilities | null): string {
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  const fails = steps.filter((s) => s.status === 'fail');
  const warns = steps.filter((s) => s.status === 'warn');
  const dropped = Object.values(caps?.models ?? {}).some((m) => m.systemRole === 'dropped');

  if (byId.key?.status === 'fail') return '没有可用的 API key，自检没跑起来';
  if (byId.system?.status === 'fail' && dropped) {
    return '网关丢弃 system 消息 —— 已自动改为单条投递，分析与简报仍能出结果，但提示词里的角色设定不会生效';
  }
  if (byId.analyze?.status === 'pass' && byId.summary?.status === 'pass' && fails.length === 0) {
    return warns.length > 0
      ? `链路可用，但有 ${warns.length} 项降级（${warns.map((w) => w.title).join('、')}）`
      : '全部通过：分析、总结、向量与结构化输出都正常';
  }
  if (byId.analyze?.status === 'pass' || byId.summary?.status === 'pass') {
    return `部分可用：${fails.map((f) => f.title).join('、') || '无硬失败'} —— 详见各步`;
  }
  return `不通：${fails.map((f) => f.title).join('、') || '未知原因'}`;
}

function readCapabilitiesSafe(db: DatabaseSync, userId: string): AiCapabilities | null {
  // 与 capabilities.ts 的 readCapabilities 同一判据（跳过 NULL 行）。
  // 这里不直接 import 它，是为了避免 capabilities.ts ← selftest.ts 的循环引用：
  // capabilities.ts 被 client.ts 依赖，而 selftest 又依赖 client。
  try {
    const row = db.prepare(`
      SELECT capabilities FROM ai_selftest_runs
       WHERE user_id = ? AND capabilities IS NOT NULL
       ORDER BY started_at DESC LIMIT 1
    `).get(userId) as { capabilities: string | null } | undefined;
    if (!row?.capabilities) return null;
    const v = JSON.parse(row.capabilities) as AiCapabilities;
    return v && typeof v.baseURL === 'string' ? v : null;
  } catch {
    return null;
  }
}

function saveRun(db: DatabaseSync, userId: string, r: SelfTestReport): void {
  db.prepare(`
    INSERT INTO ai_selftest_runs
      (id, user_id, started_at, finished_at, base_url, model, verdict, steps, capabilities, cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    r.id, userId, r.startedAt, r.finishedAt,
    r.capabilities?.baseURL ?? '', r.capabilities ? Object.keys(r.capabilities.models)[0] ?? '' : '',
    r.verdict, JSON.stringify(r.steps),
    r.capabilities ? JSON.stringify(r.capabilities) : null, r.costUsd,
  );

  // 保留最近 20 次：用户要"便于查看"，但历史无限增长没有消费方。
  // 20 次足够回答"改了什么之后变好了"，再多的行只是磁盘。
  db.prepare(`
    DELETE FROM ai_selftest_runs
     WHERE user_id = ? AND id NOT IN (
       SELECT id FROM ai_selftest_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 20
     )
  `).run(userId, userId);
}

/** 最近一次自检（不含 steps 以外的东西），没有则 null */
export function readLatestRun(db: DatabaseSync, userId: string): SelfTestReport | null {
  const row = db.prepare(`
    SELECT id, started_at, finished_at, verdict, steps, capabilities, cost_usd
      FROM ai_selftest_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 1
  `).get(userId) as {
    id: string; started_at: number; finished_at: number | null; verdict: string | null;
    steps: string; capabilities: string | null; cost_usd: number;
  } | undefined;
  if (!row) return null;
  try {
    return {
      id: row.id,
      verdict: row.verdict ?? '',
      steps: JSON.parse(row.steps) as StepResult[],
      capabilities: row.capabilities ? JSON.parse(row.capabilities) as AiCapabilities : null,
      startedAt: Number(row.started_at),
      finishedAt: Number(row.finished_at ?? row.started_at),
      costUsd: Number(row.cost_usd ?? 0),
    };
  } catch {
    return null;
  }
}

function estimate(
  pricing: Record<string, { in: number; out: number }>,
  model: string,
  inTok: number | null,
  outTok: number | null,
): number {
  const p = pricing[model] ?? pricing.default ?? { in: 0, out: 0 };
  return ((inTok ?? 0) / 1e6) * p.in + ((outTok ?? 0) / 1e6) * p.out;
}
