import type { DatabaseSync } from 'node:sqlite';

// 简报调度（PLAN §9.1 / §19.5 3.4）。
//
// 与 fetch_feed 的 sweep 是同一个套路：**单表扫一遍**，不靠 timer per user。
// 但简报的"该不该生成"比"该不该抓"复杂得多，因为它有三个独立的否决条件：
//
//   1. 时间没到         → 什么都不做（下一分钟再看）
//   2. 时间到了但没内容 → 落一条 digest_skips，今天不再试
//   3. 时间到了有内容但生成失败 → 退避重试（最多 3 次），然后放弃并记录
//
// 三种情况必须区分开。只用"有没有 digests 行"判断的话：
//   · 情况 2 会变成每分钟重试一次（1440 次/天，每次都聚类 + 调模型）
//   · 情况 3 会变成一次失败后就再也不试（而它往往只是网络抖了一下）
//
// 所以 skipping 与 failing 都要有**持久**的痕迹，且痕迹按 (user, kind, day) 唯一。

export interface DigestConfig {
  enabled: boolean;
  /** 本地时间 "HH:MM"。§9.1：每天 08:00 */
  at: string;
  kind: string;
}

export const DEFAULT_DIGEST_CONFIG: DigestConfig = {
  enabled: true,
  at: '08:00',
  kind: 'daily',
};

/** 单日最多尝试几次（含第一次） */
export const MAX_DELIVER_ATTEMPTS = 3;
/** 第 n 次失败后的退避（分钟）。第 3 次失败即放弃今天 */
export const RETRY_BACKOFF_MIN = [0, 10, 60];

export function parseDigestConfig(raw: unknown): DigestConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DIGEST_CONFIG };
  const o = raw as Record<string, unknown>;
  const at = typeof o.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.at)
    ? o.at
    : DEFAULT_DIGEST_CONFIG.at;
  return {
    enabled: o.enabled === undefined ? DEFAULT_DIGEST_CONFIG.enabled : Boolean(o.enabled),
    at,
    kind: typeof o.kind === 'string' && o.kind ? o.kind : DEFAULT_DIGEST_CONFIG.kind,
  };
}

/**
 * 本地日 00:00 的时间戳。
 *
 * 与 §9.4 的"为什么按本地日历"同源：用 UTC 日的话，东八区用户在 08:00
 * 看到的"今天"其实是 UTC 的昨天，而他 07:59 时看到的又是另一份。
 */
export function localDayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 今天应该的触发时刻。
 *
 * 用 setHours(h, m, 0, 0) 而不是 `dayStart + h*3600_000 + m*60_000`：
 * 后者在夏令时切换那天会偏一小时（少一天/多一天的小时数）。中国没有 DST，
 * 但 §17 里 Docker 用户的 TZ 可能是别的地区，而 NAS 部署里改 TZ 很常见。
 */
export function dueAt(t: number, at: string): number {
  const [hh, mm] = at.split(':').map(Number);
  const d = new Date(t);
  d.setHours(hh ?? 8, mm ?? 0, 0, 0);
  return d.getTime();
}

export interface DigestDue {
  due: boolean;
  /** 为什么不该跑（给日志与 /stats 用）。due=true 时为空 */
  reason: string;
  dayKey: number;
  triggerAt: number;
}

/**
 * 判断某用户此刻是否该生成简报。
 *
 * 只读，不改库。把"判该不该"与"做"分开的理由：调用方可能在一轮里扫
 * 几百个用户，而其中绝大多数不该跑 —— 那时不该有任何写操作。
 */
export function digestDue(
  db: DatabaseSync,
  userId: string,
  cfg: DigestConfig,
  now = Date.now(),
): DigestDue {
  const dayKey = localDayStart(now);
  const triggerAt = dueAt(now, cfg.at);

  if (!cfg.enabled) {
    return { due: false, reason: '简报已关闭', dayKey, triggerAt };
  }
  if (now < triggerAt) {
    return { due: false, reason: `未到 ${cfg.at}`, dayKey, triggerAt };
  }

  // 今天已经有简报 → 不再生成
  const done = db.prepare(
    'SELECT id FROM digests WHERE user_id = ? AND kind = ? AND day_key = ?',
  ).get(userId, cfg.kind, dayKey) as { id: string } | undefined;
  if (done) {
    return { due: false, reason: '今天已生成', dayKey, triggerAt };
  }

  // 今天已判定"没有可写的内容" → 不再生成
  const skip = db.prepare(
    'SELECT reason FROM digest_skips WHERE user_id = ? AND kind = ? AND day_key = ?',
  ).get(userId, cfg.kind, dayKey) as { reason: string } | undefined;
  if (skip) {
    return { due: false, reason: `今天已跳过：${skip.reason}`, dayKey, triggerAt };
  }

  // 今天失败过 → 按退避再试，超过上限就放弃
  const failed = db.prepare(`
    SELECT COUNT(*) c, MAX(created_at) last
      FROM digest_attempts WHERE user_id = ? AND kind = ? AND day_key = ?
  `).get(userId, cfg.kind, dayKey) as { c: number; last: number | null };

  const attempts = Number(failed.c ?? 0);
  if (attempts >= MAX_DELIVER_ATTEMPTS) {
    return { due: false, reason: `今天已尝试 ${attempts} 次仍失败`, dayKey, triggerAt };
  }
  if (attempts > 0) {
    const backoff = RETRY_BACKOFF_MIN[Math.min(attempts, RETRY_BACKOFF_MIN.length - 1)] ?? 60;
    const nextTry = Number(failed.last ?? 0) + backoff * 60_000;
    if (now < nextTry) {
      return {
        due: false,
        reason: `失败退避中，${Math.ceil((nextTry - now) / 60_000)} 分钟后重试`,
        dayKey, triggerAt,
      };
    }
  }

  return { due: true, reason: '', dayKey, triggerAt };
}

/**
 * 记录一次尝试。
 *
 * 与 digests / digest_skips 分开存：一次成功的生成也要记（这样"今天试过
 * 一次"是事实），而失败的退避依赖它。合并进 digests 会让"没有简报行"
 * 同时意味着"没试过"和"试过但失败了"。
 */
export function recordAttempt(
  db: DatabaseSync,
  userId: string,
  cfg: DigestConfig,
  dayKey: number,
  ok: boolean,
  error: string | null,
  now = Date.now(),
): void {
  db.prepare(`
    INSERT INTO digest_attempts (user_id, kind, day_key, ok, error, created_at)
    VALUES (?,?,?,?,?,?)
  `).run(userId, cfg.kind, dayKey, ok ? 1 : 0, error, now);
}

export function recordSkip(
  db: DatabaseSync,
  userId: string,
  cfg: DigestConfig,
  dayKey: number,
  reason: string,
  now = Date.now(),
): void {
  db.prepare(`
    INSERT INTO digest_skips (user_id, kind, day_key, reason, created_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, kind, day_key) DO UPDATE SET reason = excluded.reason
  `).run(userId, cfg.kind, dayKey, reason, now);
}

/** 该用户今天的简报状态（给 UI 与 /stats） */
export interface DigestStatus {
  enabled: boolean;
  at: string;
  /** none | generated | skipped | failed | pending */
  state: 'none' | 'generated' | 'skipped' | 'failed' | 'pending';
  digestId: string | null;
  skipReason: string | null;
  attempts: number;
  lastError: string | null;
  nextAt: number;
}

export function digestStatus(
  db: DatabaseSync,
  userId: string,
  cfg: DigestConfig,
  now = Date.now(),
): DigestStatus {
  const dayKey = localDayStart(now);
  const today = db.prepare(
    'SELECT id, created_at FROM digests WHERE user_id = ? AND kind = ? AND day_key = ?',
  ).get(userId, cfg.kind, dayKey) as { id: string; created_at: number } | undefined;

  const skip = db.prepare(
    'SELECT reason FROM digest_skips WHERE user_id = ? AND kind = ? AND day_key = ?',
  ).get(userId, cfg.kind, dayKey) as { reason: string } | undefined;

  const att = db.prepare(`
    SELECT COUNT(*) c, MAX(created_at) last
      FROM digest_attempts WHERE user_id = ? AND kind = ? AND day_key = ?
  `).get(userId, cfg.kind, dayKey) as { c: number; last: number | null };

  const lastErr = db.prepare(`
    SELECT error FROM digest_attempts
     WHERE user_id = ? AND kind = ? AND day_key = ?
     ORDER BY created_at DESC LIMIT 1
  `).get(userId, cfg.kind, dayKey) as { error: string | null } | undefined;

  let state: DigestStatus['state'] = 'none';
  if (today) state = 'generated';
  else if (skip) state = 'skipped';
  else if (Number(att.c ?? 0) > 0) state = 'failed';
  else if (cfg.enabled && now >= dueAt(now, cfg.at)) state = 'pending';

  // nextAt 的语义是"下一次尝试的时刻"，而不是"下一次日历上的 08:00"。
  //
  // pending 时今天 08:00 已经过了但还没跑 —— 也就是说**一分钟内的下一轮
  // sweep 就会跑**。此时报"明天 08:00"会让 UI 显示"下次：明天 08:00"，
  // 而实际上它马上就会生成，用户看到的是自相矛盾的提示。
  const todayTrigger = dueAt(now, cfg.at);
  let nextAt: number;
  if (state === 'pending') nextAt = todayTrigger;
  else if (state === 'failed') {
    const backoff = RETRY_BACKOFF_MIN[Math.min(Number(att.c ?? 0), RETRY_BACKOFF_MIN.length - 1)] ?? 60;
    nextAt = Number(att.last ?? now) + backoff * 60_000;
  } else if (now >= todayTrigger) nextAt = dueAt(now + 86400_000, cfg.at);
  else nextAt = todayTrigger;

  return {
    enabled: cfg.enabled,
    at: cfg.at,
    state,
    digestId: today?.id ?? null,
    skipReason: skip?.reason ?? null,
    attempts: Number(att.c ?? 0),
    lastError: lastErr?.error ?? null,
    nextAt,
  };
}
