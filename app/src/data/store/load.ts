/**
 * load.ts —— 批量装载（迁移 / 导入备份）
 */
import type { Habit, Project, Task } from '../../domain/types.ts';
import { state, dataOf } from './core.ts';
import { commitMany, type Change } from './commit.ts';

/**
 * 迁移 / 导入进来的历史数据就地装载，同时把每条都排进 outbox 推给服务器。
 *
 * 旧数据没有集的归属（`calId` 是空串），统一落到当前选中的集 —— 首次注册时
 * 那就是刚建出来的「我的日程」。已经带归属的（导入一份别人给的备份）原样保留，
 * 但那个集我得有写权限，否则 commitMany 会把它们整批挡下。
 */
export function loadMigrated(tasks: Task[], habits: Habit[], projects: Project[] = []): number {
  const target = state.ui.cal || '';
  const items: Change[] = [];
  for (const p of projects) {
    const calId = p.calId || target;
    if (!calId) continue;
    p.calId = calId;
    state.projects[p.id] = p;
    items.push({ entity: 'project', id: p.id, calId, fields: dataOf(p) });
  }
  for (const t of tasks) {
    const calId = t.calId || target;
    if (!calId) continue;
    t.calId = calId;
    state.tasks[t.id] = t;
    items.push({ entity: 'task', id: t.id, calId, fields: dataOf(t) });
  }
  for (const h of habits) {
    const calId = h.calId || target;
    if (!calId) continue;
    h.calId = calId;
    state.habits[h.id] = h;
    items.push({ entity: 'habit', id: h.id, calId, fields: dataOf(h) });
  }
  commitMany(items);
  return items.length;
}