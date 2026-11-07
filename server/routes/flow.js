/**
 * routes/flow.js —— 每日流程（个人私有）
 *
 * 两条接口：
 *   GET /api/flow?from=YYYY-MM-DD&to=YYYY-MM-DD
 *       → { today, template, days: { 'YYYY-MM-DD': {rev,items} } }
 *   PUT /api/flow
 *       { doc: 'template'|'YYYY-MM-DD', baseRev, items }
 *       → { doc, rev, items, stale }
 *
 * **不属于任何日程集**（按 user_id 归属），所以不查 roleOf、不走 applyOps：
 * 这里没有任何「别人也能改我这一份」的入口，能登录就是唯一门槛。
 * 这与 counters 的设计同一个理由，见 lib/db/counters.js 顶部那段。
 *
 * `today` 由服务端给：设备时间可能不准，而「今天」决定打开哪一份清单。
 */
'use strict';

const db = require('../lib/db');

/** 服务端「今天」。与 widget 那边同一口径（服务器本地日期） */
function serverToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shiftIso(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 一次最多回多少天。客户端只按「今天前后各若干天」取，
 * 给上限是为了防止一个手改的 from/to 把整个库都拖出来。
 */
const MAX_SPAN = 120;

module.exports = {

  'GET /api/flow': (ctx, me) => {
    const today = serverToday();
    /* 查询参数从 `ctx.req.url` 自己解 —— router 只把 pathname 拆给处理器，
       没有 query 对象（`ctx.query` 在这个项目里并不存在）。 */
    let q = {};
    try {
      q = Object.fromEntries(new URL(ctx.req.url, 'http://localhost').searchParams);
    } catch (_) { q = {}; }
    const from = typeof q.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : shiftIso(today, -7);
    const to = typeof q.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : shiftIso(today, 7);
    if (from > to) return { status: 400, body: { error: 'from 不能晚于 to' } };
    if (shiftIso(from, MAX_SPAN) < to) return { status: 400, body: { error: '区间太大' } };

    return {
      status: 200,
      body: {
        today,
        template: db.getFlowDoc(me.user.id, 'template'),
        days: db.listFlowDocs(me.user.id, from, to),
      },
    };
  },

  'PUT /api/flow': (ctx, me) => {
    const body = ctx.body || {};
    const doc = typeof body.doc === 'string' ? body.doc : '';
    if (!db.isFlowDocName(doc)) return { status: 400, body: { error: 'doc 只能是 template 或 YYYY-MM-DD' } };
    if (!Array.isArray(body.items)) return { status: 400, body: { error: 'items 必须是数组' } };
    if (body.items.length > db.FLOW_MAX_ITEMS) {
      return { status: 400, body: { error: `一天最多 ${db.FLOW_MAX_ITEMS} 项` } };
    }

    const baseRev = typeof body.baseRev === 'number' && Number.isFinite(body.baseRev) ? body.baseRev : null;
    const out = db.putFlowDoc(me.user.id, doc, { items: body.items }, baseRev);
    // null = body 超长 / doc 不合法 —— 两种情况都已经在前面挡过，这里是兜底
    if (!out) return { status: 400, body: { error: '这一份流程存不下（内容太长）' } };

    return { status: 200, body: { doc, ...out } };
  },

};
