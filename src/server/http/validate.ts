import type { Context } from 'hono';
import type { z } from 'zod';
import { badRequest } from '../errors.ts';

// 入站请求校验。
//
// `await c.req.json() as { starred?: boolean }` 只是类型断言，运行时什么都不检查：
// 传 `{"starred":"yes"}` 会被当成布尔值一路带到 SQL 参数绑定。这里用 zod 在
// 边界上真正解析一次，失败就转成 400 —— 错误体沿用 AppError，前端拿到的形状不变。
//
// 只处理入站方向：响应体形状由各 handler 自己组装，不在此校验。
// 查询参数不做包装 —— 各处的 `Number(q) || 默认值` 形状并不重复，
// 统一起来只是把 `||` 换成另一层间接，不划算。

/** 一次最多报几条问题。字段一多 zod 能吐十几条，原样糊给用户等于没说。 */
const MAX_ISSUES = 3;

/** zod 的英文默认提示里没有中文；schema 里手写的中文提示则要原样透出。 */
function hasCjk(s: string): boolean {
  return /[\u4e00-\u9fff]/.test(s);
}

/**
 * 把 path 拼成 `ids[0].title` 这种能顺着找的形状。
 * 数组下标用方括号，否则 `ids.0` 会被读成一个名叫 "0" 的字段。
 */
function pathLabel(path: (string | number)[]): string {
  return path
    .map((seg, i) => (typeof seg === 'number' ? `[${seg}]` : i === 0 ? seg : `.${seg}`))
    .join('');
}

/** `字段 ids 至少 1 项` / `请求体需要 object` —— 有字段名才需要那个空格。 */
function say(field: string, predicate: string): string {
  return field ? `字段 ${field} ${predicate}` : `请求体${predicate}`;
}

/** 一条 issue → 一句人话。只在 schema 没给中文提示时走这里。 */
function describeIssue(issue: z.ZodIssue): string {
  const field = pathLabel(issue.path);

  switch (issue.code) {
    case 'invalid_type':
      // 「缺字段」和「类型错」在用户眼里是两件事，别都报成类型不对。
      if (issue.received === 'undefined') return field ? `缺少字段 ${field}` : '缺少请求体';
      return say(field, `需要 ${issue.expected}`);
    case 'too_small':
      if (issue.type === 'array') return say(field, `至少 ${issue.minimum} 项`);
      if (issue.type === 'string') return say(field, `至少 ${issue.minimum} 个字符`);
      return say(field, `不能小于 ${issue.minimum}`);
    case 'too_big':
      if (issue.type === 'array') return say(field, `最多 ${issue.maximum} 项`);
      if (issue.type === 'string') return say(field, `最多 ${issue.maximum} 个字符`);
      return say(field, `不能大于 ${issue.maximum}`);
    case 'invalid_enum_value':
      return say(field, `只能是 ${issue.options.join('、')}`);
    case 'invalid_literal':
      return say(field, `只能是 ${JSON.stringify(issue.expected)}`);
    case 'unrecognized_keys':
      return say(field, `里有不认识的字段：${issue.keys.join('、')}`);
    case 'invalid_string':
      return say(field, '格式不合法');
    case 'invalid_union':
      return say(field, '不符合允许的形状');
    default:
      return issue.message;
  }
}

/**
 * 把 ZodError 压成一句人话：`字段 starred 需要 boolean`，多条用 `；` 连接。
 *
 * 超过 MAX_ISSUES 时只留前几条并给出总数 —— 用户一次改不完十个字段，
 * 逐条罗列只会把真正那一处淹掉。
 */
export function formatIssues(err: z.ZodError): string {
  const shown = err.issues.slice(0, MAX_ISSUES).map((issue) => {
    // 手写的中文提示（`.min(1, 'ids 不能为空')` 之类）比通用措辞更准。
    return hasCjk(issue.message) ? issue.message : describeIssue(issue);
  });
  // 同一个数组里两个元素错法相同时，zod 会给出两条一样的文案（path 不同、
  // 提示相同）。重复一遍只是噪音 —— 用户要改的是"元素类型"，不是第几个。
  const unique = [...new Set(shown)];
  const rest = err.issues.length - shown.length;
  return rest > 0 ? `${unique.join('；')}（另有 ${rest} 处问题）` : unique.join('；');
}

/**
 * 读并校验 JSON 请求体。
 *
 * 解析失败（空 body、语法错）当作 `{}` —— 与原先 `.catch(() => ({}))` 一致，
 * 让 schema 统一给出「缺少字段 xxx」，而不是把 JSON 语法细节暴露给调用方。
 *
 * 成功时返回 schema 的输出：`.optional()` 的键缺省时不会出现，
 * 所以 `'color' in body` 这类「键是否存在」的判断语义保持不变。
 */
export async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badRequest(formatIssues(parsed.error));
  return parsed.data;
}
