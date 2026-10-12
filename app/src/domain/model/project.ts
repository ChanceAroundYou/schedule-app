/**
 * project.ts —— 项目相关
 */

import type { LocalState, Project, Task, ProjectStatus } from '../types/types.ts';
import { isGone } from './visibility.ts';
import { liveTasks } from './tasks.ts';

/** 超过这么多天没动就在项目页里标 ⚠。**只在项目页标，不主动弹**（用户裁决） */
export const STALE_DAYS = 30;

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: '推进中', waiting: '等外部', paused: '搁置', done: '收尾',
};


export function allProjects(s: LocalState): Project[] { return Object.values(s.projects); }

export function liveProjects(s: LocalState): Project[] {
  return allProjects(s).filter((p) => !isGone(p));
}

export function projectById(s: LocalState, id: string | null | undefined): Project | null {
  if (!id) return null;
  const p = s.projects[id];
  return p && !isGone(p) ? p : null;
}

/** 挂在某个项目上的任务（含已完成的 —— 算进度要用）。墓碑不算 */
export function tasksOfProject(s: LocalState, id: string): Task[] {
  return liveTasks(s).filter((t) => t.projectId === id);
}

/**
 * 泳道里那一列。三态：`done` 被 `done` 决定，`doing` 只管「没做完但在做」。
 *
 * 用 `!!t.doing` 而不是 `t.doing === true`：远端来的可能是 0/1，
 * hydrateTask 不碰这个字段（它可选），别在这里被真值判断坑到。
 */
export function projectColumn(t: Task): 'todo' | 'doing' | 'done' {
  if (t.done) return 'done';
  return t.doing ? 'doing' : 'todo';
}

/**
 * 0–100。**手填值优先**，否则 = 关联任务里已完成的比例。
 *
 * 没有关联任务时返回 0 而不是 100 —— 「一个任务都没有」不等于「做完了」，
 * 那是「还没拆解」。泳道头会把这种情况写成 0/0 让用户看出来。
 */
export function projectProgress(s: LocalState, id: string): number {
  const p = projectById(s, id);
  if (p && p.progress !== null) return p.progress;
  const list = tasksOfProject(s, id);
  if (!list.length) return 0;
  return Math.round((list.filter((t) => t.done).length / list.length) * 100);
}

/**
 * 最后活动时刻 = 项目自身各字段的 `_ts` ∪ 关联任务的 `_ts` / `doneAt` / `createdAt`
 * 取最大。
 *
 * **只用会同步的数据。** `_ts` / `_dev` 虽然只存在本地，但 `applyRemote` 会把
 * 远端来的 `ts` 写进 `_ts`，所以它是**收敛的**、跨设备一致。
 * **不要另加一个 `touchedAt` 字段** —— 那需要「读一次就写一次」，
 * 会把只读浏览变成写入，白白产生 op，而且每台设备的「上次看」互相覆盖。
 */
export function projectTouchedAt(s: LocalState, id: string): number {
  const p = projectById(s, id);
  if (!p) return 0;
  let max = 0;
  const seen = (o: Record<string, number> | undefined) => {
    for (const v of Object.values(o || {})) if (v > max) max = v;
  };
  seen(p._ts);
  if (p.createdAt > max) max = p.createdAt;
  for (const t of tasksOfProject(s, id)) {
    seen(t._ts);
    if (t.createdAt > max) max = t.createdAt;
    if (t.doneAt && t.doneAt > max) max = t.doneAt;
  }
  return max;
}

/** 多少天没动了。算不出（没有任何时间戳）时给 0，别报一个吓人的巨大数 */
export function projectStaleDays(s: LocalState, id: string, now = Date.now()): number {
  const at = projectTouchedAt(s, id);
  if (!at) return 0;
  return Math.max(0, Math.floor((now - at) / 86400000));
}

/** 最久没动的排前面 —— 面板就是用来把「快被忘掉的那个」顶到眼前的 */
export function sortProjects(s: LocalState, list: Project[]): Project[] {
  return list.slice().sort((a, b) => {
    const d = projectTouchedAt(s, a.id) - projectTouchedAt(s, b.id);
    if (d) return d;
    return a.name.localeCompare(b.name);   // 都是 0（新建还没来得及动）时给个稳定序
  });
}
