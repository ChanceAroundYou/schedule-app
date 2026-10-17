/**
 * sync.js —— 同步核心：逐字段 LWW + 游标增量
 *
 * 为什么是「逐字段」而不是「整条任务」：
 *   整条任务做 LWW 的话，手机改标题、桌面改日期，后同步的那一方会把对方
 *   整个字段集覆盖掉——用户看到的是「我改的东西凭空没了」。逐字段比较的
 *   代码量几乎一样，但两个改动都能留下。
 *
 * 为什么不需要 oplog 做幂等：
 *   LWW 的比较键是 (ts, deviceId)，而这两样都由客户端在**创建 op 时固定**并
 *   持久化在发件箱里。同一条 op 重放时比较键完全相同 → 既不是 >、也不是同值
 *   下更大的 deviceId → ON CONFLICT 的 WHERE 不成立 → 一行都不改。
 *
 * 时间戳为什么既不钳制、也不上 HLC：
 *   钳制过一版，问题在于钳制值取决于「收到请求的那一刻」，同一条 op 重放两次
 *   会钳出两个不同的时间戳，于是幂等性当场破掉（重放被当成新改动）。
 *   所以改成**拒绝**：设备时钟与服务器差 24 小时以上，说明表本身是坏的，
 *   这种 op 退回并标记 code='clock'，客户端留着不丢、显示一条提示，
 *   等时钟校准后自然能推上来。这比静默压时间戳诚实，也不会假装问题不存在。
 *   24 小时以内的偏移仍然走 LWW —— 家庭场景就是几秒级抖动，
 *   真出问题时再升级到混合逻辑时钟，届时表结构不用动。
 *
 * 数据归属是**日程集**：每条 op 都带 calId，落库前进权限表。看不到的集与
 * 权限不够的集返回同一个 forbidden，不区分「不存在」和「不归你」—— 否则
 * 拿 id 扫一遍就能问出别人有哪些集。
 */
'use strict';

const db = require('./db');
const calendars = require('./calendars');

const ENTITIES = new Set(['task', 'habit', 'project']);

/** 派生 id 形如 `a3f2…#2026-10-07`，uuid 是 hex + 短横，都在这个字符集里 */
const ID_RE = /^[A-Za-z0-9_.:#@-]{1,200}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

const MAX_FIELD_BYTES = 64 * 1024;   // 单个字段的 JSON 上限
const MAX_OPS = 2000;                // 单次请求最多处理多少条 op
const MAX_PULL = 5000;               // 单次最多回吐多少条变更
const MAX_SKEW_MS = 24 * 3600 * 1000; // 设备时钟允许偏差多少

function safeParse(text) {
  try { return JSON.parse(text); } catch (_) { return text; }
}

/**
 * 返回 {code, reason} 表示非法，返回 null 表示合法。这里是信任边界，宁可严。
 *
 * code 决定客户端怎么处理：
 *   bad_request —— 这条 op 本身有问题，重试多少次都一样，客户端丢掉并报错
 *   clock       —— 只是设备时钟不对，改成正确时间后能成功，客户端留着重试
 *   forbidden   —— 没有这个集的写权限（只读 / 已被移除）。和 bad_request 一样
 *                  是终态，客户端丢掉并提示；真的被重新授权了，重做一次即可，
 *                  留一条几个月前的 op 悬在发件箱里反而会突然改掉别的东西。
 */
function validateOp(op, now) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return { code: 'bad_request', reason: 'op 不是对象' };
  if (typeof op.opId !== 'string' || !op.opId) return { code: 'bad_request', reason: 'opId 缺失' };
  if (typeof op.deviceId !== 'string' || !op.deviceId) return { code: 'bad_request', reason: 'deviceId 缺失' };
  if (op.deviceId.length > 64) return { code: 'bad_request', reason: 'deviceId 过长' };
  if (typeof op.calId !== 'string' || !ID_RE.test(op.calId)) return { code: 'bad_request', reason: 'calId 非法' };
  if (!ENTITIES.has(op.entity)) return { code: 'bad_request', reason: 'entity 非法: ' + String(op.entity) };
  if (typeof op.entityId !== 'string' || !ID_RE.test(op.entityId)) return { code: 'bad_request', reason: 'entityId 非法' };

  // 必须真的是数字：Number(null) 是 0，放过去的话这条 op 会以时间戳 0 落库
  if (typeof op.ts !== 'number' || !Number.isFinite(op.ts)) return { code: 'bad_request', reason: 'ts 非法' };
  if (Math.abs(op.ts - now) > MAX_SKEW_MS) {
    return { code: 'clock', reason: '设备时间与服务器相差超过 24 小时，请校准后再同步' };
  }

  const fields = op.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { code: 'bad_request', reason: 'fields 非法' };
  const keys = Object.keys(fields);
  if (!keys.length) return { code: 'bad_request', reason: 'fields 为空' };
  for (const k of keys) {
    if (!FIELD_RE.test(k)) return { code: 'bad_request', reason: '字段名非法: ' + k };
  }
  return null;
}

/**
 * 应用一批 op。
 * @returns {{applied: string[], rejected: {opId:string, code:string, reason:string}[]}}
 *   applied 里的 op 都已被**处理**（不保证胜出，只保证不会再重复生效），
 *   客户端据此把它们从发件箱里划掉。落败的字段会以对方的版本出现在本次
 *   响应附带拉取的 changes 里，客户端应用后自然收敛。
 */
/**
 * `repeatUntil` 的级联清理：把该系列在**结束日及以后**的实例标记删除。
 *
 * ## 为什么这件事必须由服务端做（2026-10-14 实测发现）
 *
 * 「从这次起往后全部」原本是发起端自己遍历**它手里的**实例去删的。问题在于
 * 发起端只知道它看得见的那一部分：
 *
 *   · 小组件拿到的是「今天 ±45 天」的快照，而这个快照是**上次同步时的**；
 *   · 同时 App 那边还在滚预生成窗口，会补出更远的实例。
 *
 * 实机验证就撞上了：小组件删掉了 10-16 起的实例，可 10-28 之后又冒出来 18 条
 * —— 谁都没写错，合起来就是「删不干净」。而且客户端啥时候再同步是不确定的，
 * 光靠「另一端下次同步时会自己清」不能保证收敛。
 *
 * 现在改成：**客户端只负责落标记**（root.repeatUntil = 结束日），服务端按标记
 * 广播删除。所有端（含以后新加入的设备）都通过普通增量同步拿到同一结果，
 * 不再依赖任何时序假设。
 *
 * 幂等：已经 deleted 的实例 `putField` 不会胜出 → 不记流水、重复调用无副作用。
 *
 * ⚠️ 2026-10-17：成员收集改成**两路并集**（用户报「全部删除只删了当天」）。
 * 实测数据里有一批实例的 seriesId 是坏的 —— ① 指向中间层实例（id 带两层
 * 日期段），② 整个缺失。只按 seriesId 字段单路收集会漏掉旁支，漏掉的那些
 * 过两天又被客户端的窗口补齐造回来。派生实例的 id 一定是
 * `${seriesId}#${发生日期}`，所以**只要 id 以 `真根 + '#'` 开头就是这个
 * 家族的**，不管 seriesId 字段写成什么。
 * 同理，`repeatUntil` 标记本身也可能不落在根上（客户端在根不在本机时会
 * 改写到存活成员身上），所以先把标记所在任务的**真根**解析出来再收集。
 */
function cascadeRepeatUntil(terms, now) {
  const SERVER_DEVICE = 'server';
  const calIds = [...new Set(terms.map((t) => t.calId))];
  const rows = db.allFields(calIds);

  /** entity_id -> seriesId */
  const seriesOf = new Map();
  /** entity_id -> date */
  const dateOf = new Map();
  /** 已经删掉的，跳过 */
  const gone = new Set();
  /** 这个库里的全部任务 id（形状路扫描用） */
  const taskIds = new Set();
  for (const r of rows) {
    if (r.entity !== 'task') continue;
    taskIds.add(r.entity_id);
    if (r.field === 'seriesId') seriesOf.set(r.entity_id, safeParse(r.value));
    else if (r.field === 'date') dateOf.set(r.entity_id, safeParse(r.value));
    else if (r.field === 'deleted' && r.value === 'true') gone.add(r.entity_id);
  }

  /**
   * 解析真根：**形状优先**，与客户端 seriesRootOf 同一口径。
   *   ① id 带 `#` → 真根是 `#` 前的部分（标记落在了派生实例 / 中间层上）；
   *   ② 否则顺着 seriesId 字段往上找（老数据、随机 id 的成员）；
   *   ③ 都断了 → 它自己就是根。
   * guard 防坏数据成环。
   */
  const trueRoot = (id) => {
    let cur = String(id);
    for (let guard = 0; guard < 8; guard++) {
      const hash = cur.indexOf('#');
      if (hash > 0) return cur.slice(0, hash);
      const sid = seriesOf.get(cur);
      // 只认真串：非字符串的脏值不跟，免得把 cur 变成非字符串后 indexOf 炸穿整批同步
      if (typeof sid === 'string' && sid && sid !== cur) { cur = sid; continue; }
      return cur;
    }
    return cur;
  };

  const mark = (calId, id, field, json) => {
    if (db.putField(calId, 'task', id, field, json, now, SERVER_DEVICE) > 0) {
      db.appendChange(calId, 'task', id, field, json, now, SERVER_DEVICE);
    }
  };

  for (const { seriesId, until, calId } of terms) {
    // 客户端可能传 null（把标记撤掉）—— 那时没有要清的
    if (typeof until !== 'string' || !until) continue;
    const root = trueRoot(seriesId);
    /** 属于这个系列的所有 id（含系列根本身、含旁支） */
    const ids = new Set([root]);
    // 形状路：id 以 `真根#` 开头 —— seriesId 字段坏了也照样收进来
    const prefix = root + '#';
    for (const id of taskIds) {
      if (id.startsWith(prefix)) ids.add(id);
    }
    // 字段路：老数据里随机 id 的成员只认 seriesId
    for (const [id, sid] of seriesOf) {
      if (sid === root) ids.add(id);
    }
    for (const id of ids) {
      if (gone.has(id)) continue;
      const d = dateOf.get(id);
      // 没有日期的（待办箱那种）不属于「某一天的重复」，跳过
      if (typeof d !== 'string' || d < until) continue;
      mark(calId, id, 'deleted', 'true');
      mark(calId, id, 'deletedAt', String(now));
      gone.add(id);
    }
  }
}

function applyOps(userId, ops) {
  const applied = [];
  const rejected = [];

  if (!Array.isArray(ops)) {
    return { applied, rejected: [{ opId: '', code: 'bad_request', reason: 'ops 不是数组' }] };
  }
  if (ops.length > MAX_OPS) {
    return { applied, rejected: [{ opId: '', code: 'bad_request', reason: `单次最多 ${MAX_OPS} 条 op` }] };
  }

  const now = Date.now();
  /** 这一批里落下 repeatUntil 的系列（循环结束后统一级联清理） */
  const terms = [];
  // 一批 op 往往集中在同一个集上，缓存一下别每条都查库。
  // 存的是「角色或 null」，null 也要缓存，否则被刷 id 时每次都查。
  const roleCache = new Map();
  const roleIn = (calId) => {
    if (!roleCache.has(calId)) roleCache.set(calId, db.roleOf(calId, userId));
    return roleCache.get(calId);
  };

  db.tx(() => {
    for (const raw of ops) {
      const problem = validateOp(raw, now);
      if (problem) {
        rejected.push({
          opId: (raw && typeof raw.opId === 'string') ? raw.opId : '',
          code: problem.code,
          reason: problem.reason,
        });
        continue;
      }
      if (!calendars.canWrite(roleIn(raw.calId))) {
        rejected.push({ opId: raw.opId, code: 'forbidden', reason: '这个日程集你没有修改权限' });
        continue;
      }

      const ts = raw.ts;
      for (const field of Object.keys(raw.fields)) {
        const value = raw.fields[field];
        const json = JSON.stringify(value === undefined ? null : value);
        if (Buffer.byteLength(json, 'utf8') > MAX_FIELD_BYTES) continue; // 超大字段静默丢弃，不拖垮整批
        // 只有真的胜出才记一条流水；落败的字段由对方那条流水负责广播
        if (db.putField(raw.calId, raw.entity, raw.entityId, field, json, ts, raw.deviceId) > 0) {
          db.appendChange(raw.calId, raw.entity, raw.entityId, field, json, ts, raw.deviceId);
        }
      }
      /* 「从这次起往后全部」：客户端只落一个 repeatUntil 标记，**清理由服务端做**
         （见 cascadeRepeatUntil 的说明）。先把这些系列记下来，循环结束后统一处理 ——
         同一批里可能有多个系列，合并成一次扫描。 */
      if (raw.entity === 'task' && Object.prototype.hasOwnProperty.call(raw.fields, 'repeatUntil')) {
        terms.push({ seriesId: raw.entityId, until: raw.fields.repeatUntil, calId: raw.calId });
      }
      applied.push(raw.opId);
    }

    if (terms.length) cascadeRepeatUntil(terms, now);
  });

  return { applied, rejected };
}

/**
 * 全量快照，只含我可见的集。两个时机用：首次登录／换设备，以及**新加入了一个集**。
 *
 * 后者容易被漏掉：游标是全局单调的，加入一个集时游标早就越过它历史的那些
 * 变更了，光靠增量永远拉不到这个集已有的内容。所以客户端一旦发现自己不认识
 * 的 calId，就得来要一次快照。
 *
 * 墓碑不进快照 —— 客户端要的是「现在还活着的东西」，不是删除史。
 */
function snapshot(userId) {
  const out = { tasks: {}, habits: {}, projects: {} };
  // 每条状态都带上它属于哪个集，客户端据此归位（也是上面那个「新集」判断的依据）
  for (const r of db.allFields(db.calendarIdsFor(userId))) {
    const bucket = r.entity === 'habit' ? out.habits
      : r.entity === 'project' ? out.projects
        : out.tasks;
    let e = bucket[r.entity_id];
    if (!e) e = bucket[r.entity_id] = { id: r.entity_id, calId: r.cal_id, _ts: {}, _dev: {} };
    e[r.field] = safeParse(r.value);
    e._ts[r.field] = Number(r.ts);
    e._dev[r.field] = r.device_id;
  }
  for (const bucket of [out.tasks, out.habits, out.projects]) {
    for (const id of Object.keys(bucket)) {
      if (bucket[id].deleted === true) delete bucket[id];
    }
  }
  return out;
}

/**
 * 自 cursor 之后的增量。返回 { cursor, changes, truncated }
 *
 * cursor 是**全局** seq，不是「我这个集里的第几条」：客户端因此只需要存一个
 * 数字。代价是别人在别的集里写东西会让这个游标往前走（下次拉到的就是空的），
 * 这是对的 —— 游标表达的是「我已经看到全世界第几号了」。
 */
function pull(userId, cursor) {
  const from = Number.isFinite(Number(cursor)) && Number(cursor) > 0 ? Number(cursor) : 0;
  const rows = db.changesSince(db.calendarIdsFor(userId), from, MAX_PULL);

  const changes = rows.map((r) => ({
    calId: r.cal_id,
    entity: r.entity,
    entityId: r.entity_id,
    field: r.field,
    value: safeParse(r.value),
    ts: Number(r.ts),
    deviceId: r.device_id,
  }));

  // 没被截断就直接跳到最新；被截断了就停在本批最后一条，客户端下一轮接着拉。
  // head 取全局最大值：空集时也要把游标推到当前水位，否则每次都要重扫一遍。
  const head = db.maxSeq();
  const next = rows.length === MAX_PULL ? Number(rows[rows.length - 1].seq) : head;
  return { cursor: next, changes, truncated: rows.length === MAX_PULL };
}

module.exports = { applyOps, snapshot, pull, validateOp, MAX_OPS };
