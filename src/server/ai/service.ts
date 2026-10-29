import type { DatabaseSync } from 'node:sqlite';
import { AiClient, resolveAiConfig, type AiConfig } from './client.ts';
import { recordUsage } from './usage.ts';
import type { RuntimeConfig } from '../config.ts';

// 每用户的 AI 客户端装配（PLAN §8.1）。
//
// 配置来源有**三层**，优先级从低到高：
//   1. DEFAULT_AI_CONFIG（内置）
//   2. config.json / 环境变量（部署期决定，`AI_BASE_URL` 在这里）
//   3. settings.ai_config（用户在设置页改的，运行时）
//
// 三层是必须的，不是重复：
//   · 第 1 层保证空配置也能跑
//   · 第 2 层是"这个部署连的是哪个网关"—— 运维/Docker 用环境变量注入，
//     不可能去让用户在 UI 里再填一遍
//   · 第 3 层是单用户日常微调（换模型、改预算）
// 早先只实现了第 1 与第 3 层，症状是：设了 AI_BASE_URL 却仍然打到默认
// 服务商（验收脚本用 mock 时表现为"请求不知去向、401"）。第 2 层必须在
// 这里合进来，而不是让调用方自己 resolve —— 调用方有三处（job handler、
// 手动重跑接口、将来 M3 的简报），任何一处漏掉就是同样的 bug 再来一次。

/** config.json / 环境变量里的 AI 段（RuntimeConfig.ai 的子集） */
export interface RuntimeAiBase {
  baseURL?: string;
  apiKeyEnv?: string;
  models?: { fast?: string; strong?: string; embed?: string };
  budget?: { dailyUsd?: number; monthlyUsd?: number };
}

export function runtimeAiBase(cfg: RuntimeConfig): RuntimeAiBase {
  return {
    baseURL: cfg.ai.baseURL,
    apiKeyEnv: cfg.ai.apiKeyEnv,
    models: cfg.ai.models,
    budget: cfg.ai.budget,
  };
}

/**
 * 把三层合成一份最终配置，并返回"哪一层赢了这个字段"的说明。
 *
 * 合并顺序（后者覆盖前者）：内置 → 部署期 → 用户设置。
 * 用展开运算符合并而不是逐字段 ??：逐字段会漏掉将来新增的字段，
 * 而漏掉的表现是"设置页里改了但不生效"，很难与缓存问题区分。
 */
export function composeAiConfig(
  base: RuntimeAiBase | undefined,
  userSettings: unknown,
): AiConfig {
  const deployed = resolveAiConfig({
    baseURL: base?.baseURL,
    apiKeyEnv: base?.apiKeyEnv,
    models: base?.models,
    budget: base?.budget,
  });

  // 用户设置只覆盖它**真的写了**的字段。
  //
  // 不能直接 {...deployed, ...raw}：resolveAiConfig 对空字符串也走兜底，
  // 而它兜的底是 DEFAULT_AI_CONFIG（deepseek），不是 deployed。于是设置页
  // 里一个清空的输入框会把部署期配好的 baseURL 悄悄打回默认服务商。
  const raw = (userSettings && typeof userSettings === 'object' ? userSettings : {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    baseURL: deployed.baseURL,
    apiKeyEnv: deployed.apiKeyEnv,
    models: { ...deployed.models },
    limits: { ...deployed.limits },
    budget: { ...deployed.budget },
    fallback: { ...deployed.fallback },
    pricing: { ...deployed.pricing },
    timeoutMs: deployed.timeoutMs,
  };

  // 标量字段：undefined/null/空串都当作"没写"
  const put = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === '') return;
    merged[k] = v;
  };
  put('baseURL', raw.baseURL);
  put('apiKeyEnv', raw.apiKeyEnv);
  put('timeoutMs', raw.timeoutMs);

  const rawModels = (raw.models ?? {}) as Record<string, unknown>;
  const rawLimits = (raw.limits ?? {}) as Record<string, unknown>;
  const rawBudget = (raw.budget ?? {}) as Record<string, unknown>;
  const rawPricing = (raw.pricing ?? {}) as Record<string, unknown>;
  const rawFallback = (raw.fallback ?? {}) as Record<string, unknown>;

  const models = merged.models as Record<string, string>;
  for (const k of ['fast', 'strong', 'embed']) {
    const v = rawModels[k];
    if (typeof v === 'string' && v.trim() !== '') models[k] = v;
  }
  const limits = merged.limits as Record<string, number>;
  for (const k of ['rpm', 'concurrency']) {
    const v = Number(rawLimits[k]);
    if (Number.isFinite(v) && v >= 0 && rawLimits[k] !== undefined) limits[k] = v;
  }
  const budget = merged.budget as Record<string, number>;
  for (const k of ['dailyUsd', 'monthlyUsd']) {
    const v = Number(rawBudget[k]);
    if (Number.isFinite(v) && v >= 0 && rawBudget[k] !== undefined) budget[k] = v;
  }
  Object.assign(merged.pricing as Record<string, unknown>, rawPricing);
  const fb = rawFallback.onBudgetExceeded;
  if (fb === 'stop' || fb === 'fast_only') {
    (merged.fallback as { onBudgetExceeded: string }).onBudgetExceeded = fb;
  }

  return resolveAiConfig(merged);
}

const cache = new Map<string, AiClient>();

/** 读用户 settings.ai_config（JSON 字符串）。不存在或坏了都回空对象 */
export function readAiConfigRaw(db: DatabaseSync, userId: string): Record<string, unknown> {
  const row = db.prepare('SELECT ai_config FROM settings WHERE user_id = ?')
    .get(userId) as { ai_config: string } | undefined;
  if (!row?.ai_config) return {};
  try {
    const v = JSON.parse(row.ai_config);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface AiForUser {
  client: AiClient;
  config: AiConfig;
  /** 环境变量里到底有没有 key —— UI 要据此提示"去配 key" */
  hasKey: boolean;
  /** 配置来自哪一层，供 /stats 与设置页显示（"我现在到底连的是哪儿"） */
  source: 'settings' | 'deployed';
}

export function aiForUser(
  db: DatabaseSync,
  userId: string,
  base?: RuntimeAiBase,
): AiForUser {
  const raw = readAiConfigRaw(db, userId);
  const config = composeAiConfig(base, raw);
  const source: AiForUser['source'] = Object.keys(raw).length > 0 ? 'settings' : 'deployed';
  const key = `${userId}|${JSON.stringify(config)}`;

  let client = cache.get(key);
  if (!client) {
    client = new AiClient({
      config,
      // apiKey 传 undefined = 从 config.apiKeyEnv 指定的环境变量读。
      // 这里绝不能从 settings 里取 —— 那会把明文 key 写进数据库与备份。
      onUsage: (u) => {
        try {
          recordUsage(db, { ...u, userId });
        } catch {
          // 记账失败不能连累分析：分析结果已经拿到了，丢掉它更糟
        }
      },
    });
    cache.set(key, client);
    // 同一用户的旧配置条目可以清掉，避免设置页反复改导致缓存无限增长
    for (const k of cache.keys()) {
      if (k !== key && k.startsWith(`${userId}|`)) cache.delete(k);
    }
  }

  return { client, config, hasKey: client.hasKey(), source };
}

/** 测试与「换了 key 想立刻生效」的出口 */
export function resetAiCache(): void {
  cache.clear();
}
