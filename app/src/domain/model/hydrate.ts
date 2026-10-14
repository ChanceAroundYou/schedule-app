/**
 * hydrate.ts —— 实体补全
 */

import type { Task, Habit, Project } from '../types/types.ts';
import { toRepeat } from '../repeat.ts';

/**
 * hydrate 能接受的形状：id 与同步元数据齐了，业务字段可以缺。
 *
 * `calId` 在这里是可选的（SyncMeta 里是必填）—— 迁移进来的旧数据和
 * 还没归位的远端变更都还没有归属，hydrate 补成空串，由 store 落位。
 */
export type MetaLike = {
  id: string;
  calId?: string;
  _ts: Record<string, number>;
  _dev: Record<string, string>;
};

/**
 * 补全一条实体缺的数据字段。
 *
 * 为什么必须有：同步过来的是**逐字段增量**，一次可能只带 `{title}`。
 * 而所有查询函数都假设实体是完整的（`t.repeat.unit`、`t.title.toLowerCase()`），
 * 半个实体进来就是一个 TypeError。凡是「外部数据进入 state」的口子
 * —— 合并远端变更、应用快照、读 v3 旧数据 —— 都要过这一道。
 *
 * 只补**缺失**的字段，不覆盖已有值，也不碰 _ts / _dev。
 */
export function hydrateTask<T extends Partial<Task> & MetaLike>(e: T): T & Task {
  const t = e as T & Task;
  if (t.calId === undefined) t.calId = '';
  if (t.title === undefined) t.title = '未命名任务';
  if (t.note === undefined) t.note = '';
  if (t.date === undefined) t.date = null;
  if (t.time === undefined) t.time = null;
  if (t.reminder === undefined) t.reminder = null;
  if (t.duration === undefined) t.duration = null;
  if (t.done === undefined) t.done = false;
  if (t.doneAt === undefined) t.doneAt = null;
  if (t.repeatSeq === undefined) t.repeatSeq = 0;
  if (t.seriesId === undefined) t.seriesId = null;
  // skipped / repeatUntil 是 2026-10-14 新加的删除语义字段，老数据没有 → 补默认值
  if (t.skipped === undefined) t.skipped = false;
  if (t.repeatUntil === undefined) t.repeatUntil = null;
  if (t.order === undefined) t.order = null;
  if (t.ord === undefined) t.ord = null;
  if (t.createdAt === undefined) t.createdAt = 0;
  if (t.source === undefined) t.source = null;
  // repeat 可能是半个对象（远端只改了 unit），统一过一遍 toRepeat 补齐
  t.repeat = toRepeat(t.repeat, t.date ?? null);
  return t;
}

export function hydrateHabit<T extends Partial<Habit> & MetaLike>(e: T): T & Habit {
  const h = e as T & Habit;
  if (h.calId === undefined) h.calId = '';
  if (h.title === undefined) h.title = '未命名习惯';
  if (h.order === undefined) h.order = 0;
  if (!h.log || typeof h.log !== 'object') h.log = {};
  if (h.createdAt === undefined) h.createdAt = 0;
  return h;
}

export function hydrateProject<T extends Partial<Project> & MetaLike>(e: T): T & Project {
  const p = e as T & Project;
  if (p.calId === undefined) p.calId = '';
  if (p.name === undefined) p.name = '未命名项目';
  if (p.note === undefined) p.note = '';
  if (p.next === undefined) p.next = '';
  if (p.progress === undefined) p.progress = null;
  if (p.createdAt === undefined) p.createdAt = 0;
  if (!STATUS_ALL.includes(p.status)) p.status = 'active';
  // 进度写成 0–100 之外的数就钳回去 —— 界面上那是个 0..100 的输入框，
  // 但盘上那份可能是手改的
  if (p.progress !== null) {
    const n = Number(p.progress);
    p.progress = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  }
  return p;
}

const STATUS_ALL: readonly Project['status'][] = ['active', 'waiting', 'paused', 'done'];
