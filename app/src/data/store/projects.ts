/**
 * projects.ts —— 项目的写入通道
 *
 * 全部走 `commit()` / `commitMany()`，权限把关、被挡提示、发件箱自动都有。
 */
import type { Project } from '../../domain/types.ts';
import { makeProject, isGone } from '../../domain/model.ts';
import { state, dataOf } from './core.ts';
import { commit, commitMany, type Change } from './commit.ts';

export function addProject(name: string, calId?: string): string {
  // 不传就落在当前集 —— 传了就用传的那个（浮层里那个集选择器，见 ProjectSheet）
  const p = makeProject(name.trim() || '未命名项目', calId || state.ui.cal || '');
  commit('project', p.id, dataOf(p));
  return p.id;
}

export function patchProject(id: string, fields: Partial<Project>): void {
  if (!state.projects[id]) return;
  // 只挑得出 Project 上的键，别把调用方多传的东西一路推到发件箱里
  const next: Record<string, unknown> = {};
  for (const k of ['name', 'note', 'status', 'next', 'progress']) {
    if (k in fields) next[k] = (fields as Record<string, unknown>)[k];
  }
  if (!Object.keys(next).length) return;
  commit('project', id, next);
}

/**
 * 删项目 = 打墓碑，**并把挂在它上面的任务的 `projectId` 一并置 null**。
 *
 * 「留着悬空引用」也能跑（`tasksOfProject` 按 id 过滤，悬空的就是查不到），
 * 但那条任务在详情里会显示一个已经不存在的项目名，用户没法把它改回来 ——
 * 这里顺手断开，比事后解释便宜。
 */
export function deleteProject(id: string): void {
  if (!state.projects[id]) return;
  const items: Change[] = [{ entity: 'project', id, fields: { deleted: true, deletedAt: Date.now() } }];
  for (const t of Object.values(state.tasks)) {
    if (t.projectId === id && !isGone(t)) items.push({ entity: 'task', id: t.id, fields: { projectId: null } });
  }
  commitMany(items);
}

export function restoreProject(id: string): void {
  if (!state.projects[id]) return;
  commit('project', id, { deleted: false, deletedAt: null, purged: false });
}

export function purgeProject(id: string): void {
  if (!state.projects[id]) return;
  commit('project', id, { purged: true });
}