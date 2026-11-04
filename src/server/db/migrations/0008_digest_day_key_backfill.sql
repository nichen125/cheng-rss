-- 0008：补回历史 digests 的 day_key（v2.2 缺陷修复）
--
-- 缺陷：3.3 的 saveDigest 在 INSERT 列清单里漏了 day_key，于是 0004 加了
-- 这一列之后写入的每一份简报 day_key 都是 NULL。后果有三层：
--
--   1. `digestDue` 按 day_key 判"今天做过没" → 永远判"没做过"，
--      调度器每分钟重跑一次完整流程（每簇一次归纳 + 一次生成）
--   2. `digestStatus` 的 state 因此恒为 pending，UI 显示"正在准备今天的简报"
--   3. 唯一索引 `uq_digest_day (user_id, kind, day_key)` 对 NULL 不生效
--      （SQLite 把 NULL 视为互不相等），所以同一天会落多份
--
-- 代码已经修好（saveDigest 现在必写 day_key），但**已落库的旧行仍要修** ——
-- 否则那份简报永远在"今天没生成"的状态里，下一次调度会再生成一份新的，
-- 而两份都 day_key 为 NULL 的行会一直躺着。
--
-- 补法与 0004 对旧行的处理一致：按 period_start 所在的**本地日 00:00** 兜底。
-- 不能写 `period_start / 86400000 * 86400000` —— 那是 UTC 午夜，东八区下
-- 一份 08:00 生成的简报会被算到 UTC 前一天，与真正前一天的简报撞唯一索引。
--
-- 只在 day_key IS NULL 时更新，所以对已经正确的库是**空操作**（可重复执行）。
UPDATE digests SET day_key = CAST(
  strftime('%s', period_start / 1000, 'unixepoch', 'localtime', 'start of day', 'utc')
  AS INTEGER
) * 1000
WHERE day_key IS NULL AND period_start IS NOT NULL;

-- period_start 也为 NULL 的行无法推断日期（正常路径不会产生：saveDigest
-- 的 periodStart 是必填）。这类行留着，不做猜测 —— 猜错会伪造历史。
