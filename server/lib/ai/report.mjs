/**
 * ai/report.mjs —— 晚间汇报（一天结束时生成一份当日汇报）
 *
 * 汇报是一个特殊会话（标题「每日汇报」），每天往里追加一条消息。
 * 由 server/background.js 每分钟扫一次、到点触发，**在后台跑，不阻塞任何请求**。
 *
 * ## 这一段原来有三个调用是坏的（2026-10-11 修）
 *
 * 写的时候按位置参数调了 `db.insertAiSession(sid, userId, …)` /
 * `db.appendAiMessage(sid, userId, seq, …)`，而 db 里这几个是**对象参数**。
 * 结果是插进去几行 id 为字符串 `'undefined'` 的垃圾，然后 `touchAiSession` 拿到
 * `when === undefined` → `Number(undefined)` 是 NaN → 抛错 → 整段被 catch 掉。
 * 也就是说**晚间汇报从来没有真正落到库里过**，界面上一次也没出现过。
 *
 * 「daily report 不出现」这个症状有三个候选（定时器没跑 / 模型没配 / 落库失败），
 * 根因在最后这一个。修的时候别再改回位置参数形式 —— db 那边是对象参数。
 */
import { randomUUID } from 'node:crypto';

import { Agent } from '@earendil-works/pi-agent-core';

import db from '../db.js';
import aiSettings from './settings.js';
import { allTools } from './tools.mjs';
import { buildModel, realStreamFn } from './model.mjs';
import { textOf } from './persist.mjs';
import { today, addDays } from './dates.mjs';

const REPORT_TITLE = '每日汇报';

/** 今天这个用户在集里动过手没有。没用过就别生成汇报 —— 空话没有价值。 */
function touchedToday(userId) {
  const calIds = db.calendarIdsFor(userId);
  if (!calIds.length) return false;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const placeholders = calIds.map(() => '?').join(',');
  const row = db.get(
    `SELECT COUNT(*) AS n FROM changes WHERE cal_id IN (${placeholders}) AND ts > ?`,
    ...calIds, startOfToday.getTime(),
  );
  return Boolean(row && Number(row.n));
}

/** 找或建「每日汇报」那个会话（**一直只有一个**，每天往里追加） */
function reportSession(userId) {
  const hit = db.listAiSessions(userId, 50).find((s) => s.title === REPORT_TITLE);
  if (hit) return hit.id;
  const id = randomUUID();
  const now = Date.now();
  db.insertAiSession({ id, userId, title: REPORT_TITLE, createdAt: now, updatedAt: now });
  return id;
}

function reportPrompt(t, tomorrow) {
  return `你是「日程清单」的晚间汇报任务。生成一份当日汇报。

今天是 ${t}，明天是 ${tomorrow}。

用工具查一下：
1. 今天有哪些任务（list_tasks）
2. 明天有哪些任务（list_tasks）
3. 今天的忙闲情况（load_summary）

然后生成一份简洁的汇报，包括：
- 今天完成了什么
- 明天有什么安排
- 有没有冲突或需要提醒的

用中文，直接说结论，别把工具返回的 JSON 倒出来。`;
}

export async function runEveningReport(userId) {
  const cfg = aiSettings.load(userId);
  if (!cfg.baseUrl || !cfg.model) return;
  if (!touchedToday(userId)) return; // 今天没用过，不生成

  const sid = reportSession(userId);
  const agent = new Agent({
    streamFn: realStreamFn(cfg),
    initialState: {
      systemPrompt: reportPrompt(today(), addDays(today(), 1)),
      model: buildModel(cfg),
      tools: allTools({ userId, proposals: new Map() }),
      messages: [],
    },
  });

  try {
    const messages = [];
    agent.on('message', (m) => { if (m) messages.push(m); });
    await agent.run();

    const assistant = messages.filter((m) => m && m.role === 'assistant').pop();
    const text = assistant ? textOf(assistant).trim() : '';
    if (!text) return;

    db.appendAiMessage({
      id: randomUUID(),
      sessionId: sid,
      userId,
      seq: db.nextAiMessageSeq(sid),
      role: 'assistant',
      payload: JSON.stringify(assistant),
      proposals: null,
      createdAt: Date.now(),
    });
    // 光有新消息不改 updated_at 的话，会话列表顺序会乱（touchAiSession 两者一起做）
    db.touchAiSession(sid, userId, null, Date.now());
  } catch (e) {
    console.error('[ai] 晚间汇报失败', e && e.message ? e.message : e);
  }
}