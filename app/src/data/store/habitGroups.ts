/**
 * habitGroups.ts —— 打卡分类的写入通道
 *
 * 与 habits.ts 同一层、同一套提交语义（commit → 本地先写 → 压 outbox）。
 * 归属永远是**私有打卡集**（`state.habitsCal`），跟打卡一致 —— 分类名和
 * 打卡记录一样，只属于这个人。
 */
import {
  makeHabitGroup, liveGroups, habitsOfGroup, groupOfHabit,
  DEFAULT_GROUPS, UNGROUPED,
} from '../../domain/model.ts';
import { state, dataOf } from './core.ts';
import { commit, commitMany, type Change } from './commit.ts';
import { reorder } from './sort.ts';

/** 分类和打卡同一个归属：私有打卡集。取不到时退回当前集（服务端还会改写） */
function ownerCal(): string {
  return state.habitsCal || state.ui.cal || '';
}

export function addHabitGroup(name: string): string | null {
  const n = name.trim();
  if (!n) return null;
  const groups = liveGroups(state);
  // 重名没有意义（用户分不清哪个是哪个），直接拒掉，界面上也不会有第二条路
  if (groups.some((g) => g.name === n)) return null;
  const calId = ownerCal();
  const order = groups.length ? (groups[groups.length - 1].order || 0) + 10 : 0;
  const g = makeHabitGroup(n, order, calId);
  commitMany([{ entity: 'habitGroup', id: g.id, calId, fields: dataOf(g) }]);
  return g.id;
}

export function patchHabitGroup(id: string, fields: { name?: string }): void {
  const g = state.habitGroups[id];
  if (!g || g.deleted) return;
  if (fields.name === undefined) return;
  const name = fields.name.trim();
  if (!name || name === g.name) return;
  commit('habitGroup', id, { name });
}

/**
 * 删掉一个分类。**组里的打卡项不删** —— 它们落回「未分类」。
 *
 * 必须显式把 groupId 改成 null：留着一个指向已删分类的 id，那些打卡项会
 * 既不在任何分组里、也不算未分类（查询会把它们算成未分类，但数据里是个悬空
 * 引用，将来按 groupId 做任何统计都会出错）。
 */
export function deleteHabitGroup(id: string): void {
  const g = state.habitGroups[id];
  if (!g || g.deleted) return;
  const items: Change[] = [];
  for (const h of Object.values(state.habits)) {
    if (!h.deleted && h.groupId === id) items.push({ entity: 'habit', id: h.id, fields: { groupId: null } });
  }
  if (items.length) commitMany(items);
  commit('habitGroup', id, { deleted: true, deletedAt: Date.now() });
}

/**
 * 把一条打卡项挪到另一个分类（跨组拖拽的落库那一步）。
 *
 * `refId` 是落点上那一项，`pos` 决定前/后；`null` = 落到该组末尾。
 * 两组都要重编号：只改被拖那条的 order 会在源组留下空洞、在目标组撞号。
 */
export function moveHabitToGroup(
  habitId: string, toGroupId: string, refId: string | null = null, pos: 'before' | 'after' = 'after',
): void {
  const h = state.habits[habitId];
  if (!h || h.deleted) return;
  const target = toGroupId || UNGROUPED;
  const from = groupOfHabit(state, h);
  if (h.groupId !== (target === UNGROUPED ? null : target)) {
    commit('habit', habitId, { groupId: target === UNGROUPED ? null : target });
  } else if (refId === habitId || (!refId && from === target)) {
    // 原地不动（拖回自己身上 / 拖到本组末尾且本来就在末尾）：不用写库
    return;
  }

  // 目标组的新顺序（此刻 state 已含刚才那次 groupId 改动）
  const ids = habitsOfGroup(state, target).filter((x) => x.id !== habitId).map((x) => x.id);
  let idx = ids.length;
  if (refId) {
    const at = ids.indexOf(refId);
    if (at >= 0) idx = pos === 'before' ? at : at + 1;
  }
  ids.splice(idx, 0, habitId);
  reorder('habit', ids);

  // 源组跟着重编号，免得拖走的那条留下一个 20 的空洞（排序本身不受影响，
  // 但「order 值」会被小组件和导出用，留空洞属于无谓的脏数据）
  if (from !== target && from !== UNGROUPED) {
    const rest = habitsOfGroup(state, from).map((x) => x.id);
    if (rest.length) reorder('habit', rest);
  }
}

/**
 * 全新账号第一次进打卡页时播下那四个默认分类。
 *
 * 只播一次：条件是「一条分类都没有」。删除留下墓碑，所以用户删光之后
 * 不会自己长回来；换台设备登录时服务端已经有分类，也不会重复播。
 * 没有私有打卡集（还没同步过）时不播 —— 那时候写进去的 calId 是猜的。
 */
export function seedDefaultGroups(): void {
  if (!state.habitsCal) return;
  if (Object.keys(state.habitGroups).length) return;
  const calId = ownerCal();
  const ts = Date.now();
  const items: Change[] = DEFAULT_GROUPS.map((name, i) => {
    const g = makeHabitGroup(name, i * 10, calId);
    g.createdAt = ts;
    return { entity: 'habitGroup' as const, id: g.id, calId, fields: dataOf(g) };
  });
  commitMany(items);
}

/** 打卡页「新建分类」用：当前有没有一条活的分类 */
export function hasGroups(): boolean {
  return liveGroups(state).length > 0;
}

/** 给界面读的一条打卡项的当前分类（悬空 id 会被算成未分类） */
export function groupIdOf(habitId: string): string {
  const h = state.habits[habitId];
  return h ? groupOfHabit(state, h) : UNGROUPED;
}
