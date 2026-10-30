import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';

// API key 的落点（PLAN §8.8，2.6）。
//
// 为什么不是写进 settings.ai_config —— 那是最省事的做法，但 key 会跟着
// 「备份包 / 导出 JSONL / 换机器」一起走，而备份包恰恰是最容易被拷出去的东西。
// 所以这里单独一个文件：
//
//   data/secrets.json   权限 0600（Windows 上收紧 ACL 到仅当前用户）
//
// 三条不变量（都有断言，见 m2-06-api-key）：
//   1. 不进 app.db —— 所以全库字节里搜不到 key
//   2. 不出现在任何 API 响应里 —— 只给掩码
//   3. 文件不存在 = 没配 key，**不自动创建空文件**
//
// 第 3 条的理由：空文件让「配了一个空 key」与「没配置」变成同一种状态，
// 而这两种状态要给的提示完全不同（前者是"你填错了"，后者是"去填一个"）。

export const SECRETS_FILE = 'secrets.json';

export interface Secrets {
  aiApiKey?: string;
  updatedAt?: number;
}

function secretsPath(dataDir: string): string {
  return `${dataDir}/${SECRETS_FILE}`;
}

/**
 * 读 secrets。任何异常都当作"没有"。
 *
 * 不抛错的理由：这个函数在每次装配 AI 客户端时被调用，抛出去会让
 * "secrets.json 被手改坏"升级成"整个分析流水线停摆" —— 而那时用户
 * 最需要的是「去界面上重新填一次」，不是看不懂的启动错误。
 */
export function readSecrets(dataDir: string): Secrets {
  const p = secretsPath(dataDir);
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (!v || typeof v !== 'object') return {};
    const o = v as Record<string, unknown>;
    const key = typeof o.aiApiKey === 'string' ? o.aiApiKey.trim() : '';
    return { aiApiKey: key || undefined, updatedAt: Number(o.updatedAt) || undefined };
  } catch {
    return {};
  }
}

/**
 * 写 secrets（合并，不是覆盖）。
 *
 * `aiApiKey` 传空串 = 删除这一项；删到没有内容时**删掉整个文件**，
 * 让"没配 key"重新变成"文件不存在"这个可判定的状态。
 */
export function writeSecrets(dataDir: string, patch: { aiApiKey?: string | null }): Secrets {
  const cur = readSecrets(dataDir);
  const next: Secrets = { ...cur };

  if (patch.aiApiKey !== undefined) {
    const k = String(patch.aiApiKey ?? '').trim();
    if (k === '') delete next.aiApiKey;
    else next.aiApiKey = k;
  }
  // updatedAt 只在内容真的变了时更新：反复点"保存"不该让时间戳动
  if (next.aiApiKey !== cur.aiApiKey) next.updatedAt = Date.now();

  const p = secretsPath(dataDir);
  if (next.aiApiKey === undefined) {
    // 只剩 updatedAt 也删掉文件 —— 一个只有时间戳的文件没有任何用处
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* 被占用时留着，无害 */ }
    }
    return {};
  }

  // 先写临时文件再改名：写到一半断电不会留下半个 JSON，
  // 而半个 JSON 会让 readSecrets 返回 {}（key 静默消失，比报错更难查）。
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ aiApiKey: next.aiApiKey, updatedAt: next.updatedAt }, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  try { renameSync(tmp, p); } catch { /* 失败时下面仍会尝试收紧旧文件权限 */ }
  restrictPermissions(p);
  return next;
}

/**
 * 收紧文件权限。
 *
 * POSIX 上 `chmod 600` 够用。**Windows 上 chmod 是空操作**（实测：写完
 * 文件 mode 是 666，调 chmodSync(0o600) 之后读回来还是 666），所以必须
 * 用 icacls 把继承的 ACE 去掉、只留当前用户。
 *
 * 失败**不抛**：某些文件系统（FAT32 的 U 盘、部分 NAS 挂载）不支持 ACL。
 * 那种情况下 key 仍然是明文裸放的 —— 但这是用户选的存储位置的问题，
 * 不该让整个应用起不来。验收脚本据此判断，不在这里替用户决定。
 */
export function restrictPermissions(path: string): boolean {
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600);
      return true;
    } catch {
      return false;
    }
  }
  const user = process.env.USERNAME || userInfo().username;
  if (!user) return false;
  try {
    execFileSync('icacls', [path, '/inheritance:r'], { stdio: 'ignore', windowsHide: true });
    execFileSync('icacls', [path, '/grant:r', `${user}:(F)`], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 掩码。任何对外响应都只给这个。
 *
 * 长度 ≤ 8 时全掩码：`sk-ab`` 这种短 key 显示前 3 后 4 等于把全貌说出来了。
 */
export function maskKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const k = String(key);
  if (k.length <= 8) return '•'.repeat(k.length);
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}

/** key 的短指纹，用于缓存键与日志（日志里绝不能出现明文） */
export function keyFingerprint(key: string | null | undefined): string {
  if (!key) return 'none';
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export type KeySource = 'file' | 'env' | 'none';

export interface ResolvedKey {
  key: string | null;
  source: KeySource;
}

/**
 * 解析生效的 key：`secrets.json` → 环境变量。
 *
 * **文件优先**，因为它是用户在界面上显式填的；环境变量是部署期默认值。
 * 反过来（env 优先）会让"我在界面上换了 key 但不生效"变成必然 ——
 * 而 Docker 用户几乎总是同时设了环境变量。
 */
export function resolveKey(dataDir: string, apiKeyEnv: string): ResolvedKey {
  const fileKey = readSecrets(dataDir).aiApiKey ?? null;
  if (fileKey) return { key: fileKey, source: 'file' };
  const envKey = (process.env[apiKeyEnv] ?? '').trim();
  if (envKey) return { key: envKey, source: 'env' };
  return { key: null, source: 'none' };
}
