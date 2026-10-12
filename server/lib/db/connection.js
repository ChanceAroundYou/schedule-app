/**
 * connection.js —— 打开数据库、事务、SQL 辅助、迁移执行
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { SCHEMA_VERSION, MIGRATIONS, ALL_TABLES, FULL_SCHEMA } = require('./schema');

let _db = null;
let _file = null;

/**
 * 把库从 from 升到 SCHEMA_VERSION。
 *
 * 排在动手之前**先把每一级的脚本都找齐**：中间缺一级就整件事不做。
 * 走一半再抛的话，库会停在一个既不是旧版也不是新版的中间态，比不升更糟。
 *
 * 真正的执行放在一个事务里，并且 `user_version` 也在事务内改 ——
 * SQLite 的 PRAGMA user_version 是写库头的，跟着事务一起回滚。
 */
function migrateFrom(from) {
  for (let v = from; v < SCHEMA_VERSION; v += 1) {
    if (!MIGRATIONS[v]) {
      throw new Error(
        `数据库是 schema v${from}，当前代码要 v${SCHEMA_VERSION}，` +
        `但没有 v${v} → v${v + 1} 的迁移脚本。\n` +
        `拒绝自动改动，请先备份 ${_file} 再手工迁移（见 DEPLOY-运维.md 的「数据模型演进」与 docs/重构路线.md）。`,
      );
    }
  }

  _db.exec('BEGIN IMMEDIATE');
  try {
    for (let v = from; v < SCHEMA_VERSION; v += 1) {
      for (const sql of MIGRATIONS[v]) _db.exec(sql);
    }
    _db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    _db.exec('COMMIT');
  } catch (e) {
    try { _db.exec('ROLLBACK'); } catch (_) { /* 已回滚 */ }
    throw new Error(
      `升级数据库失败，已回滚到 v${from}（数据没动）：${e && e.message ? e.message : e}`,
    );
  }
}

/**
 * 打开（首次时建表）数据库。幂等。
 *
 * schema 变了怎么办，分两条路：
 *   - **空库**（一个账户都没有）：推倒重建。此时没有任何人的数据可丢。
 *   - **有数据的库**：跑 MIGRATIONS 里的追加式脚本，只加表加列。
 *     某一级没有脚本 → 仍然拒绝启动，把「要不要迁、怎么迁」交回给人。
 *
 * 原来只有第一条路：版本号一不对、库里有账户就直接 throw。v3 加了三张表，
 * 版本号必须动，所以必须给有数据的库补上第二条路 —— 否则线上库一升级就起不来。
 * 但「静默重建等于把用户数据吃掉」那条底线没变：**任何删除性的操作都不在
 * 自动路径上。**
 */
function open(dir) {
  if (_db) return _db;
  fs.mkdirSync(dir, { recursive: true });
  _file = path.join(dir, 'schedule.db');
  _db = new DatabaseSync(_file);
  try {
    return initSchema();
  } catch (e) {
    // 起不来就把句柄放掉。留着的话 _db 非空，下一次 open() 会直接返回这个
    // 半死的连接 —— 调用方以为库是好的，实际上一张表都没建。
    try { _db.close(); } catch (_) { /* 已关 */ }
    _db = null;
    throw e;
  }
}

function initSchema() {
  // WAL：读写并发不互相阻塞。NORMAL 对本项目足够——掉电最多丢最后一次事务。
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA synchronous = NORMAL');
  _db.exec('PRAGMA foreign_keys = ON');

  const found = Number(_db.prepare('PRAGMA user_version').get().user_version) || 0;
  if (found !== SCHEMA_VERSION) {
    const tables = _db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((r) => r.name);
    const hasOldData = tables.includes('users')
      && Number(_db.prepare('SELECT COUNT(*) AS n FROM users').get().n) > 0;

    if (hasOldData && found > SCHEMA_VERSION) {
      // 代码比库旧。跑了只会按旧结构去读新表，读出来的东西是错的，不如不跑。
      throw new Error(
        `数据库是 schema v${found}，比当前代码的 v${SCHEMA_VERSION} 还新。\n` +
        `说明这份代码比库旧，请先更新代码（库文件没动）。`,
      );
    }

    if (hasOldData) {
      migrateFrom(found);
    } else {
      // 空库：直接推倒重建。以前留下的表结构不兼容，留着反而是隐患
      _db.exec('PRAGMA foreign_keys = OFF');
      for (const t of ALL_TABLES) _db.exec(`DROP TABLE IF EXISTS ${t}`);
      _db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /**
   * 最后无条件再跑一遍建表语句。
   *
   * ⚠️ 它会把迁移里**忘了建**的表补上，也会把迁移里**误删**的表**用一个空壳
   * 重建回来** —— 表名看着一切正常，里面的行已经没了。所以「迁移有没有删东西」
   * 光看表名是看不出来的，`migration.test.js` 比的是**行数**。
   * 这是上一版就有的兜底，别当成迁移正确性的证明。
   */
  _db.exec(FULL_SCHEMA);
  _db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return _db;
}

function handle() {
  if (!_db) throw new Error('db.open(dir) 未调用');
  return _db;
}

/** 单事务包裹。回调抛错则整体回滚。 */
function tx(fn) {
  const db = handle();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 已回滚 */ }
    throw e;
  }
}

/** run() 的返回值在不同 Node 小版本里可能是 number 也可能是 bigint，统一掉 */
function run(sql, ...args) {
  const r = handle().prepare(sql).run(...args);
  return Number(r.changes);
}

function get(sql, ...args) {
  return handle().prepare(sql).get(...args) || null;
}

function all(sql, ...args) {
  return handle().prepare(sql).all(...args);
}

function file() { return _file; }

function close() {
  if (_db) { try { _db.close(); } catch (_) { /* 已关闭 */ } _db = null; }
}

module.exports = { open, close, file, handle, tx, run, get, all };
