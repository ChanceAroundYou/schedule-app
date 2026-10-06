/**
 * ai/memory.js —— 长期记忆的读写
 *
 * 记忆是跨对话的：agent 在对话中自己决定记什么（save_memory 工具），
 * 用户在这个界面上看见、编辑、删除。
 *
 * 一张表（ai_memory），按 userId 归属。没有复杂的淘汰逻辑 ——
 * 存满时丢最旧的（pruneMemories），用户也可以手动删。
 */
'use strict';

const db = require('../db');

/** 给前端的形状 */
function shape(row) {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null,
  };
}

function list(userId) {
  const rows = db.listMemories(userId, 50);
  return { status: 200, body: { memories: rows.map(shape) } };
}

function remove(userId, id) {
  db.deleteMemory(id, userId);
  return { status: 200, body: { ok: true } };
}

function update(userId, id, body) {
  const rows = db.listMemories(userId, 50);
  const row = rows.find((r) => r.id === id);
  if (!row) return { status: 404, body: { error: '没有这条记忆' } };

  const content = String(body.content || '').trim();
  if (!content) return { status: 400, body: { error: 'content 不能为空' } };
  if (content.length > 300) return { status: 400, body: { error: 'content 太长' } };

  db.run('UPDATE ai_memory SET content = ? WHERE id = ? AND user_id = ?',
    content, id, userId);
  return { status: 200, body: { ok: true } };
}

module.exports = { list, remove, update };
