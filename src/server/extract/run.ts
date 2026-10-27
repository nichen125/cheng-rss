import type { DatabaseSync } from 'node:sqlite';
import { extractForEntry, estimateWordCount, type ExtractFailure } from './article.ts';
import { packText, unpackText } from '../db/text-blob.ts';

// 提取任务的执行体（PLAN §7.5）。
//
// 与 extract/article.ts 分开的理由与 feeds 那层一致：
//   article.ts 只回答"这页能提出多少正文"（纯函数，验收脚本直接调）
//   这里回答"该怎么写库、失败了怎么记"（要 DB）
// 混在一起，验收脚本为了测比值就得先造一个库。

export interface ExtractRunResult {
  ok: boolean;
  /** 是否用原文替换了 feed 正文 */
  replaced: boolean;
  /** 已有更优结果而跳过（重复入队的正常路径，不是错误） */
  skipped: boolean;
  failure: ExtractFailure | null;
  note: string;
}

/**
 * 提取一个条目并落库。
 *
 * 幂等来自两处：
 *   · 已经由 readability 替换过 → 直接返回 skipped，不再打网络
 *   · stage 推进用 stage='pending' 条件，重复执行不会重复写
 * 第二条不能省：重复入队时第一条能挡住，但两条任务同时在飞时只有
 * "条件 UPDATE" 能保证第二个不覆盖第一个的结果。
 */
export async function runExtract(db: DatabaseSync, entryId: string): Promise<ExtractRunResult> {
  const row = db.prepare(`
    SELECT e.id, e.url, e.stage, c.html AS content_html, c.extracted_by
      FROM entries e
      LEFT JOIN entry_contents c ON c.entry_id = e.id
     WHERE e.id = ?
  `).get(entryId) as {
    id: string; url: string; stage: string;
    content_html: Uint8Array | null; extracted_by: string | null;
  } | undefined;

  if (!row) {
    // 条目已被删除：任务作废，不是失败。抛错会白白退避重试。
    return { ok: true, replaced: false, skipped: true, failure: null, note: '条目不存在' };
  }

  if (row.extracted_by === 'readability') {
    return { ok: true, replaced: true, skipped: true, failure: null, note: '已有原文正文' };
  }

  const feedHtml = unpackText(row.content_html);
  const outcome = await extractForEntry({ url: row.url, feedHtml });

  db.exec('BEGIN IMMEDIATE');
  try {
    if (outcome.replaced && outcome.html) {
      db.prepare(
        `INSERT INTO entry_contents (entry_id, html, extracted_by) VALUES (?,?,?)
         ON CONFLICT(entry_id) DO UPDATE SET html = excluded.html, extracted_by = excluded.extracted_by`,
      ).run(entryId, packText(outcome.html), 'readability');
      db.prepare(`
        UPDATE entries SET stage = 'extracted', stage_error = NULL,
                           word_count = COALESCE(?, word_count)
         WHERE id = ? AND stage = 'pending'
      `).run(estimateWordCount(outcome.html), entryId);
    } else {
      // 失败不丢条目：正文保持 feed 原样，只把原因记下来。
      // 用 stage_error 而不是抛错，是因为重试 3 次也不会让 404 变成 200，
      // 而 extract 只有 4 个并发槽位（PLAN §5.1）。
      const reason = outcome.failure === 'feed-enough' ? null : `${outcome.failure}: ${outcome.note}`;
      db.prepare(`
        UPDATE entries SET stage = 'extracted', stage_error = COALESCE(?, stage_error)
         WHERE id = ? AND stage = 'pending'
      `).run(reason, entryId);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    ok: true,
    replaced: outcome.replaced,
    skipped: false,
    failure: outcome.failure,
    note: outcome.note,
  };
}
