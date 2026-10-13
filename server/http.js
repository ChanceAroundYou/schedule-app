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

/* ---------- CORS ----------
 *
 * 后端原本**一行 CORS 都没有** —— 网页版走 nginx 同源代理，用不上。
 * 打包成 App 之后就不一样了：Capacitor 的 WebView 源是 `https://localhost`
 * （不是 `/schedule/`），请求是跨域的。
 *
 * **按来源白名单放行，不放 `*`。** 理由是这里带的不是 cookie 而是
 * `Authorization: Bearer`，一旦放开任意来源，任何网页都能拿用户自己填的票
 * 去读他的日程。默认只认打包 App 那几个源，要加走 `SCHEDULE_CORS_ORIGINS`
 * （逗号分隔）。
 */
const DEFAULT_CORS = ['https://localhost', 'capacitor://localhost', 'http://localhost'];
const CORS_ORIGINS = new Set([
  ...DEFAULT_CORS,
  ...String(process.env.SCHEDULE_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]);

const CORS_HEADERS = 'Content-Type, Authorization';
const CORS_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

/**
 * 认下这个来源。`send()` 会把结果拼进响应头 —— 不在这里直接 setHeader，
 * 是因为 `send()` 用的是 `writeHead(obj)`，合并规则不好依赖。
 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !CORS_ORIGINS.has(origin)) return false;
  res.__cors = origin;
  return true;
}

/** OPTIONS 预检：带 Authorization 的请求浏览器一定会先发一次 */
function preflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  if (applyCors(req, res)) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin,
      'Access-Control-Allow-Headers': CORS_HEADERS,
      'Access-Control-Allow-Methods': CORS_METHODS,
      Vary: 'Origin',
    });
  } else {
    res.writeHead(204);
  }
  res.end();
  return true;
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (res.__cors) {
    headers['Access-Control-Allow-Origin'] = res.__cors;
    headers['Access-Control-Allow-Headers'] = CORS_HEADERS;
    headers['Access-Control-Allow-Methods'] = CORS_METHODS;
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
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

module.exports = { send, readBody, currentUser, issueToken, publicUser, tooMany, applyCors, preflight };