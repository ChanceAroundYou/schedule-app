/**
 * counts.ts —— 查询口径
 *
 * 查询口径必须**唯一**，旧版就吃过这个亏：`counts().today` 和 `overdueCount()`
 * 各写各的，同一个任务在两个徽标里各数了一次。这里全部收口到本文件。
 */

import type { LocalState } from '../types/types.ts';
import * as D from '../date.ts';
import { liveTasks } from './tasks.ts';
import { habitsTodayRemaining } from './habits.ts';
import { allTasks, allHabits, isTrashed } from './visibility.ts';

export function counts(s: LocalState): {
  inbox: number; today: number; overdue: number; trash: number; habits: number;
} {
  const t = D.today();
  const live = liveTasks(s);
  return {
    inbox: live.filter((x) => !x.done && !x.date).length,
    today: live.filter((x) => !x.done && x.date === t).length,
    overdue: live.filter((x) => !x.done && x.date && x.date < t).length,
    trash: allTasks(s).filter(isTrashed).length + allHabits(s).filter(isTrashed).length,
    habits: habitsTodayRemaining(s),
  };
}
