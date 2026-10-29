import type { DatabaseSync } from 'node:sqlite';

// 扫"谁该出简报"时用的最简用户清单。
//
// 为什么不做成"取全部 users"：单用户部署下结果一样，但多用户部署里
// 每个用户每分钟都要过一次 digestDue（三条索引查询）。把"简报关掉"的
// 用户在 SQL 里就滤掉，每分钟的查询成本从 O(用户数×3) 降到 O(该出的用户数)。
// NAS 上的低功耗设备对"每分钟几百次查询"是敏感的。
//
// 只读，不含鉴权字段 —— 这个函数不接受外部输入，也不会被路由直接调用。
export interface DigestUserRow {
  userId: string;
  /** 解析失败的配置返回 null，调用方按默认配置处理 */
  config: unknown;
}

export function listUsersForDigest(db: DatabaseSync): DigestUserRow[] {
  // json_extract 遇到坏 JSON 会**抛异常**（SQLite 的 JSON1 不开容错模式），
  // 而一条坏的 digest_config 不该让整个调度扫描停摆 —— 那是一个用户写坏了
  // 配置，结果是所有用户（包括他自己）从此再没有简报，且日志里只有一句
  // "malformed JSON" 指向不了是谁。
  //
  // 所以先用 CASE + json_valid 把坏行挡在过滤条件之外，让它在下面被当成
  // "配置解析失败 → 按默认（开启）处理"。宁可让写坏配置的用户继续收到默认
  // 简报，也不要让他静默失去这个功能。
  const rows = db.prepare(`
    SELECT u.id, s.digest_config
      FROM users u
      LEFT JOIN settings s ON s.user_id = u.id
     WHERE s.digest_config IS NULL
        OR json_valid(s.digest_config) = 0
        OR COALESCE(json_extract(s.digest_config, '$.enabled'), 1) = 1
  `).all() as { id: string; digest_config: string | null }[];

  return rows.map((r) => {
    let config: unknown = null;
    if (r.digest_config) {
      try { config = JSON.parse(r.digest_config); } catch { config = null; }
    }
    return { userId: r.id, config };
  });
}
