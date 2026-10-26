/**
 * tasks.ts —— 任务查询
 */

import type { LocalState, Task } from '../types/types.ts';
import * as D from '../date.ts';
import { isGone, isTrashed } from './visibility.ts';
import { plain } from './richText.ts';

export function liveTasks(s: LocalState): Task[] { return Object.values(s.tasks).filter((t) => !isGone(t)); }

export function trashedTasks(s: LocalState): Task[] {
  return Object.values(s.tasks).filter(isTrashed).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

export function taskById(s: LocalState, id: string): Task | null {
  const t = s.tasks[id];
  return t && !isGone(t) ? t : null;
}

function matches(t: { title: string; note?: string }, kw: string): boolean {
  if (!kw) return true;
  const k = kw.toLowerCase();
  /* 详细内容已经是富文本（2026-10-26）：**必须剥掉标签再比**。
     不剥的话搜「p」「div」这种字母会把所有带段落的备注都搜出来，
     而真正的字反而可能被标签切断（`加钱请 <strong>RA</strong>`）。 */
  return t.title.toLowerCase().includes(k) || plain(t.note || '').toLowerCase().includes(k);
}

/** 某一天的任务（按时间/位次排好序） */
export function tasksOn(s: LocalState, isoDate: string): Task[] {
  const kw = s.ui.search || '';
  return sortTasks(liveTasks(s).filter((t) => t.date === isoDate && matches(t, kw)));
}

/**
 * 某一天的未定时任务（**含已完成的**）。
 *
 * 2026-10-23 用户：完成的未定时任务不再从日程表消失 —— 和定时任务统一，
 * 留在原处变灰。以前这里写着 `!t.done`（勾完就没了），日视图那边还有一份
 * 同样的行内过滤。排序由调用方用 `openFirst` 把已完成排到未完成后面
 * （和月视图格子同一口径）。
 *
 * 注意：待办箱不走这里 —— 它是 `!t.date && !t.done`（没日期没时间才算待办），
 * 勾完离开箱子是另一套语义，用户 2026-10-23 明确区分过。
 */
export function untimedOn(s: LocalState, isoDate: string): Task[] {
  return tasksOn(s, isoDate).filter((t) => !t.time);
}

/**
 * 「未完成在前、已完成在后」的分组（组内保持传入顺序）。
 *
 * 2026-10-23 从月视图的 cellOrder 提取 —— 月视图格子、日/周视图未定时区
 * 三处共用同一个口径；用户明确要求完成的排在未完成的后面。
 */
export function openFirst(list: Task[]): Task[] {
  const open = list.filter((t) => !t.done);
  const done = list.filter((t) => t.done);
  return [...open, ...done];
}

export function inboxTasks(s: LocalState): Task[] {
  const kw = s.ui.search || '';
  return liveTasks(s)
    .filter((t) => !t.done && !t.date && matches(t, kw))
    .sort(ordCmp(orderCmp));
}

export function todayTasks(s: LocalState): Task[] {
  const t = D.today();
  const kw = s.ui.search || '';
  return liveTasks(s)
    .filter((x) => !x.done && x.date === t && matches(x, kw))
    .sort(ordCmp(taskCmp));
}

export function todayDoneTasks(s: LocalState): Task[] {
  const t = D.today();
  const kw = s.ui.search || '';
  return liveTasks(s)
    .filter((x) => x.done && x.date === t && matches(x, kw))
    .sort(ordCmp((a, b) => (b.doneAt || 0) - (a.doneAt || 0)));
}

/** 逾期：有日期、已过期、还没完成。**唯一口径** */
export function overdueTasks(s: LocalState): Task[] {
  const t = D.today();
  const kw = s.ui.search || '';
  return liveTasks(s)
    .filter((x) => !x.done && x.date && x.date < t && matches(x, kw))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date! < b.date! ? -1 : 1;
      return ordCmp(orderCmp)(a, b);
    });
}

export function overdueCount(s: LocalState): number {
  const t = D.today();
  return liveTasks(s).filter((x) => !x.done && x.date && x.date < t).length;
}

export function doneTasks(s: LocalState): Task[] {
  const kw = s.ui.search || '';
  return liveTasks(s)
    .filter((t) => t.done && matches(t, kw))
    .sort(ordCmp((a, b) => (b.doneAt || 0) - (a.doneAt || 0)))
    .slice(0, 200);
}

/** 某一天的负载：已排分钟数 + 任务数（周/月视图的负载感知用） */
export function dayLoad(s: LocalState, isoDate: string): { mins: number; count: number } {
  let mins = 0;
  let count = 0;
  for (const x of Object.values(s.tasks)) {
    if (isGone(x) || x.done || x.date !== isoDate) continue;
    count++;
    if (x.time) mins += D.durOf(x.duration);
  }
  return { mins, count };
}

/* --------------------------------------------------------------- 排序 */

/** 未定时任务之间的比较：手动顺序 > 创建时间 */
export function orderCmp(a: Task, b: Task): number {
  const oa = a.order == null ? 1e9 : a.order;
  const ob = b.order == null ? 1e9 : b.order;
  if (oa !== ob) return oa - ob;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

/** 有时间的按时间排前面，未定时的按手动顺序；同一天未定时里已完成的排最后 */
export function taskCmp(a: Task, b: Task): number {
  const ta = D.timeToMin(a.time);
  const tb = D.timeToMin(b.time);
  if (ta !== null && tb !== null) return ta - tb;
  if (ta !== null) return -1;
  if (tb !== null) return 1;
  if (!!a.done !== !!b.done) return a.done ? 1 : -1;
  return orderCmp(a, b);
}

export function sortTasks(list: Task[]): Task[] {
  return list.slice().sort(taskCmp);
}

/**
 * 列表排序：用户手动排过（ord 有值）就听用户的，否则用页面默认顺序。
 *
 * fallback 是各页面自己的默认口径（完成时刻倒序 / 逾期天数 / 未定时间位次）。
 * 没拖过的任务 ord 为 null，所以默认行为跟以前完全一样。
 */
export function ordCmp(fallback: (a: Task, b: Task) => number) {
  return (a: Task, b: Task): number => {
    const oa = a.ord;
    const ob = b.ord;
    if (oa != null && ob != null && oa !== ob) return oa - ob;
    if (oa != null && ob == null) return -1;
    if (oa == null && ob != null) return 1;
    return fallback(a, b);
  };
}

/** 「同一天、未定时间」这一组里下一个可用的位次 */
export function nextOrder(s: LocalState, date: string | null): number {
  let mx = -1;
  for (const t of Object.values(s.tasks)) {
    if (isGone(t)) continue;
    if (t.date === date && !t.time && t.order != null && t.order > mx) mx = t.order;
  }
  return mx + 1;
}
