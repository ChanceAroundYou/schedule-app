/**
 * db.js —— SQLite 存储层（node:sqlite，零外部依赖）
 *
 * 存的是**逐字段状态**，不是整份文档。原因：两台设备同时改同一条任务的不同
 * 字段（手机改标题、桌面改日期）时，只有真正冲突的那个字段需要决出胜负。
 * 整条任务存一坨的话，后写的那次会把对方那个字段一起抹掉。
 *
 * 四张表：
 *   users        账户。首个注册者即管理员
 *   field_state  当前值 + 每个字段各自的最后写入者 —— 同步的核心
 *   changes      追加流水，客户端按 seq 游标拉增量
 *   revoked      已登出的 jti，避免「登出后旧 token 还能用」
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  salt       TEXT    NOT NULL,
  hash       TEXT    NOT NULL,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS field_state (
  user_id   TEXT    NOT NULL,
  entity    TEXT    NOT NULL,
  entity_id TEXT    NOT NULL,
  field     TEXT    NOT NULL,
  value     TEXT,
  ts        INTEGER NOT NULL,
  device_id TEXT    NOT NULL,
  PRIMARY KEY (user_id, entity, entity_id, field)
);

CREATE TABLE IF NOT EXISTS changes (
  user_id   TEXT    NOT NULL,
  seq       INTEGER NOT NULL,
  entity    TEXT    NOT NULL,
  entity_id TEXT    NOT NULL,
  field     TEXT    NOT NULL,
  value     TEXT,
  ts        INTEGER NOT NULL,
  device_id TEXT    NOT NULL,
  PRIMARY KEY (user_id, seq)
);

CREATE TABLE IF NOT EXISTS revoked (
  jti        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_changes_user_seq ON changes(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_revoked_exp      ON revoked(expires_at);
`;

/** 打开（首次时建表）数据库。幂等。 */
function open(dir) {
  if (_db) return _db;
  fs.mkdirSync(dir, { recursive: true });
  _file = path.join(dir, 'schedule.db');
  _db = new DatabaseSync(_file);
  // WAL：读写并发不互相阻塞。NORMAL 对本项目足够——掉电最多丢最后一次事务。
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA synchronous = NORMAL');
  _db.exec('PRAGMA foreign_keys = ON');
  _db.exec(SCHEMA);
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

function listUsers() {
  return all('SELECT id, name, is_admin, created_at FROM users ORDER BY created_at');
}

function insertUser(u) {
  run('INSERT INTO users (id, name, salt, hash, is_admin, created_at) VALUES (?,?,?,?,?,?)',
    u.id, u.name, u.salt, u.hash, u.isAdmin ? 1 : 0, u.createdAt);
  return u;
}

/* --------------------------------------------------------------- 同步状态 */

/**
 * 写入一个字段，带 LWW 裁决。返回是否真的改动了。
 *
 * 接受条件：更新的时间戳；或同一时间戳下更大的 device_id。
 * device_id 做平局破解是为了让结果**确定性**——两台设备各自算出来的赢家必须
 * 是同一个，否则永远收敛不了。
 */
function putField(userId, entity, entityId, field, value, ts, deviceId) {
  return run(`
    INSERT INTO field_state (user_id, entity, entity_id, field, value, ts, device_id)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id, entity, entity_id, field) DO UPDATE SET
      value     = excluded.value,
      ts        = excluded.ts,
      device_id = excluded.device_id
    WHERE excluded.ts > field_state.ts
       OR (excluded.ts = field_state.ts AND excluded.device_id > field_state.device_id)
  `, userId, entity, entityId, field, value, ts, deviceId);
}

function maxSeq(userId) {
  const row = get('SELECT COALESCE(MAX(seq), 0) AS m FROM changes WHERE user_id = ?', userId);
  return Number(row.m);
}

/** 追加一条变更流水。seq 由调用方在事务内自增，避免每行一次 MAX 查询。 */
function appendChange(userId, seq, entity, entityId, field, value, ts, deviceId) {
  run(`INSERT INTO changes (user_id, seq, entity, entity_id, field, value, ts, device_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    userId, seq, entity, entityId, field, value, ts, deviceId);
}

function changesSince(userId, cursor, limit) {
  return all(`SELECT seq, entity, entity_id, field, value, ts, device_id
              FROM changes WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    userId, cursor, limit);
}

function allFields(userId) {
  return all(`SELECT entity, entity_id, field, value, ts, device_id
              FROM field_state WHERE user_id = ?`, userId);
}

/* ---------------------------------------------------------- 吊销名单（JWT） */

function isRevoked(jti) {
  const row = get('SELECT expires_at FROM revoked WHERE jti = ?', jti);
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
  open, tx, run, get, all,
  countUsers, findUserByName, findUserById, listUsers, insertUser,
  putField, maxSeq, appendChange, changesSince, allFields,
  isRevoked, revokeJti, pruneRevoked,
  file, close,
};
