import type { DatabaseSync } from 'node:sqlite';
import { cosine, unpackVec } from '../dedupe/cosine.ts';

// 事件聚类（PLAN §9.1 第 1 步 / §19.5 3.1）。
//
// 与 §7.1 L2 的去重是**两个不同的问题**，阈值完全不同，混用会两头都错：
//
//   去重（0.95）   "这是不是同一篇文章"      —— 近乎逐字相同
//   聚类（0.40）   "这是不是同一件事的不同报道" —— 信息点重叠、写法各不同
//
// 实测（本地 hash 向量，同一事件的五种写法 vs 不同事件）：
//   同事件两两余弦 0.40 ~ 0.78
//   异事件两两余弦 0.00 ~ 0.30
// 所以 0.35 是这条数据上的分界。真实语义向量的分布整体更高（同事件常
// 0.80~0.90），因此阈值随**向量来源**走 —— 见 thresholdFor()。
//
// 为什么不用 k-means：簇数是未知的，而"今天有几件事"正是要算出来的东西。
// 层次聚类不需要预设 k，且能把"只有一个来源"的簇自然留下来（简报要标注
// 「单一来源，待验证」）。

/** 同一事件的余弦下限（本地 hash 向量，标题+摘要级别） */
export const CLUSTER_THRESHOLD_HASH = 0.35;

/**
 * 真实语义向量的阈值。
 *
 * 比 hash 高得多：语义向量里"都在讲芯片"的两篇也能到 0.5，用它当阈值会
 * 把整个科技板块聚成一坨。0.80 是根据同事件 0.80~0.90、异事件 ≤0.60 的
 * 经验分布取的 —— 这一项需要用自己的数据校准，所以它在这里是"默认值"
 * 而不是"常量"。
 */
export const CLUSTER_THRESHOLD_SEMANTIC = 0.80;

/** 单簇最大条数。超大簇几乎总是"阈值太松"的现象，截断让它可见 */
export const MAX_CLUSTER_SIZE = 60;

/** 单次聚类的时间窗（小时）。§9.1 说"窗口内条目约 100~200 条" */
export const CLUSTER_WINDOW_HOURS = 24;

export type VectorSource = 'semantic' | 'hash';

export function thresholdFor(source: VectorSource): number {
  return source === 'semantic' ? CLUSTER_THRESHOLD_SEMANTIC : CLUSTER_THRESHOLD_HASH;
}

export interface ClusterItem {
  id: string;
  vec: Float32Array;
  /** 发布时间，用于算 recency */
  publishedAt: number;
  /** 来源标识（feedId）。算 sourceCount 用 —— 多源交叉是简报价值的来源 */
  sourceId: string;
  /** 归一后的 importance 0~1，缺省 0.5。算 heat 用 */
  importance?: number;
}

export interface Cluster {
  /** 簇内成员 id，按与中心的相似度降序（第一个是代表条目） */
  memberIds: string[];
  /** 簇中心（成员向量的均值，已归一） */
  centroid: Float32Array;
  /** 簇内两两平均相似度，用来看"这个簇紧不紧" */
  cohesion: number;
  entryCount: number;
  sourceCount: number;
  /** 0~100 的整数，供排序。§9.1：取 heat 排序前 12 簇 */
  heat: number;
}

/**
 * 层次聚类（average linkage）。
 *
 * 复杂度 O(n²) 内存 + O(n³) 最坏时间。对 n=200 实测 < 30ms；
 * §9.1 明确"100~200 条暴力层次聚类，毫秒级完成，无需向量库"。
 * 不做近似索引的理由：规模上限就在那里，为 200 条引入 HNSW 只是多一份
 * 要调参、要验证、要解释的东西。
 */
export function clusterVectors(
  items: ClusterItem[],
  opts: { threshold?: number; maxClusterSize?: number; now?: number } = {},
): Cluster[] {
  const threshold = opts.threshold ?? CLUSTER_THRESHOLD_HASH;
  const maxSize = opts.maxClusterSize ?? MAX_CLUSTER_SIZE;
  const now = opts.now ?? Date.now();

  const n = items.length;
  if (n === 0) return [];

  // 相似度矩阵。对称矩阵只算一半，但 n=200 时省下的那点时间不够抵消
  // 代码复杂度的增加 —— 直接算全量。
  const sim: Float32Array = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    sim[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = cosine(items[i]!.vec, items[j]!.vec);
      sim[i * n + j] = s;
      sim[j * n + i] = s;
    }
  }

  // 每个点先自成一簇；用并查集维护合并关系
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) { const nx = parent[x]!; parent[x] = r; x = nx; }
    return r;
  };

  // average linkage：合并两个簇时用**成员两两相似度的均值**，
  // 而不是簇心与簇心的相似度。单链接会把 A-B、B-C 串成一个大簇，
  // 而 A 与 C 其实无关 —— 那正是"误聚"的典型来源。
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) members.set(i, [i]);

  const pairSim = (a: number[], b: number[]): number => {
    let sum = 0;
    let cnt = 0;
    for (const x of a) {
      for (const y of b) {
        sum += sim[x * n + y]!;
        cnt++;
      }
    }
    return cnt === 0 ? 0 : sum / cnt;
  };

  for (;;) {
    let bestA = -1;
    let bestB = -1;
    let best = -Infinity;
    const roots = [...new Set(parent.map((_, i) => find(i)))];
    for (let ii = 0; ii < roots.length; ii++) {
      for (let jj = ii + 1; jj < roots.length; jj++) {
        const a = members.get(roots[ii]!)!;
        const b = members.get(roots[jj]!)!;
        if (a.length + b.length > maxSize) continue;
        const s = pairSim(a, b);
        if (s > best) { best = s; bestA = roots[ii]!; bestB = roots[jj]!; }
      }
    }
    if (bestA < 0 || best < threshold) break;

    // 合并：把 b 挂到 a 上
    parent[bestB] = bestA;
    const merged = [...members.get(bestA)!, ...members.get(bestB)!];
    members.set(bestA, merged);
    members.delete(bestB);
  }

  // 汇总每个簇
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }

  const out: Cluster[] = [];
  for (const idxs of groups.values()) {
    const centroid = meanVector(idxs.map((i) => items[i]!.vec));

    // 成员按与簇心的相似度降序 —— 第一个就是"最能代表这件事的那篇"
    const scored = idxs.map((i) => ({ i, s: cosine(items[i]!.vec, centroid) }))
      .sort((x, y) => y.s - x.s || items[x.i]!.id.localeCompare(items[y.i]!.id));

    let sum = 0;
    let cnt = 0;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        sum += sim[idxs[a]! * n + idxs[b]!]!;
        cnt++;
      }
    }
    const cohesion = cnt === 0 ? 1 : sum / cnt;

    const sources = new Set(idxs.map((i) => items[i]!.sourceId));
    const maxImportance = Math.max(...idxs.map((i) => items[i]!.importance ?? 0.5));
    const newest = Math.max(...idxs.map((i) => items[i]!.publishedAt));

    out.push({
      memberIds: scored.map((x) => items[x.i]!.id),
      centroid,
      cohesion,
      entryCount: idxs.length,
      sourceCount: sources.size,
      heat: heatScore({
        entryCount: idxs.length,
        sourceCount: sources.size,
        maxImportance,
        ageHours: Math.max(0, (now - newest) / 3600_000),
      }),
    });
  }

  // 排序：heat 降序，同 heat 时条目多的在前（这样"很多源都在报"优先于
  // "一个源报了很短的一条"，即使两者 heat 相同）
  out.sort((a, b) => b.heat - a.heat || b.entryCount - a.entryCount);
  return out;
}

/**
 * 热度。
 *
 * 三个因子相乘而不是相加：任一项为 0 时热度就该是 0（一个只有 1 篇、
 * 1 个源、又很旧的簇，不该因为"重要性高"就排到前面）。相加会让
 * "单一来源 + 高 importance"挤掉"五个源都在报"。
 *
 * 系数是对量级的选择，不是调参结果：
 *   · sourceCount 开根号 —— 从 1 源到 4 源的增幅应远大于 4 到 16
 *   · entryCount 同理，但要压住"一个源刷 30 条"的灌水
 *   · recency 24 小时半衰
 */
export function heatScore(x: {
  entryCount: number;
  sourceCount: number;
  maxImportance: number;
  ageHours: number;
}): number {
  const src = Math.sqrt(Math.max(1, x.sourceCount));
  const cnt = Math.sqrt(Math.max(1, x.entryCount));
  const imp = 0.5 + 0.5 * clamp01(x.maxImportance);
  const rec = Math.pow(0.5, Math.max(0, x.ageHours) / 24);
  return Math.round(clamp01((src * cnt * imp * rec) / 8) * 100);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 向量均值后归一。全零输入返回全零（余弦会退化为 0，比 NaN 好） */
export function meanVector(vs: Float32Array[]): Float32Array {
  if (vs.length === 0) return new Float32Array(0);
  const dim = vs[0]!.length;
  const out = new Float32Array(dim);
  for (const v of vs) {
    for (let i = 0; i < dim && i < v.length; i++) out[i]! += v[i]!;
  }
  let sum = 0;
  for (let i = 0; i < dim; i++) { out[i]! /= vs.length; sum += out[i]! * out[i]!; }
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < dim; i++) out[i]! /= norm;
  return out;
}

// ── 取数 ──────────────────────────────────────────────────────

export interface ClusterWindowRow {
  id: string;
  feedId: string | null;
  publishedAt: number;
  vec: Float32Array;
  source: VectorSource;
}

/**
 * 取出窗口内所有可聚类的条目。
 *
 * 优先级：真实语义向量（embeddings）> 本地 hash 指纹（entry_vectors）。
 * 两者都有时用语义向量，但**同一批里不能混用** —— 不同维度的余弦恒为 0，
 * 混在一起会让一部分条目永远自成一簇，表现为"聚类结果里有很多单条"。
 *
 * 所以这里先数一下两种来源各有多少：语义向量覆盖不足一半时整体退回 hash。
 * 那条规则比"逐条挑能用的"更可解释：用户看到的是"这批用的是哪种向量"，
 * 而不是"为什么有些条目聚不上"。
 */
export function loadClusterWindow(
  db: DatabaseSync,
  userId: string,
  sinceMs: number,
  now = Date.now(),
): { items: ClusterWindowRow[]; source: VectorSource; semanticCoverage: number } {
  const rows = db.prepare(`
    SELECT e.id, e.feed_id, e.published_at,
           v.vec AS sem_vec, t.vec AS hash_vec,
           a.importance AS importance
      FROM entries e
      LEFT JOIN embeddings v ON v.entry_id = e.id
      LEFT JOIN entry_vectors t ON t.entry_id = e.id
      LEFT JOIN entry_analysis a ON a.entry_id = e.id
     WHERE e.user_id = ?
       AND e.duplicate_of IS NULL
       AND e.published_at >= ?
     ORDER BY e.published_at DESC
     LIMIT 500
  `).all(userId, sinceMs) as {
    id: string; feed_id: string | null; published_at: number;
    sem_vec: Uint8Array | null; hash_vec: Uint8Array | null;
    importance: number | null;
  }[];

  const total = rows.length;
  const withSem = rows.filter((r) => r.sem_vec).length;
  const semanticCoverage = total === 0 ? 0 : withSem / total;

  // 语义向量覆盖过半才用它：否则说明 embeddings 还没跑满（新库、
  // 刚换了模型、或者没配 embedding key），此时用 hash 更一致。
  const useSemantic = total > 0 && semanticCoverage >= 0.5;

  const items: ClusterWindowRow[] = [];
  for (const r of rows) {
    const vec = useSemantic ? unpackVec(r.sem_vec) : unpackVec(r.hash_vec);
    if (vec.length === 0) continue;   // 没向量的条目跳过（不是错误）
    items.push({
      id: r.id,
      feedId: r.feed_id,
      publishedAt: Number(r.published_at),
      vec,
      source: useSemantic ? 'semantic' : 'hash',
    });
  }
  void now;
  return { items, source: useSemantic ? 'semantic' : 'hash', semanticCoverage };
}
