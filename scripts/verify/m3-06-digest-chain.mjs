#!/usr/bin/env node
// 简报链路回归验收（v2.2 缺陷修复）。
//
// ## 为什么需要这个脚本
//
// 3.1~3.5 的验收全绿时，简报功能**在生产里从来没成功过一次**。
// 原因是既有断言全部停在"函数能返回"这一层，而没有任何一条真的跑过
// `runDigest` 的主链（有内容 → 逐簇归纳 → 生成 → 落库 → 判定今天已生成）。
// m3-04 确实调了 runDigest，但它只走两条**在调模型之前就返回**的路径
// （没 key、窗口没条目），于是主链上的四个缺陷一个都没被碰到。
//
// ## 四个缺陷（每个都先复现过，见 PLAN §9.6）
//
//   ① `loadMembers` 查 `e.content_text` / `e.feed_content_text` —— 这两列
//     从 0001 起就不存在（正文在 `entry_contents.html`，gzip BLOB）。
//      症状：runDigest 在有内容时抛 `no such column`，被 job handler 吞成
//      "简报未生成"，digest_attempts 里连一行都不落（因为抛在 recordAttempt
//      之前），于是退避机制也不生效。
//   ② `saveDigest` 的 INSERT 不写 `day_key` → 落库后 day_key 是 NULL。
//      `digestDue` / `digestStatus` 都按 day_key 判"今天做过没"，于是：
//        · 调度器判定"今天还没生成"，**每分钟**重跑一次完整流程
//          （每次 = 每簇一次归纳 + 一次生成，十几次模型调用）
//        · UI 永远显示 pending「正在准备今天的简报」
//        · 唯一索引 `uq_digest_day (user_id, kind, day_key)` 对 NULL 不生效，
//          所以同一天会落**多份**简报（每天一条，永不覆盖）
//   ③ 生成成功也记 `recordAttempt(ok=true)`，但 ② 让 digestDue 不认它。
//   ④ 「现在生成」成功后再点一次，本该覆盖同一天那份，实际是新增一份。
//
// ## 断言的写法
//
// 每条都直接查**库里的产物**与**判定函数在生成之后的返回值**，
// 不查"代码里有没有某个字段" —— 那样 ② 这种"字段在、但没写进 INSERT"
// 的缺陷照样能过。
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
void root;

const { openDb } = await import('../../src/server/db/client.ts');
const { migrate } = await import('../../src/server/db/migrate.ts');
const { packText } = await import('../../src/server/db/text-blob.ts');
const { packVec } = await import('../../src/server/dedupe/cosine.ts');
const { runDigest } = await import('../../src/server/digest/run.ts');
const {
  digestDue, digestStatus, parseDigestConfig, localDayStart,
} = await import('../../src/server/digest/schedule.ts');
const { saveDigest, localDayRange } = await import('../../src/server/digest/index.ts');
const { resetAiCache } = await import('../../src/server/ai/service.ts');

// ── mock 上游 ────────────────────────────────────────────────
// 按 system 分流：簇归纳要 ClusterSummary，简报要 DigestBody。
// 不分流的话簇归纳会拿到简报的 JSON，schema 校验失败，
// 而那个失败看起来会像"实现坏了"。
const calls = [];
const chatBody = (content) => ({
  id: 'x', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
});
const CLUSTER_JSON = JSON.stringify({
  title: '存储芯片量产',
  summary: '两家公司同日宣布 232 层闪存量产，容量与速率一致，对位密度提升幅度说法略有出入。',
  key_points: ['232 层堆叠', '单颗 1Tb', '四季度出货'],
  consensus: ['232 层堆叠'],
  conflicts: [{ claim: '位密度提升 40% 还是 45%', sources: ['源A', '源B'] }],
});
const digestJson = (ids) => JSON.stringify({
  title: '这一天的存储与算力',
  highlights: ['闪产量产', '算力扩容', '监管新规'],
  body_md: '## 存储\n两家公司同日宣布量产。' + ids.map((i) => `{{cite:${i}}}`).join('')
    + '\n\n## 算力\n扩容计划落地。' + (ids[0] ? `{{cite:${ids[0]}}}` : ''),
  worth_reading: ids.slice(0, 1),
});

const srv = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += String(d); });
  req.on('end', () => {
    if (!String(req.url).endsWith('/chat/completions')) { res.writeHead(404); return res.end('no'); }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    const sys = String(body.messages?.[0]?.content ?? '');
    const isCluster = /多源情报编辑/.test(sys);
    calls.push({ kind: isCluster ? 'cluster' : 'digest', bytes: raw.length });
    const content = isCluster ? CLUSTER_JSON : digestJson(['cl_1', 'cl_2']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(chatBody(content)));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const AI_PORT = srv.address().port;

// ── 库：两簇四篇 ───────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m3fix-'));
const h = openDb({ dataDir: tmp });
migrate(h.db);
const db = h.db;
const UID = 'u_fix';
const now = Date.now();
db.prepare('INSERT INTO users (id,email,name,role,created_at) VALUES (?,?,?,?,?)')
  .run(UID, 'fix@t.local', 'FIX', 'owner', now);

for (const [id, title] of [['f_a', '源A'], ['f_b', '源B']]) {
  db.prepare(`INSERT INTO feeds (id,user_id,folder_id,sort,url,title,status,next_fetch_at)
    VALUES (?,?,NULL,0,?,?,'active',0)`).run(id, UID, `http://x/${id}`, title);
}
for (let i = 0; i < 4; i++) {
  const id = `e_${i}`;
  db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,title,published_at,fetched_at,
      excerpt,content_hash,stage,is_read,is_starred,is_hidden,read_later,read_count,highlight_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'extracted',0,0,0,0,0,0)`)
    .run(id, UID, i % 2 === 0 ? 'f_a' : 'f_b', id, `http://x/${id}`, `http://x/${id}`,
      `标题${i}`, now - 3600_000, now, '摘要', `h${i}`);
  db.prepare('INSERT INTO entry_contents (entry_id, html, extracted_by) VALUES (?,?,?)')
    .run(id, packText(`<p>正文${i}：${'存储芯片量产内容。'.repeat(80)}</p>`), 'test');
  db.prepare(`INSERT INTO entry_analysis (entry_id, summary, key_points, category_id, topics, entities,
      importance, tier, novelty, sentiment, model, prompt_version, created_at)
    VALUES (?,?,?,NULL,?,?,?,'worth',?,?,?,?,?)`)
    .run(id, `摘要${i}`, '[]', '[]', '{}', 70, 50, 'neutral', 'mock', 'v1', now);
  const v = new Float32Array(8);
  if (i < 2) { v[0] = 1; v[1] = 0; } else { v[0] = 0; v[1] = 1; }
  v[2] = 0.1;
  db.prepare('INSERT INTO entry_vectors (entry_id, dim, vec, model, created_at) VALUES (?,?,?,?,?)')
    .run(id, v.length, packVec(v), 'hash256', now);
}
db.prepare('INSERT OR REPLACE INTO settings (user_id, digest_config) VALUES (?,?)')
  .run(UID, JSON.stringify({ enabled: true, at: '00:00' }));

const ctx = {
  cfg: {
    dataDir: tmp, port: 0, host: '127.0.0.1',
    ai: {
      baseURL: `http://127.0.0.1:${AI_PORT}/v1`, apiKeyEnv: 'M3FIX_KEY',
      models: { fast: 'f', strong: 's', embed: 'e' },
      budget: { dailyUsd: 0, monthlyUsd: 0 },
    },
  },
  dbh: h, version: 'test', startedAt: now,
};
process.env.M3FIX_KEY = 'sk-fix';
resetAiCache();

const CFG = parseDigestConfig({ enabled: true, at: '00:00' });

// ── ① 主链能不能跑完 ────────────────────────────────────────
group('简报主链 · 有内容时');
{
  let r = null;
  let thrown = null;
  try {
    r = await runDigest(ctx, { userId: UID, manual: true, now });
  } catch (e) {
    thrown = e.message;
  }
  check('① 有内容时 runDigest 不抛异常（loadMembers 不再查不存在的列）',
    () => ok(thrown === null, `抛了：${thrown}`));
  check('① 有内容时真的生成了简报', () => ok(r?.ok === true, JSON.stringify(r)));
  check('① 上游真被调用了（不是空跑出来的 ok）', () => ok(calls.length >= 3,
    `调用 ${calls.length} 次：${JSON.stringify(calls)}`));
  check('① 每簇一次归纳 + 最后一次生成（2 簇 = 3 次）', () => ok(
    calls.filter((c) => c.kind === 'cluster').length === 2
    && calls.filter((c) => c.kind === 'digest').length === 1,
    JSON.stringify(calls),
  ));

  // ── ② day_key 必须落库 ──────────────────────────────────
  const row = db.prepare(
    'SELECT id, day_key, period_start FROM digests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(UID);
  check('② 落库时写了 day_key（不是 NULL —— 否则去重与调度判定全失效）', () => ok(
    row !== undefined && row.day_key !== null && row.day_key !== undefined,
    JSON.stringify(row),
  ));
  check('② day_key 就是本地当天 00:00', () => eq(Number(row?.day_key), localDayStart(now)));

  // ── ③ 生成之后调度器必须认「今天已做」 ─────────────────
  const dueAfter = digestDue(db, UID, CFG, now + 60_000);
  check('③ 生成 1 分钟后 digestDue 说「今天已生成」（否则每分钟重跑一遍全部模型调用）',
    () => ok(!dueAfter.due && /已生成/.test(dueAfter.reason),
      JSON.stringify(dueAfter)));
  const st = digestStatus(db, UID, CFG, now + 60_000);
  check('③ 生成之后状态是 generated，不是 pending（UI 不能永远说"正在准备"）',
    () => eq(st.state, 'generated'));
  check('③ 状态里带得上今天那份的 id',
    () => ok(st.digestId === row?.id, JSON.stringify({ st: st.digestId, row: row?.id })));

  // ── ④ 再点一次「现在生成」= 覆盖，不是第二份 ───────────
  const beforeCount = Number(
    db.prepare('SELECT COUNT(*) c FROM digests WHERE user_id = ?').get(UID).c,
  );
  let r2 = null;
  try {
    r2 = await runDigest(ctx, { userId: UID, manual: true, now: now + 60_000 });
  } catch (e) {
    thrown = e.message;
  }
  const afterCount = Number(
    db.prepare('SELECT COUNT(*) c FROM digests WHERE user_id = ?').get(UID).c,
  );
  check('④ 再生成一次不抛异常', () => ok(thrown === null, String(thrown)));
  check('④ 再生成一次仍是覆盖：库里的简报份数没变', () => eq(afterCount, beforeCount));
  check('④ 覆盖后 id 不变（推送出去的链接不能失效）',
    () => ok(r2?.digestId === row?.id, JSON.stringify({ a: r2?.digestId, b: row?.id })));

  // ── ⑤ 有内容但归纳全失败时，不该把脏数据落库 ───────────
  // 这条守的是"主链能跑完"不能靠"什么都接受"换来。
  const errs = db.prepare(
    'SELECT error FROM digest_attempts WHERE user_id = ? AND ok = 0',
  ).all(UID);
  check('⑤ 成功路径没有留下失败尝试（ok=1 才该落 attempt）',
    () => eq(errs.length, 0));
}

// ── ⑥ 无内容时的两条否决仍要有持久痕迹（回归 m3-04）───────
group('简报主链 · 无内容时不变');
{
  const tmp2 = mkdtempSync(join(tmpdir(), 'ai-rss-m3fix2-'));
  const h2 = openDb({ dataDir: tmp2 });
  migrate(h2.db);
  h2.db.prepare('INSERT INTO users (id,email,name,role,created_at) VALUES (?,?,?,?,?)')
    .run('u_empty', 'e@t.local', 'E', 'owner', Date.now());
  h2.db.prepare('INSERT OR REPLACE INTO settings (user_id, digest_config) VALUES (?,?)')
    .run('u_empty', JSON.stringify({ enabled: true, at: '00:00' }));
  const ctx2 = {
    ...ctx,
    dbh: h2,
    cfg: { ...ctx.cfg, dataDir: tmp2 },
  };
  const r = await runDigest(ctx2, { userId: 'u_empty', manual: true, now });
  check('⑥ 窗口内没条目 → 不生成，但落了 digest_skips（不是静默返回）', () => ok(
    !r.ok && /没有新条目/.test(String(r.reason))
    && Number(h2.db.prepare('SELECT COUNT(*) c FROM digest_skips').get().c) === 1,
    JSON.stringify(r),
  ));
  h2.db.close();
  rmSync(tmp2, { recursive: true, force: true });
}

// ── ⑦ saveDigest 直接调用也要写 day_key ────────────────────
// 上面 ② 走的是 runDigest。这里单独钉住 saveDigest 自己的契约：
// 它接受 periodStart 与「哪天」两件事，必须都落库。
group('saveDigest 契约');
{
  const tmp3 = mkdtempSync(join(tmpdir(), 'ai-rss-m3fix3-'));
  const h3 = openDb({ dataDir: tmp3 });
  migrate(h3.db);
  const d3 = h3.db;
  d3.prepare('INSERT INTO users (id,email,name,role,created_at) VALUES (?,?,?,?,?)')
    .run('u_sd', 's@t.local', 'S', 'owner', Date.now());
  const day = localDayRange(Date.now());
  const body = {
    title: '测试简报', highlights: ['一', '二', '三'],
    body_md: '正文足够长以通过 schema 的最小长度要求。', worth_reading: [],
  };
  const id = saveDigest(d3, {
    userId: 'u_sd', kind: 'daily', body,
    periodStart: day.start, periodEnd: day.end,
    entryCount: 3, clusterCount: 2, model: 'm', costUsd: 0.01,
  });
  const row = d3.prepare('SELECT day_key FROM digests WHERE id = ?').get(id);
  check('⑦ saveDigest 不传 dayKey 时按 periodStart 的本地日推出 day_key', () =>
    ok(row.day_key !== null && Number(row.day_key) === localDayStart(day.start),
      JSON.stringify(row)));

  const nextDay = localDayRange(day.end + 3600_000);
  const id2 = saveDigest(d3, {
    userId: 'u_sd', kind: 'daily', body: { ...body, title: '改过' },
    periodStart: nextDay.start, periodEnd: nextDay.end,
    entryCount: 4, clusterCount: 2, model: 'm', costUsd: 0.02,
  });
  check('⑦ 不同天是不同简报（day_key 不同）', () => ok(id2 !== id, `${id} / ${id2}`));
  const cnt = Number(d3.prepare('SELECT COUNT(*) c FROM digests').get().c);
  check('⑦ 两天两行（day_key 让唯一索引真的生效）', () => eq(cnt, 2));

  // 同一天再写一次必须是覆盖
  const id3 = saveDigest(d3, {
    userId: 'u_sd', kind: 'daily', body,
    periodStart: day.start, periodEnd: day.end,
    entryCount: 9, clusterCount: 3, model: 'm', costUsd: 0.03,
  });
  const cnt2 = Number(d3.prepare('SELECT COUNT(*) c FROM digests').get().c);
  check('⑦ 同一天重写是覆盖（仍两行、id 不变）', () => ok(cnt2 === 2 && id3 === id,
    `${cnt2} 行，id=${id3} vs ${id}`));
  h3.db.close();
  rmSync(tmp3, { recursive: true, force: true });
}

// ── ⑧ 异常必须被兜成"一次失败尝试"，不能冒出去 ─────────────
//
// 这条守的是 runDigest 文档里那句 **「不抛异常」**。它之前是假的：
// 实现只在四条显式判定的路径上返回，主链上任何异常（比如 ① 的那个
// 列名错误）都会直接冒到 job handler，而 handler 把它吞成一句 info 级
// 「简报未生成」。
//
// 代价比"看到异常"更糟：`recordAttempt` 在异常位置之后，所以一次都不落
// → digestDue 看到 attempts=0 → 判定"今天还没试过" → 每分钟照跑，
// 退避机制完全不存在。实测线上 17 行 digest_attempts 全是"没配 key"，
// 真正跑主链的那些次一行都没有。
//
// 造法：把 entry_contents 表改名，让 loadMembers 的 JOIN 必然抛
// `no such table`（比伪造列名更接近"库里数据坏了"这类真实故障）。
group('runDigest 的异常契约');
{
  const tmp4 = mkdtempSync(join(tmpdir(), 'ai-rss-m3fix4-'));
  const h4 = openDb({ dataDir: tmp4 });
  migrate(h4.db);
  const d4 = h4.db;
  const now4 = Date.now();
  d4.prepare('INSERT INTO users (id,email,name,role,created_at) VALUES (?,?,?,?,?)')
    .run('u_boom', 'b@t.local', 'B', 'owner', now4);
  // 有内容（两簇四篇），但正文表被改名 → 取成员时抛异常
  for (let i = 0; i < 4; i++) {
    const id = `b_${i}`;
    d4.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,title,published_at,fetched_at,
        excerpt,content_hash,stage,is_read,is_starred,is_hidden,read_later,read_count,highlight_count)
      VALUES (?,?,NULL,?,?,?,?,?,?,?,?,'extracted',0,0,0,0,0,0)`)
      .run(id, 'u_boom', id, `http://x/${id}`, `http://x/${id}`, `标题${i}`,
        now4 - 3600_000, now4, '摘要', `h${i}`);
    d4.prepare('INSERT INTO entry_contents (entry_id, html, extracted_by) VALUES (?,?,?)')
      .run(id, packText(`<p>正文${i}</p>`), 'test');
    const v = new Float32Array(8);
    if (i < 2) { v[0] = 1; v[1] = 0; } else { v[0] = 0; v[1] = 1; }
    v[2] = 0.1;
    d4.prepare('INSERT INTO entry_vectors (entry_id, dim, vec, model, created_at) VALUES (?,?,?,?,?)')
      .run(id, v.length, packVec(v), 'hash256', now4);
  }
  d4.exec('ALTER TABLE entry_contents RENAME TO entry_contents_broken');

  const ctx4 = { ...ctx, dbh: h4, cfg: { ...ctx.cfg, dataDir: tmp4 } };
  let thrown4 = null;
  let r4 = null;
  try {
    r4 = await runDigest(ctx4, { userId: 'u_boom', manual: true, now: now4 });
  } catch (e) {
    thrown4 = e.message;
  }
  check('⑧ 主链抛异常时 runDigest 也不抛（文档写死了这条契约）',
    () => ok(thrown4 === null, `抛了：${thrown4}`));
  check('⑧ 异常被返回成 ok:false + 可读原因',
    () => ok(r4?.ok === false && /异常|no such table/.test(String(r4?.reason)),
      JSON.stringify(r4)));
  check('⑧ 异常也记了一次失败尝试（否则退避与"今天试过几次"都失效）', () => {
    const rows = d4.prepare(
      'SELECT ok, error FROM digest_attempts WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    ).all('u_boom');
    return ok(rows.length === 1 && Number(rows[0].ok) === 0,
      JSON.stringify(rows));
  });
  d4.close();
  rmSync(tmp4, { recursive: true, force: true });
}

// ── ⑨ 0008 迁移：把历史 NULL 行补回来 ─────────────────────
//
// 代码修好只保证**新**行有 day_key，已经落库的旧行仍是 NULL。
// 不补的话：那份简报永远停在"今天没生成"，调度器下一分钟再生成一份新的，
// 而旧的 NULL 行一直躺着（唯一索引对 NULL 不生效）。
//
// 造法与真实升级一致：跑到最新版 → 插一行 day_key=NULL → 删掉 8 号迁移记录
// → 再迁一次，等价于"用新二进制打开旧库"。
group('0008 迁移 · 历史 day_key 回填');
{
  const tmp5 = mkdtempSync(join(tmpdir(), 'ai-rss-m3fix5-'));
  const h5 = openDb({ dataDir: tmp5 });
  migrate(h5.db);
  const d5 = h5.db;
  d5.prepare('INSERT INTO users (id,email,name,role,created_at) VALUES (?,?,?,?,?)')
    .run('u_mig', 'm@t.local', 'M', 'owner', Date.now());

  const day = localDayStart(Date.now());
  d5.prepare(`INSERT INTO digests (id,user_id,kind,title,intro,body_md,period_start,period_end,
      entry_count,cluster_count,model,cost_usd,created_at,day_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
    .run('dg_old', 'u_mig', 'daily', '旧简报', 'i', 'b', day, day + 3600_000,
      3, 2, 'm', 0.01, day + 1000);
  check('（前置）造出了一行 day_key 为 NULL 的旧数据', () =>
    eq(d5.prepare('SELECT day_key FROM digests WHERE id = ?').get('dg_old').day_key, null));

  // 删掉迁移记录 = 模拟"用新二进制打开旧库"
  d5.prepare('DELETE FROM schema_migrations WHERE version = 8').run();
  migrate(d5);
  const fixed = d5.prepare('SELECT day_key FROM digests WHERE id = ?').get('dg_old');
  check('⑨ 迁移把 day_key 补成本地当天 00:00',
    () => eq(Number(fixed.day_key), day));
  check('⑨ 补完之后 digestStatus 认得出"今天已生成"',
    () => eq(digestStatus(d5, 'u_mig', parseDigestConfig({ at: '00:00' }), Date.now()).state,
      'generated'));

  // 幂等：可重复执行
  d5.prepare('DELETE FROM schema_migrations WHERE version = 8').run();
  migrate(d5);
  check('⑨ 迁移可重复执行（第二次是空操作）', () =>
    eq(Number(d5.prepare('SELECT day_key FROM digests WHERE id = ?').get('dg_old').day_key), day));
  d5.close();
  rmSync(tmp5, { recursive: true, force: true });
}

// ── 收尾 ────────────────────────────────────────────────────
delete process.env.M3FIX_KEY;
srv.close();
db.close();
rmSync(tmp, { recursive: true, force: true });

summary('m3-06-digest-chain');
