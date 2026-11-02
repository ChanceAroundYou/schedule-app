/**
 * store.ts —— store 订阅 hooks
 */

import { useSyncExternalStore, useMemo } from 'react';
import * as store from '../../data/store.ts';
import type { LocalState } from '../../domain/types.ts';

export function useStoreState(): LocalState {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store.get();
}

/**
 * 只看**侧栏勾选显示的那几个集**里那一份。日程 / 已完成用它。
 *
 * 为什么在状态这一层过滤，而不是给每个查询函数加一个 calId 参数：
 * 下游十几个选择器全部只认 `s.tasks` / `s.habits`，过滤一次它们就不用动。
 * 「哪些页面跨集、哪些按集」是我们既定的一条界面约定（清单跨集，日程按集），
 * 表达成「这个页面拿到哪份 state」最直白，也不会有人忘了传参数。
 *
 * **按 `ui.cals`（勾选的集合）过滤，不是 `ui.cal`（当前集）** —— 侧栏是
 * 多选的，勾三个就该看到三个集的条目。`ui.cal` 只管新东西落哪儿。
 * 一个都没勾就是空 state（日程页没有条目），这是用户主动选的结果，不是 bug。
 *
 * ⚠️ **打卡不过滤**（2026-11-02 用户：「打卡只属于每一个用户自己」）。
 * 打卡现在落在每人的私有打卡集里（`kind='habits'`，不在 `ui.cals` 里、也不在
 * `cals` 里），照集过滤等于把打卡页清空。它本来就**全账号一套**，
 * 跟当前勾了哪几个集无关 —— 三个集勾两个、一个不勾，打卡都照旧全在。
 *
 * 今天 / 逾期 / 待办箱 / 垃圾箱**不**用这个 hook —— 它们是跨集的。
 */
export function useScopedState(): LocalState {
  const all = useStoreState();
  const version = store.getVersion();
  // join 成字符串当依赖：数组本身每次 setState 都是新引用，直接进依赖数组
  // 会让这行 memo 永远失效
  const shown = all.ui.cals.join(',');
  return useMemo(() => {
    const ids = new Set(shown ? shown.split(',') : []);
    if (!ids.size) return { ...all, tasks: {}, projects: {} };
    const tasks: LocalState['tasks'] = {};
    for (const [id, t] of Object.entries(all.tasks)) if (ids.has(t.calId)) tasks[id] = t;
    // 项目也是**按集**的（跟日程 / 已完成一样）：泳道看的是「这个集里
    // 在推进什么」，混着别人的会看不懂。跨集那四个页面（今天/逾期/待办箱/
    // 垃圾箱）照旧拿全量。
    const projects: LocalState['projects'] = {};
    for (const [id, p] of Object.entries(all.projects)) if (ids.has(p.calId)) projects[id] = p;
    // `habits` 原样带过去（见上面那段），**不要**照 tasks 那样筛
    return { ...all, tasks, projects };
    // all 是可变的同一个引用，靠 version 触发重算
  }, [all, shown, version]);
}

/** 只关心状态里的一个派生值时用它，避免每次写入都重算整棵树 */
export function useStoreSelector<T>(pick: (s: LocalState) => T): T {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return pick(store.get());
}
