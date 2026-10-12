/**
 * tasks.ts —— 任务的写入通道（新建 / 勾选 / 改 / 删 / 垃圾箱）
 *
 * **全部走 `commit()` / `commitMany()`**，所以权限把关（`canWrite`）、被挡提示
 * （`deny()`）、发件箱、冲突记录自动全都有 —— 这里一个都不重复。
 */
import type { Task } from '../../domain/types.ts';
import {
  makeTask, nextOrder, trashedTasks, trashedHabits,
} from '../../domain/model.ts';
import { seriesRootOf, instanceId, repeatNext, toRepeat } from '../../domain/repeat.ts';
import * as D from '../../domain/date.ts';
import { state, dataOf } from './core.ts';
import { commit, commitMany, type Change } from './commit.ts';

export interface TaskDraft {
  title: string;
  note?: string;
  date?: string | null;
  time?: string | null;
  duration?: number;
  repeat?: unknown;
  source?: string | null;
}

export function addTask(d: TaskDraft): string {
  const date = d.date ?? null;
  const t = makeTask({
    calId: state.ui.cal || '',
    title: d.title,
    note: d.note || '',
    date,
    time: d.time ?? null,
    duration: d.duration || 60,
    repeat: toRepeat(d.repeat, date),
    seriesId: null,
    order: d.time ? null : nextOrder(state, date),
    createdAt: Date.now(),
    source: d.source ?? null,
  });
  // 非重复任务没有系列根；重复任务以自己为根（后续实例的 id 从这里派生）
  if (t.repeat.unit !== 'none') t.seriesId = t.id;

  commitMany([{ entity: 'task', id: t.id, fields: dataOf(t) }]);
  return t.id;
}

/**
 * 勾选 / 取消勾选。
 *
 * 勾上一条**重复**任务时会顺手派生下一个实例。这一步是本次重构的核心：
 * 新旧实现都是「完成即派生」，区别在实例 id 的来源。旧版 `randomUUID()`
 * 让两台设备各自离线勾选时派生出两个不同的实例，同步后任务翻倍；
 * 现在 id 是 `${seriesId}#${发生日}`，两边算出来一模一样，自然合并成一条。
 */
export function toggleTask(id: string): void {
  const t = state.tasks[id];
  if (!t || t.deleted) return;

  const done = !t.done;
  const now = Date.now();
  commit('task', id, { done, doneAt: done ? now : null });
  if (!done) return;

  const root = seriesRootOf(t);
  if (!root) return;

  const nextDate = repeatNext(t, t.date || D.today());
  if (!nextDate) return;

  const nextId = instanceId(root, nextDate);
  const existing = state.tasks[nextId];
  if (existing) {
    // 另一台设备已经建过这一次的实例了 —— 派生 id 相同，本来就是同一条。
    // **不重写字段**：本机这份标题/时间可能已经过期，重写会用旧值盖掉对方的编辑。
    // 只在它被误删的情况下救回来。
    if (existing.deleted === true) {
      commit('task', nextId, { deleted: false, deletedAt: null, purged: false });
    }
    return;
  }

  commit('task', nextId, {
    title: t.title, note: t.note,
    date: nextDate, time: t.time, duration: t.duration,
    done: false, doneAt: null,
    repeat: t.repeat, repeatSeq: (t.repeatSeq || 0) + 1,
    seriesId: root, order: null, ord: null,
    createdAt: now, source: t.source ?? null,
  });
}

export function patchTask(id: string, fields: Partial<Task>): void {
  const cur = state.tasks[id];
  if (!cur) return;
  // 改日期时把未定时的位次重算一下，否则会带着旧日期的 order 落到新日期上
  const next: Record<string, unknown> = { ...fields };
  if ('date' in fields && !cur.time && !('order' in fields)) {
    next.order = nextOrder(state, (fields.date ?? null) as string | null);
  }
  commit('task', id, next);
}

export function deleteTask(id: string, from = '任务列表'): void {
  if (!state.tasks[id]) return;
  commit('task', id, { deleted: true, deletedAt: Date.now(), trashFrom: from });
}

export function restoreTask(id: string): void {
  if (!state.tasks[id]) return;
  commit('task', id, { deleted: false, deletedAt: null, purged: false });
}

export function purgeTask(id: string): void {
  if (!state.tasks[id]) return;
  commit('task', id, { purged: true });
}

/**
 * 「不保留」= 留下墓碑（走同步通道，别的设备才知道要删）。
 * 「清空」= 打 purged，服务器快照就不再带它了。两者都是字段写入，没有物理删除。
 */
export function emptyTrash(): void {
  const items: Change[] = [];
  for (const t of trashedTasks(state)) items.push({ entity: 'task', id: t.id, fields: { purged: true } });
  for (const h of trashedHabits(state)) items.push({ entity: 'habit', id: h.id, fields: { purged: true } });
  commitMany(items);
}

/** 把任务挂到项目上（`null` = 摘下来）。归属**只在详情里改**，拖拽不改它 */
export function setTaskProject(taskId: string, projectId: string | null): void {
  if (!state.tasks[taskId]) return;
  commit('task', taskId, { projectId: projectId || null });
}

/**
 * 泳道列之间的移动。`done` 那一列走 `toggleTask`（**不是**直接写 done 字段）——
 * 重复任务要靠它推进系列，绕过它会让「每週一次」这类任务勾完就不见了。
 */
export function setTaskDoing(taskId: string, doing: boolean): void {
  const t = state.tasks[taskId];
  if (!t) return;
  if (t.done) {
    // 从「已完成」列拖出来：先取消完成，再按目标列决定 doing。
    // toggleTask 自己会 commit，这里的 doing 跟随其后 —— 两条 op、两个字段，
    // 顺序无所谓（LWW 是逐字段的，它们不冲突）。
    toggleTask(taskId);
    if (doing) commit('task', taskId, { doing: true });
    return;
  }
  commit('task', taskId, { doing });
}