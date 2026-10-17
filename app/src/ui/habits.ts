/**
 * habits.ts —— 打卡的界面层写库入口（views 不碰 data/store）
 */
import * as store from '../data/store.ts';

/** 改打卡项的名字。空串由 store 那边统一拒掉，这里不重复判 */
export function renameHabit(id: string, title: string): void {
  store.patchHabit(id, { title });
}
