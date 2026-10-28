/**
 * users.js —— 账户表读写
 */

const { run, get } = require('./connection.js');

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
  run('INSERT INTO users (id, name, nickname, salt, hash, created_at) VALUES (?,?,?,?,?,?)',
    u.id, u.name, u.nickname || null, u.salt, u.hash, u.createdAt);
  return u;
}

function updateUserNickname(userId, nickname) {
  return run('UPDATE users SET nickname = ? WHERE id = ?', nickname == null ? null : String(nickname).trim(), String(userId));
}
function updateUserPassword(userId, salt, hash) {
  return run('UPDATE users SET salt = ?, hash = ? WHERE id = ?', salt, hash, String(userId));
}

module.exports = {
  countUsers, findUserByName, findUserById, insertUser, updateUserPassword, updateUserNickname,
};
