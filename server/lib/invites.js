/**
 * invites.js —— 邀请制共享
 *
 * 流程是**两段式**：owner 发出邀请，对方在自己的界面里看到并接受，之后才写进
 * calendar_members。为什么要多这一步 —— 按用户名直接加人的话，输错一个字符
 * 就是把家庭日程交给了陌生人，而发出去的一方看不到任何异常。
 *
 * 邀请不设过期：家庭场景里发出去半年后才被接受是正常的，过期只会让用户
 * 反复重发。要收回就用「撤回」。
 *
 * 权限（谁能邀请、谁能撤回）不在这个文件里判断，由调用方（server.js）
 * 查完 calendars.canManage 之后调进来 —— 别在这里再写一遍 if。
 */
'use strict';

const crypto = require('node:crypto');
const db = require('./db');
const calendars = require('./calendars');

function shape(row) {
  return {
    id: row.id,
    calId: row.cal_id,
    calName: row.cal_name,
    role: row.role,
    createdAt: Number(row.created_at),
    /** 待我处理的那些有「谁邀请的」；我发出去的有「邀请的谁」 */
    fromName: row.from_name ?? null,
    toName: row.to_name ?? null,
  };
}

/**
 * 发一条邀请。
 *
 * 目标必须是**已存在**的用户名 —— 这就是它和「按链接加入」的区别：你得先知道
 * 对方在这个服务器上的用户名。代价是这等于确认了「某人注册过」，
 * 属于可接受的信息泄露（登录接口本身已经不区分用户不存在与密码错），
 * 调用方另外做了频率限制。
 *
 * @returns {{status:number, body:object}}
 */
function create(calId, fromUserId, toName, role) {
  if (!calendars.isRole(role)) return { status: 400, body: { error: '权限不对' } };

  const name = String(toName || '').trim();
  if (!name) return { status: 400, body: { error: '请填写对方的用户名' } };

  const target = db.findUserByName(name);
  if (!target) return { status: 404, body: { error: '没有这个用户名' } };
  if (target.id === fromUserId) return { status: 400, body: { error: '不用邀请自己' } };

  const already = db.roleOf(calId, target.id);
  if (already) return { status: 409, body: { error: `「${target.name}」已经在这个日程集里了` } };

  // 同一个人已经有待处理邀请 → 复用那条，只把权限改掉。
  // 堆一串重复邀请的话，对方接受其中一条、其余几条还挂在那里。
  const pending = db.findPendingInvite(calId, target.id);
  if (pending) {
    db.decideInvite(pending.id, 'revoked');
  }

  const invite = {
    id: crypto.randomUUID(),
    calId,
    fromUser: fromUserId,
    toUser: target.id,
    role,
    createdAt: Date.now(),
  };
  try {
    db.insertInvite(invite);
  } catch (_) {
    // 唯一索引撞车（同时发了两条）—— 当作已经发出去了
    return { status: 200, body: { ok: true, invite: null } };
  }
  return {
    status: 200,
    body: { ok: true, invite: { id: invite.id, toName: target.name, role, status: 'pending' } },
  };
}

/** 发给我的待处理邀请 */
function listFor(userId) {
  return db.invitesFor(userId).map(shape);
}

/** 我发出去、还没被处理的 */
function listSent(userId) {
  return db.invitesSentBy(userId).map(shape);
}

/** 取出这条邀请，并确认它确实是我能处理的那条（对向匹配 + 仍是 pending） */
function claim(inviteId, userId, field) {
  const inv = db.findInvite(inviteId);
  if (!inv) return { status: 404, body: { error: '没有这条邀请' } };
  if (inv.status !== 'pending') return { status: 409, body: { error: '这条邀请已经处理过了' } };
  if (inv[field] !== userId) return { status: 403, body: { error: '这条邀请不是给你的' } };
  if (!db.findCalendar(inv.cal_id)) return { status: 404, body: { error: '这个日程集已经不在了' } };
  return { invite: inv };
}

/** 接受。此时才真正写进成员表。 */
function accept(inviteId, userId) {
  const got = claim(inviteId, userId, 'to_user');
  if (!got.invite) return got;

  const inv = got.invite;
  db.tx(() => {
    db.upsertMember(inv.cal_id, userId, inv.role);
    db.decideInvite(inv.id, 'accepted');
  });
  return { status: 200, body: { ok: true, calId: inv.cal_id, role: inv.role } };
}

function decline(inviteId, userId) {
  const got = claim(inviteId, userId, 'to_user');
  if (!got.invite) return got;

  db.decideInvite(got.invite.id, 'declined');
  return { status: 200, body: { ok: true } };
}

/** 撤回：发出去的人，或者这个集的 owner 都能撤。 */
function revoke(inviteId, userId) {
  const inv = db.findInvite(inviteId);
  if (!inv) return { status: 404, body: { error: '没有这条邀请' } };
  if (inv.status !== 'pending') return { status: 409, body: { error: '这条邀请已经处理过了' } };

  const isSender = inv.from_user === userId;
  const isOwner = calendars.canManage(db.roleOf(inv.cal_id, userId));
  if (!isSender && !isOwner) return { status: 403, body: { error: '只能撤回自己发出的邀请' } };

  db.decideInvite(inv.id, 'revoked');
  return { status: 200, body: { ok: true } };
}

module.exports = { create, listFor, listSent, accept, decline, revoke };
