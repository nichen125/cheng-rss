import type { DatabaseSync } from 'node:sqlite';
import { enqueue } from '../jobs/queue.ts';

// 补录孤儿分析任务（PLAN §5.7 P2，2.6）。
//
// 与 extract 的 backfill（§7.5）是同一个形状，但起因不同：
//
//   提取的孤儿来自"stage='pending' 但 jobs 里没有任务"。
//   分析的孤儿来自**没配 key 的那段时间**：`runAnalyze` 遇到 `no-key`
//   时刻意**不改 stage**（§8.6：全局配置问题不该把 745 篇打成 failed），
//   而 handler 又把它当 terminal 吃掉不重试 —— 于是那些条目的 analyze 任务
//   变成 done，库里没有任何 entry_analysis 行，条目停在 extracted，
//   而且**再也没有任何东西会把它重新排队**。
//
// 实测（2026-10-30，本机库）：745 条 extracted 条目，4 条有分析结果
// （且那 4 条是 seed 造的），129 条 analyze 任务的状态是 done 但没有分析行。
// 也就是说"填上 key"这一个动作，不会让任何东西开始跑。
//
// 判据刻意选「没有分析结果 且 没有在飞任务」，不是「任务状态是 done」：
// 后者只能修这一种成因，前者在将来任何一条新写入路径漏入队时仍然成立 ——
// 这与 extract/backfill.ts 里那条注释是同一个理由。

/** 一轮最多排多少个。与 extract 一致：分多轮，不一次打满队列 */
export const ANALYZE_BACKFILL_BATCH = 200;

/**
 * 孤儿条目的判据。导出给验收脚本直接数，避免脚本另抄一份条件。
 *
 * 排除 `stage='failed'`：那是"这篇内容有问题，判过死刑"，不该由定时器
 * 反复顶上去。排除 `noise` 档位属于将来的优化（P7），这里先不筛 ——
 * 筛错档位会让本应分析的条目永远不分析，而多分析一篇只是几分钱。
 */
export const ORPHAN_ANALYZE_WHERE = `
  e.stage IN ('fetched', 'extracted')
  AND NOT EXISTS (
    SELECT 1 FROM entry_analysis a WHERE a.entry_id = e.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
     WHERE j.kind = 'analyze'
       AND j.dedupe_key = 'analyze:' || e.id
       AND j.status IN ('pending', 'running')
  )
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
     WHERE j.kind = 'analyze'
       AND j.dedupe_key = 'analyze:' || e.id
       AND j.status = 'dead'
  )
`;

/** 还没被任何在飞任务认领的条目 id（新的在前） */
export function orphanAnalyzeIds(db: DatabaseSync, limit = ANALYZE_BACKFILL_BATCH): string[] {
  return (db.prepare(`
    SELECT e.id FROM entries e WHERE ${ORPHAN_ANALYZE_WHERE}
     ORDER BY e.fetched_at DESC LIMIT ?
  `).all(limit) as { id: string }[]).map((r) => r.id);
}

/** 孤儿总数，供启动横幅与 doctor 报告"还剩多少没收敛" */
export function countOrphanAnalyze(db: DatabaseSync): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM entries e WHERE ${ORPHAN_ANALYZE_WHERE}`,
  ).get() as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

/**
 * 把孤儿条目排进分析队列，返回本轮真正排入的条数。
 *
 * 幂等由 dedupe_key 兜底：同一篇的 `analyze:<id>` 只会在 pending/running
 * 状态下存在一条。所以在定时器里反复跑不需要记"上次补到哪了"。
 */
export function enqueueOrphanAnalyze(db: DatabaseSync, limit = ANALYZE_BACKFILL_BATCH): number {
  const ids = orphanAnalyzeIds(db, limit);
  let queued = 0;
  for (const id of ids) {
    if (enqueue(db, { kind: 'analyze', payload: { entryId: id }, dedupeKey: `analyze:${id}` }) !== null) {
      queued++;
    }
  }
  return queued;
}

/**
 * 复位「AI 侧」的失败条目，让它们重新可被 backfill 认领（v2.7，§8.10）。
 *
 * 起因：v2.7 修好了投递方式与降级链，但那些已经判死（`stage='failed'`）的
 * 315 条不会自己消失 —— 而 `ORPHAN_ANALYZE_WHERE` 明确排除 `failed`。
 * 所以修完代码若不复位，用户会看到"修好了但一条都没开始跑"。
 *
 * ## 只复位 AI 侧的
 *
 *   schema / bad-json / empty / reasoning-only / upstream-quota /
 *   timeout / network / http-*                        → 复位
 *   fetch-failed（正文抓取失败）、no-improvement（提取质量不足）→ **不动**
 *
 * 后者与模型无关，复位只会把抓取失败的 URL 再抓一遍、把本来就太短的正文
 * 再解析一遍，白花时间。
 *
 * `timeout` 与 `network` 也是 AI 侧失败：它们出现在 `runAnalyze` 的
 * `stage_error` 里意味着"这个网关当时没答上来/连不上"，同样是修好之后
 * 该重跑的那批。第一版漏了这两个前缀，于是超时的条目永远复位不了 ——
 * 而超时恰恰是慢网关最典型的表现（实测 ai_usage 里有 7 条 timeout）。
 *
 * ## 顺手清 dead 任务
 *
 * `ORPHAN_ANALYZE_WHERE` 同样排除 `status='dead'` 的 analyze 任务（那是
 * 重试到上限的）。`http-503` 这种可重试的失败会一路重试到 dead —— 于是
 * "复位了 stage 但入队 0 条"，按钮说 N 条而实际什么也没发生。
 * 而这批数据恰恰是本期最需要修的那批。
 */
export function resetAiFailures(db: DatabaseSync, userId: string): {
  reset: number; clearedDeadJobs: number;
} {
  const AI_FAILURE_PREFIXES = [
    'schema:', 'bad-json:', 'empty:', 'reasoning-only:',
    // 上游额度/账号用尽（classifyHttpFailure 归的类）：换 key 或充值后该重跑
    'upstream-quota:',
    // 传输层的两类：超时与连不上。它们同样是"这会儿网关不行"，不是文章的问题
    'timeout:', 'network:',
    'http-',
  ];
  const where = AI_FAILURE_PREFIXES.map(() => 'stage_error LIKE ?').join(' OR ');

  // 先取出要复位的 id：清 dead 任务需要按 id 精确删，不能用同一条件再删一次
  // （那时的 stage 已经变了，条件不再成立）
  const ids = (db.prepare(`
    SELECT id FROM entries
     WHERE user_id = ? AND stage = 'failed' AND (${where})
  `).all(userId, ...AI_FAILURE_PREFIXES.map((p) => `${p}%`)) as { id: string }[]).map((r) => r.id);

  if (ids.length === 0) return { reset: 0, clearedDeadJobs: 0 };

  let reset = 0;
  let clearedDeadJobs = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const upd = db.prepare(`
      UPDATE entries SET stage = 'extracted', stage_error = NULL
       WHERE id = ? AND stage = 'failed'
    `);
    for (const id of ids) reset += Number(upd.run(id).changes ?? 0);

    const del = db.prepare(`
      DELETE FROM jobs WHERE kind = 'analyze' AND status = 'dead' AND dedupe_key = ?
    `);
    for (const id of ids) clearedDeadJobs += Number(del.run(`analyze:${id}`).changes ?? 0);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { reset, clearedDeadJobs };
}
