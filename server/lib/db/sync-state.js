/**
 * sync-state.js —— 逐字段状态与变更流水（LWW 同步的核心）
 */

const { run, get, all, handle } = require('./connection.js');

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

module.exports = { putField, maxSeq, appendChange, changesSince, allFields };
