import { z } from 'zod';

// AI 结构化输出的 schema（PLAN §8.2）。
//
// 为什么单独一个文件：它同时被三处使用 ——
//   · AiClient（转成 JSON Schema 塞进 response_format / 提示词）
//   · analyze 流水线（校验模型输出）
//   · 验收脚本（直接 import 断言"缺字段会被拒"）
// 放在 client.ts 里，验收脚本为了测一个 schema 就得先把整个 HTTP 客户端
// 拖起来。

/**
 * 单篇分析。字段与 §8.2 一一对应。
 *
 * `.strip()` 是 zod 的默认行为，这里显式写出来是因为它是**刻意的**：
 * 模型经常多吐一个 `confidence` 或 `tags`，为此让整条分析失败是不划算的 ——
 * 多出来的字段丢掉即可，缺字段才是真问题。验收脚本对这一点有断言，
 * 免得将来有人把 `.strict()` 当成"更严谨"加上去。
 */
export const RawEntryAnalysisSchema = z
  .object({
    summary: z.string().min(10, '摘要太短（至少要一句话）'),
    key_points: z
      .array(z.string().min(1))
      .min(2, '要点至少 2 条，信息不足时给出原文里的事实而不是省略')
      .max(6, '要点最多 6 条'),
    category: z.string().min(1),
    topics: z.array(z.string().min(1)).max(5),
    entities: z.object({
      people: z.array(z.string()),
      orgs: z.array(z.string()),
      products: z.array(z.string()),
      tech: z.array(z.string()),
    }),
    importance: z.number().int().min(0).max(100),
    novelty: z.number().int().min(0).max(100),
    sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed']),
  })
  .strip();

export type EntryAnalysis = z.infer<typeof RawEntryAnalysisSchema>;

/**
 * 把模型吐出来的东西归一成 schema 认得的形状（PLAN §8.10，v2.7）。
 *
 * 原则是**归一化之后再校验**，而不是放宽校验。区别很重要：放宽（`optional`、
 * `unknown`）会让"字段彻底没出来"变成"字段是空的"，下游看不出区别；
 * 归一化只是把**同一件事的不同写法**对齐，缺得离谱的仍然报错。
 *
 * 每一条都对应线上实测到的一种偏差，不是预防性设计：
 *
 *   entities  模型给 `["AMD","World Labs"]`（数组）而不是四桶对象 —— 实测 100 次。
 *             塞进 `tech` 是有意的：**没有任何界面元素读 entities**（grep 过），
 *             四个桶里 `tech` 最泛，混进去无害；而为此把整篇判死是亏的。
 *   key_points 给 7 条（提示词写的是 6 条）—— 实测 94 次。截断，不报错。
 *   topics     同上，超 5 个截断。
 *   sentiment  干脆不给 —— 无消费方，兜底 neutral。
 *   novelty    不给 —— 用 importance 的水平分，总比缺失强。
 *   importance/novelty 越界 —— 夹取。分级只看 importance，越界会让 tier 算错。
 *
 * **刻意不做**：从中文散文里正则抠字段（`分类：**tech**`）。那会让"模型没按契约
 * 回答"变得不可见，而 v2.7 定位根因正是靠"它返回了散文"这条线索。
 */
export function normalizeEntryAnalysis(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };

  // entities：数组 → 四桶对象；缺失 → 四桶空
  const ENTITY_BUCKETS = ['people', 'orgs', 'products', 'tech'] as const;
  const entities = src.entities;
  if (Array.isArray(entities)) {
    out.entities = {
      people: [], orgs: [], products: [],
      tech: entities.filter((x): x is string => typeof x === 'string' && x.trim() !== ''),
    };
  } else if (!entities || typeof entities !== 'object') {
    out.entities = { people: [], orgs: [], products: [], tech: [] };
  } else {
    const e = entities as Record<string, unknown>;
    out.entities = Object.fromEntries(
      ENTITY_BUCKETS.map((k) => [k, Array.isArray(e[k]) ? e[k] : []]),
    );
  }

  // 超限截断。下限不动 —— "少于 2 条要点"仍然是真问题（模型没读正文）
  for (const [key, max] of [['key_points', 6], ['topics', 5]] as const) {
    const v = src[key];
    if (Array.isArray(v)) out[key] = v.slice(0, max);
  }

  // sentiment 兜底：枚举外的写法（"中性"、"Neutral"）不该让整篇失败
  const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'];
  if (typeof src.sentiment !== 'string' || !SENTIMENTS.includes(src.sentiment)) {
    const raw = typeof src.sentiment === 'string' ? src.sentiment.toLowerCase() : '';
    out.sentiment = SENTIMENTS.includes(raw) ? raw : 'neutral';
  }

  // 数值夹取；字符串数字也认（模型常写 "78"）
  const clamp = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
    if (!Number.isFinite(n)) return undefined;
    return Math.max(0, Math.min(100, Math.round(n)));
  };
  const importance = clamp(src.importance);
  if (importance !== undefined) out.importance = importance;
  const novelty = clamp(src.novelty);
  out.novelty = novelty ?? importance ?? 0;

  return out;
}

/**
 * 归一化 + 校验，一次搞定 —— 三处调用（analyze、验收脚本、将来的批量重跑）
 * 都必须走这一个出口，否则"某条路径忘了归一化"会表现成"这篇莫名失败"。
 *
 * 所以**导出的就是这一个**：`RawEntryAnalysisSchema` 只在文件内可见，
 * 外面拿到的 `EntryAnalysisSchema` 一定是归一化过的。名字保持不变是为了
 * 让所有既有调用点（含 m2-01 / m2-09 的断言）自动获得归一化，而不用逐处改 ——
 * 逐处改必然漏一处，而漏掉的那处正是将来出事的那条路径。
 */
export const EntryAnalysisSchema = z.preprocess(
  normalizeEntryAnalysis,
  RawEntryAnalysisSchema,
);

/** 簇级归纳（§9.2）。2.3 之后才用，先定义好让 schema 集中在一处 */
export const ClusterSummarySchema = z
  .object({
    title: z.string().min(2).max(40),
    summary: z.string().min(10),
    key_points: z.array(z.string()).min(1).max(6),
    consensus: z.array(z.string()),
    conflicts: z.array(z.object({ claim: z.string(), sources: z.array(z.string()) })),
  })
  .strip();

export type ClusterSummary = z.infer<typeof ClusterSummarySchema>;

/** 简报生成（§9.3）。正文里的 {{cite:id}} 由程序替换，模型不许自己写 URL */
export const DigestBodySchema = z
  .object({
    title: z.string().min(2),
    highlights: z.array(z.string()).min(1).max(5),
    body_md: z.string().min(20),
    worth_reading: z.array(z.string()).max(3),
  })
  .strip();

export type DigestBody = z.infer<typeof DigestBodySchema>;

/**
 * 把 zod schema 描述成人能读的字段清单（塞进纯文本降级模式的提示词）。
 *
 * 为什么不用 zod-to-json-schema 之类的库：只需要一层扁平说明，
 * 而那个库为了正确性会引入一整套 $ref/$defs 展开逻辑（约 30KB），
 * 而纯文本降级恰恰是"服务商什么都不支持"的场景，写给模型看的
 * 一段话比一份 JSON Schema 更好用。
 */
export function describeSchema(schema: z.ZodTypeAny, indent = ''): string {
  const out: string[] = [];
  const def = unwrapWrappers(schema)._def as { typeName?: string; shape?: () => Record<string, z.ZodTypeAny> };
  if (def.typeName === 'ZodObject' && def.shape) {
    for (const [k, v] of Object.entries(def.shape())) {
      out.push(`${indent}- ${k}: ${describeType(v)}`);
    }
  }
  return out.join('\n');
}

/**
 * 剥掉"包一层"的 schema 包装，拿到真正描述字段形状的那层。
 *
 * 为什么需要：`EntryAnalysisSchema` 是 `z.preprocess(...)`，zod 把它表示成
 * `ZodEffects`（`_def.typeName === 'ZodEffects'`，里层在 `_def.schema`）。
 * 下面两个描述函数原本只认 `ZodObject`，遇到 `ZodEffects` 会走 default 分支，
 * 于是 json_schema 档发出的 schema 是 `{}`、纯文本档的字段清单是空串 —— 两种
 * 降级档**同时**失去字段约束，而单测因为 mock 不看 schema 完全发现不了。
 * 归一化是校验阶段的事，跟"字段长什么样"无关，所以描述时应该看里层。
 */
function unwrapWrappers(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur = schema;
  for (let i = 0; i < 5; i += 1) {
    const d = cur._def as { typeName?: string; schema?: z.ZodTypeAny; out?: z.ZodTypeAny };
    if (d.typeName === 'ZodEffects' && d.schema) { cur = d.schema; continue; }
    if (d.typeName === 'ZodPipeline' && d.out) { cur = d.out; continue; }
    break;
  }
  return cur;
}

/**
 * zod → JSON Schema（只覆盖本项目用到的子集）。
 *
 * 为什么不用 `zod-to-json-schema`：它要正确处理 $ref/$defs/oneOf/allOf，
 * 代码量约 30KB，而这里只有 object/array/string/number/enum/optional 六种。
 * 多一个包就多一份要在 SEA 打包里验证的东西，而 §3 的目标是依赖尽量少。
 *
 * 注意 **不生成 `additionalProperties: false`**：strict 模式下 OpenAI 要求
 * 每个 object 都写全 `required` 且不许有额外字段，而模型经常多吐一个
 * `confidence`。带着 strict 联调时那会被判成"输出不合规"从而白白重试 ——
 * 这里把多余字段留给 zod 的 `.strip()` 处理，比让服务端拒收便宜。
 */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const d = unwrapWrappers(schema)._def as {
    typeName?: string; type?: z.ZodTypeAny; innerType?: z.ZodTypeAny;
    values?: string[]; shape?: () => Record<string, z.ZodTypeAny>;
    checks?: { kind: string; value?: number }[];
  };
  switch (d.typeName) {
    case 'ZodString': return { type: 'string' };
    case 'ZodNumber': return { type: 'number' };
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodEnum': return { type: 'string', enum: d.values ?? [] };
    case 'ZodArray': {
      const min = d.checks?.find((c) => c.kind === 'min');
      const max = d.checks?.find((c) => c.kind === 'max');
      return {
        type: 'array',
        items: d.type ? toJsonSchema(d.type) : {},
        ...(min?.value !== undefined ? { minItems: min.value } : {}),
        ...(max?.value !== undefined ? { maxItems: max.value } : {}),
      };
    }
    case 'ZodObject': {
      const props: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(d.shape?.() ?? {})) {
        props[k] = toJsonSchema(v);
        if ((v._def as { typeName?: string }).typeName !== 'ZodOptional') required.push(k);
      }
      return { type: 'object', properties: props, required };
    }
    case 'ZodOptional': return d.innerType ? toJsonSchema(d.innerType) : {};
    default: return {};
  }
}

function describeType(v: z.ZodTypeAny): string {
  const d = v._def as {
    typeName?: string; type?: z.ZodTypeAny; innerType?: z.ZodTypeAny;
    values?: string[]; checks?: { kind: string; value?: number }[];
    minLength?: { value: number }; maxLength?: { value: number };
  };
  switch (d.typeName) {
    case 'ZodString': return '字符串';
    case 'ZodNumber': return '数字';
    case 'ZodBoolean': return '布尔';
    case 'ZodEnum': return `枚举，取值之一：${(d.values ?? []).join(' | ')}`;
    case 'ZodArray': return `数组，元素为 ${d.type ? describeType(d.type) : '任意'}`;
    case 'ZodObject': {
      const inner = describeSchema(v, '  ');
      return `对象 {\n${inner}\n  }`;
    }
    case 'ZodOptional': return `${d.innerType ? describeType(d.innerType) : '任意'}（可选）`;
    default: return '任意';
  }
}

/**
 * 单条高亮解读（§11.4 / M4）。4.4 起使用。
 *
 * insight 上限 400 字：`INSIGHT_SYSTEM` 要求 1~3 句、不超过 120 字，
 * 400 是给模型留的余量。min(1) 拦的是空字符串 —— 空解读落库会让前端
 * 渲染出一个空白气泡，用户以为功能坏了。
 */
export const HighlightInsightSchema = z
  .object({
    insight: z.string().min(1).max(400),
  })
  .strip();

export type HighlightInsight = z.infer<typeof HighlightInsightSchema>;
