/**
 * ai/tools/read.mjs —— 只读工具
 *
 * 直接执行，结果喂回模型。
 */
import { Type } from '@earendil-works/pi-ai';
import {
  isIsoDate, today, addDays, eachDay, weekday, WEEKDAY_CN,
  minutesOfTime, timeOfMinutes, daysBetween,
} from '../dates.mjs';
import {
  MAX_DAYS, MAX_ITEMS, SEARCH_MAX,
  text, fail, liveTasks, calendars,
} from './shared.mjs';

/**
 * 解析 from / to。两个都可省：省了就是「今天起 7 天」。
 * @returns {{from:string, to:string}|{error:string}}
 */
function range(args) {
  const t = today();
  const from = args.from ? String(args.from) : t;
  // **先校验 from 再推 to**。反过来写的话，`from` 是「不是日期」这种串时
  // `addDays(from, 6)` 会在 Date 那层抛一个 `Invalid time value` ——
  // 那是个未捕获的异常，工具错误结果根本没生成，整轮对话直接断掉。
  // 模型给出垃圾日期是常事，这里必须走「回一条 isError 让它自己改」那条路。
  if (!isIsoDate(from)) return { error: `from 不是 YYYY-MM-DD：${from}` };

  const to = args.to ? String(args.to) : addDays(from, 6);
  if (!isIsoDate(to)) return { error: `to 不是 YYYY-MM-DD：${to}` };
  const n = daysBetween(from, to);
  if (n < 0) return { error: `to（${to}）早于 from（${from}）` };
  if (n >= MAX_DAYS) return { error: `区间最长 ${MAX_DAYS} 天，这次要了 ${n + 1} 天` };
  return { from, to };
}

/** 排好的任务按 catch 的日期放进桶里 */
function byDate(items) {
  const m = new Map();
  for (const it of items) {
    if (!it.view.date) continue;
    if (!m.has(it.view.date)) m.set(it.view.date, []);
    m.get(it.view.date).push(it.view);
  }
  for (const list of m.values()) {
    list.sort((a, b) => (a.time || 'zz').localeCompare(b.time || 'zz'));
  }
  return m;
}

/**
 * 造一批只读工具。
 * @param {{userId:string}} ctx
 */
export function readTools({ userId }) {
  return [

    {
      name: 'list_calendars',
      label: '看日程集',
      description: '列出我加入的全部日程集，含我在每个集里的角色（owner=可改可管人 / editor=可改 / viewer=只读）。任务只存在于日程集里，改任务前要先知道有哪些集。',
      parameters: Type.Object({}),
      execute: async () => {
        const cals = calendars.listMine(userId);
        return {
          content: text({ cals: cals.map((c) => ({ id: c.id, name: c.name, role: c.role })) }),
          details: { cals },
        };
      },
    },

    {
      name: 'list_tasks',
      label: '看这段时间的任务',
      description:
        '按日期列出任务。不传 from/to 就是「今天起 7 天」。未定日期的任务单独放在 inbox 里。' +
        '默认不含已完成的；要看已完成的把 includeDone 设成 true。',
      parameters: Type.Object({
        from: Type.Optional(Type.String({ description: '起（含），YYYY-MM-DD' })),
        to: Type.Optional(Type.String({ description: '止（含），YYYY-MM-DD' })),
        calId: Type.Optional(Type.String({ description: '只看某个日程集，省略=全部' })),
        includeDone: Type.Optional(Type.Boolean({ description: '是否包含已完成的，默认 false' })),
      }),
      execute: async (id, args) => {
        const r = range(args);
        if (r.error) return fail(r.error);

        const all = liveTasks(userId);
        const wantCal = args.calId ? String(args.calId) : null;
        const days = eachDay(r.from, r.to);

        let pool = all.filter((it) => !wantCal || it.raw.calId === wantCal);
        if (!args.includeDone) pool = pool.filter((it) => !it.raw.done);

        const buckets = byDate(pool.filter((it) => days.includes(it.view.date)));
        const inbox = pool.filter((it) => !it.view.date).map((it) => it.view);
        const overdue = pool
          .filter((it) => it.view.date && it.view.date < today())
          .map((it) => it.view);

        const out = {
          from: r.from,
          to: r.to,
          days: days.map((d) => ({
            date: d,
            weekday: WEEKDAY_CN[weekday(d)],
            tasks: buckets.get(d) || [],
          })),
        };
        if (inbox.length) out.inbox = inbox.slice(0, MAX_ITEMS);
        if (overdue.length) out.overdue = overdue.slice(0, MAX_ITEMS);

        const count = out.days.reduce((n, d) => n + d.tasks.length, 0)
          + (out.inbox ? out.inbox.length : 0) + (out.overdue ? out.overdue.length : 0);
        if (count > MAX_ITEMS) out.note = `结果较多，只给了前 ${MAX_ITEMS} 条，缩小日期范围可以看全`;

        return { content: text(out), details: out };
      },
    },

    {
      name: 'search_tasks',
      label: '搜任务',
      description: '在标题和备注里找词。用来回答「那个家长会安排在几号」这类问题。',
      parameters: Type.Object({
        query: Type.String({ description: '要找的词，会做包含匹配' }),
      }),
      execute: async (id, args) => {
        const q = String(args.query || '').trim();
        if (!q) return fail('query 不能为空');
        const lower = q.toLowerCase();

        const hits = liveTasks(userId)
          .filter((it) => {
            const t = it.raw;
            const hay = `${t.title || ''}\n${t.note || ''}`.toLowerCase();
            return hay.includes(lower);
          })
          .map((it) => it.view)
          .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));

        const out = { query: q, total: hits.length, tasks: hits.slice(0, SEARCH_MAX) };
        if (hits.length > SEARCH_MAX) out.note = `命中 ${hits.length} 条，只列了前 ${SEARCH_MAX} 条`;
        return { content: text(out), details: out };
      },
    },

    {
      name: 'load_summary',
      label: '看每天的忙闲',
      description:
        '每天排了多少事：count=任务条数，mins=已排的分钟数（只算定了时间的，没定时的只计数不计分钟）。' +
        '想知道「哪天比较空」时先看它，别先拉全部任务。',
      parameters: Type.Object({
        from: Type.Optional(Type.String({ description: '起（含），YYYY-MM-DD' })),
        to: Type.Optional(Type.String({ description: '止（含），YYYY-MM-DD' })),
      }),
      execute: async (id, args) => {
        const r = range(args);
        if (r.error) return fail(r.error);

        // 口径与前端 domain/model.ts 的 dayLoad 完全一致：
        // 跳过已完成、跳过别的日期，只有定了时间的才累加 duration（默认 60）。
        // 两边算得不一样的话，界面上显示「3 小时」而 AI 说「很空」。
        const acc = new Map();
        for (const { raw } of liveTasks(userId)) {
          if (raw.done || !raw.date) continue;
          const cur = acc.get(raw.date) || { day: raw.date, count: 0, mins: 0 };
          cur.count += 1;
          if (raw.time) cur.mins += raw.duration || 60;
          acc.set(raw.date, cur);
        }

        const days = eachDay(r.from, r.to).map((d) => acc.get(d) || { day: d, count: 0, mins: 0 });
        const out = {
          from: r.from,
          to: r.to,
          days,
          busiest: days.reduce((a, b) => (b.mins + b.count > a.mins + a.count ? b : a), days[0]),
        };
        return { content: text(out), details: out };
      },
    },

    {
      name: 'free_slots',
      label: '找空档',
      description:
        '把有时间的任务占掉之后，看每天还剩哪些整段空闲。默认按 08:00–22:00 这个作息窗口算，' +
        '只回长度 >= minMinutes（默认 60）的空档。回答「哪天适合出去玩」用它，' +
        '再配上 load_summary 看每天的任务条数。',
      parameters: Type.Object({
        from: Type.Optional(Type.String({ description: '起（含），YYYY-MM-DD' })),
        to: Type.Optional(Type.String({ description: '止（含），YYYY-MM-DD' })),
        minMinutes: Type.Optional(Type.Number({ description: '最短空档分钟数，默认 60' })),
        dayStartHour: Type.Optional(Type.Number({ description: '作息窗口起点，默认 8' })),
        dayEndHour: Type.Optional(Type.Number({ description: '作息窗口终点，默认 22' })),
      }),
      execute: async (id, args) => {
        const r = range(args);
        if (r.error) return fail(r.error);

        const min = Number.isFinite(args.minMinutes) ? Math.max(15, Number(args.minMinutes)) : 60;
        const h0 = Number.isFinite(args.dayStartHour) ? Math.min(23, Math.max(0, Number(args.dayStartHour))) : 8;
        const h1 = Number.isFinite(args.dayEndHour) ? Math.min(24, Math.max(h0 + 1, Number(args.dayEndHour))) : 22;
        const winStart = h0 * 60;
        const winEnd = h1 * 60;

        const days = eachDay(r.from, r.to);

        // 每天被占用的时间段。**跳过已完成的** —— 「哪天有空出去玩」问的是
        // 将来，已经做完的事不再占着时间（时间轴上灰显留着是为了回顾，
        // 不是为了让日程继续是满的）。
        const busy = new Map();
        for (const { raw } of liveTasks(userId)) {
          if (raw.done || !raw.time || !days.includes(raw.date)) continue;
          const s = minutesOfTime(raw.time);
          if (s == null) continue;
          const e = Math.min(winEnd, s + (raw.duration || 60));
          if (e <= winStart) continue;
          if (!busy.has(raw.date)) busy.set(raw.date, []);
          busy.get(raw.date).push([Math.max(winStart, s), e]);
        }

        const out = { from: r.from, to: r.to, window: `${timeOfMinutes(winStart)}-${timeOfMinutes(winEnd)}`, minMinutes: min, days: [] };
        for (const d of days) {
          const iv = (busy.get(d) || []).sort((a, b) => a[0] - b[0]);
          // 合并重叠（layoutOverlap 那边是同一个思路：一格一格推，看当前段有没有
          // 和已累积的那段接上）
          const merged = [];
          for (const [s, e] of iv) {
            const last = merged[merged.length - 1];
            if (last && s <= last[1]) last[1] = Math.max(last[1], e);
            else merged.push([s, e]);
          }

          const gaps = [];
          let cur = winStart;
          for (const [s, e] of merged) {
            if (s - cur >= min) gaps.push({ start: timeOfMinutes(cur), end: timeOfMinutes(s), minutes: s - cur });
            cur = Math.max(cur, e);
          }
          if (winEnd - cur >= min) {
            gaps.push({ start: timeOfMinutes(cur), end: timeOfMinutes(winEnd), minutes: winEnd - cur });
          }

          out.days.push({
            date: d,
            weekday: WEEKDAY_CN[weekday(d)],
            free: gaps,
            busyMinutes: merged.reduce((n, [s, e]) => n + (e - s), 0),
            freeMinutes: gaps.reduce((n, g) => n + g.minutes, 0),
          });
        }
        return { content: text(out), details: out };
      },
    },
  ];
}

export const READ_TOOL_NAMES = [
  'list_calendars', 'list_tasks', 'search_tasks', 'load_summary', 'free_slots',
];