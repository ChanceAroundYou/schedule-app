/**
 * routes/ai.js —— AI 这一组
 *
 * AI 在这个后端里的身份是「**另一台设备**」，不是一条新通道：它读走
 * `sync.snapshot(userId)`，写走 `sync.applyOps(userId, ops)`，`deviceId` 固定
 * `'ai'`。所以这里**没有**为 AI 单开一套鉴权或存储，它跟手机走的是同一套。
 *
 * 三个真正的落点（**别的都是只读或代理**）：
 *   - `POST /api/ai/chat`      自己写响应（流式），返回 `{ raw: true }`
 *   - `POST /api/ai/confirm`   **唯一真正写数据的地方**，权限在这里重查一遍
 *   - `save_memory` 工具       写记忆（不需要确认，且不写进 changes）
 *
 * 另五个是纯代理：settings / sessions / memory / history / authorizations，
 * 判断全在 lib/ai/*.js 里，这里只把 `me.user.id` 和参数递过去。
 *
 * **限流的位置是有讲究的**：`/chat` 放在**开流之前** —— 开了流再报 429 的话，
 * 前端拿到的是一个 200 的流里夹着一条错误，比直接 429 难处理得多。
 */
'use strict';

const rl = require('../lib/ratelimit');
const aiSettings = require('../lib/ai/settings');
const aiSessions = require('../lib/ai/sessions');
const aiConfirm = require('../lib/ai/confirm');
const aiMemory = require('../lib/ai/memory');
const aiHistory = require('../lib/ai/history');
const aiAuthorizations = require('../lib/ai/authorizations');
const ai = require('../lib/ai');
const { TEXT_MAX } = require('../config');
const { tooMany } = require('../http');

module.exports = {

  /**
   * 模型配置。**只回 hasKey，绝不回显 key** —— 见 lib/ai/settings.js。
   * 读接口不限流：它既不烧额度、也不回答「这个密码对不对」。
   */
  'GET /api/ai/settings': (ctx, me) => aiSettings.read(me.user.id),

  'PUT /api/ai/settings': (ctx, me) => aiSettings.update(me.user.id, ctx.body || {}),

  /**
   * 发一轮对话。**这个处理器自己写响应**（流式），所以返回 `{ raw: true }`
   * 让路由层别再去 send()。见 lib/ai/sse.mjs 里的说明。
   */
  'POST /api/ai/chat': async (ctx, me) => {
    const userId = me.user.id;
    const limited = rl.hitBoth([`ai-chat:${userId}`], 30, 60 * 1000);
    if (!limited.ok) return tooMany(limited);

    const text = String((ctx.body || {}).text || '').trim();
    if (!text) return { status: 400, body: { error: '说点什么' } };
    if (text.length > TEXT_MAX) return { status: 400, body: { error: `一次最多 ${TEXT_MAX} 字` } };

    let mod;
    try {
      // 动态 import：依赖没装时只有这一条路会失败（抛出去变成 503 + 原因），
      // 而不会让整个进程起不来 —— 后端不装 AI 依赖照样能当纯日程用。
      mod = await ai.load();
    } catch (e) {
      return { status: 503, body: { error: e.message } };
    }
    const { runChat, openStream, sendEvent, endStream, abortOnClose } = mod;

    openStream(ctx.res);
    // 用户关掉页面 / 点取消 → 把上游那一次请求也掐掉，别让它在后台继续烧
    const ac = new AbortController();
    abortOnClose(ctx.res, () => ac.abort());

    try {
      await runChat({
        userId,
        sessionId: ctx.body.sessionId,
        text,
        context: ctx.body.context,
        emit: (e) => sendEvent(ctx.res, e),
        signal: ac.signal,
      });
    } catch (e) {
      // runChat 自己会兜住上游错误并 emit error 事件，走到这里说明是更外层的意外。
      // 只记 message 不记堆栈：同 router.js，堆栈可能带着库文件路径
      console.error('[ai/chat]', e && e.message ? e.message : e);
      sendEvent(ctx.res, { type: 'error', message: '服务器内部错误', code: 'server' });
    } finally {
      endStream(ctx.res);
    }
    return { raw: true };
  },

  /**
   * 确认若干条提案 —— **AI 唯一真正写数据的地方**。
   *
   * 请求体只有 `{ ids }`，**没有一个可写字段**：要写什么按 id 从库里读回来，
   * 权限也在这里重查一遍（提案生成到确认之间用户可能已经被降级 / 被移出）。
   * 这两条的理由写在 lib/ai/confirm.js 的文件头。
   *
   * 限流放在写之前。确认本身不烧额度，但它一次能改几十条任务，
   * 值得和 /chat 一个级别的保护。
   */
  'POST /api/ai/confirm': (ctx, me) => {
    const userId = me.user.id;
    const limited = rl.hitBoth([`ai-confirm:${userId}`], 60, 60 * 1000);
    if (!limited.ok) return tooMany(limited);
    return aiConfirm.confirm(userId, (ctx.body || {}).ids);
  },

  'GET /api/ai/sessions': (ctx, me) => aiSessions.list(me.user.id),

  'GET /api/ai/sessions/:sessionId': (ctx, me) =>
    aiSessions.one(me.user.id, ctx.params.sessionId),

  'DELETE /api/ai/sessions/:sessionId': (ctx, me) =>
    aiSessions.remove(me.user.id, ctx.params.sessionId),

  /* ---- 记忆 ---- */

  'GET /api/ai/memory': (ctx, me) => aiMemory.list(me.user.id),

  'PUT /api/ai/memory/:id': (ctx, me) =>
    aiMemory.update(me.user.id, ctx.params.id, ctx.body || {}),

  'DELETE /api/ai/memory/:id': (ctx, me) =>
    aiMemory.remove(me.user.id, ctx.params.id),

  /* ---- 操作历史 ---- */

  'GET /api/ai/history': (ctx, me) =>
    aiHistory.list(me.user.id, {
      aiOnly: ctx.query.aiOnly === '1' || ctx.query.aiOnly === 'true',
      limit: ctx.query.limit,
    }),

  /* ---- 授权 ---- */

  'GET /api/ai/authorizations': (ctx, me) =>
    aiAuthorizations.read(me.user.id),

  'PUT /api/ai/authorizations': (ctx, me) =>
    aiAuthorizations.update(me.user.id, ctx.body || {}),

};