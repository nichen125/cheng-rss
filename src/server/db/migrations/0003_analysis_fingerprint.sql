-- 0003：分析输入指纹（2.2 幂等缓存）
--
-- 为什么必须落库而不是"看有没有 entry_analysis 行"：
-- 条目正文会在提取后更新（§7.5：feed 只有摘要 → 抓原文全文），
-- 摘要型源的条目先被分析一次、拿到全文后又该重分析一次。
-- 只看"有没有分析过"，第二条永远不生效；每次重跑都调 AI，则重跑 20 篇
-- 就是 20 次计费（§19.4 2.2 的判据 ③ 明确要防这个）。
--
-- 判据取「输入指纹」：标题 + 喂给模型那段正文的 SHA-256。内容没变就跳过，
-- 变了就重分析 —— 这与 §8.5「幂等缓存：正文 hash 未变不重分析」一致。
ALTER TABLE entry_analysis ADD COLUMN source_hash TEXT;
ALTER TABLE entry_analysis ADD COLUMN input_chars INTEGER;

CREATE INDEX idx_analysis_source_hash ON entry_analysis (source_hash);
