-- 0002_dedupe_vectors.sql —— 去重用的本地向量（PLAN §7.1 L2 / §7.5 补齐）
--
-- 为什么不复用 embeddings 表：
--   embeddings 的主键是 entry_id（一个条目只有一条向量），因为 M2 的真实
--   模型只需要一份。而本地指纹向量与 M2 的语义向量是**两种用途不同的东西**：
--     · 本地 256 维：判"这两篇是不是同一篇"（逐字转载）
--     · 真实 1536 维：判"这两篇在讲什么"（语义检索 / 聚类）
--   挤进一张表就只能二选一 —— M2 写真实向量会把去重指纹覆盖掉，
--   而去重层对 1536 维向量做 0.95 阈值判重是错的（语义相近不等于重复）。
--
-- 为什么不塞进 entries 的列：BLOB 会让 entries 的行变宽，而时间线查询
-- 每条都要读 entries 行。10 万条 × 1KB = 100MB 白白进页缓存。
CREATE TABLE entry_vectors (
  entry_id   TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,          -- Float32Array，dim*4 字节
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 去重的候选集查询是"某用户近 14 天"，需要按时间收窄。
-- entries 上已有 idx_entries_timeline（user_id, published_at DESC），
-- 这条索引让 JOIN 之后不必回表排序。
CREATE INDEX idx_entry_vectors_model ON entry_vectors (model);
