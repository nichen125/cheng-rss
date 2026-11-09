import type { DatabaseSync } from 'node:sqlite';

// 能力画像（PLAN §8.10，v2.7 / 步骤 2.9）。
//
// 为什么要单独一份数据：网关之间的差异不是"好"与"坏"，而是**能力集不同**。
// 实测的这台中转会把 `system` 消息**静默丢掉**（指令根本没到模型手上），
// 也会把 `response_format` 当没看见（200 返回散文）。这两件事都不报错，
// 所以只能靠"试出来 + 记住"。
//
// 三条设计约束，每条都有代价：
//
//   1. **库里的画像只由自检写入，运行时不写库。**
//      运行时学到的东西只记在 AiClient 实例内（与 §8.6 的 formatUnsupported
//      同形）。允许调用路径写库就有两条写入路径，而两条必然漂移 ——
//      屏幕上写"网关丢 system"而客户端还在用 split，这种矛盾最难查。
//   2. **按模型分开存。**
//      fast 与 strong 常是两个模型（本项目默认就是），共用一份必然对不上；
//      而"画像没命中"的症状是**静默退回**到每次多花一次失败的钱，看不出来。
//   3. **只覆盖本次真正测到的字段。**
//      自检因为没 key 而没跑成 system 那一步时，不能把上次的 dropped 抹成
//      unknown —— 否则"上次好好的，这次怎么又不行了"会重演。

/** 单个模型的两种能力。`unknown` 不是"没有"，是"还没测过" */
export interface ModelCapability {
  /** `system` 角色里的内容能不能到模型手上 */
  systemRole: 'honored' | 'dropped' | 'unknown';
  /** 上游真正认的最高结构化档位 */
  responseFormat: 'json_schema' | 'json_object' | 'text' | 'unknown';
}

export interface AiCapabilities {
  /** 画像只对同一网关有效。换 baseURL 必然失效 */
  baseURL: string;
  /** 模型名 → 能力。缺项视为 unknown */
  models: Record<string, ModelCapability>;
  /** 向量模型与 chat 模型是两套，不按 chat 模型分 */
  embed: { model: string; ok: boolean; dim: number | null } | null;
  checkedAt: number;
}

const UNKNOWN: ModelCapability = { systemRole: 'unknown', responseFormat: 'unknown' };

/**
 * 取某个模型的能力。
 *
 * baseURL 必须精确匹配：换网关后旧画像毫无意义，而"用着上一个网关的结论"
 * 比"没有结论"更糟 —— 后者会自愈，前者会一直用错的投递方式。
 */
export function capabilityFor(
  caps: AiCapabilities | null | undefined,
  baseURL: string,
  model: string,
): ModelCapability {
  if (!caps) return UNKNOWN;
  if (normalizeBase(caps.baseURL) !== normalizeBase(baseURL)) return UNKNOWN;
  return caps.models?.[model] ?? UNKNOWN;
}

/**
 * 合并新旧画像：**只覆盖本次真正测到的字段**（约束 3）。
 *
 * `measured` 里为 undefined 的字段保留 `prev` 的值；两者都没有才是 unknown。
 * 这里的"undefined"必须与"测出来是 unknown"区分开 —— 前者是"没测"，
 * 后者是"测了但测不出来"（例如没 key 导致该步被跳过）。
 */
export function mergeCapabilities(
  prev: AiCapabilities | null,
  baseURL: string,
  measured: { models?: Record<string, Partial<ModelCapability>>; embed?: AiCapabilities['embed'] },
  now: number,
): AiCapabilities {
  const sameGateway = prev && normalizeBase(prev.baseURL) === normalizeBase(baseURL);
  const base = sameGateway ? prev! : { baseURL, models: {}, embed: null, checkedAt: now };

  const models: Record<string, ModelCapability> = { ...base.models };
  for (const [model, patch] of Object.entries(measured.models ?? {})) {
    const old = models[model] ?? UNKNOWN;
    models[model] = {
      systemRole: patch.systemRole ?? old.systemRole,
      responseFormat: patch.responseFormat ?? old.responseFormat,
    };
  }

  return {
    baseURL,
    models,
    embed: measured.embed ?? base.embed ?? null,
    checkedAt: now,
  };
}

/** 去掉尾部斜杠与大小写差异：`https://A/v1/` 与 `https://a/v1` 是同一个网关 */
function normalizeBase(u: string): string {
  return String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * 读取某用户最近一次**真正测到能力**的自检画像。
 *
 * `capabilities IS NOT NULL` 这个条件是关键：没 key 的那次自检只跑完第一步，
 * 它落库的 capabilities 是 NULL。若不加这个条件，读到的就是那行 NULL，
 * 于是"昨天测出的 dropped"被一份半截结果盖掉，用户看到"今天又不行了"
 * 而实际上什么都没变。NULL 在这里的语义是"这次没测"，不是"测出来是未知"。
 *
 * 没有行、JSON 坏了、结构不对都返回 null —— 上层据此走"未知即自愈"。
 * 这个函数刻意不抛：画像坏了不该让整条分析链路起不来。
 */
export function readCapabilities(db: DatabaseSync, userId: string): AiCapabilities | null {
  const row = db.prepare(`
    SELECT capabilities FROM ai_selftest_runs
     WHERE user_id = ? AND capabilities IS NOT NULL
     ORDER BY started_at DESC LIMIT 1
  `).get(userId) as { capabilities: string | null } | undefined;
  if (!row?.capabilities) return null;
  try {
    const v = JSON.parse(row.capabilities) as AiCapabilities;
    if (!v || typeof v !== 'object' || typeof v.baseURL !== 'string') return null;
    return { ...v, models: v.models ?? {}, embed: v.embed ?? null };
  } catch {
    return null;
  }
}
