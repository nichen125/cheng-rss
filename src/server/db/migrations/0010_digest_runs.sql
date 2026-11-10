-- 0010：简报的"跑一次"与它的进度（PLAN §9.8，v2.8）
--
-- 为什么单独一张表而不是把进度塞进 jobs：
--
--   jobs 是通用排队设施，它的行会在 pruneDoneJobs 里按 7 天删掉。
--   进度一旦被删，"刚才那次跑到哪了"就凭空消失，而它恰恰是失败之后
--   用户最想回头看的东西。所以这里建一张面向用户的专表，job_id 只是
--   「哪个队列任务在跑它」的关联，不是主键也不是生命周期的主人。
--
-- 为什么状态里要有 queued 和 running 两个"活着"的值：
--
--   手动点「现在生成」和 08:00 的定时走同一条队列。用户点完之后到 runner
--   真正认领之间有一小段空窗，那段必须能显示成"已排队"——否则按钮点下去
--   看起来什么都没发生（这正是改这件事的起因）。
--
-- member_key 是簇的复用键，不是身份：
--
--   语义是"这一组文章是不是同一批"。它由成员 entry_id 排序后的 sha256
--   前缀算出来，与哪一天、哪次运行无关，所以可以跨天复用已归纳的结果。
--   已有的 16 行保持 NULL —— NULL 表示"未标定"，语义干净；回填要重算
--   hash，而 hash 函数以后可能会改（改了就该是另一批 key，而不是悄悄
--   把旧的当成新的）。

CREATE TABLE IF NOT EXISTS digest_runs (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 驱动它的队列任务。定时与手动都走队列，所以这里通常有值
  job_id           INTEGER,
  kind             TEXT NOT NULL,
  -- queued | running | done | failed | cancelled | interrupted
  status           TEXT NOT NULL,
  -- prepare | clustering | generating | saving
  phase            TEXT NOT NULL DEFAULT 'prepare',
  done_clusters    INTEGER NOT NULL DEFAULT 0,
  total_clusters   INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0,
  -- 用户点了停止（或花费上限触发）。runner 在簇间读它，读到就中断在飞的调用
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  -- 「谁停的」：用户手动 / 超过单次上限。UI 文案要能区分
  cancel_reason    TEXT,
  reason           TEXT,
  digest_id        TEXT,
  manual           INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  -- 每秒更新。stale 判定靠它，见 digest/runs.ts 的 STALE_RUN_MS
  heartbeat_at     INTEGER NOT NULL,
  finished_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_runs_user
  ON digest_runs (user_id, started_at DESC);

-- 部分索引：只有"活着"的行才需要被扫。判断"这个用户是不是已经在跑"
-- 是每次点按钮都要做的一次查询，它不该扫历史。
CREATE INDEX IF NOT EXISTS idx_runs_live
  ON digest_runs (status) WHERE status IN ('queued', 'running');

ALTER TABLE clusters ADD COLUMN member_key TEXT;
CREATE INDEX IF NOT EXISTS idx_clusters_member_key
  ON clusters (user_id, member_key);
