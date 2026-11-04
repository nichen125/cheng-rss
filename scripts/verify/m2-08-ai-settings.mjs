#!/usr/bin/env node
// AI 配置页分层折叠 —— 验收（PLAN §15.29，v2.2）
//
// 判据：
//   ① 默认打开时「模型连接」「总结提示词」两个 <details> 是收起的
//   ② 它们用的是原生 <details>/<summary>（键盘可达、aria 由浏览器给）
//   ③ summary 行高 ≥ 44px（触摸红线，与 §15.7 同一标准）
//   ④ summary 上不能有 user-select:none（那是侧栏长按用的，这里要能选字）
//   ⑤ 点开「模型连接」后地址 + 三个模型名输入框真的出现，再点能收起
//   ⑥ 折叠摘要行显示当前模型名 / 提示词状态（收起也知道里面是什么）
//   ⑦ 预算输入框在**收起状态下**也可修改（它是 ②，不该被折叠挡住）
//   ⑧ 折叠状态比全展开矮 ≥ 400px（防止"加了折叠但没省出空间"）
//   ⑨ 折叠不丢输入：在预算框输入 → 展开高级 → 收起 → 值还在
//
// ## ④⑦⑧ 为什么必须各有一条
//
// ④ 是因为 §15.28.11 那条 `user-select:none` 是给侧栏长按加的，若有人
//   顺手提到 `.settings-card` 上，配置页的标题就选不中了 —— 而画面正常。
// ⑦ 是因为"把预算也收进「模型连接」"是最容易的回归（它本来就在那张卡里）。
// ⑧ 是本节唯一的量化目的："折叠"本身不是目标，省出可视空间才是。
//    没有这条，把四张卡都加上 <details> 但内容一字不动也能过。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { group, check, eq, ok, summary } from './harness.mjs';
import { killTree } from '../lib/proc.mjs';
import { launchBrowser, connectCdp, findBrowser } from '../lib/cdp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(root, 'dist', process.platform === 'win32'
  ? `ai-rss-${process.platform}-${process.arch}.exe`
  : `ai-rss-${process.platform}-${process.arch}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

group('2.8 AI 配置页分层折叠');

// 改前的页高基线：四张卡全展开 ≈ 1400px（1440×900 下要滚三屏）。
// 断言用「收起后 < 改前」，把改前的数写成常量而不是"和当前 DOM 的某种
// 计算比" —— 后者会跟着实现一起漂，等于没测。
const HEIGHT_BEFORE = 1400;
const HEIGHT_REDUCTION_MIN = 400;

if (!existsSync(BIN)) {
  console.error('二进制不存在，先跑 ./scripts/build.sh --sea');
  process.exit(1);
}

if (!findBrowser()) {
  console.log('  \u001b[33mSKIP\u001b[0m  本机没有 Chromium 系浏览器，跳过 UI 断言');
  summary('m2-08-ai-settings');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'ai-rss-m208-'));
const dataDir = join(dir, 'data');
const port = 43300 + Math.floor(Math.random() * 500);
const uiBase = `http://127.0.0.1:${port}`;

const srv = spawn(BIN, ['serve', '--data', dataDir, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AI_API_KEY: '', AI_BASE_URL: '' },
});
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += String(d); });
srv.stdout.on('data', () => {});

let br = null;
const cleanup = () => {
  killTree(srv.pid);
  try { br?.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on('exit', cleanup);

let up = false;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${uiBase}/api/health`)).ok) { up = true; break; } } catch { /* 起 */ }
  await sleep(250);
}
check('服务就绪', () => ok(up, srvErr.slice(0, 300)));

if (up) {
  await fetch(`${uiBase}/api/v1/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ai@test.local', password: 'aipass12345678' }),
  });
  const lr = await fetch(`${uiBase}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ai@test.local', password: 'aipass12345678' }),
  });
  const cookie = (lr.headers.get('set-cookie') ?? '').split(';')[0];

  br = await launchBrowser({
    profile: join(dir, 'profile'),
    width: 1440,
    height: 900,
    url: uiBase,
  });

  if (!br.wsUrl) {
    check('浏览器调试端口可用', () => ok(false, 'CDP 没起来'));
  } else {
    const cdp = await connectCdp(br.wsUrl);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCookie', {
      name: cookie.split('=')[0], value: cookie.split('=')[1], url: uiBase,
    });
    await cdp.send('Page.navigate', { url: uiBase });
    await sleep(2500);

    const opened = await cdp.evaluate(`(async () => {
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
    check('能打开配置并切到「AI 分析」', () => ok(opened === 'ok', String(opened)));

    if (opened === 'ok') {
      // ── ①②③④ 默认状态 ─────────────────────────────────
      const init = await cdp.evaluate(`(() => {
        const pane = document.querySelector('.settings-pane:not([hidden])');
        const folds = [...(pane?.querySelectorAll('details.settings-fold') ?? [])];
        return {
          foldIds: folds.map(d => d.id),
          openIds: folds.filter(d => d.open).map(d => d.id),
          summaryHeights: folds.map(d => {
            const s = d.querySelector('summary');
            const r = s?.getBoundingClientRect();
            return r ? Math.round(r.height) : 0;
          }),
          userSelect: folds.map(d => getComputedStyle(d.querySelector('summary')).userSelect),
          tagNames: folds.map(d => d.tagName),
        };
      })()`);

      check('① 页面上有两个折叠卡（模型连接 / 总结提示词）', () =>
        eq((init?.foldIds ?? []).length, 2));
      check('① 默认都是收起的（展开状态不跨次记住，同 §15.19 的理由）', () =>
        ok(Array.isArray(init?.openIds) && init.openIds.length === 0,
          JSON.stringify(init?.openIds)));
      check('② 折叠用原生 <details>（键盘与 aria-expanded 由浏览器给）', () =>
        ok((init?.tagNames ?? []).length === 2
          && init.tagNames.every((t) => t === 'DETAILS'), JSON.stringify(init?.tagNames)));
      check('③ 折叠头行高 ≥ 44px（触摸目标红线）', () => {
        const hs = init?.summaryHeights ?? [];
        return ok(hs.length === 2 && hs.every((h) => h >= 44), JSON.stringify(hs));
      });
      check('④ 折叠头没有 user-select:none（那是侧栏长按用的，这里要能选字）', () => {
        const vs = init?.userSelect ?? [];
        return ok(vs.length === 2 && vs.every((v) => v !== 'none'), JSON.stringify(vs));
      });

      // ── ⑤ 展开/收起真的切换内容 ────────────────────────
      //
      // ⚠ 这里踩过一个"看起来能过、其实恒真"的坑，记下来免得下次再写：
      //
      // 关闭的 <details> 里，子元素 **`offsetParent` 不为 null**、
      // `getBoundingClientRect().height` 也**仍返回真实高度**（实测 37px）——
      // Chrome 用 `content-visibility: hidden` 实现折叠，不是 `display:none`。
      // 所以「用 offsetParent 判可见」在这种结构上恒为真，断言永远绿。
      //
      // 唯一的真判据是 `element.checkVisibility()`（实测关闭时 false、
      // 展开时 true）。这条断言因此也顺便守住了"折叠结构别改成 hidden 属性"
      // —— 换成 `hidden` 的话 offsetParent 会变 null，但 checkVisibility
      // 依然正确，两种实现都能被这条断言正确判定。
      const toggled = await cdp.evaluate(`(async () => {
        const d = document.getElementById('ai-advanced-card');
        if (!d) return { err: 'no-card' };
        const vis = () => [...d.querySelectorAll('input')]
          .filter(i => i.checkVisibility()).length;
        const closedVis = vis();
        d.querySelector('summary').click();
        await new Promise(r => setTimeout(r, 300));
        const open = d.open;
        const openVis = vis();
        const inputs = [...d.querySelectorAll('input')].map(i => i.placeholder);
        d.querySelector('summary').click();
        await new Promise(r => setTimeout(r, 300));
        return { open, closedAgain: !d.open, closedVis, openVis, inputs };
      })()`);
      check('⑤ 收起时里面的输入框确实不可见（checkVisibility，不是 offsetParent）', () =>
        eq(toggled?.closedVis, 0));
      check('⑤ 点概要行能展开（open=true）', () => ok(toggled?.open === true,
        JSON.stringify(toggled)));
      check('⑤ 展开后地址 + 三个模型名输入框真的可见（不是只改了 open 属性）', () =>
        ok(toggled?.openVis >= 4,
          JSON.stringify({ openVis: toggled?.openVis, all: toggled?.inputs })));
      check('⑤ 再点一次收起（不是只能开不能关）', () =>
        ok(toggled?.closedAgain === true, JSON.stringify(toggled)));

      // ── ⑥ 收起时显示当前值摘要 ─────────────────────────
      const summaryText = await cdp.evaluate(`(() => {
        const pane = document.querySelector('.settings-pane:not([hidden])');
        const m = pane?.querySelector('[data-testid="ai-models-summary"]')?.textContent ?? '';
        const p = pane?.querySelector('[data-testid="ai-prompt-summary"]')?.textContent ?? '';
        return { models: m.trim(), prompt: p.trim() };
      })()`);
      check('⑥ 折叠摘要行显示当前模型名（收起也知道连的是哪两个）', () =>
        ok(String(summaryText?.models).length > 0
          && String(summaryText?.models) !== '未读取',
          JSON.stringify(summaryText)));
      check('⑥ 提示词折叠摘要显示"内置默认/已自定义"', () =>
        ok(/内置默认|已自定义/.test(String(summaryText?.prompt)),
          JSON.stringify(summaryText)));

      // ── ⑦ 预算框在收起状态下可修改 ─────────────────────
      // 可见性同样用 checkVisibility（理由见 ⑤ 的注释）。
      const budget = await cdp.evaluate(`(async () => {
        const card = document.getElementById('ai-budget-card');
        if (!card) return { err: 'no-budget-card' };
        const input = card.querySelector('input');
        if (!input) return { err: 'no-input' };
        const visible = input.checkVisibility();
        const d = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value');
        d.set.call(input, '2.5');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        return { visible, value: input.value, inFold: Boolean(input.closest('details')) };
      })()`);
      check('⑦ 预算卡独立存在（不再挂在模型连接卡里）', () =>
        ok(!budget?.err, JSON.stringify(budget)));
      check('⑦ 预算输入框在收起状态下可见（折叠不该挡住它）', () =>
        ok(budget?.visible === true, JSON.stringify(budget)));
      check('⑦ 预算框不在任何 <details> 里', () =>
        ok(budget?.inFold === false, JSON.stringify(budget)));

      // ── ⑨ 折叠不丢输入 ─────────────────────────────────
      const kept = await cdp.evaluate(`(async () => {
        const d = document.getElementById('ai-advanced-card');
        const input = document.getElementById('ai-budget-card')?.querySelector('input');
        d.querySelector('summary').click();
        await new Promise(r => setTimeout(r, 250));
        d.querySelector('summary').click();
        await new Promise(r => setTimeout(r, 250));
        return input?.value ?? null;
      })()`);
      check('⑨ 展开/收起后预算框里的输入还在（折叠不重挂组件）', () =>
        eq(kept, '2.5'));

      // ── ⑧ 折叠真的省出了可视高度 ───────────────────────
      const heights = await cdp.evaluate(`(async () => {
        const pane = document.querySelector('.settings-pane:not([hidden])');
        const folds = [...pane.querySelectorAll('details.settings-fold')];
        for (const d of folds) d.open = false;
        await new Promise(r => setTimeout(r, 200));
        const collapsed = pane.scrollHeight;
        for (const d of folds) d.open = true;
        await new Promise(r => setTimeout(r, 200));
        const expanded = pane.scrollHeight;
        for (const d of folds) d.open = false;
        return { collapsed, expanded };
      })()`);
      check('⑧ 折叠状态比全展开矮 ≥ 400px（否则"折叠"只是形式）', () => {
        const drop = Number(heights?.expanded ?? 0) - Number(heights?.collapsed ?? 0);
        return ok(drop >= HEIGHT_REDUCTION_MIN,
          `展开 ${heights?.expanded} / 收起 ${heights?.collapsed} / 差 ${drop}`);
      });
      check('⑧ 收起后的页高明显低于改前基线', () =>
        ok(Number(heights?.collapsed ?? 0) < HEIGHT_BEFORE,
          `收起后 ${heights?.collapsed}，改前约 ${HEIGHT_BEFORE}`));

      cdp.close();
    }
  }
  cleanup();
}

await sleep(300);
summary('m2-08-ai-settings');
