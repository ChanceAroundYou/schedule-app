/**
 * migration.test.js —— schema 升级执行器（v2 → v3）
 *
 *   node --test server/tests/migration.test.js
 *
 * 这是**全项目唯一一处跑错会吃掉用户数据**的代码，所以比别处更啰嗦：
 * 光断言「升级成功了」不够，还要断言「老数据一行没少、一张表没被删」。
 *
 * 为什么单独一个文件：`lib/db.js` 是单例（open() 打开过就直接返回），
 * 而 api.test.js 全程占着它。node --test 每个文件一个进程，正好把这件事隔离掉。
 *
 * V2_SCHEMA 是**冻结的历史快照**，不是从 db.js 里取的 —— 迁移测试要验的是
 * 「拿真实的旧库能不能升上来」，那个旧库的形状从定义上就不该跟着代码变。
 * 别为了「去重」把它换成 import。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = require('../lib/db');

/* ------------------------------------------------------- 冻结的 v2 建表语句 */

const V2_SCHEMA = `
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
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS calendar_members (
  cal_id    TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
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
  status     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
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

/** v2 时代就有的七张表 */
const V2_TABLES = [
  'users', 'calendars', 'calendar_members', 'invites',
  'field_state', 'changes', 'revoked',
];

const NEW_TABLES = ['ai_settings', 'ai_sessions', 'ai_messages', 'ai_memory', 'ai_authorizations'];

/* ------------------------------------------------------------------ 工具 */

function tmpDataDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `schedule-mig-${tag}-`));
}

/** 每张 v2 表各有多少行 —— 「迁移没删东西」要靠它，光比表名比不出来 */
function tableCounts(d, tables) {
  const out = {};
  for (const t of tables) out[t] = Number(d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
  return out;
}

/** 绕开单例直接读文件，用来断言磁盘上真实的形状 */
function inspect(dir) {
  const d = new DatabaseSync(path.join(dir, 'schedule.db'));
  // node:sqlite 返回的行是**无原型对象**，直接和字面量做 deepStrictEqual 会
  // 因为原型不同而失败 —— 打印出来一模一样，报错却看不出原因。摊平掉。
  const rows = (sql) => d.prepare(sql).all().map((r) => ({ ...r }));
  const out = {
    userVersion: Number(d.prepare('PRAGMA user_version').get().user_version),
    tables: d.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((r) => r.name),
    counts: tableCounts(d, V2_TABLES),
    users: rows('SELECT id, name FROM users ORDER BY id'),
    fields: rows('SELECT cal_id, entity_id, field, value FROM field_state ORDER BY entity_id, field'),
    changes: rows('SELECT seq, entity_id, field FROM changes ORDER BY seq'),
  };
  d.close();
  return out;
}

/**
 * 造一个 v2 的库：写 v2 的表结构、塞进真实数据、把版本号钉成 2。
 * 用户和 field_state 都要有 —— 断言「升级后还在」才有的可断。
 */
function makeV2Dir(tag, { withUser = true } = {}) {
  const dir = tmpDataDir(tag);
  const d = new DatabaseSync(path.join(dir, 'schedule.db'));
  d.exec(V2_SCHEMA);
  if (withUser) {
    d.prepare('INSERT INTO users (id, name, salt, hash, created_at) VALUES (?,?,?,?,?)')
      .run('u-dad', '爸爸', 'salt', 'hash', 1000);
    d.prepare('INSERT INTO calendars (id, name, owner_id, created_at) VALUES (?,?,?,?)')
      .run('cal-1', '我的日程', 'u-dad', 1000);
    d.prepare('INSERT INTO calendar_members (cal_id, user_id, role, joined_at) VALUES (?,?,?,?)')
      .run('cal-1', 'u-dad', 'owner', 1000);
    d.prepare(`INSERT INTO field_state (cal_id, entity, entity_id, field, value, ts, device_id)
               VALUES (?,?,?,?,?,?,?)`)
      .run('cal-1', 'task', 't-1', 'title', '"开家长会"', 2000, 'devA');
    d.prepare(`INSERT INTO field_state (cal_id, entity, entity_id, field, value, ts, device_id)
               VALUES (?,?,?,?,?,?,?)`)
      .run('cal-1', 'task', 't-1', 'date', '"2026-10-07"', 2000, 'devA');
    d.prepare(`INSERT INTO changes (cal_id, entity, entity_id, field, value, ts, device_id)
               VALUES (?,?,?,?,?,?,?)`)
      .run('cal-1', 'task', 't-1', 'title', '"开家长会"', 2000, 'devA');
    // 这两张表平时没人查，正好当「没被顺手清掉」的探针 ——
    // 迁移里一句多余的 DELETE / DROP 只有它们看得出来
    d.prepare(`INSERT INTO invites (id, cal_id, from_user, to_user, role, status, created_at)
               VALUES (?,?,?,?,?,?,?)`)
      .run('inv-1', 'cal-1', 'u-dad', 'u-mom', 'editor', 'pending', 1500);
    d.prepare('INSERT INTO revoked (jti, expires_at) VALUES (?,?)')
      .run('jti-old', 9_999_999_999_999);
  }
  d.exec('PRAGMA user_version = 2');
  d.close();
  return dir;
}

/* ------------------------------------------------------------------ 用例 */

test('空目录：直接建到 v4，十二张表齐全', (t) => {
  const dir = tmpDataDir('fresh');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  db.open(dir);
  db.close();

  const got = inspect(dir);
  assert.strictEqual(got.userVersion, db.SCHEMA_VERSION, '新库的版本号就是当前版本');
  assert.strictEqual(db.SCHEMA_VERSION, 4, 'v4 是这次改动引入的版本');
  for (const name of [...V2_TABLES, ...NEW_TABLES]) {
    assert.ok(got.tables.includes(name), `新库里应该有 ${name}`);
  }
});

test('v2 库带真实数据：升级后一个用户、一条字段都不少', (t) => {
  const dir = makeV2Dir('upgrade');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const before = inspect(dir);
  assert.strictEqual(before.userVersion, 2, '前提：这确实是个 v2 库');
  assert.strictEqual(before.users.length, 1);
  assert.strictEqual(before.fields.length, 2);

  db.open(dir);
  db.close();

  const after = inspect(dir);
  assert.strictEqual(after.userVersion, 4, '版本号要升上去');
  assert.deepStrictEqual(after.users, before.users, '账户必须原样还在');
  assert.deepStrictEqual(after.fields, before.fields, '逐字段状态必须原样还在');
  assert.deepStrictEqual(after.changes, before.changes, '变更流水必须原样还在');
  for (const name of NEW_TABLES) {
    assert.ok(after.tables.includes(name), `升级后要有新表 ${name}`);
  }
});

test('升级只增不删：表在，行也得在', (t) => {
  const dir = makeV2Dir('superset');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const before = inspect(dir);
  db.open(dir);
  db.close();
  const after = inspect(dir);

  for (const name of V2_TABLES) {
    assert.ok(after.tables.includes(name), `迁移不得删表：${name} 不见了`);
  }
  assert.ok(after.tables.length >= before.tables.length, '迁移后的表只该多不该少');

  // **光比表名是不够的**：`open()` 最后那句 `exec(FULL_SCHEMA)` 会把删掉的表
  // 按 `CREATE TABLE IF NOT EXISTS` 立刻重建出来，于是「DROP 了但表还在」。
  // 表名看着一切正常，里面的行已经没了。真正能抓住这种情况的是行数。
  for (const name of V2_TABLES) {
    assert.ok(
      after.counts[name] >= before.counts[name],
      `迁移不得丢行：${name} 从 ${before.counts[name]} 行变成 ${after.counts[name]} 行`,
    );
  }
  assert.ok(before.counts.invites > 0 && before.counts.revoked > 0,
    '前提：这两张表里得有行，否则上面那条断言是空转');
});

test('升级后新表真的能用（不是建了个空壳）', (t) => {
  const dir = makeV2Dir('usable');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  db.open(dir);
  const handle = db.run(
    `INSERT INTO ai_sessions (id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)`,
    's-1', 'u-dad', '问排期', 3000, 3000,
  );
  db.close();

  assert.strictEqual(handle, 1);
  const got = inspect(dir);
  assert.strictEqual(got.userVersion, 4);
  assert.deepStrictEqual(got.users, [{ id: 'u-dad', name: '爸爸' }], '老数据仍要完好');
});

test('v2 空库（还没人注册）：推倒重建，不报错', (t) => {
  const dir = makeV2Dir('empty', { withUser: false });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  db.open(dir);
  db.close();

  const got = inspect(dir);
  assert.strictEqual(got.userVersion, 4);
  for (const name of [...V2_TABLES, ...NEW_TABLES]) {
    assert.ok(got.tables.includes(name), `重建后应该有 ${name}`);
  }
});

test('缺某一级迁移脚本时：宁可不启动，也不走一半', (t) => {
  const dir = makeV2Dir('noscript');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const saved = db.MIGRATIONS[2];
  delete db.MIGRATIONS[2];
  t.after(() => { db.MIGRATIONS[2] = saved; });

  assert.throws(() => db.open(dir), /没有 v2 → v3 的迁移脚本/,
    '缺脚本必须显式报错，并指出是哪一级');

  // 抛了之后库必须**原封不动**，不能停在半路
  const got = inspect(dir);
  assert.strictEqual(got.userVersion, 2, '失败不得改动版本号');
  assert.deepStrictEqual(got.users, [{ id: 'u-dad', name: '爸爸' }], '失败不得动数据');
  assert.ok(!got.tables.includes('ai_settings'), '失败不得留下半截新表');
});

test('库比代码新：拒绝启动并说清是代码旧了', (t) => {
  const dir = makeV2Dir('downgrade');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 手工把版本号推到未来，模拟「代码回滚到旧版，库已经升过了」
  const d = new DatabaseSync(path.join(dir, 'schedule.db'));
  d.exec(`PRAGMA user_version = ${db.SCHEMA_VERSION + 1}`);
  d.close();

  assert.throws(() => db.open(dir), /比当前代码的 v4 还新/);

  const got = inspect(dir);
  assert.strictEqual(got.userVersion, db.SCHEMA_VERSION + 1, '库不该被降级改写');
  assert.deepStrictEqual(got.users, [{ id: 'u-dad', name: '爸爸' }], '库不该被动');
});

test('启动失败后单例被放掉，下一次 open 不会拿到半死的连接', (t) => {
  const bad = makeV2Dir('poison');
  const good = tmpDataDir('after-poison');
  t.after(() => {
    fs.rmSync(bad, { recursive: true, force: true });
    fs.rmSync(good, { recursive: true, force: true });
  });

  const d = new DatabaseSync(path.join(bad, 'schedule.db'));
  d.exec(`PRAGMA user_version = ${db.SCHEMA_VERSION + 1}`);
  d.close();

  assert.throws(() => db.open(bad));

  // 关键：上一条把 open() 打挂了，这里必须还能正常开一个新库
  db.open(good);
  assert.strictEqual(db.countUsers(), 0);
  db.close();
});
