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
  run('INSERT INTO users (id, name, salt, hash, created_at) VALUES (?,?,?,?,?)',
    u.id, u.name, u.salt, u.hash, u.createdAt);
  return u;
}

/** 改口令。返回是否命中一行（id 是主键，命中就是 1） */
function updateUserPassword(userId, salt, hash) {
  return run('UPDATE users SET salt = ?, hash = ? WHERE id = ?', salt, hash, String(userId));
}

module.exports = {
  countUsers, findUserByName, findUserById, insertUser, updateUserPassword,
};
