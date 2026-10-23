#!/usr/bin/env node
// 0.7 检索层 —— 验收
//
// 判据（PLAN §19.2 + §5.6）：
//   ① 10 万条下「芯片」（2 字中文）有结果
//   ② 无命中查询 < 5ms
//   ③ 「半导X体」不误命中「半导体」
//   ④ 时间线 < 5ms、未读数 < 3ms
//   ⑤（补充）bigram 切分正确性单元测试
//   ⑥（补充）索引增量更新（改标题后旧词查不到、新词查得到）
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, lt, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');

if (!existsSync(nodeBin)) {
  console.error('项目内 node 缺失，先运行 bootstrap');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m007-'));
const dataDir = join(tmp, 'data');

const probe = String.raw`
import { mkdirSync } from 'node:fs';
import { openDb } from './src/server/db/client.ts';
import { migrate } from './src/server/db/migrate.ts';
import { bigrams, toIndexText, toMatchQuery } from './src/server/search/bigram.ts';
import { indexEntry, searchKeyword, rebuildIndex, removeIndex } from './src/server/search/index.ts';

const dataDir = process.env.AI_RSS_DATA_DIR;
const mode = process.env.AI_RSS_MODE;
mkdirSync(dataDir, { recursive: true });
const h = openDb({ dataDir });
migrate(h.db);

if (mode === 'units') {
  // ── ⑤ bigram 单元测试 ────────────────────────────────
  const cases = [];
  const add = (name, actual, expected) => cases.push({ name, actual, expected, pass: actual === expected });

  add('中文两字切分', bigrams('芯片').join(' '), '芯片');
  add('中文三字切分', bigrams('半导体').join(' '), '半导 导体');
  add('中文五字切分', bigrams('台积电芯片').join(' '), '台积 积电 电芯 芯片');
  add('单字保持', bigrams('芯').join(' '), '芯');
  add('英文小写', bigrams('GPU').join(' '), 'gpu');
  add('中英混合', bigrams('芯片GPU').join(' '), '芯片 gpu');
  add('标点被丢弃', bigrams('芯片，裁员').join(' '), '芯片 裁员');
  add('查询侧三字用短语', toMatchQuery('半导体'), '"半导 导体"');
  add('查询侧多词 AND', toMatchQuery('芯片 裁员'), '"芯片" AND "裁员"');
  add('查询侧英文', toMatchQuery('GPU'), '"gpu"');
  add('空查询', toMatchQuery('   '), '');

  // ── ⑥ 索引增量更新 ───────────────────────────────────
  h.db.prepare("INSERT INTO users (id, created_at, email) VALUES ('u1', ?, 'a@b.c')").run(Date.now());
  const ins = h.db.prepare(
    'INSERT INTO entries (id,user_id,guid,url,url_norm,title,published_at,fetched_at) VALUES (?,?,?,?,?,?,?,?)'
  );
  const now = Date.now();
  ins.run('e1', 'u1', 'g1', 'https://x/1', 'x/1', '台积电芯片产能紧张', now, now);
  indexEntry(h.db, 'e1', { title: '台积电芯片产能紧张' });

  const hitBefore = searchKeyword(h.db, 'u1', '芯片').length;
  const hitOldWord = searchKeyword(h.db, 'u1', '产能').length;

  // 改标题后重建这条索引
  ins.run('e2', 'u1', 'g2', 'https://x/2', 'x/2', '英伟达发布新卡', now, now);
  indexEntry(h.db, 'e1', { title: '英伟达发布新卡' });
  const hitAfterOld = searchKeyword(h.db, 'u1', '芯片').length;
  const hitAfterNew = searchKeyword(h.db, 'u1', '英伟达').length;

  // 删除索引
  removeIndex(h.db, 'e1');
  const hitAfterRemove = searchKeyword(h.db, 'u1', '英伟达').length;

  h.close();
  console.log(JSON.stringify({ cases, hitBefore, hitOldWord, hitAfterOld, hitAfterNew, hitAfterRemove }));
  process.exit(0);
}

if (mode === 'perf') {
  // ── 造 10 万条，测性能红线 ───────────────────────────
  h.db.prepare("INSERT INTO users (id, created_at, email) VALUES ('u1', ?, 'a@b.c')").run(Date.now());

  const words = ['芯片','半导体','出口管制','业绩','发布会','裁员','融资','大模型',
                 '推理','训练','开源','数据集','英伟达','台积电','供应链','产能'];
  const tail = ['紧张','升级','下滑','增长','完成','公布','影响','扩大'];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };

  const N = Number(process.env.AI_RSS_N || 100000);
  const ins = h.db.prepare(
    'INSERT INTO entries (id,user_id,guid,url,url_norm,title,excerpt,published_at,fetched_at,is_read,last_read_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  const now = Date.now();

  const t0 = performance.now();
  h.db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < N; i++) {
    const w1 = words[rnd() % words.length], w2 = tail[rnd() % tail.length];
    const title = w1 + w2 + '第' + i + '期';
    const excerpt = w1 + w2 + '，' + words[rnd() % words.length] + '相关报道';
    const readAt = i % 4 === 0 ? null : now - i * 60000;
    ins.run('e' + i, 'u1', 'g' + i, 'https://x/' + i, 'x/' + i, title, excerpt,
      now - i * 60000, now, readAt ? 1 : 0, readAt);
    // 直接写 FTS（模拟索引）
    const txt = toIndexText(title, excerpt);
    const r = h.db.prepare('INSERT INTO entries_fts (title) VALUES (?)').run(txt);
    h.db.prepare('INSERT INTO entry_fts_map (entry_id, fts_rowid) VALUES (?,?)')
      .run('e' + i, Number(r.lastInsertRowid));
  }
  h.db.exec('COMMIT');
  const buildMs = performance.now() - t0;

  h.db.exec("ANALYZE");
  h.db.exec("PRAGMA optimize");

  const bench = (fn, runs = 20) => {
    fn(); // 预热
    const t = performance.now();
    for (let i = 0; i < runs; i++) fn();
    return (performance.now() - t) / runs;
  };

  const qHit = h.db.prepare(
    "SELECT m.entry_id FROM entries_fts f JOIN entry_fts_map m ON m.fts_rowid=f.rowid JOIN entries e ON e.id=m.entry_id WHERE entries_fts MATCH ? AND e.user_id=? LIMIT 30"
  );
  const qTimeline = h.db.prepare(
    'SELECT id FROM entries WHERE user_id=? ORDER BY published_at DESC LIMIT 30'
  );
  const qUnread = h.db.prepare('SELECT COUNT(*) c FROM entries WHERE user_id=? AND is_read=0');
  const qHistory = h.db.prepare(
    'SELECT id FROM entries WHERE user_id=? AND last_read_at IS NOT NULL ORDER BY last_read_at DESC LIMIT 30'
  );

  const matchChip = toMatchQuery('芯片');
  const matchNone = toMatchQuery('完全不存在的词组');

  const msHit = bench(() => qHit.all(matchChip, 'u1'));
  const msNone = bench(() => qHit.all(matchNone, 'u1'));
  const msTimeline = bench(() => qTimeline.all('u1'));
  const msUnread = bench(() => qUnread.all('u1'));
  const msHistory = bench(() => qHistory.all('u1'));

  const hitCount = qHit.all(matchChip, 'u1').length;

  // 反例：造两条只有「半导X体」的文本，验证不会被「半导体」命中
  h.db.prepare(
    'INSERT INTO entries (id,user_id,guid,url,url_norm,title,published_at,fetched_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run('bad1', 'u1', 'gbad1', 'https://x/b1', 'x/b1', '半导X体产业观察', now, now);
  const rBad = h.db.prepare('INSERT INTO entries_fts (title) VALUES (?)')
    .run(toIndexText('半导X体产业观察'));
  h.db.prepare('INSERT INTO entry_fts_map (entry_id, fts_rowid) VALUES (?,?)')
    .run('bad1', Number(rBad.lastInsertRowid));

  const badHitRows = qHit.all(toMatchQuery('半导体'), 'u1');
  const badHit = badHitRows.some((r) => r.entry_id === 'bad1');

  h.close();
  console.log(JSON.stringify({
    N, buildMs,
    msHit, msNone, msTimeline, msUnread, msHistory,
    hitCount, badHit,
  }));
  process.exit(0);
}
`;

const child = spawn(nodeBin, [
  '--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', probe,
], {
  cwd: root,
  env: { ...process.env, AI_RSS_DATA_DIR: dataDir, AI_RSS_MODE: 'units' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function collect(p) {
  return new Promise((res) => {
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      if (code !== 0) {
        console.error(`探测失败 (${code}):\n${err.slice(0, 1000)}`);
        res(null);
        return;
      }
      try { res(JSON.parse(out.trim().split('\n').pop())); }
      catch { console.error(`输出无法解析:\n${out.slice(0, 500)}`); res(null); }
    });
  });
}

group('0.7 检索层');

const units = await collect(child);
if (units) {
  for (const c of units.cases) {
    check(`bigram: ${c.name}`, () => eq(c.actual, c.expected));
  }
  check('索引：新写入即可搜到', () => eq(units.hitBefore, 1));
  check('索引：改标题后旧词查不到（无残留）', () => eq(units.hitAfterOld, 0));
  check('索引：改标题后新词查得到', () => eq(units.hitAfterNew, 1));
  check('索引：删除后查不到', () => eq(units.hitAfterRemove, 0));
}

// ── 性能红线 ────────────────────────────────────────────────
const perfTmp = mkdtempSync(join(tmpdir(), 'ai-rss-m007perf-'));
const perfDir = join(perfTmp, 'data');
const perfChild = spawn(nodeBin, [
  '--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', probe,
], {
  cwd: root,
  env: { ...process.env, AI_RSS_DATA_DIR: perfDir, AI_RSS_MODE: 'perf', AI_RSS_N: '100000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const perf = await collect(perfChild);

if (perf) {
  process.stdout.write(`  \u001b[90m（10 万条建库 ${Math.round(perf.buildMs)}ms）\u001b[0m\n`);

  check('10 万条下「芯片」有结果（2 字中文必须能查）', () => {
    return ok(perf.hitCount > 0, `返回 ${perf.hitCount} 条`);
  });

  check('关键词查询 < 5ms（红线）', () => lt(perf.msHit, 5, `${perf.msHit.toFixed(2)}ms`));
  check('无命中查询 < 5ms（红线）', () => lt(perf.msNone, 5, `${perf.msNone.toFixed(2)}ms`));
  check('时间线查询 < 5ms（红线）', () => lt(perf.msTimeline, 5, `${perf.msTimeline.toFixed(2)}ms`));
  check('未读数 COUNT < 3ms（红线）', () => lt(perf.msUnread, 3, `${perf.msUnread.toFixed(2)}ms`));
  check('阅读历史 < 5ms', () => lt(perf.msHistory, 5, `${perf.msHistory.toFixed(2)}ms`));

  check('「半导X体」不被「半导体」误命中', () => {
    return ok(perf.badHit === false, '不连续文本被误判为匹配，短语查询失效');
  });
} else {
  check('性能探测可运行', () => ok(false, '探测脚本失败'));
}

rmSync(tmp, { recursive: true, force: true });
rmSync(perfTmp, { recursive: true, force: true });
summary('m0-07-search');
