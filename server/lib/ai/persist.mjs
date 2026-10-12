/**
 * ai/persist.mjs —— 把一轮对话的消息写进 ai_messages
 *
 * 拆出来是因为「跑 agent」和「存历史」是两件事：存库的失败**不该让这一轮
 * 失败**（runChat 里那圈 try/catch 就是为了这个），混在一起会看不出来。
 *
 * 有两条消息**故意不存**，写在 saveMessages 里，别以为是漏了：
 *   - system：随日期和上下文每轮重算的，存下来下次会读到一份过期的；
 *   - 空内容且 stopReason==='error' 的 assistant：那是这一轮的错误，
 *     存进去用户下次打开会话会看到一只永久空白的空气泡。
 */
import { randomUUID } from 'node:crypto';

import db from '../db.js';

/** 单条消息存进库的上限，防一条巨型 toolResult 把库撑起来 */
const PAYLOAD_MAX = 512 * 1024;

/** 会话标题取第一句话的前几个字 —— 列表里能认出是哪次对话就够了 */
const TITLE_MAX = 40;

/**
 * 这条 assistant 消息里带的提案。
 *
 * 按 **toolCallId** 关联（工具 `execute` 的第一个参数就是它），**不按执行顺序**：
 * pi 默认并行跑同一轮里的多个工具，`tool_execution_end` 回来的顺序和消息里
 * toolCall 块的顺序可以不一样。按顺序配就会把提案挂到别的工具调用上。
 */
export function proposalsIn(m, map) {
  if (!map.size || !m || !Array.isArray(m.content)) return null;
  const hits = m.content
    .filter((c) => c && c.type === 'toolCall' && map.has(c.id))
    .map((c) => map.get(c.id));
  return hits.length ? hits : null;
}

/** 一条消息里的正文（所有 text 块拼起来），没有就是空串 */
export const textOf = (msg) => {
  if (!msg || !Array.isArray(msg.content)) return '';
  return msg.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('');
};

/** 会话标题 = 第一句话的前几个字，空的叫「新对话」 */
export function titleFrom(text) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX)}…` : (s || '新对话');
}

/**
 * 存下这一轮新增的消息。
 *
 * @param {(m:object)=>object[]|null} [proposalsOf] 这条消息带哪些提案
 * @returns {number} 存了几条
 */
export function saveMessages(sessionId, userId, msgs, proposalsOf) {
  let n = 0;
  for (const m of msgs) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'assistant' && m.stopReason === 'error' && !textOf(m)) continue;

    const proposals = proposalsOf ? proposalsOf(m) : null;
    const payload = JSON.stringify(m);
    db.appendAiMessage({
      id: randomUUID(),
      sessionId,
      userId,
      seq: db.nextAiMessageSeq(sessionId),
      role: String(m.role),
      payload: payload.length > PAYLOAD_MAX ? payload.slice(0, PAYLOAD_MAX) : payload,
      proposals: proposals ? JSON.stringify(proposals) : null,
      createdAt: Date.now(),
    });
    n += 1;
  }
  return n;
}