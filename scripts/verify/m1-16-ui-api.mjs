#!/usr/bin/env node
// 1.16 列表/阅读/历史 API —— 验收（PLAN §19.3 1.16 + §7.4）
//
// 判据：
//   ① 游标分页不重复不漏 —— 包括"同一毫秒多条"这种必须靠 id 打破平局的场景
//   ② POST /read 两次 → read_count = 2（first_read_at 不变、last_read_at 前进）
//   ③ 历史按日期分组正确（今天 / 昨天 / 本周 / 更早）
//
// 这一节最容易假绿的地方：
//
//   A. 「分了 30 页，翻完条数对」很容易绿 —— 但如果每页都从头开始，
//      条数也会对（只是重复）。必须**收集 id 集合**，断言 |集合| = total。
//   B. 「同一毫秒的条目」不测就会漏。published_at 相同的两条之间，
//      `published_at < ?` 一条都翻不过去 —— 全排在游标时间上，
//      翻页会永远卡住或成批重复。ids 里带下划线，游标拼接方式也在这里出错。
//   C. 「历史分组」如果用 86400000 的除法算天数，跨月/跨年边界会错；
//      如果按 UTC 算，东八区凌晨 1 点读的东西会被算成"昨天"。
//      必须用本地日历日，且边界值（23:59:59 / 00:00:00）要逐个断言。
//   D. 「read_count 变成 2」不能只看数字 —— 实现可能顺手把
//      first_read_at 也覆盖掉，那样"第一次读是什么时候"就永久丢了。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { group, check, eq, ok, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';
import { removeDir } from '../lib/tmp.mjs';
import { bucketOf, groupByDay, HISTORY_BUCKETS } from '../../src/server/entries/history.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A. 日期分桶（纯函数）──────────────────────────────────
group('1.16 · 历史日期分桶');

/** 构造"本地时间某天某点"的时间戳，避免测试被 UTC 偏移影响 */
const localTs = (y, m, d, hh = 12, mm = 0, ss = 0) => new Date(y, m - 1, d, hh, mm, ss, 0).getTime();

const NOW = localTs(2026, 10, 27, 15, 30); // 2026-10-27 15:30 本地

check('今天读的 → today', () => {
  return eq(bucketOf(localTs(2026, 10, 27, 9, 0), NOW), 'today');
});

check('今天 00:00:00 整点仍是 today（边界）', () => {
  return eq(bucketOf(localTs(2026, 10, 27, 0, 0, 0), NOW), 'today');
});

check('昨天 23:59:59 是 yesterday 而不是 today（边界）', () => {
  return eq(bucketOf(localTs(2026, 10, 26, 23, 59, 59), NOW), 'yesterday');
});

check('昨天 00:00:00 整点仍是 yesterday（边界）', () => {
  return eq(bucketOf(localTs(2026, 10, 26, 0, 0, 0), NOW), 'yesterday');
});

check('前天 → week', () => {
  return eq(bucketOf(localTs(2026, 10, 25, 12, 0), NOW), 'week');
});

check('6 天前 → week', () => {
  return eq(bucketOf(localTs(2026, 10, 21, 12, 0), NOW), 'week');
});

check('7 天前 → earlier（week 是最近 7 天内，不含昨天/今天）', () => {
  return eq(bucketOf(localTs(2026, 10, 20, 12, 0), NOW), 'earlier');
});

check('跨月边界：9 月 30 日 → earlier，10 月 1 日 → earlier 但距离更近', () => {
  // 不能因为"月份不同"就分错，也不能因为"日期数字更大"就分错
  return ok(
    bucketOf(localTs(2026, 9, 30, 12, 0), NOW) === 'earlier'
      && bucketOf(localTs(2026, 10, 1, 12, 0), NOW) === 'earlier',
    `${bucketOf(localTs(2026, 9, 30, 12, 0), NOW)} / ${bucketOf(localTs(2026, 10, 1, 12, 0), NOW)}`,
  );
});

check('跨年边界：去年 12 月 31 日 → earlier', () => {
  return eq(bucketOf(localTs(2025, 12, 31, 23, 0), NOW), 'earlier');
});

check('未来时间（时钟偏差）不崩，归入 today', () => {
  // 客户端时钟比服务器快时，条目可能"未来"发布；抛错或归到 earlier 都很怪
  return eq(bucketOf(NOW + 3600_000, NOW), 'today');
});

check('非法时间戳返回 earlier 而不是抛错', () => {
  const bad = [NaN, 0, -1];
  const got = bad.map((b) => {
    try { return bucketOf(b, NOW); } catch { return 'throw'; }
  });
  return ok(!got.includes('throw'), JSON.stringify(got));
});

check('桶的顺序是 今天→昨天→本周→更早', () => {
  return eq(HISTORY_BUCKETS.join(','), 'today,yesterday,week,earlier');
});

check('groupByDay 按桶聚合且保持输入顺序', () => {
  const items = [
    { id: 'a', at: localTs(2026, 10, 27, 10, 0) },
    { id: 'b', at: localTs(2026, 10, 26, 10, 0) },
    { id: 'c', at: localTs(2026, 10, 27, 9, 0) },  // 与 a 同桶，靠后
    { id: 'd', at: localTs(2026, 10, 20, 10, 0) },
  ];
  const gs = groupByDay(items, (x) => x.at, NOW);
  const shape = gs.map((g) => `${g.key}:${g.items.map((i) => i.id).join('')}`);
  return eq(shape.join('|'), 'today:ac|yesterday:b|earlier:d');
});

check('groupByDay 空输入返回空数组（不是 4 个空桶）', () => {
  return eq(groupByDay([], (x) => x.at, NOW).length, 0);
});

check('groupByDay 跳过没有条目的桶（不渲染空分组）', () => {
  const gs = groupByDay([{ at: localTs(2026, 10, 27, 10, 0) }], (x) => x.at, NOW);
  return eq(gs.map((g) => g.key).join(','), 'today');
});

// ── B. 端到端 ─────────────────────────────────────────────
group('1.16 · 端到端');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-m116-'));
const dataDir = join(tmp, 'data');
const port = 42100 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;

const srv = spawn(binPath, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
srv.stdout.on('data', () => { /* 吃掉 */ });

const cleanup = () => {
  try { killTree(srv.pid); } catch { /* 已退出 */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
onExit(cleanup);

let ready = false;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok) { ready = true; break; }
  } catch { /* 还没起来 */ }
  await sleep(250);
}
check('服务就绪', () => ok(ready, srvErr.slice(0, 300)));
if (!ready) { summary('m1-16-ui-api'); cleanup(); process.exit(1); }

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ui@test.local', password: 'uitest12345678' }),
});
const loginRes = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ui@test.local', password: 'uitest12345678' }),
});
const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
check('登录成功', () => ok(cookie.includes('='), cookie));

const api = async (path, init = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
};

const dbPath = join(dataDir, 'app.db');
const withDb = (fn) => {
  const d = new DatabaseSync(dbPath);
  try { return fn(d); } finally { d.close(); }
};
const one = (sql, ...args) => withDb((d) => d.prepare(sql).get(...args));

const uid = one('SELECT id FROM users LIMIT 1')?.id;

// 造 250 条，其中**前 120 条 published_at 完全相同** —— 这是游标最容易漏的地方
{
  withDb((d) => {
    const now = Date.now();
    const sameMs = now - 5000;
    const ins = d.prepare(
      `INSERT INTO entries (id,user_id,guid,url,url_norm,title,published_at,fetched_at,stage)
       VALUES (?,?,?,?,?,?,?,?, 'extracted')`,
    );
    d.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 250; i++) {
      // 前 120 条同一毫秒；其余每条间隔 1ms 递减（保证严格倒序可测）
      const pub = i < 120 ? sameMs : sameMs - (i - 119) * 1000;
      const id = `e_${String(i).padStart(4, '0')}${'0'.repeat(12)}`;
      ins.run(id, uid, `g-${i}`, `http://p.test/${i}`, `http://p.test/${i}`,
        `条目 ${String(i).padStart(3, '0')}`, pub, now);
    }
    d.exec('COMMIT');
  });
}

// ── ① 游标分页：不重不漏 ──
{
  const seen = new Map(); // id -> 出现次数
  let cursor = null;
  let pages = 0;
  let firstTotal = null;
  const guard = 200;
  while (pages < guard) {
    const qs = new URLSearchParams({ limit: '30' });
    if (cursor) qs.set('cursor', cursor);
    const r = await api(`/entries?${qs}`);
    if (pages === 0) firstTotal = Number(r.body?.total);
    const items = r.body?.items ?? [];
    for (const it of items) seen.set(it.id, (seen.get(it.id) ?? 0) + 1);
    pages++;
    cursor = r.body?.nextCursor;
    if (!cursor) break;
    if (items.length === 0) break;
  }

  check('翻页次数合理（250 条 / 30 ≈ 9 页）', () => {
    return ok(pages >= 8 && pages <= 12, `实际 ${pages} 页`);
  });
  check('合计取到的条数 = total（不漏）', () => {
    return eq(seen.size, firstTotal);
  });
  check('没有任何 id 出现两次（不重复）', () => {
    const dups = [...seen.entries()].filter(([, n]) => n > 1);
    return ok(dups.length === 0, `${dups.length} 个 id 重复: ${dups.slice(0, 3).map(([k, n]) => `${k}×${n}`).join(', ')}`);
  });
  check('前 120 条（同一毫秒）全部翻到', () => {
    let n = 0;
    for (let i = 0; i < 120; i++) {
      const id = `e_${String(i).padStart(4, '0')}${'0'.repeat(12)}`;
      if (seen.has(id)) n++;
    }
    return eq(n, 120);
  });
  // 顺序断言要翻完所有页，先取齐再断言。
  // （不能在 check() 回调里 await —— 它是同步函数，harness 会直接报
  //  「回调不能是 async」，而把 await 硬塞进去是语法错误。先取数后断言。）
  const orderBad = [];
  {
    let prev = null;
    let cur = null;
    let guard2 = 0;
    while (guard2++ < 40) {
      const qs = new URLSearchParams({ limit: '50' });
      if (cur) qs.set('cursor', cur);
      const r = await api(`/entries?${qs}`);
      for (const it of r.body?.items ?? []) {
        if (prev) {
          if (it.publishedAt > prev.publishedAt) orderBad.push(`时间上升 ${prev.id}→${it.id}`);
          if (it.publishedAt === prev.publishedAt && it.id >= prev.id) {
            orderBad.push(`同毫秒未按 id 倒序 ${prev.id}→${it.id}`);
          }
        }
        prev = it;
      }
      cur = r.body?.nextCursor;
      if (!cur) break;
    }
  }
  check('翻页顺序严格按 published_at 倒序（同一毫秒内按 id 倒序）', () => {
    return ok(orderBad.length === 0,
      `${orderBad.length} 处乱序: ${orderBad.slice(0, 3).join(', ')}`);
  });
}

// ── ② POST /read 两次 → read_count = 2 ──
{
  const target = 'e_0000000000000000';
  const r1 = await api('/entries/read', { method: 'POST', body: JSON.stringify({ ids: [target] }) });
  check('第一次标已读返回 ok', () => ok(r1.body?.ok === true, JSON.stringify(r1.body)));

  const after1 = one('SELECT is_read, read_count, first_read_at, last_read_at FROM entries WHERE id = ?', target);
  check('第一次后 read_count = 1', () => eq(Number(after1.read_count), 1));
  check('第一次后 is_read = 1', () => eq(Number(after1.is_read), 1));
  check('第一次后 first_read_at 有值', () => ok(Number(after1.first_read_at) > 0, `first=${after1.first_read_at}`));

  await sleep(30);
  await api('/entries/read', { method: 'POST', body: JSON.stringify({ ids: [target] }) });

  const after2 = one('SELECT read_count, first_read_at, last_read_at FROM entries WHERE id = ?', target);
  check('第二次后 read_count = 2（不是被幂等跳过）', () => eq(Number(after2.read_count), 2));
  check('first_read_at 没被第二次覆盖（仍是最早那次）', () => {
    return eq(Number(after2.first_read_at), Number(after1.first_read_at));
  });
  check('last_read_at 前进了（"最近读过"排序依赖它）', () => {
    return ok(Number(after2.last_read_at) > Number(after1.last_read_at),
      `${after1.last_read_at} → ${after2.last_read_at}`);
  });

  // 未读回退不应抹掉阅读历史
  await api('/entries/unread', { method: 'POST', body: JSON.stringify({ ids: [target] }) });
  const afterUn = one('SELECT is_read, read_count, first_read_at, last_read_at FROM entries WHERE id = ?', target);
  check('标记未读后 is_read = 0', () => eq(Number(afterUn.is_read), 0));
  check('标记未读不清零 read_count（读过了是事实）', () => eq(Number(afterUn.read_count), 2));
  check('标记未读不清零 first_read_at（历史页依赖它）', () => {
    return eq(Number(afterUn.first_read_at), Number(after1.first_read_at));
  });

  // 详情响应把这些字段带出来（前端要显示"读过 N 次"）
  const detail = await api(`/entries/${target}`);
  check('详情返回 readCount', () => {
    return ok(detail.body?.readCount !== undefined, `readCount=${detail.body?.readCount}`);
  });

  // 把这条恢复成"没读过"：下面「历史分组」那组断言点的是具体条目与精确条数，
  // 留着它会让 today 组凭空多一条 —— 那不是在验证分桶，是在被前面的用例污染。
  withDb((d) => {
    d.prepare(`UPDATE entries SET is_read = 0, read_count = 0,
                                  first_read_at = NULL, last_read_at = NULL,
                                  read_progress = NULL WHERE id = ?`).run(target);
  });
}

// ── ③ 历史按日期分组 ──
{
  // 用绝对本地日期造数据，覆盖四个桶。
  //
  // **publishedAt 与 lastReadAt 必须刻意不同**：早先两者都填同一个值，
  // 于是"历史行显示的是读的时间还是发布的时间"这条断言分不出来
  // （实测把行内改成 timeAgo(publishedAt)，UI 断言照样全绿）。
  // 这里让发布时间统一比阅读时间早 5 天。
  const now = Date.now();
  const today = new Date(); today.setHours(10, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const threeDaysAgo = new Date(today); threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const longAgo = new Date(today); longAgo.setDate(longAgo.getDate() - 30);
  const FIVE_DAYS = 5 * 86400_000;

  const plan = [
    // 第 4 列是 read_count：B 读了 3 次，用来验"回看角标"确实渲染
    ['e_h_today1', today.getTime(), '今天读的 A', 1],
    ['e_h_today2', today.getTime() + 3600_000, '今天读的 B', 3],
    ['e_h_yday', yesterday.getTime(), '昨天读的', 1],
    ['e_h_week', threeDaysAgo.getTime(), '三天前读的', 1],
    ['e_h_old', longAgo.getTime(), '一个月前读的', 1],
  ];
  withDb((d) => {
    const ins = d.prepare(
      `INSERT INTO entries (id,user_id,guid,url,url_norm,title,published_at,fetched_at,
                            is_read,first_read_at,last_read_at,read_count,stage)
       VALUES (?,?,?,?,?,?,?,?,1,?,?,?,'extracted')`,
    );
    d.exec('BEGIN IMMEDIATE');
    for (const [id, at, title, rc] of plan) {
      // published_at 比 last_read_at 早 5 天，两者绝不相等
      ins.run(id, uid, `g-${id}`, `http://h.test/${id}`, `http://h.test/${id}`,
        title, at - FIVE_DAYS, now, at, at, rc);
    }
    d.exec('COMMIT');
  });

  const h = await api('/entries/history?limit=50');
  check('历史接口返回 200', () => eq(h.status, 200));

  const groups = h.body?.groups ?? [];
  check('返回 4 个分组（今天/昨天/本周/更早）', () => {
    return eq(groups.map((g) => g.key).join(','), 'today,yesterday,week,earlier');
  });
  check('分组顺序是 今天 → 昨天 → 本周 → 更早', () => {
    return eq(groups.map((g) => g.key).join(','), 'today,yesterday,week,earlier');
  });
  check('每组有条数与中文标题', () => {
    const shape = groups.map((g) => `${g.key}:${g.count}`);
    return eq(shape.join('|'), 'today:2|yesterday:1|week:1|earlier:1');
  });
  check('每个分组都有中文标题（渲染时不该出现英文 key）', () => {
    return eq(groups.map((g) => g.title).join(','), '今天,昨天,本周,更早');
  });
  check('今天组里是那两条（A、B）', () => {
    const g = groups.find((x) => x.key === 'today');
    const ids = (g?.items ?? []).map((x) => x.id).sort().join(',');
    return eq(ids, 'e_h_today1,e_h_today2');
  });
  check('昨天组里只有昨天那条（没把今天的算进去）', () => {
    const g = groups.find((x) => x.key === 'yesterday');
    return eq((g?.items ?? []).map((x) => x.id).join(','), 'e_h_yday');
  });
  check('更早组里只有一个月前那条', () => {
    const g = groups.find((x) => x.key === 'earlier');
    return eq((g?.items ?? []).map((x) => x.id).join(','), 'e_h_old');
  });
  check('组内按 last_read_at 倒序', () => {
    const g = groups.find((x) => x.key === 'today');
    const ts = (g?.items ?? []).map((x) => x.readAt);
    return ok(ts.length === 2 && ts[0] >= ts[1], JSON.stringify(ts));
  });
  check('条目带 readAt，而不是拿 publishedAt 冒充', () => {
    const g = groups.find((x) => x.key === 'yesterday');
    const it = g?.items?.[0];
    // yesterday 那条的 publishedAt 与 lastReadAt 刻意相等，但字段必须都在
    return ok(it && typeof it.readAt === 'number' && typeof it.publishedAt === 'number',
      JSON.stringify(it && { readAt: it.readAt, publishedAt: it.publishedAt }));
  });
  check('没读过的条目不出现在历史里（负向）', () => {
    const all = groups.flatMap((g) => g.items ?? []).map((x) => x.id);
    return ok(!all.includes('e_0001000000000000'), '未读条目混进了历史');
  });

  // 历史视图的游标也必须按 last_read_at，不能拿 published_at 比
  const page1 = await api('/entries/history?limit=2');
  check('历史分页第一页 2 条', () => {
    const n = (page1.body?.groups ?? []).flatMap((g) => g.items ?? []).length;
    return eq(n, 2);
  });
  check('历史分页返回 nextCursor', () => {
    return ok(typeof page1.body?.nextCursor === 'string', `nextCursor=${page1.body?.nextCursor}`);
  });
  check('history 的 total 是"读过的总数"，不是本页条数', () => {
    // 5 条读过的 + 本组用例里没有别的已读 → total 必须是 5
    return eq(Number(page1.body?.total), 5);
  });
  let page2Total = null;
  if (page1.body?.nextCursor) {
    const page2 = await api(`/entries/history?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
    page2Total = Number(page2.body?.total);
    const ids1 = (page1.body.groups ?? []).flatMap((g) => g.items ?? []).map((x) => x.id);
    const ids2 = (page2.body?.groups ?? []).flatMap((g) => g.items ?? []).map((x) => x.id);
    check('历史翻页两页无重叠', () => {
      return ok(ids2.every((id) => !ids1.includes(id)), `p1=${ids1} p2=${ids2}`);
    });
    check('历史翻页第二页有内容（不是提前结束）', () => {
      return ok(ids2.length > 0, `p2=${JSON.stringify(ids2)}`);
    });
    check('翻页后 total 不缩小（用不含游标的条件算）', () => {
      // 若实现拿带游标的 where 算 total，第二页会变成 3
      return ok(page2Total === 5, `第二页 total=${page2Total}`);
    });
  }
}

// ── ④ 游标对非法输入的处理 ──
{
  const bad = await api('/entries?cursor=not-a-cursor');
  check('畸形游标不 500（忽略它或 400，不能崩）', () => {
    return ok(bad.status === 200 || bad.status === 400, `status=${bad.status}`);
  });
  const neg = await api('/entries?limit=-5');
  check('负数 limit 不 500', () => ok(neg.status === 200, `status=${neg.status}`));
  const huge = await api('/entries?limit=100000');
  check('超大 limit 被夹到上限 100', () => {
    return ok((huge.body?.items ?? []).length <= 100, `实际 ${(huge.body?.items ?? []).length} 条`);
  });
}

// ── ⑤ 历史视图的界面渲染 ──
//
// 接口对了不等于界面对：分组标题有没有渲染出来、行内显示的是"读的时间"
// 还是"发布的时间"、读过多次有没有角标 —— 这三条只有看 DOM 才知道。
group('1.16 · 历史视图界面');

const CANDIDATES = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
const browserPath = CANDIDATES.find((p) => existsSync(p));

if (!browserPath) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器，UI 断言跳过');
} else {
  const profile = mkdtempSync(join(tmpdir(), 'cheng-rss-hprof-'));
  const cdpPort = 9700 + Math.floor(Math.random() * 90);
  const proc = spawn(browserPath, [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--window-size=1440,960', 'about:blank',
  ], { stdio: 'ignore' });

  // 只杀我们自己起的这个 PID —— 绝不用 /IM 按镜像名杀
  // （用户自己的浏览器也是 msedge.exe）。
  const killBrowser = () => {
    try { killTree(proc.pid); } catch { /* 已退出 */ }
    removeDir(profile);
  };
  onExit(killBrowser);

  let target = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch { /* not yet */ }
    await sleep(250);
  }

  if (!target?.webSocketDebuggerUrl) {
    check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
  } else {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      }
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval 失败');
      }
      return r.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 960, deviceScaleFactor: 1, mobile: false,
    });
    await send('Network.setCookie', {
      name: 'cheng_rss_sid', value: cookie.split('=')[1] ?? '',
      domain: '127.0.0.1', path: '/',
    });
    await send('Page.navigate', { url: base });
    for (let i = 0; i < 80; i++) {
      if (await ev('document.readyState === "complete"').catch(() => false)) break;
      await sleep(150);
    }
    await sleep(1500);

    const clickNav = async (label) => {
      const r = await ev(`(() => {
        const b = [...document.querySelectorAll('.nav-item')]
          .find((x) => (x.textContent || '').replace(/\\d+/g, '').trim() === ${JSON.stringify(label)});
        if (!b) return false;
        b.click();
        return true;
      })()`);
      await sleep(1400);
      return r;
    };

    const navOk = await clickNav('历史');
    check('侧栏能找到「历史」入口', () => ok(navOk, '没找到 .nav-item「历史」'));

    const snap = await ev(`(() => {
      const groups = [...document.querySelectorAll('.hist-group')].map((g) => ({
        bucket: g.getAttribute('data-bucket'),
        title: (g.querySelector('.hist-title')?.childNodes[0]?.textContent ?? '').trim(),
        count: (g.querySelector('.hist-count')?.textContent ?? '').trim(),
        rows: g.querySelectorAll('.entry-item').length,
      }));
      const firstRow = document.querySelector('.hist-group .entry-item');
      return {
        groups,
        titles: [...document.querySelectorAll('.hist-title')]
          .map((h) => (h.childNodes[0]?.textContent ?? '').trim()),
        // 历史行的元信息里显示的是什么时间 —— 这里只能查"有没有 title 提示"
        firstTimeTitle: firstRow?.querySelector('.entry-time')?.getAttribute('title') ?? null,
        firstTimeText: firstRow?.querySelector('.entry-time')?.textContent ?? null,
        hasReadCount: document.querySelectorAll('.read-count').length,
        readCountTexts: [...document.querySelectorAll('.read-count')]
          .map((x) => (x.textContent || '').trim()),
        emptyShown: Boolean(document.querySelector('.empty')),
        sticky: (() => {
          const h = document.querySelector('.hist-title');
          return h ? getComputedStyle(h).position : null;
        })(),
      };
    })()`);

    check('历史视图渲染出分组（不是平铺一张列表）', () => {
      return ok((snap?.groups?.length ?? 0) >= 3, JSON.stringify(snap?.groups));
    });
    check('分组标题是中文（今天/昨天/本周/更早）', () => {
      const cn = ['今天', '昨天', '本周', '更早'];
      const bad = (snap?.titles ?? []).filter((t) => !cn.includes(t));
      return ok(bad.length === 0 && (snap?.titles ?? []).length > 0,
        `标题: ${JSON.stringify(snap?.titles)}`);
    });
    check('分组顺序是今天 → 昨天 → 本周 → 更早', () => {
      const order = ['today', 'yesterday', 'week', 'earlier'];
      const got = (snap?.groups ?? []).map((g) => g.bucket);
      const idx = got.map((k) => order.indexOf(k));
      return ok(idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])), JSON.stringify(got));
    });
    check('每个分组的条数与实际渲染的行数一致', () => {
      const bad = (snap?.groups ?? []).filter((g) => String(g.rows) !== String(g.count));
      return ok(bad.length === 0, JSON.stringify(bad));
    });
    check('历史行的时间是"读的时间"，并保留发布时间作为提示', () => {
      // 行内显示 readAt；title 里写着"发布于 …" —— 两个时间都在，
      // 混成一个的话用户无法区分"这篇很旧但我刚读"和"刚发布我就读了"。
      //
      // 光看 title 不够：实测把行内改成 timeAgo(publishedAt) 时，
      // title 依然在，断言照样绿。这里必须**比对渲染出来的文案**：
      // 数据里 readAt 是今天、publishedAt 是 5 天前，两者的相对时间文案
      // 一个不含"天"、一个含"天"，正好能区分。
      return ok(
        typeof snap?.firstTimeText === 'string' && snap.firstTimeText.length > 0
          && typeof snap?.firstTimeTitle === 'string' && snap.firstTimeTitle.includes('发布于')
          && !snap.firstTimeText.includes('天'),
        `text=${snap?.firstTimeText} title=${snap?.firstTimeTitle}`,
      );
    });
    check('分组标题是粘性的（滚动时仍在顶上）', () => {
      return eq(snap?.sticky, 'sticky');
    });
    check('历史视图没有误显示「还没有阅读记录」', () => {
      return ok(snap?.emptyShown === false, '空状态被错误渲染');
    });
    check('读过多次的条目渲染出 ×N 角标', () => {
      // 数据里 B 是 read_count=3、其余为 1 —— 角标数量必须正好是 1，
      // 而不是"有角标就行"（那样 read_count>=1 全标一遍也绿）
      return eq(snap?.hasReadCount, 1);
    });
    check(' ×N 角标的文案是实际的次数（×3）', () => {
      return ok((snap?.readCountTexts ?? []).includes('×3'),
        `实际 ${JSON.stringify(snap?.readCountTexts)}`);
    });

    // 必须主动收尾：WebSocket 与浏览器进程都会占住事件循环，
    // 不收就等于把脚本挂在那儿直到被外部杀掉（实测跑了 5 分钟不退）。
    try { ws.close(); } catch { /* ignore */ }
    killBrowser();
  }
}

summary('m1-16-ui-api');
cleanup();
process.exit(process.exitCode ?? 0);
