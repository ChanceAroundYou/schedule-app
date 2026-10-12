/**
 * SyncMeta —— 同步元数据
 */

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
