/**
 * ai/chat.mjs —— 跑一轮对话，把 pi 的事件翻成给前端的 SSE
 *
 * **pi 的 Agent 调用只在 chat / review / report 三个文件里**，也就是
 * 「跑 agent」的三处。`@earendil-works/pi-*` 两个包都还是 1.0.x，API 会动；
 * 升版时只改这三个 + model.mjs，别的地方不碰。这是把它们关在这一圈里的唯一理由。
 *
 * 同一个 `Agent` 的三段组装（buildModel + realStreamFn + initialState）在
 * 三处重复，但那三行**故意不抽成一个函数**：review / report 都不接受注入的
 * `streamFn`，只有 runChat 要给测试留口子。抽出去反而多一层间接。
 *
 * ## 为什么 AI 是「另一台设备」
 *
 * AI 读的是 `sync.snapshot(userId)`，写的是 `sync.applyOps(userId, ops)`，
 * deviceId 固定 `'ai'`。这不是偷懒 —— 权限把守、墓碑剔除、集过滤全在那两个
 * 函数里，另起一套「AI 专用的读写」等于把那些判断抄第二遍，抄漏一处就是越权。
 * 于是 AI 的改动会自然地出现在客户端的 `_dev === 'ai'` 里，也会自然地参与
 * 逐字段 LWW 的冲突判定 —— 它确实就是另一个写入者，不该被特判掉。
 *
 * ## 假模型
 *
 * `runChat` 的 `streamFn` 可以注入。测试里传一个按剧本吐事件的桩，
 * 工具循环、SSE 事件序列、落库全都能测，**不联网、不烧额度**。
 *
 * 其余几块在别处：模型装配 model.mjs · 落库 persist.mjs · 错误翻人话
 * errors.mjs · 每日审查 review.mjs · 晚间汇报 report.mjs · 工具 tools.mjs。
 */
import { randomUUID } from 'node:crypto';

import { Agent } from '@earendil-works/pi-agent-core';

import db from '../db.js';
import aiSettings from './settings.js';
import { allTools } from './tools.mjs';
import { systemPrompt } from './prompt.mjs';
import { buildModel, realStreamFn } from './model.mjs';
import { proposalsIn, saveMessages, titleFrom } from './persist.mjs';
import { summaryOf, friendlyError } from './errors.mjs';
import { runDailyReview } from './review.mjs';
import { today } from './dates.mjs';

// lib/ai/index.js 从这里转出去（它只认 chat.mjs 这一个入口）
export { buildModel } from './model.mjs';
export { runEveningReport } from './report.mjs';

/** 这次对话里的历史消息（跳过坏行，别让一条脏数据把整个会话变成砖） */
function loadHistory(sid, userId) {
  const history = [];
  for (const r of db.listAiMessages(sid, userId)) {
    try {
      const m = JSON.parse(r.payload);
      if (m && m.role !== 'system') history.push(m);
    } catch (_) { /* 坏行跳过 */ }
  }
  return history;
}

/**
 * 一天里第一次对话吗？（拿最近一次会话的 updated_at 比日期）
 *
 * 是的话在后台起一次每日审查。**不 await** —— 它慢一点不该让这一轮变慢。
 */
function kickDailyReview(userId) {
  const last = db.listAiSessions(userId, 1)[0];
  const lastAt = last ? new Date(Number(last.updated_at)) : null;
  const first = !lastAt || lastAt.toISOString().slice(0, 10) !== today();
  if (!first) return;
  runDailyReview(userId).catch((e) => {
    console.error('[ai] 每日审查失败', e && e.message ? e.message : e);
  });
}

/**
 * 这一轮的 SSE 事件。写工具跑完时会多发一条 `proposal`，前端据此画出
 * 待确认卡片 —— 用户点确认才会走 /api/ai/confirm。
 */
function subscribe(agent, emit) {
  agent.subscribe((ev) => {
    switch (ev.type) {
      case 'message_update': {
        const e = ev.assistantMessageEvent;
        if (e && e.type === 'text_delta' && e.delta) {
          emit({ type: 'text', delta: e.delta });
        }
        // thinking_delta 故意不转发：pi 默认不开思考，真开了也不该让它出现在
        // 用户的对话气泡里。要显示的话在这里加一条 half-open 的 case。
        break;
      }
      case 'tool_execution_start':
        emit({ type: 'tool', phase: 'start', name: ev.toolName, args: ev.args });
        break;
      case 'tool_execution_end': {
        const proposal = ev.result && ev.result.details && ev.result.details.proposal;
        if (proposal) emit({ type: 'proposal', proposal });
        emit({
          type: 'tool',
          phase: 'end',
          name: ev.toolName,
          isError: !!ev.isError,
          summary: summaryOf(ev.result),
        });
        break;
      }
      default:
        break;
    }
  });
}

/**
 * 跑一轮对话。事件按 SSE 的形状吐给 `emit`（见 lib/ai/sse.mjs）。
 *
 * @param {object} o
 * @param {string} o.userId
 * @param {string} [o.sessionId]  省略则新建
 * @param {string} o.text
 * @param {object} [o.context]    客户端补的当前界面状态
 * @param {(e:object)=>void} o.emit
 * @param {AbortSignal} [o.signal]
 * @param {Function} [o.streamFn] 注入假模型用；省略则用用户配置的真模型
 * @returns {Promise<void>}
 */
export async function runChat({ userId, sessionId, text, context, emit, signal, streamFn }) {
  const cfg = aiSettings.load(userId);
  if (!streamFn && (!cfg.baseUrl || !cfg.model)) {
    emit({ type: 'error', message: '还没配置模型，先去 AI 设置里填 Base URL 和模型名', code: 'noconfig' });
    return;
  }

  /* --- 会话 --- */
  let sid = sessionId ? String(sessionId) : null;
  const isNew = !sid;
  if (sid) {
    if (!db.findAiSession(sid, userId)) {
      emit({ type: 'error', message: '这个对话不存在（可能已经在别处删掉了）', code: 'nosession' });
      return;
    }
  } else {
    sid = randomUUID();
    const now = Date.now();
    db.insertAiSession({ id: sid, userId, title: titleFrom(text), createdAt: now, updatedAt: now });
  }
  emit({ type: 'session', sessionId: sid, isNew });

  /* --- 记忆：取最近 N 条放进系统提示词，同时把 last_used_at 推上去 --- */
  const memories = db.listMemories(userId, 20);
  if (memories.length) db.touchMemories(memories.map((m) => m.id), Date.now());

  kickDailyReview(userId);

  /**
   * 这一轮的提案收集器：toolCallId → 提案。
   *
   * 写入工具**只往这里塞，不落库**（见 tools/write.mjs 里那段）。落库分两步：
   * 现在挂到 assistant 消息上（下面 saveMessages 的 proposalsOf），
   * 真的写数据要等用户点确认走 `POST /api/ai/confirm`。
   */
  const proposals = new Map();

  const agent = new Agent({
    streamFn: streamFn || realStreamFn(cfg),
    initialState: {
      systemPrompt: systemPrompt(context, memories),
      model: buildModel(cfg),
      tools: allTools({ userId, proposals }),
      messages: loadHistory(sid, userId),
    },
  });

  subscribe(agent, emit);

  if (signal) {
    if (signal.aborted) agent.abort();
    else signal.addEventListener('abort', () => agent.abort(), { once: true });
  }

  /* --- 跑 --- */
  const before = agent.state.messages.length;
  let failure = null;
  try {
    await agent.prompt(String(text));
  } catch (e) {
    failure = e;
  }

  const fresh = agent.state.messages.slice(before);
  try {
    saveMessages(sid, userId, fresh, (m) => proposalsIn(m, proposals));
    // 标题在建会话时就定死了（取第一句话），这里只把 updated_at 推上去 ——
    // 会话列表按它排序，不推的话新消息不会让这个会话浮到最上面
    db.touchAiSession(sid, userId, null, Date.now());
  } catch (e) {
    console.error('[ai] 存对话失败', e && e.message ? e.message : e);
  }

  // **pi 不抛异常，它把上游的错误写成一条 `stopReason: 'error'` 的消息。**
  // 只看 try/catch 的话，上游 401 / 连不上 / 没填 key 全都表现成
  // 「模型回了一句空话」，界面上一片空白、日志里干干净净。
  // 实测踩过：本机网关不填 key 时 pi 压根不发请求，直接造这样一条消息。
  const broke = fresh.filter((m) => m && m.role === 'assistant' && m.stopReason === 'error').pop();
  if (broke) failure = new Error(broke.errorMessage || '模型返回了错误');

  if (failure) {
    // 不外泄堆栈也别把上游的原文糊上去：它可能带着 baseUrl 与 key 的片段。
    // 但常见的那几种要翻译成人话，否则用户只能看到一个「服务器内部错误」。
    console.error('[ai] 运行失败', failure && failure.stack ? failure.stack : failure);
    emit({ type: 'error', message: friendlyError(failure), code: 'model' });
  }

  // 一并把用量带上：用户接的是自己的网关，花的是自己的额度，
  // 界面上能看见「这一轮花了多少 tokens」比什么都强
  const last = fresh.filter((m) => m && m.role === 'assistant').pop();
  emit({ type: 'done', sessionId: sid, usage: (last && last.usage) || null });
}