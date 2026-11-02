/**
 * habits.ts —— 打卡（habits）的写入通道
 *
 * 任务与打卡是**两个独立模块**，`habit.log` 是按日期的稀疏映射。
 */
import { makeHabit, isGone } from '../../domain/model.ts';
import * as D from '../../domain/date.ts';
import { state, dataOf } from './core.ts';
import { commit, commitMany } from './commit.ts';

export function addHabit(title: string, groupId: string | null = null): string {
  /* 打卡**按人私有**（2026-11-02）：落在自己的私有打卡集里，不是"当前选中的
     日程集"。取不到（离线首启、还没同步过）才退回 ui.cal —— 服务端收到后
     还会把它改写到私有集，不会漏进共享集。 */
  const calId = state.habitsCal || state.ui.cal || '';
  /* 位次取**目标分组内**的末位，不是全表的条数 —— 分组之后是全表条数的话，
     新加的第一条会排到 100、看起来像插在最前面（跨组比较没有意义，但数值
     本身会被导出和小组件用到）。 */
  const inGroup = Object.values(state.habits).filter((x) => !isGone(x) && (x.groupId || null) === groupId);
  const order = inGroup.length ? Math.max(...inGroup.map((x) => x.order || 0)) + 10 : 0;
  const h = makeHabit(title, order, calId, undefined, groupId);
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