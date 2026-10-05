/**
 * merge.ts —— 逐字段 LWW 合并
 *
 * 这条规则必须与服务端 lib/sync.js 里那段 SQL 的 WHERE 子句**逐字一致**：
 *
 *   WHERE excluded.ts > field_state.ts
 *      OR (excluded.ts = field_state.ts AND excluded.device_id > field_state.device_id)
 *
 * 两边不一致的话客户端和服务端会各自算出不同的赢家，永远收敛不了 —— 表现是
 * 「两台设备看到的内容一直不一样，怎么刷新都对不上」。改这里必须同时改那边。
 *
 * device_id 参与比较不是为了公平，是为了**确定性**：时间戳撞车时，
 * 两台设备必须算出同一个答案。
 */

import type { SyncMeta } from './types.ts';

export function lwwWins(
  incomingTs: number,
  incomingDev: string,
  currentTs: number,
  currentDev: string,
): boolean {
  if (incomingTs > currentTs) return true;
  if (incomingTs < currentTs) return false;
  return incomingDev > currentDev;
}

/**
 * 应用一条来自服务端的字段变更。
 * @returns 是否真的写进去了（false = 本地版本更新，按 LWW 拒绝了对方）
 */
export function mergeChange<T extends SyncMeta>(
  entity: T,
  field: string,
  value: unknown,
  ts: number,
  deviceId: string,
): boolean {
  const curTs = entity._ts[field] ?? -Infinity;
  const curDev = entity._dev[field] ?? '';
  if (!lwwWins(ts, deviceId, curTs, curDev)) return false;
  (entity as unknown as Record<string, unknown>)[field] = value;
  entity._ts[field] = ts;
  entity._dev[field] = deviceId;
  return true;
}

/**
 * 本地写入（用户操作）。**无条件**覆盖，因为本地操作永远是「刚刚发生的」，
 * 时间戳必然最新。写进去的同时记下逐字段时间戳，后面收到别的设备的变更时
 * 才有得比。
 */
export function writeField<T extends SyncMeta>(
  entity: T,
  field: string,
  value: unknown,
  ts: number,
  deviceId: string,
): void {
  (entity as unknown as Record<string, unknown>)[field] = value;
  entity._ts[field] = ts;
  entity._dev[field] = deviceId;
}

/** 一次性写多个字段（一次用户操作 = 一条 op = 一个时间戳） */
export function writeFields<T extends SyncMeta>(
  entity: T,
  fields: Record<string, unknown>,
  ts: number,
  deviceId: string,
): void {
  for (const k of Object.keys(fields)) writeField(entity, k, fields[k], ts, deviceId);
}
