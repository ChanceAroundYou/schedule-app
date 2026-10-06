/**
 * ai/chat.mjs —— 把 pi 的 Agent 跑起来，把事件翻成给前端的 SSE
 *
 * **pi 的调用只在这个文件里。** 两个包都还是 1.0.x，API 会动；升版时只改这里，
 * 别的地方不碰。这是把它关在一个文件里的唯一理由。
 *
 * ## 为什么是「另一台设备」
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
 */
import { randomUUID } from 'node:crypto';

import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';

import db from '../db.js';
import aiSettings from './settings.js';
import { allTools } from './tools.mjs';
import { systemPrompt } from './prompt.mjs';
import { today, addDays } from './dates.mjs';

/** 单条消息存进库的上限，防一条巨型 toolResult 把库撑起来 */
const PAYLOAD_MAX = 512 * 1024;
const TITLE_MAX = 40;

/**
 * 用户没填 key 时递给 pi 的占位符。
 *
 * **不能传 undefined**：pi 会先做一次「有没有 key」的检查，没有就直接返回
 * `stopReason: 'error' / errorMessage: 'No API key for provider: …'` ——
 * 请求根本没发出去。而本机那个网关（以及 Ollama / vLLM / LM Studio 这一类）
 * 本来就不校验 key，空着是合法配置。给个占位符让它照常发。
 *
 * 真需要 key 的服务会拿着这个占位符去鉴权、拿到 401，那条错误更有用：
 * 它会走到下面的 friendlyError，告诉用户「检查一下 API key」。
 */
const NO_KEY = 'not-needed';

/* -------------------------------------------------------------- 模型装配 */

/**
 * 用户配的那几个值 → pi 的 Model。
 *
 * `compat` 三个开关是**实测出来的**，不是抄的：
 * - `supportsDeveloperRole: false` —— 本机这个网关（Copilot 代理）不认 `developer` 角色
 * - `supportsReasoningEffort: false` —— 同上，不认 `reasoning_effort`
 * - `maxTokensField: 'max_tokens'` —— 不写这个会**同时**发 `max_tokens` 和
 *   `max_completion_tokens`，上游直接 400「两个不能一起给」。
 *   pi 对未知 baseUrl 的默认推断是 `max_completion_tokens`，正好撞上。
 *
 * `cost` 全 0：这里算不出钱（用户可能接的是任意网关）。填假数字反而会让
 * 界面上出现一个看起来精确的错误金额。
 */
export function buildModel(s) {
  return {
    id: s.model,
    name: s.model,
    api: 'openai-completions',
    provider: 'openai-completions',
    baseUrl: s.baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8192,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
    },
  };
}

/**
 * 真模型。apiKey 只能从 stream 选项传 —— Model 上没有这个字段。
 *
 * 模型实例由调用方（agent 的 initialState）持有并回传，这里只补 key 和选项，
 * 不自己再 build 一份 —— 否则「注入了假 streamFn」和「真模型」两条路上
 * agent 拿到的 Model 会是两个对象，测出来的行为对不上真的。
 */
function realStreamFn(cfg) {
  return (m, context, options) =>
    streamSimple(m, context, { ...options, apiKey: cfg.apiKey || NO_KEY });
}

/* ------------------------------------------------------------------ 落库 */

/**
 * 这条 assistant 消息里带的提案。
 *
 * 按 **toolCallId** 关联（工具 `execute` 的第一个参数就是它），**不按执行顺序**：
 * pi 默认并行跑同一轮里的多个工具，`tool_execution_end` 回来的顺序和消息里
 * toolCall 块的顺序可以不一样。按顺序配就会把提案挂到别的工具调用上。
 */
function proposalsIn(m, map) {
  if (!map.size || !m || !Array.isArray(m.content)) return null;
  const hits = m.content
    .filter((c) => c && c.type === 'toolCall' && map.has(c.id))
    .map((c) => map.get(c.id));
  return hits.length ? hits : null;
}

const textOf = (msg) => {
  if (!msg || !Array.isArray(msg.content)) return '';
  return msg.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('');
};

/** 会话标题取第一句话的前几个字 —— 列表里能认出是哪次对话就够了 */
function titleFrom(text) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX)}…` : (s || '新对话');
}

function saveMessages(sessionId, userId, msgs, proposalsOf) {
  let n = 0;
  for (const m of msgs) {
    // 系统提示词不落库：它是随日期和上下文每轮重算的，存下来下次会读到一份过期的
    if (!m || m.role === 'system') continue;
    // 上游出错时 pi 会补一条**空内容**的 assistant 消息（见 runChat 里那段）。
    // 存进去的话，用户下次打开这个会话会看到一只永久空白的空气泡 ——
    // 错误本身是这一轮的事，不该变成历史的一部分。
    if (m.role === 'assistant' && m.stopReason === 'error' && !textOf(m)) continue;
    const payload = JSON.stringify(m);
    db.appendAiMessage({
      id: randomUUID(),
      sessionId,
      userId,
      seq: db.nextAiMessageSeq(sessionId),
      role: String(m.role),
      payload: payload.length > PAYLOAD_MAX ? payload.slice(0, PAYLOAD_MAX) : payload,
      proposals: proposalsOf && proposalsOf(m) ? JSON.stringify(proposalsOf(m)) : null,
      createdAt: Date.now(),
    });
    n += 1;
  }
  return n;
}

/* -------------------------------------------------------------- 主流程 */

/**
 * 跑一轮对话。事件按 SSE 的形状吐给 `emit`（见 §3.2 那张表）。
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
    const row = db.findAiSession(sid, userId);
    if (!row) {
      emit({ type: 'error', message: '这个对话不存在（可能已经在别处删掉了）', code: 'nosession' });
      return;
    }
  } else {
    sid = randomUUID();
    const now = Date.now();
    db.insertAiSession({ id: sid, userId, title: titleFrom(text), createdAt: now, updatedAt: now });
  }
  emit({ type: 'session', sessionId: sid, isNew });

  /* --- 记忆 --- */
  // 取最近 N 条记忆放进系统提示词。同时把 last_used_at 推上去。
  const memories = db.listMemories(userId, 20);
  if (memories.length) {
    db.touchMemories(memories.map((m) => m.id), Date.now());
  }

  /* --- 每日审查 --- */
  // 一天第一次对话时，回顾昨天的会话和日程，提取新偏好/模式，淘汰过时记忆。
  // 这是一个独立的 agent 跑，不阻塞当前对话 —— 它在后台跑，结果写进记忆库。
  const lastSession = db.listAiSessions(userId, 1)[0];
  const t = today();
  const lastActive = lastSession ? new Date(Number(lastSession.updated_at)) : null;
  const isFirstToday = !lastActive || lastActive.toISOString().slice(0, 10) !== t;
  if (isFirstToday) {
    runDailyReview(userId).catch((e) => {
      console.error('[ai] 每日审查失败', e && e.message ? e.message : e);
    });
  }

  /* --- 历史 --- */
  const history = [];
  for (const r of db.listAiMessages(sid, userId)) {
    try {
      const m = JSON.parse(r.payload);
      if (m && m.role !== 'system') history.push(m);
    } catch (_) { /* 坏行跳过，别让一条脏数据把整个会话变成砖 */ }
  }

  /**
   * 这一轮的提案收集器：toolCallId → 提案。
   *
   * 写入工具**只往这里塞，不落库**（见 tools.mjs 里那段）。落库分两步：
   * 现在挂到 assistant 消息上（下面 `saveMessages` 的 proposalsOf），
   * 真的写数据要等用户点确认走 `POST /api/ai/confirm`。
   */
  const proposals = new Map();
  const tools = allTools({ userId, proposals });

  const agent = new Agent({
    streamFn: streamFn || realStreamFn(cfg),
    initialState: {
      systemPrompt: systemPrompt(context, memories),
      model: buildModel(cfg),
      tools,
      messages: history,
    },
  });

  /* --- 事件 → SSE --- */
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
        // 写工具跑完 = 产出了一张待确认卡片。前端据此把它画出来，
        // 用户点确认才会走 /api/ai/confirm
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

/** 工具结果的摘要 —— 给界面上那条动作条用，不占正文 */
function summaryOf(result) {
  if (!result) return '';
  const t = (result.content || []).find((c) => c && c.type === 'text');
  if (!t) return '';
  const s = String(t.text).replace(/\s+/g, ' ');
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** 上游的错误翻成人话。原文可能带 baseUrl / key 片段，所以按模式匹配，不整段透传。 */
function friendlyError(e) {
  const raw = String((e && e.message) || e || '');
  if (/No API key/i.test(raw)) return '这个模型服务要 API key，去 AI 设置里填一个。';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(raw)) {
    return '连不上模型服务。检查一下 Base URL 填得对不对、那个服务开着没有。';
  }
  if (/40[13]/.test(raw)) return '模型服务拒绝了这次请求（401/403）。检查一下 API key。';
  if (/404/.test(raw)) return '模型服务说没有这个接口或这个模型（404）。检查 Base URL 要不要带 /v1，以及模型名。';
  if (/429/.test(raw)) return '模型服务在限流（429），等一会儿再试。';
  if (/aborted/i.test(raw)) return '已取消。';
  return `模型服务出错了：${raw.slice(0, 200)}`;
}

/* -------------------------------------------------------------- 每日审查 */

/**
 * 每日审查 —— 一天第一次对话时在后台跑。
 *
 * 回顾昨天的会话和日程，提取新的偏好/模式/决定，写进记忆库。
 * 这是一个独立的 agent 跑，不阻塞当前对话。
 *
 * 审查 agent 有 save_memory 工具，能自己决定记什么。
 * 过时记忆由 pruneMemories 在存满时丢最旧的，不在这里删。
 */
async function runDailyReview(userId) {
  const cfg = aiSettings.load(userId);
  if (!cfg.baseUrl || !cfg.model) return; // 没配模型，跳过

  // 取昨天的会话
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);

  const sessions = db.listAiSessions(userId, 50);
  const yesterdaySessions = sessions.filter((s) => {
    const d = new Date(Number(s.created_at));
    return d.toISOString().slice(0, 10) === yStr;
  });

  // 收集昨天的对话文本
  const snippets = [];
  for (const s of yesterdaySessions) {
    const msgs = db.listAiMessages(s.id, userId);
    for (const m of msgs) {
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

  const proposals = new Map();
  const tools = allTools({ userId, proposals });

  const agent = new Agent({
    streamFn: realStreamFn(cfg),
    initialState: {
      systemPrompt: reviewPrompt,
      model: buildModel(cfg),
      tools,
      messages: [],
    },
  });

  try {
    await agent.run();
  } catch (e) {
    console.error('[ai] 每日审查失败', e && e.message ? e.message : e);
  }
}

/* -------------------------------------------------------------- 晚间汇报 */

/**
 * 晚间汇报 —— 一天结束时生成一份当日汇报，出现在 AI 面板里。
 *
 * 汇报是一个特殊会话（标题「每日汇报」），每天追加一条消息。
 * 内容：今天做了什么、明天有什么、有没有冲突。
 *
 * 这是一个独立的 agent 跑，在后台执行。
 */
export async function runEveningReport(userId) {
  const cfg = aiSettings.load(userId);
  if (!cfg.baseUrl || !cfg.model) return;

  // 检查今天有没有用过应用（有没有任何改动）
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const calIds = db.calendarIdsFor(userId);
  if (!calIds.length) return;

  const placeholders = calIds.map(() => '?').join(',');
  const changesToday = db.get(
    `SELECT COUNT(*) AS n FROM changes WHERE cal_id IN (${placeholders}) AND ts > ?`,
    ...calIds, startOfToday.getTime(),
  );
  if (!changesToday || !Number(changesToday.n)) return; // 今天没用过，不生成

  // 找或建「每日汇报」会话
  const sessions = db.listAiSessions(userId, 50);
  let reportSession = sessions.find((s) => s.title === '每日汇报');
  if (!reportSession) {
    const sid = randomUUID();
    db.insertAiSession(sid, userId, '每日汇报', Date.now());
    reportSession = { id: sid };
  }

  const t = today();
  const tomorrow = addDays(t, 1);

  const reportPrompt = `你是「日程清单」的晚间汇报任务。生成一份当日汇报。

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

  const proposals = new Map();
  const tools = allTools({ userId, proposals });

  const agent = new Agent({
    streamFn: realStreamFn(cfg),
    initialState: {
      systemPrompt: reportPrompt,
      model: buildModel(cfg),
      tools,
      messages: [],
    },
  });

  try {
    const messages = [];
    agent.on('message', (m) => { if (m) messages.push(m); });
    await agent.run();

    // 把汇报存进会话
    const assistant = messages.filter((m) => m && m.role === 'assistant').pop();
    if (assistant) {
      const text = (assistant.content || [])
        .filter((c) => c && c.type === 'text')
        .map((c) => String(c.text || ''))
        .join('')
        .trim();
      if (text) {
        const seq = db.nextAiMessageSeq(reportSession.id, userId);
        db.appendAiMessage(reportSession.id, userId, seq, 'assistant', JSON.stringify(assistant), null);
        db.touchAiSession(reportSession.id, userId);
      }
    }
  } catch (e) {
    console.error('[ai] 晚间汇报失败', e && e.message ? e.message : e);
  }
}
