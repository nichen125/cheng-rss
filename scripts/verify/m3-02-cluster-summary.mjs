#!/usr/bin/env node
// 3.2 簇级归纳 —— 验收
//
// 判据（PLAN §19.5 3.2 + §9.2 / §9.3）：
//   ① 输出含 consensus / conflicts
//   ② 单来源簇标注「单一来源，待验证」
//   ③ 输入 3 篇时 conflicts 为空而非编造
//   ④ 编造的来源被剔除（模型写"据媒体报道"、"新浪科技频道"这类不存在的源）
//   ⑤ 只引用一个来源的"分歧"不算分歧（无法交叉验证）
//   ⑥ 喂给模型的输入能区分"第几篇 / 来源名 / 标题 / 摘要"
//   ⑦ 归纳失败有兜底标题，且不是「事件 1」这种无信息量字符串
//   ⑧ 整窗重算：同一窗口重复跑不累积旧簇
//
// ②③ 是一对：只测 ② 的话，一个永远返回 prompted 空 conflicts 的实现
// 也能过；只测 ③ 的话，单来源时的标注就没人管。两者必须同时在场。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, gt, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const {
  buildClusterUser, summarizeCluster, describeSingleSource, SINGLE_SOURCE_NOTE,
  saveCluster, fallbackTitle, clearWindowClusters, MAX_ENTRIES_PER_CLUSTER,
  CLUSTER_SYSTEM,
} = await import('../../src/server/cluster/summarize.ts');
const { openDb } = await import('../../src/server/db/client.ts');
const { migrate } = await import('../../src/server/db/migrate.ts');

const UID = 'u_cs';

function member(i, over = {}) {
  return {
    entryId: `e${i}`,
    sourceName: over.sourceName ?? `来源${i}`,
    title: over.title ?? `标题${i}：长江存储 232 层 QLC 量产`,
    summary: over.summary ?? `摘要${i}：单颗 1Tb，接口 2400MT/s。`,
    bodyText: over.bodyText ?? `正文${i}：${'内容'.repeat(60)}`,
    publishedAt: Date.now() - i * 1000,
  };
}

/** 假客户端：可编程返回体 */
function fakeClient(payload, opts = {}) {
  const calls = [];
  return {
    calls,
    config: { models: { strong: 'mock-strong' } },
    async chatJson(o) {
      calls.push(o);
      if (opts.fail) {
        return { ok: false, usage: null, failure: { kind: 'schema', message: 'mock 失败', retryable: false } };
      }
      return {
        ok: true, raw: '{}',
        usage: { purpose: 'cluster', model: 'mock-strong', inTokens: 100, outTokens: 50, costUsd: 0.001, latencyMs: 1, ok: true },
        data: typeof payload === 'function' ? payload(o) : payload,
      };
    },
  };
}

const GOOD = {
  title: '长江存储 QLC 量产',
  summary: '长江存储宣布 232 层 QLC 闪存量产，单颗 1Tb。三家媒体均确认容量与速率，对位密度的说法略有出入。',
  key_points: ['单颗容量 1Tb', '接口速率 2400MT/s', '四季度出货'],
  consensus: ['容量 1Tb', '接口 2400MT/s'],
  conflicts: [{ claim: '位密度提升 40% 还是 45%', sources: ['来源1', '来源2'] }],
};

// ── ⑥ 输入构造 ──────────────────────────────────────────────
group('3.2 簇归纳 · 输入');

{
  const members = [member(1), member(2), member(3)];
  const text = buildClusterUser(members, 3);
  check('输入标明每篇的序号', () => ok(
    text.includes('第 1 篇') && text.includes('第 2 篇') && text.includes('第 3 篇'),
    text.slice(0, 160),
  ));
  check('输入标明每篇的来源名（conflicts.sources 要按它填）', () => ok(
    text.includes('来源：来源1') && text.includes('来源：来源3'), text.slice(0, 200),
  ));
  check('输入带标题与摘要（不只有正文）', () => ok(
    /标题：标题1/.test(text) && /摘要：摘要1/.test(text), text.slice(0, 200),
  ));
  check('输入声明总篇数（模型据此判断能不能谈"分歧"）', () =>
    ok(/共 3 篇报道/.test(text), text.slice(0, 80)));
}

{
  // 超过上限时截断，但要说清"还有几篇没列"
  const many = Array.from({ length: 15 }, (_, i) => member(i));
  const text = buildClusterUser(many, 15);
  const listed = (text.match(/【第 \d+ 篇】/g) ?? []).length;
  check(`最多喂 ${MAX_ENTRIES_PER_CLUSTER} 篇（实际列出 ${listed} 篇）`, () =>
    eq(listed, MAX_ENTRIES_PER_CLUSTER));
  check('截断后明确写出"其余 N 篇未列出"（否则模型以为只有 8 篇就敢下结论）', () =>
    ok(/其余 7 篇/.test(text), text.slice(0, 120)));
}

{
  // 单篇正文过长要截断
  const long = member(1, { bodyText: '长'.repeat(5000) });
  const text = buildClusterUser([long], 1);
  check('单篇正文被截断（不是把 5000 字全塞进去）', () => ok(
    text.length < 3000 && /已截断/.test(text), `长度 ${text.length}`,
  ));
}

// ── ① 正常归纳 ──────────────────────────────────────────────
group('3.2 簇归纳 · 正常路径');

{
  const c = fakeClient(GOOD);
  const r = await summarizeCluster(c, [member(1), member(2), member(3)]);
  check('归纳成功且带 consensus', () => ok(
    r.ok && Array.isArray(r.summary?.consensus) && r.summary.consensus.length > 0,
    JSON.stringify(r.summary?.consensus),
  ));
  check('带 conflicts 且 claim 非空', () => ok(
    Array.isArray(r.summary?.conflicts) && r.summary.conflicts.length > 0
    && r.summary.conflicts.every((x) => x.claim && x.sources.length >= 2),
    JSON.stringify(r.summary?.conflicts),
  ));
  check('调模型时 purpose=cluster（成本要归到聚类而不是分析）', () =>
    eq(c.calls[0]?.purpose, 'cluster'));
  check('整条 user 都是抓取内容，必须带 wrapUser（防提示注入）', () =>
    eq(c.calls[0]?.wrapUser, true));
  check('提示词里明确要求"只有一篇时必须留空 conflicts"', () =>
    ok(/只有一篇时\*\*必须\*\*留空/.test(CLUSTER_SYSTEM), CLUSTER_SYSTEM.slice(0, 200)));
}

// ── ② 单来源 ────────────────────────────────────────────────
group('3.2 簇归纳 · 单来源');

check('describeSingleSource(1) 返回「单一来源，待验证」', () =>
  eq(describeSingleSource(1), SINGLE_SOURCE_NOTE));
check('describeSingleSource(0) 也标注（0 个来源同样是待验证）', () =>
  eq(describeSingleSource(0), SINGLE_SOURCE_NOTE));
check('describeSingleSource(2) 返回 null（多来源不标注）', () =>
  eq(describeSingleSource(2), null));
check('describeSingleSource(3) 返回 null', () => eq(describeSingleSource(3), null));

{
  // 模型在单来源时"礼貌性"编了一条分歧 —— 必须被抹掉
  const c = fakeClient({
    ...GOOD,
    conflicts: [{ claim: '编造的分歧', sources: ['来源1', '来源2'] }],
  });
  const r = await summarizeCluster(c, [member(1)]);
  check('单来源时 conflicts 被强制清空（模型会凭空编分歧）', () =>
    eq(r.summary?.conflicts?.length, 0));
  check('被编造的来源记进 droppedSources（可观测，不是静默丢）', () =>
    gt(r.droppedSources.length, 0, 'droppedSources 数量'));
  check('单来源时 summary 其余字段保留（不是整条作废）', () =>
    ok(r.ok && Boolean(r.summary?.summary) && (r.summary?.consensus?.length ?? 0) > 0,
      JSON.stringify(r.summary)?.slice(0, 120)));
}

// ── ③ 三篇但确实没有分歧 ────────────────────────────────────
group('3.2 簇归纳 · 无分歧');

{
  const c = fakeClient({ ...GOOD, conflicts: [] });
  const r = await summarizeCluster(c, [member(1), member(2), member(3)]);
  check('三篇报道说法一致 → conflicts 是空数组（不是编造）', () =>
    ok(r.ok && Array.isArray(r.summary?.conflicts) && r.summary.conflicts.length === 0,
      JSON.stringify(r.summary?.conflicts)));
  check('空 conflicts 时 consensus 仍然要有（一致的事实是有的）', () =>
    gt(r.summary?.consensus?.length ?? 0, 0, 'consensus 条数'));
}

// ── ④ 编造来源被剔除 ────────────────────────────────────────
group('3.2 簇归纳 · 来源校验');

{
  const c = fakeClient({
    ...GOOD,
    conflicts: [
      { claim: '真实的两个来源', sources: ['来源1', '来源2'] },
      { claim: '一个是编的', sources: ['来源1', '据多家媒体报道'] },
      { claim: '把来源名写错', sources: ['新浪科技频道', '来源2'] },
    ],
  });
  const r = await summarizeCluster(c, [member(1), member(2), member(3)]);
  check('只保留来源全部真实的 disputes', () =>
    ok(r.summary.conflicts.length === 1
      && r.summary.conflicts[0].claim === '真实的两个来源',
      JSON.stringify(r.summary.conflicts)));
  check('编造的来源被记进 droppedSources', () => ok(
    r.droppedSources.includes('据多家媒体报道') && r.droppedSources.includes('新浪科技频道'),
    JSON.stringify(r.droppedSources),
  ));
  check('保留的 disputes 里 sources 已过滤成只剩真实来源', () =>
    ok(r.summary.conflicts.every((x) => x.sources.every((s) => ['来源1', '来源2'].includes(s))),
      JSON.stringify(r.summary.conflicts)));
}

{
  // ⑤ 只引用一个来源的"分歧"：无法交叉验证，整条剔除
  const c = fakeClient({
    ...GOOD,
    conflicts: [{ claim: '只有一个来源说的', sources: ['来源1'] }],
  });
  const r = await summarizeCluster(c, [member(1), member(2)]);
  check('只引用一个来源的分歧被剔除（无法交叉验证）', () =>
    eq(r.summary.conflicts.length, 0));
}

// ── ④ 归纳失败 ──────────────────────────────────────────────
group('3.2 簇归纳 · 失败兜底');

{
  const c = fakeClient(null, { fail: true });
  const r = await summarizeCluster(c, [member(1), member(2)]);
  check('归纳失败返回 ok=false 且带原因（不抛）', () =>
    ok(!r.ok && /schema/.test(String(r.failure)), String(r.failure)));
  check('失败时 summary 为 null（不返回半截结构）', () => eq(r.summary, null));
}

{
  const members = [member(1, { title: '长江存储 232 层 QLC 闪存正式量产，单颗容量 1Tb' })];
  check('失败兜底标题用代表条目的原标题（不是「事件 1」）', () => {
    const t = fallbackTitle(members);
    return ok(t.includes('长江存储') && !/^事件/.test(t), t);
  });
  check('超长标题被截到 60 字 + 省略号', () => {
    const t = fallbackTitle([member(1, { title: '长'.repeat(200) })]);
    return ok(t.length <= 61 && t.endsWith('…'), `长度 ${t.length}`);
  });
  check('没有任何成员时兜底标题也不是空的', () => ok(
    fallbackTitle([]).length > 0, fallbackTitle([]),
  ));
}

// ── ⑧ 落库与整窗重算 ────────────────────────────────────────
group('3.2 簇归纳 · 落库');

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m302-'));
const h = openDb({ dataDir: tmp });
migrate(h.db);
const DB = h.db;
DB.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
  .run(UID, 'cs@t.local', 'CS', 'owner', Date.now());

/** 造几条真条目（cluster_entries 有外键） */
function addEntries(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `ce_${i}`;
    ids.push(id);
    DB.prepare(`INSERT INTO entries (id, user_id, feed_id, guid, url, url_norm, title,
        published_at, fetched_at, stage) VALUES (?,?,NULL,?,?,?,?,?,?,'analyzed')`)
      .run(id, UID, `g-${id}`, `https://e.test/${id}`, `https://e.test/${id}`, `标题${i}`, Date.now(), Date.now());
  }
  return ids;
}

const ids = addEntries(6);
const WINDOW = { start: 1_000_000, end: 9_000_000 };
const cluster = {
  memberIds: ids.slice(0, 4),
  centroid: new Float32Array(256).fill(0.06),
  cohesion: 0.7,
  entryCount: 4,
  sourceCount: 3,
  heat: 55,
};

{
  const id = saveCluster(DB, UID, cluster, GOOD, [member(1), member(2), member(3), member(4)], WINDOW, 111);
  const row = DB.prepare('SELECT * FROM clusters WHERE id = ?').get(id);
  check('簇写入 clusters 表', () => ok(Boolean(row), '没有行'));
  check('title/summary/key_points/consensus/conflicts 都落了', () => {
    const okAll = row.title === GOOD.title && row.summary === GOOD.summary
      && JSON.parse(row.key_points).length === 3
      && JSON.parse(row.consensus).length === 2
      && JSON.parse(row.conflicts).length === 1;
    return ok(okAll, JSON.stringify({ t: row.title, kp: row.key_points }));
  });
  check('entry_count / source_count / heat 与聚类结果一致', () => ok(
    Number(row.entry_count) === 4 && Number(row.source_count) === 3 && Number(row.heat) === 55,
    `${row.entry_count}/${row.source_count}/${row.heat}`,
  ));
  check('centroid 存成 BLOB 且字节 = 256×4', () =>
    eq(Number(row.centroid.byteLength ?? row.centroid.length), 256 * 4));
  check('cluster_entries 落了全部成员，且恰好一个 is_primary', () => {
    const rows = DB.prepare('SELECT is_primary FROM cluster_entries WHERE cluster_id = ?').all(id);
    return ok(rows.length === 4 && rows.filter((r) => Number(r.is_primary) === 1).length === 1,
      `成员 ${rows.length}，primary ${rows.filter((r) => Number(r.is_primary) === 1).length}`);
  });
}

{
  // 整窗重算：清掉再写，不累积
  const cleared = clearWindowClusters(DB, UID, WINDOW.start);
  check('clearWindowClusters 删掉了该窗口的旧簇', () => eq(cleared, 1));
  check('删簇后 cluster_entries 跟着没了（级联）', () =>
    eq(Number(DB.prepare('SELECT COUNT(*) c FROM cluster_entries').get().c), 0));
  check('别的窗口的簇不受影响', () => {
    saveCluster(DB, UID, cluster, GOOD, [member(1)], { start: 5, end: 6 }, 222);
    clearWindowClusters(DB, UID, WINDOW.start);
    const left = DB.prepare('SELECT COUNT(*) c FROM clusters').get();
    return eq(Number(left.c), 1);
  });
}

{
  // 失败兜底落库：summary 为 null 时 title 用代表条目标题
  clearWindowClusters(DB, UID, 77);
  const id = saveCluster(
    DB, UID,
    { ...cluster, memberIds: ids.slice(0, 2), entryCount: 2, sourceCount: 1 },
    null, [member(1, { title: '兜底用的原标题' })], { start: 77, end: 88 }, 333,
  );
  const row = DB.prepare('SELECT title, summary, consensus FROM clusters WHERE id=?').get(id);
  check('归纳失败照样落库（简报需要"标题 + 来源数"）', () => ok(Boolean(row), '没有行'));
  check('失败时 title 用代表条目标题、summary/consensus 为 NULL', () => ok(
    row.title === '兜底用的原标题' && row.summary === null && row.consensus === null,
    JSON.stringify(row),
  ));
}

h.close();
rmSync(tmp, { recursive: true, force: true });

summary('m3-02-cluster-summary');
process.exitCode = process.exitCode ?? 0;
