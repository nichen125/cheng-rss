#!/usr/bin/env node
// 2.4 Embedding —— 验收
//
// 判据（PLAN §19.4 2.4 + §7.1 L4）：
//   ① 维度 = 配置值（不是"能存就行"）
//   ② BLOB 字节 = dim × 4
//   ③ 1000 条余弦 < 20ms
//   ④ 输入是「标题 + 摘要 + 首段」，不是全文（§7.1 L4）
//   ⑤ 同一个条目重跑不重复调模型（幂等）
//   ⑥ 换了 embedding 模型 → 重算，且不影响另一张表的去重指纹（§6.2）
//   ⑦ 坏 BLOB / 维度不符不抛，余弦退化为 0（换模型的过渡期必然出现）
//   ⑧ 失败不写半截行、不改 stage
//
// ② 的验法：只断言"存进去了"是空的 —— 一个把 Float32Array 直接
// JSON.stringify 成 "[0.1,0.2,...]" 的实现同样"存进去了"，但体积是 8 倍
// 且数据类型全丢。必须断言字节数恰好 = dim × 4。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, gt, lt, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const {
  embedInput, runEmbed, embedDimensions, EMBED_DIM_DEFAULT,
} = await import('../../src/server/ai/embed.ts');
const { cosine, packVec, unpackVec, LOCAL_DIM, LOCAL_MODEL } = await import(
  '../../src/server/dedupe/cosine.ts');
const { openDb } = await import('../../src/server/db/client.ts');
const { migrate } = await import('../../src/server/db/migrate.ts');
const { packText } = await import('../../src/server/db/text-blob.ts');

// ── ① ③ 纯函数层 ─────────────────────────────────────────
group('2.4 Embedding · 维度与字节');

check(`默认维度是 ${EMBED_DIM_DEFAULT}（不是 256 —— 那是本地判重指纹的维度）`, () =>
  ok(EMBED_DIM_DEFAULT >= 256 && EMBED_DIM_DEFAULT !== LOCAL_DIM,
    `EMBED_DIM_DEFAULT=${EMBED_DIM_DEFAULT} LOCAL_DIM=${LOCAL_DIM}`));

check('packVec(768) 恰好 3072 字节 = 768×4', () => {
  const v = new Float32Array(768);
  return eq(packVec(v).byteLength, 768 * 4);
});
check('packVec 之后 unpackVec 能还原（不是存了个空 buffer）', () => {
  const v = Float32Array.from([0.1, -0.25, 0.5, 1]);
  const back = unpackVec(packVec(v));
  return ok(back.length === 4 && Math.abs(back[1] - (-0.25)) < 1e-6,
    `len=${back.length} v1=${back[1]}`);
});
check('packVec 对带 offset 的视图不会抄错相邻数据', () => {
  // 从更大的 buffer 里切一段：底层 buffer 的 byteOffset 必须被尊重
  const big = new Float32Array([9, 9, 1, 2, 3, 9]);
  const view = big.subarray(2, 5);          // [1,2,3]
  const back = unpackVec(packVec(view));
  return ok(back.length === 3 && back[0] === 1 && back[2] === 3,
    `[${Array.from(back).join(',')}]`);
});

// ── ④ 输入构造 ────────────────────────────────────────────
group('2.4 Embedding · 输入');

const IN = {
  title: '长江存储宣布 232 层 QLC 闪存量产',
  summary: '单颗容量 1Tb，接口速率 2400MT/s，位密度提升 40%。',
  body: '<article><p>第一段正文，讲了 Xtacking 架构与量产时间。</p><p>第二段正文，讲客户与价格。</p></article>',
};
const text = embedInput(IN);

check('输入含标题', () => ok(text.includes('232 层 QLC'), text.slice(0, 120)));
check('输入含摘要', () => ok(text.includes('2400MT/s'), text.slice(0, 200)));
check('输入含正文首段', () => ok(text.includes('Xtacking'), text.slice(0, 200)));
check('输入**不含**正文第二段（只取首段，§7.1 L4）', () => ok(
  !text.includes('第二段正文'),
  `出现第二段: ${text.includes('第二段正文')}`,
));
check('首段取的是第一个 <p> 的纯文本（不是 "<p>" 标签本身）', () => ok(
  !text.includes('<p>') && !text.includes('</p>'),
  text.slice(0, 200),
));
check('没有正文时也能构造（只要标题 + 摘要）', () => {
  const t = embedInput({ title: 'T', summary: 'S', body: null });
  return ok(t.includes('T') && t.includes('S'), t);
});
// 这条断言原本用长正文来测，结果测的是 firstParagraph 的 600 字上限 ——
// 把 embedInput 末尾的 .slice(0, 2000) 整个删掉，它照样绿（实测）。
// 能测到总长度上限的只有**摘要**：正文被首段截断，摘要不被截断。
check('输入总长度有上限（摘要本身就很长时也要夹住）', () => {
  const longSummary = '摘'.repeat(8000);
  const long = embedInput({ title: 'T', summary: longSummary, body: `<p>${'长'.repeat(20000)}</p>` });
  return ok(long.length <= 2000, `长度 ${long.length}`);
});

// ── ③ 1000 条余弦 < 20ms ─────────────────────────────────
group('2.4 Embedding · 检索性能');

check('1000 条 1536 维余弦 < 20ms（实测，不是估算）', () => {
  const dim = 1536;
  const n = 1000;
  // 固定种子的伪随机：每次跑同一份数据，耗时可比较
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const q = Float32Array.from({ length: dim }, rnd);
  const rows = Array.from({ length: n }, () => Float32Array.from({ length: dim }, rnd));

  const t0 = performance.now();
  let best = -1;
  for (const r of rows) {
    const s = cosine(q, r);
    if (s > best) best = s;
  }
  const ms = performance.now() - t0;
  // 最高分必须是**明显的正数且接近 0**：随机向量之间余弦应集中在 ±0.05。
  // 只断言 best > -1 是空断言（任何算得出来的结果都满足）；断言
  // 0 < best < 0.2 才能同时排除"恒返回 0"与"返回了归一化前的点积"。
  return ok(ms < 20 && best > 0 && best < 0.2,
    `1000 条 × ${dim} 维耗时 ${ms.toFixed(2)}ms，最高分 ${best.toFixed(3)}`);
});

// 这一条**不**断言"维度低就该更快" —— 实测 768 维 4.02ms、1536 维 3.89ms，
// 两者在噪声范围内（V8 的 Float32 循环已经内存带宽受限，不随维数线性变）。
// 写"低维更快"会得到一条靠运气过的断言，下次在另一台机器上假红。
// 有意义的断言是：两种维度都在预算内，且**都真的算出了非零相似度**
// （一个恒返回 0 的实现同样会"很快"）。
check('1000 条 768 维余弦在 20ms 预算内且分数非零', () => {
  const dim = 768;
  let seed = 999;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const q = Float32Array.from({ length: dim }, rnd);
  const rows = Array.from({ length: 1000 }, () => Float32Array.from({ length: dim }, rnd));
  const t0 = performance.now();
  let nonzero = 0;
  for (const r of rows) if (cosine(q, r) !== 0) nonzero++;
  const ms = performance.now() - t0;
  return ok(ms < 20 && nonzero === 1000,
    `耗时 ${ms.toFixed(2)}ms，非零 ${nonzero}/1000`);
});

// ── ⑦ 坏数据 ─────────────────────────────────────────────
group('2.4 Embedding · 坏数据不抛');

check('维度不等的两条余弦为 0（换模型过渡期）', () =>
  eq(cosine(new Float32Array(768), new Float32Array(1536)), 0));
check('空向量余弦为 0 而不是 NaN', () => {
  const c = cosine(new Float32Array(0), new Float32Array(0));
  return ok(c === 0 && !Number.isNaN(c), `得到 ${c}`);
});
check('unpackVec 对 null / 空 / 非 4 倍数不抛', () => ok(
  unpackVec(null).length === 0 && unpackVec(new Uint8Array(0)).length === 0
  && unpackVec(new Uint8Array(7)).length === 0,
  '有坏输入抛了',
));

// ── B. 落库层 ─────────────────────────────────────────────
group('2.4 Embedding · 落库');

const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m204-'));
const h = openDb({ dataDir: tmp });
migrate(h.db);
const DB = h.db;
const UID = 'u_e';
DB.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
  .run(UID, 'e@t.local', 'E', 'owner', Date.now());
DB.prepare('INSERT INTO settings (user_id) VALUES (?)').run(UID);

function insertEntry(id, title, body) {
  DB.prepare(`INSERT INTO entries (id, user_id, feed_id, guid, url, url_norm, title,
      published_at, fetched_at, stage) VALUES (?,?,NULL,?,?,?,?,?,?,'analyzed')`)
    .run(id, UID, `g-${id}`, `https://e.test/${id}`, `https://e.test/${id}`, title, Date.now(), Date.now());
  DB.prepare('INSERT INTO entry_contents (entry_id, html, extracted_by) VALUES (?,?,?)')
    .run(id, packText(`<article><p>${body}</p></article>`), 'feed');
  DB.prepare(`INSERT INTO entry_analysis (entry_id, summary, key_points, topics, entities,
      importance, tier, model, prompt_version, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, `${title} 的摘要内容。`, '["k"]', '["t"]', '{}', 60, 'normal', 'm', 'v1', Date.now());
}

/** 假客户端：返回一个可预测的向量（第 i 维 = i/dim），并记录调用 */
function fakeClient(dim = 8, opts = {}) {
  const calls = [];
  return {
    calls,
    config: { models: { embed: opts.model ?? 'mock-embed' } },
    async embed(input) {
      calls.push(input);
      if (opts.fail) {
        return { ok: false, usage: null, failure: { kind: 'http-500', message: 'boom', retryable: true } };
      }
      const v = new Float32Array(dim);
      for (let i = 0; i < dim; i++) v[i] = (i + 1) / dim;
      return { ok: true, vec: v, dim, usage: { purpose: 'embed', model: opts.model ?? 'mock-embed', inTokens: 12, outTokens: null, costUsd: 0, latencyMs: 1, ok: true } };
    },
  };
}

insertEntry('e1', '标题一', '第一段正文。');
{
  const c = fakeClient(8);
  const r = await runEmbed(DB, c, 'e1');
  check('成功写入 embeddings 行', () => ok(r.ok && !r.skipped, JSON.stringify(r)));
  const row = DB.prepare('SELECT model, dim, length(vec) AS bytes FROM embeddings WHERE entry_id=?').get('e1');
  check('dim = 模型返回的维度（8）', () => eq(Number(row?.dim), 8));
  check('BLOB 字节 = dim × 4 = 32', () => eq(Number(row?.bytes), 32));
  check('model 记的是 embed 模型名', () => eq(row?.model, 'mock-embed'));
  check('调模型用的输入含标题（不是空串）', () => ok(
    c.calls.length === 1 && String(c.calls[0]).includes('标题一'),
    `calls=${c.calls.length} input=${String(c.calls[0]).slice(0, 80)}`,
  ));
}

// ⑤ 幂等
{
  const c = fakeClient(8);
  const r = await runEmbed(DB, c, 'e1');
  check('同一内容重跑：不调模型', () => ok(r.skipped && c.calls.length === 0,
    `skipped=${r.skipped} calls=${c.calls.length}`));
}

// ⑥ 换模型 → 重算
{
  const c = fakeClient(16, { model: 'mock-embed-v2' });
  const r = await runEmbed(DB, c, 'e1');
  check('换了 embedding 模型 → 重算（不因"已有向量"而跳过）', () =>
    ok(r.ok && c.calls.length === 1, `ok=${r.ok} calls=${c.calls.length}`));
  const row = DB.prepare('SELECT model, dim, length(vec) AS bytes FROM embeddings WHERE entry_id=?').get('e1');
  check('换模型后 dim 与字节都跟着变（16 / 64）', () => ok(
    Number(row?.dim) === 16 && Number(row?.bytes) === 64,
    `dim=${row?.dim} bytes=${row?.bytes}`,
  ));
}

// ⑥ 不影响去重指纹表
{
  const vecs = DB.prepare('SELECT COUNT(*) c FROM entry_vectors').get();
  check('embeddings 的写入没有碰 entry_vectors（§6.2 两张表分开）', () =>
    ok(Number(vecs.c) === 0, `entry_vectors 里有 ${Number(vecs.c)} 行`));

  // 反过来：写一份去重指纹，再跑 embed，指纹不该被覆盖
  DB.prepare('INSERT INTO entry_vectors (entry_id, dim, vec, model, created_at) VALUES (?,?,?,?,?)')
    .run('e1', 256, packVec(new Float32Array(256).fill(0.1)), LOCAL_MODEL, Date.now());
  await runEmbed(DB, fakeClient(16, { model: 'mock-embed-v2' }), 'e1', { force: true });
  const v = DB.prepare('SELECT model, length(vec) AS bytes FROM entry_vectors WHERE entry_id=?').get('e1');
  check('写 embeddings 不会覆盖 entry_vectors 的 256 维指纹', () => ok(
    v?.model === LOCAL_MODEL && Number(v?.bytes) === 1024,
    `model=${v?.model} bytes=${v?.bytes}`,
  ));
}

// ⑧ 失败不写半截
{
  insertEntry('e2', '标题二', '正文。');
  const c = fakeClient(8, { fail: true });
  const r = await runEmbed(DB, c, 'e2');
  check('模型失败 → ok=false 且不抛', () => ok(!r.ok && r.failure !== null, JSON.stringify(r).slice(0, 150)));
  const row = DB.prepare('SELECT entry_id FROM embeddings WHERE entry_id=?').get('e2');
  check('模型失败 → 没有写半截向量行', () => ok(!row, `存在: ${JSON.stringify(row)}`));
  const e = DB.prepare('SELECT stage FROM entries WHERE id=?').get('e2');
  check('模型失败 → 不改 stage（向量是可选增强，不是必经阶段）', () => eq(e?.stage, 'analyzed'));
}

// 维度不符：模型返回 5 维而要求 8 维 → 判失败而不是存进去
{
  insertEntry('e3', '标题三', '正文。');
  const c = fakeClient(5);
  const r = await runEmbed(DB, c, 'e3', { expectDim: 8 });
  check('维度与期望不符 → 判失败，不落库', () => ok(
    !r.ok && r.failure?.kind === 'dim-mismatch',
    `ok=${r.ok} kind=${r.failure?.kind}`,
  ));
  const row = DB.prepare('SELECT entry_id FROM embeddings WHERE entry_id=?').get('e3');
  check('维度不符 → 库里没有它的向量', () => ok(!row));
}

// 条目不存在
{
  const r = await runEmbed(DB, fakeClient(8), 'nope');
  check('条目不存在 → 作废而不是失败（与 extract 同语义）', () =>
    ok(r.ok && r.skipped, JSON.stringify(r)));
}

// embedDimensions：读库时统计真实维度分布（换模型后会有两种）
{
  const dims = embedDimensions(DB, UID);
  check('embedDimensions 报出库里实际存在的维度', () => {
    const keys = Object.keys(dims).map(Number).sort((a, b) => a - b);
    return ok(keys.length >= 1 && keys.every((k) => Number.isInteger(k) && k > 0),
      JSON.stringify(dims));
  });
}

h.close();
rmSync(tmp, { recursive: true, force: true });

summary('m2-04-embed');
process.exit(process.exitCode ?? 0);
