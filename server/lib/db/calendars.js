/**
 * calendars.js —— 日程集与成员关系
 */

const { run, get, all } = require('./connection.js');

const ROLES = new Set(['owner', 'editor', 'viewer']);

function insertCalendar(c) {
  run('INSERT INTO calendars (id, name, owner_id, color, created_at) VALUES (?,?,?,?,?)',
    c.id, c.name, c.ownerId, c.color || 'jade', c.createdAt);
  return c;
}

function setColorCalendar(id, color) {
  return run('UPDATE calendars SET color = ? WHERE id = ? AND deleted_at IS NULL', String(color), String(id));
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
    SELECT c.id, c.name, c.owner_id, c.color, c.created_at, m.role, m.joined_at
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
    SELECT m.user_id, m.role, m.joined_at, u.name, u.nickname
    FROM calendar_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.cal_id = ?
    ORDER BY m.joined_at
  `, String(calId));
}

/**
 * 「我可能遇到的所有人」—— 我那些集的全部成员去重。任务来源 tag 要查名字。
 *
 * 注意 join 的方向：**先按「我属于哪些集」挑集，再取这些集的全部成员**。
 * 写成 `WHERE m.user_id = ?` 会得到「只有我自己」—— 别人一个都不在目录里，
 * 于是所有来源 tag 都显示「?」，测试里那条「目录里有 mom」的断言就是钉这个的。
 *
 * 不含已删除的集；也不含没和我共享任何集的人 —— 目录不是全站用户名表，
 * 只暴露「和我同一个集的人」。
 */
function directoryFor(userId) {
  return all(`
    SELECT DISTINCT u.id, u.name, u.nickname
    FROM calendar_members mine
    JOIN calendar_members m ON m.cal_id = mine.cal_id
    JOIN calendars c ON c.id = m.cal_id
    JOIN users u ON u.id = m.user_id
    WHERE mine.user_id = ? AND c.deleted_at IS NULL
  `, String(userId));
}

/** 有没有别的 owner —— 「最后一个所有者不能降级 / 不能退出」要用 */
function countOwners(calId) {
  return Number(get(
    "SELECT COUNT(*) AS n FROM calendar_members WHERE cal_id = ? AND role = 'owner'",
    String(calId),
  ).n);
}

module.exports = {
  ROLES,
  insertCalendar, findCalendar, renameCalendar, softDeleteCalendar,
  calendarsFor, calendarIdsFor, countCalendarsFor, roleOf,
  upsertMember, removeMember, membersOf, countOwners,
  setColorCalendar, directoryFor,
};
