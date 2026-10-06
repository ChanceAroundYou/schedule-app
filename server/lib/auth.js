/**
 * auth.js —— 口令散列 + 自签 JWT（零外部依赖）
 *
 * 散列用 scrypt 而不是 sha256(salt+password)：账本那份是 sha256，但那是对
 * 单用户本地场景够用。这里口令要过公网，scrypt 的 ~80ms 计算成本让暴力枚举
 * 直接贵三个数量级，代价只是登录慢几十毫秒。
 *
 * JWT 手签而不是引库：HS256 就是 base64url + HMAC-SHA256，node:crypto 全有。
 * 多带一个 jti，登出时进吊销表 —— 无状态 token 唯一的缺口就是「签出去就收不
 * 回来」，jti 补上这个口子。
 */
'use strict';

const crypto = require('node:crypto');

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const SCRYPT_KEYLEN = 64;

/* ------------------------------------------------------------------ 口令 */

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, SCRYPT_KEYLEN).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, expectedHex) {
  const actual = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  let expected;
  try {
    expected = Buffer.from(String(expectedHex), 'hex');
  } catch (_) {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** 口令强度下限。家庭场景不搞复杂度规则，只挡「123456」这一档。 */
function passwordProblem(password) {
  const s = String(password || '');
  if (s.length < 6) return '密码至少 6 位';
  if (s.length > 200) return '密码过长';
  if (/^\d+$/.test(s)) return '密码不能全是数字';
  return null;
}

function nameProblem(name) {
  const s = String(name || '').trim();
  if (s.length < 1) return '用户名不能为空';
  if (s.length > 32) return '用户名最长 32 字';
  if (/[\s\u0000-\u001f]/.test(s)) return '用户名不能含空白或控制字符';
  return null;
}

/* ------------------------------------------------------------------- JWT */

function b64u(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload, secret) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(head + '.' + body).digest('base64url');
  return head + '.' + body + '.' + sig;
}

/** 验签 + 有效期。任何一步不对都返回 null，调用方只需要判空。 */
function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;

  const expect = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest('base64url');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (typeof payload.sub !== 'string' || !payload.sub) return null;
  if (typeof payload.jti !== 'string' || !payload.jti) return null;
  return payload;
}

function newJti() {
  return crypto.randomUUID();
}

module.exports = {
  TOKEN_TTL_MS,
  hashPassword, verifyPassword, passwordProblem, nameProblem,
  signToken, verifyToken, newJti,
};
