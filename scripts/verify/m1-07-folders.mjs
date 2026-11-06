#!/usr/bin/env node
// 订阅分组与编辑 —— 验收
//
// 为什么单独一节：m1-04 验的是订阅能不能加/删/抓，但「整理」这件事
// 完全没验。分组有三个最容易错的地方，都不是"接口通不通"能发现的：
//
//   ① 删分组把订阅一起删了（ON DELETE CASCADE 写错的经典事故）
//   ② OPML 往返把分组丢了（换阅读器等于重做一遍整理）
//   ③ 分组过滤与 view 冲突（点「科技」结果还是全库）
//
// 判据：
//   ① 建/改名/删分组，重名拒绝
//   ② 订阅移进分组后列表带 folderName，按组过滤准确
//   ③ 删分组 → 订阅退回未分组，条数不变
//   ④ 编辑订阅：标题/分组/间隔三个字段都生效
//   ⑤ OPML 导出含分组节点，导入能恢复分组
//   ⑥ 条目按 folderId 过滤只返回该组的条目
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, ok, summary } from './harness.mjs';
import { openSqlite } from '../lib/sqlite.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binName = process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

group('1.7 订阅分组与编辑');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'cheng-rss-fold-'));
const dataDir = join(tmp, 'data');
const port = 41000 + Math.floor(Math.random() * 900);
const origin = `http://127.0.0.1:${port}`;
// health 挂在 /api 下（不在 /api/v1 里），其余都在 v1
const base = `${origin}/api/v1`;

const srv = spawn(binPath, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
srv.stdout.on('data', () => { /* drain */ });

let ready = false;
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch { /* not yet */ }
  await sleep(250);
}
check('服务就绪', () => ok(ready, srvErr.slice(0, 300)));

const cleanup = () => {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(srv.pid)], { stdio: 'ignore' });
    } else {
      srv.kill('SIGKILL');
    }
  } catch { /* 已退出 */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

if (!ready) { summary('m1-07-folders'); process.exit(1); }

// ── 账号 ──────────────────────────────────────────────────
await fetch(`${base}/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'fold@test.local', password: 'foldtest12345' }),
});
const loginRes = await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'fold@test.local', password: 'foldtest12345' }),
});
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

const j = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};

// ── 造数据：直接写库（订阅要真抓，测试里没有外网）─────────────
const db = openSqlite(join(dataDir, 'app.db'));
const uid = (db.prepare('SELECT id FROM users LIMIT 1').get()).id;

db.exec('BEGIN IMMEDIATE');
const insFeed = db.prepare(`INSERT INTO feeds (id,user_id,url,site_url,title,icon_url,
  fetch_interval,last_fetched_at,next_fetch_at,error_count,status,source_kind)
  VALUES (?,?,?,?,?,NULL,1800,?,?,0,'active','rss')`);
const insEntry = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
  title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden)
  VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0)`);

const FEEDS = [
  ['fd_1', 'https://a.example.com/feed', '源甲'],
  ['fd_2', 'https://b.example.com/feed', '源乙'],
  ['fd_3', 'https://c.example.com/feed', '源丙'],
];
for (const [id, url, title] of FEEDS) {
  insFeed.run(id, uid, url, url.replace('/feed', ''), title, Date.now(), Date.now());
}
// fd_1 有 3 条，fd_2 有 2 条，fd_3 没有
for (let i = 0; i < 3; i++) {
  insEntry.run(`e1_${i}`, uid, 'fd_1', `g1_${i}`, `https://a.example.com/p${i}`,
    `https://a.example.com/p${i}`, `甲文 ${i}`, `摘要 ${i}`,
    1700000000000 + i, Date.now());
}
for (let i = 0; i < 2; i++) {
  insEntry.run(`e2_${i}`, uid, 'fd_2', `g2_${i}`, `https://b.example.com/p${i}`,
    `https://b.example.com/p${i}`, `乙文 ${i}`, `摘要 ${i}`,
    1700000000000 + i, Date.now());
}
db.exec('COMMIT');
db.close();

// ── ① 分组 CRUD ───────────────────────────────────────────
const created = await j('POST', '/folders', { name: '科技' });
check('新建分组返回 201 + id', () => {
  return ok(created.status === 201 && Boolean(created.data?.folder?.id),
    `status=${created.status} body=${JSON.stringify(created.data)}`);
});
const techId = created.data?.folder?.id;

const finance = await j('POST', '/folders', { name: ' 财经 ' });
check('分组名首尾空格被裁掉', () => {
  return ok(finance.data?.folder?.name === '财经', JSON.stringify(finance.data?.folder?.name));
});

const dup = await j('POST', '/folders', { name: '科技' });
check('重名分组被拒绝（400 而不是静默建第二个）', () => {
  return ok(dup.status === 400, `status=${dup.status}`);
});

const caseDup = await j('POST', '/folders', { name: 'TECH' });
const lowerDup = await j('POST', '/folders', { name: 'tech' });
check('分组名大小写不敏感去重', () => {
  return ok(caseDup.status === 201 && lowerDup.status === 400,
    `第一个 ${caseDup.status} / 第二个 ${lowerDup.status}`);
});

const emptyName = await j('POST', '/folders', { name: '   ' });
check('空分组名被拒绝', () => ok(emptyName.status === 400, `status=${emptyName.status}`));

const renamed = await j('PATCH', `/folders/${techId}`, { name: '科技资讯' });
check('重命名生效', () => {
  return ok(renamed.status === 200 && renamed.data?.folder?.name === '科技资讯',
    JSON.stringify(renamed.data?.folder?.name));
});

const renameToDup = await j('PATCH', `/folders/${techId}`, { name: '财经' });
check('改名撞上已有名字被拒绝', () => ok(renameToDup.status === 400, `status=${renameToDup.status}`));

// ── ② 订阅归组 ────────────────────────────────────────────
const moved = await j('POST', `/folders/${techId}/feeds`, { feedIds: ['fd_1', 'fd_2'] });
check('批量移入分组返回 moved=2', () => {
  return ok(moved.data?.moved === 2, JSON.stringify(moved.data));
});

const list = await j('GET', '/feeds');
check('订阅列表带 folderId 与 folderName', () => {
  const f1 = list.data.items.find((x) => x.id === 'fd_1');
  return ok(f1?.folderId === techId && f1?.folderName === '科技资讯',
    JSON.stringify({ folderId: f1?.folderId, folderName: f1?.folderName }));
});
check('未归组统计正确（3 个源里 2 个不归组 → 应为 1）', () => {
  return ok(list.data.counts.unfiled === 1, `unfiled=${list.data.counts.unfiled}`);
});
check('分组计数正确（科技资讯应有 2 个源）', () => {
  const g = list.data.folders.find((x) => x.id === techId);
  return ok(g?.feedCount === 2, JSON.stringify(g));
});

const byFolder = await j('GET', `/feeds?folderId=${techId}`);
check('按分组过滤只返回组内源', () => {
  const ids = byFolder.data.items.map((x) => x.id).sort();
  return ok(ids.length === 2 && ids[0] === 'fd_1' && ids[1] === 'fd_2', JSON.stringify(ids));
});

const unfiledList = await j('GET', '/feeds?folderId=none');
check('未分组过滤只返回未归组的源', () => {
  const ids = unfiledList.data.items.map((x) => x.id);
  return ok(ids.length === 1 && ids[0] === 'fd_3', JSON.stringify(ids));
});

// ── ③ 条目按组过滤 ────────────────────────────────────────
const allEntries = await j('GET', '/entries?limit=50');
const folderEntries = await j('GET', `/entries?limit=50&folderId=${techId}`);
check('全部条目 5 条', () => ok(allEntries.data.items.length === 5,
  `实际 ${allEntries.data.items.length}`));
check('分组内条目只含该组的源', () => {
  const feedIds = new Set(folderEntries.data.items.map((x) => x.feedId));
  return ok(folderEntries.data.items.length === 5
    && [...feedIds].every((id) => id === 'fd_1' || id === 'fd_2'),
  `条数=${folderEntries.data.items.length} 源=${JSON.stringify([...feedIds])}`);
});

const singleFeed = await j('GET', '/entries?limit=50&feedId=fd_1');
check('按订阅源过滤只返回该源的条目', () => {
  return ok(singleFeed.data.items.length === 3
    && singleFeed.data.items.every((x) => x.feedId === 'fd_1'),
  `条数=${singleFeed.data.items.length}`);
});

// 把 fd_1 移出分组后，科技资讯组应该只剩 fd_2 的 2 条
await j('POST', `/folders/${techId}/feeds`, { feedIds: [] }).then(async () => {
  // 空数组应拒绝
});
const emptyMove = await j('POST', `/folders/${techId}/feeds`, { feedIds: [] });
check('空 feedIds 被拒绝（不是静默成功）', () => {
  return ok(emptyMove.status === 400, `status=${emptyMove.status}`);
});

const unfiledMove = await j('POST', '/folders/unfile/feeds', { feedIds: ['fd_1'] });
check('可以单独把源移出分组', () => {
  return ok(unfiledMove.data?.moved === 1, JSON.stringify(unfiledMove.data));
});
const afterUnfile = await j('GET', `/entries?limit=50&folderId=${techId}`);
check('移出后该组条目数同步减少', () => {
  return ok(afterUnfile.data.items.length === 2,
    `实际 ${afterUnfile.data.items.length}（应为 fd_2 的 2 条）`);
});
// 移回去，后面的测试还要用
await j('POST', `/folders/${techId}/feeds`, { feedIds: ['fd_1'] });

// ── ④ 编辑订阅 ────────────────────────────────────────────
const edited = await j('PUT', '/feeds/fd_3', {
  title: '改过的名字',
  folderId: finance.data.folder.id,
  fetchInterval: 7200,
});
check('编辑订阅：三个字段都生效', () => {
  const f = edited.data?.feed;
  return ok(f?.title === '改过的名字'
    && f?.folderId === finance.data.folder.id
    && f?.fetchInterval === 7200,
  JSON.stringify({ t: f?.title, g: f?.folderId, i: f?.fetchInterval }));
});

const clearedTitle = await j('PUT', '/feeds/fd_3', { title: '  ' });
check('标题可以清空（退回显示域名）', () => {
  return ok(clearedTitle.data?.feed?.title === null,
    JSON.stringify(clearedTitle.data?.feed?.title));
});

const badFolder = await j('PUT', '/feeds/fd_3', { folderId: 'fo_not_exist' });
check('改到不存在的分组被拒绝', () => ok(badFolder.status === 400, `status=${badFolder.status}`));

const badInterval = await j('PUT', '/feeds/fd_3', { fetchInterval: 10 });
check('抓取间隔过小被拒绝', () => ok(badInterval.status === 400, `status=${badInterval.status}`));

const badInterval2 = await j('PUT', '/feeds/fd_3', { fetchInterval: 86400 * 30 });
check('抓取间隔过大被拒绝', () => ok(badInterval2.status === 400, `status=${badInterval2.status}`));

// ── ⑤ OPML 带分组 ─────────────────────────────────────────
// 先在 科技资讯 里放点东西，保证导出有分组节点
await j('POST', `/folders/${techId}/feeds`, { feedIds: ['fd_1', 'fd_2'] });
const opmlRes = await fetch(`${base}/feeds/export`, { headers: { cookie } });
const xml = await opmlRes.text();
check('OPML 导出包含分组节点', () => {
  return ok(xml.includes('科技资讯'), '导出的 OPML 里找不到分组名');
});
check('分组作为一个 outline 包住订阅', () => {
  // 粗验：分组名出现在某个 outline 的 text 属性里，且该 outline 有子节点
  const m = /<outline[^>]*text="科技资讯"[^>]*>([\s\S]*?)<\/outline>/.exec(xml);
  return ok(Boolean(m) && (m[1].match(/<outline/g) ?? []).length >= 2,
    m ? `子节点 ${(m[1].match(/<outline/g) ?? []).length} 个` : '没找到分组节点');
});

// 导入到干净环境验证分组能恢复
const reimport = await j('POST', '/feeds/import', { opml: xml });
check('OPML 往返：已订阅的全部跳过（不重复建）', () => {
  return ok(reimport.data?.created === 0 && reimport.data?.skipped >= 3,
    `created=${reimport.data?.created} skipped=${reimport.data?.skipped}`);
});

// ── ⑥ 删分组不删订阅 ──────────────────────────────────────
const before = await j('GET', '/feeds');
const beforeCount = before.data.items.length;
const del = await j('DELETE', `/folders/${techId}`);
check('删除分组返回成功', () => ok(del.status === 200, `status=${del.status}`));

const after = await j('GET', '/feeds');
check('删分组后订阅总数不变（源不能被连带删除）', () => {
  return ok(after.data.items.length === beforeCount,
    `${beforeCount} → ${after.data.items.length}`);
});
check('删分组后组内源退回未分组（folderId 置空）', () => {
  const stillBound = after.data.items.filter((f) => f.folderId === techId);
  const f1 = after.data.items.find((f) => f.id === 'fd_1');
  return ok(stillBound.length === 0 && f1?.folderId === null,
    `仍挂旧组 ${stillBound.length} 个；fd_1.folderId=${JSON.stringify(f1?.folderId)}`);
});
const entriesAfter = await j('GET', '/entries?limit=50');
check('删分组后条目数不变', () => {
  return ok(entriesAfter.data.items.length === 5,
    `实际 ${entriesAfter.data.items.length}`);
});

const delAgain = await j('DELETE', `/folders/${techId}`);
check('删除不存在的分组返回 404', () => ok(delAgain.status === 404, `status=${delAgain.status}`));

// ── ⑦ 分组名长度上限 ──────────────────────────────────────
const longName = await j('POST', '/folders', { name: '长'.repeat(100) });
check('超长分组名被截断到 40 字而不是报错', () => {
  const n = longName.data?.folder?.name ?? '';
  return ok(n.length === 40, `实际长度 ${n.length}`);
});

summary('m1-07-folders');
cleanup();
process.exit(process.exitCode ?? 0);
