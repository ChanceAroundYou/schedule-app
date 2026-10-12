/**
 * Op —— 同步操作
 */

export type Entity = 'task' | 'habit' | 'project';

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
  /**
   * `projects` 是可选的：前后端**必须同批发布**，但老响应落在新客户端上
   * 不该炸 —— 缺这一桶就是「还没有任何项目」，与加这个实体之前一样。
   */
  snapshot?: {
    tasks: Record<string, import('./Task.ts').Task>;
    habits: Record<string, import('./Habit.ts').Habit>;
    projects?: Record<string, import('./Project.ts').Project>;
  };
  /** 每次同步都带回来：轮询顺带发现「有人邀请我」「我被拉进新集」 */
  cals?: import('./Cal.ts').Cal[];
  invites?: import('./Cal.ts').Invite[];
}
