/**
 * server.js —— 日程清单后端（Node 22 + node:sqlite，零 npm 依赖）
 *
 * 只提供 /api/*。静态文件交给 nginx（见 ../deploy/schedule.conf），
 * 这样前端构建产物和后端进程各自独立，前端改样式不用重启服务。
 *
 * 启动：
 *   node server.js                 # 默认 127.0.0.1:25692
 *   PORT=8080 node server.js
 *   SCHEDULE_DATA_DIR=/data node server.js
 *
 * 对外暴露的接口一览见 ../docs/接口.md。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const db = require('./lib/db');
const auth = require('./lib/auth');
const sync = require('./lib/sync');

const DATA_DIR = process.env.SCHEDULE_DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 25692);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 16 * 1024 * 1024;   // 首次导入历史数据可能一次推几千条 op

/* ------------------------------------------------------------------ 启动 */

/**
 * 签名密钥落盘保存。每次重启重新生成的话，所有已签发的 token 会集体失效，
 * 表现是「用着用着突然被登出」。
 */
function loadSecret() {
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch (_) { /* 首次运行，下面生成 */ }
  const s = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

const SECRET = loadSecret();

/* -------------------------------------------------------------- HTTP 工具 */

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

/* ---------------------------------------------------------------- 鉴权 */

function currentUser(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const payload = auth.verifyToken(m[1], SECRET);
  if (!payload) return null;
  if (db.isRevoked(payload.jti)) return null;      // 已登出
  const user = db.findUserById(payload.sub);
  if (!user) return null;
  return { payload, user };
}

function issueToken(user) {
  const now = Date.now();
  return auth.signToken({
    sub: user.id,
    name: user.name,
    adm: !!user.is_admin,
    iat: now,
    exp: now + auth.TOKEN_TTL_MS,
    jti: auth.newJti(),
  }, SECRET);
}

function publicUser(u) {
  return { id: u.id, name: u.name, isAdmin: !!u.is_admin, createdAt: Number(u.created_at) };
}

/* ---------------------------------------------------------------- 处理器 */

const handlers = {

  'GET /api/health': () => ({ status: 200, body: { ok: true, time: Date.now() } }),

  /** 登录页据此决定显示「登录」还是「创建第一个账户」 */
  'GET /api/auth/state': () => ({
    status: 200,
    body: { hasUsers: db.countUsers() > 0 },
  }),

  'POST /api/auth/register': (ctx) => {
    const name = String(ctx.body.name || '').trim();
    const password = String(ctx.body.password || '');

    const np = auth.nameProblem(name);
    if (np) return { status: 400, body: { error: np } };
    const pp = auth.passwordProblem(password);
    if (pp) return { status: 400, body: { error: pp } };

    // 只有一台空服务器才允许自助注册 —— 开放注册等于把日程本挂在公网
    if (db.countUsers() > 0) {
      return { status: 403, body: { error: '已存在账户，请由管理员在设置里创建' } };
    }

    const { salt, hash } = auth.hashPassword(password);
    const user = {
      id: crypto.randomUUID(), name, salt, hash,
      isAdmin: true, createdAt: Date.now(),
    };
    // 事务内再查一次：两个请求同时到达时，第二个会在这里被挡住
    try {
      db.tx(() => {
        if (db.countUsers() > 0) {
          const e = new Error('已有账户');
          e.status = 403;
          throw e;
        }
        db.insertUser(user);
      });
    } catch (e) {
      return { status: e.status || 500, body: { error: e.status ? e.message : '创建失败' } };
    }

    return {
      status: 200,
      // 回读一次再序列化：publicUser 读的是库里的 snake_case 形状（created_at），
      // 把入参对象（camelCase createdAt）直接喂进去会得到一个 null
      body: { token: issueToken(user), user: publicUser(db.findUserById(user.id)) },
    };
  },

  'POST /api/auth/login': (ctx) => {
    const name = String(ctx.body.name || '').trim();
    const password = String(ctx.body.password || '');
    const u = db.findUserByName(name);

    // 账户不存在时也跑一遍 scrypt —— 否则响应时间会泄露「这个用户名存不存在」
    const ok = u
      ? auth.verifyPassword(password, u.salt, u.hash)
      : (auth.hashPassword(password, '0'.repeat(32)), false);

    if (!ok) return { status: 401, body: { error: '用户名或密码不对' } };
    return { status: 200, body: { token: issueToken(u), user: publicUser(u) } };
  },

  'POST /api/auth/logout': (ctx, me) => {
    db.revokeJti(me.payload.jti, me.payload.exp);
    return { status: 200, body: { ok: true } };
  },

  'GET /api/users': (ctx, me) => {
    if (!me.user.is_admin) return { status: 403, body: { error: '需要管理员权限' } };
    return { status: 200, body: { users: db.listUsers().map(publicUser) } };
  },

  'POST /api/users': (ctx, me) => {
    if (!me.user.is_admin) return { status: 403, body: { error: '需要管理员权限' } };
    const name = String(ctx.body.name || '').trim();
    const password = String(ctx.body.password || '');
    const np = auth.nameProblem(name);
    if (np) return { status: 400, body: { error: np } };
    const pp = auth.passwordProblem(password);
    if (pp) return { status: 400, body: { error: pp } };
    if (db.findUserByName(name)) return { status: 409, body: { error: '用户名已存在' } };

    const { salt, hash } = auth.hashPassword(password);
    const user = {
      id: crypto.randomUUID(), name, salt, hash,
      isAdmin: false, createdAt: Date.now(),
    };
    try {
      db.insertUser(user);
    } catch (_) {
      return { status: 409, body: { error: '用户名已存在' } };
    }
    return { status: 200, body: { user: publicUser(db.findUserById(user.id)) } };
  },

  /* ------------------------------------------------------------ 同步 */

  'POST /api/sync': (ctx, me) => {
    const userId = me.user.id;
    const body = ctx.body || {};
    const cursorIn = Number(body.cursor || 0);

    // 先落盘再取数：快照必须反映「本批 op 合并之后」的真值，
    // 否则客户端会拿一个慢半拍的快照把自己的写入盖回去。
    const { applied, rejected } = sync.applyOps(userId, body.ops);

    let state;
    if (cursorIn > 0) {
      const p = sync.pull(userId, cursorIn);
      state = { cursor: p.cursor, changes: p.changes, truncated: p.truncated };
    } else {
      state = { cursor: db.maxSeq(userId), snapshot: sync.snapshot(userId) };
    }

    return { status: 200, body: { ...state, applied, rejected } };
  },
};

/* ---------------------------------------------------------------- 路由 */

const ROUTES = Object.keys(handlers).map((key) => {
  const [method, routePath] = key.split(' ');
  return { method, path: routePath, key, needsAuth: routePath !== '/api/health' && routePath !== '/api/auth/state' && routePath !== '/api/auth/login' && routePath !== '/api/auth/register' };
});

function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method === method && r.path === pathname) return r;
  }
  return null;
}

function createServer() {
  return http.createServer(async (req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      return send(res, 400, { error: '请求地址非法' });
    }

    // 规范化：末尾斜杠统一去掉（/api/sync/ 与 /api/sync 等价）
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

    const route = matchRoute(req.method, pathname);
    if (!route) return send(res, 404, { error: '接口不存在' });

    let me = null;
    if (route.needsAuth) {
      me = currentUser(req);
      if (!me) return send(res, 401, { error: '登录状态已失效，请重新登录' });
    }

    let body = {};
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        return send(res, e.status || 400, { error: e.message || '读取请求体失败' });
      }
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch (_) {
          return send(res, 400, { error: '请求体不是合法 JSON' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return send(res, 400, { error: '请求体必须是 JSON 对象' });
        }
      }
    }

    try {
      const out = handlers[route.key]({ req, res, body }, me);
      return send(res, out.status, out.body);
    } catch (e) {
      // 不外泄堆栈：它可能带着库文件路径
      console.error(`[${route.key}]`, e && e.message ? e.message : e);
      return send(res, 500, { error: '服务器内部错误' });
    }
  });
}

/* ------------------------------------------------------------------ 入口 */

function main() {
  db.open(DATA_DIR);
  db.pruneRevoked();

  const timer = setInterval(() => {
    try { db.pruneRevoked(); } catch (_) { /* 下次再说 */ }
  }, 6 * 3600 * 1000);
  timer.unref();

  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`日程清单后端已启动  http://${HOST}:${PORT}`);
    console.log(`数据目录  ${DATA_DIR}`);
    console.log(`数据库    ${db.file()}`);
    console.log(`账户数    ${db.countUsers()}${db.countUsers() === 0 ? '（首个注册者将成为管理员）' : ''}`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();

module.exports = { createServer, loadSecret, DATA_DIR };
