/**
 * visibility.ts —— 可见性判断
 */

import type { LocalState, Task, Habit } from '../types/types.ts';

export const isGone = (e: { deleted?: boolean; purged?: boolean }): boolean =>
  e.deleted === true || e.purged === true;

/** 垃圾箱 = 墓碑但还没彻底移除 */
export const isTrashed = (e: { deleted?: boolean; purged?: boolean }): boolean =>
  e.deleted === true && e.purged !== true;

export function allTasks(s: LocalState): Task[] { return Object.values(s.tasks); }
export function allHabits(s: LocalState): Habit[] { return Object.values(s.habits); }
