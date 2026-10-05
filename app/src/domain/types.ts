/**
 * types.ts —— 数据模型 v4
 *
 * 相对 v3 的实质变化只有三处：
 *   1. 每个实体带 _ts / _dev —— 逐字段 LWW 的比较键，本地维护，不进同步
 *   2. 重复实例带 seriesId，id 由 `seriesId#发生日期` 派生，不再用随机数
 *   3. 删除是墓碑字段（deleted / purged / deletedAt），不是数组里抹掉一条
 *
 * 「垃圾箱」在旧版是独立的 trash 数组，里面存的是整条任务的深拷贝快照。
 * 那样没法同步：另一端删掉任务后，快照只存在于删除方的浏览器里。v4 改成
 * 墓碑 —— 垃圾箱就是 `deleted && !purged` 的那些实体本身。清空垃圾箱 =
 * 把 purged 置真（仍走同一条 LWW 通道），不是物理删除。
 */

export type RepeatUnit = 'none' | 'day' | 'week' | 'month' | 'year';

export interface RepeatRule {
  unit: RepeatUnit;
  /** 每隔几个单位 */
  n: number;
  /** unit='week' 时生效；空数组表示沿用原日期的星期 */
  weekdays: number[];
  /** unit='month' 时生效。注意它和 task.date 是两回事，见 repeat.ts */
  monthday: number;
  end: null | { type: 'date'; date: string } | { type: 'count'; count: number };
}

/** 每个实体都带的同步元数据。_ts / _dev 只存在本地，不上传。 */
export interface SyncMeta {
  id: string;
  /** 每个字段最后一次已知写入的时间戳 */
  _ts: Record<string, number>;
  /** 同上，写入者的 deviceId —— 时间戳相同时用它做确定性平局破解 */
  _dev: Record<string, string>;
}

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
}

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

export type Entity = 'task' | 'habit';

/** 一条同步操作。字段是「本次改动的那几个」，不是整条实体。 */
export interface Op {
  /** 客户端生成的 UUIDv4，幂等键 */
  opId: string;
  deviceId: string;
  ts: number;
  entity: Entity;
  entityId: string;
  fields: Record<string, unknown>;
}

export interface Rejected {
  opId: string;
  /**
   * bad_request —— 这条 op 本身有问题，重试多少次都一样
   * clock       —— 只是设备时钟不对，改成正确时间后能成功
   */
  code: 'bad_request' | 'clock';
  reason: string;
}

export interface Change {
  entity: Entity;
  entityId: string;
  field: string;
  value: unknown;
  ts: number;
  deviceId: string;
}

export interface SyncResponse {
  cursor: number;
  applied: string[];
  rejected: Rejected[];
  changes?: Change[];
  truncated?: boolean;
  snapshot?: { tasks: Record<string, Task>; habits: Record<string, Habit> };
}

/** 设备本地偏好。**不进同步** —— 同步过去只会让手机改主题把桌面也改了。 */
export interface UiPrefs {
  nav: string;
  view: 'day' | 'week' | 'month';
  cursor: string;
  theme: 'light' | 'dark';
  search: string;
  navOrder: string[];
  navBottom: string[];
  tdoneOpen: boolean;
}

export interface LocalState {
  tasks: Record<string, Task>;
  habits: Record<string, Habit>;
  cursor: number;
  outbox: Op[];
  ui: UiPrefs;
  /** 上次同步的报错/提示，给顶栏那个小标用 */
  lastError: string | null;
  /** 被服务器退回但值得留着重试的 opId（时钟不对那一类） */
  clockBlocked: string[];
  /** 正在同步中。瞬时状态，不落盘（load 时一律重置为 false） */
  syncing: boolean;
}

export interface PublicUser {
  id: string;
  name: string;
  isAdmin: boolean;
  createdAt: number;
}
