-- 源的排列顺序（PLAN §15.28，分组与源排序）
--
-- 为什么需要这一列：在此之前 feeds 表**没有**顺序字段，listFeeds 的
-- ORDER BY 是 `status = 'broken', title IS NULL, title` —— 即"没坏就按标题"。
-- 也就是说源既不能被用户排，也不能被摆到另一个组时保留位置。
--
-- 默认 0 是刻意的：老数据全部并列在 0 上，于是退回按标题比，
-- 迁移前后界面上完全看不出变化。新排序规则是
-- `status = 'broken', sort, title`，失效源仍排最后（§15.23 不变）。
ALTER TABLE feeds ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;

-- 建索引给"取某个组的源并按顺序排"这条路径用。
-- 侧栏一次取全部源，但配置页与跨组移动都要按 folder_id 定位，
-- 而 folder_id 上原来没有索引。
CREATE INDEX idx_feeds_folder_sort ON feeds(user_id, folder_id, sort);
