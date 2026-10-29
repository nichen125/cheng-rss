-- 003 / 0004：简报的「哪天」与「覆盖哪段时间」分开 + 跳过记录 + 推送状态
--
-- 为什么必须先于 3.4 拆开 period_start 的职责：
--   period_start 原本同时承担"覆盖窗口起点"和"这份简报属于哪一天"两个含义。
--   一旦用户把生成时间从 08:00 改到 09:00，窗口起点就跟着移了 1 小时，
--   于是同一天会多出一条"新简报"，而旧的还在 —— 用户看到两份内容不同的
--   日报，且没有"哪份是新的"的标记。改时间不该产生第二份。
--
-- day_key = 生成那天的本地 00:00，是真正的幂等键。

ALTER TABLE digests ADD COLUMN day_key INTEGER;
ALTER TABLE digests ADD COLUMN deliver_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE digests ADD COLUMN deliver_error TEXT;

-- 旧行没有 day_key：用 period_start 所在的**本地日 00:00** 兜底。
--
-- 不能写 `period_start / 86400000 * 86400000` —— 那是 UTC 午夜。东八区下
-- 一份 08:00 生成的简报会被算到 UTC 前一天 16:00，与真正前一天的简报撞上
-- 唯一索引，迁移直接失败。
--
-- `date(...)` 只给日期字符串（无时分），直接乘会丢精确性；正确的写法是
-- 经过 `'localtime','start of day','utc'` 三步再转回 epoch —— 实测得到的是
-- 本地 00:00:00.000（见 m3-04 的日界断言）。
UPDATE digests SET day_key = CAST(
  strftime('%s', period_start / 1000, 'unixepoch', 'localtime', 'start of day', 'utc')
  AS INTEGER
) * 1000 WHERE day_key IS NULL;

-- 同一天同一类只允许一份。允许 day_key 为 NULL 的多行（历史遗留）——
-- SQLite 的 UNIQUE 索引把 NULL 视为互不相等，这正好是我们要的宽容。
CREATE UNIQUE INDEX uq_digest_day ON digests (user_id, kind, day_key);

-- 旧的 (user_id, kind, period_start) 唯一索引保留：它仍然有价值
-- （防止手工导入两份时间窗完全重叠的简报），且 day_key 索引建在它之上
-- 不会冲突 —— 两条约束同时成立时都满足。

-- ── 跳过的记录 ───────────────────────────────────────────────
--
-- "今天没有值得出简报的内容"必须落一条记录，否则调度器每分钟都会再试一次，
-- 而每次尝试都要聚类 + 调模型 —— 一天 1440 次，成本与日志都不可接受。
--
-- 单独一张表而不是往 digests 里塞一条空简报：空简报会被 UI 当成"今天有简报"
-- 渲染出一个空白页，那比没有更糟；而"为什么没出"是用户会问的问题，
-- 需要一个可查的答案。
CREATE TABLE digest_skips (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  day_key    INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, day_key)
);

-- ── 尝试记录 ─────────────────────────────────────────────────
--
-- 为什么与 digests / digest_skips 分开：
--   合并进 digests 会让"没有简报行"同时意味着"没试过"和"试过但失败了"，
--   而这两者的下一步动作完全相反（立刻跑 vs 退避后重跑）。
--   合并进 digest_skips 也不行 —— 跳过是"确定今天不做了"，
--   失败是"等会儿再试"，语义相反。
--
-- 不设唯一键：同一天允许保留多次尝试的完整轨迹，排障时能看到
-- "10:00 超时、10:10 又超时、11:10 schema 错"这样的序列。
CREATE TABLE digest_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  day_key    INTEGER NOT NULL,
  ok         INTEGER NOT NULL,
  error      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_digest_attempts ON digest_attempts (user_id, kind, day_key);
