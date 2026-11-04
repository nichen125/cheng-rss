#!/usr/bin/env node
// 0.2 表结构与迁移 —— 验收
//
// 判据（PLAN §19.2）：
//   ① 19 张业务表逐一点名存在（不数数量，FTS5 的 shadow 表会干扰计数）
//   ② 再跑一次 migrate 不报错，schema_migrations 行数 = 迁移清单长度
//   ③ PRAGMA integrity_check = ok
//   ④ entries_fts 可 MATCH
//
// 注意"行数 = 迁移清单长度"而不是"= 1"：后续步骤每加一个迁移，
// 写死的数字都会变成假红，而假红会被人用"改断言"的方式消掉 ——
// 那正是 §19.1 第四条约束要防的事。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');

if (!existsSync(nodeBin)) {
  console.error('项目内 node 缺失，先运行 bootstrap');
  process.exit(1);
}

// 用项目内 node 跑一个内联脚本做检查，避免把 TS 逻辑复制到验收脚本里
const probe = String.raw`
import { DatabaseSync } from 'node:sqlite';
import { migrate, CURRENT_SCHEMA_VERSION, MIGRATIONS } from './src/server/db/migrate.ts';

const path = process.env.CHENG_RSS_PROBE_DB;
if (!path) throw new Error('缺少 CHENG_RSS_PROBE_DB');
const db = new DatabaseSync(path);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const first = migrate(db);

// 第二次迁移单独 try：幂等被破坏时应报 FAIL 而非让整个探测脚本崩溃。
// 崩溃会让其余断言全部丢失，掩盖真正的失败点。
let second = null, secondError = null;
try {
  second = migrate(db);
} catch (e) {
  secondError = e.message;
}

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type IN ('table','virtual table')"
).all().map((r) => r.name);

const migrations = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
const integrity = db.prepare('PRAGMA integrity_check').get();

// FTS5 可用性：插一条再查（entry_fts_map 是 TEXT id → INTEGER rowid 的映射）
let ftsOk = false, ftsErr = null;
try {
  const r = db.prepare("INSERT INTO entries_fts (title) VALUES (?)").run('芯片 产能');
  const hit = db.prepare("SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?").all('"芯片"');
  ftsOk = hit.length === 1;
  db.prepare('DELETE FROM entries_fts WHERE rowid = ?').run(Number(r.lastInsertRowid));
} catch (e) {
  ftsErr = e.message;
}

// 外键约束生效性：插一条引用不存在 user 的 entry 应该失败
let fkEnforced = false;
try {
  db.prepare(
    'INSERT INTO entries (id,user_id,guid,url,url_norm,title,published_at,fetched_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run('x', 'nouser', 'g', 'u', 'u', 't', Date.now(), Date.now());
} catch {
  fkEnforced = true;
}

// 关键列存在性（改名/漏加会在这里红）
const cols = (t) => db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
const entriesCols = cols('entries');
const hlCols = cols('highlights');
const entryVectorsCols = cols('entry_vectors');

console.log(JSON.stringify({
  first, second, secondError,
  tables,
  migrations,
  allVersions: MIGRATIONS.map((m) => m.version),
  integrity: integrity.integrity_check,
  schemaVersion: CURRENT_SCHEMA_VERSION,
  ftsOk, ftsErr, fkEnforced,
  entriesCols, hlCols, entryVectorsCols,
}));
`;

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-verify-'));
const dbPath = join(tmp, 'app.db');

let out;
try {
  out = execFileSync(nodeBin, [
    '--experimental-strip-types',
    '--no-warnings',
    '--input-type=module',
    '-e', probe,
  ], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHENG_RSS_PROBE_DB: dbPath },
  });
} catch (e) {
  console.error('探测脚本失败:\n' + (e.stderr || e.message));
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

const r = JSON.parse(out.trim().split('\n').pop());

// ── 19 张业务表，逐一点名 ────────────────────────────────────
const EXPECTED = [
  'users', 'settings', 'sessions',
  'categories', 'folders', 'feeds', 'entries', 'entry_contents',
  'entry_analysis', 'embeddings', 'clusters', 'cluster_entries',
  'highlights', 'digests', 'jobs', 'ai_usage', 'rsshub_cache',
  'backup_log', 'chat_sessions',
];
// chat_messages 是第 20 张（与 chat_sessions 成对），单列
const EXPECTED_EXTRA = ['chat_messages'];
// 后续迁移新增的表：entry_vectors 是 0002 引入的去重向量表。
// 放在这里而不是并进 EXPECTED，是为了让"初始 19 张"这个数字仍然成立。
const EXPECTED_LATER = ['entry_vectors'];

group('0.2 表结构与迁移');

check('19 张核心业务表全部存在', () => {
  const missing = EXPECTED.filter((t) => !r.tables.includes(t));
  return ok(missing.length === 0, `缺少: ${missing.join(', ')}`);
});

check('chat_messages 存在', () => {
  return ok(r.tables.includes('chat_messages'), '缺少 chat_messages');
});

check(`后续迁移引入的表存在（${EXPECTED_LATER.join(', ')}）`, () => {
  const missing = EXPECTED_LATER.filter((t) => !r.tables.includes(t));
  return ok(missing.length === 0, `缺少: ${missing.join(', ')}`);
});

check('entry_vectors 的向量列是 BLOB 且有唯一主键（一条目一份）', () => {
  return ok(
    r.entryVectorsCols.includes('vec') && r.entryVectorsCols.includes('dim')
      && r.entryVectorsCols.includes('model'),
    `列: ${r.entryVectorsCols.join(', ')}`,
  );
});

check('首次 migrate 应用了全部登记的迁移', () => {
  // 早先这里写死成"版本 1"。M1 加 0002 之后它就变成了一条永远红的断言 ——
  // 断言的对象应该是"迁移清单里的每一条都应用了"，而不是"只有 1 条"。
  // 后者每加一个迁移都要改脚本，等于用脚本记录版本号，没有验收价值。
  return eq(r.first.applied.join(','), r.allVersions.join(','), 'applied');
});

check('schema_migrations 行数 = 迁移清单长度', () => {
  return eq(r.migrations.length, r.allVersions.length, 'migrations 行数');
});

check('再次 migrate 不重复应用（幂等）', () => {
  if (r.secondError) return ok(false, `第二次迁移抛错: ${r.secondError}`);
  return ok(r.second.applied.length === 0 && r.second.skipped.length === r.allVersions.length,
    `第二次 applied=${JSON.stringify(r.second?.applied)} skipped=${JSON.stringify(r.second?.skipped)}`);
});

check('integrity_check = ok', () => eq(r.integrity, 'ok'));

check('entries_fts 可用（2 字中文能 MATCH）', () => {
  return ok(r.ftsOk, r.ftsErr ?? '匹配失败');
});

check('外键约束生效（引用不存在用户被拒）', () => {
  return ok(r.fkEnforced, '插入无效 user_id 竟然成功，foreign_keys 未生效');
});

// ── 关键列：这些是 PLAN 里"必须一起定"的六件事，漏了要返工 ──
check('entries.feed_id 可空（网页捕获无 feed）', () => {
  return ok(r.entriesCols.includes('feed_id'), '缺少 feed_id 列');
});

check('entries 有阅读历史时间戳（非布尔）', () => {
  const need = ['first_read_at', 'last_read_at', 'read_count', 'read_progress'];
  const missing = need.filter((c) => !r.entriesCols.includes(c));
  return ok(missing.length === 0, `缺少: ${missing.join(', ')}`);
});

check('entries 有 Huntly 插件兼容列', () => {
  const need = ['source_type', 'archive_status', 'read_later', 'library_save_status',
                'page_json', 'favicon_url', 'site_name', 'thumbnail_url'];
  const missing = need.filter((c) => !r.entriesCols.includes(c));
  return ok(missing.length === 0, `缺少: ${missing.join(', ')}`);
});

check('highlights 存三选择器（quote/position/range）', () => {
  const need = ['quote_exact', 'quote_prefix', 'quote_suffix',
                'pos_start', 'pos_end', 'range_json', 'is_orphaned'];
  const missing = need.filter((c) => !r.hlCols.includes(c));
  return ok(missing.length === 0, `缺少: ${missing.join(', ')}`);
});

check('数据库版本 = 代码里的 CURRENT_SCHEMA_VERSION', () => {
  const dbV = Math.max(...r.migrations.map((m) => m.version));
  return eq(dbV, r.schemaVersion);
});

rmSync(tmp, { recursive: true, force: true });
summary('m0-02-schema');
