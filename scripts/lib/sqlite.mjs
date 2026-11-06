// 验收脚本用的 SQLite 开库辅助。
//
// 为什么需要它：产品代码 openDb()（src/server/db/client.ts）会给连接设
// PRAGMA busy_timeout = 5000，所以服务端进程撞到别人持锁时会**等**而不是
// 立刻失败。但验收脚本为了造数据常常绕过 openDb、直接 new DatabaseSync() ——
// 裸连接的 busy_timeout 是 0，服务端刚好在提交事务时，脚本的
// `BEGIN IMMEDIATE` 会立刻抛 ERR_SQLITE_ERROR / "database is locked"。
//
// 这不是实现缺陷，是**测试环境的竞争**：本机快、撞上的窗口极窄，可能几百次
// 都碰不上；CI 的 Windows runner 慢，就撞上了。真实证据（CI 日志）：
//   PASS  服务就绪
//   Error: database is locked  at m1-07-folders.mjs:102:4
//   db.exec('BEGIN IMMEDIATE')
// 于是 m1-07 在 1.4s 内失败，看着像"服务没起来"，其实服务早就 PASS 了。
//
// 用 8000 而不是产品那边的 5000：验收脚本里常有成批插入，留点余量。
// 语义上只是"多等一会儿"，不改变任何断言可通过的条件 —— 真死锁仍会超时报错。
import { DatabaseSync } from 'node:sqlite';

const BUSY_TIMEOUT_MS = 8000;

/**
 * 打开一个验收用的 SQLite 连接（只读连接也可以设 busy_timeout，无害）。
 * @param {string} path 数据库文件路径
 * @param {{ readOnly?: boolean }} [opts]
 * @returns {DatabaseSync}
 */
export function openSqlite(path, opts) {
  const db = opts === undefined ? new DatabaseSync(path) : new DatabaseSync(path, opts);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  return db;
}

export { BUSY_TIMEOUT_MS };
