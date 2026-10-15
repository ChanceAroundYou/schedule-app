/**
 * routes/widget.js —— 桌面小组件的两个接口
 *
 * **为什么单独开一组接口**，而不是让小组件直接打 `/api/sync`：
 *
 * 1. 小组件跑在原生侧（Java/HttpURLConnection），它没有 localStorage、
 *    没有 IndexedDB、跑不了同步引擎。让它复用 `/api/sync` 就得把整套
 *    游标 / 快照合并 / outbox 语义在 Java 里再实现一遍 —— 那是把最难的
 *    一块逻辑复制到第二个地方，必然对不上。
 * 2. 小组件只需要「今天前后几周的任务 + 今天的打卡」，全量快照里带着
 *    每个字段的 `_ts`/`_dev` 和全部历史集，白下载几十 KB。
 *
 * **返回形状与 App 写的快照完全一致**（见 app/src/domain/widgetSnapshot.ts
 * 和原生 WidgetData.java）—— 否则原生侧要养两套解析器，而两套解析器
 * 对不上时的表现是「桌面一片空白」，最难查。
 *
 * **权限不绕。** 写操作最终仍然走 `sync.applyOps` —— 它是全项目唯一的
 * 服务端写入闸门（见 lib/ai/confirm.js 同一段论证），`applyOps` 内部自己
 * 查 `roleOf` + `canWrite`。这里只负责把小组件的「简化 op」补成合法 op，
 * 不多做一步判断，也不少做一步。
 *
 * 两条接口：
 *   GET  /api/widget/bootstrap   拉一次数据（含服务端「今天」，设备时间可能不准）
 *   POST /api/widget/op          写：勾完成 / 打卡 / 新建
 */
'use strict';

const sync = require('../lib/sync');
const calendars = require('../lib/calendars');
const crypto = require('node:crypto');

/** 前后各取多少天。小组件日期条要点到明天/后天，取宽点省得来回拉 */
const SPAN_DAYS = 45;

/** 服务端「今天」。设备时间可能不准，小组件选日期、判今天都以这个为准 */
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
 * 连续打卡天数。与 app/src/domain/model/habits.ts 的 habitStreak 同一套语义：
 * 今天已打从今天起算，否则从昨天起算（昨天也没打就是 0）。
 */
function streakOf(log, today) {
  if (!log || typeof log !== 'object') return 0;
  let n = 0;
  let d = today;
  if (!log[d]) {
    d = shiftIso(d, -1);
    if (!log[d]) return 0;
  }
  while (log[d]) {
    n += 1;
    d = shiftIso(d, -1);
  }
  return n;
}

/**
 * 取我可见的集，压成小组件快照的形状。
 *
 * 墓碑（deleted）snapshot() 已经剔掉了，这里不用再过一遍。
 */
function widgetView(userId) {
  const snap = sync.snapshot(userId);
  const today = serverToday();
  const lo = shiftIso(today, -SPAN_DAYS);
  const hi = shiftIso(today, SPAN_DAYS);

  const tasks = [];
  for (const t of Object.values(snap.tasks)) {
    const d = typeof t.date === 'string' ? t.date : '';
    if (!d || d < lo || d > hi) continue;
    tasks.push({
      id: t.id,
      calId: t.calId,
      date: d,
      time: t.time == null ? null : t.time,
      dur: typeof t.duration === 'number' ? t.duration : 0,
      title: typeof t.title === 'string' ? t.title : '',
      done: t.done === true,
      // ⚠️ **repeat / reminder 必须带**（2026-10-14 补）。
      // 小组件的编辑弹窗要显示「重复：每周三」「提醒：08:30」，而它的数据
      // 全部来自这里的 widgetView —— 早先没带这两个字段，表现是：
      //   · 小组件里改了重复 → 本地乐观改了，但 op 落地后按这个视图回写，
      //     repeat 不在视图里 → **本地那份被抹掉**，看起来「改了存不住」；
      //   · 小组件上给任务设了重复/提醒的任务，重新 bootstrap 后又变回没有。
      // 服务端本来就是按字段名存的（sync.js 无字段白名单），所以只是漏带。
      repeat: t.repeat == null ? null : t.repeat,
      reminder: t.reminder == null ? null : t.reminder,
      /* repeatUntil：这个重复系列已经结束的那一天（不含）。2026-10-14 加。
         原生侧 RepeatSpawn 补窗口时必须看它 —— 不带的话，一个「已结束」的系列
         （根还活着、repeat 还在、结束日之后的实例都被删了）会被判定成
         「窗口不足」而反复补齐，而 App 那边又按同一个标记把它们删掉，
         两边乒乓不停，把 refresh 递归成主线程死循环（症状：App 卡在开屏页）。
         跟 repeat / reminder 同理：字段按名字存在，服务端没有白名单。 */
      repeatUntil: t.repeatUntil == null ? null : t.repeatUntil,
    });
  }
  tasks.sort((a, b) => (a.date + (a.time || 'zzzz')).localeCompare(b.date + (b.time || 'zzzz')));

  const habits = [];
  for (const h of Object.values(snap.habits)) {
    habits.push({
      id: h.id,
      calId: h.calId,
      title: typeof h.title === 'string' ? h.title : '',
      done: !!(h.log && h.log[today]),
      streak: streakOf(h.log, today),
      // ⚠️ **必须带上整个 log 映射**，不能只给 done。
      // log 是按日期的稀疏表，而 applyOps 是「字段整值替换」——
      // 小组件改打卡时要回写整个对象，只发一天会把别的日期全抹掉。
      // 早年这里没带 log，小组件只能发一个日期字符串，服务端存进去之后
      // `h.log[today]` 恒为 undefined，表现是「打卡点了永远不生效」。
      log: (h.log && typeof h.log === 'object') ? h.log : {},
    });
  }
  habits.sort((a, b) => (a.order || 0) - (b.order || 0));

  return {
    v: 1,
    at: Date.now(),
    today,
    from: lo,
    to: hi,
    tasks,
    habits,
  };
}

module.exports = {

  'GET /api/widget/bootstrap': (ctx, me) => {
    const view = widgetView(me.user.id);
    const mine = calendars.listMine(me.user.id);
    const writable = mine.filter((c) => calendars.canWrite(c.role));
    // 默认集 = 第一个能写的；一个都不能写（纯 viewer）时退回第一个，
    // 至少让小组件有东西可显示
    const fallback = writable[0] || mine[0] || null;
    return {
      status: 200,
      body: {
        ...view,
        user: { id: me.user.id, name: me.user.name },
        defaultCalId: fallback ? fallback.id : null,
        cals: mine.map((c) => ({ id: c.id, name: c.name, role: c.role })),
      },
    };
  },

  /**
   * 写操作。客户端发「简化 op」，服务端补全后走 applyOps。
   *
   * ts 用**服务器时间**而不是客户端的：小组件那块设备时间未必准，
   * 而 applyOps 有 ±24 小时的偏移门槛，客户端时钟漂一下整批就被拒。
   * 代价是这条 op 的 LWW 时间戳不来自写入方 —— 对小组件这种低频写入可接受。
   */
  'POST /api/widget/op': (ctx, me) => {
    const userId = me.user.id;
    const body = ctx.body || {};
    const incoming = Array.isArray(body.ops) ? body.ops : [];
    if (!incoming.length) return { status: 400, body: { error: 'ops 不能为空' } };
    if (incoming.length > 50) return { status: 400, body: { error: '一次最多 50 条' } };

    const deviceId = typeof body.deviceId === 'string' && body.deviceId
      ? body.deviceId.slice(0, 64)
      : 'widget-anonymous';
    const now = Date.now();
    const ops = [];

    for (const o of incoming) {
      if (!o || typeof o !== 'object') continue;
      const calId = typeof o.calId === 'string' ? o.calId : '';
      const entity = o.entity === 'habit' ? 'habit' : 'task';
      const entityId = typeof o.entityId === 'string' ? o.entityId : '';
      if (!calId || !entityId) continue;
      const fields = (o.fields && typeof o.fields === 'object') ? o.fields : null;
      if (!fields) continue;

      // 新建时客户端不知道 id，让它传 '@new' 由服务端发一个
      const id = entityId === '@new'
        ? `t_${crypto.randomBytes(8).toString('hex')}`
        : entityId;

      ops.push({
        opId: crypto.randomUUID(),
        deviceId,
        calId,
        entity,
        entityId: id,
        ts: now,
        fields,
      });
    }

    if (!ops.length) return { status: 400, body: { error: '没有可应用的 op' } };

    const { applied, rejected } = sync.applyOps(userId, ops);

    // 顺手把最新数据带回去，省得小组件再发一次 bootstrap
    return {
      status: 200,
      body: { applied: applied.length, rejected, ...widgetView(userId) },
    };
  },

};
