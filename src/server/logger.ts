import { randomBytes } from 'node:crypto';

// 极简结构化日志。不引入 pino/winston —— 单进程自托管场景，
// 一个带级别的 printf 足够，少一个依赖少一个打包变量。

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

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => {
    if (enabled('debug')) console.error(fmt('debug', msg, extra));
  },
  info: (msg: string, extra?: Record<string, unknown>) => {
    if (enabled('info')) console.error(fmt('info', msg, extra));
  },
  warn: (msg: string, extra?: Record<string, unknown>) => {
    if (enabled('warn')) console.error(fmt('warn', msg, extra));
  },
  error: (msg: string, extra?: Record<string, unknown>) => {
    if (enabled('error')) console.error(fmt('error', msg, extra));
  },
};

/** 生成短 id（游标、临时键用）。不用 ulid 依赖。 */
export function shortId(prefix = ''): string {
  const t = Date.now().toString(36);
  const r = randomBytes(5).toString('hex');
  return `${prefix}${t}${r}`;
}
