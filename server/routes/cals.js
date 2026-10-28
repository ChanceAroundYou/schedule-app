/**
 * routes/cals.js —— 日程集与邀请这一组
 *
 * **共享的单位是集，不是任务**（像相册）：没有「把这一条任务分享给某人」。
 * 所以这一组里所有的「谁能改」都问同一句 —— `db.roleOf(calId, me.user.id)`，
 * 之后一律转给 `calendars.canWrite / canManage`（那三个入口，见 AGENTS.md「二、不变量 · 权限」）。
 *
 * **别在别处写 `role === 'owner'`。** 这里也只写 `canManage(role)`。
 *
 * 权限本身在 lib/calendars.js 里判断（含「最后一个 owner 不能被降级 / 移出 /
 * 退出」那两条不变量）；路由层只在**根本没有这个集**时返 404，
 * 并对 body 字段做类型 / 长度 / 控制字符校验（见下面 badName / badRole）。
 */
'use strict';

const db = require('../lib/db');
const calendars = require('../lib/calendars');
const invites = require('../lib/invites');
const rl = require('../lib/ratelimit');
const { tooMany } = require('../http');

/**
 * 路由层校验：类型 / 长度 / 控制字符，和 sync.js 的逐字段校验同一个模式。
 * 业务层（nameProblem / isRole）自己还有兜底，这里只是不让明显坏的数据
 * 走到那一步 —— 信任边界宁可严。
 */
function badName(name) {
  if (name == null || name === '') return null;   // 留空是业务问题（建集给默认名）
  if (typeof name !== 'string') return '名字必须是文字';
  if (name.length > calendars.NAME_MAX) return `日程集名字最长 ${calendars.NAME_MAX} 字`;
  if (/[\u0000-\u001f]/.test(name)) return '名字含控制字符';
  return null;
}

function badRole(role) {
  return typeof role === 'string' && calendars.isRole(role) ? null : '权限不对';
}

module.exports = {

  /* ------------------------------------------------------------ 日程集 */

  'GET /api/cals': (ctx, me) => ({
    status: 200,
    body: { cals: calendars.listMine(me.user.id) },
  }),

  'POST /api/cals': (ctx, me) => {
    const bad = badName(ctx.body.name);
    if (bad) return { status: 400, body: { error: bad } };
    return calendars.create(me.user.id, ctx.body.name);
  },

  'PATCH /api/cals/:calId': (ctx, me) => {
    if (ctx.body && ctx.body.color != null) {
      return calendars.setColor(ctx.params.calId, me.user.id, ctx.body.color);
    }
    const bad = badName(ctx.body && ctx.body.name);
    if (bad) return { status: 400, body: { error: bad } };
    return calendars.rename(ctx.params.calId, me.user.id, ctx.body.name);
  },

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

  'PATCH /api/cals/:calId/members/:userId': (ctx, me) => {
    const bad = badRole(ctx.body.role);
    if (bad) return { status: 400, body: { error: bad } };
    return calendars.setRole(ctx.params.calId, me.user.id, ctx.params.userId, ctx.body.role);
  },

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

    const badName = ctx.body.name != null && typeof ctx.body.name !== 'string'
      ? '用户名必须是文字' : null;
    const bad = badName || badRole(ctx.body.role);
    if (bad) return { status: 400, body: { error: bad } };

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

};