/**
 * routes/auth.js —— 账户这一组：健康检查、注册、登录、登出、改口令、/api/me
 *
 * **这些 handler 只做三件事**：限流、把参数洗成合法形状、把活派给 lib/。
 * 口令怎么存、token 怎么签在 lib/auth；用户行怎么写、撤销表怎么查在 lib/db。
 * 路由层**不写业务判断**，密码尤其 —— 它只决定「什么时候拒绝」。
 *
 * 限流的三个键是各有一处的理由，别合并：
 *   - 注册只按 IP：一个人可以注册很多账户，但那是从这台机器来的；
 *   - 登录 **IP 和用户名分开记**：只按 IP 记，同一栋楼里一个人被锁全家进不来；
 *     只按用户名记，换个名字就能继续试。任一超限就挡（rl.hitBoth）。
 *   - 改口令跟登录一个口径，因为它同样要试旧密码。
 */
'use strict';

const crypto = require('node:crypto');

const db = require('../lib/db');
const auth = require('../lib/auth');
const calendars = require('../lib/calendars');
const invites = require('../lib/invites');
const rl = require('../lib/ratelimit');
const { MAX_USERS } = require('../config');
const { tooMany, issueToken, publicUser } = require('../http');

module.exports = {

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
    const nickname = ctx.body.nickname != null ? String(ctx.body.nickname).trim() : null;

    const np = auth.nameProblem(name);
    if (np) return { status: 400, body: { error: np } };
    const pp = auth.passwordProblem(password);
    if (pp) return { status: 400, body: { error: pp } };
    const nkp = auth.nicknameProblem(nickname);
    if (nkp) return { status: 400, body: { error: nkp } };
    if (db.countUsers() >= MAX_USERS) {
      return { status: 403, body: { error: `本服务器账户数已达上限（${MAX_USERS}）` } };
    }

    const { salt, hash } = auth.hashPassword(password);
    const user = {
      id: crypto.randomUUID(), name, nickname, salt, hash,
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
  'PATCH /api/me': (ctx, me) => {
    if (ctx.body && ctx.body.nickname !== undefined) {
      const nickname = ctx.body.nickname == null ? null : String(ctx.body.nickname).trim();
      const nkp = auth.nicknameProblem(nickname);
      if (nkp) return { status: 400, body: { error: nkp } };
      db.updateUserNickname(me.user.id, nickname);
    }
    return {
      status: 200,
      body: { user: publicUser(db.findUserById(me.user.id)) },
    };
  },
};