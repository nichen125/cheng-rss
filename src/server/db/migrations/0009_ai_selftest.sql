-- 0009：自检结果落库（PLAN §8.10 / §15.30，v2.7）
--
-- 为什么要落库而不是只放内存：用户要"测试结果便于查看"，刷新页面就消失的
-- 结果等于没测。保留最近若干次还能回答"改了什么之后变好了"。
--
-- capabilities 是给客户端用的（§8.10 的能力画像），steps 是给人看的。
-- 两者同表不同列：画像只需要"最新一行"、步骤需要"每一次都在"。

CREATE TABLE IF NOT EXISTS ai_selftest_runs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  base_url     TEXT NOT NULL,
  model        TEXT NOT NULL,
  verdict      TEXT,
  steps        TEXT NOT NULL,
  capabilities TEXT,
  cost_usd     REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_selftest_user_time
  ON ai_selftest_runs(user_id, started_at DESC);
