#!/usr/bin/env node
// 3.1 事件聚类 —— 验收
//
// 判据（PLAN §19.5 3.1 + §9.1）：
//   ① 100 条同事件样本聚成 ≤3 簇
//   ② 不同事件不误聚（这是反面的关键：只测 ① 的话，一个"全部聚成一簇"
//      的实现完美满足"≤3 簇"）
//   ③ 100 条 < 1s
//   ④ average linkage 而非单链接：A-B 近、B-C 近但 A-C 远时不能串成一个大簇
//   ⑤ heat 由 源数 / 条数 / 重要性 / 新鲜度 共同决定，且任一项为 0 时不高
//   ⑥ 向量来源的选择：语义向量覆盖过半才用它，否则整体退回 hash
//   ⑦ 簇内成员按与簇心相似度降序（第一个是"最能代表这件事的"）
//   ⑧ 边角：空输入 / 单条 / 全同 / 全不同
//
// ② 的阈值不是凭空定的：实测同一事件的五种写法（标题级）余弦 0.40~0.78，
// 不同事件 0.00~0.30。0.35 落在空档里，与 §7.3 的去重阈值 0.95 是两回事。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, lt, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const {
  clusterVectors, heatScore, meanVector, loadClusterWindow,
  CLUSTER_THRESHOLD_HASH, CLUSTER_THRESHOLD_SEMANTIC, thresholdFor,
  CLUSTER_WINDOW_HOURS, MAX_CLUSTER_SIZE,
} = await import('../../src/server/cluster/index.ts');
const { hashEmbed, cosine, packVec } = await import('../../src/server/dedupe/cosine.ts');
const { openDb } = await import('../../src/server/db/client.ts');
const { migrate } = await import('../../src/server/db/migrate.ts');

// ── 构造样本 ─────────────────────────────────────────────────
//
// 三个事件，每个事件 5~6 种写法。用 hashEmbed 而不是随机向量：随机向量
// 之间余弦≈0，那样"同事件能聚起来"就无从谈起 —— 测的必须是真实文本
// 特征下的可分性。
//
// **写法刻意贴近真实转载**：同一事件的不同报道会重复实体名、产品名、
// 关键数字（这是新闻的常态），而不是把每个事实都换个说法。
//
// 这不是为了让它好过。实测过两次：
//   · 实体+数字重叠的真实转载 余弦 0.45~0.85  → 聚得起来
//   · 每条都把事实彻底改写的"人工同义"文本 余弦 0.25~0.35 → 聚不起来
// 后者说明的是 hashEmbed 的能力边界（字符 n-gram 只看字面重叠），
// 所以 §9.1 的实现优先用语义向量、hash 只作降级。本文件末尾有一条
// 断言把这个边界固定下来，免得将来有人以为"调低阈值就行"。
const EVENTS = {
  stm: [
    '长江存储 232层QLC闪存量产 单颗1Tb 2400MT/s 位密度提升40%',
    '长江存储 232层QLC闪存开始量产 容量1Tb 接口2400MT/s 位密度比上代高40%',
    '长江存储 232层QLC量产 单颗1Tb 速率2400MT/s 位密度+40% Xtacking4.0',
    '长江存储 232层QLC 量产 1Tb 2400MT/s 位密度提升40%',
    '国产闪存突破 长江存储232层QLC量产 单颗1Tb 位密度提升40%',
    '长江存储232层QLC闪存量产 1Tb 2400MT/s 首批客户两家SSD模组厂 四季度出货',
  ],
  layoff: [
    '某自动驾驶公司裁员30% 收缩L4 Robotaxi业务 保留L2++量产辅助驾驶',
    '某自动驾驶公司裁员30% Robotaxi业务收缩 保留L2++量产辅助驾驶业务',
    '某自动驾驶公司裁撤30%员工 主攻L2++量产辅助驾驶 现金可支撑18个月',
    '自动驾驶公司裁员30% Robotaxi 车队收缩 保留L2++量产辅助驾驶',
    '某自动驾驶公司裁员30% 转向整车厂定点项目 保留L2++量产辅助驾驶',
  ],
  milvus: [
    'Milvus3.0发布 重写索引构建流水线 1亿条768维建索引从4.2小时降到50分钟',
    'Milvus3.0发布 索引构建流水线重写 1亿条768维建索引降到50分钟',
    '开源向量数据库Milvus3.0发布 索引构建提速5倍 放弃旧版SDK兼容',
    'Milvus3.0发布 索引构建提速5倍 1亿条768维建索引50分钟',
    'Milvus3.0发布 重写索引构建流水线 IVF与HNSW分段并行 提速5倍',
  ],
};

function buildItems(spec) {
  const items = [];
  let t = Date.now() - 3600_000;
  for (const [event, texts] of Object.entries(spec)) {
    for (let i = 0; i < texts.length; i++) {
      items.push({
        id: `${event}_${i}`,
        vec: hashEmbed(texts[i]),
        publishedAt: t + i * 60_000,
        sourceId: `feed_${(i % 3) + 1}`,       // 每个事件最多 3 个来源
        importance: 0.7,
      });
    }
  }
  void t;
  return items;
}

// ── ① 同事件聚成 ≤3 簇 ──────────────────────────────────────
group('3.1 聚类 · 同事件聚合');

{
  const items = buildItems(EVENTS);
  const clusters = clusterVectors(items, { now: Date.now() });
  check('三个事件聚成 ≤3 簇', () => ok(
    clusters.length <= 3 && clusters.length >= 2,
    `聚成 ${clusters.length} 簇: ${clusters.map((c) => c.entryCount).join('+')}`,
  ));
  check('总条目数没丢（16 条全在簇里）', () => eq(
    clusters.reduce((s, c) => s + c.entryCount, 0), items.length,
  ));
  check('每个簇内部确实是同一事件（成员前缀一致）', () => {
    const bad = [];
    for (const c of clusters) {
      const prefixes = new Set(c.memberIds.map((id) => id.split('_')[0]));
      if (prefixes.size > 1) bad.push({ size: c.entryCount, prefixes: [...prefixes] });
    }
    return ok(bad.length === 0, `误聚: ${JSON.stringify(bad)}`);
  });
}

// 单一事件的 100 条变体：判据①的字面要求
{
  const base = EVENTS.stm[0];
  const variants = Array.from({ length: 100 }, (_, i) => `${base} 补充信息${i % 7} 第${i}次转载`);
  const items = variants.map((t, i) => ({
    id: `v${i}`, vec: hashEmbed(t), publishedAt: Date.now() - i * 1000, sourceId: `f${i % 5}`,
    importance: 0.8,
  }));
  const t0 = performance.now();
  const clusters = clusterVectors(items);
  const ms = performance.now() - t0;
  check('100 条同事件变体聚成 ≤3 簇', () => ok(
    clusters.length <= 3, `聚成 ${clusters.length} 簇（规模 ${clusters.map((c) => c.entryCount).join(',')}）`,
  ));
  check(`100 条聚类耗时 < 1000ms（实测 ${ms.toFixed(0)}ms）`, () => lt(ms, 1000, 'ms'));
}

// ── ② 不同事件不误聚 ────────────────────────────────────────
group('3.1 聚类 · 不误聚');

{
  // 极端的反面：20 个完全无关的事件各 1 条，必须聚成 20 簇（不是 1 簇）
  const texts = [
    '苹果发布新款手机', '美联储宣布加息25个基点', '某地发生6.2级地震',
    'NBA总决赛第七场结束', '开源项目Kubernetes发布新版本', '某车企召回12万辆汽车',
    'Haruki Murakami 获得文学奖', '量子计算机实现新纠错代码',
    '中国空间站完成对接', '英超联赛周末赛果', '某银行下调存款利率',
    '世界卫生组织发布新指南', '某游戏公司被收购', '比特币价格突破新高',
    '某大学发表蛋白质结构论文', '台风登陆东南沿海', '奥运会新增项目公布',
    '某芯片厂宣布扩产', '电影票房创同期纪录', '某城市推出限购政策',
  ];
  const items = texts.map((t, i) => ({
    id: `u${i}`, vec: hashEmbed(t), publishedAt: Date.now(), sourceId: `f${i}`, importance: 0.5,
  }));
  const clusters = clusterVectors(items);
  check('20 个无关事件不被聚成一坨（≥18 簇）', () => ok(
    clusters.length >= 18, `聚成 ${clusters.length} 簇`,
  ));
  check('无关事件里最大簇不超过 2 条', () => ok(
    Math.max(...clusters.map((c) => c.entryCount)) <= 2,
    `最大簇 ${Math.max(...clusters.map((c) => c.entryCount))} 条`,
  ));
}

// 阈值必须落在实测空档里
{
  const same = cosine(hashEmbed(EVENTS.stm[0]), hashEmbed(EVENTS.stm[1]));
  const diff = cosine(hashEmbed(EVENTS.stm[0]), hashEmbed(EVENTS.layoff[0]));
  check(`hash 阈值 ${CLUSTER_THRESHOLD_HASH} 落在同事件与异事件的空档之间`, () => ok(
    CLUSTER_THRESHOLD_HASH < same && CLUSTER_THRESHOLD_HASH > diff,
    `同事件 ${same.toFixed(3)} > 阈值 ${CLUSTER_THRESHOLD_HASH} > 异事件 ${diff.toFixed(3)}`,
  ));
}
check('语义向量的阈值显著高于 hash 阈值（否则整个板块聚成一坨）', () => ok(
  CLUSTER_THRESHOLD_SEMANTIC > CLUSTER_THRESHOLD_HASH + 0.3,
  `${CLUSTER_THRESHOLD_SEMANTIC} vs ${CLUSTER_THRESHOLD_HASH}`,
));
check('thresholdFor 按来源返回对应阈值', () => ok(
  thresholdFor('hash') === CLUSTER_THRESHOLD_HASH
  && thresholdFor('semantic') === CLUSTER_THRESHOLD_SEMANTIC,
  `${thresholdFor('hash')} / ${thresholdFor('semantic')}`,
));

// ── ④ average linkage 而非单链接 ───────────────────────────
group('3.1 聚类 · linkage 选择');

{
  // 构造一条链：d0 与 d1 很近、d1 与 d2 也很近，但 d0 与 d2 很远。
  // 单链接会把三条串成一簇（因为存在路径），average linkage 不会。
  //
  // 用 4 维手工向量，余弦可以精确控制，不用靠文本特征碰运气。
  const mk = (x, y) => {
    const v = new Float32Array(8);
    v[0] = x; v[1] = y;
    const n = Math.sqrt(x * x + y * y) || 1;
    v[0] = x / n; v[1] = y / n;
    return v;
  };
  // d0 与 d1 夹角 20°，d1 与 d2 夹角 20°，d0 与 d2 夹角 40°
  const deg = (d) => (d * Math.PI) / 180;
  const items = [
    { id: 'd0', vec: mk(1, 0), publishedAt: Date.now(), sourceId: 'a', importance: 0.5 },
    { id: 'd1', vec: mk(Math.cos(deg(20)), Math.sin(deg(20))), publishedAt: Date.now(), sourceId: 'b', importance: 0.5 },
    { id: 'd2', vec: mk(Math.cos(deg(40)), Math.sin(deg(40))), publishedAt: Date.now(), sourceId: 'c', importance: 0.5 },
  ];
  const s01 = cosine(items[0].vec, items[1].vec);
  const s02 = cosine(items[0].vec, items[2].vec);

  // 阈值取在 s02 与 s01 之间：average linkage 下 d0 与 d2 的距离会随
  // 簇变大而变差，于是(d0,d1)先合并，然后 (d0d1) 与 d2 的平均相似度
  // = (s02+s12)/2，仍然低于阈值 → 不合并。
  const th = (s02 + s01) / 2 + 0.005;
  const clusters = clusterVectors(items, { threshold: th });
  check('链式三联不被单链接串成一簇（是 2 簇不是 1 簇）', () => ok(
    clusters.length === 2,
    `阈值=${th.toFixed(3)} s01=${s01.toFixed(3)} s02=${s02.toFixed(3)} → ${clusters.length} 簇（${clusters.map((c) => c.entryCount).join(',')}）`,
  ));
}

// ── ⑤ heat ─────────────────────────────────────────────────
group('3.1 聚类 · 热度');

check('多源 > 单源（其余条件相同）', () => {
  const a = heatScore({ entryCount: 3, sourceCount: 1, maxImportance: 0.7, ageHours: 2 });
  const b = heatScore({ entryCount: 3, sourceCount: 3, maxImportance: 0.7, ageHours: 2 });
  return ok(b > a, `单源 ${a} vs 三源 ${b}`);
});
check('条目多 > 条目少（源数相同）', () => {
  const a = heatScore({ entryCount: 2, sourceCount: 2, maxImportance: 0.7, ageHours: 2 });
  const b = heatScore({ entryCount: 8, sourceCount: 2, maxImportance: 0.7, ageHours: 2 });
  return ok(b > a, `2 条 ${a} vs 8 条 ${b}`);
});
check('新鲜 > 陈旧（24 小时半衰）', () => {
  const a = heatScore({ entryCount: 3, sourceCount: 3, maxImportance: 0.7, ageHours: 0 });
  const b = heatScore({ entryCount: 3, sourceCount: 3, maxImportance: 0.7, ageHours: 48 });
  return ok(a > b && b >= 0, `新 ${a} vs 旧 ${b}`);
});
check('heat 落在 0~100 的整数区间', () => {
  const vals = [
    heatScore({ entryCount: 1, sourceCount: 1, maxImportance: 0, ageHours: 1000 }),
    heatScore({ entryCount: 100, sourceCount: 100, maxImportance: 1, ageHours: 0 }),
  ];
  return ok(vals.every((v) => Number.isInteger(v) && v >= 0 && v <= 100), JSON.stringify(vals));
});
check('"单源 + 高重要性"不挤掉"多源都在报"', () => {
  const single = heatScore({ entryCount: 1, sourceCount: 1, maxImportance: 1, ageHours: 1 });
  const multi = heatScore({ entryCount: 5, sourceCount: 5, maxImportance: 0.5, ageHours: 1 });
  return ok(multi > single, `单源高重要 ${single} vs 五源中重要 ${multi}`);
});

// ── ⑦ 成员排序 ──────────────────────────────────────────────
group('3.1 聚类 · 成员排序');

{
  const base = EVENTS.milvus[0];
  const items = [
    { id: 'exact', vec: hashEmbed(base), publishedAt: Date.now(), sourceId: 'a', importance: 0.6 },
    { id: 'far', vec: hashEmbed('Milvus 3.0 与上一个版本相比有一些变化，这里不细说'), publishedAt: Date.now(), sourceId: 'b', importance: 0.6 },
  ];
  const clusters = clusterVectors(items, { threshold: 0.1 });
  const c = clusters[0];
  check('簇内成员按与簇心的相似度降序（最代表的在前）', () => {
    if (!c) return ok(false, '没有簇');
    const first = c.memberIds[0];
    const firstSim = cosine(items.find((i) => i.id === first).vec, c.centroid);
    const otherSim = cosine(items.find((i) => i.id !== first).vec, c.centroid);
    return ok(firstSim >= otherSim - 1e-9, `first=${first}(${firstSim.toFixed(3)}) 另一个 ${otherSim.toFixed(3)}`);
  });
}

// ── ⑧ 边角 ─────────────────────────────────────────────────
group('3.1 聚类 · 边角');

check('空输入 → 空结果（不抛）', () => eq(clusterVectors([]).length, 0));
check('单条 → 1 簇，cohesion=1', () => {
  const c = clusterVectors([{ id: 's', vec: hashEmbed('x'), publishedAt: Date.now(), sourceId: 'a' }]);
  return ok(c.length === 1 && c[0].entryCount === 1 && c[0].cohesion === 1, JSON.stringify(c.map((x) => x.cohesion)));
});
check('完全相同的 N 条 → 1 簇，cohesion=1', () => {
  const v = hashEmbed(EVENTS.layoff[0]);
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: `s${i}`, vec: v, publishedAt: Date.now(), sourceId: `f${i}`, importance: 0.5,
  }));
  const c = clusterVectors(items);
  return ok(c.length === 1 && c[0].entryCount === 10 && Math.abs(c[0].cohesion - 1) < 1e-6,
    `簇数=${c.length} 大小=${c[0]?.entryCount} cohesion=${c[0]?.cohesion}`);
});
check('零向量不抛且不把别人吸进自己的簇', () => {
  const zero = new Float32Array(256);
  const items = [
    { id: 'z', vec: zero, publishedAt: Date.now(), sourceId: 'a' },
    { id: 'a1', vec: hashEmbed(EVENTS.stm[0]), publishedAt: Date.now(), sourceId: 'b' },
    { id: 'a2', vec: hashEmbed(EVENTS.layoff[0]), publishedAt: Date.now(), sourceId: 'c' },
  ];
  const c = clusterVectors(items);
  const zc = c.find((x) => x.memberIds.includes('z'));
  return ok(zc.memberIds.length === 1, `零向量所在簇大小 ${zc?.memberIds.length}`);
});
check(`超大簇被 MAX_CLUSTER_SIZE=${MAX_CLUSTER_SIZE} 截断后不会静默丢条目`, () => {
  const v = hashEmbed(EVENTS.stm[0]);
  const n = MAX_CLUSTER_SIZE + 20;
  const items = Array.from({ length: n }, (_, i) => ({
    id: `b${i}`, vec: v, publishedAt: Date.now(), sourceId: 'a', importance: 0.5,
  }));
  const c = clusterVectors(items);
  const total = c.reduce((s, x) => s + x.entryCount, 0);
  return ok(total === n && c.length >= 2, `总条目 ${total}，簇数 ${c.length}`);
});
check('meanVector 归一且全零输入不产生 NaN', () => {
  const m = meanVector([new Float32Array(4), new Float32Array(4)]);
  const bad = Array.from(m).some((x) => Number.isNaN(x));
  return ok(!bad && m.length === 4, `[${Array.from(m).join(',')}]`);
});
check('窗口常量是 24 小时（§9.1）', () => eq(CLUSTER_WINDOW_HOURS, 24));

// ── 能力边界 ────────────────────────────────────────────────
//
// hashEmbed 是**字符 n-gram 哈希**，它只看字面重叠。同一件事的两篇报道
// 如果把实体名、数字都换掉（"长江存储" vs "YMTC"、"1Tb" vs "128GB"），
// 余弦会掉到 0.25~0.35，跌到阈值以下。
//
// 这条断言把边界固定下来，免得将来有人把阈值降到 0.2 去"提高召回" ——
// 那样 20 个无关事件里立刻就会出现误聚。正确做法是 §9.1 的顺序：
// 有语义向量就用语义向量，hash 只是没配 embedding key 时的降级。
check('彻底改写的同义文本在 hash 向量下聚不起来（这是能力边界，不是 bug）', () => {
  const a = '长江存储宣布232层QLC闪存量产 单颗容量1Tb 接口速率2400MT/s';
  const b = 'YMTC 旗下 128GB 新型闪存进入量产阶段，传输速度提升明显';
  const s = cosine(hashEmbed(a), hashEmbed(b));
  return ok(s < CLUSTER_THRESHOLD_HASH,
    `余弦 ${s.toFixed(3)} < 阈值 ${CLUSTER_THRESHOLD_HASH}（若这条变红，说明有人为了让"同事件都能聚"而调低了阈值）`);
});
check('反过来：实体+数字重叠的真实转载越过阈值', () => {
  const a = '长江存储宣布232层QLC闪存量产 单颗容量1Tb 接口速率2400MT/s';
  const b = '长江存储232层QLC闪存量产 1Tb 2400MT/s 首批客户两家模组厂';
  const s = cosine(hashEmbed(a), hashEmbed(b));
  return ok(s > CLUSTER_THRESHOLD_HASH, `余弦 ${s.toFixed(3)}`);
});

// ── ⑥ 向量来源选择 ─────────────────────────────────────────
group('3.1 聚类 · 向量来源');

const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m301-'));
const h = openDb({ dataDir: tmp });
migrate(h.db);
const DB = h.db;
const UID = 'u_c';
DB.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
  .run(UID, 'c@t.local', 'C', 'owner', Date.now());

function addEntry(id, title, withSem, withHash) {
  DB.prepare(`INSERT INTO entries (id, user_id, feed_id, guid, url, url_norm, title,
      published_at, fetched_at, stage) VALUES (?,?,NULL,?,?,?,?,?,?,'analyzed')`)
    .run(id, UID, `g-${id}`, `https://e.test/${id}`, `https://e.test/${id}`, title, Date.now(), Date.now());
  if (withHash) {
    DB.prepare('INSERT INTO entry_vectors (entry_id, dim, vec, model, created_at) VALUES (?,?,?,?,?)')
      .run(id, 256, packVec(hashEmbed(title)), 'local-hash-v1', Date.now());
  }
  if (withSem) {
    const v = new Float32Array(768);
    for (let i = 0; i < 768; i++) v[i] = Math.sin(i + id.length);
    DB.prepare('INSERT INTO embeddings (entry_id, model, dim, vec, created_at) VALUES (?,?,?,?,?)')
      .run(id, 'mock-embed', 768, packVec(v), Date.now());
  }
}

// 语义覆盖 100% → 用语义
for (let i = 0; i < 4; i++) addEntry(`sa${i}`, `语义条目 ${i}`, true, true);
{
  const w = loadClusterWindow(DB, UID, Date.now() - CLUSTER_WINDOW_HOURS * 3600_000);
  check('语义向量全覆盖 → source=semantic 且维度 768', () =>
    ok(w.source === 'semantic' && w.items.every((x) => x.vec.length === 768),
      `source=${w.source} dims=${[...new Set(w.items.map((x) => x.vec.length))].join(',')}`));
  check('semanticCoverage 报出真实覆盖率', () => eq(w.semanticCoverage, 1));
}

// 再加 6 条只有 hash 的 → 覆盖率 40% → 整体退回 hash
for (let i = 0; i < 6; i++) addEntry(`hh${i}`, `只有指纹的条目 ${i}`, false, true);
{
  const w = loadClusterWindow(DB, UID, Date.now() - CLUSTER_WINDOW_HOURS * 3600_000);
  check('语义覆盖 40% → 整体退回 hash（不混用两种维度）', () =>
    ok(w.source === 'hash' && w.items.every((x) => x.vec.length === 256),
      `source=${w.source} coverage=${w.semanticCoverage.toFixed(2)} dims=${[...new Set(w.items.map((x) => x.vec.length))].join(',')}`));
  check('混用时不会有"维度 0"的条目混进聚类输入', () =>
    ok(w.items.every((x) => x.vec.length > 0), `有条目向量为空`));
}

// 时间窗之外的不进来
{
  DB.prepare(`UPDATE entries SET published_at = ? WHERE id = 'hh0'`)
    .run(Date.now() - 48 * 3600_000);
  const w = loadClusterWindow(DB, UID, Date.now() - CLUSTER_WINDOW_HOURS * 3600_000);
  check('48 小时前的条目不进窗口', () => ok(
    !w.items.some((x) => x.id === 'hh0'), `仍包含 hh0`,
  ));
}

// 重复条目不参与聚类（§7.1：它们指回原件，聚进去会让热度虚高）
{
  DB.prepare(`UPDATE entries SET duplicate_of = 'hh1' WHERE id = 'hh2'`).run();
  const w = loadClusterWindow(DB, UID, Date.now() - CLUSTER_WINDOW_HOURS * 3600_000);
  check('重复条目不进聚类窗口', () => ok(
    !w.items.some((x) => x.id === 'hh2'), '仍包含 hh2',
  ));
}

check('无向量条目被跳过而不是造一个零向量', () => {
  addEntry('novec', '没有任何向量的条目', false, false);
  const w = loadClusterWindow(DB, UID, Date.now() - CLUSTER_WINDOW_HOURS * 3600_000);
  return ok(!w.items.some((x) => x.id === 'novec'), '包含 novec');
});

h.close();
rmSync(tmp, { recursive: true, force: true });

summary('m3-01-cluster');
process.exitCode = process.exitCode ?? 0;
