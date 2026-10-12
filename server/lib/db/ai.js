/**
 * ai.js —— AI 那三张表（配置 / 会话 / 消息）
 *
 * 这三张表**不参与 LWW 同步**：模型配置是「我的凭据」，对话是「我问过什么」，
 * 都不是日程集里的共享内容，按 userId 归属，跟账号走。
 *
 * **每一条读 / 写都带 user_id 条件**，包括按主键查的那种。只按 id 查的话，
 * 猜到一个 sessionId 就能读到别人的对话 —— 而 id 是 UUIDv7，前 48 位是时间戳，
 * 并不是不可猜的。多一个条件不花钱。
 */
'use strict';

const { run, get, all, tx } = require('./connection.js');

/* ---------------------------------------------------------- 模型配置 */

/** 我的模型配置。没有就返回 null（用默认值），不预先塞一行。 */
function getAiSettings(userId) {
  return get('SELECT * FROM ai_settings WHERE user_id = ?', String(userId));
}

/** 整行覆盖。apiKey 传 null 表示清空 —— 「这次不改」由调用方先读旧值再传回来。 */
function putAiSettings(userId, s) {
  return run(`
    INSERT INTO ai_settings (user_id, provider, base_url, model, api_key, updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      provider   = excluded.provider,
      base_url   = excluded.base_url,
      model      = excluded.model,
      api_key    = excluded.api_key,
      updated_at = excluded.updated_at
  `, String(userId), String(s.provider), String(s.baseUrl),
     String(s.model), s.apiKey == null ? null : String(s.apiKey), Number(s.updatedAt));
}

/* ------------------------------------------------------------- 会话 */

function insertAiSession(s) {
  return run(`
    INSERT INTO ai_sessions (id, user_id, title, created_at, updated_at)
    VALUES (?,?,?,?,?)
  `, String(s.id), String(s.userId), String(s.title),
     Number(s.createdAt), Number(s.updatedAt));
}

/** 会话列表，最近改过的在前。只回元信息 —— 消息要另取，免得列表接口越用越肥。 */
function listAiSessions(userId, limit = 50) {
  return all(`
    SELECT id, title, created_at, updated_at
    FROM ai_sessions WHERE user_id = ?
    ORDER BY updated_at DESC LIMIT ?
  `, String(userId), Number(limit));
}

function findAiSession(id, userId) {
  return get('SELECT * FROM ai_sessions WHERE id = ? AND user_id = ?', String(id), String(userId));
}

/** 改标题 / 推 updated_at。两者一起 —— 光有新消息不改 updated_at 的话，列表顺序会乱。 */
function touchAiSession(id, userId, title, when) {
  if (title == null) {
    return run('UPDATE ai_sessions SET updated_at = ? WHERE id = ? AND user_id = ?',
      Number(when), String(id), String(userId));
  }
  return run('UPDATE ai_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    String(title), Number(when), String(id), String(userId));
}

/** 删会话连同它的消息。两张表没有外键约束，所以在一个事务里手动删。 */
function deleteAiSession(id, userId) {
  let n = 0;
  tx(() => {
    run('DELETE FROM ai_messages WHERE session_id = ? AND user_id = ?', String(id), String(userId));
    n = run('DELETE FROM ai_sessions WHERE id = ? AND user_id = ?', String(id), String(userId));
  });
  return n;
}

/* ------------------------------------------------------------- 消息 */

/** 会话内递增的序号，用来保证消息顺序（created_at 同毫秒会并列） */
function nextAiMessageSeq(sessionId) {
  const row = get('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM ai_messages WHERE session_id = ?',
    String(sessionId));
  return Number(row.n);
}

function appendAiMessage(m) {
  return run(`
    INSERT INTO ai_messages (id, session_id, user_id, seq, role, payload, proposals, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `, String(m.id), String(m.sessionId), String(m.userId), Number(m.seq), String(m.role),
     String(m.payload), m.proposals == null ? null : String(m.proposals), Number(m.createdAt));
}

/** 一条会话的全部消息，按对话顺序。 */
function listAiMessages(sessionId, userId) {
  return all(`
    SELECT id, seq, role, payload, proposals, created_at
    FROM ai_messages WHERE session_id = ? AND user_id = ?
    ORDER BY seq
  `, String(sessionId), String(userId));
}

/**
 * 一条 assistant 消息里剩下的**待确认**提案。
 * 用户确认或划掉之后要把这条改小，否则再打开抽屉会看到已经改完的卡片。
 */
function setAiMessageProposals(messageId, userId, proposals) {
  return run('UPDATE ai_messages SET proposals = ? WHERE id = ? AND user_id = ?',
    proposals == null ? null : String(proposals), String(messageId), String(userId));
}

/**
 * 按提案 id 找出它挂在哪条消息上，连同提案本身，以及那条消息的**全部**提案。
 *
 * `proposals` 是一列 JSON 数组，所以用 `json_each` 摊开再比 id —— 别在 JS 里
 * 把全部消息读出来遍历：那等于每次确认都把整台机器上的对话拉进内存。
 *
 * 连 `message_proposals` 一起回，是因为确认之后要把它从那一列里删掉：
 * 再查一次那条消息是多余的，而两次查之间那条消息还可能被别的请求改过。
 *
 * `user_id` 条件是**必须的**：确认接口拿到的 id 来自客户端，少了它，
 * 猜到一个提案 id 就能改别人的数据。
 */
function findAiProposal(userId, proposalId) {
  return get(`
    SELECT m.id AS message_id, m.session_id,
           p.value AS proposal, m.proposals AS message_proposals
    FROM ai_messages m, json_each(m.proposals) p
    WHERE m.user_id = ? AND m.proposals IS NOT NULL
      AND json_extract(p.value, '$.id') = ?
    LIMIT 1
  `, String(userId), String(proposalId));
}

module.exports = {
  getAiSettings, putAiSettings,
  insertAiSession, listAiSessions, findAiSession, touchAiSession, deleteAiSession,
  nextAiMessageSeq, appendAiMessage, listAiMessages, setAiMessageProposals,
  findAiProposal,
};