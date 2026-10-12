/**
 * ai/review.mjs —— 每日审查（一天第一次对话时在后台跑）
 *
 * 回顾**昨天**的会话，提取新的偏好 / 模式 / 决定，写进记忆库。
 * 这是一个独立的 agent 跑，**不阻塞当前对话**，结果直接落记忆库（下次会被
 * systemPrompt 取进上下文）。
 *
 * 审查 agent 有 `save_memory` 工具，能自己决定记什么。过时记忆由
 * `db.pruneMemories` 在存满时丢最旧的，**不在这里删** —— 审查没有可靠的
 * 「这条已经过时了」的判据，硬判只会把还能用的偏好删掉。
 *
 * 三个「没什么可做就退出」的口子都在最前面：没配模型、昨天没对话、对话全是空话。
 * 少烧一次上游就少烧一次钱。
 */
import { Agent } from '@earendil-works/pi-agent-core';

import db from '../db.js';
import aiSettings from './settings.js';
import { allTools } from './tools.mjs';
import { buildModel, realStreamFn } from './model.mjs';

/** 昨天（按本机日历）的日期串 */
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 昨天那些会话里的对话正文，每条截到 500 字 */
function snippetsOfYesterday(userId, yStr) {
  const sessions = db.listAiSessions(userId, 50)
    .filter((s) => new Date(Number(s.created_at)).toISOString().slice(0, 10) === yStr);

  const snippets = [];
  for (const s of sessions) {
    for (const m of db.listAiMessages(s.id, userId)) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      try {
        const payload = JSON.parse(m.payload);
        const text = (payload.content || [])
          .filter((c) => c && c.type === 'text')
          .map((c) => String(c.text || ''))
          .join('')
          .trim();
        if (text) snippets.push(`[${m.role}] ${text.slice(0, 500)}`);
      } catch (_) { /* 坏行跳过 */ }
    }
  }
  return snippets;
}

export async function runDailyReview(userId) {
  const cfg = aiSettings.load(userId);
  if (!cfg.baseUrl || !cfg.model) return; // 没配模型，跳过

  const snippets = snippetsOfYesterday(userId, yesterdayStr());
  if (!snippets.length) return; // 昨天没对话，没什么可审查的

  const reviewPrompt = `你是「日程清单」的每日审查任务。回顾下面昨天的对话，提取用户表达过的偏好、习惯、重复模式或关键决定，用 save_memory 工具记下来。

规则：
- 只记**跨对话有用**的信息，比如「以后健身放早上」「每周三有例会」「10月8日出差」
- 不要记流水账（「今天建了个任务」这种）
- 不要记工具返回的原文
- 每条记忆一句话就够
- 如果昨天没有值得记的，就不要调 save_memory

昨天的对话：
${snippets.join('\n')}`;

  const agent = new Agent({
    streamFn: realStreamFn(cfg),
    initialState: {
      systemPrompt: reviewPrompt,
      model: buildModel(cfg),
      tools: allTools({ userId, proposals: new Map() }),
      messages: [],
    },
  });

  try {
    await agent.run();
  } catch (e) {
    console.error('[ai] 每日审查失败', e && e.message ? e.message : e);
  }
}