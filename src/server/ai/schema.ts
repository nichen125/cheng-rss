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
export const EntryAnalysisSchema = z
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

export type EntryAnalysis = z.infer<typeof EntryAnalysisSchema>;

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
  const def = schema._def as { typeName?: string; shape?: () => Record<string, z.ZodTypeAny> };
  if (def.typeName === 'ZodObject' && def.shape) {
    for (const [k, v] of Object.entries(def.shape())) {
      out.push(`${indent}- ${k}: ${describeType(v)}`);
    }
  }
  return out.join('\n');
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
  const d = schema._def as {
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
