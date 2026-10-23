-- 0001_init.sql —— 初始表结构
-- 对应 src/server/db/schema.ts。手写而非 drizzle-kit 生成，原因：
--   1. entries_fts 是 FTS5 虚拟表，Drizzle 不支持其 DDL
--   2. 部分索引的 WHERE 子句需要精确控制
--   3. 迁移文件要能被 esbuild text loader 内嵌，纯 SQL 最稳

-- ── 用户与设置 ────────────────────────────────────────────────
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'owner',
  -- scrypt$<salt-hex>$<hash-hex>；带算法前缀便于将来换算法时识别旧格式
  password_hash TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE settings (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ai_config     TEXT NOT NULL DEFAULT '{}',
  fetch_config  TEXT NOT NULL DEFAULT '{}',
  digest_config TEXT NOT NULL DEFAULT '{}',
  rsshub_config TEXT NOT NULL DEFAULT '{}',
  ui_config     TEXT NOT NULL DEFAULT '{}'
);

-- ── 认证（cookie session，插件必需）───────────────────────────
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- ── 分类法（受控：AI 只能选不能造）───────────────────────────
CREATE TABLE categories (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
  slug      TEXT NOT NULL,
  name      TEXT NOT NULL,
  hint      TEXT,
  keywords  TEXT,
  sort      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uq_categories_slug ON categories (user_id, slug);

-- ── 订阅源 ────────────────────────────────────────────────────
CREATE TABLE folders (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE feeds (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id        TEXT REFERENCES folders(id) ON DELETE SET NULL,
  url              TEXT NOT NULL,
  site_url         TEXT,
  title            TEXT,
  icon_url         TEXT,
  fetch_interval   INTEGER NOT NULL DEFAULT 1800,
  last_fetched_at  INTEGER,
  next_fetch_at    INTEGER,
  etag             TEXT,
  last_modified    TEXT,
  error_count      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active',
  analysis_profile TEXT NOT NULL DEFAULT 'standard',
  source_kind      TEXT NOT NULL DEFAULT 'rss'
);
CREATE UNIQUE INDEX uq_feeds_url ON feeds (user_id, url);
CREATE INDEX idx_feeds_next ON feeds (next_fetch_at);

-- ── 条目 ──────────────────────────────────────────────────────
CREATE TABLE entries (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 可空：网页捕获（Huntly 插件）没有 feed
  feed_id      TEXT REFERENCES feeds(id) ON DELETE CASCADE,
  guid         TEXT NOT NULL,
  url          TEXT NOT NULL,
  url_norm     TEXT NOT NULL,
  title        TEXT NOT NULL,
  author       TEXT,
  published_at INTEGER NOT NULL,
  fetched_at   INTEGER NOT NULL,

  excerpt      TEXT,
  content_hash TEXT,
  word_count   INTEGER,

  stage        TEXT NOT NULL DEFAULT 'pending',
  stage_error  TEXT,
  retry_count  INTEGER NOT NULL DEFAULT 0,

  is_read      INTEGER NOT NULL DEFAULT 0,
  is_starred   INTEGER NOT NULL DEFAULT 0,
  is_hidden    INTEGER NOT NULL DEFAULT 0,
  duplicate_of TEXT REFERENCES entries(id) ON DELETE SET NULL,

  -- Huntly 插件兼容
  source_type         TEXT NOT NULL DEFAULT 'rss',
  archive_status      INTEGER NOT NULL DEFAULT 0,
  read_later          INTEGER NOT NULL DEFAULT 0,
  library_save_status INTEGER NOT NULL DEFAULT 0,
  page_json           TEXT,
  favicon_url         TEXT,
  site_name           TEXT,
  thumbnail_url       TEXT,

  -- 阅读历史：时间戳而非布尔（PLAN §7.4）
  first_read_at INTEGER,
  last_read_at  INTEGER,
  read_count    INTEGER NOT NULL DEFAULT 0,
  read_progress REAL,

  highlight_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uq_entries_guid ON entries (feed_id, guid);
CREATE INDEX idx_entries_timeline ON entries (user_id, published_at DESC);
CREATE INDEX idx_entries_unread   ON entries (user_id, published_at DESC) WHERE is_read = 0;
CREATE INDEX idx_entries_lastread ON entries (user_id, last_read_at DESC) WHERE last_read_at IS NOT NULL;
CREATE INDEX idx_entries_urlnorm  ON entries (user_id, url_norm);
CREATE INDEX idx_entries_stage    ON entries (user_id, stage) WHERE stage <> 'done';
CREATE INDEX idx_entries_hash     ON entries (content_hash);

-- 正文：gzip 后的 BLOB（PLAN §13.3），不是 TEXT
CREATE TABLE entry_contents (
  entry_id     TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  html         BLOB,
  markdown     BLOB,
  raw_html     BLOB,
  extracted_by TEXT
);

-- ── AI 单篇分析 ──────────────────────────────────────────────
CREATE TABLE entry_analysis (
  entry_id       TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  summary        TEXT NOT NULL,
  key_points     TEXT NOT NULL,
  category_id    TEXT REFERENCES categories(id) ON DELETE SET NULL,
  topics         TEXT NOT NULL,
  entities       TEXT NOT NULL,
  importance     INTEGER NOT NULL,
  tier           TEXT NOT NULL,
  novelty        INTEGER,
  sentiment      TEXT,
  reading_time   INTEGER,
  lang           TEXT,
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  in_tokens      INTEGER,
  out_tokens     INTEGER,
  cost_usd       REAL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_analysis_tier ON entry_analysis (tier, created_at DESC);

-- ── 向量（BLOB，无扩展依赖）──────────────────────────────────
CREATE TABLE embeddings (
  entry_id   TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_emb_model ON embeddings (model);

-- ── 跨篇聚合：事件簇 ─────────────────────────────────────────
CREATE TABLE clusters (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT,
  key_points   TEXT,
  consensus    TEXT,
  conflicts    TEXT,
  centroid     BLOB,
  entry_count  INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  heat         INTEGER,
  window_start INTEGER,
  window_end   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_clusters_window ON clusters (user_id, window_end DESC);

CREATE TABLE cluster_entries (
  cluster_id  TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  entry_id    TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  similarity  REAL,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cluster_id, entry_id)
);

-- ── 高亮（W3C 三选择器）──────────────────────────────────────
CREATE TABLE highlights (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id     TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  quote_exact  TEXT NOT NULL,
  quote_prefix TEXT,
  quote_suffix TEXT,
  pos_start    INTEGER,
  pos_end      INTEGER,
  range_json   TEXT,
  color        TEXT,
  note         TEXT,
  ai_insight   TEXT,
  is_orphaned  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_hl_entry   ON highlights (user_id, entry_id);
CREATE INDEX idx_hl_created ON highlights (user_id, created_at DESC);

-- ── 简报 ─────────────────────────────────────────────────────
CREATE TABLE digests (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  intro         TEXT,
  body_md       TEXT NOT NULL,
  period_start  INTEGER,
  period_end    INTEGER,
  entry_count   INTEGER,
  cluster_count INTEGER,
  model         TEXT,
  cost_usd      REAL,
  delivered_at  INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_digest_period ON digests (user_id, kind, period_start);

-- ── 任务队列 ─────────────────────────────────────────────────
CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  dedupe_key   TEXT,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  priority     INTEGER NOT NULL DEFAULT 0,
  run_after    INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  locked_by    TEXT,
  locked_at    INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_jobs_pick ON jobs (status, run_after, priority DESC, id);
CREATE UNIQUE INDEX uq_jobs_dedupe ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');

-- ── 成本审计 ─────────────────────────────────────────────────
CREATE TABLE ai_usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  model      TEXT NOT NULL,
  in_tokens  INTEGER,
  out_tokens INTEGER,
  cost_usd   REAL,
  latency_ms INTEGER,
  ok         INTEGER NOT NULL DEFAULT 1,
  error      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_usage_day ON ai_usage (user_id, created_at DESC);

-- ── RSSHub 路由缓存 ──────────────────────────────────────────
CREATE TABLE rsshub_cache (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- ── 备份记录（按体积保留策略依赖）────────────────────────────
CREATE TABLE backup_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  size_bytes INTEGER,
  schema_ver INTEGER NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1,
  error      TEXT,
  created_at INTEGER NOT NULL
);

-- ── RAG 会话 ─────────────────────────────────────────────────
CREATE TABLE chat_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  citations  TEXT,
  created_at INTEGER NOT NULL
);

-- ── 全文检索（中文按 bigram 预切分，PLAN §7.3）───────────────
-- content='' 表示内容由程序维护（不做 external content 同步）。
-- contentless_delete=1 是必须的：contentless 表默认不允许 DELETE，
-- 而索引更新（改标题、删条目）只能 delete + insert，
-- 没有这个选项会抛 "cannot DELETE from contentless fts5 table"。
-- 需要 SQLite >= 3.43（Node 24 自带 3.50）。
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title,
  content='',
  contentless_delete=1,
  tokenize='unicode61'
);

-- entry_id ↔ fts rowid 映射。
-- 需要它是因为 entries.id 是 TEXT 主键，而 FTS5 只能按 INTEGER rowid 操作。
CREATE TABLE entry_fts_map (
  entry_id  TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  fts_rowid INTEGER NOT NULL UNIQUE
);
CREATE INDEX idx_fts_map_rowid ON entry_fts_map (fts_rowid);
