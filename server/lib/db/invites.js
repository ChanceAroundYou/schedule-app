/**
 * invites.js —— 邀请。对方接受之后才写进 calendar_members
 */

const { run, get, all } = require('./connection.js');

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

module.exports = {
  insertInvite, findInvite, findPendingInvite, decideInvite,
  invitesFor, invitesSentBy, cancelPendingInvites,
};
