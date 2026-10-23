/**
 * model.ts —— 实体构造、查询口径、v3 → v4 迁移（桶文件）
 *
 * 查询口径必须**唯一**，旧版就吃过这个亏：`counts().today` 和 `overdueCount()`
 * 各写各的，同一个任务在两个徽标里各数了一次。这里全部收口到本文件。
 *
 * 全部是纯函数：state 传进来，结果传出去，不碰 localStorage、不碰网络。
 */

export { newId, newOpId } from './id.ts';
export type { MetaLike } from './hydrate.ts';
export { isGone, isTrashed, allTasks, allHabits } from './visibility.ts';
export { roleOf, hasCals, inCal } from './permission.ts';
export {
  liveTasks, trashedTasks, taskById, tasksOn, untimedOn, openFirst,
  inboxTasks, todayTasks, todayDoneTasks, overdueTasks, overdueCount,
  doneTasks, dayLoad, orderCmp, taskCmp, sortTasks, ordCmp, nextOrder,
} from './tasks.ts';
export {
  liveHabits, trashedHabits, habitById, habitsTodayRemaining, habitStreak,
} from './habits.ts';
export { counts } from './counts.ts';
export { makeTask, makeHabit, makeProject } from './make.ts';
export { hydrateTask, hydrateHabit, hydrateProject } from './hydrate.ts';
export { CUSTOMIZABLE, TAB_MAX, orderTabs, defaultUi, setDefaultCal, normalizeUi, quickDefaults } from './ui.ts';
export type { QuickDefaults } from './ui.ts';
export { resolveDefaultCal } from './cal.ts';
export { STALE_DAYS, STATUS_LABEL, allProjects, liveProjects, projectById, tasksOfProject, projectColumn, projectProgress, projectTouchedAt, projectStaleDays, sortProjects } from './project.ts';
export { migrateV3, fillTs, dataFields } from './migration.ts';
export type { MigrationResult } from './migration.ts';
