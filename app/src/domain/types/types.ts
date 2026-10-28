/**
 * types.ts —— 数据模型 v4（桶文件）
 *
 * 相对 v3 的实质变化只有三处：
 *   1. 每个实体带 _ts / _dev —— 逐字段 LWW 的比较键，本地维护，不进同步
 *   2. 重复实例带 seriesId，id 由 `seriesId#发生日期` 派生，不再用随机数
 *   3. 删除是墓碑字段（deleted / purged / deletedAt），不是数组里抹掉一条
 *
 * 加上日程集之后多了一条：**每个实体带 calId**。它不是可同步的字段，而是
 * 主键的一部分 —— 一条任务属于哪个集，改归属等于换一条实体（见 store.moveToCal）。
 * 所以 calId 和 _ts / _dev 一样只存在本地、不进 op 的 fields。
 *
 * 「垃圾箱」在旧版是独立的 trash 数组，里面存的是整条任务的深拷贝快照。
 * 那样没法同步：另一端删掉任务后，快照只存在于删除方的浏览器里。v4 改成
 * 墓碑 —— 垃圾箱就是 `deleted && !purged` 的那些实体本身。清空垃圾箱 =
 * 把 purged 置真（仍走同一条 LWW 通道），不是物理删除。
 */

export type { RepeatUnit, RepeatRule } from './RepeatRule.ts';
export type { SyncMeta } from './SyncMeta.ts';
export type { Task } from './Task.ts';
export type { Habit } from './Habit.ts';
export type { ProjectStatus, Project } from './Project.ts';
export type { Role, Cal, CalColorKey, Member, Invite } from './Cal.ts';
export { canWrite, canManage, ROLE_LABEL, ROLES, ASSIGNABLE_ROLES, ROLE_HINT } from './Cal.ts';
export { CAL_COLORS, CAL_COLOR_LABEL, DEFAULT_CAL_COLOR, isCalColor } from './Cal.ts';
export type { Entity } from './Entity.ts';
export type { Op, Rejected, Change, FieldConflict, SyncResponse } from './Op.ts';
export type { ThemeMode, AccentKey, StyleKey, UiPrefs, DraftSeed } from './UiPrefs.ts';
export type { LocalState, PublicUser } from './LocalState.ts';
