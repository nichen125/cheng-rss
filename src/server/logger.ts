import { randomBytes } from 'node:crypto';

// 极简结构化日志。不引入 pino/winston —— 单进程自托管场景，
// 一个带级别的 printf 足够，少一个依赖少一个打包变量。
//
// **带按模板的速率限制**（PLAN §5.7 P4）。为什么日志需要限速：
// 日志默认被容器收集到 NAS 的 /var，而"缺 key""上游 429""磁盘满"这类
// 故障会以**同一个模板**反复触发 —— 实测缺 key 时 745 篇待分析能刷 745 行
// 同一句，把真正的错误全埋掉，同时把磁盘写满。
//
// 限速的单位是**模板**而不是"总共多少行"：总量限制会让正常的、各不相同的
// 日志被压掉（那才是真正的信息），而模板级限制只压"同一句话反复出现"。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

export function setLogLevel(l: LogLevel): void {
  minLevel = l;
}

function enabled(l: LogLevel): boolean {
  return ORDER[l] >= ORDER[minLevel];
}

function fmt(level: LogLevel, msg: string, extra?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const tail = extra && Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
  return `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
}

// ── 模板级速率限制 ──────────────────────────────────────────

/** 窗口长度。与 §5.7 的「同一模板 ≤ 3 行/60s」对齐 */
export const WINDOW_MS = 60_000;
/** 每个模板在每个窗口内允许直出的行数 */
export const RATE_LIMIT_PER_WINDOW = 3;
/** 记住多少个模板。上限存在的理由：故障模板可能带动态串（URL、id），
 *  不设上限时这张表自己会泄漏内存 —— 而它本来是用来防止资源问题的 */
const MAX_TEMPLATES = 256;

interface Bucket { windowStart: number; shown: number; suppressed: number }
const buckets = new Map<string, Bucket>();

/**
 * 日志模板：去掉消息里的动态部分。
 *
 * 只做一件保守的事：数字串归一（`745 篇` 与 `3 篇` 是同一句模板）。
 *
 * 刻意**不**把引号里的内容也归一 —— 那会把 `"no-key"` 与 `"http-500"`
 * 归成同一句，两个完全不同故障的日志就被并成一条了。
 */
export function logTemplate(msg: string): string {
  return msg.replace(/\d+/g, '#');
}

/**
 * 记一次。返回 true = 应当输出，false = 被折叠。
 *
 * 窗口内前 N 次放行；之后只累计。窗口结束时由下一次调用把这期间
 * 折叠掉的条数补报出来 —— 不需要定时器，因此空闲时零开销
 * （§5.7 的空闲 CPU 红线就是靠"不引入后台定时器"守住的）。
 */
export function rateAllow(template: string, now = Date.now()): number | false {
  let b = buckets.get(template);
  if (!b) {
    // 表满时清掉窗口已过期的桶。不清的话这张表会随模板数量单调增长，
    // 而模板里常常带 id / URL。
    if (buckets.size >= MAX_TEMPLATES) {
      for (const [k, v] of buckets) {
        if (now - v.windowStart >= WINDOW_MS) buckets.delete(k);
      }
      if (buckets.size >= MAX_TEMPLATES) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
    }
    b = { windowStart: now, shown: 0, suppressed: 0 };
    buckets.set(template, b);
  }

  if (now - b.windowStart >= WINDOW_MS) {
    // 过窗口只重置**配额**，不重置 suppressed —— 被折叠的条数必须跨窗口
    // 存活到下一次真的输出为止，否则"翻转窗口"这一步就把账抹了。
    b.windowStart = now;
    b.shown = 0;
  }

  if (b.shown < RATE_LIMIT_PER_WINDOW) {
    b.shown++;
    return b.shown;
  }
  b.suppressed++;
  return false;
}

/**
 * 取走并清空某模板被折叠的条数。
 *
 * 为什么是"取走"而不是内部定时补报：补报需要定时器，而 §5.7 要求空闲时
 * 不烧 CPU。调用方在**下一次**真的有机会输出时顺手带走这个数字，
 * 于是"被压了多少"仍然可追溯，且不引入任何后台任务。
 */
export function takeSuppressed(template: string): number {
  const b = buckets.get(template);
  if (!b || b.suppressed === 0) return 0;
  const n = b.suppressed;
  b.suppressed = 0;
  return n;
}

/** 清空限速状态（验收脚本与 `setLogLevel` 用） */
export function resetRateLimit(): void {
  buckets.clear();
}

/**
 * 原子化的一次日志：先看能不能输出，能就带上"上次折叠了多少条"。
 *
 * `…折叠 N 条` 这一行**不占限额** —— 它是限速器自己的通知，
 * 让它占限额的话，一个持续刷屏的模板会把通知本身也压掉。
 */
function emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  if (!enabled(level)) return;
  const tpl = `${level[0]}:${logTemplate(msg)}`;
  const slot = rateAllow(tpl);
  if (slot === false) return;

  const folded = takeSuppressed(tpl);
  if (folded > 0) {
    console.error(fmt(level, `${msg}（另有 ${folded} 条同类已折叠）`, extra));
  } else {
    console.error(fmt(level, msg, extra));
  }
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
};

/** 生成短 id（游标、临时键用）。不用 ulid 依赖。 */
export function shortId(prefix = ''): string {
  const t = Date.now().toString(36);
  const r = randomBytes(5).toString('hex');
  return `${prefix}${t}${r}`;
}
