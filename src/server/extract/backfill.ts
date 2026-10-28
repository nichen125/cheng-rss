import type { DatabaseSync } from 'node:sqlite';
import { enqueue } from '../jobs/queue.ts';

// 补录孤儿提取任务（PLAN §7.5，v1.17 修订）。
//
// 问题：`entries.stage = 'pending'` 的语义是"等提取"，但"等提取"的唯一
// 实现是 jobs 表里有一条 extract 任务。这两者在历史上脱钩过一次 ——
// 1.14 之前的 upsertItems 把 stage 硬编码成 'pending'，而那时还没有
// 提取任务这种东西。功能上线之后只有**新抓到的**条目会入队，升级不会
// 回头认领旧条目，于是那批条目永远停在 pending：列表里看得见，正文只有
// feed 给的几十个字，队列里根本没有它的活。
//
// 实测就是这个形状：514 条 pending，0 条有任务，全部 fetched_at 早于
// 提取功能那天的提交。
//
// 判据刻意选「pending 且没有在飞的任务」，而不是「某次升级之前入库的」：
// 后者只能修一次，前者在将来任何一条新写入路径漏入队时仍然成立。
// 这也是"修根因而不是修现象"—— 数据已经错了，代码要能自己收敛回来。

/** 一轮补录最多排多少个。超过这个数就分多轮，不一次性把队列打满 */
export const BACKFILL_BATCH = 200;

/**
 * 孤儿条目的判据。导出给验收脚本直接数，避免脚本另抄一份条件
 * （抄一份就会在改判据时悄悄失配，而脚本仍然绿）。
 *
 * 为什么要排除 `status = 'dead'`：补录是每小时跑一轮的常驻兜底，
 * 一条**真的试过三次都失败**的条目如果不排除，就会被每小时重新排队、
 * 再失败三次、再排队 —— 变成一个永不停止的抓取循环。dead 的含义
 * 就是"这个条目的提取已经判过死刑"，该由人来处理，不该由定时器硬顶。
 */
export const ORPHAN_WHERE = `
  e.stage = 'pending'
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
     WHERE j.kind = 'extract'
       AND j.dedupe_key = 'extract:' || e.id
       AND j.status IN ('pending','running')
  )
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
     WHERE j.kind = 'extract'
       AND j.dedupe_key = 'extract:' || e.id
       AND j.status = 'dead'
  )
`;

/** 还没被任何在飞任务认领的 pending 条目 id（新的在前） */
export function orphanPendingIds(db: DatabaseSync, limit = BACKFILL_BATCH): string[] {
  return (db.prepare(`
    SELECT e.id FROM entries e WHERE ${ORPHAN_WHERE}
     ORDER BY e.fetched_at DESC LIMIT ?
  `).all(limit) as { id: string }[]).map((r) => r.id);
}

/** 孤儿 pending 条目的总数，供日志与 doctor 报告"还剩多少没收敛" */
export function countOrphanPending(db: DatabaseSync): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM entries e WHERE ${ORPHAN_WHERE}`,
  ).get() as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

/**
 * 把孤儿条目排进提取队列，返回本轮真正排入的条数。
 *
 * 幂等由 enqueue 的 dedupe_key 兜底：同一篇的 `extract:<id>` 只会在
 * pending/running 状态下存在一条。所以这个函数可以在定时器里反复跑，
 * 不需要自己记"上次补到哪了"。
 *
 * 返回条数可能小于 ids 长度（并发下另一路已经排过），这不是错误。
 */
export function enqueueOrphanExtracts(db: DatabaseSync, limit = BACKFILL_BATCH): number {
  const ids = orphanPendingIds(db, limit);
  let queued = 0;
  for (const id of ids) {
    if (enqueue(db, { kind: 'extract', payload: { entryId: id }, dedupeKey: `extract:${id}` }) !== null) {
      queued++;
    }
  }
  return queued;
}
