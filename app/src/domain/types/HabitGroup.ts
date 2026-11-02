/**
 * HabitGroup —— 打卡分类
 *
 * 为什么是**独立实体**而不是打卡项上的一个字符串（2026-11-02 定案）：
 *   ① 改一次分类名要批量改几十条记录，还会在另一端产生几十条 LWW 竞争；
 *   ② 「还没有任何打卡项的空分类」根本存不住 —— 新建了「小动物们」还没往里
 *      放东西，它凭空消失；
 *   ③ 顺序没地方放。分组要按用户想要的先后排，那是分类自己的属性。
 *
 * 它跟打卡一样落在**私有打卡集**里（见 LocalState.habitsCal），所以既不进
 * 日程集列表，也不会共享给别人。
 */
import type { SyncMeta } from './SyncMeta.ts';

export interface HabitGroup extends SyncMeta {
  name: string;
  /** 位次（10 递增，与 habit / task 同一套） */
  order: number;
  createdAt: number;

  deleted?: boolean;
  purged?: boolean;
  deletedAt?: number;
}
