/**
 * http.js —— 每条请求都要用到的三样东西
 *
 *   send()        统一的 JSON 回包
 *   readBody()    收请求体（带体积上限）
 *   currentUser() 从 Bearer 票里认出调用者
 *
 * 连同 issueToken / publicUser / tooMany（token 签发与限流回包）也在这。
 * 拆开的原因是这几个函数**互相咬合**：`send` 是 SSE 那条路的对照（见
 * lib/ai/sse.mjs），`currentUser` 出的 `me` 是每个 handler 的第二个参数。
 *
 * **JWT 验签不在这里做细活** —— 那是 lib/auth 的事，这里只做「票对不对 +
 * 这票还有效吗 + 这个人还在吗」这三层。见 currentUser 下面那段注释。
 */
'use strict';

const db = require('./lib/db');
const auth = require('./lib/auth');
const { MAX_BODY, SECRET } = require('./config');

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        const e = new Error('请求体过大');
        e.status = 413;
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function currentUser(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const payload = auth.verifyToken(m[1], SECRET);
  if (!payload) return null;
  if (db.isRevoked(payload.jti)) return null;      // 已登出
  // 改口令之后，截止时间之前签发的 token 全部作废。查一次表很便宜 ——
  // 这是**每一条**鉴权请求都要过的路，别为了省这一下把判断挪进各个 handler。
  // 没有 iat 的老 token 按 0 算：一旦有人改过口令，它们一起作废。
  const iat = typeof payload.iat === 'number' ? payload.iat : 0;
  if (db.pwCutoffOf(payload.sub, auth.TOKEN_TTL_MS) > iat) return null;
  const user = db.findUserById(payload.sub);
  if (!user) return null;
  return { payload, user };
}

function issueToken(user) {
  const now = Date.now();
  return auth.signToken({
    sub: user.id,
    name: user.name,
    iat: now,
    exp: now + auth.TOKEN_TTL_MS,
    jti: auth.newJti(),
  }, SECRET);
}

function publicUser(u) {
  return { id: u.id, name: u.name, createdAt: Number(u.created_at) };
}

/** 限流被挡时统一的回包 */
function tooMany(e) {
  return { status: 429, body: { error: `操作太频繁，请 ${e.retryAfter} 秒后再试` } };
}

module.exports = { send, readBody, currentUser, issueToken, publicUser, tooMany };