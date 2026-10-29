// 分析提示词（PLAN §8.3）。
//
// 与代码分开的理由：提示词会被反复改（每改一次就是一个 prompt_version），
// 而 §8.3 的硬性要求需要逐条对照验收。混在调用逻辑里，改一个标点都要
// 在滚屏里找准位置，也没法在验收脚本里单独断言"这段约束存在"。
//
// v2（M4）：user 消息在正文前多了一段可选的高亮 few-shot（§11.4）。
// 版本号跟着动 —— 黄金测试集回归靠它区分"模型变了"与"提示词变了"，
// 否则一次 prompt 改动会被误读成模型退化。

/**
 * 提示词版本。每次改动提示词都必须改这里 ——
 * entry_analysis.prompt_version 记的就是它，黄金测试集的回归靠它区分
 * "是模型变了还是提示词变了"。
 */
export const PROMPT_VERSION = 'analyze-v2';

export const ANALYZE_SYSTEM = `你是一名信息分析编辑。把一篇资讯压缩成结构化情报卡片。

硬性要求：
1. summary 用陈述句直接给结论与数据；禁止"本文/该文章/作者认为"等空话开头。
2. key_points 每条须含具体事实（数字、名称、时间、结论），不写泛泛判断。
3. 原文未提及的一律不得推断补充。信息不足时相应字段留空数组而非编造。
4. category 必须从「可选分类」中选一个 slug；无法归类选 other。
5. topics 优先复用「已有标签」；确无合适才新建，最多 5 个。
6. importance 评分基准：
   90+ 行业格局变化 / 重大技术发布 / 直接影响读者工作
   70~89 有明确新信息与分析价值
   40~69 常规更新、有参考价值的经验
   0~39 营销稿、转述、无增量
7. 只输出 JSON，不要解释文字或 Markdown 围栏。`;

export interface CategoryHint {
  slug: string;
  name: string;
  hint?: string | null;
}

export interface AnalyzePromptInput {
  title: string;
  siteName?: string | null;
  author?: string | null;
  /** 已是纯文本 */
  body: string;
  categories: CategoryHint[];
  /** 库里已有的主题标签，用于「优先复用」 */
  knownTopics?: string[];
  /**
   * 高亮 few-shot 段（§11.4「修正 importance」）。
   *
   * 由 `highlights/insight.ts` 的 `buildFewshotBlock()` 生成 —— 那段逻辑
   * 要查库（近期高亮 + 当时的 importance），不该混进这个纯函数。
   * 空串或不传 = 不注入。
   */
  fewshot?: string;
}

/**
 * 喂给模型的输入截断长度。
 *
 * §8.5 定的 4000 字是"标题 + 摘要 + 前 4000 字"。取正文前 4000 字
 * 而不是"摘要 + 前 4000 字"：正文第 1 段通常就包含结论，而很多 feed
 * 根本没有 excerpt。
 */
export const BODY_CLIP = 4000;

/**
 * 拼 user 消息。
 *
 * 分类清单必须带 hint：§8.4 说「填好 hint 能显著提升一致率」，
 * 只给 slug 列表时模型只能靠名字猜（"photo"到底指摄影器材还是影像技术）。
 */
export function buildAnalyzeUser(input: AnalyzePromptInput): string {
  const cats = input.categories
    .map((c) => (c.hint ? `- ${c.slug}（${c.name}）：${c.hint}` : `- ${c.slug}（${c.name}）`))
    .join('\n');

  const topics = (input.knownTopics ?? []).slice(0, 200);
  const topicLine = topics.length > 0
    ? `\n\n已有标签（能复用就复用，不要造近义词）：${topics.join('、')}`
    : '';

  const meta = [
    input.siteName ? `来源：${input.siteName}` : '',
    input.author ? `作者：${input.author}` : '',
  ].filter(Boolean).join('  ');

  const body = input.body.length > BODY_CLIP
    ? input.body.slice(0, BODY_CLIP) + '\n\n（正文已截断）'
    : input.body;

  return `标题：${input.title}
${meta ? meta + '\n' : ''}
可选分类：
${cats}
${topicLine}${input.fewshot ?? ''}

正文：
${body}`;
}
