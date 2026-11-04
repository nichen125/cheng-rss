#!/usr/bin/env node
// 2.6 API key 可在界面填写 + 全局失败不刷屏 + 孤儿分析回填 —— 验收
//
// 判据（PLAN §19.4 2.6 / §8.8 / §5.7 P1 P2）：
//   ① PATCH /settings/ai/key 后 hasKey=true、keySource='file'
//   ② **响应里不出现完整 key**（只有掩码）—— 全库与全响应体都搜不到
//   ③ secrets.json 权限收紧（POSIX 600 / Windows 仅当前用户）
//   ④ **不进 app.db**：直接扫库文件字节
//   ⑤ {apiKey:''} 删除文件 → 回落环境变量，keySource 变 env/none
//   ⑥ 文件优先于环境变量
//   ⑦ POST /settings/ai/test 通/401 两种，401 返回 kind='http-401'
//   ⑧ 没 key 时 100 条 analyze 只产出 ≤2 行同类日志，且条目**不落 failed**
//   ⑨ 孤儿 analyze 回填：无分析的条目会被重新入队，已有分析的不会
//   ⑩ 填上 key 之后那批任务自己开始跑（不需要手动触发）
//
// ②④ 是这一节最容易写成空断言的两处：
//   "GET 返回了掩码" 不足以证明没泄露 —— 一个既返回掩码又附带完整 key
//   的实现照样通过。所以这里扫**整个响应体字符串**，并且直接读
//   app.db 的字节。③同理：只断言"文件存在"不说权限，等于什么都没验。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, gt, lt, summary } from './harness.mjs';
import { killTree, onExit } from '../lib/proc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(root, 'dist', process.platform === 'win32'
  ? `cheng-rss-${process.platform}-${process.arch}.exe`
  : `cheng-rss-${process.platform}-${process.arch}`);

group('2.6 API key 可在界面填写');

if (!existsSync(BIN)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock 上游 ────────────────────────────────────────────────
// 两种模式：normal（200）与 badkey（401，验证 test 端点的 kind 透出）
const ai = { calls: 0, mode: 'normal', log: [] };
const chatBody = (content) => ({
  id: 'x', object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
});

const aiSrv = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += String(d); });
  req.on('end', () => {
    if (req.url === '/_ctl') {
      const c = JSON.parse(raw || '{}');
      ai.calls = 0; ai.log = []; ai.mode = c.mode ?? 'normal';
      res.writeHead(200); return res.end('{}');
    }
    if (req.url === '/_state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ calls: ai.calls, log: ai.log }));
    }
    if (!String(req.url).endsWith('/chat/completions')) { res.writeHead(404); return res.end('no'); }

    ai.calls++;
    const auth = String(req.headers.authorization ?? '');
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    ai.log.push({ auth, model: body.model, maxTokens: body.max_tokens, len: String(body.messages?.[0]?.content ?? '').length });

    if (ai.mode === 'badkey') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    }

    // 按 system 首句分流：探针要纯文本，分析要 JSON。
    // 不分流的话"填上 key 之后分析真的开始了"这条永远红 —— 而红的是
    // mock 给了一个分析器解析不了的东西，不是实现。
    const sys = String(body.messages?.[0]?.content ?? '');
    if (/连通性探针/.test(sys)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(chatBody('OK')));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(chatBody(JSON.stringify({
      summary: '长江存储发布 232 层 QLC 闪存，单颗容量 1Tb，面向企业级市场。',
      key_points: ['232 层堆叠', '单颗 1Tb 容量'],
      category: 'industry',
      topics: ['存储', '闪存'],
      entities: { people: [], orgs: [], products: [], tech: [] },
      importance: 78, novelty: 66, sentiment: 'neutral',
    }))));
  });
});
await new Promise((r) => aiSrv.listen(0, '127.0.0.1', r));
const AI_PORT = aiSrv.address().port;
const aiCtl = (b = {}) => fetch(`http://127.0.0.1:${AI_PORT}/_ctl`, { method: 'POST', body: JSON.stringify(b) });
const aiState = async () => (await fetch(`http://127.0.0.1:${AI_PORT}/_state`)).json();

// ── 起服务（**先不设环境变量 key**，验证"完全没有 key"那条路径）──
const dir = mkdtempSync(join(tmpdir(), 'cheng-rss-m206-'));
const dataDir = join(dir, 'data');
const port = 47400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const API = `${base}/api/v1`;

const env = {
  ...process.env,
  AI_BASE_URL: `http://127.0.0.1:${AI_PORT}/v1`,
};
delete env.AI_API_KEY;

const proc = spawn(BIN, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'], env,
});
let stderrBuf = '';
proc.stderr.on('data', (d) => { stderrBuf += String(d); });
proc.stdout.on('data', () => { /* drain */ });

const cleanup = () => {
  killTree(proc.pid);
  try { aiSrv.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
};
onExit(cleanup);

let up = false;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) { up = true; break; } } catch { /* not yet */ }
  await sleep(250);
}
check('服务就绪', () => ok(up, stderrBuf.slice(0, 300)));
if (!up) { cleanup(); summary('m2-06-api-key'); process.exit(1); }

// 账号
await fetch(`${API}/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'k@test.local', password: 'keytest12345678' }),
});
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'k@test.local', password: 'keytest12345678' }),
});
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; ');
check('登录拿到 cookie', () => ok(cookie.includes('='), cookie));

/** 返回原始文本 + 解析体。② 要扫原始文本，所以不能只返 JSON */
const raw = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, text, data };
};
const j = async (method, path, body) => {
  const r = await raw(method, path, body);
  return { status: r.status, data: r.data };
};

const KEY = 'sk-m206-abcdefghijklmnop-9f8e7d';

// ── ① 起手：完全没有 key ───────────────────────────────────
{
  const r = await j('GET', '/settings/ai');
  check('① 初始 hasKey=false、keySource=none', () => {
    return ok(r.data?.hasKey === false && r.data?.keySource === 'none',
      JSON.stringify({ hasKey: r.data?.hasKey, keySource: r.data?.keySource }));
  });
  check('① 初始 keyMasked 为 null（不是空串——两者语义不同）', () => eq(r.data?.keyMasked, null));
}

// ── ② 写入 key ─────────────────────────────────────────────
{
  const w = await j('PATCH', '/settings/ai/key', { apiKey: KEY });
  check('② PATCH /settings/ai/key 返回 ok 且 hasKey=true', () => {
    return ok(w.status === 200 && w.data?.ok === true && w.data?.hasKey === true,
      `status=${w.status} body=${JSON.stringify(w.data)}`);
  });

  const f = await raw('GET', '/settings/ai');
  check('② 之后 hasKey=true、keySource=file', () => {
    return ok(f.data?.hasKey === true && f.data?.keySource === 'file',
      JSON.stringify({ hasKey: f.data?.hasKey, keySource: f.data?.keySource }));
  });
  check('② keyMasked 是掩码（前 3 + 后 4，中间省略号）', () => {
    const m = f.data?.keyMasked ?? '';
    return ok(m.startsWith(KEY.slice(0, 3)) && m.endsWith(KEY.slice(-4))
      && !m.includes(KEY.slice(3, -4)) && m.includes('…'), m);
  });
  // 这一条是 ② 的核心：整个响应文本里不允许出现完整 key。
  check('② **整个 GET 响应体里不含完整 key**（含掩码但不含明文）', () => {
    return ok(!f.text.includes(KEY), `响应里出现了完整 key：${f.text.slice(0, 200)}`);
  });
}

// ── ③ secrets.json 存在、权限收紧、不进库 ──────────────────
{
  const sf = join(dataDir, 'secrets.json');
  check('③ secrets.json 已创建', () => ok(existsSync(sf), sf));

  check('③ secrets.json 里有 key（且是唯一副本）', () => {
    const txt = readFileSync(sf, 'utf8');
    return ok(txt.includes(KEY), txt.slice(0, 200));
  });

  // Windows 上 chmod 是空操作（实测 mode 恒 666），所以判据分开写：
  //   POSIX  → stat.mode & 0o777 === 0o600
  //   Windows → icacls 输出里没有继承的 ACE，只有当前用户
  check('③ 权限收紧到仅当前用户', () => {
    if (process.platform !== 'win32') {
      const mode = statSync(sf).mode & 0o777;
      return ok(mode === 0o600, `mode=${mode.toString(8)}`);
    }
    const user = process.env.USERNAME || '';
    let out = '';
    try {
      out = execFileSync('icacls', [sf], { encoding: 'utf8', windowsHide: true });
    } catch (e) {
      return ok(false, String(e.message));
    }
    // 去掉继承后不应再出现 (I) 标记的条目
    const hasInherited = /\(I\)/.test(out);
    return ok(!hasInherited && out.includes(user), out.replace(/\s+/g, ' ').slice(0, 300));
  });

  // ④ 最直接的一条：扫 app.db 的字节。key 若被写进 settings.ai_config，
  //    这一条会立刻红 —— 而只查 settings 表实现的版本也能被抓到（同一个文件）。
  check('③ **key 不在 app.db 里**（扫库文件字节）', () => {
    const db = join(dataDir, 'app.db');
    if (!existsSync(db)) return ok(false, 'app.db 不存在');
    const buf = readFileSync(db);
    return ok(!buf.includes(Buffer.from(KEY, 'utf8')),
      `app.db 里出现了 key（${buf.length} 字节里搜到）`);
  });
  // WAL 里同样不能有：SQLite 先写 WAL 再 checkpoint，
  // 只看主库文件会把"刚写进去还没合并"的实现放过。
  check('③ key 也不在 app.db-wal / -shm 里', () => {
    for (const suffix of ['-wal', '-shm']) {
      const p = join(dataDir, `app.db${suffix}`);
      if (!existsSync(p)) continue;
      const buf = readFileSync(p);
      if (buf.includes(Buffer.from(KEY, 'utf8'))) return ok(false, `${suffix} 里出现了 key`);
    }
    return true;
  });
}

// ── ⑦ test 端点：先验 401，再验通 ──────────────────────────
{
  await aiCtl({ mode: 'badkey' });
  const bad = await j('POST', '/settings/ai/test', {});
  check('⑦ key 无效时 test 返回 ok:false 且 kind=http-401', () => {
    return ok(bad.data?.ok === false && bad.data?.failure?.kind === 'http-401',
      JSON.stringify(bad.data));
  });
  check('⑦ 401 时给出「key 无效」的 hint（不是原始报文）', () => {
    const h = bad.data?.hint ?? '';
    return ok(/无效|权限/.test(h), h);
  });

  await aiCtl({ mode: 'normal' });
  const good = await j('POST', '/settings/ai/test', {});
  check('⑦ key 有效时 test 返回 ok:true 并带模型名', () => {
    return ok(good.data?.ok === true && typeof good.data?.model === 'string',
      JSON.stringify(good.data));
  });
  const st = await aiState();
  // 这条断言原来是「探针请求确实带了 max_tokens=1（探针不是跑推理）」。
  //
  // **那个要求本身是错的**（v2.4 / PLAN §8.6b）：对推理模型，1 个 token
  // 连思考的开口都不够，`content` 会是空串、`finish_reason='length'`，
  // 于是「测试连接」永远显示"模型返回空" —— 那正是用户报的 bug。
  //
  // 改成"够推理模型思考的下界"。32 是实测的分界：16 仍被思考吃光，
  // 64 能稳定拿到正文。这里要求 ≥32 而不是钉死 64，是为了让实现能调整
  // （比如将来改成先探测模型是否推理型再决定），而不会因为数字变了就红。
  // 不取 log 的最后一条：全量并行时 mock 上可能混进别的请求，
  // 取最后一条会偶发读到别的记录（实测全量跑时出现 34/35）。
  // 改成在本次测试窗口内的记录里找**最近一次 maxTokens ≥32** 的那条，
  // 它只可能是探针自己发的。
  check('⑦ 探针请求带了足够推理模型思考的 max_tokens（≥32，不再是 1）', () => {
    const log = Array.isArray(st.log) ? st.log : [];
    const probes = log.filter((x) => typeof x.maxTokens === 'number' && x.maxTokens >= 32);
    return ok(probes.length > 0,
      `log 里没有 >=32 的请求；最近 3 条 = ${JSON.stringify(log.slice(-3))}`);
  });
}

// ── ① 删除 key → 回落 ─────────────────────────────────────
{
  const d = await j('PATCH', '/settings/ai/key', { apiKey: '' });
  check('① 传空串删除成功，hasKey=false', () => {
    return ok(d.status === 200 && d.data?.hasKey === false, JSON.stringify(d.data));
  });
  check('① 删除之后 secrets.json 被移除（不是留一个空文件）', () => {
    return ok(!existsSync(join(dataDir, 'secrets.json')), '文件仍在');
  });
  const f = await j('GET', '/settings/ai');
  check('① 删除后 keySource 回到 none', () => eq(f.data?.keySource, 'none'));

  // 明显不合法的输入要被挡住，且错误消息说得出规则
  const bad = await j('PATCH', '/settings/ai/key', { apiKey: 'ab' });
  check('① 过短的 key 被 400 拒绝', () => ok(bad.status === 400, `status=${bad.status}`));
  const bad2 = await j('PATCH', '/settings/ai/key', { apiKey: 'sk-has space-12345678' });
  check('① 含空白的 key 被 400 拒绝', () => ok(bad2.status === 400, `status=${bad2.status}`));

  // /settings/ai 仍然拒绝 apiKey，并指名该用哪个端点
  const wrong = await j('PATCH', '/settings/ai', { apiKey: KEY });
  check('① PATCH /settings/ai 收到 apiKey 时 400 并指向 /settings/ai/key', () => {
    const msg = wrong.data?.error?.message ?? wrong.data?.message ?? wrong.text ?? '';
    return ok(wrong.status === 400 && String(msg).includes('/settings/ai/key'),
      `status=${wrong.status} msg=${String(msg).slice(0, 160)}`);
  });
}

// ── ⑥ 文件优先于环境变量（用第二个进程验，因为 env 不能改运行中的进程）──
{
  // 先写文件
  await j('PATCH', '/settings/ai/key', { apiKey: KEY });

  const port2 = port + 137;
  const base2 = `http://127.0.0.1:${port2}`;
  const env2 = {
    ...process.env,
    AI_BASE_URL: `http://127.0.0.1:${AI_PORT}/v1`,
    AI_API_KEY: 'sk-from-env-should-lose-0000',
  };
  // 同一个 data 目录：里面有 secrets.json
  const proc2 = spawn(BIN, ['serve', '--data', dataDir, '--port', String(port2)], {
    stdio: ['ignore', 'pipe', 'pipe'], env: env2,
  });
  proc2.stdout.on('data', () => { /* drain */ });
  proc2.stderr.on('data', () => { /* drain */ });
  const cleanup2 = () => killTree(proc2.pid);
  onExit(cleanup2);

  let up2 = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base2}/api/health`)).ok) { up2 = true; break; } } catch { /* not yet */ }
    await sleep(250);
  }
  check('⑥ 第二个进程（同时有文件与环境变量）就绪', () => ok(up2));

  const f = await j2('GET', '/settings/ai');
  check('⑥ **文件优先**：keySource=file，不是 env', () => {
    return ok(f.data?.keySource === 'file', JSON.stringify({ keySource: f.data?.keySource }));
  });
  check('⑥ 掩码是文件里那个 key 的，不是环境变量的', () => {
    const m = f.data?.keyMasked ?? '';
    return ok(m.endsWith(KEY.slice(-4)), `masked=${m}`);
  });
  async function j2(method, path, body) {
    const r = await fetch(`${base2}/api/v1${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }
  cleanup2();
  await sleep(300);
}

// ── ⑧⑨⑩ 日志抑制 + 孤儿回填 + 填 key 之后自己开跑 ─────────
//
// 这一段单独起第三个进程，因为：
//   · ⑧ 要数 stderr 行数，必须从干净的 buffer 起
//   · ⑨⑩ 要在**没有 key** 的情况下先积压，再填 key 看它自己动起来
// 用同一份 dataDir（里面现在有 key），所以先删掉 secrets.json 制造"没 key"。
{
  try { rmSync(join(dataDir, 'secrets.json'), { force: true }); } catch { /* ignore */ }
  stderrBuf = '';
  await aiCtl({ mode: 'normal' });

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dataDir, 'app.db'));
  // 服务端在同一个库上写（WAL）。裸 DatabaseSync 没有 busy_timeout，
  // 撞上服务端正在提交时会立刻 SQLITE_BUSY —— 而这不是实现的问题。
  db.exec('PRAGMA busy_timeout = 8000;');
  const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id;

  // 造 100 条 extracted 条目（**必须带正文**，否则走的是"空正文"那条分支：
  // 那条分支会 markFailed（内容确实有问题），于是 ⑧ 的"不落 failed"
  // 与 ⑧ 的日志抑制都会被它带偏 —— 第一版就没插 entry_contents，
  // 结果 50 行日志 + 100 条 failed，看起来像抑制没生效，其实是测试没造对。）
  const { packText } = await import('../../src/server/db/text-blob.ts');
  const bodyHtml = packText(
    '<p>' + '长江存储发布了 232 层 QLC 闪存，单颗容量 1Tb，面向企业级市场。'.repeat(20) + '</p>',
  );
  const now = Date.now();
  const insE = db.prepare(`INSERT INTO entries (id,user_id,feed_id,guid,url,url_norm,
    title,excerpt,published_at,fetched_at,is_read,is_starred,read_count,is_hidden,site_name,stage)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,?, 'extracted')`);
  const insC = db.prepare(
    'INSERT INTO entry_contents (entry_id, html, markdown, raw_html, extracted_by) VALUES (?,?,NULL,NULL,?)',
  );
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 100; i++) {
    insE.run(`k_e${i}`, uid, null, `k_g${i}`, `https://k.example.com/${i}`, `k/${i}`,
      `第 ${i} 篇文章`, '导语', now - i * 1000, now, `k${i}.example.com`);
    insC.run(`k_e${i}`, bodyHtml, 'feed');
  }
  db.exec('COMMIT');
  db.close();

  const port3 = port + 211;
  const base3 = `http://127.0.0.1:${port3}`;
  const env3 = { ...process.env, AI_BASE_URL: `http://127.0.0.1:${AI_PORT}/v1` };
  delete env3.AI_API_KEY;

  const proc3 = spawn(BIN, ['serve', '--data', dataDir, '--port', String(port3)], {
    stdio: ['ignore', 'pipe', 'pipe'], env: env3,
  });
  let err3 = '';
  proc3.stderr.on('data', (d) => { err3 += String(d); });
  proc3.stdout.on('data', () => { /* drain */ });
  onExit(() => killTree(proc3.pid));

  let up3 = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base3}/api/health`)).ok) { up3 = true; break; } } catch { /* not yet */ }
    await sleep(250);
  }
  check('⑧ 第三个进程（无 key + 100 条待分析）就绪', () => ok(up3, err3.slice(0, 300)));

  // 手动触发回填：等定时器要 45 秒，这里通过"入队 + 观察日志"验，
  // 时长压到可接受。入队走 /entries/:id/analyze 的批量替代 —— 直接调
  // 内部的 backfill 不是 HTTP 面，所以这里用一个小脚本进程调它。
  // 但 handler 只有在队列里有任务时才会跑，所以先让 backfill 排上：
  const { DatabaseSync: DS } = await import('node:sqlite');
  const db2 = new DS(join(dataDir, 'app.db'));
  db2.exec('PRAGMA busy_timeout = 8000;');
  const {
    enqueueOrphanAnalyze, countOrphanAnalyze,
  } = await import('../../src/server/ai/backfill.ts');
  const n0 = countOrphanAnalyze(db2);
  check('⑨ 判据认得出这 100 条孤儿', () => ok(n0 >= 100, `countOrphanAnalyze=${n0}`));

  // 两次调用必须在**同一个同步块**里：中间只要让出事件循环，
  // 队列里那几十个任务就可能被 runner 消费掉几条（变成 done 但无分析行，
  // 于是又是孤儿）—— 那时 second>0 是正确行为，不是幂等失效。
  // 第一版把两次调用分在 await 两侧，second=2 就红了，红的是测法。
  const { first, second } = (() => {
    const a = enqueueOrphanAnalyze(db2, 100);
    const b = enqueueOrphanAnalyze(db2, 100);
    return { first: a, second: b };
  })();
  check('⑨ 回填把孤儿排进队列（幂等：同一时刻再调不再加）', () => {
    return ok(first >= 100 && second === 0, `first=${first} second=${second}`);
  });

  // 等它们被处理完（no-key 是 terminal，不重试，所以很快）
  for (let i = 0; i < 120; i++) {
    const row = db2.prepare(
      "SELECT COUNT(*) c FROM jobs WHERE kind='analyze' AND status IN ('pending','running')",
    ).get();
    if (Number(row.c) === 0) break;
    await sleep(250);
  }
  await sleep(600); // 收尾日志落地

  const analyzeFailLines = err3.split('\n').filter((l) => l.includes('analyze 失败')).length;
  check('⑧ **100 条 no-key 只产出 ≤2 行 analyze 失败日志**（不是 100 行）', () => {
    return ok(analyzeFailLines <= 2, `实际 ${analyzeFailLines} 行`);
  });

  const failedRows = db2.prepare(
    "SELECT COUNT(*) c FROM entries WHERE id LIKE 'k_e%' AND stage = 'failed'",
  ).get();
  check('⑧ 没 key 时条目**不落 failed**（全局配置问题不是这篇文章的问题）', () => {
    return eq(Number(failedRows.c), 0);
  });

  const analyzedRows = db2.prepare(
    "SELECT COUNT(*) c FROM entry_analysis WHERE entry_id LIKE 'k_e%'",
  ).get();
  check('⑧ 没 key 时确实一条分析都没产出（证明上面那条不是"本来就成功"）', () => {
    return eq(Number(analyzedRows.c), 0);
  });

  // ⑩ 现在填 key，回填应该让它们自己开始跑
  db2.close();
  const setRes = await fetch(`${base3}/api/v1/settings/ai/key`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: KEY }),
  });
  check('⑩ 在界面上填 key 成功', () => ok(setRes.ok));

  // 填完 key 需要有人重新排队。这正是不变式：不填 key 时那些任务已经 done，
  // 所以必须有回填把"没有分析行"的条目重新认领。
  const db3 = new DS(join(dataDir, 'app.db'));
  db3.exec('PRAGMA busy_timeout = 8000;');
  const requeued = enqueueOrphanAnalyze(db3, 100);
  check('⑩ 填 key 后回填能重新认领那 100 条（>0 即证明"没有东西锁死它们"）', () => {
    return ok(requeued >= 100, `requeued=${requeued}`);
  });

  await aiCtl({ mode: 'normal' });
  for (let i = 0; i < 160; i++) {
    const row = db3.prepare(
      "SELECT COUNT(*) c FROM entry_analysis WHERE entry_id LIKE 'k_e%'",
    ).get();
    if (Number(row.c) >= 5) break;
    await sleep(250);
  }
  const doneRows = db3.prepare(
    "SELECT COUNT(*) c FROM entry_analysis WHERE entry_id LIKE 'k_e%'",
  ).get();
  const jobDiag = db3.prepare(
    "SELECT status, COUNT(*) c FROM jobs WHERE kind='analyze' AND dedupe_key LIKE 'analyze:k_e%' GROUP BY status",
  ).all();
  const lastNameErr = db3.prepare(
    "SELECT last_error FROM jobs WHERE kind='analyze' AND dedupe_key LIKE 'analyze:k_e%' AND last_error IS NOT NULL LIMIT 2",
  ).all();
  check('⑩ **填上 key 之后分析真的开始产出了**（≥5 篇有分析行）', () => {
    return ok(Number(doneRows.c) > 4,
      `产出 ${doneRows.c} 行；jobs=${JSON.stringify(jobDiag)}；`
      + `错误=${JSON.stringify(lastNameErr)}；`
      + `stderr 尾部=${err3.slice(-500)}`);
  });
  db3.close();

  killTree(proc3.pid);
  await sleep(400);
}

cleanup();
await sleep(300);
summary('m2-06-api-key');
