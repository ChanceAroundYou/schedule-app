/**
 * db.js —— SQLite 存储层（node:sqlite，零外部依赖）
 *
 * 存的是**逐字段状态**，不是整份文档。原因：两台设备同时改同一条任务的不同
 * 字段（手机改标题、桌面改日期）时，只有真正冲突的那个字段需要决出胜负。
 * 整条任务存一坨的话，后写的那次会把对方那个字段一起抹掉。
 *
 * 六张表：
 *   users             账户。平等多用户，没有管理员
 *   calendars         日程集 —— 数据的归属单位，相当于共享相册
 *   calendar_members  谁能看见哪个集、以什么身份（权限的**唯一**真相）
 *   invites           邀请。对方接受之后才写进 calendar_members
 *   field_state       当前值 + 每个字段各自的最后写入者 —— 同步的核心
 *   changes           追加流水，客户端按 seq 游标拉增量
 *   revoked           已登出的 jti，避免「登出后旧 token 还能用」
 *
 * **数据的归属是日程集，不是人。** 所以 field_state 与 changes 的键都是
 * cal_id —— 一个集里的所有人看到的是同一份数据，不是各存一份再互相同步。
 * 权限判断只查 calendar_members 一张表，不在别的表里冗余角色。
 *
 * 没有 oplog 表做幂等：LWW 本身幂等。同一条 op 重放时 ts 与 device_id 完全
 * 相同，ON CONFLICT 的 WHERE 不成立 → 一行都不改 → 天然不重复。
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

let _db = null;
let _file = null;

/** 当前 schema 版本，存在 PRAGMA user_version 里。加表 / 改列就 +1 */
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  salt       TEXT    NOT NULL,
  hash       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS calendars (
  id         TEXT PRIMARY KEY,
  name       TEXT    NOT NULL,
  owner_id   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  -- 软删：集被删时置位。成员关系一起清掉，field_state 留着（万一要捞回来）
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS calendar_members (
  cal_id    TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
  -- owner | editor | viewer —— 权限的唯一定义处
  role      TEXT    NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (cal_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,
  cal_id     TEXT    NOT NULL,
  from_user  TEXT    NOT NULL,
  to_user    TEXT    NOT NULL,
  role       TEXT    NOT NULL,
  status     TEXT    NOT NULL,   -- pending | accepted | declined | revoked
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
-- 同一个集对同一个人同时只能有一个待处理邀请，重复邀请直接复用
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_pending
  ON invites(cal_id, to_user) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_invites_to ON invites(to_user, status);

CREATE TABLE IF NOT EXISTS field_state (
  cal_id    TEXT    NOT NULL,
  entity    TEXT    NOT NULL,
  entity_id TEXT    NOT NULL,
  field     TEXT    NOT NULL,
  value     TEXT,
  ts        INTEGER NOT NULL,
  device_id TEXT    NOT NULL,
  PRIMARY KEY (cal_id, entity, entity_id, field)
);

CREATE TABLE IF NOT EXISTS changes (
  -- 全局单调，不按集分。客户端因此只需要**一个**游标：拉的时候按「我加入的
  -- 那些集」过滤即可，省掉「每个集一个游标」那套同步状态。
  -- AUTOINCREMENT 而不是裸 INTEGER PRIMARY KEY：游标可比性靠它，行号一旦被
  -- 回收，某个落后的客户端就会静默跳过一段变更。
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  cal_id    TEXT    NOT NULL,
  entity    TEXT    NOT NULL,
  entity_id TEXT    NOT NULL,
  field     TEXT    NOT NULL,
  value     TEXT,
  ts        INTEGER NOT NULL,
  device_id TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_cal_seq ON changes(cal_id, seq);

CREATE TABLE IF NOT EXISTS revoked (
  jti        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_exp ON revoked(expires_at);
`;

/** 旧 schema 的全部表名 —— 库是空的时候用来推倒重建 */
const ALL_TABLES = [
  'users', 'calendars', 'calendar_members', 'invites',
  'field_state', 'changes', 'revoked',
];

/**
 * 打开（首次时建表）数据库。幂等。
 *
 * schema 变了怎么办：只有**一个用户都没有**时才敢推倒重建（此时没有任何人
 * 的数据可丢）。只要库里有账户就拒绝启动，把「要不要迁、怎么迁」交回给人 ——
 * 静默重建等于把用户数据吃掉，那种事不能自动化。
 */
function open(dir) {
  if (_db) return _db;
  fs.mkdirSync(dir, { recursive: true });
  _file = path.join(dir, 'schedule.db');
  _db = new DatabaseSync(_file);
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

    if (hasOldData) {
      throw new Error(
        `数据库是 schema v${found}，当前代码要 v${SCHEMA_VERSION}，而库里已经有账户。\n` +
        `拒绝自动改动，请先备份 ${_file} 再手工迁移（见 DEPLOY.md 的「数据结构升级」）。`,
      );
    }
    // 空库：直接推倒重建。以前留下的表结构不兼容，留着反而是隐患
    _db.exec('PRAGMA foreign_keys = OFF');
    for (const t of ALL_TABLES) _db.exec(`DROP TABLE IF EXISTS ${t}`);
    _db.exec('PRAGMA foreign_keys = ON');
  }

  _db.exec(SCHEMA);
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

/* ------------------------------------------------------------------ 用户 */

function countUsers() {
  return Number(get('SELECT COUNT(*) AS n FROM users').n);
}

function findUserByName(name) {
  return get('SELECT * FROM users WHERE name = ?', String(name));
}

function findUserById(id) {
  return get('SELECT * FROM users WHERE id = ?', String(id));
}

function insertUser(u) {
  run('INSERT INTO users (id, name, salt, hash, created_at) VALUES (?,?,?,?,?)',
    u.id, u.name, u.salt, u.hash, u.createdAt);
  return u;
}

/* -------------------------------------------------------------- 日程集 */

const ROLES = new Set(['owner', 'editor', 'viewer']);

function insertCalendar(c) {
  run('INSERT INTO calendars (id, name, owner_id, created_at) VALUES (?,?,?,?)',
    c.id, c.name, c.ownerId, c.createdAt);
  return c;
}

function findCalendar(id) {
  return get('SELECT * FROM calendars WHERE id = ? AND deleted_at IS NULL', String(id));
}

function renameCalendar(id, name) {
  return run('UPDATE calendars SET name = ? WHERE id = ? AND deleted_at IS NULL', String(name), String(id));
}

function softDeleteCalendar(id) {
  return run('UPDATE calendars SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', Date.now(), String(id));
}

/** 我加入的全部日程集（含角色），按加入时间。一次 JOIN 拿完，别在循环里查。 */
function calendarsFor(userId) {
  return all(`
    SELECT c.id, c.name, c.owner_id, c.created_at, m.role, m.joined_at
    FROM calendar_members m
    JOIN calendars c ON c.id = m.cal_id
    WHERE m.user_id = ? AND c.deleted_at IS NULL
    ORDER BY m.joined_at, c.created_at
  `, String(userId));
}

/** 我加入的日程集 id 列表 —— 拉同步时用它过滤 */
function calendarIdsFor(userId) {
  return all(`
    SELECT m.cal_id AS id
    FROM calendar_members m
    JOIN calendars c ON c.id = m.cal_id
    WHERE m.user_id = ? AND c.deleted_at IS NULL
  `, String(userId)).map((r) => r.id);
}

function countCalendarsFor(userId) {
  return Number(get(`
    SELECT COUNT(*) AS n FROM calendar_members m
    JOIN calendars c ON c.id = m.cal_id
    WHERE m.user_id = ? AND c.deleted_at IS NULL
  `, String(userId)).n);
}

/** 权限的唯一查法。返回 'owner' | 'editor' | 'viewer' | null */
function roleOf(calId, userId) {
  const row = get(`
    SELECT m.role FROM calendar_members m
    JOIN calendars c ON c.id = m.cal_id
    WHERE m.cal_id = ? AND m.user_id = ? AND c.deleted_at IS NULL
  `, String(calId), String(userId));
  return row ? row.role : null;
}

function upsertMember(calId, userId, role, at) {
  return run(`
    INSERT INTO calendar_members (cal_id, user_id, role, joined_at) VALUES (?,?,?,?)
    ON CONFLICT(cal_id, user_id) DO UPDATE SET role = excluded.role
  `, String(calId), String(userId), String(role), at || Date.now());
}

function removeMember(calId, userId) {
  return run('DELETE FROM calendar_members WHERE cal_id = ? AND user_id = ?',
    String(calId), String(userId));
}

/** 成员名单 —— 带上用户名，前端要显示「谁在这个集里」 */
function membersOf(calId) {
  return all(`
    SELECT m.user_id, m.role, m.joined_at, u.name
    FROM calendar_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.cal_id = ?
    ORDER BY m.joined_at
  `, String(calId));
}

/** 有没有别的 owner —— 「最后一个所有者不能降级 / 不能退出」要用 */
function countOwners(calId) {
  return Number(get(
    "SELECT COUNT(*) AS n FROM calendar_members WHERE cal_id = ? AND role = 'owner'",
    String(calId),
  ).n);
}

/* ---------------------------------------------------------------- 邀请 */

function insertInvite(i) {
  run(`INSERT INTO invites (id, cal_id, from_user, to_user, role, status, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    i.id, i.calId, i.fromUser, i.toUser, i.role, 'pending', i.createdAt);
  return i;
}

function findInvite(id) {
  return get('SELECT * FROM invites WHERE id = ?', String(id));
}

/** 同一个集对同一个人已经有待处理邀请时复用那条，别堆一串 */
function findPendingInvite(calId, toUser) {
  return get("SELECT * FROM invites WHERE cal_id = ? AND to_user = ? AND status = 'pending'",
    String(calId), String(toUser));
}

function decideInvite(id, status) {
  return run('UPDATE invites SET status = ?, decided_at = ? WHERE id = ?',
    String(status), Date.now(), String(id));
}

/** 发给我的待处理邀请 —— 带上集名和邀请人名字，前端直接能显示 */
function invitesFor(userId) {
  return all(`
    SELECT i.*, c.name AS cal_name, u.name AS from_name
    FROM invites i
    JOIN calendars c ON c.id = i.cal_id
    JOIN users u ON u.id = i.from_user
    WHERE i.to_user = ? AND i.status = 'pending' AND c.deleted_at IS NULL
    ORDER BY i.created_at
  `, String(userId));
}

/** 我发出去的、还没被处理的 —— 界面上显示「等对方确认」 */
function invitesSentBy(userId) {
  return all(`
    SELECT i.*, c.name AS cal_name, u.name AS to_name
    FROM invites i
    JOIN calendars c ON c.id = i.cal_id
    JOIN users u ON u.id = i.to_user
    WHERE i.from_user = ? AND i.status = 'pending' AND c.deleted_at IS NULL
    ORDER BY i.created_at
  `, String(userId));
}

/** 集被删 / 成员被踢时，把相关的待处理邀请一并作废 */
function cancelPendingInvites(calId, userId) {
  const where = userId
    ? 'cal_id = ? AND (to_user = ? OR from_user = ?)'
    : 'cal_id = ?';
  const args = userId ? [String(calId), String(userId), String(userId)] : [String(calId)];
  return run(`UPDATE invites SET status = 'revoked', decided_at = ?
              WHERE ${where} AND status = 'pending'`, Date.now(), ...args);
}

/* --------------------------------------------------------------- 同步状态 */

/**
 * 写入一个字段，带 LWW 裁决。返回是否真的改动了。
 *
 * 接受条件：更新的时间戳；或同一时间戳下更大的 device_id。
 * device_id 做平局破解是为了让结果**确定性**——两台设备各自算出来的赢家必须
 * 是同一个，否则永远收敛不了。
 */
function putField(calId, entity, entityId, field, value, ts, deviceId) {
  return run(`
    INSERT INTO field_state (cal_id, entity, entity_id, field, value, ts, device_id)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(cal_id, entity, entity_id, field) DO UPDATE SET
      value     = excluded.value,
      ts        = excluded.ts,
      device_id = excluded.device_id
    WHERE excluded.ts > field_state.ts
       OR (excluded.ts = field_state.ts AND excluded.device_id > field_state.device_id)
  `, calId, entity, entityId, field, value, ts, deviceId);
}

/**
 * 全局最大 seq —— 用作「已经拉到哪了」的游标。
 *
 * 注意它**不限于**某个用户可见的集：客户端要跳过的是全世界的进度，
 * 而不是自己那几个集。否则别人在别的集里写东西会让我这个游标一直原地不动。
 */
function maxSeq() {
  const row = get('SELECT COALESCE(MAX(seq), 0) AS m FROM changes');
  return Number(row.m);
}

/** 追加一条变更流水。seq 由 SQLite 自己发号。 */
function appendChange(calId, entity, entityId, field, value, ts, deviceId) {
  const r = handle().prepare(`
    INSERT INTO changes (cal_id, entity, entity_id, field, value, ts, device_id)
    VALUES (?,?,?,?,?,?,?)`)
    .run(calId, entity, entityId, field, value, ts, deviceId);
  return Number(r.lastInsertRowid);
}

/**
 * 自 cursor 之后的变更，只含我可见的集。
 *
 * calIds 为空（一个集都没加入）时直接返回空数组 —— 不能让 `IN ()` 落进
 * SQL 里，那在部分 SQLite 版本上是语法错误。
 */
function changesSince(calIds, cursor, limit) {
  if (!calIds.length) return [];
  const holes = calIds.map(() => '?').join(',');
  return all(`
    SELECT seq, cal_id, entity, entity_id, field, value, ts, device_id
    FROM changes
    WHERE cal_id IN (${holes}) AND seq > ?
    ORDER BY seq LIMIT ?
  `, ...calIds, cursor, limit);
}

/** 全量字段状态，只含我可见的集。 */
function allFields(calIds) {
  if (!calIds.length) return [];
  const holes = calIds.map(() => '?').join(',');
  return all(`
    SELECT cal_id, entity, entity_id, field, value, ts, device_id
    FROM field_state WHERE cal_id IN (${holes})
  `, ...calIds);
}

/* ---------------------------------------------------------- 吊销名单（JWT） */

function isRevoked(jti) {
  const row = get('SELECT expires_at FROM revoked WHERE jti = ?', String(jti));
  return !!row && Number(row.expires_at) > Date.now();
}

function revokeJti(jti, expiresAt) {
  run('INSERT OR REPLACE INTO revoked (jti, expires_at) VALUES (?, ?)', jti, expiresAt);
}

/** 清掉已过期的吊销记录，避免表无限增长 */
function pruneRevoked() {
  return run('DELETE FROM revoked WHERE expires_at <= ?', Date.now());
}

/* ------------------------------------------------------------------ 杂项 */

function file() { return _file; }

function close() {
  if (_db) { try { _db.close(); } catch (_) { /* 已关闭 */ } _db = null; }
}

module.exports = {
  SCHEMA_VERSION, ROLES,
  open, tx, run, get, all,
  countUsers, findUserByName, findUserById, insertUser,
  insertCalendar, findCalendar, renameCalendar, softDeleteCalendar,
  calendarsFor, calendarIdsFor, countCalendarsFor, roleOf,
  upsertMember, removeMember, membersOf, countOwners,
  insertInvite, findInvite, findPendingInvite, decideInvite,
  invitesFor, invitesSentBy, cancelPendingInvites,
  putField, maxSeq, appendChange, changesSince, allFields,
  isRevoked, revokeJti, pruneRevoked,
  file, close,
};
