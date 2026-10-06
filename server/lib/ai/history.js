/**
 * ai/history.js —— 操作历史
 *
 * 所有写进 changes 表的改动都在这里，AI 执行的（device_id='ai'）有特殊标记。
 * 数据来自 changes 表，按 seq 倒序。
 */
'use strict';

const db = require('../db');

/** 给前端的一条历史记录 */
function shape(row) {
  return {
    seq: Number(row.seq),
    calId: row.cal_id,
    calName: row.cal_name || null,
    entity: row.entity,
    entityId: row.entity_id,
    field: row.field,
    value: row.value,
    ts: Number(row.ts),
    deviceId: row.device_id,
    isAi: row.device_id === 'ai',
  };
}

/**
 * @param {string} userId
 * @param {object} [opts] { aiOnly?: boolean, limit?: number }
 */
function list(userId, opts = {}) {
  const calIds = db.calendarIdsFor(userId);
  if (!calIds.length) return { status: 200, body: { history: [] } };

  const placeholders = calIds.map(() => '?').join(',');
  const params = [...calIds];
  let where = `cal_id IN (${placeholders})`;

  if (opts.aiOnly) {
    where += ` AND device_id = 'ai'`;
  }

  const limit = Math.min(Number(opts.limit) || 200, 500);
  params.push(limit);

  const rows = db.all(
    `SELECT c.seq, c.cal_id, c.entity, c.entity_id, c.field, c.value, c.ts, c.device_id,
            cal.name AS cal_name
     FROM changes c
     LEFT JOIN calendars cal ON cal.id = c.cal_id
     WHERE ${where}
     ORDER BY c.seq DESC
     LIMIT ?`,
    ...params,
  );

  return { status: 200, body: { history: rows.map(shape) } };
}

module.exports = { list };
