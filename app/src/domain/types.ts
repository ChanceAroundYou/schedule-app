/**
 * types.ts —— 数据模型 v4
 *
 * 相对 v3 的实质变化只有三处：
 *   1. 每个实体带 _ts / _dev —— 逐字段 LWW 的比较键，本地维护，不进同步
 *   2. 重复实例带 seriesId，id 由 `seriesId#发生日期` 派生，不再用随机数
 *   3. 删除是墓碑字段（deleted / purged / deletedAt），不是数组里抹掉一条
 *
 * 加上日程集之后多了一条：**每个实体带 calId**。它不是可同步的字段，而是
 * 主键的一部分 —— 一条任务属于哪个集，改归属等于换一条实体（见 store.moveToCal）。
 * 所以 calId 和 _ts / _dev 一样只存在本地、不进 op 的 fields。
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

/** 每个实体都带的同步元数据。calId / _ts / _dev 只存在本地，不上传。 */
export interface SyncMeta {
  id: string;
  /** 属于哪个日程集。**不是可同步字段** —— 它是主键的一部分 */
  calId: string;
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

/* ============================== 日程集 ============================== */

/**
 * 三档角色。判断只走 `canWrite` / `canManage` 两个函数，
 * 别在界面上散落 `role === 'owner'` 这种比较 —— 加一档时会漏。
 */
export type Role = 'owner' | 'editor' | 'viewer';

export interface Cal {
  id: string;
  name: string;
  ownerId: string;
  createdAt: number;
  /** **我**在这个集里的角色 */
  role: Role;
}

export interface Member {
  id: string;
  name: string;
  role: Role;
  joinedAt: number;
}

export interface Invite {
  id: string;
  calId: string;
  calName: string;
  role: Role;
  createdAt: number;
  /** 待我处理的：谁邀请的 */
  fromName: string | null;
  /** 我发出去的：邀请的谁 */
  toName: string | null;
}

/** 能改内容（任务 / 打卡） */
export const canWrite = (r: Role | undefined | null): boolean => r === 'owner' || r === 'editor';
/** 能改集本身与成员 */
export const canManage = (r: Role | undefined | null): boolean => r === 'owner';

export const ROLE_LABEL: Record<Role, string> = {
  owner: '创建者',
  editor: '可编辑',
  viewer: '只读',
};

/* ============================== 同步 ============================== */

/** 一条同步操作。字段是「本次改动的那几个」，不是整条实体。 */
export interface Op {
  /** 客户端生成的 UUIDv4，幂等键 */
  opId: string;
  deviceId: string;
  ts: number;
  /** 写到哪个日程集。服务器据此查权限 —— 没有它就没法判断能不能写 */
  calId: string;
  entity: Entity;
  entityId: string;
  fields: Record<string, unknown>;
}

export interface Rejected {
  opId: string;
  /**
   * bad_request —— 这条 op 本身有问题，重试多少次都一样
   * clock       —— 只是设备时钟不对，改成正确时间后能成功
   * forbidden   —— 没有这个集的写权限。和 bad_request 一样是终态
   */
  code: 'bad_request' | 'clock' | 'forbidden';
  reason: string;
}

export interface Change {
  entity: Entity;
  entityId: string;
  field: string;
  value: unknown;
  ts: number;
  deviceId: string;
  /** 服务器一定会带；本地摊平快照时也从实体上取 */
  calId?: string;
}

/**
 * 一处「两端都改过、LWW 挑了一个赢家」的字段。
 *
 * **不是「同步冲突」那种要用户裁决的东西** —— LWW 已经判完了，数据是一致的。
 * 这一条只是把「你那一下没生效 / 你把对方那一下盖掉了」说出来：静默合并
 * 会让用户看到自己刚打的字凭空变回旧值（或者反过来），而他并不知道为什么。
 *
 * 只在**同一字段**上成立：我这一轮推了 title，同时收到别的设备改的 title。
 * 我改日期、对方改标题，那两个字段都在，不算冲突。
 */
export interface FieldConflict {
  entity: Entity;
  entityId: string;
  field: string;
  /** 谁赢了（按 (ts, deviceId) 那套，与服务端逐字一致） */
  winner: 'mine' | 'theirs';
  /** 我这一轮推上去的值 */
  mine: unknown;
  /** 对方的值 */
  theirs: unknown;
  /** 对方的改动时间与设备，用来去重（同一处只留最新那条） */
  ts: number;
  deviceId: string;
}

export interface SyncResponse {  cursor: number;
  applied: string[];
  rejected: Rejected[];
  changes?: Change[];
  truncated?: boolean;
  snapshot?: { tasks: Record<string, Task>; habits: Record<string, Habit> };
  /** 每次同步都带回来：轮询顺带发现「有人邀请我」「我被拉进新集」 */
  cals?: Cal[];
  invites?: Invite[];
}

/** 设备本地偏好。**不进同步** —— 同步过去只会让手机改主题把桌面也改了。 */
/* ------------------------------------------------------------ 外观三轴 */

/** 深浅。`auto` = 跟随系统，实际生效的那一档由 ui/theme.ts 解析 */
export type ThemeMode = 'auto' | 'light' | 'dark';
/** 色板。只改主色族，底色归深浅那一轴 —— 见 legacy.css 的「色板轴」一段 */
export type AccentKey = 'jade' | 'azure' | 'clay' | 'plum' | 'gold' | 'slate';
/** 风格。几何（圆角 / 阴影）全在 CSS 里，TS 这边只有 label —— 见 legacy.css 的「风格轴」 */
export type StyleKey = 'soft' | 'flat' | 'notion';

export interface UiPrefs {
  nav: string;
  view: 'day' | 'week' | 'month';
  cursor: string;
  theme: ThemeMode;
  /** 6 套色板之一。`azure` = 换暖纸之前那套靛蓝，留着当退路 */
  accent: AccentKey;
  /** 柔和 / 扁平 / notion。`soft` 是空块，等价于「2026-10-06 之前的几何」 */
  style: StyleKey;
  search: string;
  navOrder: string[];
  navBottom: string[];
  tdoneOpen: boolean;
  /** 当前选中的日程集。本地偏好，各设备可以看不同的集 */
  cal: string | null;
}

export interface LocalState {
  tasks: Record<string, Task>;
  habits: Record<string, Habit>;
  /** 我加入的日程集。服务器每次同步都会刷新 */
  cals: Cal[];
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
  createdAt: number;
}
