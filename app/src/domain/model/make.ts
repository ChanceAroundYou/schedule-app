/**
 * make.ts —— 实体构造
 */

import type { Task, Habit, Project } from '../types/types.ts';
import { toRepeat } from '../repeat.ts';
import { newId } from './id.ts';

export function makeTask(partial: Partial<Task> & { title: string }): Task {
  const date = partial.date ?? null;
  const t: Task = {
    id: partial.id || newId(),
    calId: partial.calId || '',
    title: partial.title || '未命名任务',
    note: partial.note || '',
    date,
    time: partial.time ?? null,
    duration: partial.duration ?? null,
    done: partial.done ?? false,
    doneAt: partial.doneAt ?? null,
    repeat: partial.repeat || toRepeat(null, date),
    repeatSeq: partial.repeatSeq || 0,
    seriesId: partial.seriesId ?? null,
    order: partial.order ?? null,
    ord: partial.ord ?? null,
    createdAt: partial.createdAt || Date.now(),
    source: partial.source ?? null,
    _ts: partial._ts || {},
    _dev: partial._dev || {},
  };

  // 墓碑字段是可选的，**只在传了的时候才写上** —— 无条件写会让每条正常任务
  // 都带上 deleted: undefined，序列化进 localStorage 后到处都是空洞。
  if (partial.deleted) t.deleted = true;
  if (partial.purged) t.purged = true;
  if (partial.deletedAt != null) t.deletedAt = partial.deletedAt;
  if (partial.trashFrom != null) t.trashFrom = partial.trashFrom;

  return t;
}

export function makeHabit(title: string, order: number, calId: string, id?: string): Habit {
  return {
    id: id || newId(),
    calId,
    title,
    order,
    log: {},
    createdAt: Date.now(),
    _ts: {},
    _dev: {},
  };
}

export function makeProject(name: string, calId: string, id?: string): Project {
  const p: Project = {
    id: id || newId(),
    calId,
    name: name || '未命名项目',
    note: '',
    status: 'active',
    next: '',
    progress: null,
    createdAt: Date.now(),
    _ts: {},
    _dev: {},
  };
  return p;
}
