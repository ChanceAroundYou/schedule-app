/**
 * db.js —— SQLite 存储层（node:sqlite，零外部依赖）
 *
 * 存的是**逐字段状态**，不是整份文档。原因：两台设备同时改同一条任务的不同
 * 字段（手机改标题、桌面改日期）时，只有真正冲突的那个字段需要决出胜负。
 * 整条任务存一坨的话，后写的那次会把对方那个字段一起抹掉。
 *
 * 十一张表：
 *   users             账户。平等多用户，没有管理员
 *   calendars         日程集 —— 数据的归属单位，相当于共享相册
 *   calendar_members  谁能看见哪个集、以什么身份（权限的**唯一**真相）
 *   invites           邀请。对方接受之后才写进 calendar_members
 *   field_state       当前值 + 每个字段各自的最后写入者 —— 同步的核心
 *   changes           追加流水，客户端按 seq 游标拉增量
 *   revoked           已登出的 jti，避免「登出后旧 token 还能用」
 *   ai_settings       每人一行的模型配置（v3 加）
 *   ai_sessions       对话会话（v3 加）
 *   ai_messages       会话里的消息 + 待确认提案（v3 加）
 *   ai_memory         跨对话记忆（v4 加）
 *   ai_authorizations  每人的授权状态（v4 加）
 *
 * 后三张表**不参与 LWW 同步**：模型配置是「我的凭据」，对话是「我问过什么」，
 * 都不是日程集里的共享内容，按 userId 归属，跟账号走。
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
const SCHEMA_VERSION = 4;

/* --------------------------------------------------------------- v3 新增 */

/**
 * AI 那三张表。**新建库与老库升级共用这一段** —— 分成两份写迟早会只改一处，
 * 于是新装的库和老库升上来的库结构悄悄不一致。
 */
const AI_TABLES = [
  // 每人一行。api_key 明文落库，信任级别与同目录的 secret.key 相同：
  // 数据目录不在 nginx 的伺服范围里，且靠文件权限隔离。接口**永不回显**它。
  `CREATE TABLE IF NOT EXISTS ai_settings (
     user_id    TEXT PRIMARY KEY,
     provider   TEXT    NOT NULL,
     base_url   TEXT    NOT NULL,
     model      TEXT    NOT NULL,
     api_key    TEXT,
     updated_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS ai_sessions (
     id         TEXT PRIMARY KEY,
     user_id    TEXT    NOT NULL,
     title      TEXT    NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_sessions_user ON ai_sessions(user_id, updated_at)`,

  // payload 存整条 pi AgentMessage 的 JSON，不拆列：消息的形状归 pi 管，
  // 拆列等于替它定 schema，它一升版我们就得跟着迁。
  // proposals 是这条 assistant 消息里**待确认的写入提案**，天然属于「哪一轮回答」，
  // 所以不另建表。
  `CREATE TABLE IF NOT EXISTS ai_messages (
     id         TEXT PRIMARY KEY,
     session_id TEXT    NOT NULL,
     user_id    TEXT    NOT NULL,
     seq        INTEGER NOT NULL,
     role       TEXT    NOT NULL,
     payload    TEXT    NOT NULL,
     proposals  TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id, seq)`,

  // 跨对话记忆。agent 在对话中自己决定记什么，新对话时取最近/最相关的
  // 几条放进系统提示词。满了丢最旧的，不搞压缩替换。
  `CREATE TABLE IF NOT EXISTS ai_memory (
    id           TEXT PRIMARY KEY,
    user_id      TEXT    NOT NULL,
    type         TEXT    NOT NULL,   -- preference | decision | pattern
    content      TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_memory_user ON ai_memory(user_id, created_at)`,

  // 每人的授权状态。任务增删改默认免确认，打卡和日程集管理默认需确认。
  // 邀请永远人来做，不在这里。
  `CREATE TABLE IF NOT EXISTS ai_authorizations (
    user_id                TEXT PRIMARY KEY,
    task_crud              TEXT    NOT NULL DEFAULT 'free',   -- free | confirm
    habit_checkin          TEXT    NOT NULL DEFAULT 'confirm', -- free | confirm
    calendar_mgmt          TEXT    NOT NULL DEFAULT 'confirm', -- free | confirm
    evening_report_enabled INTEGER NOT NULL DEFAULT 0,
    evening_report_time    TEXT    NOT NULL DEFAULT '21:00',
    updated_at             INTEGER NOT NULL
  )`,
];

/**
 * 从 vN 升到 v(N+1) 要执行的语句。**只允许追加式**：
 * CREATE TABLE / CREATE INDEX / ALTER TABLE ADD COLUMN。
 *
 * **绝不 DROP、绝不 UPDATE 已有数据。** 库里是用户的真实日程，
 * 一条「顺手清理一下」的语句就是一次不可恢复的数据丢失。
 * 加语句前先读 open() 上那段注释，改完跑 server/tests/migration.test.js。
 */
const MIGRATIONS = {
  2: AI_TABLES,
  // v3 → v4：加 ai_memory 和 ai_authorizations 两张新表。
  // 只 CREATE，不动已有表 —— 老库的 ai_settings / ai_sessions / ai_messages 原样保留。
  3: [
    `CREATE TABLE IF NOT EXISTS ai_memory (
      id           TEXT PRIMARY KEY,
      user_id      TEXT    NOT NULL,
      type         TEXT    NOT NULL,
      content      TEXT    NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ai_memory_user ON ai_memory(user_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS ai_authorizations (
      user_id                TEXT PRIMARY KEY,
      task_crud              TEXT    NOT NULL DEFAULT 'free',
      habit_checkin          TEXT    NOT NULL DEFAULT 'confirm',
      calendar_mgmt          TEXT    NOT NULL DEFAULT 'confirm',
      evening_report_enabled INTEGER NOT NULL DEFAULT 0,
      evening_report_time    TEXT    NOT NULL DEFAULT '21:00',
      updated_at             INTEGER NOT NULL
    )`,
  ],
};

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

/** 建库语句 = v2 那七张 + v3 追加的三张。两处拼同一个真源，见 AI_TABLES */
const FULL_SCHEMA = SCHEMA + AI_TABLES.join(';\n\n') + ';\n';

/** 旧 schema 的全部表名 —— 库是空的时候用来推倒重建 */
const ALL_TABLES = [
  'users', 'calendars', 'calendar_members', 'invites',
  'field_state', 'changes', 'revoked',
  'ai_settings', 'ai_sessions', 'ai_messages',
  'ai_memory', 'ai_authorizations',
];

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
        `拒绝自动改动，请先备份 ${_file} 再手工迁移（见 DEPLOY.md 的「数据结构升级」）。`,
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

/* ---------------------------------------------------------- AI 配置 / 会话 */

/** 我的模型配置。没有就返回 null（用默认值），不预先塞一行。 */
function getAiSettings(userId) {
  return get('SELECT * FROM ai_settings WHERE user_id = ?', String(userId));
}

/** 整行覆盖。apiKey 传 null 表示清空 —— 「这次不改」由调用方先读旧值再传回来。 */
function putAiSettings(userId, s) {
  return run(`
    INSERT INTO ai_settings (user_id, provider, base_url, model, api_key, updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      provider   = excluded.provider,
      base_url   = excluded.base_url,
      model      = excluded.model,
      api_key    = excluded.api_key,
      updated_at = excluded.updated_at
  `, String(userId), String(s.provider), String(s.baseUrl),
     String(s.model), s.apiKey == null ? null : String(s.apiKey), Number(s.updatedAt));
}

/*
 * 会话与消息。**每一条读 / 写都带 user_id 条件**，包括按主键查的那种。
 * 只按 id 查的话，猜到一个 sessionId 就能读到别人的对话 —— 而 id 是 UUIDv7，
 * 前 48 位是时间戳，并不是不可猜的。多一个条件不花钱。
 */

function insertAiSession(s) {
  return run(`
    INSERT INTO ai_sessions (id, user_id, title, created_at, updated_at)
    VALUES (?,?,?,?,?)
  `, String(s.id), String(s.userId), String(s.title),
     Number(s.createdAt), Number(s.updatedAt));
}

/** 会话列表，最近改过的在前。只回元信息 —— 消息要另取，免得列表接口越用越肥。 */
function listAiSessions(userId, limit = 50) {
  return all(`
    SELECT id, title, created_at, updated_at
    FROM ai_sessions WHERE user_id = ?
    ORDER BY updated_at DESC LIMIT ?
  `, String(userId), Number(limit));
}

function findAiSession(id, userId) {
  return get('SELECT * FROM ai_sessions WHERE id = ? AND user_id = ?', String(id), String(userId));
}

/** 改标题 / 推 updated_at。两者一起 —— 光有新消息不改 updated_at 的话，列表顺序会乱。 */
function touchAiSession(id, userId, title, when) {
  if (title == null) {
    return run('UPDATE ai_sessions SET updated_at = ? WHERE id = ? AND user_id = ?',
      Number(when), String(id), String(userId));
  }
  return run('UPDATE ai_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    String(title), Number(when), String(id), String(userId));
}

/** 删会话连同它的消息。两张表没有外键约束（内存库开外键要额外一句），所以在一个事务里手动删。 */
function deleteAiSession(id, userId) {
  let n = 0;
  tx(() => {
    run('DELETE FROM ai_messages WHERE session_id = ? AND user_id = ?', String(id), String(userId));
    n = run('DELETE FROM ai_sessions WHERE id = ? AND user_id = ?', String(id), String(userId));
  });
  return n;
}

/** 会话内递增的序号，用来保证消息顺序（created_at 同毫秒会并列） */
function nextAiMessageSeq(sessionId) {
  const row = get('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM ai_messages WHERE session_id = ?',
    String(sessionId));
  return Number(row.n);
}

function appendAiMessage(m) {
  return run(`
    INSERT INTO ai_messages (id, session_id, user_id, seq, role, payload, proposals, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `, String(m.id), String(m.sessionId), String(m.userId), Number(m.seq), String(m.role),
     String(m.payload), m.proposals == null ? null : String(m.proposals), Number(m.createdAt));
}

/** 一条会话的全部消息，按对话顺序。 */
function listAiMessages(sessionId, userId) {
  return all(`
    SELECT id, seq, role, payload, proposals, created_at
    FROM ai_messages WHERE session_id = ? AND user_id = ?
    ORDER BY seq
  `, String(sessionId), String(userId));
}

/**
 * 一条 assistant 消息里剩下的**待确认**提案。
 * 用户确认或划掉之后要把这条改小，否则再打开抽屉会看到已经改完的卡片。
 */
function setAiMessageProposals(messageId, userId, proposals) {
  return run('UPDATE ai_messages SET proposals = ? WHERE id = ? AND user_id = ?',
    proposals == null ? null : String(proposals), String(messageId), String(userId));
}

/**
 * 按提案 id 找出它挂在哪条消息上，连同提案本身，以及那条消息的**全部**提案。
 *
 * `proposals` 是一列 JSON 数组，所以用 `json_each` 摊开再比 id —— 别在 JS 里
 * 把全部消息读出来遍历：那等于每次确认都把整台机器上的对话拉进内存。
 *
 * 连 `message_proposals` 一起回，是因为确认之后要把它从那一列里删掉：
 * 再查一次那条消息是多余的，而两次查之间那条消息还可能被别的请求改过。
 *
 * `user_id` 条件是**必须的**：确认接口拿到的 id 来自客户端，少了它，
 * 猜到一个提案 id 就能改别人的数据。
 */
function findAiProposal(userId, proposalId) {
  return get(`
    SELECT m.id AS message_id, m.session_id,
           p.value AS proposal, m.proposals AS message_proposals
    FROM ai_messages m, json_each(m.proposals) p
    WHERE m.user_id = ? AND m.proposals IS NOT NULL
      AND json_extract(p.value, '$.id') = ?
    LIMIT 1
  `, String(userId), String(proposalId));
}

/* ---------------------------------------------------------- AI 记忆 / 授权 */

/** 记忆库上限。满了丢最旧的，不搞压缩替换。 */
const MEMORY_MAX = 50;

function insertMemory(m) {
  return run(
    'INSERT INTO ai_memory (id, user_id, type, content, created_at, last_used_at) VALUES (?,?,?,?,?,?)',
    String(m.id), String(m.userId), String(m.type), String(m.content),
    Number(m.createdAt), m.lastUsedAt == null ? null : Number(m.lastUsedAt),
  );
}

function listMemories(userId, limit = MEMORY_MAX) {
  return all(
    'SELECT id, type, content, created_at, last_used_at FROM ai_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    String(userId), Number(limit),
  );
}

function deleteMemory(id, userId) {
  return run('DELETE FROM ai_memory WHERE id = ? AND user_id = ?', String(id), String(userId));
}

/** 取最近 N 条记忆放进系统提示词。同时把 last_used_at 推上去。 */
function touchMemories(ids, when) {
  if (!ids.length) return;
  const holes = ids.map(() => '?').join(',');
  run(`UPDATE ai_memory SET last_used_at = ? WHERE id IN (${holes})`, Number(when), ...ids.map(String));
}

/** 记忆库满了就丢最旧的，保持在 MEMORY_MAX 以内。 */
function pruneMemories(userId) {
  return run(
    `DELETE FROM ai_memory WHERE user_id = ? AND id NOT IN (
       SELECT id FROM ai_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
     )`,
    String(userId), String(userId), MEMORY_MAX,
  );
}

/** 读授权状态。没有行就用默认值（不落库 —— 用户没改过就不该有行）。 */
function getAuthorizations(userId) {
  const row = get('SELECT * FROM ai_authorizations WHERE user_id = ?', String(userId));
  if (!row) {
    return {
      taskCrud: 'free', habitCheckin: 'confirm', calendarMgmt: 'confirm',
      eveningReportEnabled: 0, eveningReportTime: '21:00', updatedAt: null,
    };
  }
  return {
    taskCrud: row.task_crud,
    habitCheckin: row.habit_checkin,
    calendarMgmt: row.calendar_mgmt,
    eveningReportEnabled: Number(row.evening_report_enabled),
    eveningReportTime: row.evening_report_time,
    updatedAt: Number(row.updated_at),
  };
}

/** 改授权。只更新传了的字段，没传的保持原值。 */
function putAuthorizations(userId, patch) {
  const cur = getAuthorizations(userId);
  const next = {
    taskCrud: patch.taskCrud || cur.taskCrud,
    habitCheckin: patch.habitCheckin || cur.habitCheckin,
    calendarMgmt: patch.calendarMgmt || cur.calendarMgmt,
    eveningReportEnabled: patch.eveningReportEnabled != null ? patch.eveningReportEnabled : cur.eveningReportEnabled,
    eveningReportTime: patch.eveningReportTime || cur.eveningReportTime,
  };
  return run(
    `INSERT INTO ai_authorizations (user_id, task_crud, habit_checkin, calendar_mgmt, evening_report_enabled, evening_report_time, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       task_crud = excluded.task_crud,
       habit_checkin = excluded.habit_checkin,
       calendar_mgmt = excluded.calendar_mgmt,
       evening_report_enabled = excluded.evening_report_enabled,
       evening_report_time = excluded.evening_report_time,
       updated_at = excluded.updated_at`,
    String(userId), next.taskCrud, next.habitCheckin, next.calendarMgmt,
    next.eveningReportEnabled, next.eveningReportTime, Date.now(),
  );
}

/* ------------------------------------------------------------------ 杂项 */

function file() { return _file; }

function close() {
  if (_db) { try { _db.close(); } catch (_) { /* 已关闭 */ } _db = null; }
}

module.exports = {
  SCHEMA_VERSION, MIGRATIONS, ALL_TABLES, ROLES,
  open, tx, run, get, all,
  countUsers, findUserByName, findUserById, insertUser,
  insertCalendar, findCalendar, renameCalendar, softDeleteCalendar,
  calendarsFor, calendarIdsFor, countCalendarsFor, roleOf,
  upsertMember, removeMember, membersOf, countOwners,
  insertInvite, findInvite, findPendingInvite, decideInvite,
  invitesFor, invitesSentBy, cancelPendingInvites,
  putField, maxSeq, appendChange, changesSince, allFields,
  isRevoked, revokeJti, pruneRevoked,
  getAiSettings, putAiSettings,
  insertAiSession, listAiSessions, findAiSession, touchAiSession, deleteAiSession,
  nextAiMessageSeq, appendAiMessage, listAiMessages, setAiMessageProposals,
  findAiProposal,
  insertMemory, listMemories, deleteMemory, touchMemories, pruneMemories,
  getAuthorizations, putAuthorizations,
  file, close,
};
