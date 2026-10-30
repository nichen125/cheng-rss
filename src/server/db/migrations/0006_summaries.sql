-- 单篇总结（PLAN §8.9，2.7）
--
-- 为什么主键是 (entry_id, prompt_fp) 而不是 entry_id：
--
-- 提示词可编辑，于是同一条目在不同提示词下会产生不同的总结。若主键只有
-- entry_id，改提示词再点一次就会**覆盖**掉原来那份 —— 用户改错提示词、
-- 点一下、再改回来，原来那份好好的总结已经没了，得重新花钱。
--
-- 按指纹存是多几 KB 换"随时可回退"：改回原提示词时指纹回到原值，
-- 那一份立刻命中，0 次请求。
--
-- 反过来的代价是"同一篇可能有多条"，所以 GET 必须带 prompt_fp 一起查，
-- 不能只按 entry_id 取最新一条 —— 那会让"提示词没变但取到了另一份"。
CREATE TABLE summaries (
  entry_id   TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  -- sha256(提示词).slice(0,16)。存指纹而不是全文：全文 8KB × 每条目 × 每提示词
  -- 会让这张表比正文还大，而它的全部用途就是"和当前提示词比对"。
  prompt_fp  TEXT NOT NULL,
  body       TEXT NOT NULL,
  model      TEXT NOT NULL,
  in_tokens  INTEGER,
  out_tokens INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entry_id, prompt_fp)
);

-- 列表页要显示"这篇总结于何时"，按时间倒序取
CREATE INDEX idx_summaries_created ON summaries (created_at DESC);
