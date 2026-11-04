import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killTree } from './proc.mjs';
import { removeDir } from './tmp.mjs';

// 无头浏览器的启动与 CDP 连接（验收脚本共用）。
//
// 存在的理由是一个**实测过的偶发失败**：各脚本自己写
//   `--remote-debugging-port=<10000 + random(80)>`
// 这种固定区间端口。它和系统的临时端口段（Windows 默认 49152+，但
// Hyper-V / WSL 会保留 10000 附近的段）撞上时，Chrome 直接静默退出，
// 脚本报「CDP 没起来」—— 而重跑一次又好了。全量跑 47 个脚本时，
// 这种"每次都 1% 概率"会变成"几乎每次总有一个红"。
//
// 修法是 `--remote-debugging-port=0`：让浏览器自己挑一个空闲端口，
// 然后从 profile 目录下的 `DevToolsActivePort` 文件读回来。
// 这不依赖 stderr 的措辞（那在各版本间会变），也不占固定端口。

const CANDIDATES = process.platform === 'win32'
  ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

/** 本机可用的 Chromium 系浏览器；没有则返回 null（调用方据此 SKIP） */
export function findBrowser() {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起一个无头浏览器并返回 CDP 的 page 目标。
 *
 * 返回 `{ proc, wsUrl, close }`。拿不到目标时返回 `{ proc, wsUrl: null, close }`，
 * 由调用方决定是 SKIP 还是 FAIL —— 这里不替调用方判。
 */
export async function launchBrowser(opts = {}) {
  const browserPath = opts.browserPath ?? findBrowser();
  if (!browserPath) return { proc: null, wsUrl: null, close: () => {}, profile: null };

  const profile = opts.profile ?? mkdtempSync(join(tmpdir(), opts.profilePrefix ?? 'cheng-rss-prof-'));
  const args = [
    '--headless=new',
    // 0 = 让浏览器自己挑空闲端口。固定区间会撞上系统保留段（见文件头注释）
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${opts.width ?? 1440},${opts.height ?? 950}`,
    'about:blank',
  ];
  if (opts.args) args.push(...opts.args);

  const proc = spawn(browserPath, args, { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');

  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      try {
        // 第一行是端口，第二行是浏览器级 ws 路径
        const [portLine, wsPath] = readFileSync(portFile, 'utf8').split(/\r?\n/);
        const port = Number(portLine);
        if (port > 0) {
          const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          const page = list.find((t) => t.type === 'page');
          if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
          // page 还没建出来时，直接用浏览器级 ws 也能连（后面 Target.createTarget）
          if (wsPath) { wsUrl = `ws://127.0.0.1:${port}${wsPath}`; break; }
        }
      } catch { /* 端口文件写了一半 */ }
    }
    await sleep(opts.pollMs ?? 200);
  }

  const close = () => {
    killTree(proc.pid);
    removeDir(profile);
  };
  return { proc, wsUrl, close, profile, browserPath };
}

/**
 * 连上 CDP 并返回一个小封装。
 *
 * `send(method, params)` 返回 Promise；`evaluate(expr)` 直接拿到值
 * （走了 `returnByValue` + `awaitPromise`）。
 *
 * **每个命令都带超时**。这不是防御性编程，是修一个实测过的挂死：
 * `Page.reload` 之后紧接着 `Runtime.evaluate` 时，被测页面正在换掉执行
 * 上下文，那条 evaluate 的应答**有时永远不来** —— 没有超时的话
 * Promise 永远 pending，整个脚本（以及串行跑它的 verify-all）就挂死。
 * 第一次遇到时它是"全量验收跑了 20 分钟没有输出"，看起来像机器卡了。
 *
 * 超时抛的是普通 Error，调用方原本就写的是 `.catch(() => false)`，
 * 于是"页面还没就绪"这条正常路径自动成立。
 */
export async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && pending.has(msg.id)) {
      const { res, rej, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      if (timer) clearTimeout(timer);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  });
  // 连接断了要立刻让所有在等的命令失败，而不是等各自的超时
  ws.addEventListener('close', () => {
    for (const [, v] of pending) {
      if (v.timer) clearTimeout(v.timer);
      v.rej(new Error('CDP 连接已关闭'));
    }
    pending.clear();
  });

  const send = (method, params = {}, timeoutMs = 15_000) => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      // 措辞里带上方法名：挂死时能一眼看出卡在哪条命令上
      rej(new Error(`CDP 超时 ${timeoutMs}ms：${method}`));
    }, timeoutMs);
    pending.set(id, { res, rej, timer });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      rej(e instanceof Error ? e : new Error(String(e)));
    }
  });

  const evaluate = async (expr, timeoutMs = 10_000) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    }
    return r.result?.value;
  };

  return { ws, send, evaluate, close: () => ws.close() };
}
