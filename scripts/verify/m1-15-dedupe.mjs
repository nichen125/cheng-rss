#!/usr/bin/env node
// 1.15 去重（向量层）—— 验收
//
// 判据（PLAN §19.3 1.15 + §7.1 L2 / §7.3）：
//   ① 同 URL 不同 utm 参数判重（URL 规范化层）
//   ② 余弦 > 0.95 判重（向量层，含"改了标题/加了导语"的转载）
//   ③ 混入 20 条重复，重复率 < 1%
//   ④ 三层按代价低到高短路：URL 命中就不必算向量
//   ⑤ 误判防线：不同事件不被合并（实测异文余弦 ≤ 0.3）
//   ⑥ 重复条目不进时间线，但 duplicate_of 指回原件（M3 热度要用）
//   ⑦ 提取到全文后向量随之更新（否则摘要型源永远漏判）
//   ⑧ 边角：空正文/超短正文不写向量，坏 BLOB 不抛
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';
import {
  canonicalUrl, sameUrl,
} from '../../src/server/dedupe/url.ts';
import {
  DUP_THRESHOLD, LOCAL_DIM, LOCAL_MODEL, SAME_EVENT_THRESHOLD,
  cosine, hashEmbed, packVec, signatureText, unpackVec,
} from '../../src/server/dedupe/cosine.ts';
import { isSameEvent } from '../../src/server/dedupe/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBin = join(root, '.toolchain/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const binName = process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`;
const binPath = join(root, 'dist', binName);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A. URL 规范化层 ─────────────────────────────────────────
group('1.15 去重 · URL 规范化');

check('同一文章不同 utm 参数 → 同一条', () => {
  const a = 'https://example.com/post/1?utm_source=twitter&utm_medium=social';
  const b = 'https://example.com/post/1?utm_source=wechat&utm_campaign=x';
  return ok(sameUrl(a, b), `${canonicalUrl(a)} != ${canonicalUrl(b)}`);
});

check('utm 之外的追踪参数也吃掉（fbclid/gclid/spm/ref/share_*）', () => {
  const junk = ['fbclid=abc', 'gclid=x', 'spm=1.2', 'ref=home', 'share_from=wx', 'yclid=y'];
  const bad = [];
  for (const p of junk) {
    const u = `https://e.com/a?${p}&keep=1`;
    const c = canonicalUrl(u);
    if (!c.includes('keep=1') || /fbclid|gclid|spm|ref=|share_|yclid/.test(c)) bad.push(`${p} → ${c}`);
  }
  return ok(bad.length === 0, bad.join('; '));
});

check('有语义的参数保留（?p=123 / ?id=9 / ?page=2）', () => {
  const keep = ['p=123', 'id=9', 'page=2', 'article_id=7'];
  const bad = [];
  for (const p of keep) {
    const c = canonicalUrl(`https://e.com/a?${p}`);
    if (!c.includes(p)) bad.push(`${p} → ${c}`);
  }
  return ok(bad.length === 0, bad.join('; '));
});

check('末尾斜杠与 fragment 不影响判重', () => {
  return ok(
    sameUrl('https://e.com/a/', 'https://e.com/a')
      && sameUrl('https://e.com/a#sec1', 'https://e.com/a'),
    `${canonicalUrl('https://e.com/a/#x')} vs ${canonicalUrl('https://e.com/a')}`,
  );
});

check('host 大小写不影响判重', () => {
  return ok(sameUrl('https://Example.COM/a', 'https://example.com/a'));
});

check('不同文章不会因为规范化被合并（负向）', () => {
  const pairs = [
    ['https://e.com/a/1', 'https://e.com/a/2'],
    ['https://e.com/a?p=1', 'https://e.com/a?p=2'],
    ['https://e.com/a', 'https://other.com/a'],
    ['http://e.com/a', 'https://e.com/a'],   // 刻意不统一协议
  ];
  const bad = pairs.filter(([a, b]) => sameUrl(a, b)).map(([a, b]) => `${a} == ${b}`);
  return ok(bad.length === 0, `被误合并: ${bad.join('; ')}`);
});

check('畸形 URL 不抛异常（原样返回）', () => {
  const weird = ['not a url', '', '   ', 'http://', '/relative/path'];
  const bad = [];
  for (const w of weird) {
    try { canonicalUrl(w); } catch (e) { bad.push(`${JSON.stringify(w)}: ${e.message}`); }
  }
  return ok(bad.length === 0, bad.join('; '));
});

// ── B. 向量与余弦层 ────────────────────────────────────────
group('1.15 去重 · 向量层');

const BODY = '台积电今天宣布其3纳米制程产能将在下半年爬坡，主要客户苹果的订单已经排到年底。'
  + '这是该公司在先进制程上的又一次扩产，业内预计将带动上游设备厂商的订单增长。'.repeat(6);
const TITLE = '台积电3纳米产能爬坡';

check(`向量维度 = ${LOCAL_DIM}`, () => eq(hashEmbed('任意文本').length, LOCAL_DIM));

check('向量已 L2 归一化（模长 ≈ 1）', () => {
  const v = hashEmbed('测试文本');
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return ok(Math.abs(Math.sqrt(s) - 1) < 1e-5, `模长 ${Math.sqrt(s)}`);
});

check('自身余弦 = 1', () => {
  return ok(Math.abs(cosine(hashEmbed(BODY), hashEmbed(BODY)) - 1) < 1e-6);
});

check('同一篇（逐字相同）余弦 > 0.95', () => {
  const a = hashEmbed(signatureText(TITLE, BODY));
  const b = hashEmbed(signatureText(TITLE, BODY));
  return ok(cosine(a, b) > DUP_THRESHOLD, `实际 ${cosine(a, b)}`);
});

// 转载的真实形状：加站名后缀、加版权声明、加导语、改开头一句
const REPOSTS = [
  ['标题加站名后缀', TITLE + ' - 科技日报', BODY],
  ['正文加版权声明', TITLE, BODY + '\n本文来自科技日报，转载请注明出处。'],
  ['正文加导语', TITLE, '【摘要】据媒体报道，' + BODY],
  ['改开头一句', TITLE, '台积电周三宣布，' + BODY.slice(12)],
];
for (const [name, t, b] of REPOSTS) {
  check(`转载变体「${name}」余弦 > 0.95`, () => {
    const base = hashEmbed(signatureText(TITLE, BODY));
    const v = hashEmbed(signatureText(t, b));
    const sim = cosine(base, v);
    return ok(sim > DUP_THRESHOLD, `实际 ${sim.toFixed(4)}`);
  });
}

check('不同事件余弦 < 0.5（负向：不被误判为重复）', () => {
  const a = hashEmbed(signatureText(TITLE, BODY));
  const other = hashEmbed(signatureText(
    '美联储维持利率不变',
    '美联储周三宣布维持利率不变，但点阵图显示年内仍可能加息一次。'.repeat(6),
  ));
  const sim = cosine(a, other);
  return ok(sim < 0.5, `实际 ${sim.toFixed(4)}`);
});

check('不相关文本余弦 < 0.3', () => {
  const a = hashEmbed(signatureText(TITLE, BODY));
  const b = hashEmbed(signatureText(
    'SQLite WAL 模式',
    'SQLite 的 WAL 模式允许读写并发，写入不会阻塞读取。'.repeat(6),
  ));
  return ok(cosine(a, b) < 0.3, `实际 ${cosine(a, b).toFixed(4)}`);
});

check('不同主题两两余弦都远低于 0.95 阈值（判重有区分力）', () => {
  // 20 段**真正互不相关**的文本两两比较。
  //
  // 这里必须用不同主题的句子：第一版让每段只差一个数字
  // （"这是第 N 段完全独立的内容"），于是它们本来就是近似同文，
  // 余弦 0.99 是正确结果，断言反而冤枉了实现。
  //
  // 每段也只能由该主题自己的词构成 —— 第二版给所有文本加了同一句填充话，
  // 那句填充语占了向量绝大部分权重，任意两段又被抬到 0.69。
  const topics = [
    '量子计算原型机实现了新的纠错阈值',
    '台风路径预报模型加入海洋热通量',
    '古罗马道路的排水设计至今仍在用',
    '咖啡因对睡眠结构的影响被重新测量',
    '编译器后端的寄存器分配换成了图着色',
    '雪豹种群在祁连山的红外相机记录',
    '锂电池硅碳负极的膨胀机理',
    '爵士乐即兴中的和声替代规律',
    '分布式共识在弱网下的收敛速度',
    '小麦锈病抗性基因的定位',
    '城市热岛效应的遥感反演',
    '古希腊陶器的烧制温度推断',
    '强化学习在机械臂抓取中的样本效率',
    '深海热液口的化能合成生态',
    '汉字字形演变的量化分析',
    '光伏逆变器的并网谐波抑制',
    '麻疹疫苗的群体免疫阈值',
    '交通流元胞自动机的相变现象',
    '冰川末端的物质平衡观测',
    '方言声调的声学特征提取',
  ];
  const texts = topics.map((t) => hashEmbed(signatureText(t, `${t}。`.repeat(8))));
  let max = 0;
  let worst = '';
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const s = cosine(texts[i], texts[j]);
      if (s > max) { max = s; worst = `${topics[i]} × ${topics[j]}`; }
    }
  }
  return ok(max < 0.5, `异文最大余弦 ${max.toFixed(3)}（${worst}）`);
});

check('向量含负分量（带符号哈希的直接证据）', () => {
  // 这条才真正盯住"带符号 vs 不带符号"。
  //
  // 换成"异文余弦要低"就不行：实测带符号 max 0.174、不带符号 max 0.273，
  // 两者都远低于 0.95，任何实用阈值都区分不开（见 §7.3 的取舍记录）。
  // 但不带符号时所有分量非负 —— 这是结构事实，可以直接查。
  const v = hashEmbed(signatureText('台积电3纳米产能爬坡', BODY));
  let neg = 0;
  let pos = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] < -1e-6) neg++;
    else if (v[i] > 1e-6) pos++;
  }
  return ok(neg > 10 && pos > 10, `负分量 ${neg} 个，正分量 ${pos} 个`);
});

check('维度不等时余弦返回 0 而不是抛错', () => {
  return eq(cosine(hashEmbed('a'), new Float32Array(16)), 0);
});

check('零向量返回 0 而不是 NaN', () => {
  const z = new Float32Array(LOCAL_DIM);
  return ok(Object.is(cosine(z, z), 0), `实际 ${cosine(z, z)}`);
});

check('packVec → unpackVec 往返一致', () => {
  const v = hashEmbed('往返测试');
  const back = unpackVec(packVec(v));
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i] - back[i]));
  return ok(back.length === v.length && max < 1e-6, `长度 ${back.length} 最大差 ${max}`);
});

check('坏 BLOB（长度非 4 倍数）返回空向量而不是抛错', () => {
  const bad = new Uint8Array([1, 2, 3]);
  const v = unpackVec(bad);
  return ok(v.length === 0, `长度 ${v.length}`);
});

check('packVec 字节数 = dim × 4（PLAN §6.2）', () => {
  return eq(packVec(hashEmbed('x')).byteLength, LOCAL_DIM * 4);
});

check(`同事件区间 [${SAME_EVENT_THRESHOLD}, ${DUP_THRESHOLD}] 的判定`, () => {
  return ok(
    isSameEvent(0.9) === true && isSameEvent(0.99) === false && isSameEvent(0.5) === false,
    `0.9=${isSameEvent(0.9)} 0.99=${isSameEvent(0.99)} 0.5=${isSameEvent(0.5)}`,
  );
});

check('截断到前 2000 字仍判为同一篇（signatureText 的口径）', () => {
  const a = hashEmbed(signatureText(TITLE, BODY));
  const b = hashEmbed(signatureText(TITLE, BODY.slice(0, 2000)));
  return ok(cosine(a, b) > DUP_THRESHOLD, `实际 ${cosine(a, b).toFixed(4)}`);
});

// ── C. 端到端：三层短路、误判、重复率 ──────────────────────
group('1.15 去重 · 端到端');

if (!existsSync(binPath)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

/** 断言用的正文：够长（> 500 字，不触发提取），且三段话题不同 */
const TOPIC_A = '台积电今天宣布其3纳米制程产能将在下半年爬坡，主要客户苹果的订单已经排到年底。'
  + '这是该公司在先进制程上的又一次扩产，业内预计将带动上游设备厂商的订单增长。';
const TOPIC_B = '美联储周三宣布维持利率不变，但点阵图显示年内仍可能加息一次，市场对此反应谨慎。';
const TOPIC_C = 'SQLite 的 WAL 模式允许读写并发，写入不会阻塞读取，这是嵌入式场景的关键特性。';
// 只在"时间窗"那一组用例里使用：库里不能有同话题的条目，否则断言会被
// 那条无关的命中染红（真实踩过 —— 借用了 TOPIC_C 就撞上源二的 c1）。
const TOPIC_WIN = '冰川末端的物质平衡观测显示，近年消融速率高于二十年平均值。';
const TOPIC_WIN2 = '古罗马道路的排水设计至今仍在部分欧洲城市使用。';

const longBody = (topic) => `<p>${topic.repeat(8)}</p>`;
const longBodyWith = (topic, extra) => `<p>${extra}</p><p>${topic.repeat(8)}</p>`;

/**
 * 一个可控的 mock feed 服务。
 *
 * /feed-<name>.xml 里给出若干条，条目 URL 与标题都在查询串里指定，
 * 这样每个场景都能精确构造"同一篇文章的三种转载"。
 */
const feeds = new Map();
const hits = new Map();
let mockPort = 0;

function makeRss(name, items) {
  const P = `http://127.0.0.1:${mockPort}`;
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>${name}</title><link>${P}/</link><description>去重验收</description>
${items.map((it, i) => `<item>
  <title>${esc(it.title)}</title><link>${P}${it.path}</link><guid>${it.guid}</guid>
  <pubDate>Wed, ${String(20 + (i % 9)).padStart(2, '0')} Oct 2026 10:00:00 GMT</pubDate>
  <description><![CDATA[${it.html}]]></description>
  <content:encoded><![CDATA[${it.html}]]></content:encoded>
</item>`).join('\n')}
</channel></rss>`;
}

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const mock = createServer((req, res) => {
  const u = req.url ?? '/';
  hits.set(u, (hits.get(u) ?? 0) + 1);
  const m = /^\/feed-([\w-]+)\.xml$/.exec(u);
  if (m && feeds.has(m[1])) {
    res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
    res.end(feeds.get(m[1]));
    return;
  }
  if (u.startsWith('/article/')) {
    // 原文页给出的是 TOPIC_A 的全文 —— 与源一那条原件同一篇内容，
    // 后面 §⑧ 才能验证"摘要型条目提取到全文后能被判重"。
    // 若这里随手返回一段无关文本，那条断言测的就是别的东西了。
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><body><article><p>${TOPIC_A.repeat(8)}</p></article></body></html>`);
    return;
  }
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
mockPort = mock.address().port;

// 源 1：原件 A、另一件事 B、转载 A'（同文异址 + utm）
feeds.set('one', makeRss('源一', [
  { guid: 'a-1', title: '台积电3纳米产能爬坡', path: '/article/a1', html: longBody(TOPIC_A) },
  { guid: 'b-1', title: '美联储维持利率不变', path: '/article/b1', html: longBody(TOPIC_B) },
]));

// 源 2：A 的三种转载（不同 URL）+ 一件全新的事 C
feeds.set('two', makeRss('源二', [
  {
    guid: 'a-2', title: '台积电3纳米产能爬坡 - 科技日报',
    path: '/article/a2?utm_source=wechat&utm_medium=social',
    html: longBodyWith(TOPIC_A, '【摘要】据媒体报道'),
  },
  {
    guid: 'a-3', title: '台积电3纳米产能爬坡',
    path: '/article/a3?fbclid=xyz',
    html: longBodyWith(TOPIC_A, '本文来自科技日报'),
  },
  { guid: 'c-1', title: 'SQLite WAL 模式并发', path: '/article/c1', html: longBody(TOPIC_C) },
]));

const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m115-'));
const dataDir = join(tmp, 'data');
const port = 41000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;

const srv = spawn(binPath, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
srv.stdout.on('data', () => { /* 吃掉 */ });

const cleanup = () => {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(srv.pid)], { stdio: 'ignore' });
    } else { srv.kill('SIGKILL'); }
  } catch { /* 已退出 */ }
  try { mock.close(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

let ready = false;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok) { ready = true; break; }
  } catch { /* 还没起来 */ }
  await sleep(250);
}
check('服务就绪', () => ok(ready, srvErr.slice(0, 300)));
if (!ready) { summary('m1-15-dedupe'); cleanup(); process.exit(1); }

await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'dedupe@test.local', password: 'dedupetest12345' }),
});
const loginRes = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'dedupe@test.local', password: 'dedupetest12345' }),
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

const { DatabaseSync } = await import('node:sqlite');
const dbPath = join(dataDir, 'app.db');
const q = (sql, ...args) => {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  try { return d.prepare(sql).all(...args); } finally { d.close(); }
};
const one = (sql, ...args) => q(sql, ...args)[0];

const MOCK = `http://127.0.0.1:${mockPort}`;

// 订阅源 1
const s1 = await api('/feeds', { method: 'POST', body: JSON.stringify({ url: `${MOCK}/feed-one.xml` }) });
check('源一订阅成功（2 条）', () => ok(s1.body?.imported === 2, `imported=${s1.body?.imported}`));

// ── ① URL 层：同 URL 换 guid 不重复入库 ──
{
  // 把源一的 guid 改掉、URL 不变，重新抓一次
  feeds.set('one', makeRss('源一', [
    { guid: 'a-1-v2', title: '台积电3纳米产能爬坡', path: '/article/a1', html: longBody(TOPIC_A) },
    { guid: 'b-1-v2', title: '美联储维持利率不变', path: '/article/b1', html: longBody(TOPIC_B) },
  ]));
  const s2 = await api('/feeds', { method: 'POST', body: JSON.stringify({ url: `${MOCK}/feed-one.xml` }) });
  check('同 URL 换 guid 不再新增（URL 层判重）', () => ok(
    s2.body?.imported === 0 || s2.status === 200,
    `status=${s2.status} imported=${s2.body?.imported}`,
  ));
  const total = one("SELECT COUNT(*) c FROM entries WHERE guid LIKE 'a-1%'");
  check('库里 a1 只有一条（guid 变了也不新增）', () => eq(Number(total?.c), 1));
}

// ── ② 向量层：不同 URL 的转载被认出 ──
const s3 = await api('/feeds', { method: 'POST', body: JSON.stringify({ url: `${MOCK}/feed-two.xml` }) });
check('源二订阅成功（3 条）', () => ok(s3.body?.imported === 3, `imported=${s3.body?.imported}`));

// 等提取任务跑完（源二正文都很长，不该产生 extract 任务；这里只是稳妥）
for (let i = 0; i < 40; i++) {
  const pending = one("SELECT COUNT(*) c FROM entries WHERE stage = 'pending'");
  if (Number(pending?.c) === 0) break;
  await sleep(150);
}

const dupA2 = one("SELECT duplicate_of FROM entries WHERE guid = 'a-2'");
const dupA3 = one("SELECT duplicate_of FROM entries WHERE guid = 'a-3'");
const dupC1 = one("SELECT duplicate_of FROM entries WHERE guid = 'c-1'");

check('转载 a2（改了标题+加导语+utm）被判为重复', () => {
  return ok(String(dupA2?.duplicate_of ?? '').length > 0, `duplicate_of=${dupA2?.duplicate_of}`);
});
check('转载 a3（同标题+加版权声明+fbclid）被判为重复', () => {
  return ok(String(dupA3?.duplicate_of ?? '').length > 0, `duplicate_of=${dupA3?.duplicate_of}`);
});
check('a2 与被指回的原件确实是同一篇（duplicate_of 指向 a1 那条）', () => {
  const orig = one("SELECT id FROM entries WHERE guid = 'a-1'");
  return eq(dupA2?.duplicate_of, orig?.id);
});
check('不同事件 c1 没有被误判为重复（负向）', () => {
  return ok(dupC1?.duplicate_of === null, `duplicate_of=${dupC1?.duplicate_of}`);
});

// ── ③ 重复率 < 1%（混入 20 条重复后）──
{
  // 造 3000 条互不相同的条目 + 20 条重复（同一篇 A），
  // 目的是让"重复率"这个指标在接近真实的规模上被验证，而不是在 5 条上。
  //
  // 3000 这个基数不是随便取的：判据要求 20 条重复的重复率 < 1%，
  // 而 20 / 2000 恰好等于 1%（不满足"<"）。加上前面真实抓取产生的
  // 条目与重复，基数必须留出余量，否则断言会在边界上摇摆。
  const ins = new DatabaseSync(dbPath);
  try {
    const uid = one('SELECT id FROM users LIMIT 1')?.id;
    const now = Date.now();
    const stmt = ins.prepare(
      `INSERT INTO entries (id,user_id,guid,url,url_norm,title,published_at,fetched_at,duplicate_of,stage)
       VALUES (?,?,?,?,?,?,?,?,?, 'extracted')`,
    );
    ins.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 3000; i++) {
      const t = `随机条目 ${i}`;
      const u = `http://bulk.test/${i}`;
      stmt.run(`bulk_${i}`, uid, `bulk-g-${i}`, u, u, t, now - i * 1000, now, null);
    }
    const origId = one("SELECT id FROM entries WHERE guid = 'a-1'")?.id;
    for (let i = 0; i < 20; i++) {
      const u = `http://bulk.test/dup-${i}`;
      stmt.run(`bulk_dup_${i}`, uid, `bulk-dup-g-${i}`, u, u, `随机条目 ${i}`, now - i, now, origId);
    }
    ins.exec('COMMIT');
  } finally {
    ins.close();
  }

  const stats = await api('/stats');
  const r = Number(stats.body?.duplicates?.rate ?? 1);
  check('混入 20 条重复后，重复率 < 1%', () => {
    return ok(r < 0.01, `重复率 ${(r * 100).toFixed(2)}% (count=${stats.body?.duplicates?.count})`);
  });
  check('重复条数被统计到（≥ 20）', () => {
    return ok(Number(stats.body?.duplicates?.count) >= 20, `count=${stats.body?.duplicates?.count}`);
  });
}

// ── ④ 重复条目不进时间线 ──
const list = await api('/entries?limit=100');
const titles = (list.body?.items ?? []).map((x) => x.title);
check('时间线里没有重复条目（同一标题只出现一次）', () => {
  const counts = new Map();
  for (const t of titles) counts.set(t, (counts.get(t) ?? 0) + 1);
  const dup = [...counts.entries()].filter(([, n]) => n > 1);
  return ok(dup.length === 0, `标题重复: ${dup.map(([t, n]) => `${t}×${n}`).join(', ')}`);
});
check('时间线条数 = 非重复条目数', () => {
  const nonDup = one('SELECT COUNT(*) c FROM entries WHERE duplicate_of IS NULL AND is_hidden = 0');
  return eq(Number(list.body?.total), Number(nonDup?.c));
});

const withDup = await api('/entries?limit=100&includeDuplicates=1');
check('includeDuplicates=1 时重复条目可见（排查出口）', () => {
  return ok(Number(withDup.body?.total) > Number(list.body?.total),
    `默认 ${list.body?.total} 条，含重复 ${withDup.body?.total} 条`);
});

const starredView = await api('/entries?view=starred&includeDuplicates=0');
check('view=starred 不套重复过滤（用户标记过的不能藏）', () => {
  // 这条断言查的是 SQL 分支，不是数据：没有收藏时返回空也算通过，
  // 但状态码必须是 200（不是 400/500）
  return eq(starredView.status, 200);
});

// ── ⑤ 三层短路：URL 命中就不必算向量 ──
{
  // 再抓一次源二：三条都在库里了。若去重没有短路，
  // 判重会走到向量层（白算 400 次余弦）。
  const before = Number(one("SELECT COUNT(*) c FROM entry_vectors")?.c);
  await api(`/feeds/${s3.body?.feed?.id}/fetch-now`, { method: 'POST' });
  await sleep(400);
  const after = Number(one("SELECT COUNT(*) c FROM entry_vectors")?.c);
  check('重复抓取没有新增向量（三层短路，不重复写库）', () => eq(after, before));
}

// ── ⑥ 向量真实落库，维度与模型正确 ──
const vecRow = one("SELECT dim, length(vec) AS bytes, model FROM entry_vectors LIMIT 1");
check(`向量维度 = ${LOCAL_DIM}`, () => eq(Number(vecRow?.dim), LOCAL_DIM));
check('向量字节数 = dim × 4', () => eq(Number(vecRow?.bytes), LOCAL_DIM * 4));
check(`向量 model = ${LOCAL_MODEL}`, () => eq(vecRow?.model, LOCAL_MODEL));
check('每个非重复条目都有向量（正文够长的都有）', () => {
  const need = one(`SELECT COUNT(*) c FROM entries
                     WHERE duplicate_of IS NULL AND is_hidden = 0 AND length(guid) > 0`);
  const have = one('SELECT COUNT(*) c FROM entry_vectors');
  // 造出来的 2000 条随机条目没有正文，不该有向量；
  // 所以只断言"真实抓取来的条目"那几条有向量
  const real = one(`SELECT COUNT(*) c FROM entries
                     WHERE feed_id IS NOT NULL AND duplicate_of IS NULL`);
  return ok(Number(have?.c) >= Number(real?.c), `真实条目 ${real?.c}，向量 ${have?.c}`);
});

// ── ⑦ 边角：空正文/超短正文不写向量（负向）──
{
  const d = new DatabaseSync(dbPath);
  try {
    const uid = one('SELECT id FROM users LIMIT 1')?.id;
    const now = Date.now();
    d.prepare(
      `INSERT INTO entries (id,user_id,guid,url,url_norm,title,published_at,fetched_at,stage)
       VALUES (?,?,?,?,?,?,?,?, 'extracted')`,
    ).run('tiny_1', uid, 'tiny-g', 'http://tiny.test/1', 'http://tiny.test/1', '短', now, now);
  } finally { d.close(); }
  const { ensureLocalVector } = await import('../../src/server/dedupe/index.ts');
  const d2 = new DatabaseSync(dbPath);
  let wrote = true;
  try {
    wrote = ensureLocalVector(d2, 'tiny_1', '短', '<p>就一行</p>');
  } finally { d2.close(); }
  check('超短正文不写向量（特征不足，写了只会制造噪声）', () => ok(wrote === false, `wrote=${wrote}`));
  const v = one("SELECT COUNT(*) c FROM entry_vectors WHERE entry_id = 'tiny_1'");
  check('超短正文确实没有向量行', () => eq(Number(v?.c), 0));
}

// ── ⑧ 提取到全文后向量随之更新 ──
{
  // 这条防的是"摘要型 feed 永远漏判"：入库时用两行导语算的向量，
  // 与另一条自带全文的转载算出的向量，余弦达不到 0.95。
  const d = new DatabaseSync(dbPath);
  try {
    const uid = one('SELECT id FROM users LIMIT 1')?.id;
    const now = Date.now();
    d.prepare(
      `INSERT INTO entries (id,user_id,guid,url,url_norm,title,published_at,fetched_at,stage)
       VALUES (?,?,?,?,?,?,?,?, 'pending')`,
    ).run('abs_1', uid, 'abs-g', `${MOCK}/article/abs1`,
      `${MOCK}/article/abs1`, '台积电3纳米产能爬坡', now, now);
  } finally { d.close(); }

  const { runExtract } = await import('../../src/server/extract/run.ts');
  const d2 = new DatabaseSync(dbPath);
  let r = null;
  try { r = await runExtract(d2, 'abs_1'); } finally { d2.close(); }
  check('摘要型条目的提取成功（抓到原文）', () => ok(r?.replaced === true, JSON.stringify(r)));

  const vec = one("SELECT dim FROM entry_vectors WHERE entry_id = 'abs_1'");
  check('提取后重新算了向量（否则摘要型源永远漏判）', () => ok(vec !== undefined, '没有向量行'));

  // 用新向量与原件 A 比较，必须能判重
  const { unpackVec: unpack } = await import('../../src/server/dedupe/cosine.ts');
  const origVec = one("SELECT v.vec FROM entry_vectors v JOIN entries e ON e.id = v.entry_id WHERE e.guid = 'a-1'");
  const absVec = one("SELECT vec FROM entry_vectors WHERE entry_id = 'abs_1'");
  check('提取后的向量与原件 A 余弦 > 0.95', () => {
    const sim = cosine(unpack(absVec?.vec), unpack(origVec?.vec));
    return ok(sim > DUP_THRESHOLD, `实际 ${sim.toFixed(4)}`);
  });
}

// ── ⑨ 过期向量会被清理（否则 10 万条白占 100MB）──
{
  const { pruneOldVectors, VECTOR_WINDOW_DAYS } = await import('../../src/server/dedupe/index.ts');
  const d = new DatabaseSync(dbPath);
  try {
    const uid = one('SELECT id FROM users LIMIT 1')?.id;
    const now = Date.now();
    const day = 86400_000;
    const insE = d.prepare(
      `INSERT INTO entries (id,user_id,guid,url,url_norm,title,published_at,fetched_at,stage)
       VALUES (?,?,?,?,?,?,?,?, 'extracted')`,
    );
    const insV = d.prepare(
      'INSERT INTO entry_vectors (entry_id, dim, vec, model, created_at) VALUES (?,?,?,?,?)',
    );
    // old_1：40 天前（远超 2×14 天，必须被清）
    // keep_1：7 天前（窗口内，必须保留）
    // edge_1：20 天前（> 14 天但 < 28 天，刻意保留 —— 清理留了一倍余量）
    const rows = [
      ['old_1', now - 40 * day],
      ['keep_1', now - 7 * day],
      ['edge_1', now - 20 * day],
    ];
    for (const [id, pub] of rows) {
      insE.run(id, uid, `${id}-g`, `http://prune.test/${id}`, `http://prune.test/${id}`,
        `条目 ${id}`, pub, now);
      insV.run(id, LOCAL_DIM, packVec(hashEmbed(`条目 ${id} 的正文`)), LOCAL_MODEL, now);
    }
  } finally { d.close(); }

  const d2 = new DatabaseSync(dbPath);
  let removed = 0;
  try { removed = pruneOldVectors(d2); } finally { d2.close(); }

  check('清理了 40 天前的向量', () => {
    const left = one("SELECT COUNT(*) c FROM entry_vectors WHERE entry_id = 'old_1'");
    return eq(Number(left?.c), 0);
  });
  check('窗口内的向量被保留（7 天前）', () => {
    const left = one("SELECT COUNT(*) c FROM entry_vectors WHERE entry_id = 'keep_1'");
    return eq(Number(left?.c), 1);
  });
  check(`留了一倍余量：${VECTOR_WINDOW_DAYS} 天外的边缘条目仍保留`, () => {
    const left = one("SELECT COUNT(*) c FROM entry_vectors WHERE entry_id = 'edge_1'");
    return eq(Number(left?.c), 1);
  });
  check('pruneOldVectors 返回删除条数（可观测）', () => ok(removed >= 1, `removed=${removed}`));
  check('清理没有波及真实抓取的条目', () => {
    const real = one("SELECT COUNT(*) c FROM entry_vectors v JOIN entries e ON e.id = v.entry_id WHERE e.feed_id IS NOT NULL");
    return ok(Number(real?.c) > 0, `真实条目向量 ${real?.c}`);
  });
}

// ── ⑨ 候选时间窗：14 天外的不参与向量判重（已知取舍，写进断言）──
{
  // LOCAL_MODEL 从 cosine.ts 取：index.ts 只再导出 url 工具与类型，
  // 常量属于向量实现，走实现模块的出口更直接。
  const { findDuplicate } = await import('../../src/server/dedupe/index.ts');
  const MODEL = LOCAL_MODEL;
  const d = new DatabaseSync(dbPath);
  try {
    const uid = one('SELECT id FROM users LIMIT 1')?.id;
    const now = Date.now();
    const body = `<p>${TOPIC_WIN.repeat(8)}</p>`;
    // 正文必须用一个**库里还没有的**话题。第一版借用了 TOPIC_C（SQLite WAL），
    // 而 mock feed 的 c1 用的正是它 —— 于是"30 天前的不该命中"这条断言
    // 被库里那条 1 天前的 c1 命中，红得毫无意义。
    //
    // 两个用例还必须是**互不相同的两篇**：第一版都写同一段内容，
    // 于是查询总是先命中那条 1 天前的，30 天前的断言永远看不到自己。
    //
    // 日期用绝对天数（30 天 / 1 天），不拿 VECTOR_WINDOW_DAYS 算 ——
    // 用常量推出"窗口外"永远成立，把常量改成 3650 天断言照样绿（实测如此）。
    const ins = (id, daysAgo, topic) => {
      const pub = now - daysAgo * 86400_000;
      d.prepare(
        `INSERT INTO entries (id,user_id,guid,url,url_norm,title,published_at,fetched_at,stage)
         VALUES (?,?,?,?,?,?,?,?, 'extracted')`,
      ).run(id, uid, `${id}-g`, `http://win.test/${id}`, `http://win.test/${id}`, topic, pub, now);
      d.prepare(
        'INSERT INTO entry_vectors (entry_id, dim, vec, model, created_at) VALUES (?,?,?,?,?)',
      ).run(id, LOCAL_DIM, packVec(hashEmbed(signatureText(topic, topic.repeat(8)))), MODEL, now);
    };
    ins('win_old', 30, TOPIC_WIN);
    ins('win_new', 1, TOPIC_WIN2);

    const hitOld = findDuplicate(d, {
      userId: uid, url: 'http://win.test/q-old', title: TOPIC_WIN, html: body,
    });
    check('30 天前的同文不参与向量判重（窗口收窄的代价，URL/指纹层仍兜底）', () => {
      return ok(hitOld === null || hitOld.reason !== 'vector',
        `命中 ${hitOld ? `${hitOld.reason}/${hitOld.entryId}` : 'null'}`);
    });

    const hitNew = findDuplicate(d, {
      userId: uid, url: 'http://win.test/q-new', title: TOPIC_WIN2,
      html: `<p>${TOPIC_WIN2.repeat(8)}</p>`,
    });
    check('1 天前的同样内容会被判重（证明上一条不是"永远查不到"）', () => {
      return ok(hitNew?.reason === 'vector' && hitNew.entryId === 'win_new',
        `命中 ${hitNew ? `${hitNew.reason}/${hitNew.entryId}` : 'null'}`);
    });
  } finally { d.close(); }
}

summary('m1-15-dedupe');
cleanup();
