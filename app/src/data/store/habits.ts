/**
 * habits.ts —— 打卡（habits）的写入通道
 *
 * 任务与打卡是**两个独立模块**，`habit.log` 是按日期的稀疏映射。
 */
import { makeHabit, liveHabits } from '../../domain/model.ts';
import * as D from '../../domain/date.ts';
import { state, dataOf } from './core.ts';
import { commit, commitMany } from './commit.ts';

export function addHabit(title: string): string {
  const calId = state.ui.cal || '';
  const h = makeHabit(title, liveHabits(state).filter((x) => x.calId === calId).length, calId);
  commitMany([{ entity: 'habit', id: h.id, calId, fields: dataOf(h) }]);
  return h.id;
}

export function toggleHabit(id: string, date = D.today()): void {
  const h = state.habits[id];
  if (!h || h.deleted) return;
  const log = { ...(h.log || {}) };
  if (log[date]) delete log[date];
  else log[date] = true;
  // log 是稀疏映射，整字段覆盖是最省事的写法；同一天在两端各勾一次会收敛到
  // 最后那次的状态，不会出现「两次都生效」这种半吊子结果。
  commit('habit', id, { log });
}

export function deleteHabit(id: string): void {
  if (!state.habits[id]) return;
  commit('habit', id, { deleted: true, deletedAt: Date.now() });
}

export function restoreHabit(id: string): void {
  if (!state.habits[id]) return;
  commit('habit', id, { deleted: false, deletedAt: null, purged: false });
}