/**
 * habits.ts —— 打卡查询
 */

import type { LocalState, Habit } from '../types/types.ts';
import * as D from '../date.ts';
import { isGone, isTrashed } from './visibility.ts';

export function liveHabits(s: LocalState): Habit[] { return Object.values(s.habits).filter((h) => !isGone(h)); }

export function trashedHabits(s: LocalState): Habit[] {
  return Object.values(s.habits).filter(isTrashed).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

export function habitById(s: LocalState, id: string): Habit | null {
  const h = s.habits[id];
  return h && !isGone(h) ? h : null;
}

export function habitsTodayRemaining(s: LocalState): number {
  const t = D.today();
  return liveHabits(s).filter((h) => !h.log || !h.log[t]).length;
}

/**
 * 连续打卡天数：今天已打则从今天起算，否则从昨天起算。
 *
 * `todayIso` 可以传 —— 给小组件快照用（它要跟快照的日期范围用同一个
 * 「今天」，否则测试里固定日期就对不上）。
 */
export function habitStreak(h: Habit, todayIso: string = D.today()): number {
  if (!h || !h.log) return 0;
  let n = 0;
  let d = todayIso;
  if (!h.log[d]) {
    d = D.addDays(d, -1);
    if (!h.log[d]) return 0;
  }
  while (h.log[d]) { n++; d = D.addDays(d, -1); }
  return n;
}
