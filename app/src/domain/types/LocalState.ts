/**
 * LocalState —— 本地状态
 */

import type { Task } from './Task.ts';
import type { Habit } from './Habit.ts';
import type { Project } from './Project.ts';
import type { Cal, Invite } from './Cal.ts';
import type { Op, FieldConflict } from './Op.ts';
import type { UiPrefs } from './UiPrefs.ts';

export interface LocalState {
  tasks: Record<string, Task>;
  habits: Record<string, Habit>;
  projects: Record<string, Project>;
  /** 我加入的日程集。服务器每次同步都会刷新 */
  cals: Cal[];
  /**
   * 我可能遇到的人：`userId → { name, nickname }`。
   *
   * 服务端每次同步都回带（`/api/sync` 与 `/api/me` 的 `users` 字段），来源只有一条：
   * **我那些集的全部成员**。任务右上角那个来源 tag 要按 `createdBy` 查名字，
   * 没有这张表就只能显示「?」。跟 `cals` 一样落盘：离线时叫得出名字比显示「?」有用的多，
   * 代价是名字可能已经被人改过 —— 所以它只用于**显示**，任何判断都不许建立在它上面。
   */
  users: Record<string, { name: string; nickname: string | null }>;
  /**
   * **我是谁**（userId）。来源只有一个：登录 / `/api/me` 拿到的那份。
   *
   * 来源 tag 要判「这条是不是我建的」，而 `views/` 不许碰网络层 ——
   * 所以把 id 放进 state，由 store 在加载与刷新元数据时写好。
   * `null` = 还不知道（离线且从没登录过），这时**不画 tag**，而不是画个「?」。
   */
  meId: string | null;
  /** 待我处理的邀请 */
  invites: Invite[];
  cursor: number;
  outbox: Op[];
  ui: UiPrefs;
  /** 上次同步的报错/提示，给顶栏那个小标用 */
  lastError: string | null;
  /** 被服务器退回但值得留着重试的 opId（时钟不对那一类） */
  clockBlocked: string[];
  /**
   * 累计被「没有写权限」挡下的改动次数。只在本地自增，用来弹一次提示 ——
   * 界面上漏了一个入口时，用户能立刻知道是权限问题而不是程序卡了。
   */
  denied: number;
  /**
   * **最近那一次**被挡下的改动涉及哪些集。给提示用来说清是哪个集 ——
   * 只说「这个日程集你只有查看权限」在跨集页面上是没用的：用户在「今天」里
   * 勾了一条别的集的任务，他会以为是眼前这个集出了问题。
   *
   * 跟 `denied` 一起自增，所以值是「这一次」的，不是历史累计。
   */
  deniedCals: string[];
  /**
   * 「同一字段两边都改过」的记录，给详情抽屉里那条提示用（见 `FieldConflict`）。
   *
   * **要落盘**：它说的是「你那一下被盖掉了」，刷新一次就忘掉等于没提示过。
   * 用户点了「知道了」才清掉。
   */
  conflicts: FieldConflict[];
  /** 正在同步中。瞬时状态，不落盘（load 时一律重置为 false） */
  syncing: boolean;
}

export interface PublicUser {
  id: string;
  name: string;
  nickname: string | null;
  createdAt: number;
}
