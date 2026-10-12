/**
 * Task —— 任务实体
 */

import type { SyncMeta } from './SyncMeta.ts';
import type { RepeatRule } from './RepeatRule.ts';

export interface Task extends SyncMeta {
  title: string;
  note: string;
  /** null = 待办箱（未定日期） */
  date: string | null;
  /** null = 未定时，落在时间轴上方的全天区 */
  time: string | null;
  duration: number;
  done: boolean;
  doneAt: number | null;
  repeat: RepeatRule;
  /** 已推进次数，用于 repeat.end.type === 'count' */
  repeatSeq: number;
  /** 重复系列根 id。非重复任务是 null */
  seriesId: string | null;
  /** 「同一天、未定时间」这一组的位次 */
  order: number | null;
  /** 用户在任意列表里手动拖出来的顺序，独立于 order */
  ord?: number | null;
  createdAt: number;
  source: string | null;

  deleted?: boolean;
  /** 已从垃圾箱彻底移除，不再显示 */
  purged?: boolean;
  deletedAt?: number;
  /** 从哪个页面删的，只在垃圾箱里显示 */
  trashFrom?: string;

  /**
   * 属于哪个项目。`null` / 缺失 = 不属于任何项目。
   *
   * **可选字段，不是必填** —— 这就是它零迁移的原因：旧任务、旧 op、旧快照
   * 缺了它一律按「没归属」处理，跟加这个字段之前的行为逐像素相同。
   */
  projectId?: string | null;
  /**
   * 泳道中间那一列。`true` = 进行中；缺失 = 待办。
   *
   * **与 `done` 是两个独立字段，不合并。** `done` 被 `counts()` / 今天页 /
   * 逾期页 / 重复推进共用，动它会牵动一大片。列判定是
   * `done → 已完成 / !done && doing → 进行中 / 否则 待办`（`projectColumn`）。
   */
  doing?: boolean;
}
