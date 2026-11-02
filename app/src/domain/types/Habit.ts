/**
 * Habit —— 打卡实体
 */

import type { SyncMeta } from './SyncMeta.ts';

export interface Habit extends SyncMeta {
  title: string;
  order: number;
  /**
   * 属于哪个打卡分类（`HabitGroup.id`）。`null` = 未分类。
   *
   * 分类被删掉时**不在打卡项上留死的 id**：`deleteHabitGroup` 会把组内
   * 所有打卡项改成 `null`，它们就落到「未分类」里 —— 否则那些项会指向
   * 一个已经不存在的分类，界面上哪儿都不显示（等于被删了）。
   */
  groupId: string | null;
  /** 按日期的稀疏映射：只有打过卡的日期才有键 */
  log: Record<string, true>;
  createdAt: number;

  deleted?: boolean;
  purged?: boolean;
  deletedAt?: number;
}
