import type { z } from 'zod';
import { toJsonSchema, describeSchema } from './schema.ts';

// OpenAI 兼容协议的单一适配层（PLAN §8.1 / §8.6）。
//
// 为什么不用 openai SDK：本项目只需要两个端点（/chat/completions 与
// /embeddings），请求体是普通 JSON。SDK 会带进几十个传递依赖、它自己的
// 重试与超时策略，以及一个要在 SEA 打包里额外照顾的环境探测分支。
// 一个 fetch 加一个 zod schema 就够，且失败点只剩下面这几处。

// ── 配置 ──────────────────────────────────────────────────────

export interface PricingEntry {
  /** 美元 / 百万输入 token */
  in: number;
  /** 美元 / 百万输出 token */
  out: number;
}

export interface AiConfig {
  baseURL: string;
  /** 环境变量名。key 本身绝不进 settings / config.json（§8.1） */
  apiKeyEnv: string;
  models: { fast: string; strong: string; embed: string };
  limits: { rpm: number; concurrency: number };
  budget: { dailyUsd: number; monthlyUsd: number };
  fallback: { onBudgetExceeded: 'fast_only' | 'stop' };
  /**
   * 模型 → 单价。`default` 兜底。
   *
   * 这些数字是**示例价目**，不是承诺 —— 服务商随时调价，用户应照自己的
   * 账单核对。留出 default 而不是"未知模型记 0"：记 0 会让预算闸门对着
   * 一个永远花不完的额度形同虚设，那是最坏的一种"看起来有保护"。
   */
  pricing: Record<string, PricingEntry>;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  baseURL: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'AI_API_KEY',
  models: { fast: 'deepseek-chat', strong: 'deepseek-chat', embed: 'text-embedding-3-small' },
  limits: { rpm: 60, concurrency: 2 },
  budget: { dailyUsd: 1.0, monthlyUsd: 20.0 },
  fallback: { onBudgetExceeded: 'fast_only' },
  pricing: {
    'deepseek-chat': { in: 0.27, out: 1.1 },
    'gpt-4o-mini': { in: 0.15, out: 0.6 },
    default: { in: 0.5, out: 1.5 },
  },
  timeoutMs: 60_000,
};

/**
 * 把 settings.ai_config 合进默认值。
 *
 * `apiKey` 刻意**不**接受：key 只从 `apiKeyEnv` 指定的环境变量读。
 * 允许它出现在 settings 里，等于允许把明文 key 写进数据库和备份包 ——
 * 而备份包正是最容易被拷贝出去的东西。
 */
export function resolveAiConfig(raw: unknown): AiConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const models = (src.models ?? {}) as Record<string, string | undefined>;
  const limits = (src.limits ?? {}) as Record<string, number | undefined>;
  const budget = (src.budget ?? {}) as Record<string, number | undefined>;
  const pricing = (src.pricing ?? {}) as Record<string, PricingEntry | undefined>;
  const fallback = (src.fallback ?? {}) as Record<string, string | undefined>;

  return {
    baseURL: str(src.baseURL, DEFAULT_AI_CONFIG.baseURL),
    apiKeyEnv: str(src.apiKeyEnv, DEFAULT_AI_CONFIG.apiKeyEnv),
    models: {
      fast: str(models.fast, DEFAULT_AI_CONFIG.models.fast),
      strong: str(models.strong, DEFAULT_AI_CONFIG.models.strong),
      embed: str(models.embed, DEFAULT_AI_CONFIG.models.embed),
    },
    limits: {
      rpm: num(limits.rpm, DEFAULT_AI_CONFIG.limits.rpm),
      concurrency: num(limits.concurrency, DEFAULT_AI_CONFIG.limits.concurrency),
    },
    budget: {
      dailyUsd: num(budget.dailyUsd, DEFAULT_AI_CONFIG.budget.dailyUsd),
      monthlyUsd: num(budget.monthlyUsd, DEFAULT_AI_CONFIG.budget.monthlyUsd),
    },
    fallback: {
      onBudgetExceeded: fallback.onBudgetExceeded === 'stop' ? 'stop' : 'fast_only',
    },
    pricing: { ...DEFAULT_AI_CONFIG.pricing, ...pricing } as Record<string, PricingEntry>,
    timeoutMs: num(src.timeoutMs, DEFAULT_AI_CONFIG.timeoutMs),
  };
}

function str(v: unknown, def: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v : def;
}
function num(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** 美元。token 缺失按 0 计，未知模型按 default 计（不记 0） */
export function estimateCost(
  pricing: Record<string, PricingEntry>,
  model: string,
  inTokens: number | null | undefined,
  outTokens: number | null | undefined,
): number {
  const p = pricing[model] ?? pricing.default ?? { in: 0, out: 0 };
  const i = Number(inTokens ?? 0) || 0;
  const o = Number(outTokens ?? 0) || 0;
  return (i / 1e6) * p.in + (o / 1e6) * p.out;
}

// ── 失败分类 ──────────────────────────────────────────────────
//
// kind 写进 entries.stage_error 与 ai_usage.error，所以它必须是**诊断信息**
// 而不是"失败了"。用户看到 stage_error='http-401: Invalid API key' 才知道
// 要去改 key；只看到 'failed' 只能来问我们。

export type AiFailureKind =
  | 'no-key'
  | 'network'
  | 'timeout'
  | `http-${number}`
  | 'bad-json'
  | 'schema'
  | 'empty'
  | 'budget'
  | 'dim-mismatch';

export interface AiFailure {
  kind: AiFailureKind;
  message: string;
  /** 交给队列层：true 表示换个时间重试还有意义 */
  retryable: boolean;
  status?: number;
}

export interface AiUsageRecord {
  purpose: string;
  model: string;
  inTokens: number | null;
  outTokens: number | null;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
  userId?: string;
}

export type ChatJsonResult<T> =
  | { ok: true; data: T; raw: string; usage: AiUsageRecord }
  | { ok: false; failure: AiFailure; usage: AiUsageRecord | null };

export interface ChatJsonOptions<S extends z.ZodTypeAny> {
  schema: S;
  system: string;
  user: string;
  model: string;
  /** 写进 ai_usage.purpose：analyze / cluster / digest … */
  purpose: string;
  userId?: string;
  temperature?: number;
  maxTokens?: number;
  /** 只在纯文本降级模式的提示词里用到 */
  signalName?: string;
}

export interface AiClientOptions {
  config: AiConfig;
  /** null = 没配置；传 undefined 则从 config.apiKeyEnv 读环境变量 */
  apiKey?: string | null;
  onUsage?: (u: AiUsageRecord) => void;
  /** 测试注入：不真睡 */
  sleepImpl?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** 传输层最多重试几次（首发 + 2 次重试 = 3 个请求） */
const TRANSPORT_RETRIES = 2;
/** 结构层（JSON / zod 不合规）最多重试几次 —— §8.2 明确只一次 */
const STRUCTURE_RETRIES = 1;

type FormatMode = 'json_schema' | 'json_object' | 'text';

/**
 * 一次调用的结果，含**是否值得重试**。
 *
 * 把"要不要重试"和"错在哪"分开，是因为它们不是同一件事：一个 401 在
 * 传输层完全没必要重试（key 不会自己变对），而一个 429 重试就有用。
 * 早先写在同一个 if 里，结果 401 也走了退避，白等 4 秒才报错。
 */
interface Attempt<T> {
  ok: boolean;
  data?: T;
  raw?: string;
  failure?: AiFailure;
  usage: AiUsageRecord;
  /** 服务端明确拒绝了这个 response_format，可以降级重来 */
  formatRejected?: boolean;
  /** 该换格式再试一次（不算传输重试） */
  retryWithFormat?: FormatMode;
}

export class AiClient {
  readonly config: AiConfig;
  private readonly apiKey: string | null;
  private readonly onUsage?: (u: AiUsageRecord) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  /**
   * 已经确认不支持某种 response_format 的 baseURL+model。
   *
   * 每个实例一份，**不持久化**。理由是服务商会升级：一旦落进配置文件，
   * 升级后用户还得去改一个他看不懂的开关才能恢复严格模式。重启即重试
   * 是更好的默认值。
   */
  private readonly formatUnsupported = new Set<string>();

  /** 最近 60 秒内的请求时间戳，用于 rpm 限流 */
  private callTimes: number[] = [];

  constructor(opts: AiClientOptions) {
    this.config = opts.config;
    this.apiKey = opts.apiKey === undefined
      ? (process.env[opts.config.apiKeyEnv] ?? null)
      : opts.apiKey;
    this.onUsage = opts.onUsage;
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  hasKey(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.trim() !== '';
  }

  /**
   * 调用一次 chat/completions，要求返回符合 schema 的 JSON。
   *
   * 失败时**不抛异常**：调用方（job handler）要按 kind 决定是重试、
   * 是置 failed、还是提示用户去配置。抛异常会让这三件事都退化成
   * "猜 e.message 里有没有 401"。
   */
  async chatJson<S extends z.ZodTypeAny>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
    if (!this.hasKey()) {
      return {
        ok: false,
        usage: null,
        failure: {
          kind: 'no-key',
          message: `没有配置 API key：环境变量 ${this.config.apiKeyEnv} 为空`,
          retryable: false,
        },
      };
    }

    let mode = this.initialFormat(opts.model);
    let structureAttempts = 0;
    let feedback: string | null = null;

    // 循环的上界要算清楚：每个 format 模式最多试 1 + TRANSPORT_RETRIES 次，
    // 格式降级最多 2 次（schema → object → text），结构重试 1 次。
    // 用 for(;;) 而不是 for 是因为退出的四个条件分属不同层。
    for (;;) {
      // 显式标注：attempt 的返回类型引用了 S，而 att 又参与决定
      // 本函数的返回类型，不标注就是自引用推断（TS7022）。
      const att: Attempt<z.infer<S>> = await this.attempt(opts, mode, feedback);

      if (att.ok) return { ok: true, data: att.data as z.infer<S>, raw: att.raw ?? '', usage: att.usage };

      const failure: AiFailure = att.failure ?? { kind: 'network', message: '未知失败', retryable: true };

      // ① 格式被拒：降级重来（不消耗结构重试次数）
      if (att.retryWithFormat) {
        this.formatUnsupported.add(this.formatKey(opts.model, mode));
        mode = att.retryWithFormat;
        continue;
      }

      // ② 结构不合规：把 issues 回灌，重试一次
      if (failure.kind === 'schema' || failure.kind === 'bad-json') {
        if (structureAttempts < STRUCTURE_RETRIES) {
          structureAttempts++;
          feedback = failure.message;
          continue;
        }
        // 二次失败：schema 错重跑也只是再错一次，交给人工
        return { ok: false, usage: att.usage, failure: { ...failure, retryable: false } };
      }

      // ③ 其余失败：按 kind 的 retryable 交给队列
      return { ok: false, usage: att.usage, failure };
    }
  }

  /** 初始格式：已确知不支持就跳过严格模式，少撞一次墙 */
  private initialFormat(model: string): FormatMode {
    if (this.formatUnsupported.has(this.formatKey(model, 'json_schema'))) {
      if (this.formatUnsupported.has(this.formatKey(model, 'json_object'))) return 'text';
      return 'json_object';
    }
    return 'json_schema';
  }

  private formatKey(model: string, mode: FormatMode): string {
    return `${this.config.baseURL}|${model}|${mode}`;
  }

  /**
   * 单次尝试，含传输层重试。
   *
   * 传输重试放在这里而不是外层：外层还要处理"降级"和"结构重试"，
   * 三类重试混在一个循环里，任何一个计数器写错都会变成无限循环或
   * 悄悄不重试。
   */
  private async attempt<S extends z.ZodTypeAny>(
    opts: ChatJsonOptions<S>,
    mode: FormatMode,
    feedback: string | null,
  ): Promise<Attempt<z.infer<S>>> {
    let last: Attempt<z.infer<S>> | null = null;

    for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt++) {
      const res = await this.once(opts, mode, feedback);

      if (res.ok) {
        const parsed = this.parseAndValidate(opts.schema, res.raw ?? '');
        const usage: AiUsageRecord = {
          purpose: opts.purpose, model: opts.model, userId: opts.userId,
          inTokens: res.inTokens ?? null, outTokens: res.outTokens ?? null,
          costUsd: estimateCost(this.config.pricing, opts.model, res.inTokens, res.outTokens),
          latencyMs: res.latencyMs, ok: parsed.ok,
          error: parsed.ok ? undefined : `${parsed.failure.kind}: ${parsed.failure.message}`,
        };
        this.record(usage);

        if (parsed.ok) {
          return { ok: true, data: parsed.data, raw: res.raw, usage };
        }
        // 结构错不在这里重试 —— 它要的是回灌 issues，而不是原样再问一遍
        return { ok: false, failure: parsed.failure, usage };
      }

      const failure = res.failure!;
      const usage: AiUsageRecord = {
        purpose: opts.purpose, model: opts.model, userId: opts.userId,
        inTokens: res.inTokens ?? null, outTokens: res.outTokens ?? null,
        costUsd: estimateCost(this.config.pricing, opts.model, res.inTokens, res.outTokens),
        latencyMs: res.latencyMs, ok: false,
        error: `${failure.kind}: ${failure.message}`,
      };
      this.record(usage);
      last = { ok: false, failure, usage, retryWithFormat: res.retryWithFormat };

      // 格式被拒是"换个参数就行"，不是"过一会儿再来"，所以立刻返回
      if (res.retryWithFormat) return last;
      if (!failure.retryable) return last;

      // 最后一次不再睡
      if (attempt < TRANSPORT_RETRIES) {
        await this.sleep(this.backoffMs(attempt, res.retryAfterMs));
      }
    }

    return last!;
  }

  /** 1s、3s；服务端给了 Retry-After 就听它的（封顶 60s） */
  private backoffMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 60_000);
    return attempt === 0 ? 1000 : 3000;
  }

  /**
   * rpm 限流。
   *
   * 用"最近 60 秒的调用时间戳"而不是令牌桶：配额是**每分钟 N 次**这种
   * 硬指标，滑动窗口能精确守住它；令牌桶按速率上限发令牌，在窗口边界
   * 仍可能连发 2N 次从而吃 429。多占几百字节内存换一个不被封的确定性。
   */
  private async waitForRateLimit(): Promise<void> {
    const rpm = this.config.limits.rpm;
    if (!rpm || rpm <= 0) return;
    for (;;) {
      const now = this.now();
      this.callTimes = this.callTimes.filter((t) => now - t < 60_000);
      if (this.callTimes.length < rpm) {
        this.callTimes.push(now);
        return;
      }
      // 等到最早那一次滑出窗口
      const waitMs = 60_000 - (now - this.callTimes[0]!) + 5;
      await this.sleep(waitMs);
    }
  }

  /** 真正的一次 HTTP 请求。只翻译传输层与状态码，不碰 schema */
  private async once<S extends z.ZodTypeAny>(
    opts: ChatJsonOptions<S>,
    mode: FormatMode,
    feedback: string | null,
  ): Promise<{
    ok: boolean;
    raw?: string;
    inTokens?: number | null;
    outTokens?: number | null;
    latencyMs: number;
    failure?: AiFailure;
    retryWithFormat?: FormatMode;
    retryAfterMs?: number;
  }> {
    await this.waitForRateLimit();

    const body: Record<string, unknown> = {
      model: opts.model,
      messages: buildMessages(opts, mode, feedback),
      temperature: opts.temperature ?? 0.2,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    };
    if (mode !== 'text') {
      body.response_format = mode === 'json_schema'
        ? {
            type: 'json_schema',
            json_schema: {
              name: opts.signalName ?? 'result',
              schema: toJsonSchema(opts.schema),
              strict: true,
            },
          }
        : { type: 'json_object' };
    }

    const url = `${this.config.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const t0 = this.now();

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      const latencyMs = this.now() - t0;
      const isTimeout = /abort|timeout/i.test((e as Error)?.name ?? '') || /timeout/i.test((e as Error)?.message ?? '');
      return {
        ok: false, latencyMs,
        failure: isTimeout
          ? { kind: 'timeout', message: `请求超过 ${this.config.timeoutMs}ms 未返回`, retryable: true }
          : { kind: 'network', message: (e as Error)?.message ?? '网络请求失败', retryable: true },
      };
    }

    const latencyMs = this.now() - t0;

    if (!resp.ok) {
      const text = await safeText(resp);
      const status = resp.status;
      const retryable = status === 429 || status >= 500;
      // 400/422 里明确提到 response_format → 是"这个参数不支持"，可以降级
      const fmt = status < 500 && /response_format|response format|json_schema|schema/i.test(text)
        ? nextFormat(mode)
        : undefined;
      return {
        ok: false, latencyMs,
        failure: {
          kind: `http-${status}` as AiFailureKind,
          message: `HTTP ${status}: ${text.slice(0, 300)}`,
          retryable: fmt ? false : retryable,
          status,
        },
        retryWithFormat: fmt,
        retryAfterMs: parseRetryAfter(resp.headers.get('retry-after')),
      };
    }

    let json: Record<string, unknown>;
    try {
      json = (await resp.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, latencyMs, failure: { kind: 'bad-json', message: '响应体不是 JSON', retryable: true } };
    }

    const choices = (json.choices ?? []) as { message?: { content?: unknown } }[];
    const content = choices[0]?.message?.content;
    const usage = (json.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };

    if (typeof content !== 'string' || content.trim() === '') {
      // 空内容不是网络问题，原样重发大概率还是空；记为可重试但只一次
      return {
        ok: false, latencyMs,
        inTokens: usage.prompt_tokens ?? null, outTokens: usage.completion_tokens ?? null,
        failure: { kind: 'empty', message: '模型返回空内容', retryable: false },
      };
    }

    return {
      ok: true, raw: content, latencyMs,
      inTokens: usage.prompt_tokens ?? null,
      outTokens: usage.completion_tokens ?? null,
    };
  }

  /** 文本 → JSON → zod。三层失败给出不同的 kind */
  private parseAndValidate<S extends z.ZodTypeAny>(
    schema: S,
    raw: string,
  ): { ok: true; data: z.infer<S> } | { ok: false; failure: AiFailure } {
    const jsonText = extractJson(raw);
    if (jsonText === null) {
      return {
        ok: false,
        failure: {
          kind: 'bad-json',
          message: `没有从回复里找到 JSON。原文前 200 字：${raw.slice(0, 200)}`,
          retryable: true,
        },
      };
    }

    let value: unknown;
    try {
      value = JSON.parse(jsonText);
    } catch (e) {
      return {
        ok: false,
        failure: {
          kind: 'bad-json',
          message: `JSON 解析失败（${(e as Error).message}）。原文前 200 字：${raw.slice(0, 200)}`,
          retryable: true,
        },
      };
    }

    const r = schema.safeParse(value);
    if (!r.success) {
      // issues 拼成「字段: 原因」。模型能看懂字段名，看不懂 zodError 对象
      const msg = r.error.issues
        .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
        .join('; ');
      return { ok: false, failure: { kind: 'schema', message: `字段不合规 —— ${msg}`, retryable: true } };
    }
    return { ok: true, data: r.data as z.infer<S> };
  }

  private record(u: AiUsageRecord): void {
    try { this.onUsage?.(u); } catch { /* 记账失败不能连累分析 */ }
  }

  // ── Embedding ─────────────────────────────────────────────
  //
  // 与 chatJson 分成两个方法而不是加个 mode 开关：两者除了都要发 HTTP，
  // 没有任何共同点（没有 messages、没有 schema、没有结构重试）。
  // 合在一起会让"重试策略"出现两套互相干扰的分支。

  async embed(input: string, model?: string): Promise<
    { ok: true; vec: Float32Array; dim: number; usage: AiUsageRecord }
    | { ok: false; failure: AiFailure; usage: AiUsageRecord | null }
  > {
    if (!this.hasKey()) {
      return {
        ok: false, usage: null,
        failure: {
          kind: 'no-key',
          message: `没有配置 API key：环境变量 ${this.config.apiKeyEnv} 为空`,
          retryable: false,
        },
      };
    }

    const m = model ?? this.config.models.embed;
    const url = `${this.config.baseURL.replace(/\/+$/, '')}/embeddings`;
    const t0 = this.now();

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: m, input }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      const isTimeout = /abort|timeout/i.test((e as Error)?.name ?? '');
      return {
        ok: false, usage: null,
        failure: isTimeout
          ? { kind: 'timeout', message: `embedding 请求超时（${this.config.timeoutMs}ms）`, retryable: true }
          : { kind: 'network', message: (e as Error)?.message ?? '网络请求失败', retryable: true },
      };
    }

    const latencyMs = this.now() - t0;
    if (!resp.ok) {
      const text = await safeText(resp);
      return {
        ok: false, usage: null,
        failure: {
          kind: `http-${resp.status}` as AiFailureKind,
          message: `HTTP ${resp.status}: ${text.slice(0, 300)}`,
          retryable: resp.status === 429 || resp.status >= 500,
          status: resp.status,
        },
      };
    }

    const json = (await resp.json()) as {
      data?: { embedding?: number[] }[];
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    const arr = json.data?.[0]?.embedding;
    if (!Array.isArray(arr) || arr.length === 0) {
      return {
        ok: false, usage: null,
        failure: { kind: 'bad-json', message: 'embedding 响应里没有 data[0].embedding', retryable: false },
      };
    }

    const usage: AiUsageRecord = {
      purpose: 'embed', model: m,
      inTokens: json.usage?.prompt_tokens ?? null, outTokens: null,
      costUsd: 0, latencyMs, ok: true,
    };
    this.record(usage);
    return { ok: true, vec: Float32Array.from(arr), dim: arr.length, usage };
  }
}

function nextFormat(mode: FormatMode): FormatMode | undefined {
  if (mode === 'json_schema') return 'json_object';
  if (mode === 'json_object') return 'text';
  return undefined;
}

function buildMessages<S extends z.ZodTypeAny>(
  opts: ChatJsonOptions<S>,
  mode: FormatMode,
  feedback: string | null,
): { role: string; content: string }[] {
  const parts = [opts.system];

  // 纯文本降级时 schema 只在这个提示词里存在，必须写全
  if (mode === 'text') {
    parts.push(
      '\n\n输出要求：只输出一个 JSON 对象，不要解释文字、不要 Markdown 围栏。字段如下：\n'
      + describeSchema(opts.schema),
    );
  }

  if (feedback) {
    parts.push(
      '\n\n上一次的输出没有通过校验，请只针对下面这些问题修正后重新输出完整 JSON：\n'
      + feedback,
    );
  }

  return [
    { role: 'system', content: parts.join('') },
    { role: 'user', content: opts.user },
  ];
}

/**
 * 从模型回复里取出 JSON 文本。
 *
 * 顺序是「先剥围栏，再截首尾大括号」。反过来会出错：围栏里可能带解释，
 * 而截大括号对"```json 开头、``` 结尾"的回复正好能切干净。两个都试，
 * 都不成才判失败 —— 小模型三种形态都会出现。
 */
export function extractJson(raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;

  // ① 整段就是 JSON
  if (t.startsWith('{') && t.endsWith('}')) {
    if (tryParse(t)) return t;
  }

  // ② ``` 围栏（语言标记可有可无）
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(t);
  if (fence && fence[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith('{') && tryParse(inner)) return inner;
  }

  // ③ 首个 { 到最后一个 }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = t.slice(first, last + 1);
    if (tryParse(slice)) return slice;
  }

  return null;
}

function tryParse(s: string): boolean {
  try { JSON.parse(s); return true; } catch { return false; }
}

async function safeText(resp: Response): Promise<string> {
  try { return await resp.text(); } catch { return ''; }
}

/**
 * Retry-After 有秒数与 HTTP 日期两种写法。
 * 解析不了就不给值 —— 上层退化成默认退避，比瞎猜一个数好。
 */
export function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(v);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}
