/**
 * ai/tools.mjs —— AI 的操作接口（本体）
 *
 * 这就是用户要的「给 AI 留出操作的接口」。分成两类：
 *
 *   只读（`readTools`）—— 直接执行，结果喂回模型。
 *   写入（`writeTools`）—— **不执行**，只产出一张待用户确认的提案。
 *                          真的落库在 `lib/ai/confirm.js`，那里会重查一遍权限。
 *
 * ## 两条不许破的规矩
 *
 * 1. **数据一律从 `sync.snapshot(userId)` 拿，绝不自己写 SQL 查 `field_state`。**
 *    snapshot 已经按 `calendarIdsFor(userId)` 过滤过、已经剔掉墓碑。自己写一条
 *    SQL，权限过滤迟早漏一处 —— 那就成了「只读成员能通过 AI 看见别人的集」。
 *    代价是每次调用多算一遍快照；家庭规模（几千行）下这点开销可以忽略。
 *
 * 2. **工具的返回是给模型看的，不是给程序看的。** 字段名用中文语义、时间用
 *    `HH:MM`、日期用 `YYYY-MM-DD`、去掉 `_ts` / `_dev` 这类内部字段。
 *    这些内部字段对模型是纯噪声，还会白占上下文。
 *
 * 工具名与参数名保持英文：模型对 `list_tasks({from,to})` 这种形状的调用最稳，
 * 而描述用中文，回答才会跟着说中文。
 *
 * 阶段 2 只挂过只读那半边 —— 先把「模型能不能正确调到工具、参数对不对」
 * 解决掉，再引入写路径。两件事混在一起时，出问题分不清是工具层还是权限层。
 * 现在两边都在，`allTools()` 是完整的工具集（阶段 2 的用例仍只挂只读的）。
 */
import { randomUUID } from 'node:crypto';

import { Type } from '@earendil-works/pi-ai';

import db from '../db.js';
import sync from '../sync.js';
import calendars from '../calendars.js';
import {
  isIsoDate, today, addDays, eachDay, weekday, WEEKDAY_CN,
  minutesOfTime, timeOfMinutes, daysBetween,
} from './dates.mjs';

/* ------------------------------------------------------------------ 上限 */

/** 一次能看多少天。超过就截断并在结果里说明 —— 别让一句「看看今年的排期」把上下文撑爆 */
const MAX_DAYS = 62;
const MAX_ITEMS = 300;
const NOTE_MAX = 300;
const SEARCH_MAX = 40;

/* -------------------------------------------------------------- 读取工具 */

/**
 * 库里的一行 → 给模型看的形状。
 * `_ts` / `_dev` 一律丢掉：它们是同步内部的状态，对模型只有噪声。
 */
function project(t, calName) {
  const out = {
    id: t.id,
    cal: calName,
    title: t.title || '(无标题)',
    date: t.date || null,
    time: t.time || null,
  };
  if (t.duration && t.duration !== 60) out.duration = t.duration;
  if (t.done) out.done = true;
  if (t.note) out.note = String(t.note).slice(0, NOTE_MAX);
  const r = t.repeat;
  if (r && r.unit && r.unit !== 'none') out.repeat = `${r.n}${r.unit}`;
  return out;
}

/** 快照 → 我可见的活任务。墓碑 / 彻底删除的都不算。 */
function liveTasks(userId) {
  const snap = sync.snapshot(userId);
  const nameOf = new Map(calendars.listMine(userId).map((c) => [c.id, c.name]));
  const out = [];
  for (const t of Object.values(snap.tasks)) {
    if (t.deleted === true || t.purged === true) continue;
    out.push({ raw: t, view: project(t, nameOf.get(t.calId) || '?') });
  }
  return out;
}

const text = (obj) => [{ type: 'text', text: JSON.stringify(obj, null, 1) }];

/** 参数校验失败 —— 用 isError 让模型看到，它会自己改参数重试 */
const fail = (msg) => ({ content: [{ type: 'text', text: `参数有问题：${msg}` }], details: {}, isError: true });

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

/* ---------------------------------------------------------------- 工具集 */

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

/* -------------------------------------------------------------- 写入工具 */

/**
 * 写入工具**在这里只造提案，一行都不写库**。
 *
 * 为什么不写：写下去就没人能撤了。AI 理解错一句话，用户的日程就变了，
 * 而且它还会出现在别的设备上 —— 用户要找回来得进垃圾箱翻。
 * 所以这条路是「模型调工具 → 工具只记一条提案 → 用户点确认 → 才真写」。
 *
 * 三道闸，缺一不可：
 *
 *   1. **提示词**（prompt.mjs）说「先提案」，软的，管住模型的措辞；
 *   2. **这里**：写工具根本没有写的能力，模型再想直接改也改不了；
 *   3. **`POST /api/ai/confirm`** 才是唯一真的落库点，它在写之前
 *      **重新查一遍权限** —— 提案生成到确认之间，用户可能被降级或被移出那个集。
 *      （换成「信客户端回传的参数」就是把权限判断交给了浏览器。）
 *
 * ## 提案里存什么
 *
 * 存的是 `fields` —— **最终要落进 op 的那些字段**，不是「意图」。
 * 确认那一步因此完全不认识 kind、也不认识下面这些工具：它只管再查一次权限、
 * 给这批字段套上 deviceId='ai'、发一批 op。
 * 两边共用一份数据结构，就不会出现「工具改了、确认那边忘了跟着改」。
 */

export const WRITE_TOOL_NAMES = [
  'create_task', 'update_task', 'complete_task', 'reschedule_task', 'delete_task',
];

/** 标题 / 备注的上限。模型写长了不该把库撑起来 —— 与界面上能编的长度同量级 */
const TITLE_MAX = 200;
const DURATION_MIN = 5;
const DURATION_MAX = 24 * 60;

const isTime = (s) => minutesOfTime(s) != null;

/** 5 分钟步进，跟时间轴上拉伸的手感一致 */
function clampDuration(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 60;
  return Math.min(DURATION_MAX, Math.max(DURATION_MIN, Math.round(n / 5) * 5));
}

/**
 * 要写进哪个日程集。
 *
 * 模型经常不传 calId（它可能压根没先调 list_calendars）。只有一个可写的集时
 * 直接用那个 —— 家庭场景里这是绝大多数情况；有多个就让它指定，
 * **不能替它挑一个**：挑错了是把任务默默塞进别人的集。
 */
function pickCal(userId, raw) {
  const mine = calendars.listMine(userId);
  if (raw) {
    const hit = mine.find((c) => c.id === String(raw));
    if (!hit) return { error: `没有这个日程集：${raw}。先调 list_calendars 看看有哪些。` };
    if (!calendars.canWrite(hit.role)) return { error: `「${hit.name}」你只有查看权限，改不了里面的东西` };
    return { cal: hit };
  }
  const ok = mine.filter((c) => calendars.canWrite(c.role));
  if (!ok.length) return { error: '你没有任何可以改的日程集' };
  if (ok.length > 1) {
    return { error: `你手上有多个可写的日程集，得指定 calId：${ok.map((c) => `${c.name}=${c.id}`).join('、')}` };
  }
  return { cal: ok[0] };
}

/** 按 id 找一条**我可见的、还活着**的任务。找不到返回 null */
function findTask(userId, id) {
  const want = String(id || '');
  return liveTasks(userId).find((it) => it.raw.id === want) || null;
}

/** 按 id 找一个**我可见的、还活着的**打卡项。找不到返回 null */
function findHabit(userId, id) {
  const want = String(id || '');
  const snap = sync.snapshot(userId);
  const h = snap.habits[want];
  if (!h || h.deleted === true || h.purged === true) return null;
  return { raw: h, view: { id: h.id, title: h.title || '(无标题)' } };
}

/**
 * 记一条提案，回给模型一句「已记下」。
 *
 * 返回的是**成功**结果（isError 为假）：模型调工具这件事本身做对了，
 * 只是改动落在「等确认」这个状态里。回 isError 的话它会以为工具坏了、反复重试。
 */
function propose(proposals, toolCallId, p) {
  const proposal = {
    id: String(toolCallId),
    kind: p.kind,
    calId: p.calId,
    calName: p.calName,
    entity: 'task',
    entityId: p.entityId,
    title: p.title,
    fields: p.fields,
  };
  proposals.set(proposal.id, proposal);
  return {
    content: text({
      pending: true,
      kind: proposal.kind,
      cal: proposal.calName,
      title: proposal.title,
      changes: proposal.fields,
      note: '已记为待确认提案，数据库里**还没有**任何改动。'
        + '用一句话说清你打算改什么、改到哪天，然后等用户点确认 —— 不要说「已经改好了」。',
    }),
    details: { proposal },
  };
}

/**
 * 造一批写入工具。
 *
 * @param {{userId:string, proposals:Map<string,object>}} ctx
 *   `proposals` 是这一轮的提案收集器：工具的 `execute` 往它里面塞，
 *   chat.mjs 再按 **toolCallId** 把它们挂到对应的 assistant 消息上落库。
 *   按 toolCallId 而不是按顺序，是因为 pi 默认**并行**执行同一轮的多个工具，
 *   回来的顺序和消息里 toolCall 块的顺序可以不一样。
 */
export function writeTools({ userId, proposals }) {
  return [

    {
      name: 'create_task',
      label: '建一条任务',
      description:
        '新建一条任务。**调用它不会真的建** —— 只会记成一条待确认提案，用户点了确认才落库。'
        + 'date 省略 = 放进待办箱（还没定哪天）；date 有、time 省略 = 那天的事，但不定时间。'
        + '你不确定用户想放哪天时，先问清楚再调，别自己猜一个日期。',
      parameters: Type.Object({
        title: Type.String({ description: '任务标题，用用户的说法，尽量短' }),
        date: Type.Optional(Type.String({ description: 'YYYY-MM-DD，省略 = 待办箱' })),
        time: Type.Optional(Type.String({ description: 'HH:MM，省略 = 那天不定时' })),
        duration: Type.Optional(Type.Number({ description: '要多久，分钟，默认 60' })),
        note: Type.Optional(Type.String({ description: '备注，可省' })),
        calId: Type.Optional(Type.String({ description: '放进哪个日程集，省略 = 你唯一的那个可写集' })),
        repeat: Type.Optional(Type.Object({
          unit: Type.Optional(Type.String({ description: 'none|day|week|month|year，默认 none' })),
          n: Type.Optional(Type.Number({ description: '每 n 个 unit，默认 1' })),
        })),
      }),
      execute: async (toolCallId, args) => {
        const title = String(args.title || '').trim();
        if (!title) return fail('title 不能为空');

        const date = args.date ? String(args.date) : null;
        if (date && !isIsoDate(date)) return fail(`date 不是 YYYY-MM-DD：${date}`);
        const time = args.time ? String(args.time) : null;
        if (time && !isTime(time)) return fail(`time 不是 HH:MM：${time}`);

        const r = pickCal(userId, args.calId);
        if (r.error) return fail(r.error);

        // 重复规则。模型只给 unit 和 n，其余字段由这里补全。
        let repeat = null;
        if (args.repeat && args.repeat.unit && args.repeat.unit !== 'none') {
          const unit = String(args.repeat.unit);
          const n = Math.max(1, Math.min(365, Number(args.repeat.n) || 1));
          const day = date ? Number(date.slice(8, 10)) : 1;
          repeat = { unit, n, weekdays: [], monthday: day, end: null };
        }

        return propose(proposals, toolCallId, {
          kind: 'create',
          calId: r.cal.id,
          calName: r.cal.name,
          // id 在提案时就定下来。确认那一步因此不需要生成任何东西，
          // 卡片上显示的就是最终那条任务的 id
          entityId: randomUUID(),
          title: title.slice(0, TITLE_MAX),
          fields: {
            title: title.slice(0, TITLE_MAX),
            note: String(args.note || '').slice(0, NOTE_MAX),
            date,
            time,
            duration: clampDuration(args.duration),
            repeat,
            createdAt: Date.now(),
            source: 'ai',
          },
        });
      },
    },

    {
      name: 'update_task',
      label: '改一条任务',
      description:
        '改一条任务的标题 / 备注 / 日期 / 时间 / 时长。**只传要改的那几项**，没传的保持不动。'
        + 'date 传空串 = 挪回待办箱；time 传空串 = 清掉时间。'
        + '**调用它不会真的改**，只会记成待确认提案。'
        + 'id 要用 list_tasks / search_tasks 结果里的 id，不要自己编。',
      parameters: Type.Object({
        id: Type.String({ description: '任务 id' }),
        title: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
        date: Type.Optional(Type.String({ description: 'YYYY-MM-DD；空串 = 挪回待办箱' })),
        time: Type.Optional(Type.String({ description: 'HH:MM；空串 = 清掉时间' })),
        duration: Type.Optional(Type.Number({ description: '分钟' })),
      }),
      execute: async (toolCallId, args) => {
        const cur = findTask(userId, args.id);
        if (!cur) return fail(`找不到这条任务：${args.id}。用 list_tasks 或 search_tasks 拿准确的 id。`);

        const fields = {};
        const bad = fillFields(fields, args, cur.raw);
        if (bad) return fail(bad);
        if (!Object.keys(fields).length) return fail('没说要改什么');

        return propose(proposals, toolCallId, {
          kind: 'update',
          calId: cur.raw.calId,
          calName: cur.view.cal,
          entityId: cur.raw.id,
          title: fields.title || cur.raw.title,
          fields,
        });
      },
    },

    {
      name: 'complete_task',
      label: '标完成 / 取消完成',
      description:
        '把一条任务标成做完（done=true）或改回没做（done=false）。**只记提案，不落库。**'
        + '重复任务不行 —— 勾完成会顺带推出下一次，那套推算在客户端里，'
        + '让它用应用界面勾，别绕。',
      parameters: Type.Object({
        id: Type.String({ description: '任务 id' }),
        done: Type.Boolean({ description: 'true = 做完了，false = 改回没做' }),
      }),
      execute: async (toolCallId, args) => {
        const cur = findTask(userId, args.id);
        if (!cur) return fail(`找不到这条任务：${args.id}`);
        if (typeof args.done !== 'boolean') return fail('done 得是 true 或 false');

        const r = cur.raw.repeat;
        if (r && r.unit && r.unit !== 'none') {
          return fail('这是一条重复任务。勾完成要顺带推出下一次，那套推算只在客户端里 —— '
            + '请让用户在应用里勾，不要改它的 done。');
        }

        const done = args.done;
        return propose(proposals, toolCallId, {
          kind: done ? 'complete' : 'uncomplete',
          calId: cur.raw.calId,
          calName: cur.view.cal,
          entityId: cur.raw.id,
          title: cur.raw.title,
          fields: { done, doneAt: done ? Date.now() : null },
        });
      },
    },

    {
      name: 'reschedule_task',
      label: '给一条任务改期',
      description:
        '把一条任务挪到别的日期 / 时间。**只记提案，不落库。**'
        + 'time 省略 = 挪到那天但不定时间；date 必须有，'
        + '要挪回待办箱请用 update_task 传空 date。',
      parameters: Type.Object({
        id: Type.String({ description: '任务 id' }),
        date: Type.String({ description: '挪到哪天，YYYY-MM-DD' }),
        time: Type.Optional(Type.String({ description: 'HH:MM，省略 = 那天不定时' })),
      }),
      execute: async (toolCallId, args) => {
        const cur = findTask(userId, args.id);
        if (!cur) return fail(`找不到这条任务：${args.id}`);

        const date = String(args.date || '');
        if (!isIsoDate(date)) return fail(`date 不是 YYYY-MM-DD：${date}`);
        const time = args.time ? String(args.time) : null;
        if (time && !isTime(time)) return fail(`time 不是 HH:MM：${time}`);

        const fields = { date, time };
        // 未定时的任务靠 order 在「同一天」里排位次，而旧位次是属于旧日期的：
        // 留着会和那天已有的任务撞号，排序变得不稳定。清掉 = 排在那组最后。
        if (!time) fields.order = null;

        return propose(proposals, toolCallId, {
          kind: 'reschedule',
          calId: cur.raw.calId,
          calName: cur.view.cal,
          entityId: cur.raw.id,
          title: cur.raw.title,
          fields,
        });
      },
    },

    {
      name: 'delete_task',
      label: '删一条任务',
      description:
        '删一条任务。**只记提案，不落库**，而且删是**软删除** —— 它会进垃圾箱，'
        + '垃圾箱里那行会写着「从 AI 删的」，用户随时能还原。'
        + '用户说「删掉」时先确认是哪一条，别把名字像的都删了。',
      parameters: Type.Object({
        id: Type.String({ description: '任务 id' }),
      }),
      execute: async (toolCallId, args) => {
        const cur = findTask(userId, args.id);
        if (!cur) return fail(`找不到这条任务：${args.id}`);

        return propose(proposals, toolCallId, {
          kind: 'delete',
          calId: cur.raw.calId,
          calName: cur.view.cal,
          entityId: cur.raw.id,
          title: cur.raw.title,
          // trashFrom 是垃圾箱那行「从哪删的」的来源（store.deleteTask 的第二个参数）。
          // 写 'AI' 是为了让用户事后看得出来这次不是自己删的
          fields: { deleted: true, deletedAt: Date.now(), trashFrom: 'AI' },
        });
      },
    },

    // ---- 打卡（需确认）----

    {
      name: 'create_habit',
      label: '建一个打卡项',
      description:
        '新建一个打卡项（比如「每天喝水」「每天读书」）。**只记提案，不落库。**'
        + '打卡项不属于日程集，是全局的。',
      parameters: Type.Object({
        title: Type.String({ description: '打卡项名称，用用户的说法' }),
      }),
      execute: async (toolCallId, args) => {
        const title = String(args.title || '').trim();
        if (!title) return fail('title 不能为空');

        return propose(proposals, toolCallId, {
          kind: 'create',
          calId: null,
          calName: null,
          entity: 'habit',
          entityId: randomUUID(),
          title: title.slice(0, TITLE_MAX),
          fields: {
            title: title.slice(0, TITLE_MAX),
            order: Object.keys(sync.snapshot(userId).habits).length,
            log: {},
            createdAt: Date.now(),
            source: 'ai',
          },
        });
      },
    },

    {
      name: 'checkin_habit',
      label: '打卡',
      description:
        '给一个打卡项打卡（标记今天完成了）。**只记提案，不落库。**'
        + 'id 要用 list_tasks 或 search_tasks 结果里的 id。',
      parameters: Type.Object({
        id: Type.String({ description: '打卡项 id' }),
        date: Type.Optional(Type.String({ description: '哪天，YYYY-MM-DD，默认今天' })),
      }),
      execute: async (toolCallId, args) => {
        const cur = findHabit(userId, args.id);
        if (!cur) return fail(`找不到这个打卡项：${args.id}`);

        const date = args.date ? String(args.date) : today();
        if (!isIsoDate(date)) return fail(`date 不是 YYYY-MM-DD：${date}`);

        return propose(proposals, toolCallId, {
          kind: 'checkin',
          calId: null,
          calName: null,
          entity: 'habit',
          entityId: cur.raw.id,
          title: cur.raw.title,
          fields: { log: { ...cur.raw.log, [date]: true } },
        });
      },
    },

    {
      name: 'delete_habit',
      label: '删一个打卡项',
      description:
        '删一个打卡项。**只记提案，不落库**，删是软删除 —— 它会进垃圾箱。',
      parameters: Type.Object({
        id: Type.String({ description: '打卡项 id' }),
      }),
      execute: async (toolCallId, args) => {
        const cur = findHabit(userId, args.id);
        if (!cur) return fail(`找不到这个打卡项：${args.id}`);

        return propose(proposals, toolCallId, {
          kind: 'delete',
          calId: null,
          calName: null,
          entity: 'habit',
          entityId: cur.raw.id,
          title: cur.raw.title,
          fields: { deleted: true, deletedAt: Date.now(), trashFrom: 'AI' },
        });
      },
    },
  ];
}

/**
 * 把 `update_task` 传进来的字段翻成 op 字段，只认**真的传了**的那几个。
 *
 * 单独拆出来是因为「没传」和「传了空串」必须分开：没传 = 不动，
 * 传空串 = 清掉（把日期清掉就是挪回待办箱）。用 `??` 一律兜默认值就会把
 * 「没传」当成「清空」，用户改个标题顺手把日期抹了。
 *
 * @returns {string|null} 参数有问题时返回原因
 */
function fillFields(fields, args, cur) {
  if (args.title !== undefined) {
    const v = String(args.title).trim();
    if (!v) return 'title 不能改成空的（要删就用 delete_task）';
    fields.title = v.slice(0, TITLE_MAX);
  }
  if (args.note !== undefined) fields.note = String(args.note).slice(0, NOTE_MAX);

  if (args.date !== undefined) {
    const d = String(args.date);
    if (!d) fields.date = null;
    else if (!isIsoDate(d)) return `date 不是 YYYY-MM-DD：${d}`;
    else fields.date = d;
  }
  if (args.time !== undefined) {
    const t = String(args.time);
    if (!t) fields.time = null;
    else if (!isTime(t)) return `time 不是 HH:MM：${t}`;
    else fields.time = t;
  }
  if (args.duration !== undefined) fields.duration = clampDuration(args.duration);

  // 换了一天、而这条又是未定时的 —— 旧 order 属于旧日期，得清掉（同 reschedule_task）
  const effTime = ('time' in fields) ? fields.time : (cur.time || null);
  if ('date' in fields && !effTime) fields.order = null;
  return null;
}

/**
 * 一轮对话能用的全部工具：只读 + 写入 + 记忆。
 * 分开导出是为了让测试能只挂只读那半边（阶段 2 的用例就是这么写的）。
 */
export function allTools({ userId, proposals }) {
  return [...readTools({ userId }), ...writeTools({ userId, proposals }), ...memoryTools({ userId })];
}

/** 记忆工具 —— agent 自己决定记什么，不需要确认。 */
function memoryTools({ userId }) {
  return [
    {
      name: 'save_memory',
      label: '记住一件事',
      description:
        '把一条信息记进长期记忆，下次对话还能用。**只在用户表达了偏好、习惯、'
        + '重复模式或关键决定时才记** —— 比如「以后健身放早上」「每周三有例会」'
        + '「10月8日出差，别排事」。不要记流水账。',
      parameters: Type.Object({
        type: Type.String({ description: 'preference | decision | pattern' }),
        content: Type.String({ description: '要记的内容，一句话，用用户的说法' }),
      }),
      execute: async (_id, args) => {
        const type = String(args.type || '').trim();
        if (!['preference', 'decision', 'pattern'].includes(type)) {
          return fail('type 必须是 preference、decision 或 pattern');
        }
        const content = String(args.content || '').trim();
        if (!content) return fail('content 不能为空');
        if (content.length > 300) return fail('content 太长，一句话就够了');

        const { randomUUID } = await import('node:crypto');
        db.insertMemory({
          id: randomUUID(),
          userId,
          type,
          content: content.slice(0, 300),
          createdAt: Date.now(),
          lastUsedAt: null,
        });
        db.pruneMemories(userId);

        return {
          content: text({ saved: true, type, content: content.slice(0, 300) }),
          details: {},
        };
      },
    },
  ];
}

export const READ_TOOL_NAMES = [
  'list_calendars', 'list_tasks', 'search_tasks', 'load_summary', 'free_slots',
];
