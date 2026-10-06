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
 * 这个文件只做三件事：解析请求、查权限、把活派给 lib/ 下的模块。
 * 业务判断一律不在路由层写 —— 权限尤其（只有 calendars.canWrite/canManage 两处）。
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
const calendars = require('./lib/calendars');
const invites = require('./lib/invites');
const rl = require('./lib/ratelimit');

const DATA_DIR = process.env.SCHEDULE_DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 25692);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 16 * 1024 * 1024;   // 首次导入历史数据可能一次推几千条 op

/** 自助注册是开放的，给个上限，免得被刷成垃圾账户库。家庭场景用不到 200 */
const MAX_USERS = Number(process.env.MAX_USERS || 200);

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

/* ---------------------------------------------------------------- 处理器 */

const handlers = {

  'GET /api/health': () => ({ status: 200, body: { ok: true, time: Date.now() } }),

  /**
   * 自助注册。**开放**，没有管理员、没有邀请码。
   *
   * 建账户与建默认日程集在同一个事务里 —— 半途失败会留下一个没有集的账户，
   * 而那种账户一进去就是白屏，也没有任何入口能自救。
   */
  'POST /api/auth/register': (ctx) => {
    const ip = rl.clientIp(ctx.req);
    const limited = rl.hitBoth([`reg:${ip}`], 10, 3600 * 1000);
    if (!limited.ok) return tooMany(limited);

    const name = String(ctx.body.name || '').trim();
    const password = String(ctx.body.password || '');

    const np = auth.nameProblem(name);
    if (np) return { status: 400, body: { error: np } };
    const pp = auth.passwordProblem(password);
    if (pp) return { status: 400, body: { error: pp } };
    if (db.countUsers() >= MAX_USERS) {
      return { status: 403, body: { error: `本服务器账户数已达上限（${MAX_USERS}）` } };
    }

    const { salt, hash } = auth.hashPassword(password);
    const user = {
      id: crypto.randomUUID(), name, salt, hash,
      createdAt: Date.now(),
    };
    try {
      db.tx(() => {
        // 事务内再查一次：两个请求同时到达时，第二个会在这里被唯一索引挡住
        db.insertUser(user);
        calendars.ensureHasCalendar(user.id);
      });
    } catch (_) {
      return { status: 409, body: { error: '用户名已被占用' } };
    }

    return {
      status: 200,
      // 回读一次再序列化：publicUser 读的是库里的 snake_case 形状（created_at），
      // 把入参对象（camelCase createdAt）直接喂进去会得到一个 null
      body: { token: issueToken(user), user: publicUser(db.findUserById(user.id)) },
    };
  },

  'POST /api/auth/login': (ctx) => {
    const ip = rl.clientIp(ctx.req);
    const name = String(ctx.body.name || '').trim();
    const password = String(ctx.body.password || '');

    // 两个键分开记：只按 IP 记，同一栋楼里一个人被锁全家进不来；
    // 只按用户名记，换个名字就能继续试。任一超限就挡。
    const key = `login:${ip}|${name}`;
    const limited = rl.hitBoth([`login-ip:${ip}`, key], 20, 15 * 60 * 1000);
    if (!limited.ok) return tooMany(limited);

    const u = db.findUserByName(name);

    // 账户不存在时也跑一遍 scrypt —— 否则响应时间会泄露「这个用户名存不存在」
    const ok = u
      ? auth.verifyPassword(password, u.salt, u.hash)
      : (auth.hashPassword(password, '0'.repeat(32)), false);

    if (!ok) return { status: 401, body: { error: '用户名或密码不对' } };
    rl.clear(key);

    // 上次退出 / 集被删之后可能一个集都不剩了，登录时补上
    calendars.ensureHasCalendar(u.id);
    return { status: 200, body: { token: issueToken(u), user: publicUser(u) } };
  },

  'POST /api/auth/logout': (ctx, me) => {
    db.revokeJti(me.payload.jti, me.payload.exp);
    return { status: 200, body: { ok: true } };
  },

  /**
   * 改口令。
   *
   * **当前这台保留登录**（用户改完密码不该被自己踢出去），
   * **其他设备上的旧票全部作废** —— 这是改密码最主要的目的。
   *
   * 截止时间 = **这一刻的 `Date.now()`**，不是手上这只票的 `iat`。
   *
   * 用 `iat` 会漏票：判据是「截止时间 > iat 才作废」，而「另一台设备在改口令
   * 之前几毫秒又登了一次」拿到的票，iat 比手上这只**还大**，判据压根管不到它 ——
   * 而它恰恰是这次要作废的目标。用「这一刻」就把所有**已经签出去**的票
   * 一网打尽，一个都不漏。
   *
   * 手上这只也作废（它的 iat 一定 < 截止时间）。**用户不会被踢出去**：
   * 响应里带回一只新 token，客户端换上就继续了（`api.changePassword` 里做这一步），
   * 用户感知不到替换。
   *
   * 顺序很要紧：**取截止时间要排在 `issueToken` 之前**，否则新签发的那只
   * iat 可能 ≤ 截止时间，被自己这一刀砍掉。中间隔着一次 scrypt，正常都是
   * 差几十毫秒，但靠「正常」不算数。
   *
   * `pruneRevoked` 不会把这条记录删掉 —— `expires_at` 是 `cutoff + TOKEN_TTL_MS`，
   * 不是 cutoff（见 db.revokeBefore）。
   *
   * 返回**新 token**：客户端换上就能继续用，不必退出再登录一次。
   */
  'POST /api/auth/password': (ctx, me) => {
    const ip = rl.clientIp(ctx.req);
    // 改口令要试旧密码，所以限速口径和登录一样（IP + 用户名两头都记）
    const limited = rl.hitBoth([`pw-ip:${ip}`, `pw:${me.user.id}`], 10, 15 * 60 * 1000);
    if (!limited.ok) return tooMany(limited);

    const oldPassword = String(ctx.body.oldPassword || '');
    const newPassword = String(ctx.body.newPassword || '');

    const bad = auth.passwordProblem(newPassword);
    if (bad) return { status: 400, body: { error: bad } };
    if (!auth.verifyPassword(oldPassword, me.user.salt, me.user.hash)) {
      return { status: 401, body: { error: '当前密码不对' } };
    }

    const { salt, hash } = auth.hashPassword(newPassword);
    db.updateUserPassword(me.user.id, salt, hash);
    // 截止时间必须取在 issueToken 之前，顺序反了会把新发的那只一起砍掉
    const cutoff = Date.now();
    db.revokeBefore(me.user.id, cutoff, auth.TOKEN_TTL_MS);
    const u = db.findUserById(me.user.id);
    return { status: 200, body: { ok: true, token: issueToken(u), user: publicUser(u) } };
  },

  /** 客户端启动只发这一个请求就能拿到全部所需：我是谁、我有哪些集、谁邀请了我 */
  'GET /api/me': (ctx, me) => {
    calendars.ensureHasCalendar(me.user.id);
    return {
      status: 200,
      body: {
        user: publicUser(me.user),
        cals: calendars.listMine(me.user.id),
        invites: invites.listFor(me.user.id),
      },
    };
  },

  /* ------------------------------------------------------------ 日程集 */

  'GET /api/cals': (ctx, me) => ({
    status: 200,
    body: { cals: calendars.listMine(me.user.id) },
  }),

  'POST /api/cals': (ctx, me) => calendars.create(me.user.id, ctx.body.name),

  'PATCH /api/cals/:calId': (ctx, me) =>
    calendars.rename(ctx.params.calId, me.user.id, ctx.body.name),

  'DELETE /api/cals/:calId': (ctx, me) =>
    calendars.remove(ctx.params.calId, me.user.id),

  'POST /api/cals/:calId/leave': (ctx, me) =>
    calendars.leave(ctx.params.calId, me.user.id),

  /** 成员名单 + 我发出去还没被接受的邀请（前端要在同一块里显示两种状态） */
  'GET /api/cals/:calId/members': (ctx, me) => {
    const calId = ctx.params.calId;
    const role = db.roleOf(calId, me.user.id);
    if (!role) return { status: 404, body: { error: '没有这个日程集' } };

    const pending = invites.listSent(me.user.id).filter((i) => i.calId === calId);
    return { status: 200, body: { members: calendars.members(calId), invites: pending, myRole: role } };
  },

  'PATCH /api/cals/:calId/members/:userId': (ctx, me) =>
    calendars.setRole(ctx.params.calId, me.user.id, ctx.params.userId, ctx.body.role),

  'DELETE /api/cals/:calId/members/:userId': (ctx, me) =>
    calendars.kick(ctx.params.calId, me.user.id, ctx.params.userId),

  /* -------------------------------------------------------------- 邀请 */

  /** 发邀请。只有 owner 能发（canManage 的语义）。 */
  'POST /api/cals/:calId/invites': (ctx, me) => {
    const calId = ctx.params.calId;
    const role = db.roleOf(calId, me.user.id);
    if (!role) return { status: 404, body: { error: '没有这个日程集' } };
    if (!calendars.canManage(role)) return { status: 403, body: { error: '只有创建者能邀请成员' } };

    // 这个接口会回答「某个用户名存不存在」，所以要比别处更严
    const limited = rl.hitBoth([`invite:${rl.clientIp(ctx.req)}`], 30, 3600 * 1000);
    if (!limited.ok) return tooMany(limited);

    return invites.create(calId, me.user.id, ctx.body.name, ctx.body.role);
  },

  'GET /api/cals/:calId/invites': (ctx, me) => {
    const calId = ctx.params.calId;
    if (!db.roleOf(calId, me.user.id)) return { status: 404, body: { error: '没有这个日程集' } };
    return { status: 200, body: { invites: invites.listSent(me.user.id).filter((i) => i.calId === calId) } };
  },

  'GET /api/invites': (ctx, me) => ({
    status: 200,
    body: { invites: invites.listFor(me.user.id) },
  }),

  'POST /api/invites/:inviteId/accept': (ctx, me) =>
    invites.accept(ctx.params.inviteId, me.user.id),

  'POST /api/invites/:inviteId/decline': (ctx, me) =>
    invites.decline(ctx.params.inviteId, me.user.id),

  /** 撤回：发出的人，或者这个集的 owner（判断在 invites.revoke 里） */
  'DELETE /api/invites/:inviteId': (ctx, me) =>
    invites.revoke(ctx.params.inviteId, me.user.id),

  /* -------------------------------------------------------------- 同步 */

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
      // 这两句之间没有 await，Node 又是单线程，所以不存在「写完快照、
      // 游标却跳到写入之后」的缝隙，不必额外加锁。
      state = { cursor: db.maxSeq(), snapshot: sync.snapshot(userId) };
    }

    // cals / invites 每次同步都带回来：轮询顺带发现「有人邀请我」和
    // 「我被拉进了一个新集」，不用刷新页面
    return {
      status: 200,
      body: {
        ...state, applied, rejected,
        cals: calendars.listMine(userId),
        invites: invites.listFor(userId),
      },
    };
  },
};

/* ---------------------------------------------------------------- 路由 */

/** 把 '/api/cals/:calId/members' 编译成正则 + 参数名。静态段要转义。 */
function compile(pattern) {
  const names = [];
  const body = pattern.split('/').map((seg) => {
    if (seg.startsWith(':')) {
      names.push(seg.slice(1));
      return '([^/]+)';
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { rx: new RegExp(`^${body}$`), names };
}

const PUBLIC = new Set(['GET /api/health', 'POST /api/auth/register', 'POST /api/auth/login']);

const ROUTES = Object.keys(handlers).map((key) => {
  const at = key.indexOf(' ');
  return {
    key,
    method: key.slice(0, at),
    ...compile(key.slice(at + 1)),
    needsAuth: !PUBLIC.has(key),
    // 静态段排在参数段前面：将来出现 GET /api/cals/:calId 与
    // GET /api/cals/mine 这种组合时，静态的那个先被匹配到
    isParam: key.includes('/:'),
  };
}).sort((a, b) => Number(a.isParam) - Number(b.isParam));

function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    for (let i = 0; i < r.names.length; i += 1) {
      try {
        params[r.names[i]] = decodeURIComponent(m[i + 1]);
      } catch (_) {
        return null;   // 百分号编码坏了，当作没匹配上
      }
    }
    return { ...r, params };
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
      const out = handlers[route.key]({ req, res, body, params: route.params }, me);
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
    console.log(`账户数    ${db.countUsers()}（开放注册，上限 ${MAX_USERS}）`);
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
