/**
 * ai/authorizations.js —— 每人的授权状态
 *
 * 任务增删改默认免确认，打卡和日程集管理默认需确认。
 * 邀请永远人来做，不在这里。
 *
 * 授权是持久的：用户改一次，记到主动收回为止。
 */
'use strict';

const db = require('../db');

const VALID = new Set(['free', 'confirm']);

function shape(a) {
  return {
    taskCrud: a.taskCrud,
    habitCheckin: a.habitCheckin,
    calendarMgmt: a.calendarMgmt,
    eveningReportEnabled: !!a.eveningReportEnabled,
    eveningReportTime: a.eveningReportTime,
    updatedAt: a.updatedAt,
  };
}

function read(userId) {
  return { status: 200, body: shape(db.getAuthorizations(userId)) };
}

function update(userId, body) {
  const patch = {};

  if (body.taskCrud !== undefined) {
    if (!VALID.has(body.taskCrud)) {
      return { status: 400, body: { error: 'taskCrud 必须是 free 或 confirm' } };
    }
    patch.taskCrud = body.taskCrud;
  }
  if (body.habitCheckin !== undefined) {
    if (!VALID.has(body.habitCheckin)) {
      return { status: 400, body: { error: 'habitCheckin 必须是 free 或 confirm' } };
    }
    patch.habitCheckin = body.habitCheckin;
  }
  if (body.calendarMgmt !== undefined) {
    if (!VALID.has(body.calendarMgmt)) {
      return { status: 400, body: { error: 'calendarMgmt 必须是 free 或 confirm' } };
    }
    patch.calendarMgmt = body.calendarMgmt;
  }
  if (body.eveningReportEnabled !== undefined) {
    patch.eveningReportEnabled = body.eveningReportEnabled ? 1 : 0;
  }
  if (body.eveningReportTime !== undefined) {
    const t = String(body.eveningReportTime || '').trim();
    if (!/^\d{2}:\d{2}$/.test(t)) {
      return { status: 400, body: { error: 'eveningReportTime 必须是 HH:MM' } };
    }
    patch.eveningReportTime = t;
  }

  db.putAuthorizations(userId, patch);
  return { status: 200, body: shape(db.getAuthorizations(userId)) };
}

module.exports = { read, update };
