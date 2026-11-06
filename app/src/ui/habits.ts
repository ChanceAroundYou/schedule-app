/**
 * habits.ts —— 打卡的界面层写库入口（views 不碰 data/store）
 */
import * as store from '../data/store.ts';
import { UNGROUPED } from '../domain/model.ts';

/** 改打卡项的名字。空串由 store 那边统一拒掉，这里不重复判 */
export function renameHabit(id: string, title: string): void {
  store.patchHabit(id, { title });
}

/** 新增打卡项。`groupId` 为空串/未传 = 未分类（选择器里「未分类」就是空值） */
export function addHabit(title: string, groupId = UNGROUPED): void {
  store.addHabit(title, groupId || null);
}

export function renameHabitGroup(id: string, name: string): void {
  store.patchHabitGroup(id, { name });
}

export function createHabitGroup(name: string): void {
  store.addHabitGroup(name);
}

export function removeHabitGroup(id: string): void {
  store.deleteHabitGroup(id);
}

/** 跨组拖拽落库：换归属 + 两组重编号 */
export function moveHabit(habitId: string, toGroupId: string, refId: string | null): void {
  store.moveHabitToGroup(habitId, toGroupId, refId, 'after');
}

/**
 * 折叠 / 展开一个分组。
 *
 * 落 `ui.closedGroups`（本地偏好，不跨设备）：折叠表达的是「这一屏我想看什么」，
 * 跟窗口宽度一样属于这台设备。
 */
export function toggleGroupClosed(id: string): void {
  const s = store.get();
  const cur = s.ui.closedGroups || [];
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  store.setUi({ closedGroups: next });
}

/** 全新账号第一次进打卡页：播下默认那四个分类（只播一次，见 store 的注释） */
export function seedGroups(): void {
  store.seedDefaultGroups();
}

/**
 * 「新加的打卡项加到哪个分类」——选择器选一次就一直用它（连加几条不用重选）。
 *
 * 以前这是个非受控的原生 `<select>`，靠「DOM 值不因重渲染丢失」白拿了这个记忆；
 * 换成 Dropdown 之后值只在 React 里，得落一处。`null` = 回落到第一个非「未分类」的组。
 */
export function setAddGroup(groupId: string): void {
  store.setUi({ addGroup: groupId || null });
}
