/**
 * memory.js —— 跨对话记忆 + 每人的授权状态
 *
 * 两张 v4 加的表，都按 user_id 归属，不参与日程集的 LWW 同步。
 */
'use strict';

const { run, get, all } = require('./connection.js');

/* --------------------------------------------------------------- 记忆 */

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

/* --------------------------------------------------------------- 授权 */

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

module.exports = {
  MEMORY_MAX,
  insertMemory, listMemories, deleteMemory, touchMemories, pruneMemories,
  getAuthorizations, putAuthorizations,
};