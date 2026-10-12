/**
 * Project —— 项目实体
 */

import type { SyncMeta } from './SyncMeta.ts';

/**
 * 项目自己的状态，写在泳道头上。
 *
 * **与「关联任务做完没有」是两回事**：任务全做完了项目也可以还是 `active`
 * （下一个阶段还没开始）。所以它是**手填**的，不由任务推导。
 */
export type ProjectStatus = 'active' | 'waiting' | 'paused' | 'done';

/**
 * 长周期项目。
 *
 * 这是 PARA 里 **Area**（持续关注、无结束点）的形态，**不是**有起止日的
 * Project —— 所以它**没有开始日 / 截止日**，也因此排除了甘特图：
 * 甘特图强制每根横条有起止日，会逼用户给每个项目编一个假日期。
 * 面板围绕「多久没动 + 下一步是什么」组织，见 `projectTouchedAt`。
 */
export interface Project extends SyncMeta {
  name: string;
  note: string;
  status: ProjectStatus;
  /** 下一步：一行字，空串 = 还没写 */
  next: string;
  /** 手填进度覆盖（0–100）；null = 按关联任务自动算 */
  progress: number | null;
  createdAt: number;

  deleted?: boolean;
  purged?: boolean;
  deletedAt?: number;
}
