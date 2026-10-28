/**
 * calendars.js —— 日程集与成员（权限的唯一实现处）
 *
 * 三档角色：
 *   owner   改名、删集、加人、改权限、踢人，以及全部内容编辑
 *   editor  增删改集里的任务与打卡，**不能**动集本身和成员
 *   viewer  只能看
 *
 * 三条不变量，任何一条被破坏都会让用户卡在一个没法自救的状态里：
 *   1. 每个用户**始终**至少属于一个日程集 —— 退出 / 被踢 / 集被删之后要是
 *      一个都不剩，自动给他建一个「我的日程」。否则他一进去就是白屏，
 *      而且没有任何入口能建新集（新建集也得先有个落脚的地方）。
 *   2. 每个集**始终**至少有一个 owner —— 最后一个 owner 不能降级、不能退出，
 *      否则这个集就没人能管了。
 *   3. 权限判断只走 db.roleOf 一处。别在别处再写一遍 if，
 *      那种散落的判断迟早会漏掉一条路径。
 *
 * 写权限（能改内容）与管权限（能改集）分开：`canWrite` 让 owner 和 editor 过，
 * `canManage` 只让 owner 过。
 */
'use strict';

const crypto = require('node:crypto');
const db = require('./db');

const ROLES = ['owner', 'editor', 'viewer'];
const DEFAULT_CAL_NAME = '我的日程';
const NAME_MAX = 40;

/**
 * 日程集颜色轴。与客户端 `app/src/domain/types/Cal.ts` 的 `CAL_COLORS` 是
 * **同一份名单**（服务端不 import 前端代码，所以两边各留一份字面量）——
 * 改一边必须改另一边，`tests/calendars.test.js` 里有一条断言盯这个。
 *
 * 键名只是标签，真正的色值在 `app/src/styles/tokens.css` 的日程集颜色轴那一节；
 * 这里**不存十六进制**，否则线上库里的颜色和界面上画出来的迟早会分家。
 */
const CAL_COLORS = ['jade', 'azure', 'clay', 'plum', 'gold', 'slate', 'rose', 'teal'];
const DEFAULT_CAL_COLOR = 'jade';

function isRole(r) {
  return ROLES.includes(r);
}

function nameProblem(name) {
  const s = String(name || '').trim();
  if (!s) return '日程集名字不能为空';
  if (s.length > NAME_MAX) return `日程集名字最长 ${NAME_MAX} 字`;
  if (/[\u0000-\u001f]/.test(s)) return '日程集名字含控制字符';
  return null;
}

/** 能改内容（任务 / 打卡）的角色 */
function canWrite(role) {
  return role === 'owner' || role === 'editor';
}

/** 能改集本身与成员的角色 */
function canManage(role) {
  return role === 'owner';
}

/* ------------------------------------------------------------------ 建集 */

/** 建一个集，并把创建者登记成 owner。调用方负责在事务里调。 */
function createOwned(userId, name, at, color) {
  const now = at || Date.now();
  const cal = {
    id: crypto.randomUUID(),
    name: String(name || DEFAULT_CAL_NAME).trim() || DEFAULT_CAL_NAME,
    ownerId: userId,
    color: color || DEFAULT_CAL_COLOR,
    createdAt: now,
  };
  db.insertCalendar(cal);
  db.upsertMember(cal.id, userId, 'owner', now);
  return cal;
}

/**
 * 保证这个用户至少有一个集。返回是否真的新建了。
 *
 * 登录后、退出/被踢/删集之后都要过一遍这道 —— 不变量 1 只有这一个执行点。
 */
function ensureHasCalendar(userId) {
  if (db.countCalendarsFor(userId) > 0) return null;
  return createOwned(userId, DEFAULT_CAL_NAME);
}

/**
 * 用户主动建一个新集。名字留空就用默认名。
 * @returns {{status:number, body:object}}
 */
function create(userId, name) {
  const clean = String(name == null ? '' : name).trim();
  if (clean) {
    const bad = nameProblem(clean);
    if (bad) return { status: 400, body: { error: bad } };
  }
  const cal = createOwned(userId, clean || DEFAULT_CAL_NAME);
  return {
    status: 200,
    body: { cal: { id: cal.id, name: cal.name, ownerId: cal.ownerId, color: cal.color, createdAt: cal.createdAt, role: 'owner' } },
  };
}

/* ---------------------------------------------------------------- 读 */

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    color: row.color || DEFAULT_CAL_COLOR,
    createdAt: Number(row.created_at),
    /** 我（请求者）在这个集里的角色 —— 前端据此决定按钮禁不禁用 */
    role: row.role,
  };
}

/** 我可见的全部集 */
function listMine(userId) {
  return db.calendarsFor(userId).map(shape);
}

function members(calId) {
  return db.membersOf(calId).map((m) => ({
    id: m.user_id,
    name: m.name,
    nickname: m.nickname || null,
    role: m.role,
    joinedAt: Number(m.joined_at),
  }));
}

/**
 * 用户目录：`{ userId: { name, nickname } }`。
 *
 * 任务上的来源 tag 要显示「谁创建的」，而 `/api/sync` 从不回用户表 ——
 * 只回这个用户**可能遇到的人**（他那些集的全部成员）。够用，且不多泄一个名字。
 */
function directory(userId) {
  const out = {};
  for (const u of db.directoryFor(userId)) out[u.id] = { name: u.name, nickname: u.nickname || null };
  return out;
}

/* ---------------------------------------------------------------- 写 */

/**
 * 改名。只有 owner 能改。
 * @returns {{status:number, body:object}}
 */
function rename(calId, userId, name) {
  const role = db.roleOf(calId, userId);
  if (!role) return { status: 404, body: { error: '没有这个日程集' } };
  if (!canManage(role)) return { status: 403, body: { error: '只有创建者能改日程集' } };
  const bad = nameProblem(name);
  if (bad) return { status: 400, body: { error: bad } };

  const clean = String(name).trim();
  db.renameCalendar(calId, clean);
  return { status: 200, body: { id: calId, name: clean } };
}

/**
 * 删集（软删）。只有 owner 能删。
 *
 * 成员关系一起清掉，待处理邀请作废。field_state 留着不动 —— 集没了就没人
 * 读得到它，删数据这个动作没必要，万一是误删还捞得回来。
 *
 * 每个受影响的人都要过一遍 ensureHasCalendar，否则删掉自己唯一那个集的人
 * 会落到「一个集都没有」的状态。
 */
function remove(calId, userId) {
  const role = db.roleOf(calId, userId);
  if (!role) return { status: 404, body: { error: '没有这个日程集' } };
  if (!canManage(role)) return { status: 403, body: { error: '只有创建者能删日程集' } };

  const affected = db.membersOf(calId).map((m) => m.user_id);
  db.tx(() => {
    db.cancelPendingInvites(calId, null);
    for (const uid of affected) db.removeMember(calId, uid);
    db.softDeleteCalendar(calId);
    for (const uid of affected) ensureHasCalendar(uid);
  });
  return { status: 200, body: { ok: true } };
}

/**
 * 改某个成员的角色。只有 owner 能改。
 *
 * 只挡一件事：把**最后一个 owner** 降级 —— 那会让这个集再没人能管。
 * 把自己提成 owner 是允许的（协作里需要转让），降级自己则会撞上同一条判断。
 */
function setRole(calId, actorId, targetId, role) {
  const actorRole = db.roleOf(calId, actorId);
  if (!actorRole) return { status: 404, body: { error: '没有这个日程集' } };
  if (!canManage(actorRole)) return { status: 403, body: { error: '只有创建者能改成员权限' } };
  if (!isRole(role)) return { status: 400, body: { error: '权限不对' } };

  const targetRole = db.roleOf(calId, targetId);
  if (!targetRole) return { status: 404, body: { error: '这个人不在日程集里' } };

  if (role !== 'owner' && targetRole === 'owner' && db.countOwners(calId) <= 1) {
    return { status: 400, body: { error: '至少要留一个创建者，请先把别人设成创建者' } };
  }

  db.upsertMember(calId, targetId, role);
  return { status: 200, body: { ok: true } };
}

function setColor(calId, userId, color) {
  const role = db.roleOf(calId, userId);
  if (!role) return { status: 404, body: { error: '没有这个日程集' } };
  if (!canManage(role)) return { status: 403, body: { error: '只有创建者能改日程集' } };
  if (!CAL_COLORS.includes(color)) return { status: 400, body: { error: '颜色不对' } };
  db.setColorCalendar(calId, color);
  return { status: 200, body: { id: calId, color } };
}
function kick(calId, actorId, targetId) {
  const actorRole = db.roleOf(calId, actorId);
  if (!actorRole) return { status: 404, body: { error: '没有这个日程集' } };
  if (!canManage(actorRole)) return { status: 403, body: { error: '只有创建者能移除成员' } };
  if (actorId === targetId) return { status: 400, body: { error: '退出请用「退出日程集」' } };
  if (!db.roleOf(calId, targetId)) return { status: 404, body: { error: '这个人不在日程集里' } };

  db.tx(() => {
    db.cancelPendingInvites(calId, targetId);
    db.removeMember(calId, targetId);
    ensureHasCalendar(targetId);
  });
  return { status: 200, body: { ok: true } };
}

/**
 * 自己退出。owner 也可以退 —— 但必须是「不是最后一个 owner」。
 * 退出的如果是 owner 且还有别的 owner，就走掉了，不必转让。
 */
function leave(calId, userId) {
  const role = db.roleOf(calId, userId);
  if (!role) return { status: 404, body: { error: '没有这个日程集' } };
  if (canManage(role) && db.countOwners(calId) <= 1) {
    return { status: 400, body: { error: '你是唯一的创建者，请先删掉日程集或把别人设成创建者' } };
  }

  db.tx(() => {
    db.cancelPendingInvites(calId, userId);
    db.removeMember(calId, userId);
    ensureHasCalendar(userId);
  });
  return { status: 200, body: { ok: true } };
}

module.exports = {
  ROLES, DEFAULT_CAL_NAME, NAME_MAX, CAL_COLORS, DEFAULT_CAL_COLOR,
  isRole, nameProblem, canWrite, canManage,
  createOwned, ensureHasCalendar, create,
  listMine, members, directory,
  rename, remove, setRole, kick, leave, setColor,
};
