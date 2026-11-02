/**
 * habitGroups.ts —— 打卡分类的查询口径（纯函数）
 */

import type { LocalState, Habit, HabitGroup } from '../types/types.ts';
import { isGone } from './visibility.ts';

/**
 * 「未分类」那一组的 id。
 *
 * 用空串而不是造一个假实体：它不该出现在同步里（否则每台设备各造一个，
 * 就成了两个同名的分类），也不在 `habitGroups` 里占位。界面上它永远排在
 * 最后，且**只有真的存在未分类的打卡项时才显示**（见 bucketsOf）。
 */
export const UNGROUPED = '';

/**
 * 全新账号第一次进打卡页时播种的分类（用户 2026-11-02 给的四个）。
 *
 * **只播一次**：播完就是普通分类，用户改名、删掉、加新的都不会被改回去。
 * 触发条件是 `seedDefaultGroups()` 里的「一条分类都没有」，所以删光了
 * 也不会自己长回来（删除会留墓碑，仍然算「有」）。
 */
export const DEFAULT_GROUPS: readonly string[] = ['工作学习', '打卡', '小动物们', '运动'];

/** 位次比较：order 升序，同值用 id 兜底（跨机器结果一致，与其余列表同一口径） */
function byOrder<T extends { id: string; order?: number }>(a: T, b: T): number {
  return (a.order || 0) - (b.order || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function liveGroups(s: LocalState): HabitGroup[] {
  return Object.values(s.habitGroups || {}).filter((g) => !isGone(g)).sort(byOrder);
}

export function groupById(s: LocalState, id: string): HabitGroup | null {
  if (!id) return null;
  const g = (s.habitGroups || {})[id];
  return g && !isGone(g) ? g : null;
}

/** 某个分类下的打卡项（按 order）。`UNGROUPED` 返回没有分类归属的那些 */
export function habitsOfGroup(s: LocalState, id: string): Habit[] {
  const all = Object.values(s.habits).filter((h) => !isGone(h));
  return all
    .filter((h) => groupOfHabit(s, h) === id)
    .sort(byOrder);
}

/**
 * 一条打卡项**实际**落在哪个分类 —— 不是直接读 `h.groupId`。
 *
 * 指向一个已被删除 / 不存在的分类时算未分类：这样「对方把分类删了、
 * 我这边还没同步到那批打卡项的 groupId 改写」的中间态不会让这些项
 * 从界面上消失（它们会出现在未分类里，用户看得见、也还能勾）。
 */
export function groupOfHabit(s: LocalState, h: Habit): string {
  const gid = h.groupId || '';
  return gid && groupById(s, gid) ? gid : UNGROUPED;
}

export interface HabitBucket {
  /** 分类 id；`UNGROUPED` 表示未分类 */
  id: string;
  /** 分类本身；未分类那一组是 null */
  group: HabitGroup | null;
  habits: Habit[];
}

/**
 * 打卡页要渲染的分组。
 *
 * 规则的取舍：
 *   · **空分类要保留**（用户刚建完还没往里放东西，它不能凭空空掉）；
 *   · **未分类组只在真有东西时出现**（否则每个用户底下都挂着一个空标题）。
 */
export function bucketsOf(s: LocalState): HabitBucket[] {
  const out: HabitBucket[] = liveGroups(s).map((g) => ({ id: g.id, group: g, habits: habitsOfGroup(s, g.id) }));
  const rest = habitsOfGroup(s, UNGROUPED);
  if (rest.length) out.push({ id: UNGROUPED, group: null, habits: rest });
  return out;
}

/** 今天打了几项 / 共几项（组头那个 x/y） */
export function groupTodayCount(habits: Habit[], today: string): { done: number; total: number } {
  let done = 0;
  for (const h of habits) if (h.log && h.log[today]) done++;
  return { done, total: habits.length };
}
