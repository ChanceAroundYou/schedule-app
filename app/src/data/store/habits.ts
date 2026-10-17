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

/**
 * 改打卡项的名字（2026-10-17 用户：「已经加入的打卡项没有办法编辑和修改」）。
 *
 * 打卡项**只有名字这一个可编辑的信息** —— 其余是 `order`（拖拽排序）和
 * `log`（按日期的打卡记录），都不是「编辑」的对象。所以这里只接 title。
 * 空串 / 只改空格的不收：界面那边也会先 trim 再判空，两边同一口径。
 */
export function patchHabit(id: string, fields: { title?: string }): void {
  const h = state.habits[id];
  if (!h || h.deleted) return;
  if (fields.title === undefined) return;
  const title = fields.title.trim();
  if (!title || title === h.title) return;
  commit('habit', id, { title });
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