import type { DatabaseSync } from 'node:sqlite';

// 订阅分组（folders 表）。
//
// 为什么单独一个文件：分组的读写被三处用到 —— 订阅 CRUD、OPML 导入、
// 条目列表按组过滤。散在路由里会出现「导入时建的组和手动建的组名字
// 不同」这类不一致。
//
// 设计取舍：分组是**一层扁平结构**，不做嵌套。
//   · PLAN §6.2 的 folders 表本身就没有 parent_id（categories 才有）
//   · OPML 虽然允许嵌套 outline，但导入时把层级拍平成
//     "父/子" 这样的名字，用户仍然能看出从属关系
// 理由：几十个源用一层分组足够；嵌套 TOC 是给上百个源的 Power User
// 准备的，会显著增加拖拽与删除的边界情况。

export interface FolderRow {
  id: string;
  user_id: string;
  name: string;
  sort: number;
}

export interface FolderWithCount extends FolderRow {
  feedCount: number;
  unread: number;
}

/** 名称长度上限。长到 40 字的分组名在侧栏里已经看不出区别了 */
const MAX_NAME = 40;

export function listFolders(db: DatabaseSync, userId: string): FolderWithCount[] {
  // 未读数排除重复条目 —— 与 feeds/store.ts 的 listFeeds、entries 路由
  // 保持同一口径。三处若不一致，侧栏角标会大于列表里真正能看到的条目数。
  const rows = db.prepare(`
    SELECT f.*,
           (SELECT COUNT(*) FROM feeds WHERE folder_id = f.id) AS feed_count,
           (SELECT COUNT(*) FROM entries e
              JOIN feeds fd ON fd.id = e.feed_id
             WHERE fd.folder_id = f.id AND e.is_read = 0 AND e.duplicate_of IS NULL) AS unread
      FROM folders f
     WHERE f.user_id = ?
     ORDER BY f.sort, f.name
  `).all(userId) as unknown as {
    id: string; user_id: string; name: string; sort: number;
    feed_count: number; unread: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    name: r.name,
    sort: Number(r.sort),
    feedCount: Number(r.feed_count),
    unread: Number(r.unread),
  }));
}

export function getFolder(db: DatabaseSync, userId: string, id: string): FolderRow | null {
  return (db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?')
    .get(id, userId) as unknown as FolderRow | undefined) ?? null;
}

/** 按名称查（大小写不敏感），OPML 导入时用来复用已有分组 */
export function findFolderByName(db: DatabaseSync, userId: string, name: string): FolderRow | null {
  return (db.prepare(
    'SELECT * FROM folders WHERE user_id = ? AND lower(name) = lower(?)',
  ).get(userId, name.trim()) as unknown as FolderRow | undefined) ?? null;
}

export function normalizeFolderName(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.slice(0, MAX_NAME);
}

export class FolderError extends Error {
  readonly code: 'BAD_NAME' | 'DUPLICATE' | 'NOT_FOUND';
  constructor(code: 'BAD_NAME' | 'DUPLICATE' | 'NOT_FOUND', message: string) {
    super(message);
    this.name = 'FolderError';
    this.code = code;
  }
}

/**
 * 新建分组。
 *
 * 重名拒绝而不是自动改名：用户重复建同名分组时，多半是忘了已经建过，
 * 静默建两个同名分组会让「把这个源放进『科技』」变成有歧义的操作。
 */
export function createFolder(
  db: DatabaseSync,
  userId: string,
  nameRaw: string,
): FolderRow {
  const name = normalizeFolderName(nameRaw);
  if (!name) throw new FolderError('BAD_NAME', '分组名不能为空');
  if (findFolderByName(db, userId, name)) {
    throw new FolderError('DUPLICATE', `已经有一个叫「${name}」的分组了`);
  }

  const id = `fo_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const nextSort = db.prepare(
    'SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM folders WHERE user_id = ?',
  ).get(userId) as { s: number };

  db.prepare('INSERT INTO folders (id, user_id, name, sort) VALUES (?,?,?,?)')
    .run(id, userId, name, Number(nextSort.s));

  return getFolder(db, userId, id)!;
}

export function renameFolder(
  db: DatabaseSync,
  userId: string,
  id: string,
  nameRaw: string,
): FolderRow {
  const cur = getFolder(db, userId, id);
  if (!cur) throw new FolderError('NOT_FOUND', '分组不存在');

  const name = normalizeFolderName(nameRaw);
  if (!name) throw new FolderError('BAD_NAME', '分组名不能为空');

  const dup = findFolderByName(db, userId, name);
  if (dup && dup.id !== id) {
    throw new FolderError('DUPLICATE', `已经有一个叫「${name}」的分组了`);
  }

  db.prepare('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?')
    .run(name, id, userId);
  return getFolder(db, userId, id)!;
}

/**
 * 删除分组。
 *
 * feeds.folder_id 是 ON DELETE SET NULL，所以源会退回「未分组」，
 * **不会**被一起删掉。这是刻意的：删分组是最容易被误触的操作，
 * 让它连带删掉 20 个订阅是灾难。
 */
export function deleteFolder(db: DatabaseSync, userId: string, id: string): boolean {
  const cur = getFolder(db, userId, id);
  if (!cur) return false;
  db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(id, userId);
  return true;
}

/** 批量把订阅放进某个分组（folderId=null 表示移出分组） */
export function assignFeedsToFolder(
  db: DatabaseSync,
  userId: string,
  feedIds: string[],
  folderId: string | null,
): number {
  if (folderId !== null && !getFolder(db, userId, folderId)) {
    throw new FolderError('NOT_FOUND', '分组不存在');
  }
  if (feedIds.length === 0) return 0;

  const upd = db.prepare(
    'UPDATE feeds SET folder_id = ? WHERE id = ? AND user_id = ?',
  );
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const fid of feedIds) {
      const r = upd.run(folderId, fid, userId);
      n += Number(r.changes ?? 0);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

/** 分组名 → id，不存在就建。OPML 导入用。 */
export function ensureFolder(
  db: DatabaseSync,
  userId: string,
  nameRaw: string | null | undefined,
): string | null {
  const name = normalizeFolderName(nameRaw);
  if (!name) return null;
  const existing = findFolderByName(db, userId, name);
  if (existing) return existing.id;
  try {
    return createFolder(db, userId, name).id;
  } catch (e) {
    // 并发建同名分组时可能撞上唯一约束之外的情况，重查一次
    if (e instanceof FolderError && e.code === 'DUPLICATE') {
      return findFolderByName(db, userId, name)?.id ?? null;
    }
    throw e;
  }
}

/** 给 OPML 导出用：feed_id → 分组名 */
export function folderNameMap(db: DatabaseSync, userId: string): Map<string, string> {
  const rows = db.prepare(
    'SELECT id, name FROM folders WHERE user_id = ?',
  ).all(userId) as unknown as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}
