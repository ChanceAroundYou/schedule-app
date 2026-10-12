/**
 * ai/tools/shared.mjs —— 工具层的公共部分
 *
 * 两条不许破的规矩（写在工具层的根上，read / write / memory 都受约束）：
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
 */
import sync from '../../sync.js';
import calendars from '../../calendars.js';

/* ------------------------------------------------------------------ 上限 */

/** 一次能看多少天。超过就截断并在结果里说明 —— 别让一句「看看今年的排期」把上下文撑爆 */
export const MAX_DAYS = 62;
export const MAX_ITEMS = 300;
export const NOTE_MAX = 300;
export const SEARCH_MAX = 40;

/** 标题的上限。模型写长了不该把库撑起来 —— 与界面上能编的长度同量级 */
export const TITLE_MAX = 200;
export const DURATION_MIN = 5;
export const DURATION_MAX = 24 * 60;

/* ------------------------------------------------------------ 通用工具件 */

/** 给模型看的结果一律包成一段 JSON 文本 */
export const text = (obj) => [{ type: 'text', text: JSON.stringify(obj, null, 1) }];

/** 参数校验失败 —— 用 isError 让模型看到，它会自己改参数重试 */
export const fail = (msg) => ({ content: [{ type: 'text', text: `参数有问题：${msg}` }], details: {}, isError: true });

/**
 * 库里的一行 → 给模型看的形状。
 * `_ts` / `_dev` 一律丢掉：它们是同步内部的状态，对模型只有噪声。
 */
export function project(t, calName) {
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
export function liveTasks(userId) {
  const snap = sync.snapshot(userId);
  const nameOf = new Map(calendars.listMine(userId).map((c) => [c.id, c.name]));
  const out = [];
  for (const t of Object.values(snap.tasks)) {
    if (t.deleted === true || t.purged === true) continue;
    out.push({ raw: t, view: project(t, nameOf.get(t.calId) || '?') });
  }
  return out;
}

/** 按 id 找一条**我可见的、还活着**的任务。找不到返回 null */
export function findTask(userId, id) {
  const want = String(id || '');
  return liveTasks(userId).find((it) => it.raw.id === want) || null;
}

/** 按 id 找一个**我可见的、还活着的**打卡项。找不到返回 null */
export function findHabit(userId, id) {
  const want = String(id || '');
  const snap = sync.snapshot(userId);
  const h = snap.habits[want];
  if (!h || h.deleted === true || h.purged === true) return null;
  return { raw: h, view: { id: h.id, title: h.title || '(无标题)' } };
}

export { sync, calendars };