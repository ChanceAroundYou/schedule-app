/**
 * revoked.js —— 已登出的 jti，避免「登出后旧 token 还能用」
 *
 * 改口令也走这张表，占一行保留键 `'pw:<userId>'`，不为每个旧 jti 各占一行。
 */
'use strict';

const { run, get } = require('./connection.js');

function isRevoked(jti) {
  const row = get('SELECT expires_at FROM revoked WHERE jti = ?', String(jti));
  return !!row && Number(row.expires_at) > Date.now();
}

function revokeJti(jti, expiresAt) {
  run('INSERT OR REPLACE INTO revoked (jti, expires_at) VALUES (?, ?)', jti, expiresAt);
}

/** 清掉已过期的吊销记录，避免表无限增长 */
function pruneRevoked() {
  return run('DELETE FROM revoked WHERE expires_at <= ?', Date.now());
}

/**
 * 让某个用户在 cutoff 之前签发的 token 全部失效。
 *
 * **占一行保留键 `'pw:<userId>'`**，不为每个旧 jti 各占一行 —— 用户改一次密码，
 * 他手里可能攥着几十只旧 token，而服务器压根看不见那些 token，逐个枚举不可能。
 * 真 jti 是 UUID（hex + 短横），**永远不含 `:`**，所以不会和保留键撞车。
 *
 * `expires_at` 取 `cutoff + ttlMs` 而不是 cutoff：`pruneRevoked()` 会把已过期的
 * 行删掉，写成 cutoff 的话这条记录**当场就被清掉**，吊销等于没发生。
 *
 * `ttlMs` 由调用方传（server.js 的 `auth.TOKEN_TTL_MS`），写与读共用同一个值 ——
 * 两边各算各的必然漂，漂了之后读回来的截止时间就是错的，而且是静默错。
 */
function revokeBefore(userId, cutoff, ttlMs) {
  return run('INSERT OR REPLACE INTO revoked (jti, expires_at) VALUES (?, ?)',
    'pw:' + userId, cutoff + ttlMs);
}

/** 某个用户当前的口令截止时间。0 = 从没改过口令（也就是「全部有效」） */
function pwCutoffOf(userId, ttlMs) {
  const row = get('SELECT expires_at FROM revoked WHERE jti = ?', 'pw:' + userId);
  if (!row) return 0;
  return Math.max(0, Number(row.expires_at) - ttlMs);
}

module.exports = {
  isRevoked, revokeJti, pruneRevoked, revokeBefore, pwCutoffOf,
};