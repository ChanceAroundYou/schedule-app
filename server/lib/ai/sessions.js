/**
 * ai/sessions.js —— 会话列表 / 一个会话的全部消息 / 删会话
 *
 * 这一层的活只有一个：把 `ai_messages.payload` 里那份 pi 的 AgentMessage
 * 还原成前端好画的东西。
 *
 * **payload 存的是整条消息的 JSON**（见 db.js 里那段注释）：消息的形状归 pi 管，
 * 拆成列等于替它定 schema。代价是读的时候要在这里翻译一次 —— 这个文件就是
 * 那份翻译，别的地方不许直接 JSON.parse 那个字段。
 *
 * 用户的输入也一并落库（role: 'user'），否则刷新之后只剩 AI 的半截话。
 */
'use strict';

const db = require('../db');

/** 单条消息的正文：pi 的 content 是数组，只取文本块 */
function textOf(payload) {
  if (!payload || !Array.isArray(payload.content)) return '';
  return payload.content
    .filter((c) => c && c.type === 'text')
    .map((c) => String(c.text || ''))
    .join('');
}

/** 这条消息调过哪些工具 —— 前端在气泡下面画一排小标签 */
function toolsOf(payload) {
  if (!payload || !Array.isArray(payload.content)) return [];
  return payload.content
    .filter((c) => c && c.type === 'toolCall')
    .map((c) => ({ name: c.name, args: c.arguments }));
}

function parse(json, fallback) {
  try { return JSON.parse(json); } catch (_) { return fallback; }
}

function shapeMessage(row) {
  const payload = parse(row.payload, null);
  return {
    id: row.id,
    role: row.role,
    text: textOf(payload),
    tools: toolsOf(payload),
    // 未确认的写入提案。null = 这条消息没有（或都已经处理完了）
    proposals: row.proposals ? parse(row.proposals, []) : null,
    createdAt: Number(row.created_at),
  };
}

function shapeSession(row) {
  return {
    id: row.id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function list(userId) {
  return { status: 200, body: { sessions: db.listAiSessions(userId).map(shapeSession) } };
}

function one(userId, sessionId) {
  const row = db.findAiSession(sessionId, userId);
  if (!row) return { status: 404, body: { error: '没有这个对话' } };
  return {
    status: 200,
    body: {
      session: shapeSession(row),
      messages: db.listAiMessages(sessionId, userId).map(shapeMessage),
    },
  };
}

function remove(userId, sessionId) {
  const n = db.deleteAiSession(sessionId, userId);
  if (!n) return { status: 404, body: { error: '没有这个对话' } };
  return { status: 200, body: { ok: true } };
}

module.exports = { list, one, remove, shapeMessage };
