import { sqliteTable, text, integer, real, blob, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// 所有时间戳统一 integer（epoch ms），布尔统一 integer（0/1）。
// 见 PLAN §6.1 类型映射。

const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
const bool = (name: string, def = false) => integer(name, { mode: 'boolean' }).notNull().default(def);

// ── 用户与设置 ────────────────────────────────────────────────
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  name: text('name'),
  role: text('role').notNull().default('owner'),
  // scrypt$<salt-hex>$<hash-hex>
  passwordHash: text('password_hash'),
  createdAt: ts('created_at').notNull(),
});

export const settings = sqliteTable('settings', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  aiConfig: text('ai_config').notNull().default('{}'),
  fetchConfig: text('fetch_config').notNull().default('{}'),
  digestConfig: text('digest_config').notNull().default('{}'),
  rsshubConfig: text('rsshub_config').notNull().default('{}'),
  uiConfig: text('ui_config').notNull().default('{}'),
});

// ── 认证 ──────────────────────────────────────────────────────
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  index('idx_sessions_user').on(t.userId),
]);

// ── 分类法 ────────────────────────────────────────────────────
export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  hint: text('hint'),
  keywords: text('keywords'),
  sort: integer('sort').notNull().default(0),
}, (t) => [
  uniqueIndex('uq_categories_slug').on(t.userId, t.slug),
]);

// ── 订阅源 ────────────────────────────────────────────────────
export const folders = sqliteTable('folders', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
});

export const feeds = sqliteTable('feeds', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  folderId: text('folder_id').references(() => folders.id, { onDelete: 'set null' }),
  /** 组内顺序（0007）。全部并列 0 时退回按标题比，见 store.ts 的 ORDER BY */
  sort: integer('sort').notNull().default(0),
  url: text('url').notNull(),
  siteUrl: text('site_url'),
  title: text('title'),
  iconUrl: text('icon_url'),
  fetchInterval: integer('fetch_interval').notNull().default(1800),
  lastFetchedAt: ts('last_fetched_at'),
  nextFetchAt: ts('next_fetch_at'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  errorCount: integer('error_count').notNull().default(0),
  status: text('status').notNull().default('active'),
  analysisProfile: text('analysis_profile').notNull().default('standard'),
  sourceKind: text('source_kind').notNull().default('rss'),
}, (t) => [
  uniqueIndex('uq_feeds_url').on(t.userId, t.url),
  index('idx_feeds_next').on(t.nextFetchAt),
]);

// ── 条目 ──────────────────────────────────────────────────────
export const entries = sqliteTable('entries', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // 可空：网页捕获（Huntly 插件）没有 feed
  feedId: text('feed_id').references(() => feeds.id, { onDelete: 'cascade' }),
  guid: text('guid').notNull(),
  url: text('url').notNull(),
  urlNorm: text('url_norm').notNull(),
  title: text('title').notNull(),
  author: text('author'),
  publishedAt: ts('published_at').notNull(),
  fetchedAt: ts('fetched_at').notNull(),

  excerpt: text('excerpt'),
  contentHash: text('content_hash'),
  wordCount: integer('word_count'),

  stage: text('stage').notNull().default('pending'),
  stageError: text('stage_error'),
  retryCount: integer('retry_count').notNull().default(0),

  isRead: bool('is_read'),
  isStarred: bool('is_starred'),
  isHidden: bool('is_hidden'),
  duplicateOf: text('duplicate_of'),

  // Huntly 插件兼容列
  sourceType: text('source_type').notNull().default('rss'),
  archiveStatus: integer('archive_status').notNull().default(0),
  readLater: bool('read_later'),
  librarySaveStatus: integer('library_save_status').notNull().default(0),
  pageJson: text('page_json'),
  faviconUrl: text('favicon_url'),
  siteName: text('site_name'),
  thumbnailUrl: text('thumbnail_url'),

  // 阅读历史
  firstReadAt: ts('first_read_at'),
  lastReadAt: ts('last_read_at'),
  readCount: integer('read_count').notNull().default(0),
  readProgress: real('read_progress'),

  highlightCount: integer('highlight_count').notNull().default(0),
}, (t) => [
  uniqueIndex('uq_entries_guid').on(t.feedId, t.guid),
  index('idx_entries_timeline').on(t.userId, t.publishedAt),
  index('idx_entries_unread').on(t.userId, t.publishedAt).where(sql`is_read = 0`),
  index('idx_entries_lastread').on(t.userId, t.lastReadAt).where(sql`last_read_at IS NOT NULL`),
  index('idx_entries_urlnorm').on(t.userId, t.urlNorm),
  index('idx_entries_stage').on(t.userId, t.stage).where(sql`stage <> 'done'`),
  index('idx_entries_hash').on(t.contentHash),
]);

export const entryContents = sqliteTable('entry_contents', {
  entryId: text('entry_id').primaryKey().references(() => entries.id, { onDelete: 'cascade' }),
  // gzip 后的 BLOB（PLAN §13.3）
  html: blob('html'),
  markdown: blob('markdown'),
  rawHtml: blob('raw_html'),
  extractedBy: text('extracted_by'),
});

export const entryAnalysis = sqliteTable('entry_analysis', {
  entryId: text('entry_id').primaryKey().references(() => entries.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull(),
  keyPoints: text('key_points').notNull(),
  categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
  topics: text('topics').notNull(),
  entities: text('entities').notNull(),
  importance: integer('importance').notNull(),
  tier: text('tier').notNull(),
  novelty: integer('novelty'),
  sentiment: text('sentiment'),
  readingTime: integer('reading_time'),
  lang: text('lang'),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  inTokens: integer('in_tokens'),
  outTokens: integer('out_tokens'),
  costUsd: real('cost_usd'),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  index('idx_analysis_tier').on(t.tier, t.createdAt),
]);

export const embeddings = sqliteTable('embeddings', {
  entryId: text('entry_id').primaryKey().references(() => entries.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  dim: integer('dim').notNull(),
  vec: blob('vec').notNull(),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  index('idx_emb_model').on(t.model),
]);

// ── 事件簇 ────────────────────────────────────────────────────
export const clusters = sqliteTable('clusters', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  summary: text('summary'),
  keyPoints: text('key_points'),
  consensus: text('consensus'),
  conflicts: text('conflicts'),
  centroid: blob('centroid'),
  entryCount: integer('entry_count').notNull().default(0),
  sourceCount: integer('source_count').notNull().default(0),
  heat: integer('heat'),
  windowStart: ts('window_start'),
  windowEnd: ts('window_end'),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  index('idx_clusters_window').on(t.userId, t.windowEnd),
]);

export const clusterEntries = sqliteTable('cluster_entries', {
  clusterId: text('cluster_id').notNull().references(() => clusters.id, { onDelete: 'cascade' }),
  entryId: text('entry_id').notNull().references(() => entries.id, { onDelete: 'cascade' }),
  similarity: real('similarity'),
  isPrimary: bool('is_primary'),
}, (t) => [
  primaryKey({ columns: [t.clusterId, t.entryId] }),
]);

// ── 高亮 ──────────────────────────────────────────────────────
export const highlights = sqliteTable('highlights', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  entryId: text('entry_id').notNull().references(() => entries.id, { onDelete: 'cascade' }),
  // W3C 三选择器（PLAN §11.1）
  quoteExact: text('quote_exact').notNull(),
  quotePrefix: text('quote_prefix'),
  quoteSuffix: text('quote_suffix'),
  posStart: integer('pos_start'),
  posEnd: integer('pos_end'),
  rangeJson: text('range_json'),
  color: text('color'),
  note: text('note'),
  aiInsight: text('ai_insight'),
  isOrphaned: bool('is_orphaned'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [
  index('idx_hl_entry').on(t.userId, t.entryId),
  index('idx_hl_created').on(t.userId, t.createdAt),
]);

// ── 简报 ──────────────────────────────────────────────────────
export const digests = sqliteTable('digests', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  intro: text('intro'),
  bodyMd: text('body_md').notNull(),
  periodStart: ts('period_start'),
  periodEnd: ts('period_end'),
  entryCount: integer('entry_count'),
  clusterCount: integer('cluster_count'),
  model: text('model'),
  costUsd: real('cost_usd'),
  deliveredAt: ts('delivered_at'),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  uniqueIndex('uq_digest_period').on(t.userId, t.kind, t.periodStart),
]);

// ── 任务队列 ──────────────────────────────────────────────────
export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key'),
  payload: text('payload').notNull(),
  status: text('status').notNull().default('pending'),
  priority: integer('priority').notNull().default(0),
  runAfter: integer('run_after').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  lockedBy: text('locked_by'),
  lockedAt: integer('locked_at'),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [
  index('idx_jobs_pick').on(t.status, t.runAfter, t.priority, t.id),
  uniqueIndex('uq_jobs_dedupe').on(t.dedupeKey).where(
    sql`dedupe_key IS NOT NULL AND status IN ('pending','running')`,
  ),
]);

// ── 成本审计 ──────────────────────────────────────────────────
export const aiUsage = sqliteTable('ai_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  purpose: text('purpose').notNull(),
  model: text('model').notNull(),
  inTokens: integer('in_tokens'),
  outTokens: integer('out_tokens'),
  costUsd: real('cost_usd'),
  latencyMs: integer('latency_ms'),
  ok: bool('ok'),
  error: text('error'),
  createdAt: ts('created_at').notNull(),
}, (t) => [
  index('idx_usage_day').on(t.userId, t.createdAt),
]);

// ── RSSHub 缓存 ───────────────────────────────────────────────
export const rsshubCache = sqliteTable('rsshub_cache', {
  key: text('key').primaryKey(),
  payload: text('payload').notNull(),
  fetchedAt: ts('fetched_at').notNull(),
});

// ── 备份记录 ──────────────────────────────────────────────────
export const backupLog = sqliteTable('backup_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  path: text('path').notNull(),
  sizeBytes: integer('size_bytes'),
  schemaVer: integer('schema_ver').notNull(),
  ok: bool('ok'),
  error: text('error'),
  createdAt: ts('created_at').notNull(),
});

// ── RAG 会话 ──────────────────────────────────────────────────
export const chatSessions = sqliteTable('chat_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title'),
  createdAt: ts('created_at').notNull(),
});

export const chatMessages = sqliteTable('chat_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  citations: text('citations'),
  createdAt: ts('created_at').notNull(),
});

// 注意：entries_fts 是 FTS5 虚拟表，Drizzle 不支持 DDL，
// 在 migrations/0001_init.sql 里手写（见 PLAN §6.2）。
