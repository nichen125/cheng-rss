import type { DatabaseSync } from 'node:sqlite';
import { AiClient, resolveAiConfig, type AiConfig } from './client.ts';
import { recordUsage } from './usage.ts';
import { budgetGuard, budgetState, type BudgetState } from './budget.ts';
import { keyFingerprint, maskKey, resolveKey, type KeySource } from './secrets.ts';
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
  /**
   * 数据目录。**v2.0 起必须传**：key 现在可能来自 `data/secrets.json`（§8.8），
   * 而 secrets 是按数据目录放的。不传的后果是"界面上填了 key 但不生效"，
   * 而那种症状与缓存问题几乎无法区分。
   */
  dataDir?: string;
}

export function runtimeAiBase(cfg: RuntimeConfig): RuntimeAiBase {
  return {
    baseURL: cfg.ai.baseURL,
    apiKeyEnv: cfg.ai.apiKeyEnv,
    models: cfg.ai.models,
    budget: cfg.ai.budget,
    dataDir: cfg.dataDir,
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
  /** 有没有可用的 key（文件或环境变量）—— UI 要据此提示"去配 key" */
  hasKey: boolean;
  /** key 从哪来（§8.8）：界面上填的文件 / 部署期环境变量 / 都没有 */
  keySource: KeySource;
  /** 掩码后的 key，供设置页显示"当前用的是哪个"。绝不回显完整 key */
  keyMasked: string | null;
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

  // key 的解析放在这里而不是各调用点（§8.8）：调用点有六处，
  // 任何一处自己决定"从哪儿读 key"就会有一条路径读不到界面上填的那个。
  const resolved = base?.dataDir
    ? resolveKey(base.dataDir, config.apiKeyEnv)
    : { key: (process.env[config.apiKeyEnv] ?? '').trim() || null, source: 'env' as KeySource };

  // 缓存键必须含 key 的指纹：用户在界面上换了 key、但 baseURL 与模型都没动时，
  // 不含指纹的缓存会继续用旧客户端，症状是"换了 key 还是 401"。
  const key = `${userId}|${JSON.stringify(config)}|${keyFingerprint(resolved.key)}`;

  let client = cache.get(key);
  if (!client) {
    client = new AiClient({
      config,
      // 显式传 key（而不是让它自己读环境变量）：这样文件里的 key 才生效，
      // 且"文件优先于环境变量"这条规则只有一个实现点（secrets.ts）。
      apiKey: resolved.key,
      onUsage: (u) => {
        try {
          recordUsage(db, { ...u, userId });
        } catch {
          // 记账失败不能连累分析：分析结果已经拿到了，丢掉它更糟
        }
      },
      // 预算闸门（2.5）。放在这里而不是各调用点：调用点有三处
      // （job handler / 手动重跑接口 / M3 的简报），任何一处漏挂闸门
      // 就是"那条路径可以无限花钱"。
      guard: budgetGuard(db, userId, config),
    });
    cache.set(key, client);
    // 同一用户的旧配置条目可以清掉，避免设置页反复改导致缓存无限增长
    for (const k of cache.keys()) {
      if (k !== key && k.startsWith(`${userId}|`)) cache.delete(k);
    }
  }

  return {
    client, config,
    hasKey: client.hasKey(),
    keySource: resolved.key ? resolved.source : 'none',
    keyMasked: maskKey(resolved.key),
    source,
  };
}

/**
 * 该用户当前的预算状态。UI 与 /stats 读它。
 *
 * 每次重新算而不读缓存 —— 与 guard 的理由相同：它是闸门的依据，
 * 缓 60 秒就等于允许超支 60 秒。
 */
export function aiBudgetFor(
  db: DatabaseSync,
  userId: string,
  base?: RuntimeAiBase,
): BudgetState {
  const config = composeAiConfig(base, readAiConfigRaw(db, userId));
  return budgetState(db, userId, config);
}

/** 测试与「换了 key 想立刻生效」的出口 */
export function resetAiCache(): void {
  cache.clear();
}
