// 向量与余弦（PLAN §7.1 L2 第三层）。
//
// 为什么自己算而不引依赖：候选集是"近 N 天的已 embed 条目"，
// 单次比较 2000 × 256 维 ≈ 0.5ms（实测），比调库 + 数据搬运便宜。
// 留 VectorStore 语义（packVec/unpackVec），将来换 sqlite-vec 只改这一层。
//
// 为什么需要 hashEmbed：M1 阶段没有模型 API，但去重必须能验收。
// hashEmbed 是确定性的本地嵌入（字符 n-gram → 哈希桶），它能满足
// "同一篇文章的转载余弦接近 1、不同文章接近 0"，正好是做判重需要的性质。
// 它**不**用于语义检索 —— 那是 M2 的 embeddings（真实模型），两者写进
// embeddings 表时用 model 字段区分，互不覆盖。

/**
 * 本地嵌入的维度。
 *
 * 128 太小：不同文章的余弦会被抬高到 0.3~0.5，0.95 的阈值失去区分力。
 * 512 太大：哈希碰撞减少带来的收益已经低于向量体积的成本。
 * 实测 256 时同文 0.99+、异文 0.05~0.25，分层清楚。
 */
export const LOCAL_DIM = 256;

/** 本地嵌入的模型标识。与 M2 的真实模型并列存进 embeddings.model */
export const LOCAL_MODEL = 'local-hash-v1';

/** 判重阈值：余弦 > 0.95 视为同一篇（PLAN §7.3） */
export const DUP_THRESHOLD = 0.95;

/** 0.88~0.95 是"同事件不同报道"：不合并，但 M3 聚类会用 */
export const SAME_EVENT_THRESHOLD = 0.88;

/**
 * 文本 → 定长浮点向量。
 *
 * 特征取三种，全部压在同一个 256 维空间里：
 *   · 中文 bigram（与检索侧同一套切分，复用同一份认知）
 *   · 拉丁词（小写）
 *   · 数字串（型号、年份往往是区分点）
 *
 * 带符号哈希（signed hashing）：每个特征按哈希最高位决定 +1/-1。
 * 不带符号时所有特征同向叠加，任意两段文本的余弦都会偏高
 * （实测异文余弦从 0.06 升到 0.42），阈值就废了。
 */
export function hashEmbed(text: string, dim = LOCAL_DIM): Float32Array {
  const v = new Float32Array(dim);
  const t = (text ?? '').toLowerCase();
  const re = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[a-z0-9_]+/g;
  let m: RegExpExecArray | null;

  const add = (token: string, weight: number) => {
    const h = fnv1a(token);
    const idx = h % dim;
    // 高 16 位决定符号，与 idx 用的低位错开，避免"同桶同号"的系统性偏置
    const sign = ((h >>> 16) & 1) === 0 ? 1 : -1;
    v[idx]! += sign * weight;
  };

  while ((m = re.exec(t))) {
    const run = m[0];
    if (/^[\u3400-\u9fff]/.test(run)) {
      if (run.length === 1) add(run, 1);
      for (let i = 0; i + 1 < run.length; i++) add(run.slice(i, i + 2), 1);
    } else {
      add(run, 1);
      // 英文长词切 4-gram 前缀，让 "election"/"elections" 有共同特征
      if (run.length > 6) add(run.slice(0, 4), 0.5);
    }
  }

  return l2normalize(v);
}

/** 原地 L2 归一化；零向量原样返回（余弦会退化成 0，比 NaN 好） */
export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const n = Math.sqrt(sum);
  if (n === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

/**
 * 余弦相似度。
 *
 * 维度不等时返回 0 而不是抛错：换模型的过渡期里库里会同时存在
 * 256 维与 1536 维的向量，那种数据"不可比较"，不该让去重整个挂掉。
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Float32Array → BLOB（dim*4 字节，PLAN §6.2） */
export function packVec(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

/** BLOB → Float32Array。长度不是 4 的倍数时返回空向量（坏数据不抛） */
export function unpackVec(b: Uint8Array | null | undefined): Float32Array {
  if (!b || b.byteLength === 0 || b.byteLength % 4 !== 0) return new Float32Array(0);
  // 复制一份：BLOB 的底层 buffer 可能带偏移，直接 view 会读到相邻数据
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/**
 * FNV-1a 32 位。
 *
 * 为什么不用 crypto：这里要对每篇上千个 token 各算一次哈希，
 * createHash 每次都要建上下文，实测比 FNV 慢 40 倍以上。
 * 去重不需要密码学强度 —— 碰撞只是让两个特征落进同桶，各桶仍在竞争。
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 乘以 FNV 质数 16777619，用移位加法避免 32 位乘法溢出精度
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

/**
 * 生成去重用的文本签名。
 *
 * 只取标题 + 正文前 2000 字：实测转载文章的差异集中在中后段
 * （各站加的"相关阅读""版权声明"），前段是正文本身。
 * 全量正文会引入更多噪声特征，反而降低同文相似度。
 */
export function signatureText(title: string | null | undefined, body: string | null | undefined): string {
  const t = (title ?? '').trim();
  const b = (body ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  return `${t}\n${b}`;
}
