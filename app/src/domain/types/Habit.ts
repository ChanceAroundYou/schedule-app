/**
 * Habit —— 打卡实体
 */

import type { SyncMeta } from './SyncMeta.ts';

export interface Habit extends SyncMeta {
  title: string;
  order: number;
  /** 按日期的稀疏映射：只有打过卡的日期才有键 */
  log: Record<string, true>;
  createdAt: number;

  deleted?: boolean;
  purged?: boolean;
  deletedAt?: number;
}
