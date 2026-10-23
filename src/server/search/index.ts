import type { DatabaseSync } from 'node:sqlite';
import { toIndexText, toMatchQuery } from './bigram.ts';

// 全文检索。
//
// 索引维护方式：entries_fts 用 content='' （contentless），
// 由程序显式写入。rowid 与 entries.rowid 无关 —— 因此需要
// entry_fts_map 记录 entry_id ↔ fts_rowid 的映射。
//
// 为什么不用 external content 表：外部内容表要求 FTS 表与源表
// 共享 rowid，而 entries.id 是 TEXT 主键（无 rowid 语义），
// 且摘要来自 entry_analysis 另一张表，本来就需要 JOIN。

export interface SearchHit {
  entryId: string;
  score: number;
}

/** 单条索引写入（插入或替换） */
export function indexEntry(
  db: DatabaseSync,
  entryId: string,
  fields: { title?: string | null; summary?: string | null },
): void {
  const text = toIndexText(fields.title, fields.summary);
  // contentless FTS5 不能 UPDATE，只能 delete + insert
  const existing = db.prepare('SELECT fts_rowid FROM entry_fts_map WHERE entry_id = ?')
    .get(entryId) as { fts_rowid: number } | undefined;

  if (existing) {
    db.prepare('DELETE FROM entries_fts WHERE rowid = ?').run(existing.fts_rowid);
  }

  const r = db.prepare('INSERT INTO entries_fts (title) VALUES (?)').run(text);
  const rowid = Number(r.lastInsertRowid);

  if (existing) {
    db.prepare('UPDATE entry_fts_map SET fts_rowid = ? WHERE entry_id = ?').run(rowid, entryId);
  } else {
    db.prepare('INSERT INTO entry_fts_map (entry_id, fts_rowid) VALUES (?, ?)')
      .run(entryId, rowid);
  }
}

export function removeIndex(db: DatabaseSync, entryId: string): void {
  const existing = db.prepare('SELECT fts_rowid FROM entry_fts_map WHERE entry_id = ?')
    .get(entryId) as { fts_rowid: number } | undefined;
  if (!existing) return;
  db.prepare('DELETE FROM entries_fts WHERE rowid = ?').run(existing.fts_rowid);
  db.prepare('DELETE FROM entry_fts_map WHERE entry_id = ?').run(entryId);
}

/**
 * 关键词检索。
 *
 * 解析 dist 极低（0.01~0.1ms），因为 FTS5 走倒排索引，
 * 不需要扫表。这是 0.7 要保住的核心性能特征。
 */
export function searchKeyword(
  db: DatabaseSync,
  userId: string,
  query: string,
  limit = 30,
): SearchHit[] {
  const match = toMatchQuery(query);
  if (!match) return [];

  try {
    const rows = db.prepare(`
      SELECT m.entry_id AS entryId, bm25(entries_fts) AS score
        FROM entries_fts f
        JOIN entry_fts_map m ON m.fts_rowid = f.rowid
        JOIN entries e ON e.id = m.entry_id
       WHERE entries_fts MATCH ? AND e.user_id = ?
       ORDER BY score
       LIMIT ?
    `).all(match, userId, limit) as { entryId: string; score: number }[];
    // bm25 越小越相关，翻成越大越相关便于排序
    return rows.map((r) => ({ entryId: r.entryId, score: -Number(r.score) }));
  } catch {
    // MATCH 表达式非法（如全是标点）会抛错，视为无结果
    return [];
  }
}

/**
 * LIKE 兜底。只在 FTS 无结果时用 —— 例如用户输入了
 * 分词器不认识的符号组合。
 */
export function searchLike(
  db: DatabaseSync,
  userId: string,
  query: string,
  limit = 30,
): SearchHit[] {
  const pattern = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const rows = db.prepare(`
    SELECT e.id AS entryId
      FROM entries e
     WHERE e.user_id = ? AND (e.title LIKE ? ESCAPE '\\' OR e.excerpt LIKE ? ESCAPE '\\')
     ORDER BY e.published_at DESC
     LIMIT ?
  `).all(userId, pattern, pattern, limit) as { entryId: string }[];
  return rows.map((r) => ({ entryId: r.entryId, score: 0 }));
}

/**
 * RRF 融合（Reciprocal Rank Fusion）。
 * 用于把关键词与后续的语义检索结果合并，无需调分数尺度。
 */
export function fuseRRF(
  lists: { hits: SearchHit[]; weight?: number }[],
  k = 60,
): SearchHit[] {
  const acc = new Map<string, number>();
  for (const { hits, weight = 1 } of lists) {
    hits.forEach((h, i) => {
      acc.set(h.entryId, (acc.get(h.entryId) ?? 0) + weight / (k + i + 1));
    });
  }
  return [...acc.entries()]
    .map(([entryId, score]) => ({ entryId, score }))
    .sort((a, b) => b.score - a.score);
}

/** 重建全部索引（迁移后或索引损坏时用） */
export function rebuildIndex(db: DatabaseSync): { indexed: number } {
  db.exec('DELETE FROM entries_fts');
  db.exec('DELETE FROM entry_fts_map');
  const rows = db.prepare(`
    SELECT e.id, e.title, a.summary
      FROM entries e
      LEFT JOIN entry_analysis a ON a.entry_id = e.id
  `).all() as { id: string; title: string | null; summary: string | null }[];

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) indexEntry(db, r.id, { title: r.title, summary: r.summary });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { indexed: rows.length };
}
