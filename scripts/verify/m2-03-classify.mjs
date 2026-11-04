#!/usr/bin/env node
// 2.3 受控分类 + tier —— 验收
//
// 判据（PLAN §19.4 2.3 + §8.4）：
//   ① slug 不在列表 → 判 other（不是 NULL，不是原样存下）
//   ② tier 边界正确：39/40/69/70/89/90 六个数逐个断言
//   ③ 分类是**受控**的：模型自造 slug 不会在库里长出新的分类行
//   ④ 大小写 / 空格 / 中文名的容错：模型回 "Tech" 或 "  tech " 应归到 tech
//   ⑤ 英文近义词不算自造：模型回 "technology" 这类**没有**对应分类时归 other，
//      而不是靠模糊匹配猜一个 —— 猜错的代价比 other 高（§21 标签越用越乱）
//   ⑥ 每类都有 hint（§8.4：填好 hint 能显著提升一致率）
//   ⑦ 分类清单进提示词，且带 hint
//
// ② 的验法是本项目最容易假绿的地方之一，所以单独说明：
// 六个数里如果只测 40/70/90，实现写成 `>=` 还是 `>` 完全测不出来 ——
// 90 分在两种写法下都是 must_read。必须成对测 89/90 这一对。
import { group, check, eq, ok, gt, summary } from './harness.mjs';

// ── A. 纯函数层 ─────────────────────────────────────────────
const {
  tierForImportance, TIER_BOUNDS, normalizeCategorySlug,
} = await import('../../src/server/ai/classify.ts');
const { DEFAULT_CATEGORIES, FALLBACK_SLUG } = await import('../../src/server/ai/taxonomy.ts');
const { buildAnalyzeUser } = await import('../../src/server/ai/prompt.ts');

group('2.3 受控分类 · tier 边界');

// 期望值写死而不是调实现算 —— 用实现算期望值等于没测
const BOUNDARY_CASES = [
  [0, 'noise'], [1, 'noise'], [39, 'noise'],
  [40, 'normal'], [41, 'normal'], [69, 'normal'],
  [70, 'worth'], [71, 'worth'], [89, 'worth'],
  [90, 'must_read'], [91, 'must_read'], [100, 'must_read'],
];
for (const [v, want] of BOUNDARY_CASES) {
  check(`importance=${v} → ${want}`, () => eq(tierForImportance(v), want));
}
check('边界常量本身就是 40/70/90（改常量必须同步改断言）', () => ok(
  TIER_BOUNDS.normal === 40 && TIER_BOUNDS.worth === 70 && TIER_BOUNDS.mustRead === 90,
  JSON.stringify(TIER_BOUNDS),
));

// 越界与非法值不能崩，也不能悄悄升到高级别
check('越界值（-5 / 101 / 999）夹到最近档而不是崩', () => ok(
  tierForImportance(-5) === 'noise'
  && tierForImportance(101) === 'must_read'
  && tierForImportance(999) === 'must_read',
  `${tierForImportance(-5)} ${tierForImportance(101)} ${tierForImportance(999)}`,
));
check('NaN 判 noise 而不是 must_read（坏数据不能拿到最高优先）', () =>
  eq(tierForImportance(Number.NaN), 'noise'));
check('小数按向下取整比较：89.9 仍是 worth（不是 must_read）', () => ok(
  tierForImportance(89.9) === 'worth' && tierForImportance(90.0) === 'must_read',
  `${tierForImportance(89.9)} ${tierForImportance(90)}`,
));

group('2.3 受控分类 · slug 归一');

const SLUGS = DEFAULT_CATEGORIES.map((c) => c.slug);

check('已知 slug 原样保留', () => {
  const bad = SLUGS.filter((s) => normalizeCategorySlug(s, SLUGS) !== s);
  return ok(bad.length === 0, `被改动的: ${JSON.stringify(bad)}`);
});
check('大小写与首尾空格容错："Tech" / "  tech  " → tech', () => ok(
  normalizeCategorySlug('Tech', SLUGS) === 'tech'
  && normalizeCategorySlug('  tech  ', SLUGS) === 'tech',
  `${normalizeCategorySlug('Tech', SLUGS)} / ${normalizeCategorySlug('  tech  ', SLUGS)}`,
));
check('自造的 slug → other', () => {
  const made = ['crypto-bro', 'AI news', '科技资讯', 'gaming', 'xyz'];
  const bad = made.filter((s) => normalizeCategorySlug(s, SLUGS) !== FALLBACK_SLUG);
  return ok(bad.length === 0, `没归到 other 的: ${JSON.stringify(bad)}`);
});
check('英文近义词**不**做模糊匹配（technology ≠ tech），归 other', () =>
  eq(normalizeCategorySlug('technology', SLUGS), FALLBACK_SLUG));
check('中文分类名不当作 slug（"技术" → other，模型该给 slug）', () =>
  eq(normalizeCategorySlug('技术', SLUGS), FALLBACK_SLUG));
check('空串 / null / undefined / 纯空白 → other', () => ok(
  normalizeCategorySlug('', SLUGS) === FALLBACK_SLUG
  && normalizeCategorySlug(null, SLUGS) === FALLBACK_SLUG
  && normalizeCategorySlug(undefined, SLUGS) === FALLBACK_SLUG
  && normalizeCategorySlug('   ', SLUGS) === FALLBACK_SLUG,
  '有空值没归到 other',
));
check('other 自己也是合法 slug（不是被当成自造）', () =>
  eq(normalizeCategorySlug('other', SLUGS), 'other'));

group('2.3 受控分类 · 分类法本身');

check('每个分类都有非空 hint', () => {
  const bad = DEFAULT_CATEGORIES.filter((c) => !c.hint || c.hint.trim().length < 4);
  return ok(bad.length === 0, `缺 hint: ${JSON.stringify(bad.map((c) => c.slug))}`);
});
check('other 一定在默认分类法里（否则"归不进就选它"无处可归）', () =>
  ok(SLUGS.includes(FALLBACK_SLUG), JSON.stringify(SLUGS)));
check('slug 唯一（重复会让 slug→id 的映射随机取一个）', () =>
  eq(new Set(SLUGS).size, SLUGS.length));
check('slug 全是小写 ASCII（模型写大写时要靠归一，但源头别制造歧义）', () => {
  const bad = SLUGS.filter((s) => !/^[a-z][a-z0-9-]*$/.test(s));
  return ok(bad.length === 0, JSON.stringify(bad));
});
check(`分类数在 5~12 之间（当前 ${DEFAULT_CATEGORIES.length}）`, () =>
  ok(DEFAULT_CATEGORIES.length >= 5 && DEFAULT_CATEGORIES.length <= 12,
    String(DEFAULT_CATEGORIES.length)));

// ── ⑦ 提示词里带分类清单与 hint ────────────────────────────
group('2.3 受控分类 · 提示词');

const promptText = buildAnalyzeUser({
  title: 'T', body: 'B', categories: DEFAULT_CATEGORIES, knownTopics: ['交付'],
});
check('提示词含每一个 slug', () => {
  const missing = SLUGS.filter((s) => !promptText.includes(s));
  return ok(missing.length === 0, `缺: ${JSON.stringify(missing)}`);
});
check('提示词含每个分类的 hint（不只给 slug）', () => {
  const missing = DEFAULT_CATEGORIES.filter((c) => !promptText.includes(String(c.hint)));
  return ok(missing.length === 0, `缺 hint: ${JSON.stringify(missing.map((c) => c.slug))}`);
});
check('提示词含已有标签（"优先复用"的依据）', () =>
  ok(promptText.includes('交付') && /已有标签/.test(promptText), promptText.slice(0, 200)));

// ── B. 落库层：受控分类真的约束了写库 ──────────────────────
//
// 纯函数断言只能证明"归一函数是对的"，证明不了**它被调用了**。
// 这里用一个假客户端把 runAnalyze 跑起来，直接查库：
// 库里不该出现模型自造的分类，也不该出现 category_id 为 NULL 的分析行
// （按分类筛选时它会彻底消失）。
group('2.3 受控分类 · 落库');

const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { openDb } = await import('../../src/server/db/client.ts');
const { migrate } = await import('../../src/server/db/migrate.ts');
const { packText } = await import('../../src/server/db/text-blob.ts');
const { runAnalyze } = await import('../../src/server/ai/analyze.ts');
const { ensureDefaultCategories, listCategories } = await import('../../src/server/ai/taxonomy.ts');

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m203-'));
const h = openDb({ dataDir: tmp });
migrate(h.db);
const DB = h.db;
const UID = 'u_test';

DB.prepare(`INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)`)
  .run(UID, 'c@t.local', 'C', 'owner', Date.now());
DB.prepare('INSERT INTO settings (user_id) VALUES (?)').run(UID);
ensureDefaultCategories(DB, UID);

function insertEntry(id, title, body) {
  DB.prepare(`INSERT INTO entries (id, user_id, feed_id, guid, url, url_norm, title,
      published_at, fetched_at, stage) VALUES (?,?,NULL,?,?,?,?,?,?,'extracted')`)
    .run(id, UID, `g-${id}`, `https://e.test/${id}`, `https://e.test/${id}`, title, Date.now(), Date.now());
  DB.prepare('INSERT INTO entry_contents (entry_id, html, extracted_by) VALUES (?,?,?)')
    .run(id, packText(`<article><p>${body}</p></article>`), 'feed');
}

/** 假客户端：只回一个分类 slug，其余字段固定 */
function fakeClient(slug, importance = 55) {
  return {
    config: { models: { strong: 'mock-strong' } },
    async chatJson() {
      return {
        ok: true,
        raw: '{}',
        usage: { purpose: 'analyze', model: 'mock-strong', inTokens: 10, outTokens: 5, costUsd: 0.00001, latencyMs: 1, ok: true },
        data: {
          summary: '这是一段足够长的摘要，用于通过 schema 的最小长度校验。',
          key_points: ['要点一', '要点二'],
          category: slug,
          topics: ['测试'],
          entities: { people: [], orgs: [], products: [], tech: [] },
          importance, novelty: 50, sentiment: 'neutral',
        },
      };
    },
  };
}

const catsBefore = Number(DB.prepare('SELECT COUNT(*) c FROM categories WHERE user_id=?').get(UID).c);
const cases = [
  ['e_ok', 'tech', 'tech', '模型给合法 slug → 原样落库'],
  ['e_case', 'Technology', 'other', '英文近义词 "Technology" → other（不做模糊匹配）'],
  ['e_upper', 'TECH', 'tech', '全大写 TECH → tech（大小写要容错）'],
  ['e_made', 'crypto-bro', 'other', '自造 slug → other'],
  ['e_cn', '科技资讯', 'other', '中文名当 slug → other'],
  ['e_empty', '', 'other', '空串 → other'],
];
const importances = [55, 89, 90, 70, 39, 40];  // 与 cases 一一对应，顺带验落库的 tier

for (let i = 0; i < cases.length; i++) {
  insertEntry(cases[i][0], `标题 ${i}`, '正文内容足够长，用于分析。'.repeat(10));
}
for (let i = 0; i < cases.length; i++) {
  await runAnalyze(DB, fakeClient(cases[i][1], importances[i]), cases[i][0]);
}

const slugOf = (id) => {
  const r = DB.prepare(`SELECT c.slug AS slug, a.category_id AS cid, a.tier AS tier
                          FROM entry_analysis a
                          LEFT JOIN categories c ON c.id = a.category_id
                         WHERE a.entry_id = ?`).get(id);
  return r;
};

for (let i = 0; i < cases.length; i++) {
  const [id, , want, label] = cases[i];
  const got = slugOf(id);
  check(label, () => ok(
    got && got.slug === want,
    `期望 category_slug=${want}，实际 ${got ? got.slug : '(无分析行)'}（category_id=${got?.cid}）`,
  ));
}

check('没有任何分析行的 category_id 是 NULL（NULL 会让它在按分类筛选时消失）', () => {
  const bad = DB.prepare('SELECT COUNT(*) c FROM entry_analysis WHERE category_id IS NULL').get();
  return eq(Number(bad.c), 0);
});
check('库里的分类行数没变（模型自造 slug 长不出新分类）', () => {
  const after = Number(DB.prepare('SELECT COUNT(*) c FROM categories WHERE user_id=?').get(UID).c);
  return eq(after, catsBefore);
});
check('落库的 tier 与 importance 逐条对应（89→worth 90→must_read 70→worth 39→noise 40→normal）', () => {
  const got = cases.map((c) => slugOf(c[0])?.tier);
  const want = ['normal', 'worth', 'must_read', 'worth', 'noise', 'normal'];
  return ok(JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)} 实际 ${JSON.stringify(got)}`);
});

// 再跑一条自造 slug，读 runAnalyze 的**返回值**（不只是库里的结果）
{
  insertEntry('e_ret', '标题 ret', '正文内容足够长，用于分析。'.repeat(10));
  const r = await runAnalyze(DB, fakeClient('not-a-real-slug', 60), 'e_ret');
  check('runAnalyze 返回值里的 categorySlug 是归一后的 other', () =>
    eq(r.categorySlug, 'other'));
}

check('listCategories 返回 9 类且含 other', () => {
  const list = listCategories(DB, UID);
  return ok(list.length === DEFAULT_CATEGORIES.length && list.some((c) => c.slug === 'other'),
    `共 ${list.length} 类: ${list.map((c) => c.slug).join(',')}`);
});

h.close();
rmSync(tmp, { recursive: true, force: true });

summary('m2-03-classify');
process.exit(process.exitCode ?? 0);
