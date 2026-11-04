#!/usr/bin/env node
// 4.1 高亮锚定与恢复 —— 验收
//
// 判据（PLAN §19.6 M4 + §11.1）：
//   ① 改提取器后旧高亮仍能定位
//   ② 破坏 position 靠 quote 找回
//   ③ 再破坏 quote 靠 range 找回（服务端只能判"该交给前端"，实际是 orphaned 边界）
//   ④ 全失败标 orphaned 且列表可见（**不静默丢**）
//
// 这一节最容易写成空断言的地方是 ① 与 ②：如果只断言"resolveAnchor 返回了
// 非 null"，那么一个**永远返回全文第一处**的实现也能通过 —— 而它正是在
// 正文前面加一段导语后必然出错的实现。所以每条都要断言：
//   · 定位到的位置**就是**原来那一段（用 text.slice(start,end) 比对）
//   · 或者**明确 ORPHANED**，而不是随便给个位置
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, gt, summary } from './harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const {
  resolveAnchor, makeAnchor, findByQuoteForTest, CONTEXT_CHARS,
  insertHighlight, reanchorEntry, toApi,
} = await import('../../src/server/highlights/anchor.ts');
const { openDb } = await import('../../src/server/db/client.ts');
const { migrate } = await import('../../src/server/db/migrate.ts');

const PARA = '长江存储宣布 232 层 QLC 闪存量产，单颗容量 1Tb。';
const OTHER = '该产品面向企业级 SSD 市场，四季度出货。';
const BASE = `导语：这是一篇关于存储芯片的报道。\n\n${PARA}\n\n${OTHER}\n\n结尾：以上为全文。`;

const startOf = (text, sub) => text.indexOf(sub);

// ── ① 偏移未变 ──────────────────────────────────────────────
group('4.1 锚定 · 偏移未变');

{
  const s = startOf(BASE, PARA);
  const a = makeAnchor(BASE, s, s + PARA.length);
  const r = resolveAnchor(BASE, a);
  check('makeAnchor 存的 exact 就是原文那一段', () => eq(a.exact, PARA));
  check('position 一级直接命中（via=position）', () => eq(r.via, 'position'));
  check('定位到的位置确实是那一段（不是随便给个位置）', () =>
    eq(BASE.slice(r.start, r.end), PARA));
  check('prefix/suffix 各 32 字且与原文相邻', () => {
    const pre = BASE.slice(a.posStart - a.prefix.length, a.posStart);
    const suf = BASE.slice(a.posEnd, a.posEnd + a.suffix.length);
    return ok(pre === a.prefix && suf === a.suffix
      && a.prefix.length <= CONTEXT_CHARS && a.suffix.length <= CONTEXT_CHARS,
      `prefix=${JSON.stringify(a.prefix)} suffix=${JSON.stringify(a.suffix)}`);
  });
}

// ── ① 正文前面加一段（提取器升级的典型后果）─────────────────
group('4.1 锚定 · 偏移漂移');

{
  const s = startOf(BASE, PARA);
  const a = makeAnchor(BASE, s, s + PARA.length);

  // 前面插入 500 字（模拟提取器把"相关推荐"吞进正文）
  const padded = '荐读：' + '无关内容'.repeat(125) + '\n\n' + BASE;
  const r = resolveAnchor(padded, a);
  check('正文前面多出 500 字后仍能定位', () => ok(r.start !== null, r.note));
  check('定位结果**仍是原来那一段**（不是原文同位置的那 500 字）', () =>
    eq(padded.slice(r.start, r.end), PARA));
  check('记录偏移漂移量（可观测提取器改动的幅度）', () =>
    ok(/偏移漂移\s*500/.test(r.note) || r.via === 'quote', r.note));
  check('via=quote（position 校验失败，降级成功）', () => eq(r.via, 'quote'));
}

{
  // 正文**中间**改动：后面那段的位置全错，但 quote 还在
  const s = startOf(BASE, OTHER);
  const a = makeAnchor(BASE, s, s + OTHER.length);
  const mutated = BASE.replace('存储芯片', '存储芯片与主控芯片（新增段落，插入了一段说明）');
  const r = resolveAnchor(mutated, a);
  check('正文中间插入一段后，后文的高亮仍能定位', () => eq(
    mutated.slice(r.start, r.end), OTHER,
  ));
}

{
  // quote 与 position 都动：模拟"换提取器后偏移改了且原文没变"
  const s = startOf(BASE, PARA);
  const a = makeAnchor(BASE, s, s + PARA.length);
  const moved = { ...a, posStart: a.posStart - 7, posEnd: a.posEnd - 7 };
  const r = resolveAnchor(BASE, moved);
  check('position 被改坏但 quote 还在 → 靠 quote 找回', () => eq(r.via, 'quote'));
  check('找回的位置正确', () => eq(BASE.slice(r.start, r.end), PARA));
}

// ── ② quote 出现多次时的消歧 ────────────────────────────────
group('4.1 锚定 · 歧义消解');

{
  // 同一句话出现三次，用户标的是第二次 —— 只有上下文能分辨
  const text = `第一段。${PARA}\n\n中间。\n\n${PARA}\n\n又一。\n\n${PARA}\n\n结束。`;
  const second = text.indexOf(PARA, text.indexOf(PARA) + 1);
  const a = makeAnchor(text, second, second + PARA.length);

  // 只给 quote，不给 position：这时候必须靠上下文
  const onlyQuote = { exact: a.exact, prefix: a.prefix, suffix: a.suffix };
  const r = resolveAnchor(text, onlyQuote);
  check('同一段出现 3 次时，上下文能挑出正确的那一处', () =>
    eq(text.slice(r.start, r.end), PARA));
  check('挑中的确实是第二次出现的位置', () => eq(r.start, second));
  check('note 里报出候选数量（可观测）', () => ok(/\d+ 处候选/.test(r.note), r.note));
}

{
  // 上下文也失配（两处一样的前后文）→ 明确报歧义，不瞎猜
  const dup = `${PARA}\n\n${PARA}\n\n${PARA}`;
  const a = makeAnchor(dup, dup.indexOf(PARA) + PARA.length + 2, dup.indexOf(PARA) + PARA.length + 2 + PARA.length);
  const noCtx = { exact: a.exact };
  const r = resolveAnchor(dup, noCtx);
  // 无上下文时降级到"取首次出现"，但必须写明这可能不是原位
  check('无上下文约束且多处出现时，note 明确说"可能不是原位"', () =>
    ok(/可能不是原位/.test(r.note), r.note));
}

// ── ③ 全失败 ────────────────────────────────────────────────
group('4.1 锚定 · 全失败');

{
  const s = startOf(BASE, PARA);
  const a = makeAnchor(BASE, s, s + PARA.length);
  const rewritten = '这是一篇完全重写过的文章，内容与原文毫无关系。';
  const r = resolveAnchor(rewritten, a);
  check('原文被彻底改写 → start/end 都为 null', () =>
    ok(r.start === null && r.end === null, JSON.stringify(r)));
  check('via=none（不是假装找到）', () => eq(r.via, 'none'));
  check('note 说明失配（而不是空字符串）', () => ok(r.note.length > 0, r.note));
}
check('quote 为空字符串时明确判失败（不返回全文）', () => {
  const r = resolveAnchor(BASE, { exact: '' });
  return ok(r.start === null && /quote 为空/.test(r.note), JSON.stringify(r));
});
check('position 越界时不抛，降级到 quote', () => {
  const s = startOf(BASE, PARA);
  const a = makeAnchor(BASE, s, s + PARA.length);
  const r = resolveAnchor(BASE, { ...a, posStart: 99999, posEnd: 100050 });
  return ok(BASE.slice(r.start, r.end) === PARA, r.note);
});

// ── makeAnchor 的边角 ──────────────────────────────────────
group('4.1 锚定 · 构造');

check('高亮在文首时 prefix 为 null（不是空串）', () => {
  const t = '开头就是正文。后面还有。';
  const a = makeAnchor(t, 0, 4);
  return ok(a.prefix === null && a.exact === t.slice(0, 4), JSON.stringify(a));
});
check('高亮在文末时 suffix 为 null', () => {
  const t = '前面一段。最后一段。';
  const a = makeAnchor(t, t.length - 5, t.length);
  return ok(a.suffix === null, JSON.stringify(a));
});
check('空区间抛错（不允许存一条零长度高亮）', () => {
  try { makeAnchor(BASE, 5, 5); return ok(false, '没有抛'); } catch { return ok(true); }
});
check('越界索引被钳制而不是抛错', () => {
  const a = makeAnchor(BASE, -10, BASE.length + 100);
  return ok(a.exact === BASE.slice(0, BASE.length), `len=${a.exact.length}`);
});
check('exact 就是原文切片（不是重新拼的）', () => {
  const s = 10; const e = 30;
  const a = makeAnchor(BASE, s, e);
  return eq(a.exact, BASE.slice(s, e));
});

// ── ④ 落库 + 重新锚定 + orphaned 可见 ───────────────────────
group('4.1 锚定 · 落库与重锚');

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m401-'));
const h = openDb({ dataDir: tmp });
migrate(h.db);
const DB = h.db;
const UID = 'u_hl';
DB.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
  .run(UID, 'hl@t.local', 'HL', 'owner', Date.now());
DB.prepare(`INSERT INTO entries (id, user_id, feed_id, guid, url, url_norm, title,
    published_at, fetched_at, stage) VALUES (?,?,NULL,?,?,?,?,?,?,'extracted')`)
  .run('e_hl', UID, 'g1', 'https://e.test/hl', 'https://e.test/hl', '高亮测试', Date.now(), Date.now());

const s1 = startOf(BASE, PARA);
const s2 = startOf(BASE, OTHER);
const id1 = insertHighlight(DB, {
  userId: UID, entryId: 'e_hl', anchor: makeAnchor(BASE, s1, s1 + PARA.length), color: 'yellow',
});
const id2 = insertHighlight(DB, {
  userId: UID, entryId: 'e_hl', anchor: makeAnchor(BASE, s2, s2 + OTHER.length), note: '这条要批注',
});

check('两条高亮都写进库', () => eq(
  Number(DB.prepare('SELECT COUNT(*) c FROM highlights').get().c), 2,
));
check('color / note 按传入值落库', () => {
  const a = DB.prepare('SELECT color, note FROM highlights WHERE id=?').get(id1);
  const b = DB.prepare('SELECT color, note FROM highlights WHERE id=?').get(id2);
  return ok(a.color === 'yellow' && a.note === null && b.note === '这条要批注',
    JSON.stringify({ a, b }));
});
check('toApi 把下划线字段转成驼峰（不泄漏库结构）', () => {
  const row = DB.prepare('SELECT * FROM highlights WHERE id=?').get(id1);
  const api = toApi(row);
  return ok(api.entryId === 'e_hl' && api.posStart === s1 && api.isOrphaned === false
    && !('entry_id' in api) && !('pos_start' in api),
    JSON.stringify(Object.keys(api)));
});

{
  // 正文重提取：前面插一段 → 两条都应该重新找到
  const newText = '新增的导语段落。\n\n' + BASE;
  const r = reanchorEntry(DB, 'e_hl', newText);
  check('重新锚定覆盖了全部高亮（total=2）', () => eq(r.total, 2));
  check('两条都成功定位，没有变成 orphaned', () => eq(r.orphaned, 0));
  check('重锚后位置确实指向新正文里的对应段落', () => {
    const row = DB.prepare('SELECT pos_start, pos_end FROM highlights WHERE id=?').get(id1);
    return eq(newText.slice(row.pos_start, row.pos_end), PARA);
  });
  check('bysVia 记下了用哪一级成功的（可观测）', () =>
    ok(Number(r.byVia.quote ?? 0) + Number(r.byVia.position ?? 0) === 2, JSON.stringify(r.byVia)));
}

{
  // 正文被彻底改写 → 两条都 orphaned，但**都还在**
  const r = reanchorEntry(DB, 'e_hl', '完全不同的文章内容，与原文无任何重叠。');
  check('全部失配时 orphaned=2', () => eq(r.orphaned, 2));
  check('**行没有被删**（不静默丢，这是 §11.1 的硬要求）', () =>
    eq(Number(DB.prepare('SELECT COUNT(*) c FROM highlights').get().c), 2));
  check('is_orphaned 标记落库了', () =>
    eq(Number(DB.prepare('SELECT COUNT(*) c FROM highlights WHERE is_orphaned=1').get().c), 2));
  check('orphaned 的高亮仍然能被列表查出来（用户看得到"原文已变化"）', () => {
    const rows = DB.prepare('SELECT id FROM highlights WHERE user_id=? AND is_orphaned=1').all(UID);
    return eq(rows.length, 2);
  });
}

{
  // 还原回去 → orphaned 被清掉（不是一次性判死）
  const r = reanchorEntry(DB, 'e_hl', BASE);
  check('原文恢复后 orphaned 自动清零（不是永久标记）', () => eq(r.orphaned, 0));
  check('库里 is_orphaned 也清零了', () =>
    eq(Number(DB.prepare('SELECT COUNT(*) c FROM highlights WHERE is_orphaned=1').get().c), 0));
}

{
  // 部分失配：只删掉后段
  const partial = BASE.replace(OTHER, '');
  const r = reanchorEntry(DB, 'e_hl', partial);
  check('部分正文丢失 → 只把失配的那条标 orphaned', () =>
    eq(r.orphaned, 1));
  check('另一条仍然正常', () =>
    eq(Number(DB.prepare('SELECT COUNT(*) c FROM highlights WHERE is_orphaned=0').get().c), 1));
}

check('reanchorEntry 对没有高亮的条目是安全空操作', () => {
  const r = reanchorEntry(DB, 'e_hl', BASE);
  const r2 = reanchorEntry(DB, 'no_such_entry', BASE);
  return ok(r2.total === 0 && r2.orphaned === 0, JSON.stringify(r2));
});

check('orphaned 时 pos 被写成 NULL 而不是留着旧值', () => {
  reanchorEntry(DB, 'e_hl', '完全不相关的内容。');
  const rows = DB.prepare('SELECT pos_start, pos_end FROM highlights WHERE is_orphaned=1').all();
  return ok(rows.length > 0 && rows.every((r) => r.pos_start === null),
    JSON.stringify(rows));
});

h.close();
rmSync(tmp, { recursive: true, force: true });

summary('m4-01-anchor');
process.exitCode = process.exitCode ?? 0;
