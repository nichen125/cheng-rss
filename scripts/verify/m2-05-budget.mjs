#!/usr/bin/env node
// 2.5 成本审计 + 预算闸门 —— 验收
//
// 判据（PLAN §19.4 2.5 + §8.5）：
//   ① 每次调用都有 ai_usage 记录（含失败的那次）
//   ② 设 dailyUsd=0.001 超限后降 fast_only（仍发请求，但换成快模型）
//   ③ 再超（月门）则停止，且 UI 可见
//   ④ 日门按**本地日历日**算，不是 UTC、不是滚动 24 小时
//   ⑤ monthlyUsd=0 表示不限额（不是"立刻停止"）
//   ⑥ 闸门在第一个请求之前生效：block 时一个 HTTP 请求都不发
//   ⑦ embedding 在 fast_only 下不降级（没有更便宜的同族模型），但 stop 时也停
//
// ② 的验法：只断言"调用被拦了"是错的 —— 日门的语义是**降级而非停止**。
// 必须断言：1) 请求照发 2) 请求里的 model 变成了 models.fast 3) 返回 ok。
// 一个把日门实现成"直接停"的版本会让 ③ 通过而 ② 失败，反之亦然。
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, gt, summary } from './harness.mjs';
import { z } from 'zod';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const {
  AiClient, DEFAULT_AI_CONFIG,
} = await import('../../src/server/ai/client.ts');
const {
  budgetState, budgetGuard,
} = await import('../../src/server/ai/budget.ts');
const { recordUsage, usageSince, startOfLocalDay, startOfLocalMonth } = await import(
  '../../src/server/ai/usage.ts');
const { openDb } = await import('../../src/server/db/client.ts');
const { migrate } = await import('../../src/server/db/migrate.ts');

// ── mock 上游 ────────────────────────────────────────────────
const seen = [];
const srv = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += String(d); });
  req.on('end', () => {
    if (req.url === '/_reset') { seen.length = 0; res.writeHead(200); return res.end('{}'); }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    seen.push({ url: req.url, model: body.model });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (String(req.url).endsWith('/embeddings')) {
      return res.end(JSON.stringify({
        data: [{ embedding: Array.from({ length: 8 }, (_, i) => (i + 1) / 8) }],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }));
    }
    res.end(JSON.stringify({
      choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}/v1`;
const reset = () => fetch(`http://127.0.0.1:${srv.address().port}/_reset`);

const cleanup = () => { try { srv.close(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const TOY = z.object({ a: z.number() });
const OPTS = {
  schema: TOY, system: 's', user: 'u', model: 'strong-model', purpose: 'analyze', userId: 'u_b',
};

const tmp = mkdtempSync(join(tmpdir(), 'ai-rss-m205-'));
const h = openDb({ dataDir: tmp });
migrate(h.db);
const DB = h.db;
const UID = 'u_b';
DB.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
  .run(UID, 'b@t.local', 'B', 'owner', Date.now());

const cfg = (over = {}) => ({
  ...DEFAULT_AI_CONFIG,
  baseURL: BASE,
  apiKeyEnv: 'M205_KEY',
  models: { fast: 'fast-model', strong: 'strong-model', embed: 'embed-model' },
  limits: { rpm: 0, concurrency: 2 },
  budget: { dailyUsd: 10, monthlyUsd: 10 },
  pricing: { 'fast-model': { in: 1000, out: 1000 }, 'strong-model': { in: 1000, out: 1000 }, default: { in: 1000, out: 1000 } },
  ...over,
});

const mk = (over = {}, guard) => new AiClient({
  config: cfg(over),
  apiKey: 'sk-x',
  sleepImpl: async () => {},
  onUsage: (u) => recordUsage(DB, { ...u, userId: UID }),
  guard: guard ?? budgetGuard(DB, UID, cfg(over)),
});

// ── ① 每次调用都有记录 ─────────────────────────────────────
group('2.5 预算 · 审计');

await reset();
{
  const c = mk();
  await c.chatJson(OPTS);
  const u = usageSince(DB, UID, 0);
  check('成功调用写了一条 ai_usage', () => eq(u.calls, 1));
  check('记录了 model / tokens / 成本（不是只记一条空行）', () => {
    const row = DB.prepare('SELECT model, in_tokens, out_tokens, cost_usd, ok, purpose FROM ai_usage ORDER BY id DESC LIMIT 1').get();
    return ok(row.model === 'strong-model' && Number(row.in_tokens) === 1000
      && Number(row.out_tokens) === 500 && Number(row.cost_usd) > 0
      && Number(row.ok) === 1 && row.purpose === 'analyze', JSON.stringify(row));
  });
  check('成本按 pricing 算：1000 入 + 500 出 @ $1000/M = $1.5', () => {
    const row = DB.prepare('SELECT cost_usd FROM ai_usage ORDER BY id DESC LIMIT 1').get();
    return ok(Math.abs(Number(row.cost_usd) - 1.5) < 1e-9, `算得 ${row.cost_usd}`);
  });
}

// 失败的调用也要记（成本账不能只记成功）
await reset();
{
  // 让 mock 回 500：换一个只会 500 的客户端
  const badSrv = createServer((req, res) => { res.writeHead(500); res.end('x'); });
  await new Promise((r) => badSrv.listen(0, '127.0.0.1', r));
  const badBase = `http://127.0.0.1:${badSrv.address().port}/v1`;
  const before = usageSince(DB, UID, 0).calls;
  const c = new AiClient({
    config: cfg({ baseURL: badBase, budget: { dailyUsd: 0, monthlyUsd: 0 } }),
    apiKey: 'sk-x', sleepImpl: async () => {},
    onUsage: (u) => recordUsage(DB, { ...u, userId: UID }),
  });
  await c.chatJson(OPTS);
  const after = usageSince(DB, UID, 0);
  check('失败调用也写 ai_usage（含重试的每一次）', () => ok(
    after.calls - before === 3, `新增 ${after.calls - before} 条（重试 2 次共 3 次）`,
  ));
  check('失败记录带 ok=0 与 error 原因', () => {
    const row = DB.prepare('SELECT ok, error FROM ai_usage ORDER BY id DESC LIMIT 1').get();
    return ok(Number(row.ok) === 0 && /http-500/.test(String(row.error)), JSON.stringify(row));
  });
  badSrv.close();
}

// ── ④ 本地日历日的边界 ────────────────────────────────────
group('2.5 预算 · 日界');

check('startOfLocalDay 落在本机 00:00:00.000', () => {
  const t = startOfLocalDay(Date.now());
  const d = new Date(t);
  return ok(d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0,
    new Date(t).toString());
});
check('startOfLocalDay 对"今天 00:30"与"今天 23:30"给出同一天', () => {
  const a = new Date(); a.setHours(0, 30, 0, 0);
  const b = new Date(); b.setHours(23, 30, 0, 0);
  return eq(startOfLocalDay(a.getTime()), startOfLocalDay(b.getTime()));
});
check('昨天 23:59 的花费不计入今天', () => {
  const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(23, 59, 0, 0);
  return ok(startOfLocalDay(y.getTime()) < startOfLocalDay(Date.now()),
    `昨天 ${new Date(startOfLocalDay(y.getTime())).toString()}`);
});
check('startOfLocalMonth 是本机 1 号 00:00:00.000', () => {
  const t = startOfLocalMonth(Date.now());
  const d = new Date(t);
  return ok(d.getDate() === 1 && d.getHours() === 0, d.toString());
});

// ── ② 日门降级 ────────────────────────────────────────────
group('2.5 预算 · 日门降级');

// 先清空今日用量再测：前面几组已经花掉一些
DB.prepare('DELETE FROM ai_usage').run();
{
  // dailyUsd=0.001，先花 0.002（一次 1.5 美元？不对 —— 这里用便宜的价目）
  const cheap = {
    pricing: { 'fast-model': { in: 1, out: 1 }, 'strong-model': { in: 1, out: 1 }, default: { in: 1, out: 1 } },
    budget: { dailyUsd: 0.001, monthlyUsd: 100 },
  };
  recordUsage(DB, {
    userId: UID, purpose: 'analyze', model: 'strong-model',
    inTokens: 1000, outTokens: 500, costUsd: 0.002, latencyMs: 1, ok: true,
  });
  const st = budgetState(DB, UID, cfg(cheap));
  check('今日花费超 dailyUsd → level=fast_only', () => eq(st.level, 'fast_only'));
  check('状态里带人话解释（UI 直接显示）', () => ok(
    /上限/.test(st.reason) && /降级|快模型/.test(st.reason), st.reason,
  ));

  await reset();
  const c = mk(cheap);
  const r = await c.chatJson(OPTS);
  check('降级档：请求**照发**（不是直接拒绝）', () => ok(r.ok === true, JSON.stringify(r).slice(0, 150)));
  check('降级档：请求里的 model 换成了 fast-model', () =>
    ok(seen.length === 1 && seen[0].model === 'fast-model', JSON.stringify(seen)));
  check('降级档：usage 记的是实际用的 fast-model', () => {
    const row = DB.prepare('SELECT model FROM ai_usage ORDER BY id DESC LIMIT 1').get();
    return eq(row?.model, 'fast-model');
  });
}

// fallback=stop 时日门直接停
{
  const stopCfg = {
    pricing: { default: { in: 1, out: 1 } },
    budget: { dailyUsd: 0.001, monthlyUsd: 100 },
    fallback: { onBudgetExceeded: 'stop' },
  };
  const st = budgetState(DB, UID, cfg(stopCfg));
  check('fallback=stop 时，日门也直接停在 stop 档', () => eq(st.level, 'stop'));
}

// ── ③ 月门停止 ────────────────────────────────────────────
group('2.5 预算 · 月门停止');

DB.prepare('DELETE FROM ai_usage').run();
{
  const monthCfg = { budget: { dailyUsd: 100, monthlyUsd: 0.001 } };
  recordUsage(DB, {
    userId: UID, purpose: 'analyze', model: 'strong-model',
    inTokens: 1, outTokens: 1, costUsd: 0.002, latencyMs: 1, ok: true,
  });
  const st = budgetState(DB, UID, cfg(monthCfg));
  check('本月花费超 monthlyUsd → level=stop', () => eq(st.level, 'stop'));
  check('stop 的解释提到"暂停"', () => ok(/暂停/.test(st.reason), st.reason));

  await reset();
  const c = mk(monthCfg);
  const r = await c.chatJson(OPTS);
  check('stop 档：返回 kind=budget 而不是抛异常', () => ok(
    r.ok === false && r.failure.kind === 'budget', JSON.stringify(r).slice(0, 150),
  ));
  check('stop 档：一个 HTTP 请求都没发（闸门在请求之前）', () => eq(seen.length, 0));
  check('stop 档：不写 ai_usage（没花钱就不记账）', () => {
    const n = usageSince(DB, UID, 0).calls;
    return eq(n, 1);   // 只有上面手工插的那一条
  });
  check('stop 不可重试（队列不该反复撞墙）', () => ok(r.failure.retryable === false));
}

// ── ⑤ monthlyUsd=0 表示不限额 ─────────────────────────────
group('2.5 预算 · 不限额');

DB.prepare('DELETE FROM ai_usage').run();
recordUsage(DB, {
  userId: UID, purpose: 'analyze', model: 'strong-model',
  inTokens: 1, outTokens: 1, costUsd: 5, latencyMs: 1, ok: true,
});
{
  const st = budgetState(DB, UID, cfg({ budget: { dailyUsd: 0, monthlyUsd: 0 } }));
  check('dailyUsd=0 与 monthlyUsd=0 → 不限额（level=ok，不是 stop）', () =>
    eq(st.level, 'ok'));
  check('不限额时 reason 为空（UI 不该显示"已暂停"）', () => eq(st.reason, ''));
  check('不限额时仍记录花费（供用户自己看账）', () => gt(st.todayUsd, 0, '今日花费'));
}

// ── ⑦ embedding 的档位行为 ────────────────────────────────
group('2.5 预算 · embedding 档位');

DB.prepare('DELETE FROM ai_usage').run();
{
  const fastCfg = {
    pricing: { default: { in: 1, out: 1 } },
    budget: { dailyUsd: 0.001, monthlyUsd: 100 },
  };
  recordUsage(DB, {
    userId: UID, purpose: 'analyze', model: 'strong-model',
    inTokens: 1, outTokens: 1, costUsd: 0.002, latencyMs: 1, ok: true,
  });
  await reset();
  const c = mk(fastCfg);
  const r = await c.embed('some text');
  check('fast_only 档：embedding 不降级（照用 embed-model）', () => ok(
    r.ok === true && seen.length === 1 && seen[0].model === 'embed-model',
    `ok=${r.ok} seen=${JSON.stringify(seen)}`,
  ));
}

DB.prepare('DELETE FROM ai_usage').run();
{
  const stopCfg = { budget: { dailyUsd: 100, monthlyUsd: 0.001 } };
  recordUsage(DB, {
    userId: UID, purpose: 'analyze', model: 'strong-model',
    inTokens: 1, outTokens: 1, costUsd: 0.002, latencyMs: 1, ok: true,
  });
  await reset();
  const c = mk(stopCfg);
  const r = await c.embed('some text');
  check('stop 档：embedding 也停，且不发请求', () => ok(
    r.ok === false && r.failure.kind === 'budget' && seen.length === 0,
    `ok=${r.ok} kind=${r.failure?.kind} seen=${seen.length}`,
  ));
}

// ── ⑥ guard 可注入（不再依赖库里的数据） ─────────────────
group('2.5 预算 · 闸门可注入');

await reset();
{
  const c = new AiClient({
    config: cfg(), apiKey: 'sk-x', sleepImpl: async () => {},
    onUsage: () => {},
    guard: () => ({ action: 'block', reason: '测试注入的拦截' }),
  });
  const r = await c.chatJson(OPTS);
  check('注入 block 的 guard → 一个请求都不发', () => ok(
    r.ok === false && seen.length === 0, `seen=${seen.length}`,
  ));
  check('注入的 reason 原样出现在 failure.message 里', () =>
    ok(String(r.failure.message).includes('测试注入的拦截'), r.failure.message));
}

// ── ⑧ UI 可见（PLAN 2.5 判据③"再超则停止且 UI 可见"）───────
//
// 这一条必须走真实浏览器：档位是**后端算的**，但"用户能不能看见"只有
// 打开页面才知道。只断言 /stats 返回了 level 是空的 —— 一个把 level
// 存在 state 里却从不渲染的实现同样满足。
//
// 没有 Chromium 系浏览器时这一节 SKIP（与 0.9/m1-05 一致：环境缺失不算失败）。
const { existsSync } = await import('node:fs');
const BROWSERS = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
const browser = BROWSERS.find((p) => existsSync(p));

if (!browser) {
  console.log('  \u001b[33mSKIP\u001b[0m  未找到 Chromium 系浏览器，跳过 UI 断言');
} else {
  group('2.5 预算 · UI 可见');
  const { spawn } = await import('node:child_process');
  const { mkdtempSync: mkd, rmSync: rms } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const { join: jn, dirname: dn, resolve: rs } = await import('node:path');
  const { fileURLToPath: fu } = await import('node:url');
  const { killTree: kt } = await import('../lib/proc.mjs');

  const ROOT = rs(dn(fu(import.meta.url)), '../..');
  const BIN = jn(ROOT, 'dist', process.platform === 'win32'
    ? `ai-rss-${process.platform}-${process.arch}.exe`
    : `ai-rss-${process.platform}-${process.arch}`);

  const dir = mkd(jn(td(), 'ai-rss-m205ui-'));
  const dataDir = jn(dir, 'data');
  const port = 42800 + Math.floor(Math.random() * 500);
  const uiBase = `http://127.0.0.1:${port}`;

  const srv2 = spawn(BIN, ['serve', '--data', dataDir, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // AI_API_KEY 刻意留空：要验的就是"没配 key 时 UI 有没有提示"
    env: { ...process.env, AI_API_KEY: '', AI_BASE_URL: BASE },
  });
  let srvErr = '';
  srv2.stderr.on('data', (d) => { srvErr += String(d); });
  srv2.stdout.on('data', () => {});

  const profile = jn(dir, 'profile');
  let edge = null;
  const cleanupUi = () => {
    kt(srv2.pid);
    kt(edge?.pid);
    try { rms(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on('exit', cleanupUi);

  let up = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${uiBase}/api/health`)).ok) { up = true; break; } } catch { /* 起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  check('UI 用的服务就绪', () => ok(up, srvErr.slice(0, 300)));

  if (up) {
    await fetch(`${uiBase}/api/v1/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ui@test.local', password: 'uipass12345678' }),
    });
    const lr = await fetch(`${uiBase}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ui@test.local', password: 'uipass12345678' }),
    });
    const cookie = (lr.headers.get('set-cookie') ?? '').split(';')[0];

    // 造出"月预算已超"的状态
    const { DatabaseSync: W } = await import('node:sqlite');
    const w = new W(jn(dataDir, 'app.db'));
    try {
      const uid = w.prepare('SELECT id FROM users LIMIT 1').get().id;
      w.prepare(`INSERT INTO ai_usage (user_id, purpose, model, in_tokens, out_tokens,
          cost_usd, latency_ms, ok, error, created_at)
          VALUES (?, 'analyze', 'm', 1, 1, 99, 1, 1, NULL, ?)`)
        .run(uid, Date.now());
      w.prepare('UPDATE settings SET ai_config = ? WHERE user_id = ?')
        .run(JSON.stringify({ budget: { dailyUsd: 10, monthlyUsd: 1 } }), uid);
    } finally { w.close(); }

    const st = await (await fetch(`${uiBase}/api/v1/stats`, { headers: { cookie } })).json();
    check('后端 /stats 报出 stop 档（UI 的数据源）', () => eq(st?.ai?.level, 'stop'));

    edge = spawn(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--window-size=1440,900', uiBase,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let wsUrl = '';
    edge.stderr.on('data', (d) => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
      if (m) wsUrl = m[1];
    });
    for (let i = 0; i < 80 && !wsUrl; i++) await new Promise((r) => setTimeout(r, 250));

    if (!wsUrl) {
      check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
    } else {
      const ws = new WebSocket(wsUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      let msgId = 0;
      const pending = new Map();
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        }
      };
      const raw = (method, params = {}, sessionId) => new Promise((res, rej) => {
        const i = ++msgId;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

      const targets = await raw('Target.getTargets');
      const pageT = targets.targetInfos.find((t) => t.type === 'page');
      const { sessionId } = await raw('Target.attachToTarget', { targetId: pageT.targetId, flatten: true });
      const sess = (method, params = {}) => raw(method, params, sessionId);

      const evalJs = async (expr) => {
        const r = await sess('Runtime.evaluate', {
          expression: expr, returnByValue: true, awaitPromise: true,
        });
        return r.result?.value;
      };

      await sess('Network.enable');
      await sess('Network.setCookie', {
        name: cookie.split('=')[0], value: cookie.split('=')[1], url: uiBase,
      });
      await sess('Page.navigate', { url: uiBase });
      await new Promise((r) => setTimeout(r, 2500));

      const opened = await evalJs(`(async () => {
        const btn = document.querySelector('.side-settings, button[title*="配置"], button[aria-label*="配置"]');
        if (!btn) return 'no-btn';
        btn.click();
        await new Promise(r => setTimeout(r, 700));
        const nav = [...document.querySelectorAll('.settings-nav-item')]
          .find(x => x.textContent.includes('AI 分析'));
        if (!nav) return 'no-nav';
        nav.click();
        await new Promise(r => setTimeout(r, 1200));
        return 'ok';
      })()`);
      check('能打开配置弹窗并切到「AI 分析」', () => ok(opened === 'ok', String(opened)));

      const ui = await evalJs(`(() => {
        const pane = document.querySelector('.settings-pane:not([hidden])');
        const level = pane?.querySelector('.ai-level');
        return {
          level: level?.getAttribute('data-level') ?? '',
          levelText: pane?.querySelector('.ai-level-text')?.textContent ?? '',
          reason: pane?.querySelector('.ai-level-reason')?.textContent ?? '',
          kv: [...(pane?.querySelectorAll('.ai-kv dt') ?? [])].map(x => x.textContent.trim()),
          warn: (pane?.querySelector('.hint.warn')?.textContent ?? '').slice(0, 80),
        };
      })()`);

      check('UI 上运行状态显示 stop 档（不是一直显示"正常"）', () =>
        ok(ui?.level === 'stop', `data-level=${ui?.level}`));
      check('UI 上写出"已暂停"并解释原因', () =>
        ok(/暂停/.test(String(ui?.levelText)) && /上限|暂停/.test(String(ui?.reason)),
          `text=${ui?.levelText} reason=${ui?.reason}`));
      check('UI 上能看到今日/本月花费与额度', () =>
        ok(Array.isArray(ui?.kv) && ui.kv.length >= 4
          && ui.kv.some((t) => t.includes('今日花费'))
          && ui.kv.some((t) => t.includes('本月花费')),
          JSON.stringify(ui?.kv)));
      check('没配 key 时 UI 明确提示去配环境变量', () =>
        ok(/AI_API_KEY|环境变量/.test(String(ui?.warn)), String(ui?.warn)));

      ws.close();
    }
  }
  cleanupUi();
}

summary('m2-05-budget');

// ── 收尾 ────────────────────────────────────────────────────
//
// 这一节吃过一次"脚本跑到 35/35 却不退出"的教训：重构文件时把
// `srv.close()` / `h.close()` 那几行连同 summary 一起截掉了，结果是
// 断言全绿、退出码永远不返回，只能靠超时杀进程。断言通过不等于脚本
// 结束 —— 任何被 open 出来的句柄（mock server、DB 连接、CDP WebSocket）
// 都必须显式关掉，否则 verify-all 会挂在它身上。
//
// 顺序：先关业务句柄（DB 在最后，因为它在 tail 段之后没人用了），
// 再关 HTTP server。不调 process.exit() —— 见本文件前面关于
// libuv UV_HANDLE_CLOSING 断言的说明。
h.close();
rmSync(tmp, { recursive: true, force: true });
await new Promise((r) => { srv.close(() => r()); setTimeout(r, 300).unref?.(); });
process.exitCode = process.exitCode ?? 0;
