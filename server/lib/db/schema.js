/**
 * schema.js —— 表结构定义与迁移脚本（纯数据，零逻辑）
 *
 * 建库语句 = v2 那七张 + v3 追加的三张。两处拼同一个真源，见 AI_TABLES。
 * **只允许追加式迁移**：CREATE TABLE / CREATE INDEX / ALTER TABLE ADD COLUMN。
 * 绝不 DROP、绝不 UPDATE 已有数据 —— 库里是用户的真实日程。
 *
 * **唯一的例外是 v8 的打卡搬家**（migrateHabitsToPersonal）：它是用户明确
 * 要求的语义变更（打卡从"随集共享"改成"按人私有"），不带任何"顺手清理"。
 * 写这类迁移的规矩还是那两条：可重入（跑第二遍什么都不做）、不删 changes
 * 流水（那是别人游标的落脚点）。
 */
const crypto = require('node:crypto');

/** 当前 schema 版本，存在 PRAGMA user_version 里。加表 / 改列就 +1 */
const SCHEMA_VERSION = 9;

/* --------------------------------------------------------------- v9 新增 */

/**
 * 每日流程（2026-11-07）。
 *
 * **按 user_id 归属，不进 field_state / changes**，理由与 counters 那两张表相同：
 * 每日流程是「我自己的顺序表」，个人私有，不共享、不参与日程集那套角色权限。
 *
 * 存的是一份**整文档 JSON**，不是逐字段实体：
 *   doc = 'template'  常用模板（全用户一份，每天共用）
 *   doc = 'YYYY-MM-DD' 当天清单（首次打开那天时由模板生成，之后独立）
 *
 * 为什么整文档而不是逐项字段：
 *   · 一项流程只有「标题 / 参考时间 / 顺序 / 完成」，没有并发分字段改的场景；
 *   · 顺序是一个整体（拖一下会动一串），逐字段 LWW 反而会把顺序拆散；
 *   · 个人私有，不存在两个人同时编辑同一份 —— 冲突只可能来自同一个人的两台设备，
 *     用「整文档最后写入者胜」就够，配合 rev 让客户端能看出自己是不是落后了。
 *
 * body 是 JSON 字符串而不是 JSON 列：SQLite 没有原生 JSON 类型，
 * 存文本、由 lib/db/flow.js 统一 parse/stringify，别在路由里各写一遍。
 */
const FLOW_TABLES = [
  `CREATE TABLE IF NOT EXISTS flow_docs (
     user_id    TEXT    NOT NULL,
     doc        TEXT    NOT NULL,
     -- 单调递增。每次成功写入 +1，客户端拿它判断「我手上这份是不是旧的」
     rev        INTEGER NOT NULL,
     body       TEXT    NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, doc)
   )`,
];

/* --------------------------------------------------------------- v5 新增 */

/**
 * 桌面计数器（v5）。
 *
 * **按 user_id 归属，不进 field_state / changes**，理由与 AI 那三张表相同：
 * 计数器是「我自己的两个数字」，不是日程集里的共享内容，没有 owner/editor/
 * viewer 那套权限语义。硬塞进 LWW 通道还会带来一个真问题 —— 字段级同步是
 * **整值替换**，两台设备同时点 +1，后写的把前一次覆盖掉，加两次只长 1。
 * 所以这里用一条独立的原子自增语句，见 db/counters.js。
 *
 * id 用固定值（naonao / kutai），name 可改 —— 改名字不该换 id，否则
 * 桌面上的小组件会指向一条空记录。
 */
const COUNTER_TABLES = [
  `CREATE TABLE IF NOT EXISTS counters (
     user_id    TEXT    NOT NULL,
     id         TEXT    NOT NULL,
     name       TEXT    NOT NULL,
     value      INTEGER NOT NULL DEFAULT 0,
     -- 每天自动加多少（v6）。0 = 关闭自动增加。
     daily_increment INTEGER NOT NULL DEFAULT 6,
     -- 上一次「结算」到哪一天（YYYY-MM-DD，北京时间）。NULL = 还没结算过，
     -- 第一次读到它时才设为当天并且**不加**（从那天开始算，不追历史）。
     last_credit_date TEXT,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, id)
   )`,
];

/* --------------------------------------------------------------- v6 新增 */

/** SQLite 没有 `ADD COLUMN IF NOT EXISTS`，只能先问 PRAGMA 再决定加不加。 */
function addColumnIfMissing(handle, table, column, decl) {
  const cols = handle.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/**
 * 每个用户那个私有「打卡集」的名字。**只在库里看得见** —— 它不出现在任何
 * 集列表里，所以这个名字用户永远读不到，取一个能自查的就行。
 */
const HABITS_CAL_NAME = '打卡（仅自己）';

/**
 * v7 → v8：打卡改成「按用户私有」。
 *
 * 打卡原本和任务一样挂在日程集上（`field_state.cal_id`），于是一旦共享一个
 * 集，打卡也跟着共享了。用户 2026-11-02 明确要求：**日程可以共享，打卡只属于
 * 每个用户自己**。
 *
 * 做法不是另起一张表（那要重做一套同步：outbox、游标、LWW、小组件快照全都
 * 绕不开），而是给**每个用户一个不出现在列表里的私有「打卡集」**
 * （`calendars.kind = 'habits'`），打卡一律落在那里。共享集的成员自然看不到
 * 别人的打卡，而上面那套机制一行都不用改。
 *
 * 历史数据（用户确认的口径：原记录保留、别人界面里不再显示）：老打卡没有
 * 「创建者」字段（服务端只给任务补 createdBy），所以按**每个成员各留一份**
 * 来迁 —— 共享集里的每条打卡复制到该集每个成员的私有打卡集（沿用同一个
 * entity_id，客户端上那条打卡项不会变成「新的」），再把行从共享集删掉。
 * 好处是谁的打卡记录都不会凭空消失；代价是同一份历史在库里存了 N 份
 * （两三个人的家庭场景，量可以忽略）。
 *
 * 幂等：干完活之后普通集里一条 habit 行都不剩，再跑一次直接返回。
 * 只删 field_state 的**行**，changes 里那些流水保留 —— 它们是客户端游标
 * 走过的路，删掉会让落后的一端静默跳过一段。新写的 change 负责把客户端
 * 手里那条打卡的「所属集」改过来。
 */
function migrateHabitsToPersonal(handle) {
  const strays = handle.prepare(`
    SELECT f.cal_id AS calId, f.entity_id AS entityId, f.field, f.value, f.ts, f.device_id AS deviceId
    FROM field_state f
    JOIN calendars c ON c.id = f.cal_id
    WHERE f.entity = 'habit' AND COALESCE(c.kind, 'normal') <> 'habits'
  `).all();
  if (!strays.length) return;

  const now = Date.now();
  const membersOf = handle.prepare('SELECT user_id AS userId FROM calendar_members WHERE cal_id = ?');
  const findHabitCal = handle.prepare(
    "SELECT id FROM calendars WHERE owner_id = ? AND kind = 'habits' AND deleted_at IS NULL LIMIT 1",
  );
  const insCal = handle.prepare(
    "INSERT INTO calendars (id, name, owner_id, color, created_at, kind) VALUES (?,?,?,?,?,'habits')",
  );
  const insMember = handle.prepare(
    'INSERT OR IGNORE INTO calendar_members (cal_id, user_id, role, joined_at) VALUES (?,?,?,?)',
  );
  const insField = handle.prepare(`
    INSERT INTO field_state (cal_id, entity, entity_id, field, value, ts, device_id)
    VALUES (?, 'habit', ?, ?, ?, ?, ?)
    ON CONFLICT(cal_id, entity, entity_id, field) DO NOTHING
  `);
  const insChange = handle.prepare(`
    INSERT INTO changes (cal_id, entity, entity_id, field, value, ts, device_id)
    VALUES (?, 'habit', ?, ?, ?, ?, ?)
  `);

  const calCache = new Map();
  const habitCalOf = (userId) => {
    if (calCache.has(userId)) return calCache.get(userId);
    const row = findHabitCal.get(userId);
    let id = row && row.id;
    if (!id) {
      id = crypto.randomUUID();
      insCal.run(id, HABITS_CAL_NAME, userId, 'jade', now);
      insMember.run(id, userId, 'owner', now);
    }
    calCache.set(userId, id);
    return id;
  };

  // 先按集分组：成员数是「每个集查一次」，不是「每一行查一次」
  const byCal = new Map();
  for (const r of strays) {
    if (!byCal.has(r.calId)) byCal.set(r.calId, []);
    byCal.get(r.calId).push(r);
  }

  for (const [calId, rows] of byCal) {
    const members = membersOf.all(calId).map((m) => m.userId);
    if (!members.length) continue;
    for (const userId of members) {
      const target = habitCalOf(userId);
      for (const r of rows) {
        insField.run(target, r.entityId, r.field, r.value, r.ts, r.deviceId);
        insChange.run(target, r.entityId, r.field, r.value, r.ts, r.deviceId);
      }
    }
  }

  handle.exec(`
    DELETE FROM field_state
    WHERE entity = 'habit'
      AND cal_id IN (SELECT id FROM calendars WHERE COALESCE(kind, 'normal') <> 'habits')
  `);
}

/**
 * v5 → v6：计数器加「每日增量」和「上次结算日」两列。
 *
 * ⚠️ **为什么这两条不是 SQL 字符串**：v4→v5 那步建 counters 用的就是上面
 * COUNTER_TABLES，而它已经是**最新结构**（新建库和迁移共用一份，否则两边会悄悄
 * 分叉）。于是一个 v2 老库升级时会先按最新结构建出 counters，紧接着 v6 再
 * `ALTER ADD` 同样的列 → `duplicate column name`，整个迁移回滚，服务起不来。
 * 用函数先查 PRAGMA 就能同时伺候「刚建好的新表」和「真正的 v5 老表」。
 *
 * 两列都可空 / 有默认值，老数据不用回填：last_credit_date 留空表示「还没结算过」，
 * 第一次读到它时设为当天并且**不加**（从升级那天起算，不追历史）。
 */
const COUNTER_CREDIT_COLUMNS = [
  (handle) => addColumnIfMissing(handle, 'counters', 'daily_increment', 'INTEGER NOT NULL DEFAULT 6'),
  (handle) => addColumnIfMissing(handle, 'counters', 'last_credit_date', 'TEXT'),
];

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
  // v4 → v5：桌面计数器。只加一张新表，不动任何已有表。
  4: COUNTER_TABLES,
  // v5 → v6：计数器「每天自动加」。见 COUNTER_CREDIT_COLUMNS 上那段注释
  // —— 为什么这两列不是普通 SQL 字符串。
  5: COUNTER_CREDIT_COLUMNS,
  // v6 → v7：日程集颜色 + 用户昵称。追加列，老数据回退默认值。
  6: [
    (handle) => addColumnIfMissing(handle, 'users', 'nickname', 'TEXT'),
    (handle) => addColumnIfMissing(handle, 'calendars', 'color', "TEXT NOT NULL DEFAULT 'jade'"),
  ],
  // v7 → v8：打卡改成按用户私有（每人一个不出现在列表里的 `kind='habits'` 集）。
  // 这一步**会动已有数据**（把共享集里的打卡搬到各人的私有集），见
  // migrateHabitsToPersonal 上面那整段理由。除此之外只加一列。
  7: [
    (handle) => addColumnIfMissing(handle, 'calendars', 'kind', "TEXT NOT NULL DEFAULT 'normal'"),
    (handle) => migrateHabitsToPersonal(handle),
  ],
  // v8 → v9：每日流程（2026-11-07）。只加一张表，不动任何已有表 ——
  // 老账号打开新版本时这张表是空的，第一次打开「每日流程」就按模板生成当天清单。
  8: FLOW_TABLES,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  nickname   TEXT,
  salt       TEXT    NOT NULL,
  hash       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS calendars (
  id         TEXT PRIMARY KEY,
  name       TEXT    NOT NULL,
  owner_id   TEXT    NOT NULL,
  color      TEXT    NOT NULL DEFAULT 'jade',
  -- 'normal' = 用户看得见的日程集；'habits' = 每个人的私有「打卡集」，
  -- 只装自己的打卡、不出现在任何集列表里（见 v8 迁移那段）。
  kind       TEXT    NOT NULL DEFAULT 'normal',
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

/** 建库语句 = v2 那七张 + v3 追加的三张 + v5 的计数器 */
const FULL_SCHEMA = SCHEMA + AI_TABLES.join(';\n\n') + ';\n' + COUNTER_TABLES.join(';\n\n') + ';\n'
  + FLOW_TABLES.join(';\n\n') + ';\n';

/** 旧 schema 的全部表名 —— 库是空的时候用来推倒重建 */
const ALL_TABLES = [
  'users', 'calendars', 'calendar_members', 'invites',
  'field_state', 'changes', 'revoked',
  'ai_settings', 'ai_sessions', 'ai_messages',
  'ai_memory', 'ai_authorizations',
  'counters', 'flow_docs',
];

module.exports = {
  SCHEMA_VERSION, AI_TABLES, MIGRATIONS, SCHEMA, FULL_SCHEMA, ALL_TABLES, HABITS_CAL_NAME,
};
