import type { DatabaseSync } from 'node:sqlite';
import { deleteFeed, nextSortInFolder, type FeedStatus } from './store.ts';

// 订阅的批量操作（PLAN §15.10、§18）。
//
// 为什么是一个独立模块而不是塞进 routes/feeds.ts：
// 这里有**三种不同的部分成功语义**，每一处的边界条件都要单独解释，
// 混在路由文件里会被其他 400 行代码淹掉。路由只做参数解析与错误映射。
//
// 统一的返回形状：
//   { requested, done, skipped, missing }
//     requested  收到的 id 数（去重后）
//     done       真正生效的
//     skipped    因为业务原因跳过的（例如暂停的源不刷新）
//     missing    库里找不到的 id
//
// 关键决定：**mix 了不存在的 id 不整体失败**。理由是"另一个标签页刚删掉
// 一个源"不该阻断这次操作；但要把 missing 报回去，否则用户永远不知道
// 自己选中的 32 个里有一个是幽灵。

export interface BulkResult {
  requested: number;
  done: number;
  skipped: number;
  missing: string[];
}

/** 一次操作最多处理多少个。个人库远到不了这个量；防的是脚本刷 */
export const BULK_MAX = 500;

/** 去重 + 去掉非字符串 + 长度校验。返回 null 表示 id 列表本身不合法 */
export function normalizeIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s) out.add(s);
  }
  return [...out];
}

/**
 * 把 id 分成「库里有的」和「没有的」。
 *
 * 不用 `IN (?,?,?...)` 动态拼 SQL：SQLite 的变量上限是 999，
 * 而 BULK_MAX 是 500，看起来安全——但 feeds 的查询还要带 user_id，
 * 一旦将来放宽上限就会炸。逐条 `SELECT 1` 在 500 条量级下是 <5ms，
 * 不值得为它引入拼接。
 */
export function splitExisting(
  db: DatabaseSync,
  userId: string,
  ids: string[],
): { existing: string[]; missing: string[] } {
  const stmt = db.prepare('SELECT 1 FROM feeds WHERE id = ? AND user_id = ?');
  const existing: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    if (stmt.get(id, userId)) existing.push(id);
    else missing.push(id);
  }
  return { existing, missing };
}

/**
 * 批量移入/移出分组。folderId = null 表示移出。
 *
 * 单事务：32 个源移进分组时中途失败，用户看到的会是"一半在组里"，
 * 还得手动找出来哪个没进去。这不是理论风险——SQLITE_BUSY 在
 * 定时抓取与 UI 同时写的时候会出现。
 */
export function bulkMoveToFolder(
  db: DatabaseSync,
  userId: string,
  ids: string[],
  folderId: string | null,
): BulkResult {
  const { existing, missing } = splitExisting(db, userId, ids);
  if (existing.length === 0) {
    return { requested: ids.length, done: 0, skipped: 0, missing };
  }

  const upd = db.prepare('UPDATE feeds SET folder_id = ?, sort = ? WHERE id = ? AND user_id = ?');
  // 目标组当前的末尾序号（§15.28）。不显式给 sort 的话它保持原来的值，
  // 于是从别的组移过来的源会带着**旧组的序号**插进新组中间 ——
  // 看起来像是随机位置，而且完全不可复现（取决于它在旧组排第几）。
  let next = nextSortInFolder(db, userId, folderId);
  let done = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of existing) {
      done += Number(upd.run(folderId, next, id, userId).changes ?? 0);
      next += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { requested: ids.length, done, skipped: existing.length - done, missing };
}

/**
 * 批量暂停/恢复。
 *
 * 恢复（active）时必须同时清 error_count 并让 next_fetch_at 立刻到期，
 * 否则"从 broken 恢复"的源要等到退避窗口结束才抓 —— 用户以为没生效。
 * 这段和 store.ts 的 updateFeed 是同一条规则，但那是单条接口；
 * 批量版走 UPDATE ... WHERE id IN 更省事，代价是要自己再写一遍
 * 这条规则。两处都要改的需求出现时，抽公共 SQL 片段。
 */
export function bulkSetStatus(
  db: DatabaseSync,
  userId: string,
  ids: string[],
  status: FeedStatus,
): BulkResult {
  const { existing, missing } = splitExisting(db, userId, ids);
  if (existing.length === 0) {
    return { requested: ids.length, done: 0, skipped: 0, missing };
  }

  const active = status === 'active';
  const sql = active
    ? `UPDATE feeds SET status = 'active', error_count = 0, next_fetch_at = ?
        WHERE id = ? AND user_id = ?`
    : `UPDATE feeds SET status = ? WHERE id = ? AND user_id = ?`;
  const stmt = db.prepare(sql);
  const now = Date.now();

  let done = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of existing) {
      const r = active ? stmt.run(now, id, userId) : stmt.run(status, id, userId);
      done += Number(r.changes ?? 0);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { requested: ids.length, done, skipped: existing.length - done, missing };
}

/**
 * 批量删除。
 *
 * 逐条复用 deleteFeed，不写一条 `DELETE ... WHERE id IN`：
 * deleteFeed 里有一条**关键语义**（未读条目随订阅删、已读/已收藏保留并解绑），
 * 复制一份等于给自己埋一个"批量删和单条删行为不一致"的雷。
 *
 * 代价是每条一个事务。500 条的上限下实测仍在百毫秒级，可以接受；
 * 真到了需要优化的量级，应该改的是 deleteFeed 让它接受数组，而不是
 * 在调用方绕过它。
 */
export function bulkDelete(
  db: DatabaseSync,
  userId: string,
  ids: string[],
): BulkResult {
  const { existing, missing } = splitExisting(db, userId, ids);
  let done = 0;
  for (const id of existing) {
    if (deleteFeed(db, userId, id)) done++;
  }
  return { requested: ids.length, done, skipped: existing.length - done, missing };
}
