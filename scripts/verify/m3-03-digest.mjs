#!/usr/bin/env node
// 3.3 简报生成 —— 验收
//
// 判据（PLAN §19.5 3.3 + §9.3）：
//   ① 简报结构四段齐全（今日要点 3 条 / 分主题展开 / 值得一读 / 今日高亮）
//   ② `{{cite:id}}` 换成了脚注，且脚注 id 是输入里真实存在的簇
//   ③ 模型编的 id → 可见的 [?]，并记进 invalid（不静默删）
//   ④ **模型自己写 URL 必须被抹掉** —— 这是简报唯一的硬安全边界
//   ⑤ 单来源主题喂进模型时带「单一来源，待验证」标注
//   ⑥ 同一天重跑是覆盖不是新增，且 id 不变（推送出去的链接不能失效）
//   ⑦ 模型完全没写引用时有兜底脚注
//   ⑧ 本地日历日的起止
//   ⑨ 最多 12 簇
//
// ④ 是最容易做成"空断言"的一条。只查"渲染结果里没有 http" 的话，
// 一个从来不产出任何正文的实现也能通过 —— 所以必须断言：
//   · 输入 md 里**确实有** URL（否则这条测试没测到东西）
//   · 输出 md 里没有 URL
//   · 被抹掉的 URL 记在 strippedUrls 里（可观测）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, gt, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const {
  buildDigestUser, renderCitations, generateDigestBody, fallbackCitations,
  saveDigest, localDayRange, MAX_DIGEST_CLUSTERS, HIGHLIGHT_COUNT, DIGEST_SYSTEM,
} = await import('../../src/server/digest/index.ts');
const { openDb } = await import('../../src/server/db/client.ts');
const { migrate } = await import('../../src/server/db/migrate.ts');

function cluster(id, over = {}) {
  return {
    id,
    title: over.title ?? `事件 ${id}`,
    summary: over.summary ?? '综述内容。',
    keyPoints: over.keyPoints ?? ['要点 A', '要点 B'],
    consensus: over.consensus ?? ['一致事实'],
    conflicts: over.conflicts ?? [],
    entryCount: over.entryCount ?? 3,
    sourceCount: over.sourceCount ?? 3,
    heat: over.heat ?? 50,
  };
}

const BODY = {
  title: '存储与向量库同日出现量产与提速消息',
  highlights: ['长江存储 232 层 QLC 量产', 'Milvus 3.0 索引构建提速 5 倍', '某自动驾驶公司裁员 30%'],
  body_md: '## 存储\n{{cite:cl_a}} 长江存储宣布量产。\n\n## 数据库\n{{cite:cl_b}} Milvus 发布 3.0。\n\n## 行业\n{{cite:cl_c}} 该公司收缩 L4 业务。',
  worth_reading: ['cl_b'],
};

function fakeClient(payload, opts = {}) {
  const calls = [];
  return {
    calls,
    config: { models: { strong: 'mock-strong' } },
    async chatJson(o) {
      calls.push(o);
      if (opts.fail) {
        return { ok: false, usage: null, failure: { kind: 'timeout', message: 'mock 超时', retryable: true } };
      }
      return {
        ok: true, raw: '{}',
        usage: { purpose: 'digest', model: 'mock-strong', inTokens: 1, outTokens: 1, costUsd: 0.01, latencyMs: 1, ok: true },
        data: typeof payload === 'function' ? payload(o) : payload,
      };
    },
  };
}

const THREE = [cluster('cl_a'), cluster('cl_b'), cluster('cl_c')];

// ── ⑤ 输入构造 ──────────────────────────────────────────────
group('3.3 简报 · 输入');

{
  const text = buildDigestUser(THREE);
  check('每个事件都写出 id=（模型要原样抄进 {{cite:id}}）', () => ok(
    text.includes('id=cl_a') && text.includes('id=cl_b') && text.includes('id=cl_c'),
    text.slice(0, 160),
  ));
  check('带来源数/条目数/热度（模型据此写"多方一致"还是"单一来源"）', () =>
    ok(/来源数：3｜条目数：3｜热度：50/.test(text), text.slice(0, 200)));
  check('带综述与要点', () =>
    ok(/综述：/.test(text) && /要点：/.test(text), text.slice(0, 200)));
}

{
  // ⑤ 单来源标注必须真的喂进去
  const single = [cluster('cl_solo', { sourceCount: 1 }), cluster('cl_multi', { sourceCount: 4 })];
  const text = buildDigestUser(single);
  check('单来源事件带「单一来源，待验证」标注', () =>
    ok(/标注：单一来源，待验证/.test(text), text.slice(0, 300)));
  check('多来源事件**没有**这条标注（否则所有事件都被打上"待验证"= 等于没标）', () => {
    const idx = text.indexOf('id=cl_multi');
    const seg = text.slice(idx, idx + 400);
    return ok(!/单一来源，待验证/.test(seg), seg.slice(0, 120));
  });
}

{
  const many = Array.from({ length: 20 }, (_, i) => cluster(`cl_${i}`));
  const text = buildDigestUser(many.slice(0, MAX_DIGEST_CLUSTERS));
  check(`最多 ${MAX_DIGEST_CLUSTERS} 个事件进简报`, () =>
    eq((text.match(/【事件 \d+】/g) ?? []).length, MAX_DIGEST_CLUSTERS));
}
check('提示词里写明了「不许自己写 URL」', () =>
  ok(/绝对不能自己写 URL/.test(DIGEST_SYSTEM), DIGEST_SYSTEM.slice(0, 300)));
check(`提示词要求恰好 ${HIGHLIGHT_COUNT} 条要点`, () =>
  ok(new RegExp(`highlights 恰好 ${HIGHLIGHT_COUNT} 条`).test(DIGEST_SYSTEM)));

// ── ② 引用替换 ──────────────────────────────────────────────
group('3.3 简报 · 引用');

{
  const map = new Map(THREE.map((c) => [c.id, { title: c.title }]));
  const r = renderCitations(BODY.body_md, map);
  check('{{cite:id}} 被替换成 [n] 脚注标记', () =>
    ok(r.md.includes('[1]') && r.md.includes('[2]') && r.md.includes('[3]'), r.md));
  check('输出里不再有 {{cite: 残留', () => ok(!/\{\{cite:/.test(r.md), r.md));
  check('脚注表 3 条，index 从 1 连续', () =>
    ok(r.citations.length === 3 && r.citations.map((c) => c.index).join(',') === '1,2,3',
      JSON.stringify(r.citations.map((c) => c.index))));
  check('脚注 id 与标题对应正确', () =>
    ok(r.citations[0].id === 'cl_a' && r.citations[1].id === 'cl_b'
      && r.citations[2].id === 'cl_c', JSON.stringify(r.citations)));
  check('没有编造的 id', () => eq(r.invalid.length, 0));
}

{
  // 同一个簇引用两次 → 复用同一个脚注号，不重复编号
  const map = new Map(THREE.map((c) => [c.id, { title: c.title }]));
  const r = renderCitations('先说 {{cite:cl_a}}，再说一次 {{cite:cl_a}}。', map);
  check('同一簇引用两次复用同一个脚注号', () =>
    ok(r.md === '先说 [1]，再说一次 [1]。' && r.citations.length === 1, r.md));
}

{
  // ③ 编造的 id
  const map = new Map(THREE.map((c) => [c.id, { title: c.title }]));
  const r = renderCitations('真实 {{cite:cl_a}} 和编的 {{cite:cl_zzz}}。', map);
  check('编造的 id 变成可见的 [?]', () => ok(r.md.includes('[?]'), r.md));
  check('编造的 id 记进 invalid', () => ok(r.invalid.includes('cl_zzz'), JSON.stringify(r.invalid)));
  check('真实的引用仍然正常编号（不是整段作废）', () => ok(r.md.includes('[1]'), r.md));
}

// ── ④ URL 抹除（硬安全边界）──────────────────────────────────
group('3.3 简报 · URL 安全');

{
  const map = new Map(THREE.map((c) => [c.id, { title: c.title }]));
  const dirty = '据路透社报道（https://fake-news.example.com/a?b=1），事件属实。' +
    '另有 [新浪科技](https://sina.example.com/x) 提到 {{cite:cl_a}}。';
  // 先自证：输入里确实有 URL，否则这条测试测不到东西
  check('（前置）输入 md 里确实含有 URL —— 否则下面的断言是空的', () => ok(
    /https?:\/\//.test(dirty), '测试数据本身没有 URL，说明这条用例写错了',
  ));

  const r = renderCitations(dirty, map);
  check('输出 md 里一个 http(s) URL 都不剩', () =>
    ok(!/https?:\/\//.test(r.md), r.md));
  check('被抹掉的 URL 记在 strippedUrls（可观测）', () =>
    ok(r.strippedUrls.length >= 2, JSON.stringify(r.strippedUrls)));
  check('markdown 链接保留了可见文字（不是整句删掉）', () =>
    ok(r.md.includes('新浪科技'), r.md));
  check('抹掉 URL 后引用仍然正常替换（两件事不互相干扰）', () =>
    ok(r.md.includes('[1]'), r.md));
  check('抹掉处留下可见标记（用户能看出这里原本有个链接）', () =>
    ok(r.md.includes('[链接已移除]'), r.md));
}

// ── ① 生成整份简报 ──────────────────────────────────────────
group('3.3 简报 · 结构');

{
  const c = fakeClient(BODY);
  const r = await generateDigestBody(c, THREE);
  check('生成成功', () => ok(r.ok, String(r.failure)));
  check(`highlights 恰好 ${HIGHLIGHT_COUNT} 条`, () =>
    eq(r.body?.highlights?.length, HIGHLIGHT_COUNT));
  check('body_md 有分主题的 Markdown 小标题', () =>
    ok((r.body?.body_md?.match(/^## /gm) ?? []).length >= 2, r.body?.body_md?.slice(0, 120)));
  check('worth_reading 有内容且 ≤3 条', () => ok(
    (r.body?.worth_reading?.length ?? 0) >= 1 && r.body.worth_reading.length <= 3,
    JSON.stringify(r.body?.worth_reading),
  ));
  check('body_md 里的引用已被渲染成脚注（不是原样返回 {{cite:}}）', () =>
    ok(!/\{\{cite:/.test(r.rendered?.md ?? '') && (r.rendered?.citations?.length ?? 0) === 3,
      String(r.rendered?.citations?.length)));
  check('调模型时 purpose=digest（成本归到简报）', () =>
    eq(c.calls[0]?.purpose, 'digest'));
  check('传给模型的 user 里带 id=（否则模型无从引用）', () =>
    ok(String(c.calls[0]?.user).includes('id=cl_a'), String(c.calls[0]?.user)?.slice(0, 100)));
}

{
  // ⑦ 模型完全没写引用
  const noCite = { ...BODY, body_md: '## 存储\n长江存储宣布量产。\n\n## 数据库\nMilvus 发布 3.0。' };
  const c = fakeClient(noCite);
  const r = await generateDigestBody(c, THREE);
  check('模型没写引用时 citations 为空（不假装有引用）', () =>
    eq(r.rendered?.citations?.length, 0));
  check('兜底脚注按 heat 顺序给出前几名', () => {
    const fb = fallbackCitations(THREE, 5);
    return ok(fb.length === 3 && fb[0].index === 1 && fb[0].id === 'cl_a',
      JSON.stringify(fb.map((x) => x.id)));
  });
  check('兜底脚注不改动正文（正文没写引用就是没写）', () =>
    ok(!/\[\d\]/.test(r.rendered?.md ?? ''), r.rendered?.md?.slice(0, 80)));
}

{
  // 生成失败
  const c = fakeClient(null, { fail: true });
  const r = await generateDigestBody(c, THREE);
  check('生成失败返回 ok=false 且带原因（不抛）', () => ok(
    !r.ok && /timeout/.test(String(r.failure)), String(r.failure),
  ));
  check('失败时不返回半截正文', () => eq(r.body, null));
}

// check() 的回调必须同步（harness 的硬约束）。先把异步结果取出来。
const emptyRes = await generateDigestBody(fakeClient(BODY), []);
check('空簇列表 → 明确失败而不是产出空简报', () =>
  ok(!emptyRes.ok && /没有可用的簇/.test(String(emptyRes.failure)), String(emptyRes.failure)));

// ── ⑥ 落库 ──────────────────────────────────────────────────
group('3.3 简报 · 落库');

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m303-'));
const h = openDb({ dataDir: tmp });
migrate(h.db);
const DB = h.db;
const UID = 'u_dg';
DB.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
  .run(UID, 'dg@t.local', 'DG', 'owner', Date.now());

const DAY = localDayRange(Date.now());

{
  const id1 = saveDigest(DB, {
    userId: UID, kind: 'daily', body: BODY,
    periodStart: DAY.start, periodEnd: DAY.end,
    entryCount: 12, clusterCount: 5, model: 'mock-strong', costUsd: 0.03, now: 1000,
  });
  const row = DB.prepare('SELECT * FROM digests WHERE id = ?').get(id1);
  check('简报写入 digests 表', () => ok(Boolean(row), '没有行'));
  check('title / body_md / intro 都落了', () => ok(
    row.title === BODY.title && row.body_md === BODY.body_md
    && row.intro.split('\n').length === 3,
    JSON.stringify({ t: row.title, intro: row.intro }),
  ));
  check('entry_count / cluster_count / model / cost_usd 落库', () => ok(
    Number(row.entry_count) === 12 && Number(row.cluster_count) === 5
    && row.model === 'mock-strong' && Math.abs(Number(row.cost_usd) - 0.03) < 1e-9,
    JSON.stringify(row),
  ));

  // ⑥ 同一天重跑
  const id2 = saveDigest(DB, {
    userId: UID, kind: 'daily', body: { ...BODY, title: '改过的标题' },
    periodStart: DAY.start, periodEnd: DAY.end,
    entryCount: 15, clusterCount: 6, model: 'mock-strong', costUsd: 0.04, now: 2000,
  });
  const cnt = DB.prepare('SELECT COUNT(*) c FROM digests').get();
  check('同一天重跑是覆盖，不是新增一份', () => eq(Number(cnt.c), 1));
  check('重跑后 id 不变（推送出去的链接不能失效）', () => eq(id2, id1));
  check('重跑后内容确实更新了', () => {
    const row2 = DB.prepare('SELECT title, entry_count FROM digests WHERE id = ?').get(id1);
    return ok(row2.title === '改过的标题' && Number(row2.entry_count) === 15, JSON.stringify(row2));
  });

  // 不同天是不同简报
  const nextDay = localDayRange(DAY.end + 3600_000);
  saveDigest(DB, {
    userId: UID, kind: 'daily', body: BODY,
    periodStart: nextDay.start, periodEnd: nextDay.end,
    entryCount: 3, clusterCount: 2, model: null, costUsd: null, now: 3000,
  });
  check('不同日期各有各的简报', () =>
    eq(Number(DB.prepare('SELECT COUNT(*) c FROM digests').get().c), 2));
  check('model/cost 允许为空（手工导入或未记账的简报）', () => {
    const r = DB.prepare('SELECT model, cost_usd FROM digests ORDER BY period_start DESC LIMIT 1').get();
    return ok(r.model === null && r.cost_usd === null, JSON.stringify(r));
  });
}

// ── ⑧ 本地日历日 ────────────────────────────────────────────
group('3.3 简报 · 日界');

check('localDayRange 从本地 00:00:00.000 开始', () => {
  const d = new Date(DAY.start);
  return ok(d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0
    && d.getMilliseconds() === 0, d.toString());
});
check('localDayRange 的 end 是次日 00:00（区间左闭右开）', () => {
  const e = new Date(DAY.end);
  const next = localDayRange(DAY.end + 1);
  return ok(e.getHours() === 0 && next.start === DAY.end, `end=${e.toString()}`);
});
check('同一天内任意时刻落在同一个区间里', () => {
  const a = new Date(); a.setHours(0, 30, 0, 0);
  const b = new Date(); b.setHours(23, 30, 0, 0);
  return ok(localDayRange(a.getTime()).start === localDayRange(b.getTime()).start);
});

h.close();
rmSync(tmp, { recursive: true, force: true });

summary('m3-03-digest');
process.exitCode = process.exitCode ?? 0;
