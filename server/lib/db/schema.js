/**
 * schema.js —— 表结构定义与迁移脚本（纯数据，零逻辑）
 *
 * 建库语句 = v2 那七张 + v3 追加的三张。两处拼同一个真源，见 AI_TABLES。
 * **只允许追加式迁移**：CREATE TABLE / CREATE INDEX / ALTER TABLE ADD COLUMN。
 * 绝不 DROP、绝不 UPDATE 已有数据 —— 库里是用户的真实日程。
 */

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

module.exports = {
  SCHEMA_VERSION, AI_TABLES, MIGRATIONS, SCHEMA, FULL_SCHEMA, ALL_TABLES,
};
