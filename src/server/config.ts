import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 运行配置。
//
// 优先级：命令行参数 > 环境变量 > data/config.json > 默认值
// 三条部署路径（源码/二进制/Docker）走完全相同的解析逻辑（PLAN §4.5）。

export interface RuntimeConfig {
  dataDir: string;
  port: number;
  host: string;
  /** 首次启动自动创建的管理员账号，仅用于单用户场景 */
  adminEmail: string;
  /** AI 配置从环境变量或 config.json 读取，key 绝不写进 config.json */
  ai: {
    baseURL: string;
    apiKeyEnv: string;
    models: { fast: string; strong: string; embed: string };
    budget: { dailyUsd: number; monthlyUsd: number };
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** 会话 cookie 的有效期（天） */
  sessionDays: number;
}

const DEFAULTS = {
  dataDir: './data',
  port: 3000,
  host: '127.0.0.1',
  logLevel: 'info' as const,
  sessionDays: 30,
};

export function resolveDataDir(explicit?: string): string {
  const raw = explicit ?? process.env.CHENG_RSS_DATA ?? process.env.DATA_DIR ?? DEFAULTS.dataDir;
  return resolve(raw);
}

/**
 * 加载配置。dataDir 下的 config.json 若不存在则用默认值，
 * 不会自动创建 —— 创建时机由 serve 负责，避免 doctor 之类的
 * 只读命令改动磁盘。
 */
export function loadConfig(opts: { dataDir?: string; port?: number; host?: string } = {}): RuntimeConfig {
  const dataDir = resolveDataDir(opts.dataDir);
  const configPath = `${dataDir}/config.json`;

  let fileCfg: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`config.json 解析失败: ${(e as Error).message}\n路径: ${configPath}`);
    }
  }

  const pick = <T>(...vals: (T | undefined | null)[]): T | undefined =>
    vals.find((v) => v !== undefined && v !== null && (v as unknown) !== '') as T | undefined;

  const port = Number(pick<number | string>(
    opts.port, process.env.PORT, fileCfg.port as number, DEFAULTS.port,
  ) ?? DEFAULTS.port);
  const host = String(pick<string>(
    opts.host, process.env.HOST, fileCfg.host as string, DEFAULTS.host,
  ) ?? DEFAULTS.host);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`端口无效: ${port}`);
  }

  const aiFile = (fileCfg.ai ?? {}) as Record<string, unknown>;
  const modelsFile = (aiFile.models ?? {}) as Record<string, string>;
  const budgetFile = (aiFile.budget ?? {}) as Record<string, number>;

  return {
    dataDir,
    port,
    host,
    adminEmail: String(pick(fileCfg.adminEmail as string, 'admin@localhost')),
    ai: {
      baseURL: String(pick(process.env.AI_BASE_URL, aiFile.baseURL as string,
        'https://api.deepseek.com/v1')),
      // 只存环境变量名，不存 key 本身
      apiKeyEnv: String(pick(aiFile.apiKeyEnv as string, 'AI_API_KEY')),
      models: {
        fast: String(pick(modelsFile.fast, 'deepseek-chat')),
        strong: String(pick(modelsFile.strong, 'deepseek-chat')),
        embed: String(pick(modelsFile.embed, 'text-embedding-3-small')),
      },
      budget: {
        dailyUsd: Number(pick(budgetFile.dailyUsd, 1.0)),
        monthlyUsd: Number(pick(budgetFile.monthlyUsd, 20.0)),
      },
    },
    logLevel: (pick(process.env.LOG_LEVEL, fileCfg.logLevel as string,
      DEFAULTS.logLevel) as RuntimeConfig['logLevel']),
    sessionDays: Number(pick(fileCfg.sessionDays as number, DEFAULTS.sessionDays)),
  };
}

/** 确保 data 目录及其子目录存在。仅 serve/migrate/import 调用。 */
export function ensureDataDirs(dataDir: string): void {
  for (const sub of ['', '/files', '/backups']) {
    const p = `${dataDir}${sub}`;
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
}

/** 写入 config.json（仅在文件不存在时），不覆盖用户已有配置 */
export function writeDefaultConfigIfAbsent(cfg: RuntimeConfig): boolean {
  const path = `${cfg.dataDir}/config.json`;
  if (existsSync(path)) return false;
  const body = {
    port: cfg.port,
    host: cfg.host,
    adminEmail: cfg.adminEmail,
    ai: {
      baseURL: cfg.ai.baseURL,
      apiKeyEnv: cfg.ai.apiKeyEnv,
      models: cfg.ai.models,
      budget: cfg.ai.budget,
    },
    logLevel: cfg.logLevel,
    sessionDays: cfg.sessionDays,
    _comment: 'API key 从环境变量读取，不要写在此文件里',
  };
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n', 'utf8');
  return true;
}
